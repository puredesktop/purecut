import { createSignal } from 'solid-js'
import { FrameRate } from '@diffusionstudio/runtime'
import { addSpeechCaptions, applySpeechCuts, type SpeechScene } from './editor'
import { frameRanges, type Range, type Transcript } from './model'
export type SpeechReview = {
  snapshot: SpeechScene
  /** Frame-aligned and merged (see reviewedCuts): the review shows exactly these. */
  cuts: Range[]
  title: string
  highlightName?: string
  captions?: Transcript
  /** Why a word was suggested, by timeline word key (filler cleanup). */
  reasons?: Record<string, string>
  /**
   * The rule a pause cleanup used, so the review can say it in words, and the
   * waveform silences (timeline seconds) it found: only a cut inside one of
   * these is described as silence, also after its boundaries are moved.
   */
  pause?: { minimum: number; retain: number; silences: Range[] }
}
export const [speechOpen, setSpeechOpen] = createSignal(false)
export const [speechReview, setSpeechReview] =
  createSignal<SpeechReview | null>(null)
export function reviewSpeech(proposal: SpeechReview) {
  setSpeechReview(proposal)
  setSpeechOpen(true)
}

/**
 * The ranges applySpeechCuts removes for these cuts. Proposals and boundary
 * edits store this form, so what the review lists is what Apply cuts.
 */
export function reviewedCuts(snapshot: SpeechScene, cuts: Range[]) {
  return frameRanges(
    cuts,
    snapshot.world.get(FrameRate)?.value ?? 30,
    snapshot.end,
  )
}

/** The drawer and UI use the same reviewed mutation and editor history. */
export async function applySpeechReview(proposal: SpeechReview) {
  if (proposal.captions) await addSpeechCaptions(proposal.snapshot, proposal.captions)
  else await applySpeechCuts(proposal.snapshot, proposal.cuts, proposal.highlightName)
}
