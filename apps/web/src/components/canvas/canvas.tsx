/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useWorld } from "@diffusionstudio/koota-solid";
import { findSceneAt, screenToWorld, worldToLocal, Library, Root } from "@diffusionstudio/runtime";
import { CameraController, EngineCanvas, useEngineContext } from "@/engine";
import { Button } from '../ui/button';
import { insertAsset } from "@/engine/insert-asset";
import { droppedFiles, importFiles } from "@/engine/asset-actions";
import { Toolbar } from "./toolbar";
import { PlaybackControls } from './playback-controls';
import { ProjectStatus } from './project-status';
import { Show } from 'solid-js';
import { useLayout } from '@/context/layout';
import { DrawOverlay } from "./draw-overlay";

import { toast } from "somoto"
import { SceneInitOverlay } from "./scene-init-overlay";
import { ASSET_DRAG_TYPE } from "@/components/sidebar-left/folder-item";

import type { Asset } from "@diffusionstudio/assets";

export function Canvas(props: { loading?: boolean; error?: string; onRetry?: () => void } = {}) {
  const world = useWorld();
  const engine = useEngineContext();
  const { uiVisible } = useLayout();

  /**
   * Drops onto the canvas: library assets (dragged from the panel) land where
   * they were dropped, in the scene under the pointer; external files are
   * imported into the library first, then land the same way.
   *
   * With no scene under the pointer they land loose on the stage, like an
   * element drawn there (see DrawOverlay): the drop says where, so the active
   * scene — which is somewhere else entirely — is not the answer.
   */
  const handleDropEvent = async (event: DragEvent) => {
    event.preventDefault();
    event.stopPropagation();

    const library = world.get(Library);
    if (!library) return;

    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const worldPt = screenToWorld(world, event.clientX - rect.left, event.clientY - rect.top);
    const scene = findSceneAt(world, worldPt.x, worldPt.y);
    const parent = scene ?? world.get(Root)!;
    const localPt = scene ? worldToLocal(world, scene, worldPt.x, worldPt.y) : worldPt;

    const place = (asset: Asset) => {
      const size = 'width' in asset && 'height' in asset ? { width: asset.width, height: asset.height } : { width: 500, height: 150 };
      const placed = insertAsset(world, asset, {
        parent,
        x: localPt.x - size.width / 2,
        y: localPt.y - size.height / 2,
      });
      if (!placed) toast("Nothing to insert into", { description: "Open a project first." });
    };

    const assetIds = event.dataTransfer?.getData(ASSET_DRAG_TYPE)?.split(',').filter(Boolean) ?? [];
    for (const id of assetIds) {
      const asset = library.get(id);
      if (asset) place(asset);
    }

    const files = droppedFiles(event);
    if (files.length) {
      for (const asset of await importFiles(library, files, '')) place(asset);
    }
  }

  const handleDragOver = (event: DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
  }

  return (
    <div data-cut-preview class="relative size-full bg-background" style={{ 'min-width': '0', 'min-height': '0' }}>
      <div
        class={import.meta.env.VITE_PURECUT ? 'absolute top-0 left-0 right-0 bottom-[38px]' : 'absolute inset-0'}
        on:drop={handleDropEvent}
        on:dragover={handleDragOver}
      >
        <Show when={uiVisible()}><Toolbar /><DrawOverlay /></Show>
        <Show when={!props.loading && !props.error}><SceneInitOverlay /></Show>
        <EngineCanvas />
        <CameraController />
        <ProjectStatus loading={props.loading} error={props.error} onRetry={props.onRetry} />
        <Show when={engine.failure()}>{failure =>
          <div role="alert" on:keydown={event => event.stopPropagation()} class="absolute top-3 left-3 right-3 z-50 rounded-md border border-border bg-background p-3 shadow-md">
            <strong>Preview stopped</strong>
            <p class="text-sm break-words">{failure()}</p>
            <Button variant="outline" onClick={() => engine.start()}>Retry preview</Button>
          </div>
        }</Show>
      </div>
      <Show when={import.meta.env.VITE_PURECUT}><PlaybackControls /></Show>
    </div>
  );
}
