import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { Dialog, DialogContent, DialogPortal, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export interface SourceProposal {
  dir: string;
  before: string;
  baseHash: string;
  source: string;
  hash: string;
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
        <div class="cut-source-review-columns">
          <section><h3>Current</h3><pre tabIndex={0}>{review.proposal()?.before}</pre></section>
          <section><h3>Proposed</h3><pre tabIndex={0}>{review.proposal()?.source}</pre></section>
        </div>
        <Show when={review.error()}><p role="alert">{review.error()}</p></Show>
        <footer>
          <Button ref={cancel} variant="outline" disabled={review.busy()} onClick={() => review.dismiss()}>Discard</Button>
          <Button disabled={review.busy()} onClick={() => void review.apply()}>{review.busy() ? "Applying..." : "Apply edit"}</Button>
        </footer>
      </DialogContent>
    </DialogPortal>
  </Dialog>;
}
