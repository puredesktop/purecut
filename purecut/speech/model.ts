/** Speech editing uses source seconds; edits never change the original transcript. */
export type Range = { start: number; end: number }
export type Word = Range & {
  text: string
  speaker?: string
  confidence?: number
}
export type Transcript = {
  version: 1
  assetId: string
  words: Word[]
  speakers: Record<string, string>
}
export type Clip = Range & { sourceIn: number; source: string }
export type TimelineWord = Word & { index: number; key: string }

export function ranges(input: Range[], duration = Infinity): Range[] {
  const result: Range[] = []
  for (const r of input) {
    if (
      !r ||
      !Number.isFinite(r.start) ||
      !Number.isFinite(r.end) ||
      r.start < 0 ||
      r.end <= r.start
    )
      throw Error(
        'Each range must have a finite end after its non-negative start.',
      )
  }
  for (const r of input
    .map(r => ({ start: r.start, end: Math.min(r.end, duration) }))
    .filter(r => r.end > r.start)
    .sort((a, b) => a.start - b.start)) {
    const last = result.at(-1)
    if (last && r.start <= last.end + 1e-9) last.end = Math.max(last.end, r.end)
    else result.push({ ...r })
  }
  return result
}
export function subtract(span: Range, cuts: Range[]): Range[] {
  let cursor = span.start
  const kept: Range[] = []
  for (const cut of ranges(cuts)) {
    if (cut.end <= cursor || cut.start >= span.end) continue
    if (cut.start > cursor)
      kept.push({ start: cursor, end: Math.min(cut.start, span.end) })
    cursor = Math.max(cursor, cut.end)
  }
  if (cursor < span.end) kept.push({ start: cursor, end: span.end })
  return kept
}
export function rippleTime(time: number, cuts: Range[]): number {
  return (
    time -
    ranges(cuts).reduce(
      (n, r) => n + Math.max(0, Math.min(time, r.end) - r.start),
      0,
    )
  )
}
export function timelineWords(
  transcript: Transcript,
  clips: Clip[],
): TimelineWord[] {
  return clips
    .flatMap(clip =>
      transcript.words.flatMap((word, index) => {
        const start = Math.max(word.start, clip.sourceIn),
          end = Math.min(word.end, clip.sourceIn + clip.end - clip.start)
        return end - start > 0.001
          ? [
              {
                ...word,
                index,
                key: `${clip.source}:${index}`,
                start: clip.start + start - clip.sourceIn,
                end: clip.start + end - clip.sourceIn,
              },
            ]
          : []
      }),
    )
    .sort((a, b) => a.start - b.start)
}
export function validateTranscript(
  value: unknown,
  assetId: string,
): Transcript {
  const t = value as Transcript
  if (
    !t ||
    t.version !== 1 ||
    t.assetId !== assetId ||
    !Array.isArray(t.words) ||
    !t.words.length ||
    t.words.length > 200000
  )
    throw Error('Invalid or mismatched transcript.')
  let previous = -1
  const words = t.words.map(w => {
    if (
      !w ||
      typeof w.text !== 'string' ||
      !w.text.trim() ||
      w.text.length > 1000 ||
      !Number.isFinite(w.start) ||
      !Number.isFinite(w.end) ||
      w.start < previous ||
      w.start < 0 ||
      w.end <= w.start
    )
      throw Error(
        'Transcript words must have ordered, valid source timestamps.',
      )
    previous = w.start
    return {
      text: w.text,
      start: w.start,
      end: w.end,
      ...(typeof w.speaker === 'string' ? { speaker: w.speaker } : {}),
    }
  })
  const speakers = Object.fromEntries(
    Object.entries(t.speakers ?? {}).filter(
      ([, v]) => typeof v === 'string' && v.length <= 100,
    ),
  )
  return { version: 1, assetId, words, speakers }
}
const normalized = (s: string) =>
  s.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '')
