/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The caption footage check: how a preset's caption would sit on a picture,
 * and whether it would stay readable there. The layout and the readability
 * measure are pure; the painting takes any 2D context, so the same code draws
 * the inspector's tiles and the checks' canvases.
 */

import { CAPTION_MARGIN, CaptionAlign, TextBaseline, TextCase, groupBy, splitSequence } from "@diffusionstudio/runtime";

import type { Transcript, WordGroup } from "@diffusionstudio/assets";
import type { CaptionPresetStyle } from "@diffusionstudio/runtime";
import type { CaptionPreviewLook } from "./caption-types";

type Cue = Transcript[number];

/** What a preset shows of a cue at one moment: its lines and the part being spoken. */
export type PreviewText = {
  lines: string[];
  /** The line the speaker is on, for Paper's weight and Guinea's color. */
  activeLine: number;
  /** The word being spoken, for Spotlight: its line and its index in that line. */
  activeWord: { line: number; index: number } | null;
};

/** What stands in for a cue when the playhead is between cues. */
export const SAMPLE_CUE: Cue = {
  text: "Every caption should read clearly on this shot",
  words: "Every caption should read clearly on this shot".split(" ").map((text, i) => ({
    text, start: i * 0.35, end: i * 0.35 + 0.3,
  })),
};

/**
 * The words a preset puts on screen at `seconds` (transcript time): the same
 * grouping its decoder makes, and the group playing then — or the first group
 * when nothing is playing, so a cue is always shown.
 */
export function previewText(look: CaptionPreviewLook, cue: Cue, seconds: number): PreviewText {
  const groups = groupBy([cue], look.group);
  if (!groups.length) return { lines: [], activeLine: 0, activeWord: null };
  const playing = groups.findIndex(group => seconds >= group[0]!.start && seconds <= group.at(-1)!.end);
  const group: WordGroup = groups[playing === -1 ? 0 : playing]!;
  const spoken = group.findIndex(word => seconds >= word.start && seconds <= word.end);

  if (look.lines === 2) {
    const [left, right] = splitSequence(group);
    const lines = [left, right].filter(line => line.length).map(line => line.map(word => word.text).join(" "));
    const activeLine = right.length && seconds >= right[0]!.start ? 1 : 0;
    return { lines, activeLine, activeWord: null };
  }
  const word = look.accent === "word" && group.length > 1 ? Math.max(0, spoken) : -1;
  return {
    lines: [group.map(w => w.text).join(" ")],
    activeLine: 0,
    activeWord: word === -1 ? null : { line: 0, index: word },
  };
}

export function applyTextCase(text: string, textCase: TextCase): string {
  if (textCase === TextCase.UPPER) return text.toUpperCase();
  if (textCase === TextCase.LOWER) return text.toLowerCase();
  return text;
}

