import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';

const port = 5563;
const output = process.env.PURECUT_SCREENSHOTS || '/tmp/purecut-visual';
const server = spawn(process.execPath, ['scripts/purecut-dev.mjs', '--port', String(port)], { stdio: 'pipe' });
let log = '', browser;
server.stdout.on('data', data => { log += data; });
server.stderr.on('data', data => { log += data; });
/**
 * The Pen and the path editor, driven like a person would: the toolbar's Pen
 * button, clicks and a drag on the stage, Enter, a vertex dragged, a
 * double-click, a click on the outline, Delete, P; then a gradient's line
 * handle dragged on the canvas. What the editor wrote is read back through
 * scripts/pen-visual-fixture.tsx.
 */
async function checkPen(page, mode, errors) {
  const pen = (name, ...args) => page.evaluate(async ([name, args]) => (await import('/scripts/pen-visual-fixture.tsx'))[name](...args), [name, args]);
  const check = (value, message) => { if (!value) throw Error(`${mode} pen: ${message}`); };
  const frame = () => page.waitForTimeout(120);
  const drag = async (from, to) => {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await frame();
    await page.mouse.move(to.x, to.y, { steps: 6 });
    await frame();
    await page.mouse.up();
    await frame();
  };
  await page.evaluate(async () => (await import('/scripts/editor-visual-fixture.tsx')).prepareTrimFixture(30));
  await pen('recordEdits');

  await page.getByRole('button', { name: 'Pen', exact: true }).click();
  await frame();
  check(await pen('readTool') === 'PEN', 'the toolbar button must pick the pen');
  const [a, b, c] = await Promise.all([[300, 200], [640, 520], [980, 200]].map(([x, y]) => pen('documentToPage', x, y)));
  await page.mouse.click(a.x, a.y);
  await frame();
  await drag(b, { x: b.x + 70, y: b.y });
  await page.mouse.click(c.x, c.y);
  await frame();
  await page.mouse.move(c.x - 120, c.y + 160, { steps: 4 });
  await frame();
  await page.screenshot({ path: `${output}/pen-drawing-${mode}.png` });
  await page.mouse.click(a.x, a.y);
  await frame();

  const inserted = (await pen('recordedEdits')).filter((edit) => edit.kind === 'insert' && /^path$/i.test(edit.tag));
  check(inserted.length === 1, `closing on the first vertex must write one <path>, got ${inserted.length}`);
  const { props } = inserted[0];
  check(/C/.test(props.d) && /Z\s*$/.test(props.d), `the dragged vertex must curve and the path must close: ${props.d}`);
  check(props.viewBox === `0 0 ${props.width} ${props.height}`, `the path must carry its box as viewBox: ${props.viewBox} for ${props.width}x${props.height}`);
  let path = await pen('readPath');
  check(path.closed && path.vertices === 3 && path.selected && path.tool === 'MOVE' && path.penVertices === 0,
    `the pen must hand a selected closed path of 3 vertices to the move tool: ${JSON.stringify(path)}`);

  await page.keyboard.press('Enter');
  await frame();
  path = await pen('readPath');
  check(path.tool === 'PATH_EDIT' && path.editing, `Enter on the selected path must edit its vertices: ${path.tool}`);
  const before = path.anchors[2];
  await pen('recordEdits');
  await drag(before, { x: before.x, y: before.y + 60 });
  await page.screenshot({ path: `${output}/path-edit-${mode}.png` });
  check((await pen('recordedEdits')).some((edit) => edit.kind === 'prop' && edit.name === 'd'), 'dragging a vertex must write d');
  path = await pen('readPath');
  check(Math.abs(path.anchors[2].y - before.y - 60) < 3 && Math.abs(path.anchors[2].x - before.x) < 3,
    `the vertex must follow the pointer: ${JSON.stringify(before)} -> ${JSON.stringify(path.anchors[2])}`);
  await page.keyboard.press('Escape');
  await frame();
  path = await pen('readPath');
  check(path.tool === 'MOVE' && !path.editing, `Escape must put the editor down: ${path.tool}`);
  check(path.viewBox && path.viewBox.x === 0 && path.viewBox.y === 0 && path.viewBox.width === path.width && path.viewBox.height === path.height,
    `the box must fit the edited outline, viewBox and all: ${JSON.stringify(path.viewBox)} for ${path.width}x${path.height}`);

  // Inside the box, clear of the selection's corner handles: the mask is what takes it.
  const [first, , last] = path.anchors;
  await page.mouse.dblclick((first.x + last.x) / 2, (first.y + last.y) / 2 + 30);
  await frame();
  path = await pen('readPath');
  check(path.tool === 'PATH_EDIT' && path.editing, `double-clicking the path must edit its vertices: ${path.tool}`);
  // The closing segment is straight (both its ends are corners), so its middle is on the outline.
  await page.mouse.move((first.x + last.x) / 2 + 4, (first.y + last.y) / 2 + 4, { steps: 3 });
  await page.mouse.click((first.x + last.x) / 2, (first.y + last.y) / 2);
  await frame();
  check((await pen('readPath')).vertices === 4, 'a click on the outline must add a vertex');
  await page.keyboard.press('Backspace');
  await frame();
  path = await pen('readPath');
  check(path.vertices === 3 && path.editing, `Delete must take out the picked vertex, not the path: ${path.vertices}`);
  await page.keyboard.press('Escape');
  await frame();

  await pen('recordEdits');
  await page.keyboard.press('p');
  await frame();
  check(await pen('readTool') === 'PEN', 'P must pick the pen');
  const [d, e] = await Promise.all([[200, 600], [500, 640]].map(([x, y]) => pen('documentToPage', x, y)));
  // A double-click puts down one vertex, not two on top of each other.
  await page.mouse.dblclick(d.x, d.y);
  await frame();
  await page.mouse.click(e.x, e.y);
  await frame();
  await page.keyboard.press('Enter');
  await frame();
  const open = (await pen('recordedEdits')).find((edit) => edit.kind === 'insert' && /^path$/i.test(edit.tag));
  check(open && !/Z/i.test(open.props.d) && /viewBox/.test(Object.keys(open.props).join()), `Enter must end an open path: ${open?.props.d}`);
  check(/^M[^MLC]+L[^MLC]+$/.test(open.props.d.trim()), `two clicks, one a double-click, must make one straight segment: ${open.props.d}`);
  check(await pen('readTool') === 'MOVE', 'the move tool must be back after the pen');

  await pen('recordEdits');
  const gradient = await pen('stageGradient');
  await frame();
  check(gradient.tool === 'LINEAR_GRADIENT', `an open gradient picker must put its handles up: ${gradient.tool}`);
  const target = { x: (gradient.start.x + gradient.end.x) / 2, y: gradient.end.y + 120 };
  await drag(gradient.end, target);
  await page.screenshot({ path: `${output}/gradient-handles-${mode}.png` });
  const moved = await pen('readGradient');
  check(Math.hypot(moved.end.x - target.x, moved.end.y - target.y) < 3, `the end handle must follow the pointer: ${JSON.stringify(moved.end)} vs ${JSON.stringify(target)}`);
  const written = (await pen('recordedEdits')).filter((edit) => edit.kind === 'prop' && (edit.name === 'x2' || edit.name === 'y2'));
  check(written.length >= 2, 'dragging the handle must write x2 and y2');
  if (errors.length) throw Error(errors.join('; '));
  console.log(`PASS pen, path editing and gradient handles ${mode}: ${output}/pen-drawing-${mode}.png`);
}

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
      await checkPen(page, mode, errors);
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
