/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Show, createMemo, createSignal } from "solid-js";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Icon } from "@/components/ui/icon";
import {
  FloatingInspector,
  FloatingInspectorContent,
  FloatingInspectorHeader,
  FloatingInspectorSeparator,
  FloatingInspectorTitle,
} from "@/components/ui/floating-inspector";
import { ControlRow } from "@/components/ui/control-group";
import { ColorOpacityRow } from "@/components/ui/color-opacity-row";
import { ColorOpacityPicker } from "@/components/ui/color-opacity-picker";
import { ControlledTextField } from "@/components/ui/text-field";
import { SegmentedIconTabs } from "@/components/ui/segmented-icon-tabs";
import { Keyframe } from "@/components/ui/keyframe";
import { useHas, useTrait, useWorld } from "@diffusionstudio/koota-solid";
import { Computed, StrokeCap, StrokeDash, StrokeJoin, StrokeStyle, colorToHex } from "@diffusionstudio/runtime";
import { useDerived, useEditor } from "@/engine/hooks";
import { removeKeyframeTrack, syncKeyframe } from "@/engine/keyframes";

import type {
  AnimatableProperty,
  StrokeCap as StrokeCapName,
  StrokeJoin as StrokeJoinName,
} from "@diffusionstudio/jsx";
import type { Entity } from "koota";

const JOIN_SEGMENTS: { value: StrokeJoinName; icon: string; label: string }[] = [
  { value: "miter", icon: "line-join-miter", label: "Miter" },
  { value: "bevel", icon: "line-join-bevel", label: "Bevel" },
  { value: "round", icon: "line-join-round", label: "Round" },
];

const CAP_SEGMENTS: { value: StrokeCapName; icon: string; label: string }[] = [
  { value: "butt", icon: "line-cap-butt", label: "Butt" },
  { value: "round", icon: "line-cap-round", label: "Round" },
  { value: "square", icon: "line-cap-square", label: "Square" },
];

const CAP_NAMES: Record<StrokeCap, StrokeCapName> = {
  [StrokeCap.BUTT]: "butt",
  [StrokeCap.ROUND]: "round",
  [StrokeCap.SQUARE]: "square",
};

type LineStyle = "solid" | "dashed";

const LINE_SEGMENTS: { value: LineStyle; icon: string; label: string }[] = [
  { value: "solid", icon: "stroke.solid", label: "Solid" },
  { value: "dashed", icon: "stroke.dashed", label: "Dashed" },
];

/** The props a dashed line adds, all cleared when it goes back to solid. */
const DASH_PROPS: AnimatableProperty[] = ["dash", "dashGap", "dashOffset"];

/** The dash a solid line takes when it is switched to dashed, its gap the same. */
const DASHED_DASH = 10;

const JOIN_NAMES: Record<StrokeJoin, StrokeJoinName> = {
  [StrokeJoin.MITER]: "miter",
  [StrokeJoin.BEVEL]: "bevel",
  [StrokeJoin.ROUND]: "round",
};

/** `<stroke>`'s defaults; a control left at one of these unsets its prop. */
const DEFAULT_OPACITY = 1;
const DEFAULT_WIDTH = 1;
const DEFAULT_MITER_LIMIT = 10;

type StrokeInspectorProps = {
  stroke: Entity;
  anchorRef: HTMLElement;
  onClose(): void;
};

/**
 * One `<stroke>`: its paint (color and opacity) and its line style
 * (`width`/`cap`/`join`/`miterLimit`, and when dashed `dash`/`dashGap`).
 * The color half is the color picker alone, with no gradient or asset tab.
 * A cap shows on the ends of open paths and on each dash.
 */
