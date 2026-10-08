/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// What a tracked mask is used for (PureCut). A mask on its own is a picture
// of where an object is; these are the four things the editor offers to do
// with it, each spelled in the document as an `<effect>` holding a `<mask>`,
// so it renders the same in the preview and the export, survives a reopen
// and undoes in one step:
//
// - Cut out: the clip's `opacity` effect, the clip seen only inside the mask.
// - Blur / Pixelate: the clip's `blur` or `pixelate` effect, limited to the
//   mask: a face, a plate or a screen hidden for the whole clip.
// - Behind subject: a node above the clip (a text, usually) gets an
//   `opacity` effect with an inverted mask that follows the clip, so it is
//   cut away where the subject is and the subject stands in front of it.

import { assetName } from '@diffusionstudio/assets';
import { parseSource } from '@diffusionstudio/jsx';
import { Effect as EffectElement, Mask } from '@diffusionstudio/reconciler';
import {
	AssetId, Cache, Computed, Effect, EffectType, Hidden, Library, Mask as MaskTrait, Name, Source,
	findGeometryAsset, getSceneAncestor, isGroupLike, isScene, isText,
} from '@diffusionstudio/runtime';

import { getDocumentEditor } from '../editor';
import { isEditLocked } from '../locking';
import type { Entity, World } from 'koota';
import type { AssetLibrary } from '@diffusionstudio/assets';
import type { ObjectMaskSource } from './copy';

/** What the tool's tracked mask becomes in the document. */
export type ObjectMaskUse = 'cutout' | 'blur' | 'pixelate' | 'behind';

export type ObjectMaskUseOption = { value: ObjectMaskUse; label: string; hint: string };

/** The uses, in menu order. */
export const OBJECT_MASK_USES: readonly ObjectMaskUseOption[] = [
	{ value: 'cutout', label: 'Cut out', hint: 'Keep only the object; the rest of the clip goes clear' },
	{ value: 'blur', label: 'Blur', hint: 'Blur the object for the whole clip: a face, a plate, a screen' },
	{ value: 'pixelate', label: 'Pixelate', hint: 'Pixelate the object for the whole clip' },
	{ value: 'behind', label: 'Behind text', hint: 'Put the text above the clip behind the object' },
];

export const isObjectMaskUse = (value: unknown): value is ObjectMaskUse =>
	OBJECT_MASK_USES.some((option) => option.value === value);

/** The privacy effects' starting strength: blur radius and block size, in px of the clip. */
export const PRIVACY_STRENGTH = { blur: 24, pixelate: 24 } as const;

export type PrivacyKind = keyof typeof PRIVACY_STRENGTH;

/** The id a clip is written with: what a mask names to follow it. Null when it has none (a position only). */
export function authoredId(entity: Entity): string | null {
	const source = entity.get(Source)?.value;
	const parsed = source ? parseSource(source) : undefined;
	if (!parsed || typeof parsed.locator !== 'string') return null;
	// The id as written, which `parseSource` would read as a number if it were all digits.
	return source!.slice(source!.lastIndexOf(':') + 1);
}

/** A `<mask>` element for `source`, placed where its frames were written for. */
function maskElement(source: ObjectMaskSource, extra: Record<string, unknown> = {}) {
	return () => (
		<Mask
			src={source.asset.path}
			{...(source.sourceIn > 0 ? { sourceIn: source.sourceIn } : {})}
			{...extra}
		/>
	);
}

// ── Privacy ──────────────────────────────────────────────────

/**
 * Hides the tracked object of `source` on `clip` for the whole clip: a
 * `blur` or `pixelate` effect holding its mask, at `strength` (radius or
 * block size, px of the clip). Returns the effect, or null when the clip is
 * locked.
 */
export function addPrivacyEffect(world: World, clip: Entity, source: ObjectMaskSource, kind: PrivacyKind, strength: number = PRIVACY_STRENGTH[kind]): Entity | null {
	if (isEditLocked(clip)) return null;
	const mask = maskElement(source);
	const [effect] = getDocumentEditor(world).insertElement(clip, () => (
		<EffectElement type={kind} value={strength}>
			{mask()}
		</EffectElement>
	));
	return effect ?? null;
}

