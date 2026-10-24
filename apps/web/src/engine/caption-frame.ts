/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createImageEncoder, decodePng } from '@diffusionstudio/encoder';
import { Caption, Computed, Hidden, Workarea, store } from '@diffusionstudio/runtime';

import { createCapture } from './capture';

import type { Entity, World } from 'koota';

/** Tall enough to judge a caption by, small enough to render in a moment. */
const FRAME_HEIGHT = 360;

/**
 * Readies a capture world for a caption check and says which encoder frame
 * shows `playhead` (a frame of the editor's scene). Every caption is hidden,
 * so the picture is what a caption has to stand out from. The scene's work
 * area goes: the image encoder counts frames from it, as an export does, and
 * a playhead before or after it would otherwise be captured as some other
 * frame. Without one, frame 0 is the scene's start and the playhead is its
 * own frame.
 */
export function prepareCaptionFrame(captureWorld: World, scene: Entity, playhead: number): number {
  for (const caption of captureWorld.query(Caption)) caption.add(Hidden);
  scene.remove(Workarea);
  return Math.max(0, Math.round(playhead));
}

/**
 * The picture under the playhead with every caption taken out: what a caption
 * preset has to stay readable on. Rendered the way an export renders the
 * scene — so it is the shot itself, not the editor's view of it with its
 * selection and guides — in a world of its own, which leaves the project and
 * its history untouched.
 */
export async function captureFrameWithoutCaptions(world: World, scene: Entity, dir?: string): Promise<ImageBitmap> {
  const playhead = store(world, Computed).localTime[scene.id()] ?? 0;
  const capture = await createCapture(world, scene, { dir });
  try {
    const frame = prepareCaptionFrame(capture.world, capture.node, playhead);
    const encoder = await createImageEncoder(capture.world, { frames: [frame], resolution: FRAME_HEIGHT });
    const result = await encoder.render();
    if (result.type === 'canceled') throw new Error('The frame capture was cancelled');
    if (result.type === 'error') throw result.error;
    return await decodePng(result.data[0]!.png);
  } finally {
    capture.dispose();
  }
}
