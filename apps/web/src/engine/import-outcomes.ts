/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// What an import came to and where missing media is used, in the words the
// asset panel shows them.

import { basename, describeAssetType } from '@diffusionstudio/assets';
import { AssetId, ChildOf, Name, Scene, getSceneAncestor, sortByItemIndex } from '@diffusionstudio/runtime';

import type { Asset, ImportOutcome } from '@diffusionstudio/assets';
import type { Entity, World } from 'koota';

export interface ImportSummaryRow {
  name: string;
  /** What happened to it, said as a sentence. */
  detail: string;
  /** Whether it was refused (the others were kept, in some form). */
  failed: boolean;
}

export interface ImportSummary {
  title: string;
  /** Every file that was not simply added: refused, renamed or already there. */
  rows: ImportSummaryRow[];
}

/** The summary of one import: a count of what was added, and a row for every file that needs a word. */
export function describeImport(outcomes: readonly ImportOutcome[]): ImportSummary {
  const added = outcomes.filter(outcome => outcome.status === 'added' || outcome.status === 'renamed').length;
  const total = outcomes.length;
  const title = total === 1
    ? (added ? '1 file added' : outcomes[0]!.status === 'duplicate' ? 'Already in the library' : 'The file was not added')
    : `${added} of ${total} files added`;
  const rows = outcomes.flatMap((outcome): ImportSummaryRow[] => {
    switch (outcome.status) {
      case 'added': return [];
      case 'renamed': return [{ name: outcome.name, detail: `Added as "${basename(outcome.asset.path)}": the name was taken.`, failed: false }];
      case 'duplicate': return [{ name: outcome.name, detail: `Already in the library as "${outcome.asset.path}".`, failed: false }];
      case 'failed': return [{ name: outcome.name, detail: outcome.reason, failed: true }];
    }
  });
  return { title, rows };
}

/**
 * The scenes an asset is used in, by the name the scene switcher shows
 * ("Intro", or "Scene 2" for one without a name), in stage order.
 */
export function scenesUsing(world: World, assetId: string): string[] {
  const scenes = new Set<Entity>();
  for (const entity of world.query(AssetId)) {
    if (entity.get(AssetId)?.value !== assetId) continue;
    const scene = getSceneAncestor(entity);
    if (scene) scenes.add(scene);
  }
  return [...scenes].sort(sortByItemIndex).map(scene => {
    const name = scene.get(Name)?.value;
    if (name) return name;
    const parent = scene.targetFor(ChildOf);
    const siblings = parent ? [...world.query(Scene, ChildOf(parent))].sort(sortByItemIndex) : [scene];
    return `Scene ${siblings.indexOf(scene) + 1}`;
  });
}

/** Why `asset` cannot be played, naming its file and the scenes using it; undefined when it can be. */
export function missingMediaMessage(world: World, asset: Asset): string | undefined {
  if (!asset.sourceError) return undefined;
  const file = basename(asset.source) || basename(asset.path);
  const scenes = scenesUsing(world, asset.id);
  const why = asset.sourceError === 'File not found'
    ? `${file} is no longer at ${asset.source}.`
    : `${file} could not be read: ${asset.sourceError.replace(/\.$/, '')}.`;
  const where = scenes.length ? ` It is used in ${listWords(scenes)}.` : ' No scene uses it yet.';
  return `${why}${where} Replace it with the file, or another ${describeAssetType(asset.type).replace(/^an? /, '')}, to bring it back.`;
}

const listWords = (words: string[]) =>
  words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