// ── Behind subject ───────────────────────────────────────────

/** A node's behind-subject effect: the `opacity` effect, its mask that follows a clip, and the clip. */
export type BehindSubject = { effect: Entity; mask: Entity; clip: Entity | null; follow: string };

/**
 * The node's behind-subject effect, if it has one: an `opacity` effect
 * holding an inverted mask that follows another clip. The clip is null
 * while the id it names matches nothing.
 */
export function behindSubjectOf(world: World, node: Entity): BehindSubject | null {
	for (const effect of node.get(Cache)?.effects ?? []) {
		if (effect.get(Effect)?.type !== EffectType.OPACITY) continue;
		for (const mask of effect.get(Cache)?.masks ?? []) {
			const trait = mask.get(MaskTrait);
			if (!trait?.follow || !trait.inverted) continue;
			return { effect, mask, clip: findClipById(world, node, trait.follow), follow: trait.follow };
		}
	}
	return null;
}

/** Whether `effect` is a behind-subject effect: opacity, holding an inverted mask that follows a clip. */
export function isBehindSubjectEffect(effect: Entity): boolean {
	if (effect.get(Effect)?.type !== EffectType.OPACITY) return false;
	return (effect.get(Cache)?.masks ?? []).some((mask) => {
		const trait = mask.get(MaskTrait);
		return !!trait?.follow && trait.inverted;
	});
}

/** The clip in `node`'s scene written with `id`. */
function findClipById(world: World, node: Entity, id: string): Entity | null {
	const scene = sceneOf(node);
	for (const entity of scene ? treeOf(scene) : world.query(Source)) {
		if (entity !== node && authoredId(entity) === id) return entity;
	}
	return null;
}

/** A subject a node can be put behind: a tracked mask of a video clip in its scene. */
export type SubjectChoice = {
	clip: Entity;
	/** The clip's id in the file, which the mask follows. */
	id: string;
	/** What to call the clip: its name, or its footage's. */
	clipName: string;
	source: ObjectMaskSource;
};

/**
 * Every subject `node` can be put behind: for each video clip in its scene
 * (but itself) that is written with an id, the masks tracked on its footage.
 * Clips drawn below the node come first, since only those can stand in front
 * of it. Empty when nothing is tracked yet — the Object mask tool makes them.
 */
export function subjectChoices(world: World, node: Entity): SubjectChoice[] {
	const library = world.get(Library);
	const scene = sceneOf(node);
	if (!library || !scene) return [];

	const below: SubjectChoice[] = [];
	const above: SubjectChoice[] = [];
	let passed = false;
	for (const clip of treeOf(scene)) {
		if (clip === node) {
			passed = true;
			continue;
		}
		const footage = videoFootage(world, clip);
		const id = footage ? authoredId(clip) : null;
		if (!footage || !id) continue;
		for (const source of trackedOn(library, footage.id)) {
			(passed ? above : below).push({ clip, id, clipName: clipName(world, clip), source });
		}
	}
	return [...below, ...above];
}

/** Whether `node`'s scene has a video clip to track a subject in: the Object mask tool's way in. */
export function sceneHasVideo(world: World, node: Entity): boolean {
	const scene = sceneOf(node);
	return !!scene && treeOf(scene).some((entity) => entity !== node && videoFootage(world, entity) !== null);
}

/**
 * Puts `node` behind the subject `choice` names, in one step: a node already
 * behind a subject has its mask pointed at the new one; otherwise it gets an
 * `opacity` effect holding an inverted mask of the subject that follows its
 * clip. Returns the mask, or null when the node or the clip cannot take it
 * (locked, or the clip has no id to follow).
 */
