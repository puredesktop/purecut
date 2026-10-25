import { chromium } from 'playwright'
import { spawn, execFileSync } from 'node:child_process'
import { writeFile, readFile, mkdir } from 'node:fs/promises'
import assert from 'node:assert/strict'
const port = Number(process.env.SPEECH_TEST_PORT) || 5571,
  out = process.env.SPEECH_VERIFICATION_DIR || '../../../speech-verification',
  server = spawn(
    process.execPath,
    ['scripts/purecut-dev.mjs', '--port', String(port)],
    { stdio: 'pipe' },
  )
let log = '',
  browser
server.stdout.on('data', d => (log += d))
server.stderr.on('data', d => (log += d))
try {
  await mkdir(out, { recursive: true })
  execFileSync('ffmpeg', [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=red:size=320x180:rate=30:duration=6',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000:duration=6',
    '-vf',
    "drawbox=x=0:y=0:w=iw:h=ih:color=0x00ff00:t=fill:enable='gte(t,3)'",
    '-af',
    "volume=0:enable='between(t,2.6,3.8)'",
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    `${out}/source.mp4`,
  ])
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}`)).ok) break
    } catch {}
    if (i > 120 || server.exitCode !== null) throw Error(log)
    await new Promise(r => setTimeout(r, 250))
  }
  // SPEECH_TEST_BROWSER=<path> runs another Chromium build instead of Chrome.
  const executablePath = process.env.SPEECH_TEST_BROWSER
  browser = await chromium.launch({ ...(executablePath ? { executablePath } : { channel: 'chrome' }), headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const errors = []
  page.on('pageerror', e => {
    errors.push(e.message)
    console.log('PAGE ERROR', e.message)
  })
  await page.route('**/speech-check', r =>
    r.fulfill({
      contentType: 'text/html',
      body: '<html><body style="margin:0"><main id="fixture" style="height:100vh;display:flex"></main></body></html>',
    }),
  )
  await page.route('**/speech-media.mp4', async route =>
    route.fulfill({
      contentType: 'video/mp4',
      body: await readFile(`${out}/source.mp4`),
    }),
  )
  await page.goto(`http://127.0.0.1:${port}/speech-check`)
  await page.evaluate(async () => {
    const { speechFixture } = await import('/scripts/speech-fixture.tsx')
    window.speechFixture = await speechFixture(
      document.getElementById('fixture'),
    )
  })
  // Every status the panel can show, without a transcript yet. Reading and
  // showing status must never start a job or upload anything.
  const fixtureState = () => page.evaluate(() => window.speechFixture.state())
  const panel = page.getByRole('region', { name: 'Speech editing' })
  const transcribe = page.getByRole('button', {
    name: 'Transcribe recording',
    exact: true,
  })
  const checkAgain = panel.getByRole('button', { name: 'Check again', exact: true })
  const shots = async name => {
    await mkdir(out, { recursive: true })
    for (const [width, theme] of [[1440, 'light'], [1440, 'dark'], [375, 'light'], [375, 'dark']]) {
      await page.setViewportSize({ width, height: 900 })
      await page.evaluate(t => (document.documentElement.dataset.kbTheme = t), theme)
      await page.screenshot({ path: `${out}/status-${name}-${width}-${theme}.png` })
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
        `${name} scrolls sideways at ${width}px`,
      )
    }
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.evaluate(() => (document.documentElement.dataset.kbTheme = 'light'))
  }
  const showsOnly = async (text, name) => {
    await panel.getByText(text, { exact: false }).waitFor()
    assert.equal(await transcribe.count(), 0, `${name}: no Transcribe button`)
    assert.equal((await fixtureState()).started, 0, `${name}: nothing was sent`)
  }
  await showsOnly('Connect a transcription service in PureDesktop Settings → Speech', 'no provider')
  await panel.getByText('Transcribe this recording', { exact: true }).waitFor()
  await panel.getByText('No speech service', { exact: false }).waitFor()
  await shots('no-provider')

  await page.evaluate(() => window.speechFixture.setService({ available: false, reason: 'missing-key' }))
  await checkAgain.click()
  await showsOnly('AssemblyAI needs an API key', 'missing key')

  await page.evaluate(() =>
    window.speechFixture.setService({ id: 'whisper', label: 'Whisper on this computer', kind: 'local', available: false, reason: 'runtime-unreachable' }))
  await checkAgain.click()
  await showsOnly('Whisper on this computer isn’t responding on this computer', 'unreachable')

  await page.evaluate(() => {
    window.speechFixture.configure()
    window.speechFixture.setSettings({ speechEditingEnabled: false })
  })
  await checkAgain.click()
  await showsOnly('Transcription is turned off', 'disabled')
  await shots('disabled')
  await page.evaluate(() => window.speechFixture.setSettings({}))
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await transcribe.waitFor()
  // The cloud-consent gate is unchanged.
  assert.equal(await transcribe.isDisabled(), true)
  await page
    .getByRole('checkbox', { name: 'Allow this recording', exact: false })
    .check()
  await shots('ready')

  // A running job: each phase says what is happening, then cancel.
  const job = panel.locator('.cut-transcription-job')
  await page.evaluate(() => window.speechFixture.setJobs([{ state: 'queued' }]))
  await transcribe.click()
  await job.getByText('Waiting to start', { exact: true }).waitFor()
  assert.equal((await fixtureState()).started, 1)
  await shots('waiting')
  await page.evaluate(() => window.speechFixture.setJobs([{ state: 'running', progress: 0.02 }]))
  await job.getByText('Uploading the recording', { exact: true }).waitFor()
  await shots('uploading')
  await page.evaluate(() => window.speechFixture.setJobs([{ state: 'running', progress: 0.5 }]))
  await job.getByText('Transcribing', { exact: true }).waitFor()
  assert.equal(await job.getByText('%', { exact: false }).count(), 0, 'no invented percentage for a cloud service')
  assert.equal(await job.getByRole('progressbar').count(), 0)
  await shots('processing')
  await job.getByRole('button', { name: 'Cancel transcription', exact: true }).click()
  await panel.getByText('Transcription cancelled. No transcript was saved.', { exact: true }).waitFor()
  assert.equal((await fixtureState()).cancelled, 1, 'cancelling stops the host job')
  await transcribe.waitFor()
  assert.equal((await fixtureState()).started, 1, 'cancelled status does not start another job')
  await shots('cancelled')

  // Today’s limit: refused, then offered again once the limit is raised.
  await page.evaluate(() => window.speechFixture.setJobs([{ state: 'done', result: { status: 'skipped', reason: 'daily-cap' } }]))
  await transcribe.click()
  await panel.getByRole('alert').getByText('Today’s limit of 20 transcriptions is used up.', { exact: false }).waitFor()
  assert.equal(await transcribe.count(), 0, 'no retry while the limit stands')
  await checkAgain.click()
  await panel.getByRole('alert').waitFor()
  assert.equal(await transcribe.count(), 0, 'checking again under the same limit still refuses')
  await page.evaluate(() => window.speechFixture.setSettings({ diarizationDailyCap: 40 }))
  await checkAgain.click()
  await transcribe.waitFor()
  assert.equal(await panel.getByRole('alert').count(), 0, 'a raised limit clears the refusal')
  assert.equal((await fixtureState()).started, 2, 'checking eligibility sends nothing')

  // A failure: says what happened and why sending again today won’t work.
  await page.evaluate(() => window.speechFixture.setJobs([{ state: 'failed', result: { status: 'skipped', reason: 'unavailable' } }]))
  await transcribe.click()
  const failure = panel.getByRole('alert')
  await failure.getByText('Transcription didn’t finish', { exact: true }).waitFor()
  await failure.getByText('AssemblyAI could not transcribe this recording.', { exact: true }).waitFor()
  await failure.getByText('can take this recording again tomorrow', { exact: false }).waitFor()
  assert.equal(await transcribe.count(), 0, 'no retry the host would refuse')
  assert.equal(await panel.getByRole('button', { name: 'Try again', exact: true }).count(), 0)
  await shots('failed')
  await checkAgain.click()
  await failure.getByText('Transcription didn’t finish', { exact: true }).waitFor()
  assert.equal((await fixtureState()).started, 3, 'checking again after a failure sends nothing')

  // Another service clears it; this one completes.
  await page.evaluate(() => {
    window.speechFixture.setService({ id: 'assemblyai-eu', label: 'AssemblyAI (EU)', available: true })
    window.speechFixture.setJobs(null)
  })
  await checkAgain.click()
  await transcribe.waitFor()
  assert.equal(await panel.getByRole('alert').count(), 0)
  assert.equal(await transcribe.isDisabled(), true, 'consent is asked again for another service')
  await page
    .getByRole('checkbox', { name: 'Allow this recording to be uploaded to AssemblyAI (EU)', exact: false })
    .check()
  await transcribe.click()
  await page.locator('[data-speech-key]').filter({ hasText: /^um$/ }).waitFor()
  const before = await page.evaluate(() => window.speechFixture.state())
  assert.equal(before.units.length, 1)
  // Native text selection, followed by Delete, must edit media immediately.
  await page.locator('[data-speech-key]').filter({ hasText: /^um$/ }).dblclick()
  await page.keyboard.press('Delete')
  assert.deepEqual((await page.evaluate(() => window.speechFixture.state())).timelineKeys, [])
  await page.waitForFunction(
    () => window.speechFixture.state().units?.length === 2,
  )
  await page.locator('[data-speech-key]').filter({ hasText: /^um$/ })
    .waitFor({ state: 'hidden' })
  await page.evaluate(() => window.speechFixture.undo())
  await page.locator('[data-speech-key]').filter({ hasText: /^um$/ }).waitFor()
  const helloBox = await page.locator('[data-speech-key]').filter({ hasText: /^Hello$/ }).boundingBox()
  const umBox = await page.locator('[data-speech-key]').filter({ hasText: /^um$/ }).boundingBox()
  await page.mouse.move(helloBox.x, helloBox.y + helloBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(umBox.x + umBox.width + 2, umBox.y + umBox.height / 2, { steps: 12 })
  await page.mouse.up()
  assert.equal(await page.getByRole('document', { name: 'Transcript words' }).evaluate(el => el === document.activeElement), true)
  assert.deepEqual(await page.locator('.is-selected').allTextContents(), ['Hello', 'um'])
  await page.keyboard.press('Backspace')
  await page.locator('[data-speech-key]').filter({ hasText: /^Hello$/ }).waitFor({ state: 'hidden' })
  await page.locator('[data-speech-key]').filter({ hasText: /^um$/ }).waitFor({ state: 'hidden' })
  assert.deepEqual((await page.evaluate(() => window.speechFixture.state())).timelineKeys, [])
  await page.keyboard.press('Control+z')
  await page.locator('[data-speech-key]').filter({ hasText: /^Hello$/ }).waitFor()
  await page.locator('[data-speech-key]').filter({ hasText: /^um$/ }).waitFor()
  await page.evaluate(() => window.speechFixture.agentSpeechChecks())
  const captionReview = page.getByRole('group', {name:'Review speech edit'})
  await captionReview.getByText('Generate captions from the saved transcript.', {exact:false}).waitFor()
  assert.equal(await captionReview.getByRole('button', {name:'Preview result'}).count(), 0)
  await captionReview.getByRole('button', {name:'Apply edit', exact:true}).click()
  await page.waitForFunction(() => window.speechFixture.state().units?.some(u => u.tag === 'captions'))
  await page.evaluate(() => window.speechFixture.undo())
  await page.waitForFunction(() => window.speechFixture.state().units?.length === 1)
  const checks = await page.evaluate(() => window.speechFixture.coreChecks())
  assert.equal(checks.duration, 5.5)
  assert.equal(checks.children, 4)
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await page.locator('[data-speech-key]').filter({ hasText: /^Next$/ }).waitFor()
  // A saved transcript keeps working when the service goes away.
  const startedWithTranscript = (await fixtureState()).started
  await page.evaluate(() => window.speechFixture.setService({ available: false, reason: 'missing-key' }))
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  const note = panel.getByRole('note')
  await note.waitFor()
  assert.match(await note.textContent(), /^New transcription is unavailable: AssemblyAI needs an API key\. This transcript, cleanup, captions and search keep working\.$/)
  await page.locator('[data-speech-key]').filter({ hasText: /^Next$/ }).waitFor()
  await page.waitForFunction(() => {
    const button = [...document.querySelectorAll('button')].find(b => b.textContent === 'Generate captions')
    return button && !button.closest('fieldset')?.disabled
  })
  await page.getByRole('textbox', { name: 'Find words or a topic' }).fill('world')
  await panel.getByRole('button', { name: /world/ }).first().waitFor()
  await shots('transcript-service-unavailable')
  await page.getByRole('textbox', { name: 'Find words or a topic' }).fill('')
  assert.equal((await fixtureState()).started, startedWithTranscript, 'the note sends nothing')
  await page.evaluate(() => window.speechFixture.setService({ id: 'assemblyai-eu', label: 'AssemblyAI (EU)', available: true }))
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await page.locator('[data-speech-key]').filter({ hasText: /^Next$/ }).waitFor()
  assert.equal(await panel.getByRole('note').count(), 0)
  // A saved transcript that cannot be read says so, offers a way back and sends nothing.
  const startedBeforeDamage = (await fixtureState()).started
  const checkScene = panel.getByRole('button', { name: 'Check scene again', exact: true })
  for (const kind of ['malformed', 'unreadable']) {
    await page.evaluate(k => window.speechFixture.breakTranscript(k), kind)
    await page.getByRole('button', { name: 'Refresh', exact: true }).click()
    await panel.getByText('The saved transcript couldn’t be opened', { exact: true }).waitFor()
    await panel.getByText('It has not been changed or replaced.', { exact: false }).waitFor()
    await checkScene.waitFor()
    assert.equal(await panel.getByText('Looking at this scene…').count(), 0, `${kind}: not left looking busy`)
    assert.equal(await transcribe.count(), 0)
    await shots(`transcript-${kind}`)
  }
  await page.getByText('Permission denied', { exact: false }).waitFor()
  assert.equal((await fixtureState()).started, startedBeforeDamage, 'a damaged transcript sends nothing')
  await page.evaluate(() => window.speechFixture.breakTranscript(null))
  await checkScene.click()
  await page.locator('[data-speech-key]').filter({ hasText: /^Next$/ }).waitFor()
  await mkdir(out, { recursive: true })
  for (const width of [1440, 640, 375]) {
    await page.setViewportSize({ width, height: 900 })
    await page.screenshot({
      path: `${out}/transcript-${width}.png`,
    })
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    )
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  const exported = await page.evaluate(() => window.speechFixture.exportAudio())
  await writeFile(
    `${out}/edited.webm`,
    Buffer.from(exported.base64, 'base64'),
  )
  const probe = JSON.parse(
    execFileSync(
      'ffprobe',
      [
        '-v',
        'error',
        '-show_streams',
        '-show_format',
        '-of',
        'json',
        `${out}/edited.webm`,
      ],
      { encoding: 'utf8' },
    ),
  )
  assert.ok(probe.streams.some(s => s.codec_type === 'audio'))
  assert.ok(probe.streams.some(s => s.codec_type === 'video'))
  assert.ok(Math.abs(Number(probe.format.duration) - 5.5) < 0.15)
  const output = `${out}/edited.webm`
  const samples = execFileSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-i',
      output,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '48000',
      '-f',
      'f32le',
      'pipe:1',
    ],
    { maxBuffer: 8 * 1024 * 1024 },
  )
  const power = (from, to) => {
    let sum = 0,
      n = 0
    for (
      let i = Math.floor(from * 48000);
      i < Math.min(Math.floor(to * 48000), samples.length / 4);
      i++
    ) {
      const v = samples.readFloatLE(i * 4)
      sum += v * v
      n++
    }
    return Math.sqrt(sum / n)
  }
  assert.ok(power(2.3, 2.9) < 0.005, 'silence moves with the source cut')
  assert.ok(
    power(1.7, 1.9) > 0.01 && power(3.5, 3.8) > 0.01 && power(5.2, 5.4) > 0.01,
    'sound before, after and at the export tail survives',
  )
  const pixel = time =>
    execFileSync('ffmpeg', [
      '-v',
      'error',
      '-ss',
      String(time),
      '-i',
      output,
      '-frames:v',
      '1',
      '-vf',
      'crop=2:2:10:10,format=rgb24',
      '-f',
      'rawvideo',
      'pipe:1',
    ])
  const red = pixel(2.3),
    green = pixel(2.7)
  assert.ok(
    red[0] > 180 && red[1] < 80 && green[1] > 180 && green[0] < 80,
    'video cut stays aligned with audio',
  )
  await page.evaluate(() => window.speechFixture.overrideChecks())
  await page.evaluate(() => window.speechFixture.highlightChecks())
  const uploadsBeforeOverride = (await page.evaluate(() => window.speechFixture.state())).started
  await page.evaluate(() => window.speechFixture.addOverlay())
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  const override = page.getByRole('button', { name: 'Edit recording only', exact: true })
  await override.waitFor()
  await override.click()
  await page.getByText('Editing recording only.', { exact: true }).waitFor()
  assert.equal((await page.evaluate(() => window.speechFixture.state())).started, uploadsBeforeOverride,
    'override must not upload media')
  // Unsupported scene, then a scene with no recording left: neither uploads.
  await page.evaluate(() => window.speechFixture.removeRecording())
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await panel.getByText('Start with a recording', { exact: true }).waitFor()
  await panel.getByRole('button', { name: 'Check scene again', exact: true }).waitFor()
  assert.equal(await transcribe.count(), 0)
  assert.equal((await fixtureState()).started, uploadsBeforeOverride, 'no recording: nothing sent')
  await shots('no-recording')
  await page.evaluate(() => window.speechFixture.dispose())
  assert.deepEqual(errors, [])
  console.log(
    'PASS speech browser: optional provider, explicit cloud consent, transcript selection, cut/undo/redo, caption mapping, reopen, responsive panel and A/V export',
  )
} finally {
  await browser?.close()
  server.kill('SIGTERM')
}
