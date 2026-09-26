import {
  getDiarizationStatus,
  startDiarization,
  getDiarizationJob,
  cancelDiarization,
} from '@purescience/platform-ui/bridge/diarization.mjs'
import { getPlatformAppSettings } from '@purescience/platform-ui/bridge/appSettings.mjs'
import { validateTranscript, type Transcript } from './model'

export type SpeechProvider = {
  id: string
  label: string
  kind: 'cloud' | 'local' | 'inferred'
  input: 'audio' | 'text'
  available: boolean
}
export type Availability = {
  provider: SpeechProvider | null
  dailyCap: number
  reason: string
}
// Use the existing host service: no credentials, upload URLs or HTTP in the app.
export async function speechAvailability(): Promise<Availability> {
  try {
    const [status, settings] = await Promise.all([
      getDiarizationStatus(),
      getPlatformAppSettings('cut'),
    ])
    if (settings.speechEditingEnabled === false)
      return {
        provider: null,
        dailyCap: 20,
        reason: 'Speech features are turned off in app settings.',
      }
    const preferred =
      typeof settings.diarizationProvider === 'string'
        ? settings.diarizationProvider
        : status.selected
    const provider = preferred
      ? status.providers.find(p => p.id === preferred)
      : status.providers.find(p => p.available && p.input === 'audio')
    const dailyCap =
      typeof settings.diarizationDailyCap === 'number' &&
      Number.isInteger(settings.diarizationDailyCap)
        ? Math.max(1, Math.min(200, settings.diarizationDailyCap))
        : 20
    if (!provider?.available || provider.input !== 'audio')
      return {
        provider: null,
        dailyCap,
        reason:
          'Configure an audio transcription provider in settings to enable speech features.',
      }
    return { provider, dailyCap, reason: '' }
  } catch {
    return {
      provider: null,
      dailyCap: 20,
      reason:
        'Speech services are not configured on this host. Timeline editing is still available.',
    }
  }
}
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
  progress: (s: string) => void,
): Promise<Transcript> {
  if (!availability.provider) throw Error(availability.reason)
  if (availability.provider.kind === 'cloud' && !cloudUpload)
    throw Error('Allow uploading this recording before cloud transcription.')
  signal.throwIfAborted()
  const job = await startDiarization({
    provider: availability.provider.id,
    source: { kind: 'file', path },
    dailyCap: availability.dailyCap,
    consent: { cloudUpload },
    disfluencies: true,
  })
  let finished = false
  try {
    for (let count = 0; count < 10800; count++) {
      signal.throwIfAborted()
      const result = await getDiarizationJob(job.jobId)
      if (result.state === 'done') {
        finished = true
        if (result.result?.status !== 'completed')
          throw Error(
            `Transcription unavailable: ${
              result.result?.reason ?? 'no result'
            }.`,
          )
        if (!result.result.words?.length)
          throw Error(
            'This provider returned speaker turns without word timestamps. Choose a provider that transcribes words.',
          )
        return validateTranscript(
          {
            version: 1,
            assetId,
            speakers: {},
            words: result.result.words.map(w => ({
              text: w.text,
              start: w.startMs / 1000,
              end: w.endMs / 1000,
              speaker: w.speaker,
            })),
          },
          assetId,
        )
      }
      if (result.state === 'failed' || result.state === 'cancelled')
        throw Error(
          result.state === 'cancelled'
            ? 'Transcription cancelled.'
            : 'Transcription failed. Check your provider in settings and retry.',
        )
      progress(
        result.state === 'queued'
          ? 'Waiting for transcription…'
          : `Transcribing with ${availability.provider.label}${
              typeof result.progress === 'number'
                ? ` · ${Math.round(result.progress * 100)}%`
                : '…'
            }`,
      )
      await delay(signal)
    }
    throw Error('Transcription timed out.')
  } finally {
    if (!finished) await cancelDiarization(job.jobId).catch(() => {})
  }
}
