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
 * The picture under the playhead with every caption taken out: what a caption
 * preset has to stay readable on. Rendered the way an export renders the
 * scene — so it is the shot itself, not the editor's view of it with its
 * selection and guides — in a world of its own, which leaves the project and
 * its history untouched.
 */
export async function captureFrameWithoutCaptions(world: World, scene: Entity, dir?: string): Promise<ImageBitmap> {
  const computed = store(world, Computed);
  // The image encoder counts from the work area's first frame, as an export does.
  const playhead = computed.localTime[scene.id()] ?? 0;
  const frame = Math.max(0, playhead - (scene.get(Workarea)?.start ?? 0));

  const capture = await createCapture(world, scene, { dir });
  try {
    for (const caption of capture.world.query(Caption)) caption.add(Hidden);
    const encoder = await createImageEncoder(capture.world, { frames: [frame], resolution: FRAME_HEIGHT });
    const result = await encoder.render();
    if (result.type === 'canceled') throw new Error('The frame capture was cancelled');
    if (result.type === 'error') throw result.error;
    return await decodePng(result.data[0]!.png);
  } finally {
    capture.dispose();
  }
}
