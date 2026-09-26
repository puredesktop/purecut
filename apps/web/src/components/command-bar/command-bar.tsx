/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { speechOpen, setSpeechOpen } from "../../../../../purecut/speech/review";
import { Show, createEffect, createSignal, onCleanup } from "solid-js";
import { toast } from "somoto";
import { useWorld } from "@diffusionstudio/koota-solid";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipPortal, TooltipTrigger } from "@/components/ui/tooltip";
import { deleteSelection, getEditHistory, useActiveScene, useEditor, useSelection } from "@/engine";
import { addLayer } from "@/engine/add-layer";
import { pickAndImport } from "@/engine/asset-actions";
import { useLibrary } from "@/engine/library";
import { splitAtPlayhead } from "@/engine/split";
import { rippleDeleteSelection } from '@/engine/ripple-delete';
import { ExportVideoButton } from "@/components/sidebar-right/inspector/export";
import { KeysSheet, useKeysSheetShortcut } from "./keys-sheet";
import { useLayout } from "@/context/layout";
import { ExportHistory } from './export-history';
import { useTimeline } from '@/context/timeline';

/**
 * The verbs, on screen.
 *
 * The editor keeps its commands in menus behind one home icon, in right-click
 * menus, and in keys with no printed home. This bar carries the handful people
 * reach for on every video — import, split, delete, undo, export, ask — and
 * calls exactly the same functions those menus do.
 */
