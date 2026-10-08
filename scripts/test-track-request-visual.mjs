// The assistant asking the person to track an object, in the editor: the
// Object mask bar with the request above it and the suggested point ringed
// on the video, light and dark, at 1440 and 640 wide (see
// scripts/track-request-visual-fixture.tsx). Then the person's side: the
// request names the subject and the use, Blur is picked, "Use suggested
// point" is offered, the download still waits for the person, and Cancel
// ends the request as cancelled with the project unchanged. No model runs and
// nothing is downloaded. Fails on a page error, on horizontal overflow, or
// when the request is out of the window.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';

const port = Number(process.env.PURECUT_VISUAL_PORT || 5568);
const output = process.env.PURECUT_SCREENSHOTS || '/tmp/purecut-visual/track-request';
const server = spawn(process.execPath, ['scripts/purecut-dev.mjs', '--port', String(port)], { stdio: 'pipe' });
let log = '', browser;
server.stdout.on('data', data => { log += data; });
server.stderr.on('data', data => { log += data; });
const check = (value, message) => { if (!value) throw Error(message); };
try {
  for (let i = 0; ; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) break; } catch {}
    if (i > 120 || server.exitCode !== null) throw Error(log);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  await mkdir(output, { recursive: true });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  for (const mode of ['light', 'dark']) for (const width of [1440, 640]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = [];
    const downloads = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (/huggingface|hf\.co/.test(request.url())) downloads.push(request.url()); });
    await page.route('**/visual-fixture', route => route.fulfill({ contentType: 'text/html', body: '<html><body style="margin:0"><div id="fixture"></div></body></html>' }));
    await page.goto(`http://127.0.0.1:${port}/visual-fixture`);
    await page.evaluate(async mode => {
      const { mountEditorVisual } = await import('/scripts/editor-visual-fixture.tsx');
      window.disposeFixture = mountEditorVisual(document.getElementById('fixture'), mode);
      const desk = document.createElement('style');
      desk.textContent = 'html:root[data-app="cut"][data-platform-theme] { background: var(--platform-colors-app-viewport, #15251f) !important; }';
      document.head.append(desk);
    }, mode);
    await page.waitForFunction(() => document.querySelectorAll('canvas').length >= 2 && !document.body.innerText.includes('Opening project...'));
    const fixture = (name) => page.evaluate(async name => (await import('/scripts/track-request-visual-fixture.tsx'))[name](), name);
    const ask = page.getByRole('status', { name: 'Request from the assistant' });
    const shot = async (name) => {
      await page.waitForTimeout(600);
      const box = await ask.boundingBox();
      if (!box || box.x < 0 || box.x + box.width > width + 1 || box.y < 0) throw Error(`${mode}/${width} ${name}: the request is out of the window ${JSON.stringify(box)}`);
      const bar = await page.locator('.cut-tool-bar').boundingBox();
      if (!bar || bar.y < box.y + box.height) throw Error(`${mode}/${width} ${name}: the request overlaps the bar ${JSON.stringify({ box, bar })}`);
      await page.screenshot({ path: `${output}/${name}-${mode}-${width}.png` });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      if (overflow) throw Error(`${mode}/${width} ${name}: the page scrolls sideways`);
    };

    await fixture('stageRequest');
    const before = await fixture('state');
    check(!before.pending && before.status.status === 'none', `${mode}/${width}: nothing asked yet ${JSON.stringify(before)}`);
    const asked = await fixture('ask');
    check(asked.status === 'awaiting_person', `${mode}/${width}: the tool returns awaiting_person ${JSON.stringify(asked)}`);
    await ask.waitFor({ timeout: 5000 });
    const text = await ask.innerText();
    check(/From the assistant/i.test(text) && /his face/.test(text) && /Interview/.test(text) && /blur it/.test(text),
      `${mode}/${width}: the request says who asked, what and what for: ${text}`);

    await fixture('modelNeedsDownload');
    await page.getByRole('button', { name: 'Download' }).waitFor();
    check(/Nothing downloads until you choose Download/.test(await ask.innerText()), `${mode}/${width}: the request defers to the download consent`);
    check(await page.getByRole('button', { name: 'Use suggested point' }).count() === 0, `${mode}/${width}: no point to take before the model is here`);
    await shot('asked-download');

    await fixture('modelReady');
    const take = page.getByRole('button', { name: 'Use suggested point' });
    await take.waitFor({ timeout: 5000 });
    check(/confirm its point/.test(await ask.innerText()), `${mode}/${width}: the request says to click or confirm the point`);
    const use = page.getByRole('button', { name: /Use as/ });
    check(/Blur/.test(await use.innerText()), `${mode}/${width}: Blur is picked: ${await use.innerText()}`);
    await shot('asked');
    if (width === 1440) {
      // The suggested point, up close.
      const stage = await page.locator('canvas').first().boundingBox();
      await page.screenshot({ path: `${output}/asked-point-${mode}-${width}.png`, clip: { x: stage.x + stage.width / 2 - 220, y: stage.y + stage.height / 2 - 220, width: 440, height: 300 } });
    }

    // The person declines.
    await page.locator('.cut-tool-bar').getByRole('button', { name: 'Cancel', exact: true }).click();
    await ask.waitFor({ state: 'detached', timeout: 5000 });
    const after = await fixture('state');
    check(!after.pending && after.tool === 'other' && after.status.status === 'cancelled' && /unchanged/.test(after.status.message),
      `${mode}/${width}: Cancel ends the request as cancelled ${JSON.stringify(after)}`);

    if (downloads.length) throw Error(`${mode}/${width}: the model was fetched: ${downloads.join(', ')}`);
    if (errors.length) throw Error(`${mode}/${width}: ${errors.join('; ')}`);
    console.log(`PASS ${mode}/${width}: ${output}/*-${mode}-${width}.png`);
    await page.close();
  }
} finally {
  await browser?.close();
  server.kill();
}
