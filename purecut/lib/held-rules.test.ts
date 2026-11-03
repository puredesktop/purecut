import { expect, it } from 'vitest'
import { HELD_IDLE_FRAME_MS, heldRefusal, nextFrameDelay, sceneChoices } from './held-rules'

it('a held preview nobody is playing wakes up a few times a second, and plays at full rate when asked', () => {
  expect(nextFrameDelay(true, false)).toBe(HELD_IDLE_FRAME_MS)
  expect(nextFrameDelay(true, true)).toBeNull()
})

it('the whole app runs as ever', () => {
  expect(nextFrameDelay(false, false)).toBeNull()
  expect(nextFrameDelay(false, true)).toBeNull()
})

it('offers scenes only when there are several, naming the ones with no name', () => {
  expect(sceneChoices([])).toEqual([])
  expect(sceneChoices(['Whole recording'])).toEqual([])
  expect(sceneChoices(['Whole recording', 'Why we moved', ' '])).toEqual([
    { index: 0, label: 'Whole recording' },
    { index: 1, label: 'Why we moved' },
    { index: 2, label: 'Scene 3' },
  ])
})

it('a held copy refuses only the long jobs that need the full app, and says what to do', () => {
  expect(heldRefusal(true, 'exportCut')).toMatch(/full app/)
  expect(heldRefusal(true, 'trackCutObject')).toMatch(/full app/)
  for (const tool of ['getCutContext', 'getCutTranscript', 'proposeCutEdits', 'replaceCutSource', 'checkCut']) expect(heldRefusal(true, tool)).toBeNull()
  expect(heldRefusal(false, 'exportCut')).toBeNull()
})
