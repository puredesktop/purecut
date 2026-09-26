import { createRuntimeWorld, Computed, Geometry, Name, Scene, Source, Selected, getEntityTree, getSourceFrameAt, setPlayhead, playbackSystem } from '../packages/runtime/src';
import { createRuntimeDocument } from '../packages/reconciler/src';
import { splitAtPlayhead } from '../apps/web/src/engine/split';
import { getEditHistory } from '../apps/web/src/engine/history';
import { renderScene, renderOverlay, cancelRender } from '../apps/web/src/context/render';
import { rememberProjectBundle, forgetProjectBundle } from '../apps/web/src/lib/db';
import type { Engine } from '../apps/web/src/engine';
import { createRoot, createEffect } from 'solid-js';
import { rippleDeleteSelection } from '../apps/web/src/engine/ripple-delete';

export async function checkTimeline() {
  await checkRipple(false);
  await checkRipple(true);
  const video = await checkSplit(false);
  await checkSplit(true);
  return video;
}

async function checkRipple(overlap: boolean) {
  const world = createRuntimeWorld('ripple-regression');
  const document = createRuntimeDocument(world);
  const check = (value: unknown, message: string) => { if (!value) throw Error(message); };
  try {
    document.setProperty(document.stage, '__source', 'ripple-stage');
    const scene = document.createElement('Scene');
    document.setProperty(scene, '__source', 'ripple-scene');
    document.setProperty(scene, 'active', true);
    document.insertNode(document.stage, scene);
    const sequence = document.createElement('Sequence');
    document.setProperty(sequence, '__source', 'ripple-sequence');
    document.insertNode(scene, sequence);
    for (const [id, start, end, selected] of [
      ['head', 0, 1, false], ['removed', 1, 3, true],
      ['removed-overlap', 1.5, 2.5, true],
      ['tail', 4, 6, false], ['removed-later', 6, 7, true], ['last', 7, 8, false],
      ...(overlap ? [['overlay', 2, 3, false]] : []),
    ] as [string, number, number, boolean][]) {
      const clip = document.createElement('Rect');
      document.setProperty(clip, '__source', id);
      document.setProperty(clip, 'name', id);
      document.setProperty(clip, 'start', start);
      document.setProperty(clip, 'end', end);
      document.setProperty(clip, 'sourceIn', 2);
      document.insertNode(id === 'overlay' ? scene : sequence, clip);
      if (selected) clip.entity.add(Selected);
    }
    const history = getEditHistory(world);
    const spans = () => Object.fromEntries(world.query(Geometry, Source).filter(e => !e.has(Scene)).map(e => {
      const time = e.get(Computed)!;
      return [e.get(Name)!.value, [time.start, time.end]];
    }));
    const before = JSON.stringify(spans());
    rippleDeleteSelection(world);
    const after = spans();
    check(!after.removed && !after['removed-later'] && !after['removed-overlap'], 'ripple removes every selected clip without double-counting overlapping selections');
    check(JSON.stringify(after.tail) === (overlap ? '[90,150]' : '[60,120]'), 'ripple closes only empty removed time, retaining existing gaps');
    check(JSON.stringify(after.last) === (overlap ? '[150,180]' : '[120,150]'), 'ripple accumulates disjoint removed ranges');
    if (overlap) check(JSON.stringify(after.overlay) === '[30,60]', 'ripple preserves overlapping content and shifts it in sync');
    const tail = world.query(Source).find(e => e.get(Source)?.value === 'tail')!;
    check(getSourceFrameAt(tail, tail.get(Computed)!.start) === 60, 'ripple preserves source offset');
    const expected = JSON.stringify(after);
    await Promise.resolve();
    history.undo();
    const restored = spans();
    check(Object.entries(JSON.parse(before)).every(([id, span]) => JSON.stringify(restored[id]) === JSON.stringify(span)), `one undo restores removed clips and original timing: ${before} -> ${JSON.stringify(restored)}`);
    history.redo();
    const redone = spans();
    check(Object.entries(JSON.parse(expected)).every(([id, span]) => JSON.stringify(redone[id]) === JSON.stringify(span)) && !redone.removed && !redone['removed-later'], 'redo restores ripple deletion and all shifts');
  } finally { document.dispose(); world.destroy(); }
}

