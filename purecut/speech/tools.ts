import { request } from '../transport'
import { flushPendingProjectEdits } from '@/projects/edits'
import { speechScene, clips, assertCurrent, sceneNames } from './editor'
import { loadTranscript } from './store'
import { findAssetSilences } from './silences'
import {
  cleanSceneName,
  fillerSuggestions,
  highlightExcerpt,
  highlightSceneName,
  listedCuts,
  pauseCuts,
  ranges,
  removedSeconds,
  subtract,
  timelineSilences,
  timelineWords,
  wordsInRanges,
  type Range,
} from './model'
import { reviewSpeech, reviewedCuts, setSpeechOpen, type SpeechReview } from './review'

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
    let detail: Pick<SpeechReview, 'reasons'> | Pick<SpeechReview, 'pause'>
    if (args.mode === 'fillers') {
      if (args.includeRepetitions !== undefined && typeof args.includeRepetitions !== 'boolean')
        throw Error('includeRepetitions must be a boolean.')
      const suggestions = fillerSuggestions(words, args.includeRepetitions === true)
      proposed = suggestions
      detail = { reasons: Object.fromEntries(suggestions.map(w => [w.key, w.reason])) }
    } else if (args.mode === 'pauses') {
      const minimum = args.minimumSeconds ?? 1.5, retain = args.retainSeconds ?? 0.3
      if (typeof minimum !== 'number' || typeof retain !== 'number' || !Number.isFinite(minimum) || !Number.isFinite(retain) || minimum <= 0 || retain < 0 || retain >= minimum)
        throw Error('Use finite seconds: minimum > 0 and 0 <= retain < minimum.')
      const silences = await findAssetSilences(snapshot.asset)
      assertCurrent(snapshot)
      proposed = pauseCuts(silences, clips(snapshot), words, minimum, retain)
      detail = { pause: { minimum, retain, silences: timelineSilences(silences, clips(snapshot)) } }
    } else throw Error('Choose fillers or pauses.')
    const cuts = reviewedCuts(snapshot, proposed)
    if (!cuts.length) return { status: 'no-matches', message: 'No matching cleanup suggestions; nothing changed.' }
    reviewSpeech({ snapshot, cuts, title: args.mode === 'fillers' ? 'Review filler words' : 'Shorten pauses', ...detail })
    return { status: 'awaiting_review', ...listedCuts(cuts), removedSeconds: removedSeconds(cuts),
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
  const cuts = reviewedCuts(
    snapshot,
    highlight ? subtract({ start: 0, end: snapshot.end }, requested) : requested,
  )
  const title = highlight ? 'Review highlight' : 'Review transcript cuts'
  if (highlight && args.title !== undefined && typeof args.title !== 'string')
    throw Error('title must be a string: the name for the new highlight scene.')
  // The person sees this name in the review and can change it before applying.
  const highlightDefault = highlight
    ? highlightExcerpt(wordsInRanges(words, requested))
    : undefined
  const highlightName = highlight
    ? cleanSceneName(args.title) || highlightDefault
    : undefined
  reviewSpeech({
    snapshot,
    cuts,
    title,
    ...(highlight ? { highlightName, highlightDefault } : {}),
  })
  return {
    status: 'awaiting_review',
    ...(highlight
      ? { sceneName: highlightSceneName(highlightName, highlightDefault, sceneNames(snapshot.world)) }
      : {}),
    ...listedCuts(cuts),
    remainingSeconds:
      snapshot.end - removedSeconds(cuts),
    message: highlight
      ? 'Nothing has been changed. The user can rename the highlight, preview it and apply it in the transcript panel. sceneName is the name it would get now; the user may change it. The original scene stays as it is.'
      : 'Nothing has been changed. The user previews and applies this proposal in the transcript panel.',
  }
}
