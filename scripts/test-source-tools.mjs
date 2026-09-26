import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const port = 5564;
const server = spawn(process.execPath, ['scripts/purecut-dev.mjs', '--port', String(port)], { stdio: 'pipe' });
let browser, log = '';
server.stdout.on('data', data => { log += data; });
server.stderr.on('data', data => { log += data; });
try {
  for (let attempt = 0; ; attempt++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/`)).ok) break; } catch {}
    if (attempt > 120 || server.exitCode !== null) throw Error(log);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  for (const scenario of ['discard', 'apply', 'stale', 'locked', 'closed']) {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/source-tool-fixture', route => route.fulfill({ contentType: 'text/html', body: '<html><body><main id="fixture"></main></body></html>' }));
    await page.goto(`http://127.0.0.1:${port}/source-tool-fixture`);
    await page.evaluate(async () => {
      const { mountSourceToolFixture } = await import('/scripts/source-tool-fixture.tsx');
      window.fixture = await mountSourceToolFixture(document.getElementById('fixture'));
    });
    if (scenario === 'locked') await page.evaluate(() => window.fixture.lockSecond());
    const before = await page.evaluate(() => window.fixture.read());
    const proposal = await page.evaluate(() => window.fixture.propose());
    if (proposal.status !== 'awaiting_review' || (await page.evaluate(() => window.fixture.read())).hash !== before.hash)
      throw Error(`${scenario}: proposing must not change source`);
    const dialog = page.getByRole('dialog', { name: 'Review proposed edit' });
    await dialog.waitFor();
    if (scenario === 'discard') {
      await dialog.getByRole('button', { name: 'Discard', exact: true }).click();
      if ((await page.evaluate(() => window.fixture.read())).hash !== before.hash) throw Error('Discard wrote source');
    } else {
      const expected = scenario === 'stale' ? await page.evaluate(() => window.fixture.changeOutside()) : before;
      if (scenario === 'closed') await page.evaluate(() => window.fixture.closeProject());
      await dialog.getByRole('button', { name: 'Apply edit', exact: true }).click();
      if (scenario === 'apply') {
        await dialog.waitFor({ state: 'hidden' });
        const saved = await page.evaluate(() => window.fixture.read());
        const state = await page.evaluate(() => window.fixture.state());
        if (saved.hash !== proposal.proposedHash || state.text !== 'A reviewed tool edit' || !state.canUndo)
          throw Error('Tool application did not save the reviewed revision with undo');
        await page.evaluate(() => window.fixture.undo());
        const undone = await page.evaluate(() => ({ state: window.fixture.state(), initial: window.fixture.initialText }));
        if (undone.state.text !== undone.initial) throw Error('Tool edit did not undo');
      } else {
        await dialog.getByRole('alert').waitFor();
        const state = await page.evaluate(() => window.fixture.state());
        if (!new RegExp(scenario === 'stale' ? 'changed' : scenario === 'closed' ? 'No project open' : 'locked', 'i').test(state.error)) throw Error(`Unexpected review failure: ${state.error}`);
        if ((await page.evaluate(() => window.fixture.read())).hash !== expected.hash) throw Error(`${scenario}: rejected tool proposal changed source`);
        if (state.text !== await page.evaluate(() => window.fixture.initialText)) throw Error(`${scenario}: rejected tool proposal changed the live text`);
        await dialog.getByRole('button', { name: 'Discard', exact: true }).click();
      }
    }
    await page.evaluate(() => window.fixture.dispose());
    if (errors.length) throw Error(errors.join('; '));
    console.log(`PASS source tool/${scenario}`);
    await page.close();
  }
} finally {
  await browser?.close(); server.kill('SIGTERM');
  if (server.exitCode === null) await new Promise(resolve => server.once('exit', resolve));
}
