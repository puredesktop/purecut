import {
  getDiarizationStatus,
  startDiarization,
  getDiarizationJob,
  cancelDiarization,
  type DiarizationJob,
} from '@purescience/platform-ui/bridge/diarization.mjs'
import { getPlatformAppSettings } from '@purescience/platform-ui/bridge/appSettings.mjs'
import { validateTranscript, type Transcript } from './model'

export type SpeechProvider = {
  id: string
  label: string
  kind: 'cloud' | 'local' | 'inferred'
  input: 'audio' | 'text'
  available: boolean
  reason?: 'missing-key' | 'runtime-unreachable' | 'not-configured'
}
/**
 * Why new transcription can or cannot start. Only `ready` carries a provider;
 * every other state names its own next step. None of them affects a saved
 * transcript, which stays editable whatever the service is doing.
 */
export type AvailabilityState =
  | 'checking'
  | 'ready'
  | 'disabled'
  | 'no-provider'
  | 'missing-key'
  | 'runtime-unreachable'
  | 'no-service'
export type Availability = {
  state: AvailabilityState
  provider: SpeechProvider | null
  /** The chosen provider's name, when one is chosen but cannot run. */
  providerLabel?: string
  dailyCap: number
  reason: string
}
const capOf = (value: unknown) =>
  typeof value === 'number' && Number.isInteger(value)
    ? Math.max(1, Math.min(200, value))
    : 20
const unavailable = (
  state: Exclude<AvailabilityState, 'ready'>,
  dailyCap: number,
  provider?: SpeechProvider,
): Availability => {
  const name = provider?.label ?? 'The speech service'
  const reason = {
    checking: 'Checking speech settings…',
    disabled: 'Transcription is turned off in PureCut settings.',
    'no-provider': 'No transcription service is set up yet.',
    'missing-key': `${name} needs an API key before it can transcribe.`,
    'runtime-unreachable': `${name} is not responding on this computer.`,
    'no-service': 'Speech services are not available on this host.',
  }[state]
  return {
    state,
    provider: null,
    ...(provider ? { providerLabel: provider.label } : {}),
    dailyCap,
    reason,
  }
}
export const checkingAvailability = (): Availability =>
  unavailable('checking', 20)
// Use the existing host service: no credentials, upload URLs or HTTP in the app.
// This only reads status: it never starts a job or sends audio anywhere.
export async function speechAvailability(): Promise<Availability> {
  try {
    const [status, settings] = await Promise.all([
      getDiarizationStatus(),
      getPlatformAppSettings('cut'),
    ])
    const dailyCap = capOf(settings.diarizationDailyCap)
    if (settings.speechEditingEnabled === false)
      return unavailable('disabled', dailyCap)
    const preferred =
      typeof settings.diarizationProvider === 'string'
        ? settings.diarizationProvider
        : status.selected
    const audio = status.providers.filter(p => p.input === 'audio')
    const provider: SpeechProvider | undefined = preferred
      ? audio.find(p => p.id === preferred)
      : audio.find(p => p.available)
    if (provider?.available) return { state: 'ready', provider, dailyCap, reason: '' }
    if (provider?.reason === 'missing-key')
      return unavailable('missing-key', dailyCap, provider)
    if (provider?.reason === 'runtime-unreachable')
      return unavailable('runtime-unreachable', dailyCap, provider)
    return unavailable('no-provider', dailyCap)
  } catch {
    return unavailable('no-service', 20)
  }
}

/** What a running job is doing, as far as the host has said. */
export type TranscriptionPhase =
  | { phase: 'starting' }
  | { phase: 'waiting' }
  | { phase: 'uploading' }
  | { phase: 'processing'; progress?: number }
// The host marks 0 on start and 0.02 once it has read the file; a cloud
// provider reports 0.2 once the audio is uploaded.
const HOST_MARK = 0.02,
  UPLOADED = 0.2
/**
 * A percentage is shown only when the provider measured one: a cloud service
 * reports coarse stages, not real progress, so it shows the stage alone.
 */
export function transcriptionPhase(
  job: Pick<DiarizationJob, 'state' | 'progress'>,
  provider: Pick<SpeechProvider, 'kind'>,
): TranscriptionPhase {
  if (job.state === 'queued') return { phase: 'waiting' }
  const p = typeof job.progress === 'number' && Number.isFinite(job.progress) ? job.progress : undefined
  if (provider.kind === 'cloud')
    return p === undefined || p < UPLOADED ? { phase: 'uploading' } : { phase: 'processing' }
  return p !== undefined && p > HOST_MARK && p < 1
    ? { phase: 'processing', progress: p }
    : { phase: 'processing' }
}

export type TranscriptionFailure =
  | 'cancelled'
  | 'failed'
  | 'consent-required'
  | 'daily-cap'
  | 'already-attempted'
  | 'missing-key'
  | 'runtime-unreachable'
  | 'unavailable'
  | 'no-speech'
  | 'no-word-timing'
  | 'timed-out'
