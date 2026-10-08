/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createSignal } from "solid-js";
import { PanelSection } from "@/components/ui/panel-section";
import { useWorld } from "@diffusionstudio/koota-solid";
import { useDerived } from "@/engine/hooks";
import { textColourTarget, type TextColourTarget } from "@/engine/text-colour";
import { SolidFillRow } from "./source";

import type { Entity } from "koota";

type TextColorSettingsProps = {
  selection: Entity[];
};

const sameTarget = (a: TextColourTarget, b: TextColourTarget) => a.entity === b.entity && a.name === b.name;

/**
 * The colour a text is seen in, as one row whatever spells it: the topmost
 * visible solid paint on the glyphs, or the text's own `fill`/`color` when
 * nothing paints over it (see `textColourTarget`). Editing the intrinsic
 * beneath a paint would change nothing on the canvas, so the row follows the
 * paint — adding, hiding or removing a fill moves it.
 */
export function TextColorSettings(props: TextColorSettingsProps) {
  const world = useWorld();
  const entity = () => props.selection[0]!;
  const target = useDerived(() => textColourTarget(world, entity()), sameTarget);
  const [picking, setPicking] = createSignal(false);

  let anchorRef!: HTMLDivElement;

  return (
    <PanelSection title="Color" ref={anchorRef}>
      <SolidFillRow
        target={target()}
        label="Text"
        anchorRef={anchorRef}
        picking={picking()}
        onPickingChange={setPicking}
      />
    </PanelSection>
  );
}
