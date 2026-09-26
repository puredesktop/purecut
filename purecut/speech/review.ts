import { createSignal } from 'solid-js'
import { addSpeechCaptions, applySpeechCuts, type SpeechScene } from './editor'
import type { Range, Transcript } from './model'
export type SpeechReview = {
  snapshot: SpeechScene
  cuts: Range[]
  title: string
  highlightName?: string
  captions?: Transcript
}
export const [speechOpen, setSpeechOpen] = createSignal(false)
export const [speechReview, setSpeechReview] =
  createSignal<SpeechReview | null>(null)
export function reviewSpeech(proposal: SpeechReview) {
  setSpeechReview(proposal)
  setSpeechOpen(true)
}

/** The drawer and UI use the same reviewed mutation and editor history. */
export async function applySpeechReview(proposal: SpeechReview) {
  if (proposal.captions) await addSpeechCaptions(proposal.snapshot, proposal.captions)
  else await applySpeechCuts(proposal.snapshot, proposal.cuts, proposal.highlightName)
}
