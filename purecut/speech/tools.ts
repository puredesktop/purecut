import { FrameRate, waveformAsset } from '@diffusionstudio/runtime'
import { request } from '../transport'
import { flushPendingProjectEdits } from '@/projects/edits'
import { speechScene, clips, assertCurrent } from './editor'
import { loadTranscript } from './store'
import {
  fillerSuggestions,
  frameRanges,
  pauseCuts,
  ranges,
  subtract,
  timelineWords,
  type Range,
} from './model'
import { reviewSpeech, setSpeechOpen } from './review'

export async function speechTool(name: string, args: Record<string, unknown>) {
  if (name === 'openCutTranscript') {
    setSpeechOpen(true)
    return {
      status: 'opened',
      message:
        'Transcription is optional and uses the service configured in settings. The user can start it in the transcript panel.',
    }
  }
  await flushPendingProjectEdits()
  const snapshot = speechScene(),
    transcript = await loadTranscript(snapshot)
  assertCurrent(snapshot)
  if (!transcript)
    return {
      status: 'no-transcript',
      message:
        'Open the transcript panel to transcribe with a configured service. Normal timeline editing remains available.',
    }
  const source = await request('purecut:source', {
    dir: snapshot.session.project.dir(),
  })
  assertCurrent(snapshot)
  const words = timelineWords(transcript, clips(snapshot))
  if (name === 'getCutTranscript') {
    const offset =
      typeof args.offset === 'number' && Number.isInteger(args.offset)
        ? Math.max(0, args.offset)
        : 0
    const limit =
      typeof args.limit === 'number' && Number.isInteger(args.limit)
        ? Math.max(1, Math.min(500, args.limit))
        : 250
    const query =
      typeof args.query === 'string' ? args.query.trim().toLowerCase() : ''
    const result = query
      ? words.filter((_w, i) =>
          words
            .slice(Math.max(0, i - 10), i + 11)
            .map(v => v.text)
            .join(' ')
            .toLowerCase()
            .includes(query),
        )
      : words
    return {
      baseHash: source.hash,
      unit: 'timeline seconds',
      duration: snapshot.end,
      total: result.length,
      words: result.slice(offset, offset + limit),
      nextOffset: offset + limit < result.length ? offset + limit : null,
      fillers: fillerSuggestions(words).slice(0, 100),
    }
  }
  if (!['proposeCutSpeechEdit', 'proposeCutSpeechCleanup', 'proposeCutCaptions'].includes(name)) throw Error('Unknown speech tool.')
  if (args.baseHash !== source.hash)
    throw Error('Project changed. Read getCutTranscript again.')
  if (name === 'proposeCutCaptions') {
    reviewSpeech({ snapshot, cuts: [], title: 'Generate captions', captions: transcript })
    return {
      status: 'awaiting_review',
      message: 'The user can apply caption generation in the transcript panel. Existing captions in this scene will be replaced. No transcription request is made.',
    }
  }
  if (name === 'proposeCutSpeechCleanup') {
    let proposed: Range[]
    if (args.mode === 'fillers') {
      if (args.includeRepetitions !== undefined && typeof args.includeRepetitions !== 'boolean')
        throw Error('includeRepetitions must be a boolean.')
      proposed = fillerSuggestions(words, args.includeRepetitions === true)
    } else if (args.mode === 'pauses') {
      const minimum = args.minimumSeconds ?? 1.5, retain = args.retainSeconds ?? 0.3
      if (typeof minimum !== 'number' || typeof retain !== 'number' || !Number.isFinite(minimum) || !Number.isFinite(retain) || minimum <= 0 || retain < 0 || retain >= minimum)
        throw Error('Use finite seconds: minimum > 0 and 0 <= retain < minimum.')
      const wave = await waveformAsset(snapshot.asset)
      assertCurrent(snapshot)
      proposed = pauseCuts(wave.silences, clips(snapshot), words, minimum, retain)
    } else throw Error('Choose fillers or pauses.')
    const cuts = frameRanges(proposed, snapshot.world.get(FrameRate)?.value ?? 30, snapshot.end)
    if (!cuts.length) return { status: 'no-matches', message: 'No matching cleanup suggestions; nothing changed.' }
    reviewSpeech({ snapshot, cuts, title: args.mode === 'fillers' ? 'Review filler words' : 'Shorten pauses' })
    return { status: 'awaiting_review', cuts, removedSeconds: cuts.reduce((n, r) => n + r.end - r.start, 0),
      message: 'Nothing changed. The user can preview, adjust and apply these cleanup suggestions.' }
  }
  if (args.mode !== 'delete' && args.mode !== 'highlight')
    throw Error('Choose delete or highlight.')
  if (
    !Array.isArray(args.ranges) ||
    !args.ranges.length ||
    args.ranges.length > 500
  )
    throw Error('Provide 1–500 timeline ranges.')
  const requested = ranges(args.ranges as Range[])
  if (requested.some(r => r.end > snapshot.end))
    throw Error('A range is outside this scene.')
  const highlight = args.mode === 'highlight'
  const cuts = highlight
    ? subtract({ start: 0, end: snapshot.end }, requested)
    : requested
  const title = highlight ? 'Review highlight' : 'Review transcript cuts'
  reviewSpeech({
    snapshot,
    cuts,
    title,
    ...(highlight
      ? {
          highlightName:
            typeof args.title === 'string' ? args.title : 'Highlight',
        }
      : {}),
  })
  return {
    status: 'awaiting_review',
    cuts,
    remainingSeconds:
      snapshot.end - cuts.reduce((n, r) => n + r.end - r.start, 0),
    message:
      'Nothing has been changed. The user previews and applies this proposal in the transcript panel.',
  }
}
