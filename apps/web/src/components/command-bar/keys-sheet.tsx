/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { For, Show, createEffect, onCleanup } from "solid-js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Every key the editor listens for, written down where a person can find it.
 * The editor's shortcuts used to live only in `shortcuts.ts` and a few
 * tooltips, so a dozen of them — group, wrap in a scene, the shuttle keys —
 * could not be discovered from the interface at all.
 *
 * Keep this in step with PRESSED_SHORTCUTS and HELD_SHORTCUTS in
 * `@/engine/input/shortcuts`.
 */
const GROUPS: readonly { title: string; keys: readonly [string, string][] }[] = [
  {
    title: "Play",
    keys: [
      ["Space", "Play or pause"],
      ["J K L", "Back, stop, forward"],
      ["A D", "One frame back or on"],
      ["W S", "One second back or on"],
      ["Home End", "Start or end of the timeline"],
      ["; '", "Start or end of the selection"],
    ],
  },
  {
    title: "Edit",
    keys: [
      ["⌘B", "Split at the playhead"],
      ["⌫", "Delete the selection"],
      ["Shift+Delete", "Ripple delete and close empty time"],
      ["⌘D", "Duplicate"],
      ["⌘G", "Group"],
      ["⇧⌘G", "Ungroup"],
      ["⌘↩", "Wrap the selection in a scene"],
      ["⌥⌘↩", "Wrap the selection in a layer"],
      ["← →", "Nudge, hold ⇧ to go further"],
      ["⇧⌘H", "Hide or show"],
    ],
  },
  {
    title: "This video",
    keys: [
      ["⌘I", "Import media"],
      ["⌘E", "Export"],
      ["⌘O", "Switch video"],
      ["⌘Z", "Undo"],
      ["⇧⌘Z", "Redo"],
      ["⌘A", "Select everything"],
      ["Esc", "Deselect"],
    ],
  },
  {
    title: "Tools",
    keys: [
      ["V", "Move"],
      ["H", "Hand, or hold Space"],
      ["F", "Scene"],
      ["T", "Text"],
      ["R", "Rectangle"],
      ["⌘0 ⌘1 ⌘2", "Actual size, fit, fit selection"],
    ],
  },
];

export function KeysSheet(props: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent class="max-w-[720px]">
        <DialogHeader>
          <DialogTitle>Keys</DialogTitle>
          <DialogDescription>
            Press ? at any time. Everything here is also a button or a menu item.
          </DialogDescription>
        </DialogHeader>
        <div class="grid grid-cols-2 gap-x-8 gap-y-6 pt-1">
          <For each={GROUPS}>
            {(group) => (
              <div class="flex flex-col gap-2">
                <span class="text-xxs uppercase tracking-wider text-muted-foreground">
                  {group.title}
                </span>
                <For each={group.keys}>
                  {([keys, what]) => (
                    <div class="flex gap-3 items-baseline">
                      <span class="font-mono text-xs text-muted-foreground min-w-[84px]">{keys}</span>
                      <span class="text-sm">{what}</span>
                    </div>
                  )}
                </For>
              </div>
            )}
          </For>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** "?" opens the sheet, unless the person is typing. */
export function useKeysSheetShortcut(open: () => boolean, setOpen: (open: boolean) => void) {
  createEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "?" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable='true']")) return;
      event.preventDefault();
      setOpen(!open());
    };
    document.addEventListener("keydown", onKeyDown);
    onCleanup(() => document.removeEventListener("keydown", onKeyDown));
  });

  return <Show when={false}>{null}</Show>;
}
