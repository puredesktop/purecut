/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createMemo, createSignal, Index, Show } from 'solid-js';
import { useTag, useTrait, useWorld } from '@diffusionstudio/koota-solid';
import {
  ClipHeight,
  Expanded,
  Hidden,
  Locked,
  Hovering,
  Muted,
  Name,
  Selected,
  Soloed,
  findGeometryAsset,
  getEntityChildren,
  getParentEntity,
  isAdjustmentLayer,
  isCaption,
  isGroup,
  isMask,
  isScene,
  isSequence,
  isText,
} from '@diffusionstudio/runtime';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuPortal,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipPortal, TooltipTrigger } from '@/components/ui/tooltip';
import { useEditor } from '@/engine/hooks';
import { DEFAULT_CLIP_HEIGHT, MAX_CLIP_HEIGHT, MIN_CLIP_HEIGHT, getClipFallbackName } from '@/engine/timeline';
import { NESTED_INDENT_PX } from './config';
import { useLayerContext } from './context';
import { setRowHover } from './hover';
import { containsLocked } from '@/engine/locking';

import type { World } from 'koota';
import type { TimelineNode } from '@diffusionstudio/runtime';
import type { LayerRowProps } from './layer';

/** One entry of the row's menu, rendered by both the right-click menu and the row's "more" button. */
type RowMenuItem = {
  label: string;
  onSelect: () => void;
  shortcut?: string;
  /** Opens a new group above this item. */
  separatorBefore?: boolean;
};

/**
 * A row control is always there, quietly, and comes up to full strength when
 * the row is hovered or holds focus. One that is on reads as on wherever the
 * pointer is.
 */
const CONTROL_QUIET = 'opacity-55 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100';
const CONTROL_ON = 'opacity-100 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100';

const controlClass = (on: boolean) => (on ? CONTROL_ON : CONTROL_QUIET);

