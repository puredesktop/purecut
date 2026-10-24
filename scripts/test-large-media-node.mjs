// Storage boundary regression with file-backed OPFS adapters. The companion
// browser check exercises Chromium's own OPFS implementation.
import { testMediaLocks } from './test-media-locks.mjs';
import { build } from 'esbuild';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, open, rm, readdir, writeFile, readFile } from 'node:fs/promises';
import { openAsBlob } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const { outputFiles } = await build({
  stdin: { contents: `export { ProjectService } from './purecut/lib/projects.ts'; export { files } from './purecut/lib/platform-files.ts'; export { bridge } from '@purescience/platform-ui/bridge/client.mjs'; export { ElectronWritableFileHandle } from './apps/web/src/lib/electron-file-writable.ts'; export { mainBridge } from './apps/web/src/lib/ipc.ts';`, resolveDir: process.cwd() },
  bundle: true, write: false, format: 'esm', platform: 'node',
  alias: { '@/lib/ipc': process.cwd() + '/apps/web/src/lib/ipc.ts', '@editor-core/main-channels': process.cwd() + '/purecut/editor-core/main-channels.ts' },
  external: ['../compiler-runtime.js'], banner: { js: `import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);` }, define: { 'import.meta.env': '{}' },
});
const bundleDir = await mkdtemp(join(tmpdir(), 'cut-storage-test-bundle-'));
const bundlePath = join(bundleDir, 'bundle.mjs');
await writeFile(bundlePath, outputFiles[0].contents);
let runtime;
try { runtime = await import(pathToFileURL(bundlePath).href); }
finally { await rm(bundleDir, { recursive: true, force: true }); }
const { ProjectService, files, bridge, ElectronWritableFileHandle, mainBridge } = runtime;

