/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createEffect, createMemo, Index, onCleanup, onMount, Show } from 'solid-js';
import { useTrait, useWorld } from '@diffusionstudio/koota-solid';
import {
  ClipHeight,
  Computed,
  FrameRate,
  Playback,
  togglePlayback,
} from '@diffusionstudio/runtime';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipPortal, TooltipTrigger } from '@/components/ui/tooltip';
import { DEFAULT_CLIP_HEIGHT, RULER_HEIGHT } from '@/engine/timeline';
import { splitAtPlayhead } from '@/engine/split';
import { useDerived, useEditor, useTimelineIndex } from '@/engine/hooks';
import { addLayer as addLayerToScene } from '@/engine/add-layer';
import { useTimeline } from '@/context/timeline';
import { useLayout } from '@/context/layout';
import { store } from '@/init';
import { createStoredSignal } from '@/lib/store';
import { Layer } from './layer';
import { LayerContextProvider } from './context';
import { DropIndicator } from './drop-indicator';
import { formatFrames, TIME_FORMAT_OPTIONS, type TimeFormat } from '../time-format';

import type { TimelineNode } from '@diffusionstudio/runtime';
import type { Entity } from 'koota';

/** The row heights the height menu offers, tightest first. */
const HEIGHT_PRESETS = [
  { label: 'Tight', height: 28 },
  { label: 'Snug', height: 32 },
  { label: 'Normal', height: 40 },
  { label: 'Relaxed', height: 64 },
  { label: 'Loose', height: 116 },
];

