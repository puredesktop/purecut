// Real Chromium OPFS + the shipped bounded bridge helper, backed by scratch
// files on disk. No codecs or full editor build are needed to test this boundary.
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdtemp, open, mkdir, readFile, rm, rename, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
const runStorageTests = async () => {
    const { ProjectService, files, bridge } = await import('/bundle.js');
    bridge.call = (method, args) => window.diskBridge(method, args);
    const fs = { ...files, root: async () => '/projects', read: async () => JSON.stringify({ main: 'index.tsx', projectId: 'test' }) };
    const service = new ProjectService(fs);
    const rejects = async (run, pattern) => { try { await run(); } catch (error) { if (pattern.test(error.message)) return; throw error; } throw Error('Expected failure'); };
    const dir = '/projects/test.cut';
    const size = 129 * 1024 * 1024 + 17;
    const chunk = new Uint8Array(4 * 1024 * 1024).fill(53);
    for (const folder of ['assets', 'renders']) {
      const path = `${dir}/${folder}/large.mp4`;
      const { id } = await service.call('file:write-open', { path });
      for (let position = 0; position < size; position += chunk.length)
        await service.call('file:write-chunk', { id, position, data: chunk.subarray(0, Math.min(chunk.length, size - position)) });
      // Simulate a muxer seeking back to finish a header.
      await service.call('file:write-chunk', { id, position: 0, data: new Uint8Array([1, 2, 3, 4]) });
      await service.call('file:write-close', { id });
      const reopened = await fs.file(path);
      if (reopened.size !== size) throw Error('Reopened file size differs');
      if (Array.from(new Uint8Array(await reopened.slice(0, 4).arrayBuffer())).join() !== '1,2,3,4') throw Error('Header seek was lost');
      if ((new Uint8Array(await reopened.slice(-1).arrayBuffer()))[0] !== 53) throw Error('Tail was lost');
    }
    await rejects(() => service.call('file:write-open', { path: `${dir}/renders/../escape` }), /Invalid/);
    const { id } = await service.call('file:write-open', { path: `${dir}/renders/interrupted.mp4` });
    await service.call('file:write-chunk', { id, position: 0, data: chunk });
    await service.call('file:write-abort', { id });
    // Inject OPFS quota failure at the active writer boundary.
    const quota = await service.call('file:write-open', { path: `${dir}/renders/quota.mp4` });
    service.streams.get(quota.id).writer.write = async () => { throw new DOMException('disk full', 'QuotaExceededError'); };
    await rejects(() => service.call('file:write-chunk', { id: quota.id, position: 0, data: chunk }), /disk full/);
    const opfs = await navigator.storage.getDirectory();
    if (service.streams.size) throw Error('Leaked OPFS streams');
    for await (const name of opfs.keys()) if (name.startsWith('cut-')) throw Error('Leaked OPFS staging');
    window.mediaFixture = { service, dir, chunk, rejects };
    return { size, importsAndExports: 2 };
};

const runFailureTests = async () => {
    const { service, dir, chunk, rejects } = window.mediaFixture;
    const { id } = await service.call('file:write-open', { path: `${dir}/renders/large.mp4` });
    await service.call('file:write-chunk', { id, position: 0, data: chunk });
    await rejects(() => service.call('file:write-close', { id }), /ENOSPC/);
    if (service.streams.size) throw Error('Leaked failed commit');
    for await (const name of (await navigator.storage.getDirectory()).keys()) if (name.startsWith('cut-')) throw Error('Leaked failed OPFS staging');
};

const root = await mkdtemp(join(tmpdir(), 'cut-large-media-'));
const ui = process.env.PURECUT_PLATFORM_UI;
const bundle = await build({
  stdin: { contents: `export { ProjectService } from './purecut/lib/projects.ts'; export { files } from './purecut/lib/platform-files.ts'; export { bridge } from '@purescience/platform-ui/bridge/client.mjs';`, resolveDir: process.cwd() },
  bundle: true, write: false, format: 'esm', platform: 'browser',
  external: ['../compiler-runtime.js'], define: { 'import.meta.env': '{}' },
  ...(ui ? { alias: { '@purescience/platform-ui': ui } } : {}),
});
const server = createServer((req, res) => {
  if (req.url === '/bundle.js') { res.setHeader('content-type', 'text/javascript'); res.end(bundle.outputFiles[0].contents); }
  else if (req.url.startsWith('/media/')) {
    readFile(join(root, req.url.slice(7))).then(data => res.end(data), () => { res.statusCode = 404; res.end(); });
  } else res.end('<!doctype html><title>Large media filesystem test</title>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const pending = new Map();
let maxChunk = 0, failAppend = false, browser;
const diskBridge = async (method, args) => {
    if (method === 'fs.previewUrl') return { url: `${url}/media/${args[0].path.slice(1)}`, mimeType: 'video/mp4' };
    assert.equal(method, 'fs.binaryTransfer');
    const r = args[0];
    if (r.action === 'begin') {
      const target = join(root, r.path.slice(1)), temporary = target + '.upload';
      await mkdir(dirname(target), { recursive: true });
      const id = crypto.randomUUID();
      pending.set(id, { file: await open(temporary, 'wx'), target, temporary, offset: 0, size: r.size });
      return { id };
    }
    const s = pending.get(r.id);
    assert.ok(s);
    if (r.action === 'abort') { await s.file.close(); await rm(s.temporary); pending.delete(r.id); return { ok: true }; }
    if (r.action === 'append') {
      if (failAppend) throw Error('ENOSPC: No space left on device');
      const bytes = Buffer.from(r.base64, 'base64');
      maxChunk = Math.max(maxChunk, bytes.length);
      assert.ok(bytes.length <= 4 * 1024 * 1024);
      assert.equal(r.offset, s.offset);
      await s.file.write(bytes, 0, bytes.length, s.offset);
      s.offset += bytes.length;
      return { offset: s.offset };
    }
    assert.equal(r.action, 'commit'); assert.equal(s.offset, s.size);
    await s.file.close(); await rename(s.temporary, s.target); pending.delete(r.id);
    return { ok: true };
};

try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  await page.exposeFunction('diskBridge', diskBridge);
  await page.goto(url);
  const results = await page.evaluate(runStorageTests);
  failAppend = true;
  await page.evaluate(runFailureTests);
  assert.equal(pending.size, 0);
  assert.deepEqual(await readdir(join(root, 'projects/test.cut/renders')), ['large.mp4']);
  const reopened = await open(join(root, 'projects/test.cut/renders/large.mp4'));
  try { assert.equal((await reopened.stat()).size, results.size); } finally { await reopened.close(); }
  console.log('PASS: large import/export storage, seek, reopen, cancellation, OPFS quota and bridge disk-full', { ...results, maxChunk });
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  for (const s of pending.values()) await s.file.close().catch(() => {});
  await rm(root, { recursive: true, force: true });
}
