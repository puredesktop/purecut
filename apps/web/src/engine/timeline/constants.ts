/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { secondsToFrames } from "@diffusionstudio/runtime";

export const RULER_INTERVALS = [
  {
    numerator: secondsToFrames(600),
    denominator: 10,
  },
  {
    numerator: secondsToFrames(300),
    denominator: 5,
  },
  {
    numerator: secondsToFrames(120),
    denominator: 4,
  },
  {
    numerator: secondsToFrames(60),
    denominator: 6,
  },
  {
    numerator: secondsToFrames(30),
    denominator: 10,
  },
  {
    numerator: secondsToFrames(10),
    denominator: 10,
  },
  {
    numerator: secondsToFrames(5),
    denominator: 10,
  },
  {
    numerator: secondsToFrames(3),
    denominator: 10,
  },
  {
    numerator: secondsToFrames(2),
    denominator: 10,
  },
  {
    numerator: secondsToFrames(1),
    denominator: 10,
  },
  {
    numerator: 15,
    denominator: 5,
  },
  {
    numerator: 10,
    denominator: 10,
  },
  {
    numerator: 5,
    denominator: 5,
  },
];

// window.getComputedStyle(document.body).getPropertyValue('--background')

export const COLORS = {
  background: {
    default: '#1C1C1C',
    muted: '#292929',
    accent: '#292929',
  },
  border: {
    darker: '#1C1C1C',
    input: '#3E3F41',
    ring: '#008CFF',
    scrubber: '#F43535', // ambient red
  },
  ruler: {
    tick: 'rgba(53, 53, 53, 1)',
    text: 'rgba(75, 75, 75, 1)',
  },
  clip: {
    group: {
      background: '#40464F',
      primary: '#545D67',
      foreground: '#EDF0F3',
    },
    video: {
      background: '#0F3C8A',
      primary: '#70A7FF', // Waveform
      foreground: '#CCE0FF', // Label
    },
    audio: {
      background: '#004732',
      primary: '#0DBF8A',
      foreground: '#CBFAED',
    },
    caption: {
      background: '#7B1E5A',
      primary: '#AA317B', // Word background
      foreground: '#F9DCED',
    },
    image: {
      background: '#A55912',
      foreground: '#F9F2EC',
    },
    text: {
      background: '#303E4F',
      foreground: '#E7EFF9',
    },
    shape: {
      background: '#933325',
      foreground: '#FAEDEB',
    },
    scene: {
      background: '#066284',
      primary: '#5AB9DD',
      foreground: '#DBEAF0',
    },
    mask: {
      background: '#5455DE',
      foreground: '#EAE8FC',
    },
    adjustment: {
      background: '#4827B0',
      foreground: '#E7DFFB',
    },
    html: {
      background: '#2B525F',
      foreground: '#E7F4F9',
    },
    failed: {
      background: '#2E1D1D',
      foreground: '#FF8A8A',
    },
  },
} as const;

export type ClipPalette = {
  background: string;
  foreground: string;
  primary?: string;
};

/** One complete set of timeline colours: the dark one below, or the light one. */
export type TimelinePalette = {
  background: { default: string; muted: string; accent: string };
  border: { darker: string; input: string; ring: string; scrubber: string };
  ruler: { tick: string; text: string };
  clip: Record<keyof (typeof COLORS)['clip'], ClipPalette> & {
    /** The renderer fills child blocks with this, so it is never absent. */
    group: ClipPalette & { primary: string };
  };
};

/**
 * The light palette: the timeline on paper rather than on a dark slab.
 *
 * PureCut sits in a light desktop, so the dark constants below (upstream's
 * own, kept for the dark theme) turned the timeline into a black rectangle in
 * the middle of a pale window. Clip colours keep their meaning — blue for
 * video and scenes, green for sound, violet for text — at a lightness that
 * reads against paper, with the label dark rather than pale.
 */
export const LIGHT_COLORS: TimelinePalette = {
  background: {
    default: '#ffffff',
    muted: '#f4f6f8',
    accent: '#eef2f6',
  },
  border: {
    darker: 'rgba(16, 22, 42, 0.10)',
    input: 'rgba(16, 22, 42, 0.20)',
    ring: '#1f6f8b',
    scrubber: '#c2412d',
  },
  ruler: {
    tick: 'rgba(16, 22, 42, 0.18)',
    text: 'rgba(16, 22, 42, 0.45)',
  },
  clip: {
    group: { background: '#dfe4ea', primary: '#b9c2cc', foreground: '#1c2430' },
    video: { background: '#a8d2e4', primary: '#4c8aa8', foreground: '#0d2230' },
    audio: { background: '#c5dcb6', primary: '#5f8f42', foreground: '#22321a' },
    caption: { background: '#f0cfe2', primary: '#c77fa8', foreground: '#4a1536' },
    image: { background: '#f0d9bd', foreground: '#3a2a16' },
    text: { background: '#d8cbea', foreground: '#2c2140' },
    shape: { background: '#f3cfc8', foreground: '#4a1c14' },
    scene: { background: '#bfe0ee', primary: '#4c8aa8', foreground: '#0d2230' },
    mask: { background: '#d5d5f5', foreground: '#20205a' },
    adjustment: { background: '#ddd2f5', foreground: '#2a1b55' },
    html: { background: '#cfe3ea', foreground: '#123038' },
    failed: { background: '#f7dcd8', foreground: '#8c2a1a' },
  },
};

/** The palette for the desktop's current light or dark setting. */
export function timelineColors(dark: boolean): TimelinePalette {
  return dark ? COLORS : LIGHT_COLORS;
}

/**
 * The palette every draw reads. The surface carries it too, but the clip
 * styles are resolved from entity kind alone, far from the surface, so the
 * choice lives here as well and both stay in step.
 */
let active: TimelinePalette = LIGHT_COLORS;

export function activeTimelineColors(): TimelinePalette {
  return active;
}

export function setActiveTimelineColors(palette: TimelinePalette): void {
  active = palette;
}