export function CommandBar() {
  const world = useWorld();
  const timeline = useTimeline();
  const { mediaVisible, toggleMedia, inspectorVisible, toggleInspector, timelineMinimized, toggleTimeline } = useLayout();
  const editor = useEditor();
  const activeScene = useActiveScene();
  const library = useLibrary();
  const history = getEditHistory(world);
  const { nodes } = useSelection();
  const [keysOpen, setKeysOpen] = createSignal(false);
  const [historyOpen, setHistoryOpen] = createSignal(false);
  let exportSlot: HTMLDivElement | undefined;

  useKeysSheetShortcut(keysOpen, setKeysOpen);

  // The File menu prints ⌘I and ⌘E, but nothing listened for either: they are
  // not in the engine's shortcut table, which works on the world alone and
  // cannot reach the media library or the export sheet.
  createEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const target = event.target;
      if (target instanceof HTMLElement && target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return;
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      const key = event.key.toLowerCase();
      if (key === "i") {
        event.preventDefault();
        void handleImport();
      } else if (key === "e") {
        event.preventDefault();
        exportSlot?.querySelector("button")?.click();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    onCleanup(() => document.removeEventListener("keydown", onKeyDown));
  });

  const hasSelection = () => nodes().length > 0;

  const handleImport = async () => {
    const lib = library();
    if (!lib) {
      toast("No video open", { description: "Open or create a video first." });
      return;
    }
    await pickAndImport(lib, "");
  };

  return (
    <div class="cut-command-bar flex items-center gap-1 min-h-11 px-2 border-b border-border bg-sidebar select-none shrink-0">
      <Tooltip placement="bottom">
        <TooltipTrigger<typeof Button>
          as={(triggerProps) => (
            <Button {...triggerProps} variant="ghost" size="default" onClick={() => void handleImport()}>
              <Icon name="download" class="size-5" />
              Import media
            </Button>
          )}
        />
        <TooltipPortal>
          <TooltipContent shortcut="⌘I">Bring clips, sound or images into this video</TooltipContent>
        </TooltipPortal>
      </Tooltip>

      <Button variant="ghost" size="default" onClick={() => addLayer(world, editor, activeScene())}>
        <Icon name="plus-add" class="size-5" />
        Add layer
      </Button>

      <Button variant="ghost" aria-pressed={speechOpen()} onClick={() => setSpeechOpen(!speechOpen())}>Transcript</Button>
      <Separator orientation="vertical" class="data-[orientation=vertical]:h-5 mx-1" />

      <Show when={!speechOpen()}>
      <Tooltip placement="bottom">
        <TooltipTrigger<typeof Button>
          as={(triggerProps) => (
            <Button {...triggerProps} variant="ghost" size="icon" aria-label="Split at playhead" onClick={() => splitAtPlayhead(world)}>
              <Icon name="split" class="size-5" />
            </Button>
          )}
        />
        <TooltipPortal>
          <TooltipContent shortcut="⌘B">Split at the playhead</TooltipContent>
        </TooltipPortal>
      </Tooltip>

      <Tooltip placement="bottom">
        <TooltipTrigger<typeof Button>
          as={(triggerProps) => (
            <Button
              {...triggerProps}
              variant="ghost"
              size="icon"
              aria-label="Delete selection"
              disabled={!hasSelection()}
              onClick={() => deleteSelection(world)}
            >
              <Icon name="trash" class="size-5" />
            </Button>
          )}
        />
        <TooltipPortal>
          <TooltipContent shortcut="⌫">Delete the selection</TooltipContent>
        </TooltipPortal>
      </Tooltip>

      <Separator orientation="vertical" class="data-[orientation=vertical]:h-5 mx-1" />

      <Button
        variant="ghost"
        size="icon"
        aria-label="Ripple delete selection"
        title="Ripple delete: remove selection and close empty time (Shift+Delete)"
        disabled={!hasSelection()}
        onClick={() => rippleDeleteSelection(world)}
      >
        <Icon name="minus" class="size-5" />
      </Button>
      </Show>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Undo"
        disabled={!history.canUndo()}
        onClick={() => history.undo()}
      >
        <Icon name="history" class="size-5" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Redo"
        disabled={!history.canRedo()}
        onClick={() => history.redo()}
      >
        <Icon name="history" class="size-5 -scale-x-100" />
      </Button>

      <div class="ml-auto flex flex-wrap max-w-full items-center gap-1">
        <Button variant="ghost" size="icon" aria-label="Fit timeline" title="Fit timeline" disabled={timelineMinimized()} onClick={() => timeline.fit()}><Icon name="tool.scene-frame" /></Button>
        <Button variant="ghost" size="icon" aria-label="Zoom timeline out" title="Zoom timeline out" disabled={timelineMinimized()} onClick={() => timeline.zoomAtPlayhead(1 / 1.25)}><Icon name="minus" /></Button>
        <Button variant="ghost" size="icon" aria-label="Zoom timeline in" title="Zoom timeline in" disabled={timelineMinimized()} onClick={() => timeline.zoomAtPlayhead(1.25)}><Icon name="plus-add" /></Button>
        <Button variant="ghost" size="icon" aria-label="Toggle media panel" title="Toggle media panel" aria-pressed={mediaVisible()} onClick={toggleMedia}><Icon name="sidebar" /></Button>
        <Button variant="ghost" size="icon" aria-label="Export history" title="Export history" onClick={() => setHistoryOpen(true)}><Icon name="history" /></Button>
        <Button variant="ghost" size="icon" aria-label="Toggle timeline" title="Toggle timeline" aria-pressed={!timelineMinimized()} onClick={toggleTimeline}>
          <Icon name="sidebar-timeline" />
        </Button>
        <Button variant="ghost" size="icon" aria-label="Toggle inspector" title="Toggle inspector" aria-pressed={inspectorVisible()} onClick={toggleInspector}>
          <Icon name="sidebar-right" />
        </Button>
        <Button variant="ghost" size="default" onClick={() => setKeysOpen(true)}>
          Keys
        </Button>
        <div ref={exportSlot} class="flex items-center">
          <ExportVideoButton variant="default" />
        </div>
      </div>

      <KeysSheet open={keysOpen()} onOpenChange={setKeysOpen} />
      <ExportHistory open={historyOpen()} onOpenChange={setHistoryOpen} />
    </div>
  );
}