/** WCAG relative luminance of an sRGB color, 0 (black) to 1 (white). */
export function relativeLuminance(r: number, g: number, b: number): number {
  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio between two luminances, 1 to 21. */
export function contrastRatio(a: number, b: number): number {
  const [light, dark] = a > b ? [a, b] : [b, a];
  return (light + 0.05) / (dark + 0.05);
}

/** Large text (captions are) stays legible at 3:1; below it, letters wash into the picture. */
export const LEGIBLE_CONTRAST = 3;

export type Readability = {
  /** Share of the picture behind the words the text cannot be told apart from (0–1). */
  lost: number;
  verdict: "clear" | "patchy" | "lost";
};

/**
 * How much of the picture behind a caption its text would disappear into.
 * `pixels` is RGBA of the backdrop under the text block, sampled before the
 * text is drawn. A shadow (Classic) darkens what is directly behind the
 * letters, so it is measured against a darkened backdrop; a difference blend
 * (Stark) draws each pixel's inverse, which vanishes only on mid grey.
 */
export function assessReadability(
  pixels: ArrayLike<number>,
  text: number,
  look: Pick<CaptionPreviewLook, "shadow" | "difference">,
  step = 1,
): Readability {
  const tr = (text >> 16) & 0xff;
  const tg = (text >> 8) & 0xff;
  const tb = text & 0xff;
  const textLuminance = relativeLuminance(tr, tg, tb);
  // A blurred black shadow under the letters keeps roughly half the light
  // of what is behind them.
  const keep = look.shadow ? 0.45 : 1;
  let sampled = 0;
  let lost = 0;
  for (let i = 0; i + 3 < pixels.length; i += 4 * step) {
    const r = pixels[i]! * keep;
    const g = pixels[i + 1]! * keep;
    const b = pixels[i + 2]! * keep;
    const behind = relativeLuminance(r, g, b);
    const drawn = look.difference
      ? relativeLuminance(Math.abs(tr - r), Math.abs(tg - g), Math.abs(tb - b))
      : textLuminance;
    sampled++;
    if (contrastRatio(drawn, behind) < LEGIBLE_CONTRAST) lost++;
  }
  const share = sampled ? lost / sampled : 0;
  return { lost: share, verdict: share > 0.3 ? "lost" : share > 0.1 ? "patchy" : "clear" };
}

/** Past this share of the picture, a caption hides more than it helps. */
export const HEAVY_COVERAGE = 0.2;

export type CaptionLayout = {
  font: (line: number) => string;
  /** Scene-pixel text block: where the lines are drawn, as one rectangle. */
  block: { x: number; y: number; width: number; height: number };
  /** `source` is the PreviewText line it wraps; `firstWord` its first word's index there. */
  lines: { text: string; source: number; firstWord: number; x: number; y: number; width: number }[];
  lineHeight: number;
  /** Share of the picture the text block covers (0–1). */
  coverage: number;
};

type Measure = (text: string, font: string) => number;

/**
 * Where a preset draws a cue in a scene of `scene` size, in scene pixels:
 * the decoder's box placed the way `placeCaption` places it (authored x/y
 * win), lines wrapped to the box width, and the block they make.
 */
export function layoutCaption(
  look: CaptionPreviewLook,
  style: CaptionPresetStyle,
  text: PreviewText,
  scene: { width: number; height: number },
  measure: Measure,
  placement: { x?: number; y?: number; align?: CaptionAlign } = {},
): CaptionLayout {
  const align = placement.align ?? look.align;
  const boxX = placement.x ?? look.box.x ?? (scene.width - look.box.width) / 2;
  const boxY = placement.y ?? (align === CaptionAlign.TOP
    ? CAPTION_MARGIN
    : align === CaptionAlign.BOTTOM
      ? scene.height - look.box.height - CAPTION_MARGIN
      : (scene.height - look.box.height) / 2);

  const font = (line: number) => {
    const active = line === text.activeLine;
    const weight = look.accent === "line-weight" && active ? "500" : style.fontWeight;
    const size = look.accent === "line-color" && active ? Math.round(style.fontSize * 1.1) : style.fontSize;
    return `${weight} ${size}px "${style.fontFamily}", sans-serif`;
  };
  const lineHeight = style.fontSize * Math.max(1, style.leading) * 1.1;

  // Wrapped to the box: a line too wide for it continues on the next.
  // Each wrapped line remembers the line it came from and where in that
  // line's words it starts, so the accent still lands on the right words.
  const wrapped: { text: string; source: number; firstWord: number }[] = [];
  text.lines.forEach((line, source) => {
    let current = "";
    let firstWord = 0;
    applyTextCase(line, style.textCase).split(" ").forEach((word, index) => {
      const next = current ? `${current} ${word}` : word;
      if (current && measure(next, font(source)) > look.box.width) {
        wrapped.push({ text: current, source, firstWord });
        current = word;
        firstWord = index;
      } else current = next;
    });
    if (current) wrapped.push({ text: current, source, firstWord });
  });

  const height = wrapped.length * lineHeight;
  const top = style.textBaseline === TextBaseline.TOP
    ? boxY
    : boxY + (look.box.height - height) / 2;
  const left = look.box.x !== undefined;
  const lines = wrapped.map((line, i) => {
    const width = measure(line.text, font(line.source));
    return {
      text: line.text,
      source: line.source,
      firstWord: line.firstWord,
      width,
      x: left ? boxX : boxX + (look.box.width - width) / 2,
      y: top + i * lineHeight,
    };
  });
  const minX = Math.min(...lines.map(line => line.x));
  const maxX = Math.max(...lines.map(line => line.x + line.width));
  const block = lines.length
    ? { x: minX, y: top, width: maxX - minX, height }
    : { x: boxX, y: boxY, width: 0, height: 0 };
  return {
    font: (i: number) => font(wrapped[i]?.source ?? 0),
    block,
    lines,
    lineHeight,
    coverage: (block.width * block.height) / (scene.width * scene.height),
  };
}

const hex = (color: number) => `#${color.toString(16).padStart(6, "0")}`;

/**
 * Stand-ins for the shots captions most often fail on: a sunlit,
 * near-white one (a white shirt, a bright sky) and a night one.
 */
export function paintSampleBackdrop(ctx: CanvasRenderingContext2D, kind: "bright" | "dark", width: number, height: number): void {
  const sky = ctx.createLinearGradient(0, 0, 0, height);
  if (kind === "bright") {
    sky.addColorStop(0, "#fbfaf6");
    sky.addColorStop(0.55, "#f3efe4");
    sky.addColorStop(1, "#e9e3d3");
  } else {
    sky.addColorStop(0, "#0c1018");
    sky.addColorStop(0.6, "#151b26");
    sky.addColorStop(1, "#1d2533");
  }
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, width, height);
  // A figure's shoulders across the lower half, where captions sit.
  ctx.fillStyle = kind === "bright" ? "#ffffff" : "#232c3b";
  ctx.beginPath();
  ctx.ellipse(width / 2, height * 1.05, width * 0.42, height * 0.48, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = kind === "bright" ? "#f6e7c8" : "#3a3f4a";
  ctx.beginPath();
  ctx.ellipse(width / 2, height * 0.42, width * 0.08, height * 0.16, 0, 0, Math.PI * 2);
  ctx.fill();
}

export type SampleOptions = {
  look: CaptionPreviewLook;
  style: CaptionPresetStyle;
  layout: CaptionLayout;
  text: PreviewText;
  /** The caption's base fill (white unless the file recolors it). */
  fill: number;
  /** The preset's slot colors, filled. */
  colors: number[];
  /** Scene pixels to canvas pixels. */
  scale: number;
};

/** Paints a laid-out caption over whatever the canvas already holds. */
export function paintCaptionSample(ctx: CanvasRenderingContext2D, options: SampleOptions): void {
  const { look, layout, text, fill, colors, scale } = options;
  ctx.save();
  ctx.scale(scale, scale);
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  if (look.difference) ctx.globalCompositeOperation = "difference";
  if (look.shadow) {
    ctx.shadowColor = hex(look.shadow.color);
    ctx.shadowBlur = look.shadow.blur * scale;
    ctx.shadowOffsetY = look.shadow.offsetY * scale;
  }
  // The accent follows the line each wrapped line came from.
  layout.lines.forEach((line, i) => {
    ctx.font = layout.font(i);
    const lineColor = look.accent === "line-color" && line.source === text.activeLine ? colors[0] ?? fill : fill;
    if (text.activeWord && text.activeWord.line === line.source && look.accent === "word") {
      let x = line.x;
      line.text.split(" ").forEach((word, index) => {
        ctx.fillStyle = hex(line.firstWord + index === text.activeWord!.index ? colors[0] ?? fill : fill);
        ctx.fillText(word, x, line.y);
        x += ctx.measureText(`${word} `).width;
      });
    } else {
      ctx.fillStyle = hex(lineColor);
      ctx.fillText(line.text, line.x, line.y);
    }
  });
  ctx.restore();
}
