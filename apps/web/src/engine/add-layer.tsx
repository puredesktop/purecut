/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { toast } from 'somoto';
import { Sequence as SequenceElement } from '@diffusionstudio/reconciler';
import { getNextName, Source } from '@diffusionstudio/runtime';

import type { Entity, World } from 'koota';
import type { DocumentEditor } from './editor';

/**
 * A new layer is an empty sequence: a row of its own whose clips share one
 * line, laid end to end without overlapping.
 *
 * It lives here rather than inside the timeline so the command bar, the
 * timeline rail and the overflow menu all add a layer the same way.
 */
export function addLayer(
  world: World,
  editor: DocumentEditor,
  scene: Entity | null | undefined,
): Entity | undefined {
  if (!scene?.get(Source)?.value) {
    toast('Nothing to add a layer to', { description: 'Open a scene first.' });
    return;
  }

  const [layer] = editor.insertElement(scene, () => (
    <SequenceElement name={getNextName(world, 'Layer')} />
  ));

  if (layer) editor.select(layer);
  return layer;
}
