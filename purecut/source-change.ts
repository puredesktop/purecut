import type { SourceProposal } from "./edit-review";

type Replace = (edit: { dir: string; source: string; baseHash: string }) => Promise<{ source: string; hash: string }>;

/** Keeps the exact reviewed snapshots; every reversal remains a conditional write. */
export async function applyReviewedSource(proposal: SourceProposal, replace: Replace) {
  const snapshot = { ...proposal };
  let current = await replace({ dir: snapshot.dir, source: snapshot.source, baseHash: snapshot.baseHash });
  let applied = true;
  let busy = false;
  return {
    async reverse() {
      if (busy) throw Error("The previous source change is still saving.");
      busy = true;
      try {
        current = await replace({
          dir: snapshot.dir,
          source: applied ? snapshot.before : snapshot.source,
          baseHash: current.hash,
        });
        applied = !applied;
        return applied;
      } finally { busy = false; }
    },
    isApplied: () => applied,
  };
}
