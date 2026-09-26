import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir, readdir, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname, join, sep } from 'node:path';
import { createHash } from 'node:crypto';

const root = await mkdtemp(join(tmpdir(), 'purecut-disk-editor-'));
const port = 5565;
const server = spawn(process.execPath, ['scripts/purecut-dev.mjs', '--port', String(port)], { stdio: 'pipe' });
let browser, log = '', dir;
server.stdout.on('data', data => { log += data; });
server.stderr.on('data', data => { log += data; });
const disk = async (method, path, value) => {
  const target = resolve(path);
  if (target !== root && !target.startsWith(root + sep)) throw Error('Fixture path escapes temporary root');
  if (method === 'read') return readFile(target, 'utf8');
  if (method === 'readBinary') return { base64: (await readFile(target)).toString('base64'), mtime: (await stat(target)).mtimeMs };
  if (method === 'writeBinary') { await mkdir(dirname(target), { recursive: true }); await writeFile(target, Buffer.from(value, 'base64')); return; }
  if (method === 'storageRead' || method === 'storageWrite') {
    let contents = null;
    try { contents = await readFile(target, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const version = contents === null ? null : createHash('sha256').update(contents).digest('hex');
    if (method === 'storageRead') return { path: target, value: contents === null ? null : JSON.parse(contents), version };
    const request = JSON.parse(value);
    if (request.ifMatch !== version) return { ok: false, conflict: true, version };
    const next = JSON.stringify(request.value);
    await writeFile(target, next);
    return { ok: true, path: target, version: createHash('sha256').update(next).digest('hex') };
  }
  if (method === 'write') { await mkdir(dirname(target), { recursive: true }); await writeFile(target, value); return; }
  if (method === 'remove') return rm(target);
  if (method === 'list') {
    let entries;
    try { entries = await readdir(target, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    return Promise.all(entries.map(async entry => {
      const path = join(target, entry.name), info = await stat(path);
      return { path, name: entry.name, isDirectory: entry.isDirectory(), byteLength: info.size, modifiedAt: info.mtime.toISOString() };
    }));
  }
  throw Error(`Unknown fixture disk method: ${method}`);
};
try {
  for (let attempt = 0; ; attempt++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) break; } catch {}
    if (attempt > 120 || server.exitCode !== null) throw Error(log);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  for (const pass of ['create', 'restart']) {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.exposeFunction('fixtureDisk', disk);
    await page.route('**/disk-editor-fixture', route => route.fulfill({ contentType: 'text/html', body: '<html><body style="margin:0"><div id="fixture"></div></body></html>' }));
    await page.goto(`http://127.0.0.1:${port}/disk-editor-fixture`);
    dir = await page.evaluate(async ({ root, dir }) => {
      const { openDiskEditor } = await import('/scripts/disk-editor-fixture.ts');
      window.fixture = await openDiskEditor(document.getElementById('fixture'), root, dir);
      return window.fixture.dir;
    }, { root, dir });
    await page.waitForFunction(() => window.fixture.state().ready && !document.body.innerText.includes('Opening project...'), undefined, { timeout: 30000 });
    await page.waitForFunction(() => {
      const canvas = document.querySelector('[data-cut-preview] canvas');
      if (!canvas || !canvas.width || !canvas.height) return false;
      const copy = document.createElement('canvas');
      copy.width = 160; copy.height = 100;
      const context = copy.getContext('2d');
      context.drawImage(canvas, 0, 0, 160, 100);
      const pixels = context.getImageData(0, 0, 160, 100).data;
      let white = 0;
      for (let i = 0; i < pixels.length; i += 4)
        if (pixels[i] > 245 && pixels[i + 1] > 245 && pixels[i + 2] > 245 && pixels[i + 3] > 245) white++;
      return white > 3000;
    }, undefined, { timeout: 30000 });
    const elapsed = await page.evaluate(() => performance.now() - window.fixture.started);
    if (pass === 'restart' && await page.evaluate(() => performance.getEntriesByType('resource').some(entry => entry.name.includes('compiler-runtime'))))
      throw Error('Unchanged saved project loaded the compiler instead of its verified cache');
    console.log(`${pass} service timings: ${JSON.stringify(await page.evaluate(() => window.fixture.timings.filter(item => item.ms > 10)))}`);
    const expected = pass === 'create' ? 'Welcome to PureCut' : 'Saved across browser restart';
    const state = await page.evaluate(() => window.fixture.state());
    if (!state.text.includes(expected)) throw Error(`${pass}: loaded text mismatch ${JSON.stringify(state)}`);
    if (pass === 'restart' && !state.assets.some(asset => asset.type === 'VIDEO')) throw Error('Imported video did not survive restart');
    if (pass === 'create') {
      await page.evaluate(() => window.fixture.propose());
      const dialog = page.getByRole('dialog', { name: 'Review proposed edit' });
      await dialog.getByRole('button', { name: 'Apply edit', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      const saved = await readFile(join(dir, 'index.tsx'), 'utf8');
      if (!saved.includes('Saved across browser restart')) throw Error('Edit was not saved on disk');
    }
    const exported = await page.evaluate(pass => window.fixture.exportVideo(pass), pass);
    if (exported.size !== (await stat(exported.path)).size || exported.size < 1000) throw Error('Export file size mismatch');
    if (pass === 'create') await page.evaluate(path => window.fixture.importVideo(path), exported.path);
    await page.getByRole('button', { name: 'Export history', exact: true }).click();
    const history = page.getByRole('dialog', { name: 'Export history', exact: true });
    await history.waitFor();
    const expectedEntries = pass === 'create' ? 1 : 2;
    await page.waitForFunction(count => document.querySelectorAll('.cut-export-row').length === count, expectedEntries);
    for (let index = 0; index < expectedEntries; index++) {
    const row = history.locator('.cut-export-row').nth(index);
    const filename = await row.locator('strong').innerText();
    await row.locator('button[aria-pressed]').click();
    await page.waitForFunction(name => document.querySelector('.cut-export-history a[download]')?.getAttribute('download') === name, filename);
    await history.locator('video').evaluate(async (video, filename) => {
      video.muted = true;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('Disk export playback stalled')), 10000);
        video.requestVideoFrameCallback(() => { clearTimeout(timer); resolve(); });
        void video.play().catch(error => { clearTimeout(timer); reject(error); });
      });
      if (Math.abs(video.duration - 6) > 0.1 || video.videoWidth !== 320 || video.videoHeight !== 180) throw Error('Disk export metadata mismatch');
      const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
      const context = canvas.getContext('2d'); context.drawImage(video, 0, 0);
      const pixel = context.getImageData(10, 10, 1, 1).data;
      if (pixel[0] < 240 || pixel[1] < 240 || pixel[2] < 240) throw Error('Disk export decoded the wrong scene');
      const darkPixels = (x, y, width, height) => {
        const data = context.getImageData(x, y, width, height).data;
        let count = 0;
        for (let i = 0; i < data.length; i += 4) if (data[i] < 100 && data[i + 1] < 100 && data[i + 2] < 100) count++;
        return count;
      };
      if (darkPixels(20, 55, 280, 35) < 100) throw Error('Saved title missing from decoded export');
      const inset = darkPixels(225, 125, 80, 45);
      if (filename === 'restart.webm' ? inset < 5 : inset > 0) throw Error(`Imported clip pixels mismatch for ${filename}: ${inset}`);
      video.pause();
    }, filename);
    if (!await history.getByRole('link', { name: 'Download video', exact: true }).isVisible()) throw Error('Download link missing');
    }
    await page.screenshot({ path: join(root, `${pass}.png`) });
    await page.evaluate(() => window.fixture.dispose());
    if (errors.length) throw Error(errors.join('; '));
    console.log(`PASS disk editor/${pass}: route-to-painted-content ${elapsed.toFixed(0)}ms; ${join(root, `${pass}.png`)}`);
    await browser.close(); browser = undefined;
  }
} finally {
  await browser?.close(); server.kill('SIGTERM');
  if (server.exitCode === null) await new Promise(resolve => server.once('exit', resolve));
}