export function NodeLayer(props: LayerRowProps) {
  const world = useWorld();
  const editor = useEditor();

  const entity = () => props.layer.entity;

  const clipHeight = useTrait(entity, ClipHeight);
  const height = () => clipHeight()?.value ?? DEFAULT_CLIP_HEIGHT;

  const muted = useTag(entity, Muted);
  const soloed = useTag(entity, Soloed);
  const hidden = useTag(entity, Hidden);
  const locked = useTag(entity, Locked);
  const hovering = useTag(entity, Hovering);
  const selected = useTag(entity, Selected);

  const { resized: resizedSignal, drag } = useLayerContext();
  const [resized, setResized] = resizedSignal;

  /**
   * The controls sit at the end of every row rather than appearing on hover,
   * so the name fades out beneath them whenever they are there at all.
   */
  const controlsVisible = createMemo(() => resized() === null);

  const [editing, setEditing] = createSignal(false);
  let originalName = '';

  const nameTrait = useTrait(entity, Name);
  const name = createMemo(() => nameTrait()?.value || getClipFallbackName(world, entity()));
  const icon = createMemo(() => getLayerIcon(world, props.layer));

  const toggleMuted = (e?: Event) => {
    e?.stopPropagation();
    editor.editProperty(entity(), 'muted', !muted());
  };

  const toggleHidden = (e?: Event) => {
    e?.stopPropagation();
    editor.editProperty(entity(), 'hidden', !hidden());
  };

  const toggleLocked = (e?: Event) => {
    e?.stopPropagation();
    editor.editProperty(entity(), 'locked', !locked());
  };

  const toggleExpanded = (e?: Event) => {
    e?.stopPropagation();
    editor.editProperty(entity(), 'expanded', !entity().has(Expanded));
  };

  /**
   * Solo is monitoring rather than composition — it says what you want to
   * hear right now, which the file has nothing to say about — so it is
   * written to the trait and only one node holds it.
   */
  const toggleSoloed = (e?: Event) => {
    e?.stopPropagation();

    const wasSoloed = soloed();
    for (const other of world.query(Soloed)) other.remove(Soloed);
    if (!wasSoloed) entity().add(Soloed);
  };

  /**
   * A press on a row selects it, shift-clicking to extend the selection. A
   * plain press also arms a drag: moving far enough turns the press into
   * dragging the layer to a new place in the tree.
   */
  const handleRowPointerDown = (e: PointerEvent) => {
    if (e.button !== 0 || resized() !== null) return;
    if ((e.target as HTMLElement | null)?.closest('button')) return;
    if (containsLocked(world, entity())) return;

    editor.select(entity(), { extend: e.shiftKey });
    if (!e.shiftKey) drag.begin(e, entity());
  };

  let resizeStartY = 0;
  let resizeStartHeight = 0;

  const handleResizeMove = (e: PointerEvent) => {
    const next = Math.max(MIN_CLIP_HEIGHT, Math.min(MAX_CLIP_HEIGHT, resizeStartHeight + e.clientY - resizeStartY));
    editor.editProperty(entity(), 'clipHeight', next);
  };

  const handleResizeEnd = () => {
    setResized(null);
    document.removeEventListener('pointermove', handleResizeMove);
    document.removeEventListener('pointerup', handleResizeEnd);
  };

  const handleResizeStart = (e: PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    resizeStartY = e.clientY;
    resizeStartHeight = height();
    setResized(entity());

    document.addEventListener('pointermove', handleResizeMove);
    document.addEventListener('pointerup', handleResizeEnd);
  };

  const handleRemove = () => editor.remove(entity());

  /**
   * The column reads top-down while the file reads bottom-up: the last child
   * of an element is the one drawn on top, so "front" is the end of the file
   * and "back" is the beginning.
   */
  const handleReorder = (target: 'front' | 'back') => {
    const parent = getParentEntity(entity());
    if (!parent) return;

    const siblings = getEntityChildren(world, parent).filter((sibling) => sibling !== entity());
    editor.reparent(entity(), parent, target === 'back' ? siblings[0] : undefined);
  };

  const startEditing = () => {
    if (containsLocked(world, entity())) return;
    originalName = name();
    setEditing(true);
  };

  const finishEditing = (input: HTMLInputElement) => {
    if (!editing()) return;
    // An empty name is not a name; the row falls back to what it had.
    if (!input.value.trim()) editor.editProperty(entity(), 'name', originalName);
    setEditing(false);
  };

  const handleNameInput = (e: InputEvent) => {
    editor.editProperty(entity(), 'name', (e.currentTarget as HTMLInputElement).value);
  };

  const handleNameKeyDown = (e: KeyboardEvent) => {
    // The canvas is listening for keys; a name being typed is not a shortcut.
    e.stopPropagation();
    const input = e.currentTarget as HTMLInputElement;

    if (e.key === 'Escape') {
      editor.editProperty(entity(), 'name', originalName);
      input.blur();
    } else if (e.key === 'Enter') {
      input.blur();
    }
  };

  const mountNameInput = (input: HTMLInputElement) => {
    queueMicrotask(() => {
      input.focus();
      input.select();
    });
  };

  /**
   * What the row offers, written once: the right-click menu and the row's
   * "more" button are two ways to the same items and the same handlers.
   */
  const menuItems = createMemo<RowMenuItem[]>(() => [
    { label: locked() ? 'Unlock layer' : 'Lock layer', onSelect: toggleLocked },
    { label: muted() ? 'Unmute' : 'Mute', onSelect: toggleMuted },
    { label: soloed() ? 'Unsolo' : 'Solo', onSelect: toggleSoloed },
    { label: hidden() ? 'Unhide' : 'Hide', onSelect: toggleHidden },
    { label: 'Rename layer', onSelect: startEditing, separatorBefore: true },
    { label: 'Bring to front', shortcut: ']', onSelect: () => handleReorder('front'), separatorBefore: true },
    { label: 'Send to back', shortcut: '[', onSelect: () => handleReorder('back') },
    { label: 'Remove', onSelect: handleRemove, separatorBefore: true },
  ]);

  return (
    <ContextMenu>
      <ContextMenuTrigger
        as="div"
        data-layer-row
        class="w-full text-muted-foreground group relative select-none"
        onPointerEnter={() => setRowHover(world, entity())}
        onPointerLeave={() => setRowHover(world, null)}
        onPointerDown={handleRowPointerDown}
        classList={{
          'bg-accent': selected(),
          'bg-accent/70': !selected() && hovering() && resized() === null && drag.dragging() === null,
          'bg-accent/40': !selected() && !(hovering() && resized() === null) && props.ancestorSelected,
          'opacity-60': drag.dragging() === entity(),
        }}
        style={{ height: height() + 'px' }}
      >
        <div class="w-full pl-0.5 pr-2 flex items-center justify-between h-full">
          <div
            data-layer-label
            class="flex-1 min-w-0 overflow-hidden"
            style={{
              'mask-image': controlsVisible() && !editing() ? 'linear-gradient(to right, #000 calc(100% - 1.25rem), transparent)' : undefined,
              '-webkit-mask-image': controlsVisible() && !editing() ? 'linear-gradient(to right, #000 calc(100% - 1.25rem), transparent)' : undefined,
            }}
          >
            <div
              class="flex items-center gap-0.5 w-max"
              style={{
                'padding-left': `${props.depth * NESTED_INDENT_PX}px`,
                transform: editing() ? 'none' : 'translateX(calc(var(--layer-x, 0px) * -1))',
              }}
            >
              <button
                disabled={!props.layer.expandable}
                onClick={toggleExpanded}
                aria-label={props.layer.expandable ? (props.expanded ? 'Collapse layer' : 'Expand layer') : undefined}
                class={`size-4 shrink-0 flex items-center justify-center overflow-clip focus-ring rounded-sm ${controlClass(props.expanded)} group-hover/layers:opacity-100`}
              >
                <Show when={props.layer.expandable}>
                  <Icon name={props.expanded ? "chevron-down" : "chevron-right"} class="size-6 hover:text-foreground" />
                </Show>
              </button>
              <div class="size-4 shrink-0 flex items-center justify-center overflow-clip mr-0.5">
                <Icon name={icon()} class="size-6" />
              </div>
              <Show
                when={editing()}
                fallback={
                  <span class="text-xs px-0.5 shrink-0 whitespace-nowrap text-foreground" onDblClick={startEditing}>
                    {name()}
                  </span>
                }
              >
                <input
                  ref={mountNameInput}
                  type="text"
                  class="text-xs bg-input border border-primary rounded-sm outline-none px-0.5 w-32 text-foreground"
                  value={name()}
                  onInput={handleNameInput}
                  onKeyDown={handleNameKeyDown}
                  onBlur={(e) => finishEditing(e.currentTarget)}
                  onPointerDown={(e) => e.stopPropagation()}
                  onDblClick={(e) => e.stopPropagation()}
                />
              </Show>
            </div>
          </div>

          <div
            class="cut-layer-controls items-center flex gap-0.5 shrink-0"
            classList={{ 'hidden': resized() !== null }}
          >
            <Tooltip placement="bottom">
              <TooltipTrigger as={Button} variant={locked() ? 'on' : 'ghost'} size="icon"
                class={controlClass(locked())} aria-label={locked() ? 'Unlock layer' : 'Lock layer'}
                aria-pressed={locked()} onClick={toggleLocked}>
                <Icon name={locked() ? 'lock-closed' : 'lock-open'} class="size-5" />
              </TooltipTrigger>
              <TooltipPortal><TooltipContent>{locked() ? 'Unlock layer' : 'Lock layer'}</TooltipContent></TooltipPortal>
            </Tooltip>
            <Tooltip placement="bottom">
              <TooltipTrigger
                as={Button}
                variant={muted() ? "on" : "ghost"}
                size="icon"
                class={controlClass(muted())}
                aria-label={muted() ? "Unmute" : "Mute"}
                onClick={toggleMuted}
              >
                <Icon name="mute" class="size-6" />
              </TooltipTrigger>
              <TooltipPortal>
                <TooltipContent>{muted() ? "Unmute" : "Mute"}</TooltipContent>
              </TooltipPortal>
            </Tooltip>
            <Tooltip placement="bottom">
              <TooltipTrigger
                as={Button}
                variant={soloed() ? "on" : "ghost"}
                size="icon"
                class={controlClass(soloed())}
                aria-label={soloed() ? "Unsolo" : "Solo"}
                onClick={toggleSoloed}
              >
                <Icon name="solo" class="size-6" />
              </TooltipTrigger>
              <TooltipPortal>
                <TooltipContent>{soloed() ? "Unsolo" : "Solo"}</TooltipContent>
              </TooltipPortal>
            </Tooltip>
            <Tooltip placement="bottom">
              <TooltipTrigger
                as={Button}
                variant="ghost"
                size="icon"
                class={controlClass(hidden())}
                aria-label={hidden() ? "Show" : "Hide"}
                onClick={toggleHidden}
              >
                <Show when={!hidden()} fallback={<Icon name="eye-off" class="size-6" />}>
                  <Icon name="eye-on" class="size-6" />
                </Show>
              </TooltipTrigger>
              <TooltipPortal>
                <TooltipContent>{hidden() ? "Show" : "Hide"}</TooltipContent>
              </TooltipPortal>
            </Tooltip>
            {/* The same items as the right-click menu, for anyone who never right-clicks. */}
            <DropdownMenu>
              <DropdownMenuTrigger<typeof Button>
                as={(triggerProps) => (
                  <Button
                    {...triggerProps}
                    variant="ghost"
                    size="icon"
                    aria-label="Layer options"
                    class={`${CONTROL_QUIET} data-[expanded]:opacity-100`}
                  >
                    <Icon name="more-three-dots" class="size-6" />
                  </Button>
                )}
              />
              <DropdownMenuPortal>
                <DropdownMenuContent class="w-[160px]">
                  <Index each={menuItems()}>
                    {(item) => (
                      <>
                        <Show when={item().separatorBefore}>
                          <DropdownMenuSeparator />
                        </Show>
                        <DropdownMenuItem onSelect={item().onSelect}>
                          {item().label}
                          <Show when={item().shortcut}>
                            <DropdownMenuShortcut>{item().shortcut}</DropdownMenuShortcut>
                          </Show>
                        </DropdownMenuItem>
                      </>
                    )}
                  </Index>
                </DropdownMenuContent>
              </DropdownMenuPortal>
            </DropdownMenu>
          </div>
        </div>

        {/* Drag the bottom edge to make the row taller. */}
        <div
          class="absolute bottom-0 left-0 right-0 h-[3px] cursor-ns-resize translate-y-0.5 z-20 group/resize"
          onPointerDown={handleResizeStart}
        >
          <div
            class="absolute left-0 right-0 top-px h-px transition-colors group-hover/resize:bg-primary"
            classList={{ 'bg-primary': resized() === entity() }}
          />
        </div>
      </ContextMenuTrigger>
      <ContextMenuPortal>
        <ContextMenuContent class="w-[160px]">
          <Index each={menuItems()}>
            {(item) => (
              <>
                <Show when={item().separatorBefore}>
                  <ContextMenuSeparator />
                </Show>
                <ContextMenuItem onSelect={item().onSelect}>
                  {item().label}
                  <Show when={item().shortcut}>
                    <ContextMenuShortcut>{item().shortcut}</ContextMenuShortcut>
                  </Show>
                </ContextMenuItem>
              </>
            )}
          </Index>
        </ContextMenuContent>
      </ContextMenuPortal>
    </ContextMenu>
  )
}

function getLayerIcon(world: World, layer: TimelineNode) {
  const entity = layer.entity;

  if (isMask(entity)) return "mask-small";
  if (isAdjustmentLayer(entity)) return "adjustment-layer";
  if (isScene(entity)) return "scene-frame-small";
  if (isSequence(entity)) return "timeline-sequence-small";
  if (isGroup(entity)) return "group";
  if (isCaption(entity)) return "captions-small";
  if (isText(entity)) return "text-small";

  switch (findGeometryAsset(world, entity)?.type) {
    case 'IMAGE':
      return "image-small";
    case 'VIDEO':
    case 'SEQUENCE':
      return "video-small";
    case 'AUDIO':
      return "audio-small";
    default:
      return "rectangle-small";
  }
}
