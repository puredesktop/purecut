import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';

const port = 5563;
const output = process.env.PURECUT_SCREENSHOTS || '/tmp/purecut-visual';
const server = spawn(process.execPath, ['scripts/purecut-dev.mjs', '--port', String(port)], { stdio: 'pipe' });
let log = '', browser;
server.stdout.on('data', data => { log += data; });
server.stderr.on('data', data => { log += data; });
try {
  for (let i = 0; ; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) break; } catch {}
    if (i > 120 || server.exitCode !== null) throw Error(log);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  await mkdir(output, { recursive: true });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  for (const mode of ['light', 'dark']) for (const width of [1440, 640, 375]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/visual-fixture', route => route.fulfill({ contentType: 'text/html', body: '<html><body style="margin:0"><div id="fixture"></div></body></html>' }));
    await page.goto(`http://127.0.0.1:${port}/visual-fixture`);
    await page.evaluate(async mode => {
      const { mountEditorVisual } = await import('/scripts/editor-visual-fixture.tsx');
      window.disposeFixture = mountEditorVisual(document.getElementById('fixture'), mode);
    }, mode);
    await page.waitForFunction(() => document.querySelectorAll('canvas').length >= 2 && !document.body.innerText.includes('Opening project...'));
    await page.waitForTimeout(300);
    const initialCamera = await page.evaluate(async () => (await import('/scripts/editor-visual-fixture.tsx')).readFixtureCamera());
    await page.screenshot({ path: `${output}/${mode}-${width}-initial.png` });
    const fit = page.getByRole('button', { name: 'Fit preview', exact: true });
    await fit.scrollIntoViewIfNeeded();
    await fit.click();
    await page.waitForTimeout(300);
    const fittedCamera = await page.evaluate(async () => (await import('/scripts/editor-visual-fixture.tsx')).readFixtureCamera());
    if (initialCamera.some((value, i) => Math.abs(value - fittedCamera[i]) > 0.01)) {
      throw Error(`${mode}/${width}: initial camera did not fit: ${initialCamera} vs ${fittedCamera}`);
    }
    for (const name of ['Fullscreen preview', 'Previous frame']) {
      const control = page.getByRole('button', { name, exact: true });
      await control.scrollIntoViewIfNeeded();
      const reachable = await control.evaluate(element => {
        const box = element.getBoundingClientRect();
        const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return !!hit && element.contains(hit);
      });
      if (!reachable) throw Error(`${mode}/${width}: ${name} is obscured`);
    }
    await page.screenshot({ path: `${output}/${mode}-${width}.png` });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    if (overflow || errors.length) throw Error(`${mode}/${width}: overflow=${overflow}; ${errors.join('; ')}`);
    console.log(`PASS ${mode}/${width}: ${output}/${mode}-${width}.png`);
    await page.evaluate(async () => (await import('/scripts/editor-visual-fixture.tsx')).showReviewFixture());
    const review = page.getByRole('dialog', { name: 'Review proposed edit' });
    try { await review.waitFor({ timeout: 5000 }); }
    catch (error) {
      await page.screenshot({ path: `${output}/source-review-failure.png` });
      throw Error(`${error.message}\n${await page.locator('.cut-source-review').evaluate(e => e.outerHTML.slice(0, 2000))}\n${errors.join('; ')}`);
    }
    await page.waitForTimeout(300);
    const box = await review.boundingBox();
    if (!box || box.x < 15 || box.x + box.width > width - 15 || box.y < 0 || box.y + box.height > 900)
      throw Error(`Source review does not fit ${mode}/${width}: ${JSON.stringify(box)}`);
    if (await review.evaluate(element => element.scrollWidth > element.clientWidth)) throw Error('Source review overflows horizontally');
    if (!await review.getByRole('button', { name: 'Discard', exact: true }).evaluate(element => element === document.activeElement))
      throw Error('Source review must focus Discard');
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('Tab');
      if (!await review.evaluate(element => element.contains(document.activeElement))) throw Error('Source review leaked keyboard focus');
    }
    await page.screenshot({ path: `${output}/source-review-${mode}-${width}.png` });
    await review.getByRole('button', { name: 'Apply edit', exact: true }).click();
    await review.getByRole('alert').waitFor();
    await review.getByRole('button', { name: 'Discard', exact: true }).click();
    await review.waitFor({ state: 'hidden' });
    if (errors.length) throw Error(errors.join('; '));
    console.log(`PASS source review ${mode}/${width}`);
    if (width === 1440) {
      await page.evaluate(async () => (await import('/scripts/editor-visual-fixture.tsx')).prepareTrimFixture(90));
      const trim = page.getByRole('button', { name: 'Trim start to playhead', exact: true });
      await trim.waitFor();
      await page.waitForTimeout(100);
      if (!await trim.isEnabled()) throw Error('Trim button should enable inside the clip');
      await trim.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${output}/trim-${mode}.png` });
      await page.evaluate(async () => (await import('/scripts/editor-visual-fixture.tsx')).prepareTrimFixture(150));
      await page.waitForTimeout(100);
      if (!await trim.isDisabled()) throw Error('Trim button should disable at the clip end');
      console.log(`PASS trim controls ${mode}`);
    }
    await page.close();
  }
  for (const width of [1440, 375]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.route('**/visual-fixture', route => route.fulfill({ contentType: 'text/html', body: '<html><body style="margin:0"><div id="fixture"></div></body></html>' }));
    await page.goto(`http://127.0.0.1:${port}/visual-fixture`);
    const expected = [0.5, 0, 0, 0.5, 27, 63];
    await page.evaluate(async camera => {
      const fixture = await import('/scripts/editor-visual-fixture.tsx');
      window.disposeFixture = fixture.mountEditorVisual(document.getElementById('fixture'), 'light', camera);
    }, expected);
    await page.waitForFunction(() => document.querySelectorAll('canvas').length >= 2 && !document.body.innerText.includes('Opening project...'));
    await page.waitForTimeout(500);
    const actual = await page.evaluate(async () => (await import('/scripts/editor-visual-fixture.tsx')).readFixtureCamera());
    if (actual.some((value, i) => Math.abs(value - expected[i]) > 0.001)) throw Error(`Saved camera changed at ${width}: ${actual}`);
    console.log(`PASS saved camera/${width}`);
    await page.close();
  }
} finally {
  await browser?.close();
  server.kill('SIGTERM');
  if (server.exitCode === null) await new Promise(resolve => server.once('exit', resolve));
}
