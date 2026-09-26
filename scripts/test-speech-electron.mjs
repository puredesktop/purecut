import { _electron as electron } from 'playwright'
import { createRequire } from 'node:module'
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  cp,
  readdir,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import assert from 'node:assert/strict'

// Real Electron, filesystem, bridge, local speech provider and export. Only the
// recognition result is controlled: this is not an accuracy test of an ASR model.
const shell = process.env.PURECUT_SHELL_DIR || resolve('../../packages/shell')
const shellUrl = process.env.PURECUT_SHELL_URL
if (!shellUrl || !(await fetch(shellUrl)).ok)
  throw Error('Start the shell renderer and set PURECUT_SHELL_URL')
const require = createRequire(join(shell, 'package.json'))
const root = await mkdtemp(join(tmpdir(), 'purecut-speech-electron-'))
const evidence = resolve(
  process.env.PURECUT_SPEECH_EVIDENCE || '../../../speech-electron',
)
await mkdir(evidence, { recursive: true })
const rate = 48000,
  chunks = [],
  words = []
let samples = 0
const silence = seconds => {
  const b = Buffer.alloc(Math.round(seconds * rate) * 2)
  chunks.push(b)
  samples += b.length / 2
}
silence(0.3)
for (const [i, text] of [
  'Welcome',
  'um',
  'to',
  'puredesktop',
  'We',
  'can',
  'edit',
  'speech',
].entries()) {
  const aiff = join(root, `${i}.aiff`)
  execFileSync('say', ['-v', 'Samantha', '-r', '155', '-o', aiff, text])
  const pcm = execFileSync('ffmpeg', [
    '-v',
    'error',
    '-i',
    aiff,
    '-af',
    'silenceremove=start_periods=1:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse',
    '-ar',
    String(rate),
    '-ac',
    '1',
    '-f',
    's16le',
    'pipe:1',
  ])
  const startMs = (samples / rate) * 1000
  chunks.push(pcm)
  samples += pcm.length / 2
  words.push({ text, startMs, endMs: (samples / rate) * 1000, speaker: 'A' })
  silence(i === 3 ? 2.4 : 0.2)
}
silence(0.3)
const pcm = Buffer.concat(chunks),
  header = Buffer.alloc(44)
header.write('RIFF')
header.writeUInt32LE(36 + pcm.length, 4)
header.write('WAVEfmt ', 8)
header.writeUInt32LE(16, 16)
header.writeUInt16LE(1, 20)
header.writeUInt16LE(1, 22)
header.writeUInt32LE(rate, 24)
header.writeUInt32LE(rate * 2, 28)
header.writeUInt16LE(2, 32)
header.writeUInt16LE(16, 34)
header.write('data', 36)
header.writeUInt32LE(pcm.length, 40)
await writeFile(join(root, 'speech.wav'), Buffer.concat([header, pcm]))
const mediaPath = join(evidence, 'spoken-source.mp4'),
  duration = samples / rate
execFileSync('ffmpeg', [
  '-y',
  '-v',
  'error',
  '-f',
  'lavfi',
  '-i',
  'testsrc2=size=640x360:rate=30',
  '-i',
  join(root, 'speech.wav'),
  '-t',
  String(duration),
  '-c:v',
  'libx264',
  '-pix_fmt',
  'yuv420p',
  '-c:a',
  'aac',
  mediaPath,
])
const mediaBytes = await readFile(mediaPath)
let requests = 0,
  healthy = false
const server = createServer(async (req, res) => {
  try {
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/health') {
      res.statusCode = healthy ? 200 : 503
      return res.end(
        JSON.stringify({ ok: healthy, model: 'synthetic-speech-test' }),
      )
    }
    assert.equal(req.url, '/diarize')
    const body = []
    for await (const data of req) body.push(data)
    const form = await new Response(Buffer.concat(body), {
      headers: { 'content-type': req.headers['content-type'] },
    }).formData()
    assert.deepEqual(
      Buffer.from(await form.get('audio').arrayBuffer()),
      mediaBytes,
    )
    assert.equal(JSON.parse(form.get('options')).disfluencies, true)
    requests++
    res.end(
      JSON.stringify({
        model: 'synthetic-speech-test',
        durationMs: duration * 1000,
        turns: [
          {
            startMs: words[0].startMs,
            endMs: words.at(-1).endMs,
            speaker: 'A',
          },
        ],
        words,
      }),
    )
  } catch (error) {
    res.statusCode = 500
    res.end(JSON.stringify({ error: error.message }))
    console.error(error)
  }
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
await mkdir(join(root, 'workspace'))
await mkdir(join(root, 'profile'))
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
    speechProvider: 'local-sidecar',
    speechSidecarUrl: `http://127.0.0.1:${server.address().port}`,
  }),
)
const fixtureShell = join(root, 'packages/shell'),
  fixtureApp = join(root, 'apps/purecut')
