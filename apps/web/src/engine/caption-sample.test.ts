import { afterAll, describe, expect, it, vi } from 'vitest';

// Node has no canvas. The stand-in measures text from its font size alone
// (each character half the size wide; a font box of 0.8 / 0.2 of the size)
// and records every glyph run drawn, with the paint and blend it was drawn
// in. That is enough to follow the runtime's own layout and paint order,
// which is what the sampler is for; real glyph shapes are the browser check's.
vi.hoisted(() => {
  const scope = globalThis as Record<string, unknown>;
  scope.DOMMatrix ??= class {
    a = 1; b = 0; c = 0; d = 1; e = 0; f = 0;
    multiply() { return this; } inverse() { return this; } translate() { return this; } scale() { return this; }
  };
  for (const name of ['HTMLCanvasElement', 'HTMLElement', 'Element', 'Node', 'Text', 'HTMLImageElement', 'HTMLVideoElement'])
    scope[name] ??= class {};

  class RecordingContext {
    font = '10px sans-serif';
    textBaseline = 'top';
    textAlign = 'start';
    letterSpacing = '0px';
    fillStyle: unknown = '#000000';
    strokeStyle: unknown = '#000000';
    globalAlpha = 1;
    globalCompositeOperation = 'source-over';
    shadowColor = 'transparent';
    shadowBlur = 0;
    shadowOffsetX = 0;
    shadowOffsetY = 0;
    lineWidth = 1;
    runs: { chars: string; x: number; y: number; fill: string; blend: string; font: string; shadow: boolean }[] = [];
    private stack: Record<string, unknown>[] = [];
    private size() { return Number(/(\d+(?:\.\d+)?)px/.exec(this.font)?.[1] ?? 10); }
    measureText(chars: string) {
      const size = this.size();
      const width = chars.length * size * 0.5;
      return {
        width,
        actualBoundingBoxLeft: 0, actualBoundingBoxRight: width,
        actualBoundingBoxAscent: 0, actualBoundingBoxDescent: size,
        fontBoundingBoxAscent: size * 0.8, fontBoundingBoxDescent: size * 0.2,
      };
    }
    fillText(chars: string, x: number, y: number) {
      this.runs.push({
        chars, x, y, fill: String(this.fillStyle).toLowerCase(), blend: this.globalCompositeOperation, font: this.font,
        shadow: this.shadowColor !== 'transparent' && this.shadowBlur > 0,
      });
    }
    strokeText() {}
    save() {
      this.stack.push({ fillStyle: this.fillStyle, globalCompositeOperation: this.globalCompositeOperation, shadowColor: this.shadowColor, shadowBlur: this.shadowBlur, font: this.font, globalAlpha: this.globalAlpha });
    }
    restore() { Object.assign(this, this.stack.pop() ?? {}); }
    scale() {} translate() {} setTransform() {} resetTransform() {}
    createLinearGradient() { return { addColorStop() {} }; }
    createRadialGradient() { return { addColorStop() {} }; }
  }
  scope.RecordingContext = RecordingContext;
  scope.OffscreenCanvas ??= class { width: number; height: number; constructor(w: number, h: number) { this.width = w; this.height = h; } getContext() { return new RecordingContext(); } };
});

import { createRuntimeWorld, drawOnto, Library, resolveCaptionDecoder, bindAsset } from '@diffusionstudio/runtime';
import { createRuntimeDocument } from '@diffusionstudio/reconciler';
import { CaptionSampler } from './caption-sample';
import { CAPTION_PRESET_OPTIONS, captionTextPaint } from '../components/sidebar-right/inspector/caption-types';
import { assessCaptionPaints } from '../components/sidebar-right/inspector/caption-preview';

import type { Asset, AssetLibrary, Transcript } from '@diffusionstudio/assets';
import type { CaptionPreset } from '@diffusionstudio/jsx';

type Run = { chars: string; x: number; y: number; fill: string; blend: string; font: string; shadow: boolean };
type Recording = CanvasRenderingContext2D & { runs: Run[] };
const recorder = () => new (globalThis as unknown as { RecordingContext: new () => Recording }).RecordingContext();

const words = (text: string, start: number, each: number) =>
  text.split(' ').map((word, i) => ({ text: word, start: start + i * each, end: start + (i + 1) * each - 0.02 }));
const cue = (text: string, start: number, each: number) => ({ text, words: words(text, start, each) });

const scene = { width: 1920, height: 1080 };
const sampler = new CaptionSampler();
afterAll(() => sampler.dispose());

async function draw(preset: CaptionPreset, transcript: Transcript, seconds: number, props: Record<string, unknown> = {}, colors: string[] | false = false) {
  const ctx = recorder();
  const sample = await sampler.draw(ctx, { scene, scale: 1, props, preset, colors, transcript, seconds });
  return { ...sample, runs: ctx.runs.filter(run => run.chars.trim()) };
}

