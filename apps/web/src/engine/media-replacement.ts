/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// One media replacement as an undo step: the two directions the edit
// history plays, each pointing the asset at the bytes it had on that side.

import { AssetSelection } from './traits';

import type { Asset, AssetLibrary } from '@diffusionstudio/assets';
import type { World } from 'koota';

/** Keeps the library selection on an asset whose id changed with its bytes. */
export function followSelection(world: World, asset: Asset, from: string): void {
  if (world.has(AssetSelection) && world.get(AssetSelection)?.id === from) world.set(AssetSelection, { id: asset.id });
}

export interface ReplacementStep {
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  /** The asset as it is now: its id changes with its bytes. */
  current: () => Asset;
  /** Resolves once every undo and redo asked for so far has finished. */
  settled: () => Promise<void>;
}

export interface ReplacementHooks {
  /** Before the bytes change: `id` is the asset's id until then. */
  forget?: (id: string) => void;
  /** After: the asset is `asset`, and was `from`. */
  changed?: (asset: Asset, from: string) => void;
  failed?: (error: Error) => void;
}

// Different steps can replace the same asset. File reads must finish in
// history order, including a burst of Undo commands across those steps.
const queues = new WeakMap<AssetLibrary, Promise<void>>();

/**
 * The step for a replacement that turned `before` (a copy of the asset taken
 * before it) into `replaced`. Undo and redo run in the order they are asked
 * for, each after the last library step has finished, whatever the files take to read.
 */
export function replacementStep(library: AssetLibrary, before: Asset, replaced: Asset, hooks: ReplacementHooks = {}): ReplacementStep {
  const after = { ...replaced };
  let current = replaced;
  let queue: Promise<void> = Promise.resolve();
  const turnTo = (target: Asset): Promise<void> => {
    queue = (queues.get(library) ?? Promise.resolve()).then(async () => {
      const from = current.id;
      try {
        // A later step's Undo (or a library reload) revives a fresh object
        // for these same bytes. Resolve that instance, while still refusing
        // a replacement made outside this history.
        const live = library.get(current.id);
        if (!live || live.source !== current.source || live.path !== current.path) {
          throw new Error('This media was changed again, so this replacement can no longer be undone.');
        }
        const next = await library.restore(live, target);
        hooks.forget?.(from);
        current = next;
        hooks.changed?.(next, from);
      } catch (error) {
        hooks.failed?.(error instanceof Error ? error : new Error(String(error)));
      }
    });
    queues.set(library, queue);
    return queue;
  };
  return { undo: () => turnTo(before), redo: () => turnTo(after), current: () => current, settled: () => queue };
}
