/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The assistant asking the person to track an object (PureCut). The drawer
// agent never runs a model: its `trackCutObject` tool opens the Object mask
// tool on a clip, at a time, with the point it suggests shown as a hint and
// the use it wants picked, and returns. The person clicks the subject (or
// takes the suggested point), agrees to the model's download if it is not on
// this computer yet, and confirms; the app tracks on this computer. What came
// of it — a mask, a cancel, no WebGPU — is kept here for `getCutTrackStatus`.
//
// One request at a time. Opening one writes nothing to the project: the
// playhead moves (as scrubbing does, without a word to the file) and the tool
// is picked; the clip is aimed at rather than selected, since selection is in
// the file.

import { Tool, ToolType, getSceneAncestor, setPlayhead } from '@diffusionstudio/runtime';
import { createSignal } from 'solid-js';

import { clearObjectTrack, clearTargetEffect, getObjectTrack, objectMaskModelLoad, setObjectMaskUse } from './store';
import { OBJECT_MASK_USES } from './uses';

import type { Entity, World } from 'koota';
import type { ObjectMaskUse } from './uses';

/** Where a request stands: waiting for the person, or over one way or another. */
export type TrackRequestStatus = 'pending' | 'done' | 'cancelled' | 'unavailable' | 'failed';

/** What a finished request made: the mask file and what it was put to. */
export type TrackRequestResult = {
	/** The mask's path in the project: what a `<mask src>` names. */
	mask: string;
	/** The use the person confirmed, which may differ from the one asked for. */
	use: ObjectMaskUse;
	/** How many elements took the mask: the clip's effect, or the texts put behind the subject. */
	applied: number;
};

export type TrackRequest = {
	id: string;
	world: World;
	clip: Entity;
	/** The clip's source stamp, `index.tsx:<id>`. */
	clipSource: string;
	/** What to call the clip in the bar: its name, or its footage's. */
	clipName: string;
	/** The assistant's suggested point, in 0..1 of the video frame; a hint until the person takes it. */
	point: { x: number; y: number } | null;
	/** The scene frame the request opened on. */
	frame: number;
	/** The use the assistant asked for. */
	use: ObjectMaskUse;
	/** What the assistant calls the object ("his face"), or null. */
	label: string | null;
	status: TrackRequestStatus;
	/** Why it ended, said so the assistant can pass it on. */
	reason: string | null;
	result: TrackRequestResult | null;
};

export type TrackRequestOptions = Omit<TrackRequest, 'id' | 'world' | 'status' | 'reason' | 'result'>;

const [request, setRequest] = createSignal<TrackRequest | null>(null);

/** The latest request, reactive: pending or how it ended; null before the first. */
export const trackRequest = request;

/** The request waiting for the person, if there is one. */
export function pendingTrackRequest(world?: World): TrackRequest | null {
	const current = request();
	return current?.status === 'pending' && (!world || current.world === world) ? current : null;
}

/** The pending request aimed at `clip`, if there is one: where the tool works. */
export function trackRequestClip(world: World): Entity | null {
	const current = pendingTrackRequest(world);
	return current?.clip.isAlive() ? current.clip : null;
}

/**
 * Opens a request: the Object mask tool, aimed at the clip on `frame`, with
 * `use` picked in its bar. Whatever the tool was doing before is dropped.
 * Throws while another request waits for the person, or while the person has
 * an object of their own in hand.
 */
export function openTrackRequest(world: World, options: TrackRequestOptions): TrackRequest {
	const open = pendingTrackRequest();
	if (open) {
		throw new Error(
			`A tracking request is already waiting for the person (${describeAsk(open)}). Ask them to finish or cancel it in the Object mask bar, then call getCutTrackStatus.`,
		);
	}
	const track = getObjectTrack();
	if (track && track.status !== 'error') {
		throw new Error('The person is working with the Object mask tool right now. Let them finish, then ask again.');
	}

	clearObjectTrack();
	clearTargetEffect();
	setObjectMaskUse(options.use);
	const scene = getSceneAncestor(options.clip);
	if (scene) setPlayhead(world, scene, options.frame);

	const next: TrackRequest = { ...options, id: crypto.randomUUID(), world, status: 'pending', reason: null, result: null };
	setRequest(next);
	world.set(Tool, { value: ToolType.OBJECT_MASK });
	return next;
}

/** Ends the pending request (of `world`, when given) as `status`, with `reason` in words the assistant can relay. */
export function settleTrackRequest(status: Exclude<TrackRequestStatus, 'pending'>, reason: string, result: TrackRequestResult | null = null, world?: World): void {
	const current = pendingTrackRequest(world);
	if (!current) return;
	setRequest({ ...current, status, reason, result });
}

/**
 * The person put the tool down (Cancel, Esc). Nothing was tracked; when the
 * bar was still asking to download the model, that is said, since it is the
 * likelier reason.
 */
export function cancelTrackRequest(world: World): void {
	const current = pendingTrackRequest(world);
	if (!current) return;
	const load = objectMaskModelLoad();
	settleTrackRequest(
		'cancelled',
		load?.phase === 'needs-download' && !getObjectTrack()
			? 'The person closed the Object mask tool without downloading the tracking model. Nothing was tracked and the project is unchanged.'
			: 'The person cancelled. Nothing was tracked and the project is unchanged.',
		null,
		world,
	);
}

/** The person switched to another tool with the request open and nothing being tracked. */
export function settleTrackRequestOnToolDown(world: World): void {
	const current = pendingTrackRequest(world);
	if (!current) return;
	const track = getObjectTrack();
	// Tracking carries on when the tool is put down mid-way; it ends the request itself.
	if (track?.clip === current.clip && (track.status === 'tracking' || track.status === 'saving')) return;
	settleTrackRequest('cancelled', 'The person put the Object mask tool down before confirming. Nothing was tracked and the project is unchanged.', null, world);
}

/** The project is closing: a pending request goes with it. */
export function settleTrackRequestOnClose(world: World): void {
	settleTrackRequest('cancelled', 'The project was closed before the object was tracked. Nothing was tracked.', null, world);
}

/** `clip` left the document. */
export function settleTrackRequestOf(clip: Entity): void {
	if (request()?.status === 'pending' && request()!.clip === clip) {
		settleTrackRequest('cancelled', 'The clip was removed before the object was tracked. Nothing was tracked.');
	}
}

// ── Words ────────────────────────────────────────────────────

/** "his face", or "an object" when the assistant gave no name. */
export function requestSubject(current: Pick<TrackRequest, 'label'>): string {
	return current.label ?? 'an object';
}

/** What the use does to the object, as the end of a sentence: "to blur it". */
export function usePurpose(use: ObjectMaskUse): string {
	switch (use) {
		case 'blur':
			return 'to blur it';
		case 'pixelate':
			return 'to pixelate it';
		case 'behind':
			return 'to put the text behind it';
		default:
			return 'to cut it out';
	}
}

export function useLabel(use: ObjectMaskUse): string {
	return OBJECT_MASK_USES.find((option) => option.value === use)?.label ?? use;
}

function describeAsk(current: TrackRequest): string {
	return `track ${requestSubject(current)} on ${current.clipSource} ${usePurpose(current.use)}`;
}
