import assert from 'node:assert/strict'
import { build } from 'esbuild'
const result = await build({
  entryPoints: ['purecut/speech/model.ts'],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
})
const m = await import(
  `data:text/javascript;base64,${Buffer.from(
    result.outputFiles[0].text,
  ).toString('base64')}`
)
const transcript = m.validateTranscript(
  {
    version: 1,
    assetId: 'asset',
    speakers: {},
    words: [
      { text: 'Hello', start: 0, end: 0.4, speaker: 'A' },
      { text: 'um', start: 0.6, end: 0.85, speaker: 'A' },
      { text: 'world.', start: 1, end: 1.4, speaker: 'A' },
      { text: 'Next', start: 3, end: 3.5, speaker: 'B' },
    ],
  },
  'asset',
)
assert.equal(transcript.words[1].start, 0.6)
assert.equal(transcript.words[3].speaker, 'B')
assert.throws(
  () => m.validateTranscript({ ...transcript, assetId: 'other' }, 'asset'),
  /mismatched/,
)
assert.throws(
  () =>
    m.validateTranscript(
      { ...transcript, words: [{ text: 'x', start: 2, end: 1 }] },
      'asset',
    ),
  /timestamps/,
)
assert.deepEqual(
  m.ranges([
    { start: 2, end: 4 },
    { start: 1, end: 3 },
    { start: 6, end: 7 },
  ]),
  [
    { start: 1, end: 4 },
    { start: 6, end: 7 },
  ],
)
assert.deepEqual(
  m.subtract({ start: 0, end: 10 }, [
    { start: 2, end: 4 },
    { start: 6, end: 8 },
  ]),
  [
    { start: 0, end: 2 },
    { start: 4, end: 6 },
    { start: 8, end: 10 },
  ],
)
assert.equal(
  m.rippleTime(9, [
    { start: 2, end: 4 },
    { start: 6, end: 8 },
  ]),
  5,
)
const clips = [
  { source: 'one', start: 0, end: 0.6, sourceIn: 0 },
  { source: 'two', start: 0.6, end: 3.75, sourceIn: 0.85 },
]
const words = m.timelineWords(transcript, clips)
assert.deepEqual(
  words.map(w => w.text),
  ['Hello', 'world.', 'Next'],
)
assert.ok(Math.abs(words[1].start - 0.75) < 1e-9)
assert.ok(Math.abs(words[2].start - 2.75) < 1e-9)
assert.equal(
  m.fillerSuggestions(
    m.timelineWords(transcript, [
      { source: 'all', start: 0, end: 4, sourceIn: 0 },
    ]),
  ).length,
  1,
)
assert.equal(m.captions(transcript.words).length, 2)
const cut = m.pauseCuts(
  [{ start: 1.4, end: 3 }],
  [{ source: 'all', start: 0, end: 4, sourceIn: 0 }],
  m.timelineWords(transcript, [
    { source: 'all', start: 0, end: 4, sourceIn: 0 },
  ]),
  1,
  0.4,
)
assert.ok(Math.abs(cut[0].start - 1.6) < 1e-9)
assert.ok(Math.abs(cut[0].end - 2.8) < 1e-9)
assert.throws(() => m.pauseCuts([], [], [], 1, 2), /Retained/)
assert.deepEqual(
  m
    .pauseCuts(
      [{ start: 0, end: 4 }],
      [{ source: 'all', start: 0, end: 4, sourceIn: 0 }],
      m.timelineWords(transcript, [
        { source: 'all', start: 0, end: 4, sourceIn: 0 },
      ]),
      1,
      0,
    )
    .some(r => r.start < 1.4 && r.end > 1),
  false,
)
assert.equal(
  m.searchTranscript(
    m.timelineWords(transcript, [
      { source: 'all', start: 0, end: 4, sourceIn: 0 },
    ]),
    'world',
  ).length,
  1,
)
// Many cuts: each surviving source instant maps to a monotonically increasing timeline.
for (let n = 0; n < 50; n++) {
  const cuts = Array.from({ length: 10 }, (_, i) => ({
    start: i * 2 + 0.2,
    end: i * 2 + 0.3 + n * 0.01,
  }))
  const kept = m.subtract({ start: 0, end: 20 }, cuts)
  const length = kept.reduce((s, r) => s + r.end - r.start, 0)
  assert.ok(Math.abs(length - m.rippleTime(20, cuts)) < 1e-8)
  for (let i = 1; i < kept.length; i++)
    assert.ok(
      Math.abs(
        m.rippleTime(kept[i].start, cuts) - m.rippleTime(kept[i - 1].end, cuts),
      ) < 1e-8,
    )
}
assert.deepEqual(m.frameRanges([{ start: 1.001, end: 1.501 }], 30, 6), [
  { start: 1, end: 46 / 30 },
])
assert.deepEqual(
  m.selectedPassages(
    [
      { key: 'a', start: 0, end: 0.5 },
      { key: 'b', start: 1, end: 1.5 },
      { key: 'c', start: 2, end: 2.5 },
    ],
    new Set(['a', 'b']),
  ),
  [{ start: 0, end: 1.5 }],
)
assert.equal(
  m.fillerSuggestions(
    ['I', 'think', 'I', 'think'].map((text, i) => ({
      text,
      start: i * 0.2,
      end: i * 0.2 + 0.15,
      key: String(i),
      index: i,
      speaker: 'A',
    })),
    true,
  ).length,
  2,
)
console.log(
  'PASS speech model: validation, ripple mapping, captions, fillers, pause protection and search',
)