export function setBehindSubject(world: World, node: Entity, choice: SubjectChoice): Entity | null {
	if (isEditLocked(node) || choice.clip === node) return null;
	const editor = getDocumentEditor(world);
	const current = behindSubjectOf(world, node);

	if (current) {
		editor.editProperty(current.mask, 'src', choice.source.asset.path);
		editor.editProperty(current.mask, 'sourceIn', choice.source.sourceIn > 0 ? choice.source.sourceIn : false);
		editor.editProperty(current.mask, 'follow', choice.id);
		if (current.effect.has(Hidden)) editor.editProperty(current.effect, 'hidden', false);
		return current.mask;
	}

	const mask = maskElement(choice.source, { follow: choice.id, inverted: true });
	const [effect] = editor.insertElement(node, () => (
		<EffectElement type="opacity" value={1}>
			{mask()}
		</EffectElement>
	));
	return effect?.get(Cache)?.masks[0] ?? null;
}

/** Brings `node` back in front of the subject: its behind-subject effect leaves the document. */
export function clearBehindSubject(world: World, node: Entity): boolean {
	const current = behindSubjectOf(world, node);
	if (!current || isEditLocked(node)) return false;
	getDocumentEditor(world).remove(current.effect);
	return true;
}

/**
 * The texts drawn above `clip` in its scene that play while it does: what
 * "Behind text" in the Object mask tool puts behind the tracked object.
 */
export function textsAboveClip(_world: World, clip: Entity): Entity[] {
	const scene = sceneOf(clip);
	if (!scene) return [];
	const computed = (entity: Entity) => entity.get(Computed);
	const start = computed(clip)?.start ?? 0;
	const end = computed(clip)?.end ?? 0;

	const texts: Entity[] = [];
	let passed = false;
	for (const entity of treeOf(scene)) {
		if (entity === clip) {
			passed = true;
			continue;
		}
		if (!passed || !isText(entity) || isEditLocked(entity)) continue;
		const time = computed(entity);
		if (time && time.start < end && time.end > start) texts.push(entity);
	}
	return texts;
}

/**
 * Whether the clip's footage is cut out by `source`: an `opacity` effect on
 * the clip holding that mask. A subject in front of a text shows through
 * from the clip, so with the clip cut out to it there is no background left
 * behind the text.
 */
export function cutOutBy(clip: Entity, source: { asset: { id: string } } | null): Entity | null {
	if (!source) return null;
	for (const effect of clip.get(Cache)?.effects ?? []) {
		if (effect.has(Hidden) || effect.get(Effect)?.type !== EffectType.OPACITY) continue;
		const masks = effect.get(Cache)?.masks ?? [];
		if (masks.some((mask) => !mask.has(Hidden) && !mask.get(MaskTrait)?.follow && mask.get(AssetId)?.value === source.asset.id)) return effect;
	}
	return null;
}

// ── The tree ─────────────────────────────────────────────────

function sceneOf(node: Entity): Entity | null {
	return isScene(node) ? node : getSceneAncestor(node);
}

/** The nodes under `root`, in the order they are drawn: the later, the more on top. */
function treeOf(root: Entity): Entity[] {
	const out: Entity[] = [];
	const visit = (entity: Entity) => {
		for (const child of entity.get(Cache)?.children ?? []) {
			out.push(child);
			if (isGroupLike(child) || (child.get(Cache)?.children.length ?? 0) > 0) visit(child);
		}
	};
	visit(root);
	return out;
}

/** The masks the Object mask tool tracked on the video `footage`, as an effect takes them. */
export function trackedOn(library: AssetLibrary, footage: string): ObjectMaskSource[] {
	const sources: ObjectMaskSource[] = [];
	for (const asset of library.list()) {
		if (asset.type !== 'MASK' || asset.recipe?.source !== footage) continue;
		sources.push({
			asset,
			name: assetName(asset).replace(/\.[^.]+$/, ''),
			sourceIn: asset.recipe ? asset.recipe.first / asset.frameRate : 0,
		});
	}
	return sources;
}

function videoFootage(world: World, clip: Entity) {
	const asset = findGeometryAsset(world, clip);
	return asset?.type === 'VIDEO' ? asset : null;
}

function clipName(world: World, clip: Entity): string {
	const name = clip.get(Name)?.value;
	if (name) return name;
	const footage = videoFootage(world, clip);
	return footage ? assetName(footage).replace(/\.[^.]+$/, '') : 'Clip';
}
