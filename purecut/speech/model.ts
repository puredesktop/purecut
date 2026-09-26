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
    const filler = /^(um+|uh+|erm+|er|hmm+)$/.test(normalized(w.text))
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