const clipped = m.trimCaptionCues(
  [{ text: 'Hello um world', words: transcript.words.slice(0, 3) }],
  0.9,
  1.3,
)
assert.equal(clipped[0].text, 'world.')
assert.deepEqual(
  clipped[0].words.map(w => [w.start, w.end]),
  [[1, 1.3]],
)

// A proposal reply lists a bounded number of cuts: a long talk can hold
// hundreds of fillers, and the reply goes back into the agent's context.
const few = m.listedCuts([{ start: 1, end: 2 }])
assert.deepEqual(few, { cutCount: 1, cuts: [{ start: 1, end: 2 }] })
const many = Array.from({ length: 400 }, (_, i) => ({ start: i * 2 + 0.36666666666666664, end: i * 2 + 0.7333333333333333 }))
const listed = m.listedCuts(many)
assert.equal(listed.cutCount, 400)
assert.equal(listed.cuts.length, m.LISTED_CUTS)
assert.equal(listed.cutsNotListed, 400 - m.LISTED_CUTS)
assert.match(listed.cutsNote, /all 400/)
console.log('PASS speech proposal replies list a bounded number of cuts')

// Review context: every displayed cut and total comes from the same frame-
// aligned ranges applySpeechCuts removes, never a re-derived copy.
{
  const at = (text, start, end, i) => ({ text, start, end, index: i, key: `s:${i}`, speaker: 'A' })
  const spoken = [
    at('So', 0, 0.3, 0), at('I', 0.4, 0.5, 1), at('um', 0.6, 0.91, 2), at('think', 0.92, 1.3, 3),
    at('we', 1.4, 1.6, 4), at('uh', 1.7, 2.0, 5), at('should', 2.1, 2.5, 6), at('go.', 4.6, 5.0, 7),
    at('Next', 5.2, 5.6, 8),
  ]
  const fillers = m.fillerSuggestions(spoken)
  assert.deepEqual(fillers.map(w => w.text), ['um', 'uh'])
  const fps = 30, duration = 6
  const applied = m.frameRanges(fillers, fps, duration)
  // Proposals and boundary edits store this form; applying normalises again.
  assert.deepEqual(m.frameRanges(applied, fps, duration), applied)
  const items = m.cutContexts(applied, spoken, 3)
  assert.deepEqual(items.map(i => ({ start: i.start, end: i.end })), applied)
  const listedTotal = items.reduce((n, i) => n + i.duration, 0)
  assert.ok(Math.abs(listedTotal - m.removedSeconds(applied)) < 1e-9)
  assert.equal(m.formatSeconds(listedTotal), m.formatSeconds(m.removedSeconds(applied)))
  assert.deepEqual(items[0].before.map(w => w.text), ['So', 'I'])
  assert.deepEqual(items[0].removed.map(w => w.text), ['um'])
  // The frame-aligned end reaches into "think": the review says so.
  assert.deepEqual(items[0].trimmed.map(w => w.text), ['think'])
  assert.deepEqual(items[0].after.map(w => w.text), ['we', 'uh', 'should'])
  assert.deepEqual(items[1].removed.map(w => w.text), ['uh'])
  assert.deepEqual(items[1].before.map(w => w.text), ['um', 'think', 'we'])
  assert.equal(m.formatTimestamp(items[0].start), '0:00.60')
  assert.equal(m.formatTimestamp(65.4321), '1:05.43')
  assert.equal(m.formatTimestamp(59.999), '1:00.00')
  assert.equal(m.formatSeconds(m.removedSeconds([{ start: 1, end: 1.5 }, { start: 2, end: 2.25 }])), '0.75 s')
  // A pause cut holds no words; its context is the words either side.
  const [gap] = m.cutContexts([{ start: 2.6, end: 4.5 }], spoken, 2)
  assert.deepEqual(gap.removed, [])
  assert.deepEqual(gap.trimmed, [])
  assert.deepEqual(gap.before.map(w => w.text), ['uh', 'should'])
  assert.deepEqual(gap.after.map(w => w.text), ['go.', 'Next'])
  assert.deepEqual(m.cutContexts([{ start: 5.7, end: 6 }], spoken, 2)[0].after, [])
  // Pause rule in words, and the same validation pauseCuts enforces.
  assert.equal(m.pauseRule(1.5, 0.3).valid, true)
  assert.match(m.pauseRule(1.5, 0.3).text, /longer than 1\.50 s .* about 0\.30 s/)
  assert.equal(m.pauseRule(1, 1).valid, false)
  assert.equal(m.pauseRule(NaN, 0.3).valid, false)
  assert.throws(() => m.pauseCuts([], [], [], 1, 1))
}
console.log('PASS speech review: listed ranges, context words, totals and pause rule match the applied cuts')

