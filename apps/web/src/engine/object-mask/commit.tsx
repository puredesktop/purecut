/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { MASK_EXTENSION, assetName, encodeMaskFile } from '@diffusionstudio/assets';
import { Effect as EffectElement, Mask } from '@diffusionstudio/reconciler';
import { Cache, Effect, EffectType, FrameRate, Hidden, Library, getParentNode } from '@diffusionstudio/runtime';
import { geometryOf } from '@diffusionstudio/sam2/models';

import { getDocumentEditor } from '../editor';
import { isEditLocked } from '../locking';
import { getVideoRect } from './media';
import { getTargetEffect } from './store';
import { addPrivacyEffect, authoredId, setBehindSubject, textsAboveClip } from './uses';

import type { Entity, World } from 'koota';
import type { AssetLibrary, MaskAsset, MaskFrame, MaskRecipe, VideoAsset } from '@diffusionstudio/assets';
import type { ObjectMaskSource } from './copy';
import type { ObjectTrack } from './store';
import type { ObjectMaskUse } from './uses';

/** Where masks go in the library: a folder per video under this one. */
const MASKS_FOLDER = 'masks';

/**
 * Turns a tracked session into the document: its frames go into the
 * library as one mask file, `masks/<video>/Tracking <n>.mask`, with the
 * recipe that made them,
 * and the clip gets a `<mask>` naming it — `src` the file, `sourceIn` the
 * clip's source time its first frame belongs to — under the effect the tool
 * was started for, or else under an `opacity` effect: the cut-out. A clip
 * that already has an opacity effect gets the mask under that one. Returns
 * the mask, or null when nothing was written (the session was cancelled, the
 * clip is not a video, or it is locked). `use` picks another effect for the
 * mask (PureCut, see `commitObjectMaskAs`).
 */
export async function commitObjectMask(world: World, track: ObjectTrack, use: ObjectMaskUse = 'cutout'): Promise<Entity | null> {
	return (await commitObjectMaskAs(world, track, use))?.mask ?? null;
}

/** What a commit wrote: the mask file, and the masks it authored — none when there was nowhere to put one. */
export type ObjectMaskCommit = { asset: MaskAsset; mask: Entity | null; masks: Entity[] };

/**
 * `commitObjectMask`, with the mask put to `use` (PureCut): the cut-out, a
 * privacy blur or pixelation on the clip, or the texts above the clip put
 * behind the object (see `uses.tsx`). A target effect, set from an effect's
 * inspector, takes the mask whatever the use. Behind text with no text
 * above the clip writes the file and authors nothing. Null when nothing was
 * written at all.
 */
export async function commitObjectMaskAs(world: World, track: ObjectTrack, use: ObjectMaskUse): Promise<ObjectMaskCommit | null> {
	const library = world.get(Library);
	const rect = getVideoRect(world, track.clip);
	const model = track.model;
	if (!library || !rect || !model || track.masks.length === 0) return null;
	// PureCut: a clip locked while it was tracked takes no mask, and gets no file in the library either.
	if (isEditLocked(track.clip)) return null;

	const { signal } = track.controller;
	const fps = world.get(FrameRate)?.value ?? 30;
	const folder = objectMaskFolder(rect.asset);

	const blob = encodeObjectMask(rect.asset, fps, geometryOf(model.imageSize).maskSize, track.masks, {
		model: model.repo,
		source: rect.asset.id,
		first: track.first,
		seedFrame: track.seedFrame,
		points: track.points,
		strokes: track.strokes,
	});
	if (signal.aborted) return null;

	const asset = await library.store(blob, { folder, name: nextTrackingName(library, folder) }) as MaskAsset;
	if (signal.aborted || !track.clip.isAlive()) return null;

	const editor = getDocumentEditor(world);
	const mask = () => <Mask src={asset.path} sourceIn={track.first / fps} />;
	const written = (entity: Entity | null | undefined): ObjectMaskCommit => ({ asset, mask: entity ?? null, masks: entity ? [entity] : [] });

	const target = getTargetEffect();
	if (target && getParentNode(target) === track.clip) {
		return written(editor.insertElement(target, mask)[0]);
	}

	const source: ObjectMaskSource = { asset, name: assetName(asset).replace(/\.[^.]+$/, ''), sourceIn: track.first / fps };
	if (use === 'blur' || use === 'pixelate') {
		return written(addPrivacyEffect(world, track.clip, source, use)?.get(Cache)?.masks[0]);
	}
	if (use === 'behind') {
		const id = authoredId(track.clip);
		const masks = id === null ? [] : textsAboveClip(world, track.clip).flatMap((text) =>
			setBehindSubject(world, text, { clip: track.clip, id, clipName: '', source }) ?? []);
		return { asset, mask: masks[0] ?? null, masks };
	}

	const holder = opacityEffect(track.clip);
	if (holder) {
		return written(editor.insertElement(holder, mask)[0]);
	}
	const [effect] = editor.insertElement(track.clip, () => (
		<EffectElement type="opacity" value={1}>
			{mask()}
		</EffectElement>
	));
	return written(effect?.get(Cache)?.masks[0]);
}

/** A mask file of tracked frames, on a `grid` square, over footage of `size`, one a frame at `frameRate`. */
export function encodeObjectMask(
	size: { width: number; height: number },
	frameRate: number,
	grid: number,
	masks: readonly (MaskFrame | null)[],
	recipe: MaskRecipe,
): Blob {
	return encodeMaskFile(
		{ gridWidth: grid, gridHeight: grid, width: size.width, height: size.height, frameRate, recipe },
		masks,
	);
}

/** Where masks tracked on `video` go in the library: `masks/<video>`. */
export function objectMaskFolder(video: VideoAsset): string {
	return `${MASKS_FOLDER}/${assetName(video).replace(/\.[^.]+$/, '')}`;
}

/** `Tracking <n>.mask`, `n` the first count not yet taken in `folder`. */
export function nextTrackingName(library: AssetLibrary, folder: string): string {
	for (let n = 1; ; n++) {
		const name = `Tracking ${n}.${MASK_EXTENSION}`;
		if (!library.get(`${folder}/${name}`)) return name;
	}
}

/** The clip's opacity effect, if it has one that is switched on: where another mask joins. */
function opacityEffect(clip: Entity): Entity | null {
	for (const effect of clip.get(Cache)?.effects ?? []) {
		if (effect.get(Effect)?.type === EffectType.OPACITY && !effect.has(Hidden)) return effect;
	}
	return null;
}
