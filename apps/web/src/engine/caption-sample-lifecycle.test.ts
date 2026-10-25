import { describe, expect, it, vi } from 'vitest';

// Keep the real sampler queue and shutdown code, but hold decoder loading
// at a controlled async boundary. No canvas or media dependencies needed.
const state = vi.hoisted(() => ({
  events: [] as string[],
  init: Promise.resolve(),
}));
vi.mock('@diffusionstudio/runtime', () => ({
  CaptionDecoderHandle: 'decoder', Computed: 'computed', Offset: 'offset', Position: 'position',
  RenderSurface: 'surface', Size: 'size', TextCache: 'text', Library: 'library',
  createRuntimeWorld: () => ({ set() {}, destroy() { state.events.push('destroy'); } }),
  store: () => ({ width: [], height: [] }),
  bindAsset() {}, drawOnto() {},
  resolveCaptionDecoder: () => ({ initPromise: state.init }),
}));
vi.mock('@diffusionstudio/reconciler', () => ({
  createRuntimeDocument: () => ({
    stage: {},
    createElement: () => ({ entity: {
      id: () => 1,
      get: () => ({ dispose() { state.events.push('decoder disposed'); } }),
    } }),
    insertNode() {}, setProperty() {},
    removeNode() { state.events.push('removed'); },
    dispose() { state.events.push('document disposed'); },
  }),
}));

import { CaptionSampler } from './caption-sample';

describe('caption sampler shutdown', () => {
  it.each([false, true])('cancels queued work when initialization has started: %s', async started => {
    state.events = [];
    let finish!: () => void;
    state.init = new Promise<void>(resolve => { finish = resolve; });
    const sampler = new CaptionSampler();
    const request = { scene: { width: 640, height: 360 }, scale: 1, props: {},
      preset: 'whisper' as const, colors: false as const, transcript: [], seconds: 0 };
    const ctx = {} as CanvasRenderingContext2D;
    const first = sampler.draw(ctx, request);
    const queued = sampler.draw(ctx, request);
    if (started) await Promise.resolve();
    sampler.dispose();
    sampler.dispose();
    // Destruction must wait for a decoder still holding the world.
    expect(state.events).toEqual([]);
    finish();
    await expect(first).resolves.toEqual({ block: null });
    await expect(queued).resolves.toEqual({ block: null });
    await expect(sampler.draw(ctx, request)).resolves.toEqual({ block: null });
    expect(state.events).toEqual([
      ...(started ? ['decoder disposed', 'removed'] : []), 'document disposed', 'destroy',
    ]);
  });
});