// "Silence" is only what the waveform found. Missing transcript words are not
// silence, and a cut inside a word is speech.
{
  const at = (text, start, end, i) => ({ text, start, end, index: i, key: `w:${i}`, speaker: 'A' })
  const spoken = [at('Long', 0, 0.5, 0), at('wooord', 1, 2, 1), at('then', 3, 3.4, 2), at('more', 5, 5.4, 3)]
  const [inside] = m.cutContexts([{ start: 1.2, end: 1.3 }], spoken)
  assert.deepEqual(inside.removed, [])
  assert.deepEqual(inside.trimmed.map(w => w.text), ['wooord'])
  assert.equal(m.cutContent(inside), 'partial')
  assert.equal(m.cutContent(inside, [{ start: 0, end: 10 }]), 'partial', 'transcribed speech wins over a silence claim')
  // Most of a word is still only part of it: its tail stays audible.
  const [most] = m.cutContexts([{ start: 1, end: 1.8 }], spoken)
  assert.deepEqual(most.removed, [])
  assert.deepEqual(most.trimmed.map(w => w.text), ['wooord'])
  assert.equal(m.cutContent(most), 'partial')
  const [gap] = m.cutContexts([{ start: 3.6, end: 4.6 }], spoken)
  assert.equal(m.cutContent(gap), 'untranscribed', 'an agent range between words is not known to be silent')
  assert.equal(m.cutContent(gap, []), 'untranscribed')
  assert.equal(m.cutContent(gap, [{ start: 3.5, end: 4.8 }]), 'silence')
  // A boundary moved past the waveform silence is no longer called silence.
  const [moved] = m.cutContexts([{ start: 3.6, end: 4.9 }], spoken)
  assert.equal(m.cutContent(moved, [{ start: 3.5, end: 4.8 }]), 'untranscribed')
  const [both] = m.cutContexts([{ start: 0.9, end: 2.1 }], spoken)
  assert.equal(m.cutContent(both, [{ start: 0, end: 10 }]), 'words')
  // Source silences map onto the edited timeline through the kept clips.
  assert.deepEqual(
    m.timelineSilences([{ start: 2, end: 4 }], [
      { source: 'a', start: 0, end: 1, sourceIn: 0 },
      { source: 'a', start: 1, end: 4, sourceIn: 2.5 },
    ]),
    [{ start: 1, end: 2.5 }],
  )
}
console.log('PASS speech review: silence only where the waveform found it; partial words and untranscribed gaps say so')

