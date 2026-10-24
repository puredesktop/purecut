import { createSignal } from 'solid-js'
import { addSpeechCaptions, applySpeechCuts, type SpeechScene } from './editor'
import type { Range, Transcript } from './model'
export type SpeechReview = {
  snapshot: SpeechScene
  cuts: Range[]
  title: string
  /** Set for a highlight: the name being given, as typed (may be empty). */
  highlightName?: string
  /** The excerpt name a highlight was offered; used when the name is left empty. */
  highlightDefault?: string
  captions?: Transcript
}
export const [speechOpen, setSpeechOpen] = createSignal(false)
export const [speechReview, setSpeechReview] =
  createSignal<SpeechReview | null>(null)
export function reviewSpeech(proposal: SpeechReview) {
  setSpeechReview(proposal)
  setSpeechOpen(true)
}

/**
 * The drawer and UI use the same reviewed mutation and editor history.
 * A highlight answers with the scene it created and the name it was given.
 */
export async function applySpeechReview(proposal: SpeechReview) {
  if (proposal.captions) {
    await addSpeechCaptions(proposal.snapshot, proposal.captions)
    return undefined
  }
  return applySpeechCuts(
    proposal.snapshot,
    proposal.cuts,
    proposal.highlightName,
    proposal.highlightDefault,
  )
}