/**
 * The host takes a recording once a day per service, counting every attempt
 * it started. These ended before one started (or were stopped), so the same
 * recording can be sent again once the cause is fixed.
 */
export const canRetryToday = (reason: TranscriptionFailure) =>
  ['cancelled', 'timed-out', 'consent-required', 'missing-key', 'runtime-unreachable', 'unavailable'].includes(reason)
/** The host counts attempts per UTC day. */
export const utcDay = (now: Date) => now.toISOString().slice(0, 10)
export type PastOutcome = {
  reason: TranscriptionFailure
  /** utcDay() when it happened. */
  day: string
  /** The daily limit in force then. */
  dailyCap: number
}
/**
 * Whether a past outcome still says anything about sending the recording now.
 * A new UTC day lifts every once-a-day refusal, and a raised daily limit
 * lifts `daily-cap`; then the panel offers transcription again.
 */
export function outcomeStillApplies(
  outcome: PastOutcome,
  now: Date,
  availability: Pick<Availability, 'dailyCap'>,
) {
  if (outcome.day !== utcDay(now)) return false
  if (outcome.reason === 'daily-cap' && availability.dailyCap > outcome.dailyCap) return false
  return true
}
/** A transcription that ended without a transcript. Nothing is saved. */
export class TranscriptionError extends Error {
  constructor(
    readonly reason: TranscriptionFailure,
    message: string,
  ) {
    super(message)
    this.name = 'TranscriptionError'
  }
}
const failure = (reason: TranscriptionFailure, provider: string, dailyCap: number) =>
  new TranscriptionError(
    reason,
    {
      cancelled: 'Transcription cancelled. No transcript was saved.',
      failed: `${provider} could not transcribe this recording.`,
      'consent-required': 'Allow uploading this recording before cloud transcription.',
      'daily-cap': `Today’s limit of ${dailyCap} transcriptions is used up. Try again tomorrow, or raise the daily limit in PureCut settings.`,
      'already-attempted': 'This recording was already sent for transcription today, so it was not sent again. Try again tomorrow, or choose another service in settings.',
      'missing-key': `${provider} needs an API key before it can transcribe.`,
      'runtime-unreachable': `${provider} is not responding on this computer.`,
      unavailable: `${provider} is unavailable right now.`,
      'no-speech': 'No speech was found in this recording.',
      'no-word-timing': `${provider} found speech but did not return a time for each word, which editing needs.`,
      'timed-out': 'Transcription took too long and was stopped.',
    }[reason],
  )
const delay = (signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer)
      reject(new DOMException('Cancelled', 'AbortError'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, 1000)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
export async function transcribeSource(
  path: string,
  assetId: string,
  availability: Availability,
  cloudUpload: boolean,
  signal: AbortSignal,
  progress: (phase: TranscriptionPhase) => void,
): Promise<Transcript> {
  const provider = availability.provider
  if (!provider) throw Error(availability.reason)
  if (provider.kind === 'cloud' && !cloudUpload)
    throw failure('consent-required', provider.label, availability.dailyCap)
  const fail = (reason: TranscriptionFailure) =>
    failure(reason, provider.label, availability.dailyCap)
  if (signal.aborted) throw fail('cancelled')
  progress({ phase: 'starting' })
  const job = await startDiarization({
    provider: provider.id,
    source: { kind: 'file', path },
    dailyCap: availability.dailyCap,
    consent: { cloudUpload },
    disfluencies: true,
  })
  let finished = false
  try {
    for (let count = 0; count < 10800; count++) {
      if (signal.aborted) throw fail('cancelled')
      const result = await getDiarizationJob(job.jobId)
      if (result.state === 'done') {
        finished = true
        const outcome = result.result
        if (outcome?.status === 'skipped')
          throw fail(outcome.reason === 'cancelled' ? 'cancelled' : outcome.reason)
        if (outcome?.status !== 'completed') throw fail('failed')
        if (!outcome.words?.length)
          throw fail(outcome.turns.length ? 'no-word-timing' : 'no-speech')
        return validateTranscript(
          {
            version: 1,
            assetId,
            speakers: {},
            words: outcome.words.map(w => ({
              text: w.text,
              start: w.startMs / 1000,
              end: w.endMs / 1000,
              speaker: w.speaker,
            })),
          },
          assetId,
        )
      }
      if (result.state === 'cancelled') {
        finished = true
        throw fail('cancelled')
      }
      if (result.state === 'failed') {
        finished = true
        throw result.result?.status === 'skipped' &&
          result.result.reason === 'runtime-unreachable'
          ? new TranscriptionError('failed', `${provider.label} stopped responding before it finished.`)
          : fail('failed')
      }
      progress(transcriptionPhase(result, provider))
      try {
        await delay(signal)
      } catch {
        throw fail('cancelled')
      }
    }
    throw fail('timed-out')
  } finally {
    if (!finished) await cancelDiarization(job.jobId).catch(() => {})
  }
}