async function checkSplit(multipleTracks: boolean) {
  let renderedBytes: Uint8Array | undefined;
  const world = createRuntimeWorld('timeline-regression');
  const document = createRuntimeDocument(world);
  const check = (value: unknown, message: string) => { if (!value) throw Error(message); };
  try {
    document.setProperty(document.stage, '__source', 'test-stage');
    const scene = document.createElement('Scene');
    document.setProperty(scene, '__source', 'test-scene');
    document.setProperty(scene, 'active', true);
    document.insertNode(document.stage, scene);
    const clip = document.createElement('Rect');
    document.setProperty(clip, '__source', 'test-clip');
    document.setProperty(clip, 'end', 6);
    document.insertNode(scene, clip);
    if (multipleTracks) {
      const overlay = document.createElement('Rect');
      document.setProperty(overlay, '__source', 'test-overlay');
      document.setProperty(overlay, 'start', 1);
      document.setProperty(overlay, 'end', 5);
      document.setProperty(overlay, 'sourceIn', 2);
      document.insertNode(scene, overlay);
    }
    const active = world.query(Scene)[0]!;
    const history = getEditHistory(world);
    setPlayhead(world, active, 90);
    playbackSystem(world);
    const tails = splitAtPlayhead(world);
    check(tails.length === (multipleTracks ? 2 : 1), 'split creates one tail per intersected track');
    check(JSON.stringify(tails.map(tail => getSourceFrameAt(tail, 90)).sort((a, b) => a - b)) ===
      (multipleTracks ? '[90,120]' : '[90]'), 'split tails retain source frame offsets');
    const clips = () => getEntityTree(world, active).filter(e => e.has(Geometry) && !e.has(Scene));
    const spans = () => clips().map(e => { const c = e.get(Computed)!; return [c.start, c.end]; }).sort((a, b) => a[0]! - b[0]!);
    const splitSpans = multipleTracks ? '[[0,90],[30,90],[90,150],[90,180]]' : '[[0,90],[90,180]]';
    const wholeSpans = multipleTracks ? '[[0,180],[30,150]]' : '[[0,180]]';
    check(JSON.stringify(spans().sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]!)) === splitSpans, 'split preserves adjacent frame ranges on every track');
    await Promise.resolve();
    check(history.canUndo(), 'split records undo');
    history.undo();
    check(JSON.stringify(spans()) === wholeSpans, 'one undo restores all original clips');
    history.redo();
    check(JSON.stringify(spans().sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]!)) === splitSpans, 'redo restores all split halves');
    setPlayhead(world, active, 180);
    playbackSystem(world);
    check(splitAtPlayhead(world).length === 0, 'boundary split does not create empty clips');
    check(clips().every(e => !!e.get(Source)?.value), 'split retains source identities');
    let stopped = 0, restarted = 0;
    const engine = { world, stop: () => stopped++, start: () => restarted++ } as unknown as Engine;
    // No bundle is stored for this fixture: preparation must fail cleanly,
    // and a simultaneous request must not take ownership of its overlay.
    const options = { scene: active, target: {} as FileSystemFileHandle };
    const first = renderScene(engine, options).then(() => '', error => String(error));
    const second = await renderScene(engine, options).then(() => '', error => String(error));
    check(second.includes('already running'), 'parallel exports are rejected');
    check((await first).includes('no project to render'), 'preparation failure is reported');
    check(!renderOverlay() && stopped === 1 && restarted === 1, 'failed preparation clears progress and resumes preview exactly once');
    const fixtureBundle = `
      const { Stage, Scene, Rect } = require('@diffusionstudio/jsx');
      module.exports.default = () => Stage({ __source: 'test-stage', get children() {
        return Scene({ __source: 'test-scene', width: 320, height: 180, get children() {
          return Rect({ __source: 'test-clip', width: 320, height: 180, end: 1, fill: '#ff0000' });
        }});
      }});
    `;
    await rememberProjectBundle('timeline-regression', fixtureBundle);
    const canvasesBefore = globalThis.document.querySelectorAll('canvas').length;
    let writes = 0;
    const cancelTarget = { createWritable: async () => { writes++; throw Error('Cancelled export must not open an output'); } } as unknown as FileSystemFileHandle;
    const pending = renderScene(engine, { scene: active, target: cancelTarget });
    cancelRender();
    check((await pending).type === 'canceled', 'cancel during preparation returns cancelled result');
    check(writes === 0 && !renderOverlay() && restarted === 2, 'cancelled preparation writes no output and resumes preview');
    check(globalThis.document.querySelectorAll('canvas').length === canvasesBefore, 'cancelled preparation disposes capture canvas');
    if (!multipleTracks) {
      await rememberProjectBundle('timeline-regression', fixtureBundle.replace('end: 1,', 'end: 60,'));
      let cancelledWhileEncoding = false;
      const disposeCancellation = createRoot(dispose => {
        createEffect(() => {
          const progress = renderOverlay()?.progress ?? 0;
          if (progress > 0 && progress < 100 && !cancelledWhileEncoding) {
            cancelledWhileEncoding = true;
            cancelRender();
          }
        });
        return dispose;
      });
      try {
        const cancelled = await renderScene(engine, { scene: active,
          target: { createWritable: async () => new WritableStream({ write() {} }) },
          config: { format: 'webm', video: { codec: 'vp8', resolution: 180, fps: 30, bitrate: 500_000 }, audio: { enabled: false } } });
        check(cancelledWhileEncoding && cancelled.type === 'canceled', 'cancel during encoding does not report success');
        check(!renderOverlay() && restarted === 3, 'encoding cancellation clears progress and restarts preview');
        check(globalThis.document.querySelectorAll('canvas').length === canvasesBefore, 'encoding cancellation releases capture canvas');
      } finally {
        disposeCancellation();
        await rememberProjectBundle('timeline-regression', fixtureBundle);
      }
      const chunks: { position: number; data: Uint8Array }[] = [];
      const target = { createWritable: async () => new WritableStream({
        write(chunk: { position: number; data: Uint8Array }) {
          chunks.push({ position: chunk.position, data: chunk.data.slice() });
        },
      }) };
      const result = await renderScene(engine, { scene: active, target,
        config: { format: 'webm', video: { codec: 'vp8', resolution: 180, fps: 30, bitrate: 500_000 }, audio: { enabled: false } } });
      check(result.type === 'success', `fixture export succeeds: ${JSON.stringify(result)}`);
      const bytes = new Uint8Array(Math.max(...chunks.map(chunk => chunk.position + chunk.data.length)));
      for (const chunk of chunks) bytes.set(chunk.data, chunk.position);
      check(bytes.length > 100, 'export produces video bytes');
      renderedBytes = bytes;
      const url = URL.createObjectURL(new Blob([bytes], { type: 'video/webm' }));
      const video = globalThis.document.createElement('video');
      video.muted = true;
      globalThis.document.body.append(video);
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(Error('Export playback timed out')), 10_000);
          video.onloadeddata = () => { clearTimeout(timer); resolve(); };
          video.onerror = () => { clearTimeout(timer); reject(Error('Export video failed to decode')); };
          video.src = url;
          video.load();
        });
        check(video.videoWidth === 320 && video.videoHeight === 180, 'export preserves aspect ratio and requested resolution');
        check(Math.abs(video.duration - 1) < 0.1, 'export duration matches source');
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(Error('Export frame presentation timed out')), 10_000);
          video.requestVideoFrameCallback(() => { clearTimeout(timer); video.pause(); resolve(); });
          void video.play().catch(error => { clearTimeout(timer); reject(error); });
        });
        const canvas = globalThis.document.createElement('canvas');
        canvas.width = 320; canvas.height = 180;
        const context = canvas.getContext('2d')!;
        context.drawImage(video, 0, 0);
        const pixel = context.getImageData(50, 50, 1, 1).data;
        check(pixel[0]! > 200 && pixel[1]! < 50 && pixel[2]! < 50, `decoded export contains the red fixture: ${Array.from(pixel)}`);
      } finally {
        video.removeAttribute('src'); video.load(); video.remove(); URL.revokeObjectURL(url);
      }
    }
  } finally {
    await forgetProjectBundle('timeline-regression');
    document.dispose();
    world.destroy();
  }
  return renderedBytes;
}
