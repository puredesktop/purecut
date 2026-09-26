import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  cp,
  readdir,
  stat,
  open,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

const proxyTest = process.argv.includes('--proxy');
const appendTest = process.argv.includes('--append');
const rangeTest = process.argv.includes('--range') || appendTest;
const mediaTest = process.argv.includes('--media') || proxyTest || rangeTest;
let savedProxy;

const shell = process.env.PURECUT_SHELL_DIR || resolve('../../packages/shell');
const shellUrl = process.env.PURECUT_SHELL_URL;
if (!shellUrl)
  throw Error(
    'Set PURECUT_SHELL_URL to the running shell renderer URL. Build PureCut and the shell main/preload first.'
  );
if (!(await fetch(shellUrl, { signal: AbortSignal.timeout(5000) })).ok)
  throw Error('Shell renderer is unavailable');
const require = createRequire(join(shell, 'package.json'));
const root = await mkdtemp(join(tmpdir(), 'purecut-native-editor-'));
const mediaPath = join(root, 'native-tone.mp4');
if (mediaTest)
  execFileSync('ffmpeg', [
    '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${proxyTest ? '1920x1080' : '320x180'}:rate=30`,
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', mediaPath,
  ]);
await mkdir(join(root, 'workspace'));
await mkdir(join(root, 'profile'));
await writeFile(
  join(root, 'profile/preferences.json'),
  JSON.stringify({
    workingDirectory: join(root, 'workspace'),
    workspaceRoot: join(root, 'workspace'),
    onboardingCompletedAt: new Date().toISOString(),
    assistantIntroSeen: ['cut'],
    userProfile: {
      name: 'Native verification',
      email: 'verification@example.invalid',
      completedAt: new Date().toISOString(),
    },
  })
);
const fixtureShell = join(root, 'packages/shell');
const fixtureApp = join(root, 'apps/purecut');
await mkdir(fixtureShell, { recursive: true });
await mkdir(fixtureApp, { recursive: true });
const shellPackage = JSON.parse(
  await readFile(join(shell, 'package.json'), 'utf8')
);
await writeFile(
  join(fixtureShell, 'package.json'),
  JSON.stringify({ ...shellPackage, main: join(shell, 'out/main/index.js') })
);
const manifest = JSON.parse(await readFile('plugin.json', 'utf8'));
manifest.entrypoint = { kind: 'built-static', dir: 'dist' };
await writeFile(join(fixtureApp, 'plugin.json'), JSON.stringify(manifest));
await cp('dist', join(fixtureApp, 'dist'), { recursive: true });
let app, page;
const errors = [];
try {
  const env = {
    ...process.env,
    PURESCIENCE_USER_DATA_DIR: join(root, 'profile'),
    PURESCIENCE_WORKSPACE_ROOT: join(root, 'workspace'),
    VITE_DEV_SERVER_URL: shellUrl,
    SHELL_OPEN_DEVTOOLS: '0',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({
    executablePath: require('electron'),
    args: [fixtureShell],
    env,
    timeout: 60000,
  });
  page = await app.firstWindow({ timeout: 60000 });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text().slice(0, 1000));
  });
  await page.waitForFunction(() => !!window.platformShell);
  const paths = await app.evaluate(({ app }) => ({
    profile: app.getPath('userData'),
    workspace: process.env.PURESCIENCE_WORKSPACE_ROOT,
  }));
  if (
    paths.profile !== join(root, 'profile') ||
    paths.workspace !== join(root, 'workspace')
  )
    throw Error('Native test is not isolated');
  const apps = await page.evaluate(() =>
    window.platformShell.invoke('shell:apps:list')
  );
  console.log(
    JSON.stringify({
      root,
      paths,
      apps: apps.map((app) => ({
        id: app.manifest.id,
        entrypoint: app.manifest.entrypoint,
      })),
    })
  );
  if (
    apps.length !== 1 ||
    apps[0].manifest.id !== 'cut' ||
    apps[0].manifest.entrypoint.kind !== 'built-static'
  )
    throw Error('Unexpected native fixture app registry');
  await page.evaluate(() =>
    window.platformShell.invoke('shell:apps:open', { id: 'cut', active: true })
  );
  const cutDock = page.getByRole('toolbar', { name: 'Dock', exact: true })
    .getByRole('button', { name: 'Cut', exact: true });
  await cutDock.waitFor({ state: 'attached' });
  if (await cutDock.getAttribute('data-active') !== 'true') await cutDock.click();
  let frame;
  for (let attempt = 0; attempt < 120; attempt++) {
    frame = page
      .frames()
      .find((frame) => frame.url().startsWith('pure-app://app-637574/'));
    if (frame) break;
    await page.waitForTimeout(250);
  }
  if (!frame) throw Error('Native PureCut iframe did not open');
  await frame
    .getByRole('button', { name: /^New video/ })
    .click({ timeout: 20000 });
  await frame
    .getByRole('button', { name: 'Fit preview', exact: true })
    .waitFor({ timeout: 60000 });
  await frame
    .getByRole('status')
    .filter({ hasText: 'Opening project...' })
    .waitFor({ state: 'hidden' });
  const chunks = await readdir(join(fixtureApp, 'dist/assets'));
  const drawer =
    './assets/' +
    chunks.find((name) => name.startsWith('drawer-') && name.endsWith('.js'));
  if (process.argv.includes('--large-read') || process.argv.includes('--large-write')) {
    const path = join(root, 'workspace/large-media.bin');
    const size = 129 * 1024 * 1024;
    const file = await open(path, 'wx');
    try {
      await file.truncate(size);
      await file.write(Buffer.from('start'), 0, 5, 0);
      await file.write(Buffer.from('finish'), 0, 6, size - 6);
    } finally {
      await file.close();
    }
    const module = './assets/' + chunks.find(name => name.startsWith('platform-files-') && name.endsWith('.js'));
    const copyPath = process.argv.includes('--large-write') ? join(root, 'workspace/large-copy.bin') : null;
    const modifiedAt = (await stat(path)).mtime.getTime();
    await frame.evaluate(async ({ module, path, size, copyPath, modifiedAt }) => {
      const exports = await import(module);
      const files = Object.values(exports).find(value => value && typeof value.file === 'function');
      if (!files) throw Error('Built platform files adapter missing');
      const file = await files.file(path);
      if (file.lastModified !== modifiedAt)
        throw Error(`Native modification time mismatch: ${file.lastModified} != ${modifiedAt}`);
      if (file.size !== size || await file.slice(0, 5).text() !== 'start' ||
          await file.slice(-6).text() !== 'finish')
        throw Error('Large native read was truncated or corrupted');
      if (copyPath) await files.binary(copyPath, file);
    }, { module, path, size, copyPath, modifiedAt });
    if (copyPath) {
      const hash = async path => {
        const hash = createHash('sha256');
        for await (const chunk of createReadStream(path)) hash.update(chunk);
        return hash.digest('hex');
      };
      if ((await stat(copyPath)).size !== size || await hash(path) !== await hash(copyPath))
        throw Error('Large native write was truncated or corrupted');
      console.log(JSON.stringify({ largeNativeWriteBytes: size }));
    }
    console.log(JSON.stringify({ largeNativeReadBytes: size }));
  }
  const context = await frame.evaluate(
    async (drawer) => (await import(drawer)).cutTool('getCutContext'),
    drawer
  );
  if (!context.projectDir.startsWith(join(root, 'workspace') + '/'))
    throw Error('Native project escaped the isolated workspace');
  await frame.evaluate(async (drawer) => {
    const { cutTool } = await import(drawer);
    const context = await cutTool('getCutContext');
    return cutTool('proposeCutSource', {
      baseHash: context.hash,
      source: context.source.replace(
        'Welcome to PureCut',
        'Native saved title'
      ),
    });
  }, drawer);
  const review = frame.getByRole('dialog', { name: 'Review proposed edit' });
  await review.getByRole('button', { name: 'Apply edit', exact: true }).click();
  await review.waitFor({ state: 'hidden' });
  if (
    !(await readFile(join(context.projectDir, 'index.tsx'), 'utf8')).includes(
      'Native saved title'
    )
  )
    throw Error('Native edit was not written');
  if (mediaTest) {
    const chooserPromise = page.waitForEvent('filechooser');
    await frame.getByRole('button', { name: 'Import media', exact: true }).first().click();
    await (await chooserPromise).setFiles(mediaPath);
    const asset = frame.locator('[data-asset-id]').filter({ hasText: 'native-tone' });
    await asset.waitFor({ timeout: 30000 });
    if (rangeTest) {
      await asset.click();
      await frame.getByRole('spinbutton', { name: 'Source in', exact: true }).fill('1');
      await frame.getByRole('spinbutton', { name: 'Source out', exact: true }).fill('3');
      await frame.getByRole('button', { name: 'Play selected range', exact: true }).click();
      await frame.waitForFunction(() => {
        const video = document.querySelector('video');
        return video?.paused && Math.abs(video.currentTime - 3) < 0.05;
      }, undefined, { timeout: 10000 });
      await frame.getByRole('button', { name: 'Reset range', exact: true }).click();
      if (await frame.getByRole('spinbutton', { name: 'Source in', exact: true }).inputValue() !== '0')
        throw Error('Reset range did not restore source in');
      await frame.getByRole('spinbutton', { name: 'Source in', exact: true }).fill('1');
      await frame.getByRole('spinbutton', { name: 'Source out', exact: true }).fill('3');
      await page.screenshot({ path: join(root, 'source-range.png') });
      await frame.getByRole('button', { name: appendTest ? 'Append range to end' : 'Insert range at playhead', exact: true }).click();
    } else {
      await asset.click({ button: 'right' });
      await frame.getByRole('menuitem', { name: 'Insert at playhead', exact: true }).click();
    }
    if (proxyTest) {
      await asset.click({ button: 'right' });
      await frame.getByRole('menuitem', { name: 'Use playback proxy', exact: true }).click();
      await asset.getByText('Proxy', { exact: true }).waitFor({ timeout: 120000 });
      const proxyDir = join(context.projectDir, 'cache/playback-proxies-v1');
      const names = (await readdir(proxyDir)).filter(name => name.endsWith('.webm'));
      if (names.length !== 1) throw Error('Expected one cached playback proxy');
      const path = join(proxyDir, names[0]);
      savedProxy = { path, mtimeMs: (await stat(path)).mtimeMs };
      const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', join(proxyDir, names[0])], { encoding: 'utf8' }));
      if (probe.streams.length !== 1 || probe.streams[0].width !== 1280 || probe.streams[0].height !== 720 || Math.abs(Number(probe.format.duration) - 6) > 0.05)
        throw Error('Native proxy dimensions, tracks or duration mismatch');
      console.log(JSON.stringify({ playbackProxy: { width: 1280, height: 720, duration: probe.format.duration } }));
    }
  }
  const exported = await frame.evaluate(async (drawer) => {
    const { cutTool } = await import(drawer);
    const context = await cutTool('getCutContext');
    const id = context.source.match(/<scene\b[^>]*\bid="([^"]+)"/)[1];
    return cutTool('exportCut', { id });
  }, drawer);
  if (
    (await stat(exported.path)).size !== exported.size ||
    exported.size < 1000
  )
    throw Error('Native export bytes mismatch');
  if (mediaTest) {
    const samples = execFileSync('ffmpeg', [
      '-v', 'error', '-ss', appendTest ? '6.5' : rangeTest ? '0.5' : '4', '-i', exported.path, '-t', '1',
      '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', 'pipe:1',
    ]);
    let power = 0;
    for (let offset = 0; offset < samples.length; offset += 4)
      power += samples.readFloatLE(offset) ** 2;
    const rms = Math.sqrt(power / (samples.length / 4));
    if (samples.length < 48000 * 4 * 0.9 || !(rms > 0.01))
      throw Error(`Native imported audio missing near export tail: RMS ${rms}`);
    console.log(JSON.stringify({ nativeMediaAudioRms: rms }));
  }
  console.log(JSON.stringify({ project: context.projectDir, exported }));
  await page.screenshot({ path: join(root, 'shell.png') });
  await app.close();
  app = undefined;
  app = await electron.launch({
    executablePath: require('electron'),
    args: [fixtureShell],
    env,
    timeout: 60000,
  });
  page = await app.firstWindow({ timeout: 60000 });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text().slice(0, 1000));
  });
  frame = undefined;
  for (let attempt = 0; attempt < 120; attempt++) {
    frame = page
      .frames()
      .find((frame) => frame.url().startsWith('pure-app://app-637574/'));
    if (frame) break;
    await page.waitForTimeout(250);
  }
  if (!frame)
    throw Error('Native workspace did not restore PureCut after restart');
  await frame
    .getByRole('button', { name: 'Fit preview', exact: true })
    .waitFor({ timeout: 60000 });
  await frame
    .getByRole('status')
    .filter({ hasText: 'Opening project...' })
    .waitFor({ state: 'hidden' });
  const reopened = await frame.evaluate(
    async (drawer) => (await import(drawer)).cutTool('getCutContext'),
    drawer
  );
  if (
    reopened.projectDir !== context.projectDir ||
    !reopened.source.includes('Native saved title')
  )
    throw Error('Native restart did not restore the saved project');
  if (rangeTest && (!/sourceIn=\{1\}/.test(reopened.source) || !/sourceOut=\{3\}/.test(reopened.source)))
    throw Error('Source range was not saved and restored');
  if (appendTest && !/start=\{6\}/.test(reopened.source))
    throw Error('Appended source range did not start after existing content');
  if (proxyTest) {
    const asset = frame.locator('[data-asset-id]').filter({ hasText: 'native-tone' });
    await asset.getByText('Proxy', { exact: true }).waitFor({ timeout: 30000 });
    if ((await stat(savedProxy.path)).mtimeMs !== savedProxy.mtimeMs)
      throw Error('Restart regenerated the cached playback proxy');
    await asset.click({ button: 'right' });
    await frame.getByRole('menuitem', { name: 'Use original for playback', exact: true }).waitFor();
    await page.keyboard.press('Escape');
    console.log('PASS: native restart restored proxy selection without re-encoding');
  }
  await frame
    .getByRole('button', { name: 'Export history', exact: true })
    .click();
  const history = frame.getByRole('dialog', {
    name: 'Export history',
    exact: true,
  });
  await history.locator('video').waitFor();
  const playback = await history.locator('video').evaluate(async (video, proxyTest) => {
    if (!video.src.startsWith('purescience-fs:'))
      throw Error('Native playback did not use the production file protocol');
    video.muted = true;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(Error('Native export playback stalled')),
        10000
      );
      video.requestVideoFrameCallback(() => {
        clearTimeout(timer);
        resolve();
      });
      void video.play().catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 180;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, 320, 180);
    const pixels = ctx.getImageData(20, 55, 280, 35).data;
    let dark = 0;
    for (let i = 0; i < pixels.length; i += 4)
      if (pixels[i] < 100 && pixels[i + 1] < 100 && pixels[i + 2] < 100) dark++;
    if (proxyTest) {
      const picture = ctx.getImageData(0, 0, 320, 180).data;
      const colours = [0, 0, 0];
      for (let i = 0; i < picture.length; i += 4)
        for (let channel = 0; channel < 3; channel++)
          if (picture[i + channel] > 150 && picture[i + (channel + 1) % 3] < 80 && picture[i + (channel + 2) % 3] < 80) colours[channel]++;
      // The 1080p clip is centred in the default 720p scene: its red edge is
      // outside the scene, while the green and blue bars remain visible.
      if (colours[1] < 5000 || colours[2] < 5000) throw Error(`Native export test-pattern pixels missing: ${colours}`);
    } else if (dark < 100) throw Error('Native export title pixels missing');
    video.pause();
    return {
      width: video.videoWidth,
      height: video.videoHeight,
      duration: video.duration,
    };
  }, proxyTest);
  if (
    playback.width !== exported.width ||
    playback.height !== exported.height ||
    Math.abs(playback.duration - (appendTest ? 8 : 6)) > 0.1
  )
    throw Error('Native playback metadata mismatch');
  await history
    .getByRole('link', { name: 'Download video', exact: true })
    .waitFor();
  await page.screenshot({ path: join(root, 'restart-history.png') });
  if (errors.length) throw Error(errors.join('; '));
  console.log(
    JSON.stringify({ pass: true, root, project: context.projectDir, playback })
  );
} catch (error) {
  if (page) {
    await page.screenshot({ path: join(root, 'failure.png') }).catch(() => {});
    for (const frame of page.frames())
      console.log(
        JSON.stringify({
          url: frame.url(),
          text: await frame
            .locator('body')
            .innerText({ timeout: 1000 })
            .catch(() => 'unavailable'),
        })
      );
  }
  console.error(JSON.stringify({ errors, root }));
  throw error;
} finally {
  await app?.close();
}
