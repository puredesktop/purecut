import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { Dialog, DialogContent, DialogPortal, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export interface SourceProposal {
  dir: string;
  before: string;
  baseHash: string;
  source: string;
  hash: string;
}

export type DiffLine = { kind: "same" | "del" | "add"; text: string };
export type DiffRow = DiffLine | { kind: "gap"; count: number };

/**
 * Line diff of two sources (longest common subsequence), cut down to what
 * changed with `context` unchanged lines either side; longer unchanged runs
 * fold into a gap. A review that shows two whole files side by side hides a
 * one-word change — this is what the reader needs to see first.
 */
export function diffSources(before: string, after: string, context = 2): DiffRow[] {
  const a = before.split("\n"), b = after.split("\n");
  let lines: DiffLine[];
  if (a.length * b.length > 4_000_000) {
    lines = [...a.map(text => ({ kind: "del" as const, text })), ...b.map(text => ({ kind: "add" as const, text }))];
  } else {
    const n = a.length, m = b.length;
    const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    lines = [];
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a[i] === b[j]) { lines.push({ kind: "same", text: a[i]! }); i++; j++; }
      // Removed before added, so the old line reads above its replacement.
      else if (i < n && (j >= m || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) lines.push({ kind: "del", text: a[i++]! });
      else lines.push({ kind: "add", text: b[j++]! });
    }
  }
  const keep = lines.map(() => false);
  lines.forEach((line, index) => {
    if (line.kind === "same") return;
    for (let k = Math.max(0, index - context); k <= Math.min(lines.length - 1, index + context); k++) keep[k] = true;
  });
  const rows: DiffRow[] = [];
  let skipped = 0;
  lines.forEach((line, index) => {
    if (keep[index]) {
      if (skipped) rows.push({ kind: "gap", count: skipped });
      skipped = 0;
      rows.push(line);
    } else skipped++;
  });
  if (skipped && rows.length) rows.push({ kind: "gap", count: skipped });
  return rows;
}

export function createSourceReview() {
  const [proposal, setProposal] = createSignal<SourceProposal>();
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  let applySource: ((proposal: SourceProposal) => Promise<unknown>) | undefined;
  return {
    proposal, busy, error,
    present(value: SourceProposal, apply: (proposal: SourceProposal) => Promise<unknown>) {
      if (proposal() || busy()) throw Error("Review or dismiss the current proposed edit first.");
      applySource = apply;
      setError("");
      setProposal({ ...value });
    },
    dismiss() {
      if (busy()) return;
      setProposal(undefined);
      applySource = undefined;
      setError("");
    },
    async apply() {
      const current = proposal();
      const apply = applySource;
      if (!current || !apply || busy()) return;
      setBusy(true);
      setError("");
      try {
        await apply(current);
        setProposal(undefined);
        applySource = undefined;
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    },
  };
}

export const sourceReview = createSourceReview();

export function SourceEditReview(props: { review?: ReturnType<typeof createSourceReview> }) {
  const review = props.review ?? sourceReview;
  let cancel: HTMLButtonElement | undefined;
  onMount(() => {
    const dismiss = () => review.dismiss();
    window.addEventListener("hashchange", dismiss);
    onCleanup(() => window.removeEventListener("hashchange", dismiss));
  });
  onCleanup(() => review.dismiss());
  const rows = createMemo(() => {
    const value = review.proposal();
    return value ? diffSources(value.before, value.source) : [];
  });
  const changed = createMemo(() => rows().filter(row => row.kind === "add" || row.kind === "del").length);
  return <Dialog open={!!review.proposal()} onOpenChange={open => { if (!open) review.dismiss(); }}>
    <DialogPortal>
      <DialogContent role="dialog" class="cut-source-review" showCloseButton={false}
        onPointerDownOutside={event => event.preventDefault()}
        onEscapeKeyDown={event => { if (review.busy()) event.preventDefault(); }}
        onOpenAutoFocus={event => { event.preventDefault(); cancel?.focus(); }}
        on:keydown={event => {
          event.stopPropagation();
          if (event.key === "Escape") { event.preventDefault(); review.dismiss(); }
        }}>
        <DialogTitle>Review proposed edit</DialogTitle>
        <p class="cut-source-review-summary">
          {changed() === 0 ? "No change to the project." : `${changed()} line${changed() === 1 ? "" : "s"} change. Removed lines are marked \u2212, added lines +.`}
        </p>
        <div class="cut-source-diff" tabIndex={0} aria-label="Changes">
          <For each={rows()}>
            {row => row.kind === "gap"
              ? <div class="cut-diff-gap">{`\u22ef ${row.count} unchanged line${row.count === 1 ? "" : "s"}`}</div>
              : <div class={`cut-diff-line cut-diff-${row.kind}`}>
                  <span class="cut-diff-mark" aria-hidden="true">{row.kind === "add" ? "+" : row.kind === "del" ? "\u2212" : " "}</span>
                  <span class="sr-only">{row.kind === "add" ? "Added: " : row.kind === "del" ? "Removed: " : ""}</span>
                  <span>{row.text || " "}</span>
                </div>}
          </For>
        </div>
        <details class="cut-source-review-full">
          <summary>Show the whole file before and after</summary>
          <div class="cut-source-review-columns">
            <section><h3>Current</h3><pre tabIndex={0}>{review.proposal()?.before}</pre></section>
            <section><h3>Proposed</h3><pre tabIndex={0}>{review.proposal()?.source}</pre></section>
          </div>
        </details>
        <Show when={review.error()}><p role="alert">{review.error()}</p></Show>
        <footer>
          <Button ref={cancel} variant="outline" disabled={review.busy()} onClick={() => review.dismiss()}>Discard</Button>
          <Button disabled={review.busy()} onClick={() => void review.apply()}>{review.busy() ? "Applying..." : "Apply edit"}</Button>
        </footer>
      </DialogContent>
    </DialogPortal>
  </Dialog>;
}