const isFiller = (s: string) => /^(um+|uh+|erm+|er|hmm+)$/.test(normalized(s))
export function fillerSuggestions(words: TimelineWord[], repetitions = false) {
  const restarts = new Set<number>()
  if (repetitions) {
    for (let i = 0; i < words.length; i++)
      for (
        let count = 1;
        count <= 5 && i + 2 * count <= words.length;
        count++
      ) {
        const passage = words.slice(i, i + count * 2)
        if (
          passage.some(
            (w, j) =>
              w.speaker !== passage[0].speaker ||
              (j > 0 && w.start - passage[j - 1].end > 0.7),
          )
        )
          continue
        if (
          passage
            .slice(0, count)
            .every(
              (w, j) =>
                normalized(w.text) === normalized(passage[j + count].text),
            )
        )
          for (let j = i; j < i + count; j++) restarts.add(j)
      }
  }
  return words.flatMap((w, i) => {
    const filler = isFiller(w.text)
    return filler || restarts.has(i)
      ? [{ ...w, reason: filler ? 'Filler' : 'Possible repetition or restart' }]
      : []
  })
}
/** Keep natural gaps between consecutively selected words in highlight clips. */
export function selectedPassages(
  words: TimelineWord[],
  selected: ReadonlySet<string>,
): Range[] {
  const result: Range[] = []
  let previous = -2
  words.forEach((word, index) => {
    if (!selected.has(word.key)) return
    if (index === previous + 1) result[result.length - 1].end = word.end
    else result.push({ start: word.start, end: word.end })
    previous = index
  })
  return result
}
/** Words whose middle falls inside one of the ranges: what a highlight keeps. */
export function wordsInRanges<T extends Range>(words: T[], kept: Range[]): T[] {
  return words.filter(w => {
    const middle = (w.start + w.end) / 2
    return kept.some(r => middle >= r.start && middle <= r.end)
  })
}
export const SCENE_NAME_LIMIT = 80
export const HIGHLIGHT_FALLBACK = 'Highlight'
const shorten = (text: string, limit: number) => {
  const chars = Array.from(text)
  if (chars.length <= limit) return text
  const cut = chars.slice(0, limit - 1).join(''), space = cut.lastIndexOf(' ')
  return (space > limit / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.–—-]+$/u, '') + '…'
}
/**
 * A scene name is one line of plain text: control and invisible characters
 * become spaces, runs of space collapse, and it is at most `limit` characters.
 * Anything that is not a string, or holds only space, is no name ('').
 */
export function cleanSceneName(raw: unknown, limit = SCENE_NAME_LIMIT): string {
  if (typeof raw !== 'string') return ''
  const text = raw
    .normalize('NFC')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  return shorten(text, limit)
}
/**
 * The name a highlight is offered: the first words of what is said in it,
 * quoted, so the scene reads as a moment of the recording and not as a copy
 * of its source. Fillers, bracketed notes ([laughter]) and stray punctuation
 * are left out; it stops at the end of the first sentence or after about
 * `limit` characters. With no usable words it is "Highlight".
 */
