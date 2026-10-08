/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createEffect, createMemo, createSignal, on } from "solid-js";
import { Show, Portal } from "solid-js/web";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPortal,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { renderOverlay, cancelRender } from "@/context/render";

type ExportProgressProps = {
  open: boolean;
  audioOnly: boolean;
  progress: number;
  remaining?: { minutes: number; seconds: number };
  onCancel: () => void;
};

export function ExportProgress(props: ExportProgressProps) {
  const [confirming, setConfirming] = createSignal(false);
  const open = createMemo(() => props.open);
  createEffect(on(open, () => setConfirming(false)));
  let keepExporting: HTMLButtonElement | undefined;

  const confirmCancel = () => {
    setConfirming(false);
    props.onCancel();
  };

  const remaining = () => {
    const r = props.remaining;
    if (!r) return "Preparing…";
    return r.minutes > 0
      ? `~${r.minutes}m ${r.seconds}s remaining`
      : `~${r.seconds}s remaining`;
  };

  return (
    <Show when={props.open}>
      <Portal>
        <div
          class="cut-export-progress fixed inset-0 z-50 flex items-center justify-center"
          role="dialog"
          aria-modal="true"
          aria-label="Export progress"
        >
          <div class="flex w-full max-w-md flex-col items-center px-6">
            <p class="cut-export-progress-label">{props.audioOnly ? "Audio export" : "Video export"}</p>
            <h4 class="text-[14px] mt-2">
              {props.audioOnly ? "Exporting audio..." : "Exporting video..."}
            </h4>

            <div
              role="progressbar"
              aria-label={props.audioOnly ? "Audio export progress" : "Video export progress"}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={props.progress}
              class="cut-export-progress-track mt-8 h-1.5 w-full overflow-hidden rounded-full"
            >
              <div
                class="h-full rounded-full bg-primary transition-all"
                style={{ width: `${props.progress}%` }}
              />
            </div>
            <div class="cut-export-progress-meta mt-3 flex w-full justify-between">
              <span>{remaining()}</span>
              <span>{props.progress}%</span>
            </div>

            <Button
              variant="outline"
              class="mt-8 px-3"
              onClick={() => setConfirming(true)}
            >
              Cancel export
            </Button>
          </div>
        </div>
      </Portal>

      <AlertDialog open={confirming()} onOpenChange={setConfirming}>
        <AlertDialogPortal>
          <AlertDialogContent
            class="cut-export-confirmation cut-export-cancel"
            onOpenAutoFocus={(event: Event) => {
              // The safe choice takes focus: Enter or Space keeps the export going.
              event.preventDefault();
              keepExporting?.focus();
            }}
          >
            <AlertDialogHeader>
              <AlertDialogTitle class="text-[14px] font-medium">Stop exporting?</AlertDialogTitle>
              <AlertDialogDescription class="text-[12px] leading-normal">
                The export is still in progress. You'll need to start over if you stop now.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <Button ref={keepExporting} variant="outline" onClick={() => setConfirming(false)}>
                Keep exporting
              </Button>
              <Button variant="destructive" onClick={confirmCancel}>
                Stop export
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialogPortal>
      </AlertDialog>
    </Show>
  );
}

/**
 * The overlay bound to the one render slot in `context/render`: shown while
 * any render (UI export or the agent's export tool) is in flight, and its
 * confirmed cancel stops that render.
 */
export function RenderProgress() {
  return (
    <ExportProgress
      open={!!renderOverlay()}
      audioOnly={renderOverlay()?.audioOnly ?? false}
      progress={renderOverlay()?.progress ?? 0}
      remaining={renderOverlay()?.remaining}
      onCancel={cancelRender}
    />
  );
}
