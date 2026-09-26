/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { For, Show, createMemo } from "solid-js";
import { PanelSection } from "@/components/ui/panel-section";
import { ControlRow } from "@/components/ui/control-group";
import { useQuery, useTrait, useWorld } from "@diffusionstudio/koota-solid";
import {
  ChildOf,
  Computed,
  FrameRate,
  Name,
  Root,
  Scene,
  sortByItemIndex,
} from "@diffusionstudio/runtime";
import { useActiveScene, useDerived } from "@/engine/hooks";
import { formatDuration } from "@/utils/formatters";
import { ExportVideoButton } from "./export";

import type { Entity } from "koota";

/** Whole frame rates read as themselves; a drop-frame rate keeps its decimals. */
function formatFrameRate(fps: number) {
  return Number.isInteger(fps) ? `${fps}` : fps.toFixed(2);
}

/**
 * What the video is, for when nothing is selected: the size and frame rate it
 * is made at, the scenes it is made of, and the way out of the editor — an
 * export. The inspector is never blank, and never only a colour well.
 */
export function VideoPanel() {
  const world = useWorld();
  const activeScene = useActiveScene();

  const frameRate = useTrait(world, FrameRate);
  const fps = () => frameRate()?.value ?? 30;

  const width = useDerived(() => activeScene()?.get(Computed)?.width ?? 0);
  const height = useDerived(() => activeScene()?.get(Computed)?.height ?? 0);

  // Scenes are top-level by definition; the order is the stage's, so the list
  // reads the way the timeline's scene switcher does.
  const children = useQuery(Scene, ChildOf(world.get(Root)!));
  const scenes = createMemo(() => [...children()].sort(sortByItemIndex));

  return (
    <PanelSection title="Video">
      <ControlRow label="Size">
        <span class="text-xs text-foreground">
          <Show when={width() && height()} fallback="—">
            {width()} × {height()}
          </Show>
        </span>
      </ControlRow>
      <ControlRow label="Frame rate">
        <span class="text-xs text-foreground">{formatFrameRate(fps())} FPS</span>
      </ControlRow>

      <Show when={scenes().length > 0}>
        <div class="flex flex-col">
          <For each={scenes()}>
            {(scene, index) => (
              <SceneRow
                scene={scene}
                index={index()}
                fps={fps()}
                active={scene === activeScene()}
              />
            )}
          </For>
        </div>
      </Show>

      <ExportVideoButton />

      <p class="text-xxs text-muted-foreground">
        Select a clip to see its timing, frame and sound.
      </p>
    </PanelSection>
  );
}

type SceneRowProps = {
  scene: Entity;
  index: number;
  fps: number;
  active: boolean;
};

/** One scene: what it is called, and the stretch of time it covers. */
function SceneRow(props: SceneRowProps) {
  const name = useTrait(() => props.scene, Name);
  const start = useDerived(() => props.scene.get(Computed)?.start ?? 0);
  const end = useDerived(() => props.scene.get(Computed)?.end ?? 0);

  const range = () =>
    `${formatDuration(start() / props.fps)} – ${formatDuration(end() / props.fps)}`;

  return (
    <div class="flex items-center gap-2 h-7 text-xs">
      <span
        class="flex-1 min-w-0 truncate"
        classList={{ "text-foreground": props.active, "text-muted-foreground": !props.active }}
      >
        {name()?.value || `Scene ${props.index + 1}`}
      </span>
      <span class="shrink-0 text-muted-foreground tabular-nums">{range()}</span>
    </div>
  );
}
