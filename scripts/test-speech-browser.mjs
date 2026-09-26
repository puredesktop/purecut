import { chromium } from 'playwright'
import { spawn, execFileSync } from 'node:child_process'
import { writeFile, readFile, mkdir } from 'node:fs/promises'
import assert from 'node:assert/strict'
const port = 5571,
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
  await mkdir('../../../speech-verification', { recursive: true })
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
    '../../../speech-verification/source.mp4',
  ])
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}`)).ok) break
    } catch {}
    if (i > 120 || server.exitCode !== null) throw Error(log)
    await new Promise(r => setTimeout(r, 250))
  }
  browser = await chromium.launch({ channel: 'chrome', headless: true })
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
      body: await readFile('../../../speech-verification/source.mp4'),
    }),
  )
  await page.goto(`http://127.0.0.1:${port}/speech-check`)
  await page.evaluate(async () => {
    const { speechFixture } = await import('/scripts/speech-fixture.tsx')
    window.speechFixture = await speechFixture(
      document.getElementById('fixture'),
    )
  })
  await page
    .getByText('Configure an audio transcription provider', { exact: false })
    .waitFor()
  assert.equal(
    await page
      .getByRole('button', { name: 'Transcribe recording', exact: true })
      .count(),
    0,
  )
  assert.equal(
    (await page.evaluate(() => window.speechFixture.state())).started,
    0,
  )
  await page.evaluate(() => window.speechFixture.configure())
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  const transcribe = page.getByRole('button', {
    name: 'Transcribe recording',
    exact: true,
  })
  await transcribe.waitFor()
  assert.equal(await transcribe.isDisabled(), true)
  await page
    .getByRole('checkbox', { name: 'Allow this recording', exact: false })
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
  await mkdir('../../../speech-verification', { recursive: true })
  for (const width of [1440, 640, 375]) {
    await page.setViewportSize({ width, height: 900 })
    await page.screenshot({
      path: `../../../speech-verification/transcript-${width}.png`,
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
    '../../../speech-verification/edited.webm',
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
        '../../../speech-verification/edited.webm',
      ],
      { encoding: 'utf8' },
    ),
  )
  assert.ok(probe.streams.some(s => s.codec_type === 'audio'))
  assert.ok(probe.streams.some(s => s.codec_type === 'video'))
  assert.ok(Math.abs(Number(probe.format.duration) - 5.5) < 0.15)
  const output = '../../../speech-verification/edited.webm'
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
  await page.evaluate(() => window.speechFixture.highlightChecks())
  await page.evaluate(() => window.speechFixture.dispose())
  assert.deepEqual(errors, [])
  console.log(
    'PASS speech browser: optional provider, explicit cloud consent, transcript selection, cut/undo/redo, caption mapping, reopen, responsive panel and A/V export',
  )
} finally {
  await browser?.close()
  server.kill('SIGTERM')
}
