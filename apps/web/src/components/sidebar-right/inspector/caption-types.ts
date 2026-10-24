/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { CAPTION_PRESETS, captionTextStyle } from "@diffusionstudio/reconciler";
import { CAPTION_PRESET_STYLES, CaptionAlign } from "@diffusionstudio/runtime";

import type { CaptionPreset as CaptionPresetName } from "@diffusionstudio/jsx";
import type { CaptionPresetStyle, CaptionType, GroupByOptions } from "@diffusionstudio/runtime";

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
 * How a preset lays a cue out, for the footage previews: the box its decoder
 * sizes and places (in scene pixels, before any authored x/y), how it groups
 * words into what is on screen at once, and what it draws beyond plain text.
 * Mirrors the runtime decoders in packages/runtime/src/media/caption, which
 * stay the source of truth; the previews are a sample of them, not a render.
 */
export type CaptionPreviewLook = {
  box: { width: number; height: number; x?: number };
  align: CaptionAlign;
  group: GroupByOptions;
  /** Paper and Guinea break what they show across two lines. */
  lines: 1 | 2;
  /** Cascade reveals a group word by word: only the words that have started are on screen. */
  reveal?: boolean;
  /** What marks the words being spoken: a colored word, a colored larger line, a heavier line. */
  accent?: "word" | "line-color" | "line-weight";
  shadow?: { color: number; blur: number; offsetY: number };
  /** Stark draws in white with a difference blend: the text inverts whatever is behind it. */
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
  {
    name: "classic",
    label: "Classic",
    slots: [],
    look: {
      box: { width: 600, height: 100 },
      align: CaptionAlign.CENTER,
      group: { duration: 0.2 },
      lines: 1,
      shadow: { color: 0x000000, blur: 28, offsetY: 5 },
    },
  },
  {
    name: "cascade",
    label: "Cascade",
    slots: [],
    look: { box: { width: 800, height: 200, x: 100 }, align: CaptionAlign.BOTTOM, group: { length: 50 }, lines: 1, reveal: true },
  },
  {
    name: "spotlight",
    label: "Spotlight",
    slots: [{ label: "Highlight", defaultColor: 0x19FF75 }],
    look: { box: { width: 700, height: 100 }, align: CaptionAlign.CENTER, group: { length: 10 }, lines: 1, accent: "word" },
  },
  {
    name: "whisper",
    label: "Whisper",
    slots: [],
    look: { box: { width: 1000, height: 100 }, align: CaptionAlign.BOTTOM, group: { duration: 2 }, lines: 1 },
  },
  {
    name: "paper",
    label: "Paper",
    slots: [],
    look: { box: { width: 700, height: 200 }, align: CaptionAlign.CENTER, group: { length: 18 }, lines: 2, accent: "line-weight" },
  },
  {
    name: "guinea",
    label: "Guinea",
    slots: [
      { label: "Color 1", defaultColor: 0xF55353 },
      { label: "Color 2", defaultColor: 0xFEB139 },
      { label: "Color 3", defaultColor: 0xF6F54D },
    ],
    look: { box: { width: 700, height: 200 }, align: CaptionAlign.CENTER, group: { length: 18 }, lines: 2, accent: "line-color" },
  },
  {
    name: "stark",
    label: "Stark",
    slots: [],
    look: { box: { width: 700, height: 100 }, align: CaptionAlign.CENTER, group: { duration: 0.2 }, lines: 1, difference: true },
  },
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
 * the caption will look like. A field the document would leave unset falls
 * back to the preset's value here; `fill` is white where the caption draws
 * with no base fill of its own (Stark's difference blend).
 */
export function captionStyleFor(
  option: CaptionPresetOption,
  props: Record<string, unknown>,
): { style: CaptionPresetStyle; fill: number } {
  const base = captionPresetTextStyle(option);
  const resolved = captionTextStyle(CAPTION_PRESETS[option.name]!, props);
  const style = { ...base };
  for (const [key, value] of Object.entries(resolved.style)) {
    if (value !== undefined) Object.assign(style, { [key]: value });
  }
  return { style, fill: resolved.fill ?? 0xffffff };
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
