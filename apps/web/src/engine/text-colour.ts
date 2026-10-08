/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { authoredElement } from '@diffusionstudio/reconciler';
import { Geometry, Hidden, Paint, PaintType, Stroke, getEntityChildren } from '@diffusionstudio/runtime';

import type { Entity, World } from 'koota';

/** Which element and prop hold the colour a text is seen in. */
export interface TextColourTarget {
	entity: Entity;
	name: 'color' | 'fill';
}

/**
 * A text's colour is the colour you see. Its own `fill`/`color` (one Color
 * trait) is an intrinsic solid drawn beneath every paint child, so once a
 * `<solidPaint>` sits on the glyphs that prop is invisible. The colour is the
 * topmost visible solid paint child's `color`, or, without one, the text's own
 * intrinsic prop — spelled the way the element already spells it (`color`
 * from the T tool, `fill` from a project or an agent), `fill` when neither is
 * written.
 *
 * The same rule over source is `retargetTextColours` (purecut/editor-core/
 * text-colour.ts), which the review of a proposeCutEdits proposal uses: keep
 * the two in step.
 */
export function textColourTarget(world: World, text: Entity): TextColourTarget {
	const solids = getEntityChildren(world, text).filter(
		child =>
			child.has(Paint) &&
			!child.has(Geometry) &&
			!child.has(Stroke) &&
			!child.has(Hidden) &&
			child.get(Paint)?.value === PaintType.SOLID,
	);
	const top = solids.at(-1);
	if (top) return { entity: top, name: 'color' };

	const props = authoredElement(text)?.props ?? {};
	const name = props.fill === undefined && props.color !== undefined ? 'color' : 'fill';
	return { entity: text, name };
}