await mkdir(fixtureShell, { recursive: true })
await mkdir(fixtureApp, { recursive: true })
await writeFile(
  join(fixtureShell, 'package.json'),
  JSON.stringify({
    ...JSON.parse(await readFile(join(shell, 'package.json'), 'utf8')),
    main: join(shell, 'out/main/index.js'),
  }),
)
await writeFile(
  join(fixtureApp, 'plugin.json'),
  JSON.stringify({
    ...JSON.parse(await readFile('plugin.json', 'utf8')),
    entrypoint: { kind: 'built-static', dir: 'dist' },
  }),
)
await cp('dist', join(fixtureApp, 'dist'), { recursive: true })
const drawer =
  './assets/' +
  (await readdir('dist/assets')).find(
    n => n.startsWith('drawer-') && n.endsWith('.js'),
  )
const env = {
  ...process.env,
  PURESCIENCE_USER_DATA_DIR: join(root, 'profile'),
  PURESCIENCE_WORKSPACE_ROOT: join(root, 'workspace'),
  VITE_DEV_SERVER_URL: shellUrl,
  SHELL_OPEN_DEVTOOLS: '0',
}
delete env.ELECTRON_RUN_AS_NODE
let app, page, frame
const errors = []
async function launch() {
  app = await electron.launch({
    executablePath: require('electron'),
    args: [fixtureShell],
    env,
    timeout: 60000,
  })
  page = await app.firstWindow({ timeout: 60000 })
  page.setDefaultTimeout(20000)
  page.on('pageerror', e => errors.push(e.message))
  page.on('console', m => {
    if (m.type() === 'error') console.log('CONSOLE', m.text().slice(0, 700))
  })
  await page.waitForFunction(() => !!window.platformShell)
}
async function getFrame() {
  for (let i = 0; i < 120; i++) {
    frame = page
      .frames()
      .find(f => f.url().startsWith('pure-app://app-637574/'))
    if (frame) return
    await page.waitForTimeout(250)
  }
  throw Error('Cut iframe missing')
}
const tool = (name, args = {}) =>
  frame.evaluate(
    async ({ drawer, name, args }) =>
      (await import(drawer)).cutTool(name, args),
    { drawer, name, args },
  )
