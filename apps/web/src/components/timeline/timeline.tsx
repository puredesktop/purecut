/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createEffect, onCleanup, onMount } from 'solid-js';
import { toast } from 'somoto';
import { useWorld } from '@diffusionstudio/koota-solid';
import { FrameRate, framesToSeconds, getActiveEntity } from '@diffusionstudio/runtime';
import { droppedFiles, importFiles } from '@/engine/asset-actions';
import { insertAsset } from '@/engine/insert-asset';
import { insertAssetsInNewScene } from '@/engine/new-scene';
import { useLibrary } from '@/engine/library';
import { useTimeline } from '@/context/timeline';
import { TimelineSurface, setActiveTimelineColors, timelineColors } from '@/engine/timeline';
import { ASSET_DRAG_TYPE } from '@/components/sidebar-left/folder-item';

/**
 * The timeline's canvas. What is drawn on it is the timeline system's
 * business (see `@/engine/timeline`); this is the element it draws on and
 * what dropping an asset onto it means.
 */
export function Timeline() {
  const world = useWorld();
  const timeline = useTimeline();
  const library = useLibrary();

  onMount(() => timeline.attachCanvas());
  onCleanup(() => timeline.detachCanvas());

  /**
   * The timeline is drawn on a canvas, so its colours cannot come from CSS.
   * Follow the desktop's light or dark setting, the way the rest of the app
   * does, instead of painting a dark slab into a pale window.
   */
  createEffect(() => {
    const root = document.documentElement;
    const apply = () => {
      const surface = world.get(TimelineSurface);
      if (!surface) return;
      const dark =
        root.dataset.platformTheme === 'dark' ||
        root.dataset.kbTheme === 'dark' ||
        (!root.dataset.platformTheme &&
          window.matchMedia('(prefers-color-scheme: dark)').matches);
      const palette = timelineColors(dark);
      setActiveTimelineColors(palette);
      surface.colors = palette;
    };

    apply();
    const observer = new MutationObserver(apply);
    observer.observe(root, { attributes: true, attributeFilter: ['data-platform-theme', 'data-kb-theme'] });
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', apply);
    onCleanup(() => {
      observer.disconnect();
      media.removeEventListener('change', apply);
    });
  });

  /**
   * Assets dropped on the timeline start where they were dropped, unlike
   * ones dropped on the canvas, which start at the playhead: the whole point
   * of aiming at a place on the timeline is to say when.
   *
   * With no scene to drop into, they get one of their own rather than
   * landing loose at the root, sized to the last of them that has a size
   * (see `insertAssetsInNewScene`).
   */
  const handleDrop = async (event: DragEvent) => {
    event.preventDefault();
    event.stopPropagation();

    const lib = library();
    if (!lib) return;

    const fps = world.get(FrameRate)?.value ?? 30;
    const start = framesToSeconds(Math.max(0, timeline.clientToFrame(event.clientX)), fps);

    // Read the transfer before the first await: it is gone by the time an
    // import resolves.
    const ids = event.dataTransfer?.getData(ASSET_DRAG_TYPE)?.split(',').filter(Boolean) ?? [];
    const files = droppedFiles(event);

    const assets = ids.map((id) => lib.get(id)).filter((asset) => asset != null);
    if (files.length) assets.push(...await importFiles(lib, files, ''));
    if (!assets.length) return;

    if (!getActiveEntity(world)) {
      if (!insertAssetsInNewScene(world, assets, { start })) {
        toast("Nothing to insert into", { description: "Open a project first." });
      }
      return;
    }

    for (const asset of assets) {
      if (!insertAsset(world, asset, { start })) {
        toast("Nothing to insert into", { description: "Open a scene first." });
      }
    }
  };

  const handleDragOver = (event: DragEvent) => {
    event.preventDefault();
    event.dataTransfer!.dropEffect = 'copy';
  };

  return (
    <div class="relative size-full">
      <canvas
        class="absolute inset-0"
        id="timeline-canvas"
        on:drop={handleDrop}
        on:dragover={handleDragOver}
      />
    </div>
  );
}