// A word is removed only when the cut holds all of it. Cutting most of a word
// still leaves a fragment you can hear, so it is partial, with a warning.
{
  const at = (text, start, end, i) => ({ text, start, end, index: i, key: `p:${i}`, speaker: 'A' })
  const spoken = [at('wooord', 1, 2, 0), at('next', 2.1, 2.4, 1), at('last', 3, 3.5, 2)]
  const [middle] = m.cutContexts([{ start: 1.2, end: 1.8 }], spoken)
  assert.deepEqual(middle.removed, [], 'cutting 60% of a word does not remove it')
  assert.deepEqual(middle.trimmed.map(w => w.text), ['wooord'])
  assert.equal(m.cutContent(middle), 'partial')
  // Keeps only the word's opening: the rest of it and the next word go.
  const [tail] = m.cutContexts([{ start: 1.1, end: 2.5 }], spoken)
  assert.deepEqual(tail.removed.map(w => w.text), ['next'])
  assert.deepEqual(tail.trimmed.map(w => w.text), ['wooord'], 'a kept edge is still flagged')
  assert.equal(m.cutContent(tail), 'words')
  // Keeps only the word's ending.
  const [head] = m.cutContexts([{ start: 0.5, end: 1.9 }], spoken)
  assert.deepEqual(head.removed, [])
  assert.equal(m.cutContent(head), 'partial')
  // Exact word bounds, and frame alignment widening a cut outwards, remove it whole.
  assert.deepEqual(m.cutContexts([{ start: 1, end: 2 }], spoken)[0].removed.map(w => w.text), ['wooord'])
  const [snapped] = m.cutContexts(m.frameRanges([{ start: 3, end: 3.5 }], 30, 6), spoken)
  assert.deepEqual(snapped.removed.map(w => w.text), ['last'])
  assert.deepEqual(snapped.trimmed, [])
}
console.log('PASS speech review: only words wholly inside a cut count as removed; every other overlap is partial')

// Highlight names: offered from the passage, cleaned, never a duplicate.
assert.equal(
  m.highlightExcerpt([{ text: 'um,' }, { text: 'we' }, { text: 'shipped' }, { text: '"it"' }, { text: 'on' }, { text: 'time.' }, { text: 'Then' }]),
  '“We shipped it on time”',
  'excerpt drops fillers and quotes and stops at the first sentence',
)
assert.equal(
  m.highlightExcerpt('so this is a very long passage that keeps going and going without any end'.split(' ').map(text => ({ text }))),
  '“So this is a very long passage that…”',
  'a long excerpt stops at a word and says it goes on',
)
assert.equal(m.highlightExcerpt([{ text: '[laughter]' }, { text: 'uh' }, { text: '—' }]), 'Highlight', 'nothing usable falls back')
assert.equal(m.highlightExcerpt([{ text: 'Yes' }]), '“Yes”')
assert.equal(m.cleanSceneName('  Lesson\u0000 3\n\tintro​ '), 'Lesson 3 intro', 'control and invisible characters go')
assert.equal(m.cleanSceneName('   '), '')
assert.equal(m.cleanSceneName(42), '')
assert.equal(Array.from(m.cleanSceneName('x'.repeat(300))).length, m.SCENE_NAME_LIMIT)
assert.equal(m.uniqueSceneName('Interview', ['interview', 'Interview 2']), 'Interview 3', 'duplicates get the next free number, ignoring case')
assert.equal(m.uniqueSceneName('Lesson intro', ['Interview']), 'Lesson intro')
assert.equal(m.highlightSceneName('', '“We shipped it”', ['Interview']), '“We shipped it”', 'an empty name uses the offered excerpt')
assert.equal(m.highlightSceneName(' ', ' ', []), 'Highlight', 'with nothing at all it is Highlight')
assert.equal(m.highlightSceneName('Interview', '“x”', ['Interview']), 'Interview 2', 'a source name is never reused')
assert.equal(
  Array.from(m.uniqueSceneName('y'.repeat(m.SCENE_NAME_LIMIT), ['y'.repeat(m.SCENE_NAME_LIMIT)])).length,
  m.SCENE_NAME_LIMIT,
  'a numbered name still fits the limit',
)
assert.deepEqual(
  m.wordsInRanges(
    [{ text: 'a', start: 0, end: 1 }, { text: 'b', start: 2, end: 3 }, { text: 'c', start: 2.9, end: 4 }],
    [{ start: 1.5, end: 3.2 }],
  ).map(w => w.text),
  ['b'],
  'a word belongs to the range holding its middle',
)
console.log('PASS highlight names: excerpt, cleaning, empty and duplicate names')