export function Layers() {
  const world = useWorld();
  const editor = useEditor();
  const timeline = useTimeline();
  const index = useTimelineIndex();
  const { timelineMinimized, toggleTimeline } = useLayout();

  const layers = createMemo(() => index().layers);
  const scene = createMemo(() => index().root);

  const frameRate = useTrait(world, FrameRate);
  const playback = useTrait(scene, Playback);
  const now = useDerived(() => scene()?.get(Computed)?.localTime ?? 0);

  const [timeFormat, setTimeFormat] = createStoredSignal(
    store.define<TimeFormat>('timeline.timeFormat', 'standard'),
  );

  const clock = createMemo(() => formatFrames(now(), frameRate()?.value ?? 30, timeFormat()));

  // What the height menu ticks: the height the rows share, or none of them if
  // they differ.
  const commonHeight = useDerived(() => {
    let common: number | null = null;

    for (const entity of geometryEntities(layers())) {
      const height = entity.get(ClipHeight)?.value ?? DEFAULT_CLIP_HEIGHT;
      if (common === null) common = height;
      else if (common !== height) return null;
    }

    return common;
  });

  const setCommonHeight = (height: number) => {
    for (const entity of geometryEntities(layers())) {
      editor.editProperty(entity, 'clipHeight', height);
    }
  };

  const addLayer = () => addLayerToScene(world, editor, scene());

  const toggleLooping = () => {
    const entity = scene();
    if (!entity) return;
    entity.set(Playback, { loop: !playback()?.loop });
  };

  const handlePlay = () => {
    const entity = scene();
    if (entity) togglePlayback(world, entity);
  };

  // A press on the empty space below the rows, not on one of them.
  const handlePointerDown = (e: PointerEvent) => {
    if (e.button !== 0 || e.target !== e.currentTarget) return;
    editor.clearSelection();
  };

  const handleHeaderDoubleClick = (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    toggleTimeline();
  };

  createEffect(() => timeline.setMinimized(timelineMinimized()));

  onMount(timeline.mount);
  onCleanup(timeline.unmount);

  return (
    <div class="relative size-full">
      <div
        class="grid grid-cols-1 h-full absolute border-b border-border inset-0 overflow-hidden"
        on:wheel={timeline.scroll}
        style={{ 'grid-template-rows': `${RULER_HEIGHT}px 1fr` }}
        data-timeline-layers-container
      >
        <div
          class="w-full z-10 flex flex-row gap-1 pl-2 pr-3 items-center text-muted-foreground select-none"
          on:dblclick={handleHeaderDoubleClick}
        >
          <Tooltip placement="top">
            <TooltipTrigger<typeof Button>
              as={(triggerProps) => (
                <Button {...triggerProps} variant="ghost" size="icon" onClick={handlePlay}>
                  <Show when={playback()?.playing} fallback={<Icon name="play" class="size-6" />}>
                    <Icon name="pause" class="size-6" />
                  </Show>
                </Button>
              )}
            />
            <TooltipPortal>
              <TooltipContent shortcut="Space">
                {playback()?.playing ? 'Pause' : 'Play'}
              </TooltipContent>
            </TooltipPortal>
          </Tooltip>
          <Tooltip placement="top">
            <TooltipTrigger<typeof Button>
              as={(triggerProps) => (
                <Button {...triggerProps} variant="ghost" size="icon" onClick={toggleLooping}>
                  <Show when={playback()?.loop} fallback={<Icon name="controls-no-loop" />}>
                    <Icon name="controls-loop" />
                  </Show>
                </Button>
              )}
            />
            <TooltipPortal>
              <TooltipContent>
                {playback()?.loop ? 'Disable loop' : 'Enable loop'}
              </TooltipContent>
            </TooltipPortal>
          </Tooltip>
          <Show when={!timelineMinimized()}>
            <Tooltip placement="top">
              <TooltipTrigger<typeof Button>
                as={(triggerProps) => (
                  <Button {...triggerProps} variant="ghost" size="icon" onClick={() => splitAtPlayhead(world)}>
                    <Icon name="split" class="size-6" />
                  </Button>
                )}
              />
              <TooltipPortal>
                <TooltipContent shortcut="⌘B">Split at playhead</TooltipContent>
              </TooltipPortal>
            </Tooltip>
            <DropdownMenu>
              <Tooltip placement="top">
                <TooltipTrigger<typeof DropdownMenuTrigger>
                  as={(triggerProps: object) => (
                    <DropdownMenuTrigger<typeof Button>
                      {...triggerProps}
                      as={(buttonProps) => (
                        <Button {...buttonProps} variant="ghost" size="icon">
                          <Icon name="more-three-dots" class="size-6" />
                        </Button>
                      )}
                    />
                  )}
                />
                <TooltipPortal>
                  <TooltipContent>More options</TooltipContent>
                </TooltipPortal>
              </Tooltip>
              <DropdownMenuPortal>
                <DropdownMenuContent class="w-[180px]">
                  <DropdownMenuItem onSelect={addLayer}>Add layer</DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>Layer height</DropdownMenuSubTrigger>
                    <DropdownMenuPortal>
                      <DropdownMenuSubContent class="w-[140px]">
                        <Index each={HEIGHT_PRESETS}>
                          {(preset) => (
                            <DropdownMenuCheckboxItem
                              onSelect={() => setCommonHeight(preset().height)}
                              checked={commonHeight() === preset().height}
                            >
                              {preset().label}
                              <span class="text-xxs text-muted-foreground ml-auto">{preset().height}</span>
                            </DropdownMenuCheckboxItem>
                          )}
                        </Index>
                      </DropdownMenuSubContent>
                    </DropdownMenuPortal>
                  </DropdownMenuSub>
                  <DropdownMenuSeparator />
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>Time format</DropdownMenuSubTrigger>
                    <DropdownMenuPortal>
                      <DropdownMenuSubContent class="w-[200px]">
                        <DropdownMenuRadioGroup
                          value={timeFormat()}
                          onChange={(value) => setTimeFormat(value as TimeFormat)}
                        >
                          <Index each={TIME_FORMAT_OPTIONS}>
                            {(option) => (
                              <DropdownMenuRadioItem value={option().value}>
                                {option().label}
                                <span class="text-xxs text-muted-foreground ml-auto">
                                  {option().example}
                                </span>
                              </DropdownMenuRadioItem>
                            )}
                          </Index>
                        </DropdownMenuRadioGroup>
                      </DropdownMenuSubContent>
                    </DropdownMenuPortal>
                  </DropdownMenuSub>
                </DropdownMenuContent>
              </DropdownMenuPortal>
            </DropdownMenu>
          </Show>
          <span class="text-xs font-mono font-thin ml-auto select-none">
            {clock()}
          </span>
        </div>
        <div data-timeline-layers-viewport class="relative h-full z-0 overflow-hidden">
          <div
            data-timeline-layers
            class="min-h-full group/layers flex flex-col pb-0.5"
            onPointerDown={handlePointerDown}
          >
            <LayerContextProvider>
              <Index each={layers()}>
                {(layer) => <Layer layer={layer()} />}
              </Index>
              <DropIndicator />
            </LayerContextProvider>
            {/* The way to a new layer that does not ask to be looked for. */}
            <button
              type="button"
              onClick={addLayer}
              class="w-full shrink-0 flex items-center gap-1 h-7 pl-1 pr-2 text-xs text-muted-foreground select-none opacity-55 hover:opacity-100 focus-visible:opacity-100 hover:bg-accent/70 transition-opacity focus-ring rounded-sm"
            >
              <span class="size-4 shrink-0 flex items-center justify-center overflow-clip">
                <Icon name="plus-add" class="size-6" />
              </span>
              Add layer
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Every clip row of the tree, expanded ones included. */
function* geometryEntities(nodes: TimelineNode[]): Generator<Entity> {
  for (const node of nodes) {
    if (node.kind === 'geometry') yield node.entity;
    yield* geometryEntities(node.children);
  }
}
