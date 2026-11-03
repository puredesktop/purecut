/** How often a held preview that nobody is playing wakes up: enough for what loads into it to appear, and no more. */
export const HELD_IDLE_FRAME_MS = 250;

/** The wait before the preview's next frame: none (the next animation frame) unless it is held and still. */
export function nextFrameDelay(held: boolean, playing: boolean): number | null {
  return held && !playing ? HELD_IDLE_FRAME_MS : null;
}

/** The scenes a held video offers, in the order of the project: only when there is more than one to choose between. */
export function sceneChoices(names: ReadonlyArray<string | undefined>): Array<{ index: number; label: string }> {
  if (names.length < 2) return [];
  return names.map((name, index) => ({ index, label: name?.trim() || `Scene ${index + 1}` }));
}

/** What only the full app does: both are long, and both need a person at controls a held copy hides. */
const HELD_REFUSES: Readonly<Record<string, string>> = {
  exportCut: "This video is held inside a page, which does not export. Ask the person to open the full app, then export it there.",
  trackCutObject: "This video is held inside a page, which does not track objects. Ask the person to open the full app, then track it there.",
};

/** What an agent's tool call is told in a held copy, or nothing when it may go ahead. */
export const heldRefusal = (held: boolean, tool: string): string | null => (held && HELD_REFUSES[tool]) || null;