describe('caption previews drawn by the runtime', () => {
  it('measures a single line by its font box, whatever its leading', async () => {
    const line = [cue('Plain words here', 1, 0.3)];
    const plain = await draw('whisper', line, 1.1);
    const loose = await draw('whisper', line, 1.1, { leading: 3 });
    expect(plain.block).not.toBeNull();
    // Leading spaces lines apart; one line has nothing to space.
    expect(loose.block).toEqual(plain.block);
  });

  it('lays out Guinea\'s two lines with the larger active line, leading only between them', async () => {
    const group = [cue('alpha beta gamma delta', 2, 0.4)];
    const { runs, block } = await draw('guinea', group, 2.1);
    const sizes = [...new Set(runs.map(run => Number(/(\d+)px/.exec(run.font)![1])))].sort((a, b) => a - b);
    // Guinea's 62px text, and its active line at 1.1 times that.
    expect(sizes).toEqual([62, 68]);
    const ys = [...new Set(runs.map(run => run.y))].sort((a, b) => a - b);
    expect(ys).toHaveLength(2);
    expect(block!.height).toBeGreaterThan(62);
    // The same caption with double leading moves its second line, not its first's height.
    const spaced = await draw('guinea', group, 2.1, { leading: 2 });
    expect(spaced.block!.height).toBeGreaterThan(block!.height);
  });

  it('paints Stark\'s own fill first and its white difference paint over it', async () => {
    const line = [cue('LOUD WORDS', 0, 0.5)];
    const own = await draw('stark', line, 0.1, { fill: '#ffffff' });
    const first = own.runs.find(run => run.chars.startsWith('LOUD'))!;
    const passes = own.runs.filter(run => run.chars === first.chars);
    expect(passes.map(run => [run.fill, run.blend])).toEqual([['#ffffff', 'source-over'], ['#ffffff', 'difference']]);
    // White under white difference is black glyphs: lost on a night shot, clear on a white one.
    const stark = CAPTION_PRESET_OPTIONS.find(option => option.name === 'stark')!;
    const paint = captionTextPaint(stark, { fill: '#ffffff' });
    expect(paint).toEqual({ text: 0x000000, difference: false });
    const night = new Uint8ClampedArray(64 * 4).map((_, i) => (i % 4 === 3 ? 255 : 20));
    const day = new Uint8ClampedArray(64 * 4).fill(250);
    expect(assessCaptionPaints(night, { text: paint.text, highlights: [] }, { difference: paint.difference }).verdict).toBe('lost');
    expect(assessCaptionPaints(day, { text: paint.text, highlights: [] }, { difference: paint.difference }).verdict).toBe('clear');
    // A colored fill comes out as that color inverted.
    expect(captionTextPaint(stark, { fill: '#ff0000' })).toEqual({ text: 0x00ffff, difference: false });
    // With no fill of its own, Stark inverts the picture.
    const bare = await draw('stark', line, 0.1);
    expect(bare.runs.filter(run => run.chars === first.chars).map(run => run.blend)).toEqual(['difference']);
    expect(captionTextPaint(stark, {})).toEqual({ text: 0xffffff, difference: true });
  });

  it('shows the Guinea color playback would show at that moment', async () => {
    const slots = ['#ff0000', '#00ff00', '#0000ff'];
    const transcript = [
      cue('one two three four five six.', 0, 0.3),
      cue('seven eight nine ten eleven twelve.', 2, 0.3),
      cue('thirteen fourteen fifteen sixteen.', 4, 0.3),
    ];
    // Playback: a decoder in a world of its own, seeked frame by frame from the start.
    const world = createRuntimeWorld(`guinea-playback-${Math.random()}`);
    const asset = { id: 'playback', type: 'VIDEO', transcript } as unknown as Asset;
    world.set(Library, { get: () => asset } as unknown as AssetLibrary);
    const document = createRuntimeDocument(world);
    const seen = new Set<string>();
    try {
      const sceneNode = document.createElement('Scene'); document.insertNode(document.stage, sceneNode);
      const clip = document.createElement('Captions');
      document.setProperty(clip, 'preset', 'guinea');
      document.setProperty(clip, 'colors', slots);
      document.insertNode(sceneNode, clip);
      bindAsset(clip.entity, asset);
      const decoder = resolveCaptionDecoder(world, clip.entity)!;
      await decoder.initPromise;
      // One forward pass, frame by frame, as playback runs; at each moment,
      // what playback shows against what a preview of that moment shows.
      let t = 0;
      for (const moment of [0.1, 1.0, 2.1, 3.0, 4.1, 4.9]) {
        for (; t <= moment; t += 1 / 30) decoder.seekTo(world, clip.entity, t);
        decoder.seekTo(world, clip.entity, moment);
        const playback = recorder();
        drawOnto(playback, () => decoder.draw(world, clip.entity));
        const expected = playback.runs.find(run => slots.includes(run.fill))?.fill;
        const preview = await draw('guinea', transcript, moment, {}, slots);
        const shown = preview.runs.find(run => slots.includes(run.fill))?.fill;
        expect(shown, `at ${moment}s`).toBe(expected);
        if (shown) seen.add(shown);
      }
    } finally { document.dispose(); world.destroy(); }
    // Over these moments the preview shows more than the first slot.
    expect(seen.size).toBeGreaterThan(1);
  });

  it('reveals Cascade word by word, as its decoder does', async () => {
    const group = [cue('one two three four five', 4, 0.5)];
    const early = await draw('cascade', group, 4.1);
    const late = await draw('cascade', group, 6.4);
    expect(early.runs.map(run => run.chars.trim()).join(' ')).toBe('one');
    expect(late.runs.map(run => run.chars.trim()).join(' ')).toBe('one two three four five');
    expect(late.block!.width).toBeGreaterThan(early.block!.width);
  });

  it('keeps the caption\'s own size, so coverage follows it', async () => {
    const line = [cue('Plain words here', 1, 0.3)];
    const plain = await draw('whisper', line, 1.1);
    const large = await draw('whisper', line, 1.1, { fontSize: 120 });
    const area = (b: { width: number; height: number }) => b.width * b.height;
    expect(area(large.block!)).toBeGreaterThan(area(plain.block!) * 4);
  });
});
