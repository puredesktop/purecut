/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The caption footage check's judgement: whether a caption's words stay
 * readable on a picture, and the stand-in pictures it is checked on. The
 * caption itself is laid out and painted by the runtime (`CaptionSampler`);
 * what is here is pure and needs no canvas but the backdrops.
 */

import type { Transcript } from "@diffusionstudio/assets";
import type { CaptionPreviewLook } from "./caption-types";

type Cue = Transcript[number];

/** What stands in for the transcript of a caption with no words yet. */
export const SAMPLE_CUE: Cue = {
  text: "Every caption should read clearly on this shot",
  words: "Every caption should read clearly on this shot".split(" ").map((text, i) => ({
    text, start: i * 0.35, end: i * 0.35 + 0.3,
  })),
};

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
 * with nothing beneath it (Stark with no fill of its own) draws each pixel's
 * inverse, which vanishes only on mid grey.
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

const WORST: Readability["verdict"][] = ["clear", "patchy", "lost"];

export type CaptionReadability = Readability & {
  /** Which paint reads worst: the caption's text, or the color marking the spoken words. */
  weakest: "text" | "highlight";
};

/**
 * Every paint a preset shows, judged on the same picture: the text as it
 * ends up on screen (see `captionTextPaint`) and each color its highlight can
 * take (Spotlight's one, all three of Guinea's, which it cycles through line
 * by line). The verdict is the worst of them, since a spoken word that
 * vanishes is lost even when the rest reads.
 */
export function assessCaptionPaints(
  pixels: ArrayLike<number>,
  paints: { text: number; highlights: number[] },
  look: Pick<CaptionPreviewLook, "shadow" | "difference">,
): CaptionReadability {
  let worst: CaptionReadability = { ...assessReadability(pixels, paints.text, look), weakest: "text" };
  for (const color of paints.highlights) {
    // Highlights are plain paints: only Stark blends, and it has none.
    const result = assessReadability(pixels, color, { shadow: look.shadow });
    if (WORST.indexOf(result.verdict) > WORST.indexOf(worst.verdict)
      || (result.verdict === worst.verdict && result.lost > worst.lost)) {
      worst = { ...result, weakest: "highlight" };
    }
  }
  return worst;
}

/** The colors a preset marks spoken words with, out of its slot colors. */
export function highlightColors(look: CaptionPreviewLook, colors: number[]): number[] {
  if (look.accent === "word") return colors.slice(0, 1);
  if (look.accent === "line-color") return colors;
  return [];
}

/** Past this share of the picture, a caption hides more than it helps. */
export const HEAVY_COVERAGE = 0.2;

/** The RGBA pixels of a rectangle of an image, row by row. */
export function cropPixels(
  image: { data: ArrayLike<number>; width: number },
  x: number, y: number, width: number, height: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let row = 0; row < height; row++) {
    for (let i = 0; i < width * 4; i++) out[row * width * 4 + i] = image.data[((y + row) * image.width + x) * 4 + i]!;
  }
  return out;
}

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
