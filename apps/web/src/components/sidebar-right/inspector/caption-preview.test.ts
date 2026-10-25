import { describe, expect, it } from 'vitest';
import { assessCaptionPaints, captionCoverage, cropPixels } from './caption-preview';

describe('background under captions at the frame edge', () => {
  // White in the top-left quarter, black elsewhere. White caption text
  // clipped into that quarter must be judged only against the white shirt.
  const image = { width: 8, data: new Uint8ClampedArray(8 * 8 * 4) };
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const i = (y * 8 + x) * 4;
    image.data.fill(x < 4 && y < 4 ? 255 : 0, i, i + 3);
    image.data[i + 3] = 255;
  }

  it('intersects negative offsets with the frame instead of shifting the sampled box', () => {
    const pixels = cropPixels(image, -4, -4, 8, 8);
    expect(pixels).toHaveLength(4 * 4 * 4);
    expect(assessCaptionPaints(pixels, { text: 0xffffff, highlights: [] }, {}).verdict).toBe('lost');
    expect([...pixels]).toEqual(new Array(4 * 4 * 4).fill(255));
  });

  it('clips the right and bottom edges without reading the next row or adding black pixels', () => {
    const white = { width: 8, data: new Uint8ClampedArray(8 * 8 * 4).fill(255) };
    expect([...cropPixels(white, 6, 6, 4, 4)]).toEqual(new Array(2 * 2 * 4).fill(255));
  });

  it('returns no pixels for captions outside any edge', () => {
    for (const [x, y] of [[-5, 0], [0, -5], [8, 0], [0, 8]])
      expect(cropPixels(image, x!, y!, 4, 4)).toHaveLength(0);
  });

  it('counts only the part of the caption covering the picture', () => {
    const scene = { width: 8, height: 8 };
    expect(captionCoverage({ x: -4, y: -4, width: 8, height: 8 }, scene)).toBe(0.25);
    expect(captionCoverage({ x: 6, y: 6, width: 4, height: 4 }, scene)).toBe(0.0625);
    expect(captionCoverage({ x: 8, y: 0, width: 4, height: 4 }, scene)).toBe(0);
    expect(captionCoverage({ x: 0, y: 0, width: 8, height: 8 }, scene)).toBe(1);
  });
});
