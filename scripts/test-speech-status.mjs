// Transcription status with the host's speech service mocked: every
// availability state, every job phase and every way a job can end, and proof
// that reading status never starts a job or sends audio.
import assert from 'node:assert/strict'
import { build } from 'esbuild'

const mock = {
  status: { providers: [], selected: null, today: 0 },
  statusError: null,
  settings: {},
  jobs: [],
  calls: { status: 0, start: 0, job: 0, cancel: 0 },
}
globalThis.__speechMock = mock
const bridge = {
  name: 'speech-bridge-mock',
  setup(b) {
    b.onResolve({ filter: /bridge\/(diarization|appSettings)\.mjs$/ }, args => ({
      path: args.path,
      namespace: 'speech-mock',
    }))
    b.onLoad({ filter: /.*/, namespace: 'speech-mock' }, () => ({
      loader: 'js',
      contents: `
        const m = globalThis.__speechMock
        export async function getDiarizationStatus() {
          m.calls.status++
          if (m.statusError) throw m.statusError
          return m.status
        }
        export async function startDiarization(request) {
          m.calls.start++
          m.lastRequest = request
          return { jobId: 'job-1' }
        }
        export async function getDiarizationJob() {
          m.calls.job++
          return m.jobs.length > 1 ? m.jobs.shift() : m.jobs[0]
        }
        export async function cancelDiarization() { m.calls.cancel++ }
        export async function getPlatformAppSettings() { return m.settings }
      `,
    }))
  },
}
const result = await build({
  entryPoints: ['purecut/speech/client.ts'],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  plugins: [bridge],
})
const c = await import(
  `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
)
// The client polls once a second; the test runs the same loop without waiting.
const realSetTimeout = globalThis.setTimeout
globalThis.setTimeout = (fn, _ms, ...rest) => realSetTimeout(fn, 0, ...rest)

const reset = () => {
  mock.status = { providers: [], selected: null, today: 0 }
  mock.statusError = null
  mock.settings = {}
  mock.jobs = []
  mock.calls = { status: 0, start: 0, job: 0, cancel: 0 }
}
const assembly = (patch = {}) => ({
  id: 'assemblyai', label: 'AssemblyAI', kind: 'cloud', input: 'audio', available: true, ...patch,
})
const whisper = (patch = {}) => ({
  id: 'whisper', label: 'Whisper on this computer', kind: 'local', input: 'audio', available: true, ...patch,
})
const noJobs = () =>
  assert.deepEqual(
    { start: mock.calls.start, job: mock.calls.job, cancel: mock.calls.cancel },
    { start: 0, job: 0, cancel: 0 },
    'reading status must never start, poll or cancel a job',
  )

// ── Availability: one state per situation, each read-only ──────────────────
const availability = async setup => {
  reset()
  setup()
  const a = await c.speechAvailability()
  noJobs()
  return a
}
assert.equal(c.checkingAvailability().state, 'checking')

let a = await availability(() => {
  mock.settings = { speechEditingEnabled: false }
  mock.status.providers = [assembly()]
})
assert.equal(a.state, 'disabled')
assert.equal(a.provider, null)

a = await availability(() => {})
assert.equal(a.state, 'no-provider')

a = await availability(() => {
  mock.status = { providers: [assembly({ available: false, reason: 'missing-key' })], selected: 'assemblyai', today: 0 }
})
assert.equal(a.state, 'missing-key')
assert.equal(a.providerLabel, 'AssemblyAI')
assert.match(a.reason, /AssemblyAI needs an API key/)

a = await availability(() => {
  mock.status = { providers: [whisper({ available: false, reason: 'runtime-unreachable' })], selected: 'whisper', today: 0 }
})
assert.equal(a.state, 'runtime-unreachable')
assert.equal(a.providerLabel, 'Whisper on this computer')

a = await availability(() => {
  mock.status = { providers: [assembly({ available: false, reason: 'not-configured' })], selected: 'assemblyai', today: 0 }
})
assert.equal(a.state, 'no-provider')

a = await availability(() => {
  // A text-only provider chosen in app settings cannot transcribe audio.
  mock.settings = { diarizationProvider: 'inferred' }
  mock.status.providers = [assembly(), { id: 'inferred', label: 'From captions', kind: 'inferred', input: 'text', available: true }]
})
assert.equal(a.state, 'no-provider')

a = await availability(() => {
  mock.statusError = new Error('No such method')
})
assert.equal(a.state, 'no-service')

a = await availability(() => {
  mock.settings = { diarizationDailyCap: 999 }
  mock.status.providers = [assembly({ available: false, reason: 'missing-key' }), whisper()]
})
assert.equal(a.state, 'ready')
assert.equal(a.provider.id, 'whisper', 'with nothing chosen, the first working audio provider is used')
assert.equal(a.dailyCap, 200)
console.log('PASS speech status: disabled, no provider, missing key, unreachable, no service and ready — none starts a job')

// ── Phases: provider progress only where the provider measured it ──────────
const cloud = { kind: 'cloud' }, local = { kind: 'local' }
assert.deepEqual(c.transcriptionPhase({ state: 'queued' }, cloud), { phase: 'waiting' })
assert.deepEqual(c.transcriptionPhase({ state: 'queued', progress: 0 }, local), { phase: 'waiting' })
assert.deepEqual(c.transcriptionPhase({ state: 'running', progress: 0 }, cloud), { phase: 'uploading' })
assert.deepEqual(c.transcriptionPhase({ state: 'running', progress: 0.02 }, cloud), { phase: 'uploading' })
assert.deepEqual(c.transcriptionPhase({ state: 'running' }, cloud), { phase: 'uploading' })
assert.deepEqual(c.transcriptionPhase({ state: 'running', progress: 0.5 }, cloud), { phase: 'processing' },
  'a cloud service reports stages, not a percentage')
assert.deepEqual(c.transcriptionPhase({ state: 'running', progress: 0.02 }, local), { phase: 'processing' },
  'the host’s own start mark is not provider progress')
assert.deepEqual(c.transcriptionPhase({ state: 'running' }, local), { phase: 'processing' })
assert.deepEqual(c.transcriptionPhase({ state: 'running', progress: Number.NaN }, local), { phase: 'processing' })
assert.deepEqual(c.transcriptionPhase({ state: 'running', progress: 0.42 }, local), { phase: 'processing', progress: 0.42 })
console.log('PASS speech phases: waiting, uploading, processing, with a percentage only from the provider')

// ── Jobs: every way one runs and ends ──────────────────────────────────────
const words = [
  { text: 'Hello', startMs: 0, endMs: 400, speaker: 'SPEAKER_00' },
  { text: 'world', startMs: 500, endMs: 900, speaker: 'SPEAKER_00' },
]
const done = result => ({ state: 'done', progress: 1, result })
const completed = (patch = {}) =>
  done({ status: 'completed', provider: 'x', model: 'm', kind: 'cloud', speakers: [], turns: [{ startMs: 0, endMs: 900, speaker: 'SPEAKER_00' }], words, durationMs: 900, latencyMs: 1, ...patch })
const ready = provider => ({ state: 'ready', provider, dailyCap: 20, reason: '' })
const transcribe = async ({ provider = assembly(), consent = true, jobs, signal = new AbortController().signal, onPhase } = {}) => {
  reset()
  mock.jobs = jobs ?? []
  const phases = []
  try {
    const transcript = await c.transcribeSource('/p/talk.mp4', 'asset1', ready(provider), consent, signal, p => {
      phases.push(p)
      onPhase?.(p)
    })
    return { transcript, phases }
  } catch (error) {
    return { error, phases }
  }
}
const failsWith = (run, reason, message) => {
  assert.ok(run.error instanceof c.TranscriptionError, `expected a TranscriptionError, got ${run.error}`)
  assert.equal(run.error.reason, reason)
  if (message) assert.match(run.error.message, message)
}

// The cloud-consent gate holds before anything is sent.
let run = await transcribe({ consent: false })
failsWith(run, 'consent-required', /Allow uploading/)
assert.equal(mock.calls.start, 0, 'no upload without consent')

reset()
await assert.rejects(
  c.transcribeSource('/p/talk.mp4', 'asset1', await c.speechAvailability(), true, new AbortController().signal, () => {}),
  /No transcription service/,
)
noJobs()

run = await transcribe({
  jobs: [
    { state: 'queued' },
    { state: 'running', progress: 0.02 },
    { state: 'running', progress: 0.2 },
    { state: 'running', progress: 0.5 },
    completed(),
  ],
})
assert.equal(run.error, undefined)
assert.deepEqual(run.transcript.words.map(w => w.text), ['Hello', 'world'])
assert.deepEqual(run.phases.map(p => p.phase), ['starting', 'waiting', 'uploading', 'processing', 'processing'])
assert.ok(run.phases.every(p => p.progress === undefined), 'cloud stages show no percentage')
assert.equal(mock.lastRequest.consent.cloudUpload, true)
assert.equal(mock.lastRequest.disfluencies, true)
assert.equal(mock.calls.start, 1)
assert.equal(mock.calls.cancel, 0, 'a finished job is not cancelled')

run = await transcribe({ provider: whisper(), consent: false, jobs: [{ state: 'running', progress: 0.02 }, { state: 'running', progress: 0.4 }, completed()] })
assert.equal(run.error, undefined, 'a local provider needs no upload consent')
assert.deepEqual(run.phases, [{ phase: 'starting' }, { phase: 'processing' }, { phase: 'processing', progress: 0.4 }])

for (const [reason, message] of [
  ['daily-cap', /limit of 20/],
  ['already-attempted', /already sent/],
  ['missing-key', /API key/],
  ['runtime-unreachable', /not responding/],
  ['unavailable', /unavailable right now/],
  ['consent-required', /Allow uploading/],
]) {
  run = await transcribe({ jobs: [done({ status: 'skipped', reason })] })
  failsWith(run, reason, message)
}
run = await transcribe({ jobs: [done({ status: 'skipped', reason: 'cancelled' })] })
failsWith(run, 'cancelled', /No transcript was saved/)

run = await transcribe({ jobs: [{ state: 'running', progress: 0.3 }, { state: 'failed', error: 'boom', result: { status: 'skipped', reason: 'unavailable' } }] })
failsWith(run, 'failed', /could not transcribe/)
assert.equal(mock.calls.cancel, 0)
run = await transcribe({ jobs: [{ state: 'failed', result: { status: 'skipped', reason: 'runtime-unreachable' } }] })
failsWith(run, 'failed', /stopped responding/)

run = await transcribe({ jobs: [{ state: 'cancelled', result: { status: 'skipped', reason: 'cancelled' } }] })
failsWith(run, 'cancelled')
assert.equal(mock.calls.cancel, 0)

run = await transcribe({ jobs: [completed({ words: [] })] })
failsWith(run, 'no-word-timing', /time for each word/)
run = await transcribe({ jobs: [completed({ words: [], turns: [] })] })
failsWith(run, 'no-speech', /No speech/)

// Cancelling mid-job stops polling and cancels the host job.
const controller = new AbortController()
run = await transcribe({
  jobs: [{ state: 'running', progress: 0.1 }],
  signal: controller.signal,
  onPhase: p => { if (p.phase === 'uploading') controller.abort() },
})
failsWith(run, 'cancelled', /No transcript was saved/)
assert.equal(mock.calls.cancel, 1, 'the host job is cancelled')

// Cancelled before it was sent: nothing starts.
const early = new AbortController()
early.abort()
run = await transcribe({ signal: early.signal })
failsWith(run, 'cancelled')
assert.equal(mock.calls.start, 0)

for (const reason of ['cancelled', 'timed-out', 'consent-required', 'missing-key', 'runtime-unreachable', 'unavailable'])
  assert.equal(c.canRetryToday(reason), true, reason)
for (const reason of ['failed', 'no-speech', 'no-word-timing', 'daily-cap', 'already-attempted'])
  assert.equal(c.canRetryToday(reason), false, reason)
console.log('PASS speech jobs: consent gate, waiting/uploading/processing, every skip reason, failure, cancellation, empty results and retry rules')
globalThis.setTimeout = realSetTimeout

// ── A refusal lasts only as long as its cause ──────────────────────────────
const noon = new Date('2026-10-24T12:00:00Z')
const past = (reason, dailyCap = 20) => ({ reason, day: c.utcDay(noon), dailyCap })
assert.equal(c.outcomeStillApplies(past('daily-cap'), noon, { dailyCap: 20 }), true)
assert.equal(c.outcomeStillApplies(past('daily-cap'), noon, { dailyCap: 30 }), false, 'a raised limit lifts daily-cap')
assert.equal(c.outcomeStillApplies(past('daily-cap', 30), noon, { dailyCap: 20 }), true, 'a lowered limit does not')
assert.equal(c.outcomeStillApplies(past('failed'), noon, { dailyCap: 30 }), true, 'a raised limit does not lift a failure')
const nextDay = new Date('2026-10-25T00:00:01Z')
for (const reason of ['daily-cap', 'already-attempted', 'failed', 'no-speech', 'no-word-timing'])
  assert.equal(c.outcomeStillApplies(past(reason), nextDay, { dailyCap: 20 }), false, `${reason} ends at the UTC day boundary`)
assert.equal(c.outcomeStillApplies(past('failed'), new Date('2026-10-24T23:59:59Z'), { dailyCap: 20 }), true)
// Checking eligibility again (what Check again does) only reads status.
reset()
mock.settings = { diarizationDailyCap: 40 }
mock.status.providers = [assembly()]
const raised = await c.speechAvailability()
assert.equal(c.outcomeStillApplies(past('daily-cap'), noon, raised), false)
noJobs()
console.log('PASS speech retry: a raised limit or a new UTC day offers transcription again, and checking sends nothing')

// ── A saved transcript that cannot be read fails loudly ────────────────────
const disk = { entries: [], read: null }
globalThis.__speechDisk = disk
const store = await build({
  entryPoints: ['purecut/speech/store.ts'],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  plugins: [{
    name: 'files-mock',
    setup(b) {
      b.onResolve({ filter: /lib\/platform-files$/ }, args => ({ path: args.path, namespace: 'files-mock' }))
      b.onLoad({ filter: /.*/, namespace: 'files-mock' }, () => ({
        loader: 'js',
        contents: `
          const d = globalThis.__speechDisk
          export const join = (...p) => p.join('/')
          export const projectPath = (dir, p) => dir + '/' + p
          export const files = {
            list: async () => d.entries,
            read: async () => d.read(),
            write: async () => { throw Error('not used') },
          }
        `,
      }))
    },
  }],
})
const s = await import(`data:text/javascript;base64,${Buffer.from(store.outputFiles[0].text).toString('base64')}`)
const scene = { session: { project: { dir: () => '/project' } }, asset: { id: 'asset1', source: 'talk.mp4' } }
disk.entries = []
assert.equal(await s.loadTranscript(scene), null, 'no saved transcript is not an error')
disk.entries = [{ name: 'speech-asset1.json', path: '/project/speech-asset1.json', isDirectory: false }]
disk.read = async () => { throw Error('Permission denied') }
await assert.rejects(s.loadTranscript(scene), /Permission denied/)
disk.read = async () => '{"version":1,"assetId":"asset1","words":[{'
await assert.rejects(s.loadTranscript(scene), SyntaxError)
disk.read = async () => JSON.stringify({ version: 1, assetId: 'other', speakers: {}, words: [] })
await assert.rejects(s.loadTranscript(scene), /mismatched/)
console.log('PASS speech load: unreadable, malformed and mismatched transcripts reject instead of passing as empty')