export function highlightExcerpt(words: { text: string }[], limit = 40): string {
  const tokens = words
    .map(w => w.text.replace(/\[[^\]]*\]|\([^)]*\)/gu, ' ').trim())
    .filter(text => text && !isFiller(text))
    .map(text => ({
      text: text.replace(/[^\p{L}\p{N}'’-]/gu, '').replace(/^[-'’]+|[-'’]+$/gu, ''),
      ends: /[.!?]["'’”)]*$/u.test(text),
    }))
    .filter(token => token.text)
  if (!tokens.length) return HIGHLIGHT_FALLBACK
  let excerpt = '', complete = false
  for (const [index, token] of tokens.entries()) {
    const next = excerpt ? `${excerpt} ${token.text}` : token.text
    if (excerpt && Array.from(next).length > limit) break
    excerpt = next
    if (index === tokens.length - 1 || (token.ends && index >= 2)) {
      complete = true
      break
    }
  }
  excerpt = shorten(excerpt, limit)
  if (!complete && !excerpt.endsWith('…')) excerpt += '…'
  return `“${excerpt.charAt(0).toLocaleUpperCase()}${excerpt.slice(1)}”`
}
/** `name`, or `name 2`, `name 3`… when another scene is already called that (any case). */
export function uniqueSceneName(name: string, taken: Iterable<string>): string {
  const used = new Set(Array.from(taken, n => n.trim().toLocaleLowerCase()))
  if (!used.has(name.toLocaleLowerCase())) return name
  for (let n = 2; ; n++) {
    const suffix = ` ${n}`
    const candidate = shorten(name, SCENE_NAME_LIMIT - suffix.length) + suffix
    if (!used.has(candidate.toLocaleLowerCase())) return candidate
  }
}
/**
 * The name a new highlight scene gets: what the person typed (or the agent
 * sent), else the offered excerpt, else "Highlight"; never the name of a
 * scene that already exists.
 */
export function highlightSceneName(
  requested: unknown,
  fallback: unknown,
  taken: Iterable<string>,
): string {
  return uniqueSceneName(
    cleanSceneName(requested) || cleanSceneName(fallback) || HIGHLIGHT_FALLBACK,
    taken,
  )
}
export function frameRanges(
  input: Range[],
  fps: number,
  duration: number,
): Range[] {
  if (!Number.isFinite(fps) || fps <= 0) throw Error('Invalid frame rate.')
  return ranges(
    ranges(input, duration)
      .map(r => ({
        start: Math.floor(r.start * fps + 1e-7) / fps,
        end: Math.ceil(r.end * fps - 1e-7) / fps,
      }))
      .filter(r => r.end > r.start),
    duration,
  )
}
/** How many cuts a proposal reply lists; the review in the transcript panel holds them all. */
export const LISTED_CUTS = 50
/** A proposal's cuts for the agent's reply: the count, then the first few, never one per filler in a long talk. */
export function listedCuts(cuts: Range[], limit = LISTED_CUTS) {
  return {
    cutCount: cuts.length,
    cuts: cuts.slice(0, limit),
    ...(cuts.length > limit
      ? {
          cutsNotListed: cuts.length - limit,
          cutsNote: `Only the first ${limit} cuts are listed here; the review in the transcript panel holds all ${cuts.length}.`,
        }
      : {}),
  }
}
/** Seconds removed by a list of cuts; reviews and replies use this one sum. */
export const removedSeconds = (cuts: Range[]) =>
  cuts.reduce((n, r) => n + r.end - r.start, 0)
/** Edited-timeline seconds as m:ss.cc, the precision a frame needs. */
export function formatTimestamp(seconds: number) {
  const hundredths = Math.round(Math.max(0, seconds) * 100)
  const minutes = Math.floor(hundredths / 6000)
  return `${minutes}:${((hundredths % 6000) / 100).toFixed(2).padStart(5, '0')}`
}
export const formatSeconds = (seconds: number) => `${seconds.toFixed(2)} s`
/** A reviewed cut with the words either side, so a person can judge what it removes. */
export type CutContext = Range & {
  duration: number
  before: TimelineWord[]
  /** Words wholly inside the cut: nothing of them is left. */
  removed: TimelineWord[]
  /** Every other word the cut touches: a fragment of it stays audible. */
  trimmed: TimelineWord[]
  after: TimelineWord[]
}
function firstAtOrAfter(words: TimelineWord[], time: number) {
  let lo = 0,
    hi = words.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (words[mid].start < time) lo = mid + 1
    else hi = mid
  }
  return lo
}
/** One entry per cut, in the cuts' own order and with their exact bounds. */
export function cutContexts(
  cuts: Range[],
  words: TimelineWord[],
  context = 4,
): CutContext[] {
  return cuts.map(cut => {
    let lo = firstAtOrAfter(words, cut.start)
    while (lo > 0 && words[lo - 1].end > cut.start + 0.001) lo--
    let hi = lo
    const removed: TimelineWord[] = [],
      trimmed: TimelineWord[] = []
    while (hi < words.length && words[hi].start < cut.end - 0.001) {
      const word = words[hi++]
      const overlap =
        Math.min(word.end, cut.end) - Math.max(word.start, cut.start)
      if (overlap <= 0.001) continue
      const whole = word.start >= cut.start - 0.001 && word.end <= cut.end + 0.001
      ;(whole ? removed : trimmed).push(word)
    }
    return {
      start: cut.start,
      end: cut.end,
      duration: cut.end - cut.start,
      before: words.slice(Math.max(0, lo - context), lo),
      removed,
      trimmed,
      after: words.slice(hi, hi + context),
    }
  })
}
/** Plain-language rule for pause cleanup, shown before any audio is analysed. */
export function pauseRule(minimum: number, retain: number) {
  if (!Number.isFinite(minimum) || minimum <= 0)
    return { valid: false, text: 'Enter how long a pause must be before it is shortened.' }
  if (!Number.isFinite(retain) || retain < 0 || retain >= minimum)
    return { valid: false, text: `The pause you keep must be shorter than ${formatSeconds(minimum)}.` }
  return {
    valid: true,
    text: `Silences longer than ${formatSeconds(minimum)} are shortened so about ${formatSeconds(retain)} of quiet remains. Shorter pauses stay as they are, and spoken words are never cut.`,
  }
}
/** Waveform silences on the edited timeline, the same mapping pauseCuts uses. */
export function timelineSilences(silences: Range[], clips: Clip[]): Range[] {
  return ranges(
    clips.flatMap(c =>
      silences.flatMap(s => {
        const start = Math.max(c.sourceIn, s.start),
          end = Math.min(c.sourceIn + c.end - c.start, s.end)
        return end > start
          ? [{ start: c.start + start - c.sourceIn, end: c.start + end - c.sourceIn }]
          : []
      }),
    ),
  )
}
/**
 * What a cut takes out, as far as the evidence goes. "silence" needs the
 * waveform: a stretch with no transcribed words may still hold speech the
 * transcript missed, so without silences it is only "untranscribed".
 */
export type CutContent = 'words' | 'partial' | 'silence' | 'untranscribed'
export function cutContent(item: CutContext, silences?: Range[]): CutContent {
  if (item.removed.length) return 'words'
  if (item.trimmed.length) return 'partial'
  return silences?.some(
    s => s.start <= item.start + 1e-6 && s.end >= item.end - 1e-6,
  )
    ? 'silence'
    : 'untranscribed'
}
export function pauseCuts(
  silences: Range[],
  clips: Clip[],
  words: TimelineWord[],
  minimum: number,
  retain: number,
): Range[] {
  if (
    !Number.isFinite(minimum) ||
    !Number.isFinite(retain) ||
    minimum <= 0 ||
    retain < 0 ||
    retain >= minimum
  )
    throw Error('Retained pause must be shorter than the minimum pause.')
  const candidates = clips.flatMap(c =>
    silences.flatMap(s => {
      const start = Math.max(c.sourceIn, s.start),
        end = Math.min(c.sourceIn + c.end - c.start, s.end)
      return end - start >= minimum
        ? [
            {
              start: c.start + start - c.sourceIn + retain / 2,
              end: c.start + end - c.sourceIn - retain / 2,
            },
          ]
        : []
    }),
  )
  // Acoustic silence can overlap a soft word. Keep a small margin around all speech.
  return ranges(
    candidates.flatMap(r =>
      subtract(
        r,
        words.map(w => ({
          start: Math.max(0, w.start - 0.06),
          end: w.end + 0.06,
        })),
      ),
    ),
  )
}
export function captions(
  words: Word[],
  maxChars = 42,
): { text: string; words: Word[] }[] {
  const cues: { text: string; words: Word[] }[] = []
  for (const word of words) {
    let cue = cues.at(-1)
    const last = cue?.words.at(-1)
    if (
      !cue ||
      !last ||
      cue.text.length + word.text.length + 1 > maxChars ||
      word.end - cue.words[0].start > 4 ||
      word.start - last.end > 0.8 ||
      last.speaker !== word.speaker ||
      /[.!?]$/.test(last.text)
    ) {
      cue = { text: '', words: [] }
      cues.push(cue)
    }
    cue.words.push({ ...word })
    cue.text = cue.words.map(w => w.text).join(' ')
  }
  return cues
}
export function searchTranscript(
  words: TimelineWord[],
  query: string,
): TimelineWord[][] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!tokens.length) return []
  const groups = captions(words) as { text: string; words: TimelineWord[] }[]
  return groups
    .filter(c => tokens.every(t => c.text.toLowerCase().includes(t)))
    .map(c => c.words)
}

/** Trim both cue text and word timings so removed words cannot leak into subtitles. */
export function trimCaptionCues<T extends { text: string; words: Word[] }>(
  cues: T[],
  start: number,
  end: number,
): T[] {
  return cues.flatMap(cue => {
    const words = cue.words.flatMap(word => {
      const from = Math.max(start, word.start),
        to = Math.min(end, word.end)
      return to > from + 0.001 ? [{ ...word, start: from, end: to }] : []
    })
    return words.length
      ? [{ ...cue, text: words.map(w => w.text).join(' '), words }]
      : []
  })
}