export function StrokeInspector(props: StrokeInspectorProps) {
  const world = useWorld();
  const editor = useEditor();

  let colorRowRef: HTMLDivElement | undefined;

  const [pickingColor, setPickingColor] = createSignal(false);

  const color = useDerived(() => props.stroke.get(Computed)?.color ?? 0);
  const opacity = useDerived(() => props.stroke.get(Computed)?.opacity ?? DEFAULT_OPACITY);
  const width = useDerived(() => props.stroke.get(Computed)?.strokeWidth ?? DEFAULT_WIDTH);

  const style = useTrait(() => props.stroke, StrokeStyle);

  const join = createMemo(() => JOIN_NAMES[style()?.join ?? StrokeJoin.MITER]);
  const cap = createMemo(() => CAP_NAMES[style()?.cap ?? StrokeCap.BUTT]);
  const isDashed = useHas(() => props.stroke, StrokeDash);
  const lineStyle = (): LineStyle => (isDashed() ? "dashed" : "solid");
  const dash = useDerived(() => props.stroke.get(Computed)?.dash ?? 0);
  const dashGap = useDerived(() => props.stroke.get(Computed)?.dashGap ?? 0);
  const miterLimit = () => style()?.miterLimit ?? DEFAULT_MITER_LIMIT;

  /** A stroke's color is required, never unset. */
  const editColor = (value: number) => {
    const hex = colorToHex(value);
    editor.editProperty(props.stroke, "color", hex);
    syncKeyframe(world, editor, props.stroke, "color", hex);
  };

  const editOpacity = (value: number) => {
    const next = Math.round(value * 100) / 100;
    editor.editProperty(props.stroke, "opacity", next === DEFAULT_OPACITY ? false : next);
    syncKeyframe(world, editor, props.stroke, "opacity", next);
  };

  const editWidth = (value: number) => {
    // Unlike a node's width this is the line width, not `resizeEntity`, so
    // there is no track of its own to mint and the sync belongs after.
    editor.editProperty(props.stroke, "width", value === DEFAULT_WIDTH ? false : value);
    syncKeyframe(world, editor, props.stroke, "width", value);
  };

  const editJoin = (value: StrokeJoinName) => {
    editor.editProperty(props.stroke, "join", value === "miter" ? false : value);
  };

  const editCap = (value: StrokeCapName) => {
    editor.editProperty(props.stroke, "cap", value === "butt" ? false : value);
  };

  /** Dashed starts as equal dashes and gaps; solid clears every dash prop and its keyframes. */
  const editLineStyle = (value: LineStyle) => {
    if (value === lineStyle()) return;
    if (value === "dashed") {
      editor.editProperty(props.stroke, "dash", DASHED_DASH);
      editor.editProperty(props.stroke, "dashGap", DASHED_DASH);
      return;
    }
    for (const property of DASH_PROPS) {
      removeKeyframeTrack(world, editor, props.stroke, property);
      editor.editProperty(props.stroke, property, false);
    }
  };

  // The dash fields write even their defaults: unsetting the last of them
  // would make the line solid again.
  const editDash = (value: number) => {
    editor.editProperty(props.stroke, "dash", value);
    syncKeyframe(world, editor, props.stroke, "dash", value);
  };

  const editDashGap = (value: number) => {
    editor.editProperty(props.stroke, "dashGap", value);
    syncKeyframe(world, editor, props.stroke, "dashGap", value);
  };

  const editMiterLimit = (value: number) => {
    editor.editProperty(
      props.stroke,
      "miterLimit",
      value === DEFAULT_MITER_LIMIT ? false : value,
    );
  };

  const handleClose = () => {
    setPickingColor(false);
    props.onClose();
  };

  return (
    <>
      <FloatingInspector open anchorRef={props.anchorRef} width={248}>
        <FloatingInspectorHeader class="items-center justify-between">
          <FloatingInspectorTitle>Stroke</FloatingInspectorTitle>
          <Tooltip>
            <TooltipTrigger
              as={Button}
              size="icon"
              variant="ghost"
              class="text-muted-foreground"
              onClick={handleClose}
            >
              <Icon name="close-remove" />
            </TooltipTrigger>
            <TooltipContent>Close</TooltipContent>
          </Tooltip>
        </FloatingInspectorHeader>
        <FloatingInspectorSeparator />
        <FloatingInspectorContent class="flex flex-col gap-2 p-4">
          <ControlRow label="Color" ref={colorRowRef}>
            <ColorOpacityRow
              color={color()}
              onChangeColor={editColor}
              opacity={opacity()}
              onChangeOpacity={editOpacity}
              onClick={() => setPickingColor(true)}
              keyframe={<Keyframe target={props.stroke} property="opacity" />}
            />
          </ControlRow>

          <ControlRow label="Weight">
            <ControlledTextField
              value={width()}
              onNumber={editWidth}
              step={1}
              min={0}
              autoSelect
              limitEvents
              keyframe={<Keyframe target={props.stroke} property="width" />}
            />
          </ControlRow>

          <ControlRow label="Line">
            <SegmentedIconTabs
              value={lineStyle}
              onChange={editLineStyle}
              items={LINE_SEGMENTS}
              buttonClass="transition-colors"
              iconClass="size-3.5 text-muted-foreground"
            />
          </ControlRow>

          <Show when={isDashed()}>
            <ControlRow label="Dash" contentClass="grid grid-cols-2 gap-2">
              <ControlledTextField
                value={dash()}
                onNumber={editDash}
                step={1}
                min={0}
                autoSelect
                limitEvents
                aria-label="Dash length"
                keyframe={<Keyframe target={props.stroke} property="dash" />}
              />
              <ControlledTextField
                value={dashGap()}
                onNumber={editDashGap}
                step={1}
                min={0}
                autoSelect
                limitEvents
                aria-label="Gap length"
                keyframe={<Keyframe target={props.stroke} property="dashGap" />}
              />
            </ControlRow>
          </Show>

          <ControlRow label="Cap">
            <SegmentedIconTabs
              value={cap}
              onChange={editCap}
              items={CAP_SEGMENTS}
              buttonClass="transition-colors"
              iconClass="size-3.5 text-muted-foreground"
            />
          </ControlRow>

          <ControlRow label="Join">
            <SegmentedIconTabs
              value={join}
              onChange={editJoin}
              items={JOIN_SEGMENTS}
              buttonClass="transition-colors"
              iconClass="size-3.5 text-muted-foreground"
            />
          </ControlRow>

          <ControlRow label="Miter">
            <ControlledTextField
              value={miterLimit()}
              onNumber={editMiterLimit}
              step={1}
              min={1}
              autoSelect
              limitEvents
            />
          </ControlRow>
        </FloatingInspectorContent>
      </FloatingInspector>

      <FloatingInspector open={pickingColor} anchorRef={() => colorRowRef} offset={26}>
        <FloatingInspectorHeader>
          <FloatingInspectorTitle>Color</FloatingInspectorTitle>
          <div class="ml-auto">
            <Tooltip>
              <TooltipTrigger
                as={Button}
                size="icon"
                variant="ghost"
                class="text-muted-foreground"
                onClick={() => setPickingColor(false)}
              >
                <Icon name="close-remove" class="size-6" />
              </TooltipTrigger>
              <TooltipContent>Close</TooltipContent>
            </Tooltip>
          </div>
        </FloatingInspectorHeader>
        <FloatingInspectorContent class="p-0">
          <ColorOpacityPicker
            color={color()}
            opacity={opacity()}
            onColorChange={editColor}
            onOpacityChange={editOpacity}
            keyframeTarget={props.stroke}
          />
        </FloatingInspectorContent>
      </FloatingInspector>
    </>
  );
}