const button = name => frame.getByRole('button', { name, exact: true })
async function ready() {
  await button('Fit preview').waitFor({ timeout: 60000 })
  await frame
    .getByRole('status')
    .filter({ hasText: 'Opening project...' })
    .waitFor({ state: 'hidden' })
}
try {
  console.log(JSON.stringify({ root, evidence, duration, words }))
  await launch()
  assert.equal(
    await app.evaluate(({ app }) => app.getPath('userData')),
    join(root, 'profile'),
  )
  await page.evaluate(() =>
    window.platformShell.invoke('shell:apps:open', { id: 'cut', active: true }),
  )
  const dock = page
    .getByRole('toolbar', { name: 'Dock', exact: true })
    .getByRole('button', { name: 'Cut', exact: true })
  await dock.waitFor()
  if ((await dock.getAttribute('data-active')) !== 'true') await dock.click()
  await getFrame()
  await frame
    .getByRole('button', { name: /^New video/ })
    .click({ timeout: 30000 })
  await ready()
  const context = await tool('getCutContext')
  assert.ok(context.projectDir.startsWith(join(root, 'workspace') + '/'))
  const chooser = page.waitForEvent('filechooser')
  await button('Import media').first().click()
  await (await chooser).setFiles(mediaPath)
  const asset = frame
    .locator('[data-asset-id]')
    .filter({ hasText: 'spoken-source' })
  await asset.waitFor({ timeout: 30000 })
  await asset.click({ button: 'right' })
  await frame
    .getByRole('menuitem', { name: 'Insert at playhead', exact: true })
    .click()
  const imported = await tool('getCutContext')
  console.log('IMPORTED', imported.source)
  const videoTag = imported.source.match(/<rect\b[^>]*>[\s\S]*?<\/rect>/)?.[0]
  assert.ok(videoTag, 'Imported video source missing')
  await tool('proposeCutSource', {
    baseHash: imported.hash,
    source: `export default () => <stage><scene active name="Speech" width={640} height={360}>${videoTag
      .replace(/x=\{320\}/, 'x={0}')
      .replace(/y=\{180\}/, 'y={0}')}</scene></stage>`,
  })
  const review = frame.getByRole('dialog', { name: 'Review proposed edit' })
  await review.getByRole('button', { name: 'Apply edit', exact: true }).click()
  await review.waitFor({ state: 'hidden' })
  await button('Fit preview').click()
  console.log('STEP open transcript')
  await button('Transcript').click()
  await frame
    .getByText('Configure an audio transcription provider', { exact: false })
    .waitFor()
  assert.equal(await button('Transcribe recording').count(), 0)
  assert.equal(requests, 0)
  healthy = true
  await button('Refresh').click()
  console.log('STEP transcribe')
  await button('Transcribe recording').click({ timeout: 30000 })
  await frame.locator('[data-speech-key]').filter({ hasText: /^um$/ }).waitFor({ timeout: 30000 })
  assert.equal(requests, 1)
  const original = await tool('getCutTranscript')
  assert.equal(original.words.length, words.length)
  await frame.locator('[data-speech-key]').filter({ hasText: /^um$/ }).click()
  await button('Cut selection').click()
  await frame
    .getByRole('group', { name: 'Review speech edit', exact: true })
    .waitFor({ state: 'hidden' })
  await frame.locator('[data-speech-key]').filter({ hasText: /^um$/ }).waitFor({ state: 'hidden' })
  let edited = await tool('getCutTranscript')
  assert.equal(edited.words.length, words.length - 1)
  await frame.getByLabel('Undo', { exact: true }).click()
  await button('Refresh').click()
  await frame.locator('[data-speech-key]').filter({ hasText: /^um$/ }).waitFor()
  await button('Redo').click()
  await button('Refresh').click()
  await frame.locator('[data-speech-key]').filter({ hasText: /^um$/ }).waitFor({ state: 'hidden' })
  await frame.getByLabel('Undo', { exact: true }).click()
  await button('Refresh').click()
  await frame.locator('[data-speech-key]').filter({ hasText: /^um$/ }).waitFor()
  await frame.getByText('Clean up speech', { exact: true }).click()
  await frame
    .getByRole('button', { name: /Review \d+ filler suggestions/ })
    .click()
  await button('Apply edit').click()
  await frame
    .getByRole('group', { name: 'Review speech edit', exact: true })
    .waitFor({ state: 'hidden' })
  await frame.locator('[data-speech-key]').filter({ hasText: /^um$/ }).waitFor({ state: 'hidden' })
  edited = await tool('getCutTranscript')
  assert.ok(edited.duration < original.duration)
  await frame.getByText('Clean up speech', { exact: true }).click()
  await frame
    .getByRole('spinbutton', { name: 'Minimum pause seconds', exact: true })
    .fill('1.5')
  await frame
    .getByRole('spinbutton', { name: 'Retained pause seconds', exact: true })
    .fill('0.3')
  await button('Review pauses').click()
  await button('Apply edit').click()
  await frame
    .getByRole('group', { name: 'Review speech edit', exact: true })
    .waitFor({ state: 'hidden' })
  const shortened = await tool('getCutTranscript')
  assert.ok(shortened.duration < edited.duration - 1.8)
  await button('Generate captions').click()
  let captioned
  for (let i = 0; i < 100; i++) {
    captioned = await tool('getCutContext')
    if (captioned.source.includes('<captions')) break
    await page.waitForTimeout(100)
  }
  assert.ok(captioned.source.includes('<captions'))
  await page.screenshot({ path: join(evidence, 'electron-transcript.png') })
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(900, 800),
  )
  await page.screenshot({ path: join(evidence, 'electron-narrow.png') })
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1280, 840),
  )
  const exported = await tool('exportCut', {
    id: captioned.source.match(/<scene\b[^>]*\bid="([^"]+)"/)[1],
  })
  const output = join(evidence, 'spoken-edited.mp4')
  await cp(exported.path, output)
  const probe = JSON.parse(
    execFileSync(
      'ffprobe',
      ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', output],
      { encoding: 'utf8' },
    ),
  )
  assert.ok(probe.streams.some(s => s.codec_type === 'video'))
  assert.ok(probe.streams.some(s => s.codec_type === 'audio'))
  assert.ok(Math.abs(Number(probe.format.duration) - shortened.duration) < 0.15)
  const decode = path => {
    const bytes = execFileSync(
      'ffmpeg',
      [
        '-v',
        'error',
        '-i',
        path,
        '-vn',
        '-ac',
        '1',
        '-ar',
        '16000',
        '-f',
        'f32le',
        'pipe:1',
      ],
      { maxBuffer: 8 * 1024 * 1024 },
    )
    return Float32Array.from({ length: bytes.length / 4 }, (_, i) =>
      bytes.readFloatLE(i * 4),
    )
  }
  const originalAudio = decode(mediaPath),
    editedAudio = decode(output)
  const correlations = shortened.words.map(word => {
    const original = words[word.index],
      length = Math.floor((word.end - word.start - 0.06) * 16000)
    const inputStart = Math.round((original.startMs / 1000 + 0.03) * 16000)
    const outputStart = Math.round((word.start + 0.03) * 16000)
    let best = -1,
      bestShift = 0
    for (let shift = -1600; shift <= 1600; shift++) {
      let dot = 0,
        a2 = 0,
        b2 = 0
      for (let i = 0; i < length; i += 2) {
        const a = originalAudio[inputStart + i] || 0,
          b = editedAudio[outputStart + i + shift] || 0
        dot += a * b
        a2 += a * a
        b2 += b * b
      }
      const correlation = dot / Math.sqrt(a2 * b2 || 1)
      if (correlation > best) {
        best = correlation
        bestShift = shift
      }
    }
    assert.ok(
      best > 0.75,
      `Exported word ${word.text} lost alignment or audio: ${best}`,
    )
    return {
      word: word.text,
      correlation: best,
      offsetSeconds: bestShift / 16000,
    }
  })
  assert.ok(
    Math.max(...correlations.map(c => c.offsetSeconds)) -
      Math.min(...correlations.map(c => c.offsetSeconds)) <
      1 / 30,
    'Audio drifted across cuts',
  )
  console.log('AUDIO', JSON.stringify(correlations))
  const keep = shortened.words.filter(w =>
    ['We', 'can', 'edit', 'speech'].includes(w.text),
  )
  const current = await tool('getCutTranscript')
  await tool('proposeCutSpeechEdit', {
    baseHash: current.baseHash,
    mode: 'highlight',
    title: 'Speech highlight',
    ranges: [{ start: keep[0].start, end: keep.at(-1).end }],
  })
  await button('Apply edit').click()
  await frame
    .getByRole('group', { name: 'Review speech edit', exact: true })
    .waitFor({ state: 'hidden' })
  assert.equal(
    ((await tool('getCutContext')).source.match(/<scene\b/g) || []).length,
    2,
  )
  await frame.getByLabel('Undo', { exact: true }).click()
  await button('Refresh').click()
  const saved = await tool('getCutContext')
  await app.close()
  app = undefined
  await launch()
  await getFrame()
  await ready()
  const reopened = await tool('getCutContext')
  assert.equal(reopened.projectDir, context.projectDir)
  assert.equal(reopened.source, saved.source)
  console.log('STEP open transcript')
  await button('Transcript').click()
  await frame.locator('[data-speech-key]').filter({ hasText: /^speech$/ }).waitFor()
  assert.equal(requests, 1, 'Restart must use saved transcript')
  await button('Export history').click()
  const video = frame
    .getByRole('dialog', { name: 'Export history', exact: true })
    .locator('video')
  await video.waitFor()
  const playback = await video.evaluate(async v => {
    v.muted = true
    await v.play()
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Playback stalled')), 10000)
      v.requestVideoFrameCallback(() => {
        clearTimeout(timer)
        resolve()
      })
    })
    v.pause()
    return { src: v.src, width: v.videoWidth, duration: v.duration }
  })
  assert.ok(playback.src.startsWith('purescience-fs:'))
  assert.equal(
    playback.width,
    probe.streams.find(s => s.codec_type === 'video').width,
  )
  await page.screenshot({ path: join(evidence, 'electron-export.png') })
  assert.deepEqual(errors, [])
  await writeFile(
    join(evidence, 'results.json'),
    JSON.stringify(
      {
        status: 'PASS',
        root,
        originalSeconds: original.duration,
        fillerRemovedSeconds: original.duration - edited.duration,
        pauseRemovedSeconds: edited.duration - shortened.duration,
        exportedSeconds: probe.format.duration,
        requests,
        correlations,
        playback,
        checks: [
          'normal import/editing without a speech service',
          'native shared speech provider',
          'actual spoken media uploaded intact',
          'preserve fillers forwarded',
          'transcript selection and preview',
          'delete/undo/redo',
          'filler cleanup',
          'pause cleanup',
          'aligned captions',
          'native audio/video export',
          'drawer highlight and undo',
          'cold restart persisted edits and transcript',
          'native export playback',
        ],
      },
      null,
      2,
    ),
  )
  console.log(
    'PASS: Electron spoken-video workflow',
    JSON.stringify({
      original: original.duration,
      edited: shortened.duration,
      output,
    }),
  )
} catch (error) {
  if (page) {
    await page
      .screenshot({ path: join(evidence, 'failure.png') })
      .catch(() => {})
    console.log(
      'BODY',
      await page
        .locator('body')
        .innerText()
        .catch(() => ''),
    )
    if (frame)
      console.log(
        'APP BODY',
        await frame
          .locator('body')
          .innerText()
          .catch(() => ''),
      )
  }
  throw error
} finally {
  if (app) await app.close()
  await new Promise(r => server.close(r))
}
