// Screenshots of behind subject and privacy blur in the editor, light and
// dark, at 1440 and 640 wide (see scripts/mask-uses-visual-fixture.tsx). The
// footage and its mask are made in the page; no model runs. Fails on a page
// error, on horizontal overflow, or when a new control is out of the window.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';

const port = Number(process.env.PURECUT_VISUAL_PORT || 5566);
const output = process.env.PURECUT_SCREENSHOTS || '/tmp/purecut-visual/mask-uses';
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
  for (const mode of ['light', 'dark']) for (const width of [1440, 640]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/visual-fixture', route => route.fulfill({ contentType: 'text/html', body: '<html><body style="margin:0"><div id="fixture"></div></body></html>' }));
    await page.goto(`http://127.0.0.1:${port}/visual-fixture`);
    await page.evaluate(async mode => {
      const { mountEditorVisual } = await import('/scripts/editor-visual-fixture.tsx');
      window.disposeFixture = mountEditorVisual(document.getElementById('fixture'), mode);
      // The shell's window sits under the app's glass (purecut/styles.css keeps
      // the frame transparent); without it, glass on a white page reads as fog.
      const desk = document.createElement('style');
      desk.textContent = 'html:root[data-app="cut"][data-platform-theme] { background: var(--platform-colors-app-viewport, #15251f) !important; }';
      document.head.append(desk);
    }, mode);
    await page.waitForFunction(() => document.querySelectorAll('canvas').length >= 2 && !document.body.innerText.includes('Opening project...'));
    const fixture = (name) => page.evaluate(async name => (await import('/scripts/mask-uses-visual-fixture.tsx'))[name](), name);
    const shot = async (name, locator) => {
      await page.waitForTimeout(500);
      if (locator) {
        await locator.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(async (error) => {
          await page.screenshot({ path: `${output}/${name}-${mode}-${width}-failure.png` });
          throw error;
        });
        const box = await locator.boundingBox();
        if (!box || box.x < 0 || box.x + box.width > width + 1) throw Error(`${mode}/${width} ${name}: out of the window ${JSON.stringify(box)}`);
      }
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${output}/${name}-${mode}-${width}.png` });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      if (overflow) throw Error(`${mode}/${width} ${name}: the page scrolls sideways`);
    };
    const section = page.locator('[data-panel-title]', { hasText: 'Behind subject' });

    await fixture('stageInterview');
    // Below 1000px the inspector is a panel of its own, opened from the command bar.
    const toggle = page.getByRole('button', { name: 'Toggle inspector' });
    if (width < 1000 && await toggle.getAttribute('aria-pressed') !== 'true') await toggle.click();
    await page.getByText('First track them', { exact: false }).waitFor({ state: 'attached' });
    await page.screenshot({ path: `${output}/staged-${mode}-${width}.png` });
    await shot('guide', page.locator('[data-behind-subject-empty]'));

    await fixture('trackFigure');
    const offer = page.getByRole('button', { name: 'Put behind a subject' });
    await offer.waitFor();
    await offer.click();
    await page.getByRole('menuitem', { name: 'Tracking 1' }).waitFor();
    await shot('choose', section);
    await page.keyboard.press('Escape');

    await fixture('putTitleBehind');
    await page.getByRole('button', { name: /Behind Tracking 1/ }).waitFor();
    await shot('behind', section);

    // The tool works on the stage: in a narrow window the inspector panel would cover it.
    if (width < 1000 && await toggle.getAttribute('aria-pressed') === 'true') await toggle.click();
    await fixture('openObjectMaskTool');
    const use = page.getByRole('button', { name: /Use as/ });
    await use.waitFor({ timeout: 5000 }).catch(async (error) => {
      await page.screenshot({ path: `${output}/use-as-${mode}-${width}-failure.png` });
      throw error;
    });
    await use.click();
    await page.getByRole('menuitem', { name: 'Pixelate' }).waitFor();
    await shot('use-as', page.locator('.cut-tool-bar'));
    await page.keyboard.press('Escape');
    await fixture('closeObjectMaskTool');

    if (width < 1000 && await toggle.getAttribute('aria-pressed') !== 'true') await toggle.click();
    await fixture('pixelateFigure');
    const row = page.getByText('Pixelate', { exact: true }).first();
    await row.waitFor();
    await row.click();
    await page.getByText('Block size', { exact: true }).waitFor();
    await shot('pixelate', page.getByText('Block size', { exact: true }));

    if (errors.length) throw Error(`${mode}/${width}: ${errors.join('; ')}`);
    console.log(`PASS ${mode}/${width}: ${output}/*-${mode}-${width}.png`);
    await page.close();
  }
} finally {
  await browser?.close();
  server.kill();
}