test('large storage, cross-tab cleanup, responsive project lock and cancellable publication', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cut-large-storage-'));
  const opfs = join(root, 'opfs'); await mkdir(opfs);
  const pending = new Map();
  let failAppend = false, failStaging = false, failOpen = false, failClose = false, maxChunk = 0, failRemove = false;
  const storage = {
    async getDirectory() {
      return {
        async getFileHandle(name) {
          const path = join(opfs, name);
          await writeFile(path, '');
          return {
            async createWritable() {
              if (failOpen) throw Error('OPFS createWritable quota');
              const handle = await open(path, 'r+');
              return {
                async write({ position, data }) {
                  if (failStaging) throw Error('OPFS quota');
                  await handle.write(data, 0, data.length, position);
                },
                async close() { if (failClose) throw Error('OPFS close quota'); await handle.close(); },
                async abort() { await handle.close(); },
              };
            },
            async getFile() { return openAsBlob(path); },
          };
        },
        async *entries() {
          for (const name of await readdir(opfs)) yield [name, { kind: 'file' }];
        },
        async removeEntry(name) { if (failRemove) throw Error('cleanup failure'); await rm(join(opfs, name)); },
      };
    },
  };
  const locks = testMediaLocks();
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { storage, locks } });
  globalThis.FileReader = class {
    readAsDataURL(blob) {
      assert.ok(blob.size <= 4 * 1024 * 1024);
      blob.arrayBuffer().then(data => { this.result = 'data:;base64,' + Buffer.from(data).toString('base64'); this.onload(); }, error => { this.error = error; this.onerror(); });
    }
  };
  const fakeBridge = async (method, args) => {
    assert.equal(method, 'fs.binaryTransfer');
    const r = args[0];
    if (r.action === 'begin') {
      const path = join(root, r.path.slice(1)); await mkdir(dirname(path), { recursive: true });
      const id = crypto.randomUUID(), temporary = path + '.upload';
      pending.set(id, { handle: await open(temporary, 'wx'), path, temporary, offset: 0, size: r.size });
      return { id };
    }
    const s = pending.get(r.id); assert.ok(s);
    if (r.action === 'append') {
      if (failAppend) throw Error('ENOSPC');
      const bytes = Buffer.from(r.base64, 'base64'); maxChunk = Math.max(maxChunk, bytes.length);
      assert.ok(bytes.length <= 4 * 1024 * 1024); assert.equal(r.offset, s.offset);
      await s.handle.write(bytes, 0, bytes.length, s.offset); s.offset += bytes.length;
      return { offset: s.offset };
    }
    await s.handle.close();
    if (r.action === 'abort') await rm(s.temporary);
    else { assert.equal(r.action, 'commit'); assert.equal(s.offset, s.size); await import('node:fs/promises').then(fs => fs.rename(s.temporary, s.path)); }
    pending.delete(r.id); return { ok: true };
  };
  // Optional host integration: run the app's actual bridge helper against the
  // configured server's actual handler and shared atomic writer, without mocks.
  let realWorkspace, realBridge;
  if (process.env.PURECUT_TEST_SERVER) {
    const server = pathToFileURL(process.env.PURECUT_TEST_SERVER.replace(/\/$/, '') + '/');
    const { dispatchBridge } = await import(new URL('src/bridge.ts', server));
    const { openWorkspace } = await import(new URL('src/workspace.ts', server));
    const person = { id: crypto.randomUUID(), name: 'Storage test', role: 'tester', organisation: { id: crypto.randomUUID(), name: 'Test' } };
    realWorkspace = await openWorkspace(root, person.organisation.id);
    realBridge = (method, args) => dispatchBridge(person, 'cut', method, args, root);
  }
  const hostPath = path => realWorkspace ? realWorkspace.real(path) : join(root, path.slice(1));
  bridge.call = realBridge ?? fakeBridge;
  const fs = { ...files, read: async () => JSON.stringify({ main: 'index.tsx', projectId: 'test' }) };
  const service = new ProjectService(fs);
  const dir = '/Workspace/projects/test.cut';
  const size = 129 * 1024 * 1024 + 17;
  const chunk = new Uint8Array(4 * 1024 * 1024).fill(53);
  try {
    for (const folder of ['assets', 'renders']) {
      const path = `${dir}/${folder}/large.mp4`;
      const { id } = await service.call('file:write-open', { path });
      for (let position = 0; position < size; position += chunk.length)
        await service.call('file:write-chunk', { id, position, data: chunk.subarray(0, Math.min(chunk.length, size - position)) });
      await service.call('file:write-chunk', { id, position: 0, data: [1, 2, 3, 4] });
      await service.call('file:write-close', { id });
      const saved = await open(hostPath(path));
      try {
        assert.equal((await saved.stat()).size, size);
        const buffer = Buffer.alloc(1024 * 1024);
        for (let offset = 0; offset < size;) {
          const { bytesRead } = await saved.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
          assert.ok(bytesRead > 0);
          for (let i = 0; i < bytesRead; i++) assert.equal(buffer[i], offset + i < 4 ? offset + i + 1 : 53);
          offset += bytesRead;
        }
      } finally { await saved.close(); }
    }
    const path = `${dir}/renders/preserved.mp4`;
    await writeFile(hostPath(path), 'original');
    for (const failure of ['abort', 'append', 'staging', 'open', 'close', 'position']) {
      failOpen = failure === 'open';
      if (failOpen) await assert.rejects(service.call('file:write-open', { path }), /quota/);
      else {
        const { id } = await service.call('file:write-open', { path });
        failStaging = failure === 'staging';
        if (failStaging || failure === 'position') {
          await assert.rejects(service.call('file:write-chunk', { id, position: failure === 'position' ? Number.MAX_SAFE_INTEGER : 0, data: chunk }), /quota|position/);
        } else {
          await service.call('file:write-chunk', { id, position: 0, data: chunk });
          failAppend = failure === 'append'; failClose = failure === 'close';
          if (failAppend || failClose) {
            let failure;
            if (realBridge && failAppend) {
              const probe = await open(hostPath(path)); const prototype = Object.getPrototypeOf(probe); await probe.close();
              failure = t.mock.method(prototype, 'write', async () => { throw Object.assign(Error('ENOSPC'), { code: 'ENOSPC' }); });
            }
            try { await assert.rejects(service.call('file:write-close', { id }), /ENOSPC|quota/); }
            finally { failure?.mock.restore(); }
          }
          else await service.call('file:write-abort', { id });
        }
      }
      failOpen = failStaging = failAppend = failClose = false;
      assert.equal(await readFile(hostPath(path), 'utf8'), 'original');
      assert.equal(service.streams.size, 0); assert.equal(pending.size, 0);
      assert.deepEqual(await readdir(opfs), []);
      await service.call('file:write-abort', { id: 'already-disposed' });
    }
    // A second tab must preserve a live export while removing crash leftovers.
    const live = await service.call('file:write-open', { path });
    const orphan = 'cut-' + crypto.randomUUID();
    await writeFile(join(opfs, orphan), 'abandoned after a crash');
    await writeFile(join(opfs, 'unrelated-file'), 'keep');
    const otherTab = new ProjectService({ ...fs, root: async () => '/Workspace' });
    await otherTab.init();
    assert.deepEqual((await readdir(opfs)).sort(), ['cut-' + live.id, 'unrelated-file'].sort());
    // Simulate tab death: Web Locks release without the service receiving abort.
    await service.streams.get(live.id).writer.abort();
    locks.lose('purecut-opfs-cut-' + live.id);
    const reopenedService = new ProjectService({ ...fs, root: async () => '/Workspace' });
    await reopenedService.init();
    assert.deepEqual(await readdir(opfs), ['unrelated-file']);
    await rm(join(opfs, 'unrelated-file'));

    // A large publication does not block project reads or abort. The app's
    // actual platform helper checks cancellation after the in-flight append.
    mainBridge.call = (channel, data) => otherTab.call(channel, data);
    const target = new ElectronWritableFileHandle(path);
    const encoder = (await target.createWritable()).getWriter();
    await encoder.write({ type: 'write', position: 0, data: chunk });
    const publishing = { id: [...otherTab.streams.keys()][0] };
    let releaseAppend, enteredAppend;
    const entered = new Promise(resolve => { enteredAppend = resolve; });
    const gate = new Promise(resolve => { releaseAppend = resolve; });
    const backend = bridge.call;
    bridge.call = async (method, args) => {
      if (args[0].action === 'append') { enteredAppend(); await gate; }
      return backend(method, args);
    };
    const closing = encoder.close();
    const cancelled = assert.rejects(closing, /abort/i);
    await entered;
    await Promise.race([
      otherTab.call('projects:get', { dir }),
      new Promise((_, reject) => { const timer = setTimeout(() => reject(Error('project lock held during publish')), 1000); timer.unref(); }),
    ]);
    // A startup sweep also preserves staging while it is being published.
    await new ProjectService({ ...fs, root: async () => '/Workspace' }).init();
    assert.ok((await readdir(opfs)).includes('cut-' + publishing.id));
    await target.dispose();
    releaseAppend(); await cancelled;
    bridge.call = backend;
    assert.equal(await readFile(hostPath(path), 'utf8'), 'original');
    assert.deepEqual(await readdir(opfs), []);

    // Deletion failures must not mask quota/write errors and are swept later.
    const failed = await otherTab.call('file:write-open', { path });
    failStaging = failRemove = true;
    await assert.rejects(otherTab.call('file:write-chunk', { ...failed, position: 0, data: chunk }), /OPFS quota/);
    failStaging = failRemove = false;
    await otherTab.call('file:write-abort', failed);
    await new ProjectService({ ...fs, root: async () => '/Workspace' }).init();
    assert.deepEqual(await readdir(opfs), []);
    await assert.rejects(service.call('file:write-open', { path: `${dir}/renders/../escape` }), /Invalid/);
    if (!realBridge) assert.equal(maxChunk, 4 * 1024 * 1024);
  } finally { await rm(root, { recursive: true, force: true }); }
});
