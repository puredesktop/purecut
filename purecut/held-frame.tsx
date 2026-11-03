/** @jsxImportSource react */
import { useEffect, useState } from "react";
import { bridge } from "@purescience/platform-ui/bridge/client.mjs";
import { PLATFORM_BRIDGE_METHODS } from "@purescience/platform-ui/bridge/methods.mjs";

/** A shell that never answers must not leave the whole app unable to start. */
const ANSWER_WAIT_MS = 3_000;

export interface CopyRole {
  /** Has the shell said where this copy is? The editor waits: a timeline it mounted first would have started its heavy work. */
  known: boolean;
  /** Held in a page: the compact view. Beside a room in split view it is the whole app, and a room's "Full app" says it is alone, which gives the whole app back without a reload. */
  compact: boolean;
  /** Runs nothing but what it is asked: not library upkeep, recents or covers. In a room's frame that holds when it grows to the full app, since it is still a second copy. */
  second: boolean;
}

const heldIn = (app: unknown) => (app as { heldInRoom?: unknown } | null)?.heldInRoom === true;

/** Where this copy runs. Everything compact hangs off this one answer, asked for once and told of every change after. */
export function useCopyRole(): CopyRole {
  const nested = window.parent !== window.top;
  const alone = window.parent === window;
  const [role, setRole] = useState<CopyRole>({ known: alone, compact: false, second: nested });
  useEffect(() => {
    if (alone) return;
    let disposed = false;
    let told = false;
    const answer = (app: unknown): void => {
      if (disposed) return;
      const compact = heldIn(app);
      setRole({ known: true, compact, second: nested || compact });
    };
    const receive = (event: MessageEvent): void => {
      if (event.source !== window.parent || event.data?.type !== "pure:adjacent-app") return;
      told = true;
      answer(event.data.app);
    };
    window.addEventListener("message", receive);
    const timer = window.setTimeout(() => { if (!told) answer(null); }, ANSWER_WAIT_MS);
    void bridge.call(PLATFORM_BRIDGE_METHODS.WORKSPACE_ADJACENT_APP).then(
      (app) => { if (!told) answer(app); },
      () => { if (!told) answer(null); },
    );
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      window.removeEventListener("message", receive);
    };
  }, [nested, alone]);
  return role;
}

/** Held with no video open: one quiet line, and nothing that would make a new one. */
export function HeldNoVideo() {
  return (
    <div className="cut-held-none" role="status">
      <strong>No video open here</strong>
      <span>Choose one above, or make one in the full app.</span>
    </div>
  );
}
