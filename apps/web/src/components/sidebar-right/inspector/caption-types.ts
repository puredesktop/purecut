/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { CAPTION_PRESETS, captionTextStyle } from "@diffusionstudio/reconciler";
import { CAPTION_PRESET_STYLES, FontStyle, TextAlign, TextBaseline, TextCase } from "@diffusionstudio/runtime";

import type { CaptionPreset as CaptionPresetName } from "@diffusionstudio/jsx";
import type { CaptionPresetStyle, CaptionType } from "@diffusionstudio/runtime";

/**
 * A color the preset paints with and lets the file override, in the order its
 * decoder reads `colors`. `defaultColor` is what that decoder falls back to,
 * so it is what the row shows for a slot the file has not filled; the runtime
 * constants are the source of truth for those values.
 */
export type CaptionColorSlot = {
  label: string;
  defaultColor: number;
};

/**
 * What the readability check needs to know about how a preset paints, beyond
 * its colors: the runtime decoders in packages/runtime/src/media/caption
 * stay the source of truth, and draw the previews themselves (see
 * CaptionSampler). Layout, grouping and placement are theirs alone.
 */
export type CaptionPreviewLook = {
  /** What marks the words being spoken: a colored word, a colored larger line, a heavier line. */
  accent?: "word" | "line-color" | "line-weight";
  /** Classic's blurred black shadow, which darkens the picture behind the letters. */
  shadow?: { color: number; blur: number; offsetY: number };
  /** Stark paints white with a difference blend over the caption's own fill. */
  difference?: boolean;
};

export type CaptionPresetOption = {
  name: CaptionPresetName;
  label: string;
  slots: CaptionColorSlot[];
  look: CaptionPreviewLook;
};

/** The presets, in the order the select lists them. */
export const CAPTION_PRESET_OPTIONS: CaptionPresetOption[] = [
  { name: "classic", label: "Classic", slots: [], look: { shadow: { color: 0x000000, blur: 28, offsetY: 5 } } },
  { name: "cascade", label: "Cascade", slots: [], look: {} },
  {
    name: "spotlight",
    label: "Spotlight",
    slots: [{ label: "Highlight", defaultColor: 0x19FF75 }],
    look: { accent: "word" },
  },
  { name: "whisper", label: "Whisper", slots: [], look: {} },
  { name: "paper", label: "Paper", slots: [], look: { accent: "line-weight" } },
  {
    name: "guinea",
    label: "Guinea",
    slots: [
      { label: "Color 1", defaultColor: 0xF55353 },
      { label: "Color 2", defaultColor: 0xFEB139 },
      { label: "Color 3", defaultColor: 0xF6F54D },
    ],
    look: { accent: "line-color" },
  },
  { name: "stark", label: "Stark", slots: [], look: { difference: true } },
];

/** The text style a preset writes onto its caption (font, weight, size, case). */
export function captionPresetTextStyle(option: CaptionPresetOption): CaptionPresetStyle {
  return CAPTION_PRESET_STYLES[CAPTION_PRESETS[option.name]!];
}

/**
 * The style a caption with these authored props would draw with under a
 * preset: the preset's base coat with the caption's own font, size, case,
 * spacing, alignment and fill over it, by the document's own rules
 * (`captionTextStyle`). Applying a preset keeps those props, so this is what
 * the caption will look like. A field the document would leave unset uses
 * the renderer's default; `fill` is white where the caption draws with no
 * base fill of its own (Stark's difference blend).
 */
export function captionStyleFor(
  option: CaptionPresetOption,
  props: Record<string, unknown>,
): { style: CaptionPresetStyle; fill: number } {
  const { style: resolved, fill } = captionTextStyle(CAPTION_PRESETS[option.name]!, props);
  const style: CaptionPresetStyle = {
    fontSize: resolved.fontSize ?? 16,
    fontFamily: resolved.fontFamily || "Inter",
    fontWeight: resolved.fontWeight ?? "400",
    fontStyle: resolved.fontStyle ?? FontStyle.NORMAL,
    textAlign: resolved.textAlign ?? TextAlign.LEFT,
    textBaseline: resolved.textBaseline ?? TextBaseline.TOP,
    textCase: resolved.textCase ?? TextCase.ORIGINAL,
    leading: resolved.leading ?? 1,
    letterSpacing: resolved.letterSpacing,
  };
  return { style, fill: fill ?? 0xffffff };
}

/**
 * The colors a caption's words end up on screen in under a preset, for the
 * readability check: what its text is drawn in, and whether that depends on
 * the picture behind it. The runtime paints the caption's own fill first and
 * the preset's paints over it. Stark's paint is white with a difference
 * blend, so over a fill of its own each glyph is that fill inverted — one
 * fixed color — and only with no fill (the preset's default) does it invert
 * the picture itself.
 */
export function captionTextPaint(
  option: CaptionPresetOption,
  props: Record<string, unknown>,
): { text: number; difference: boolean } {
  const { fill } = captionTextStyle(CAPTION_PRESETS[option.name]!, props);
  if (!option.look.difference) return { text: fill ?? 0xffffff, difference: false };
  if (fill === undefined || fill === null) return { text: 0xffffff, difference: true };
  return { text: 0xffffff ^ fill, difference: false };
}

/** The preset a caption with no `preset` of its own plays. */
export const DEFAULT_CAPTION_PRESET: CaptionPresetOption = CAPTION_PRESET_OPTIONS[0]!;

const BY_TYPE = new Map<CaptionType, CaptionPresetOption>(
  CAPTION_PRESET_OPTIONS.map((option) => [CAPTION_PRESETS[option.name]!, option]),
);

/**
 * The option for the type a `Caption` trait holds. Identity matters: the
 * select compares its value against the options it was given, so this hands
 * back the option itself rather than a copy.
 */
export function captionPresetOption(type: CaptionType | undefined): CaptionPresetOption {
  return (type === undefined ? undefined : BY_TYPE.get(type)) ?? DEFAULT_CAPTION_PRESET;
}
