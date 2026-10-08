import {
  AssetLibrary, MASK_FIELD_MAX, MASK_MIME_TYPE, MaskFile, deriveThumbnail, detectMimeType, isMaskFileHead,
  probeMedia, type MaskAsset, type MaskFrame, type ProjectFS,
} from '@diffusionstudio/assets';
import { sam2Model } from '@diffusionstudio/sam2/models';
import { ALL_FORMATS, BlobSource, CanvasSink, Input } from 'mediabunny';
import { createRuntimeDocument, mount } from '../packages/reconciler/src';
import {
  AssetId, Cache, Effect, EffectType, IsClipPath, Library, Locked, Mask, Mode, RenderSurface, Root, Source,
  assetSystem, createRuntimeWorld, disposeDecoders, motionSystem, playbackSystem, renderSystem, resetCamera,
  setPlayhead, transformSystem,
} from '../packages/runtime/src';
import { rememberProjectBundle, forgetProjectBundle } from '../apps/web/src/lib/db';
import { renderScene } from '../apps/web/src/context/render';
import { getDocumentEditor } from '../apps/web/src/engine/editor';
import { commitObjectMask, encodeObjectMask, nextTrackingName, objectMaskFolder } from '../apps/web/src/engine/object-mask/commit';
import { getObjectTrack, objectMaskModelLoad, setObjectMaskModel } from '../apps/web/src/engine/object-mask/store';
import { promptObjectMask } from '../apps/web/src/engine/object-mask/tracking';
import type { Engine } from '../apps/web/src/engine';
import type { ObjectTrack } from '../apps/web/src/engine/object-mask/store';
import type { Entity } from 'koota';

/**
 * Object masks and clip paths (upstream diffusionstudio/editor e63f1c7…
 * 5c685e1, a6e27ef). No model runs here: the segmentation step is replaced
 * by a tiny hand-made mask file, which is what the tool would have written.
 *
 * - The mask file: encoded, sniffed, probed and read back frame by frame; the
 *   library takes it as a MASK asset under the tool's folder and names the
 *   next one; it gets a thumbnail.
 * - The compiler: `<mask>` under `<effect>` is the composition element, and
 *   an SVG `<mask>` inside an html paint stays SVG.
 * - Rendering: a red clip cut out by the mask over a blue scene, the mask
 *   moving left to right, then a green clip under a `<rect clipPath>`. The
 *   preview (realtime) and the export (encoded, decoded again) show the same
 *   pixels on every frame, and `<rect mask>` still reads as a clip path.
 * - The tool's commit (see `checkCommit`), and its download gate.
 */
export async function checkObjectMasks() {
  // The compiler the app runs, bundled by the dev server's start (scripts/build-compiler.mjs).
  const { compile } = await import('../purecut/compiler-runtime.js') as { compile(source: string): { ok: boolean; code?: string; error?: string } };
  const check = (value: unknown, message: string) => { if (!value) throw Error(message); };
  const W = 320, H = 180, GRID = 8;

  // ── The mask file ─────────────────────────────────────────
  const half = (left: boolean, grid = GRID): MaskFrame => ({
    field: Int8Array.from({ length: grid * grid }, (_, i) => ((i % grid < grid / 2) === left ? MASK_FIELD_MAX : -MASK_FIELD_MAX)),
    score: 1, iou: 0.9,
  });
  const frames = [half(true), half(false), null];
  const recipe = { model: 'fixture', source: 'video-id', first: 0, seedFrame: 0, points: [{ x: 0.25, y: 0.5, label: 1 as const }] };
  const blob = encodeObjectMask({ width: W, height: H }, 30, GRID, frames, recipe);
  check(blob.type === MASK_MIME_TYPE, 'A mask file has its own type');
  check(isMaskFileHead(new Uint8Array(await blob.slice(0, 4).arrayBuffer())), 'A mask file starts with its magic');
  check(await detectMimeType(new File([blob], 'Tracking 1.mask')) === MASK_MIME_TYPE, 'A mask file is sniffed by its magic');
  const probed = await probeMedia(blob, MASK_MIME_TYPE);
  check(probed.type === 'MASK' && probed.width === W && probed.height === H && Math.abs(probed.duration - 0.1) < 1e-9 && probed.recipe?.model === 'fixture',
    `A mask file probes as a MASK asset: ${JSON.stringify(probed)}`);
  const file = await MaskFile.read(blob);
  check(file.frameCount === 3 && file.has(0) && file.has(1) && !file.has(2), 'Tracked and untracked frames survive the round trip');
  const field = new Int8Array(GRID * GRID);
  check(file.field(1, field) && field.every((value, i) => value === frames[1]!.field[i]), 'A frame decodes to the field it was written from');
  check(Math.abs(file.iou(0) - 0.9) < 1e-6, 'A frame keeps its quality estimate');

  const files = new Map<string, File>();
  const fs: ProjectFS = {
    readManifest: async () => null, writeManifest: async () => {}, list: async () => [],
    stat: async path => { const file = files.get(path); return file ? { size: file.size, mtime: file.lastModified } : null; },
    file: async path => { const file = files.get(path); if (!file) throw Error(`Missing fixture ${path}`); return file; },
    write: async (path, data) => { files.set(path, new File([data], path.split('/').pop()!)); },
    remove: async path => { files.delete(path); },
  };
  const library = new AssetLibrary(fs);
  const folder = objectMaskFolder({ path: 'clip.mp4', name: 'clip.mp4' } as never);
  check(folder === 'masks/clip', `Masks of a video go in its folder: ${folder}`);
  check(nextTrackingName(library, folder) === 'Tracking 1.mask', 'The first mask of a video is Tracking 1');
  const asset = await library.store(blob, { folder, name: 'Tracking 1.mask' }) as MaskAsset;
  check(asset.type === 'MASK' && asset.path === 'masks/clip/Tracking 1.mask' && asset.frameRate === 30 && asset.recipe?.source === 'video-id',
    `The library takes a mask file as a MASK asset: ${JSON.stringify({ type: asset.type, path: asset.path })}`);
  check(nextTrackingName(library, folder) === 'Tracking 2.mask', 'The next mask of the video is Tracking 2');
  const thumbnail = await deriveThumbnail(blob, MASK_MIME_TYPE, 64);
  check(thumbnail && thumbnail.size > 0 && thumbnail.type === 'image/webp', 'A mask has a thumbnail');

  // ── The compiler ──────────────────────────────────────────
  const svg = compile(`export default () => <stage><scene active id="s"><rect id="r"><htmlPaint><svg><mask id="m"><rect width="10" height="10" /></mask></svg></htmlPaint></rect></scene></stage>;`);
  check(svg.ok && !/_jsx\.Mask\b/.test(svg.code!) && /createElement\)\("mask"\)/.test(svg.code!), `An SVG <mask> in an html paint stays SVG: ${svg.ok ? svg.code : svg.error}`);

  const source = `export default () => (
  <stage>
    <scene active id="mscene" width={${W}} height={${H}} fill="#0000ff">
      <rect id="cutout" width={${W}} height={${H}} end={0.1} fill="#ff0000">
        <effect type="opacity" value={1}>
          <mask src="${asset.path}" />
        </effect>
      </rect>
      <rect id="clipped" width={${W}} height={${H}} start={0.1} end={0.2} fill="#00ff00">
        <rect clipPath width={${W / 2}} height={${H}} />
      </rect>
      <rect id="legacy" width={${W}} height={${H}} start={0.2} end={0.3} fill="#00ff00">
        <rect mask x={${W / 2}} width={${W / 2}} height={${H}} />
      </rect>
    </scene>
  </stage>
);`;
  const compiled = compile(source);
  check(compiled.ok && /createComponent\)\(_jsx\.Mask\b/.test(compiled.code!), `A <mask> under an <effect> compiles to the composition element: ${compiled.ok ? '' : compiled.error}`);
  const code = compiled.code!;

  // What each frame shows at the middle of its left and right halves.
  const R = [255, 0, 0], B = [0, 0, 255], G = [0, 255, 0];
  const expected: [number[], number[]][] = [[R, B], [B, R], [B, B], [G, B], [G, B], [G, B], [B, G], [B, G], [B, G]];
  const near = (pixel: ArrayLike<number>, color: number[], tolerance: number) => color.every((value, i) => Math.abs(pixel[i]! - value) <= tolerance);
  const sample = (ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D) =>
    [ctx.getImageData(W / 4, H / 2, 1, 1).data, ctx.getImageData((3 * W) / 4, H / 2, 1, 1).data];

  // ── Preview ───────────────────────────────────────────────
  const projectId = 'object-mask-fixture';
  const world = createRuntimeWorld(projectId);
  world.set(Library, library);
  world.set(Mode, { value: 'realtime' });
  const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  world.set(RenderSurface, { canvas, ctx, resolution: 1 });
  const mounted = mount(code, world);
  // The editor's view at 1:1 on the scene, as the export frames it.
  resetCamera(world);
  try {
    const byStamp = (stamp: string) => world.query(Source).find(entity => entity.get(Source)?.value === `index.tsx:${stamp}`);
    const scene = byStamp('mscene')!;
    const cutout = byStamp('cutout')!;
    check(scene && cutout, 'The fixture project mounts');
    const masks = (cutout.get(Cache)?.effects ?? []).flatMap((effect: Entity) => effect.get(Cache)?.masks ?? []);
    check(masks.length === 1 && masks[0]!.has(Mask) && masks[0]!.get(AssetId)?.value === asset.id, 'The <mask> binds to the mask asset');
    check(byStamp('clipped')!.get(Cache)?.clipPaths.length === 1, '<rect clipPath> is a clip path of its parent');
    check(byStamp('legacy')!.get(Cache)?.clipPaths.every((entity: Entity) => entity.has(IsClipPath)) && byStamp('legacy')!.get(Cache)?.clipPaths.length === 1,
      '<rect mask> is still read as a clip path');

    const preview: Uint8ClampedArray[][] = [];
    for (let frame = 0; frame < expected.length; frame++) {
      let pixels: Uint8ClampedArray[] = [];
      for (let attempt = 0; attempt < 100; attempt++) {
        setPlayhead(world, scene, frame);
        assetSystem(world); playbackSystem(world); motionSystem(world); transformSystem(world); renderSystem(world);
        pixels = sample(ctx);
        if (near(pixels[0]!, expected[frame]![0], 2) && near(pixels[1]!, expected[frame]![1], 2)) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      check(near(pixels[0]!, expected[frame]![0], 2) && near(pixels[1]!, expected[frame]![1], 2),
        `Preview frame ${frame} shows ${JSON.stringify(expected[frame])}, not ${JSON.stringify(pixels.map(p => [...p.slice(0, 3)]))}`);
      preview.push(pixels);
    }

    // ── Export ────────────────────────────────────────────────
    await rememberProjectBundle(projectId, code);
    const chunks: { position: number; data: Uint8Array }[] = [];
    const result = await renderScene({ world, stop() {}, start() {} } as unknown as Engine, {
      scene,
      target: { createWritable: async () => new WritableStream({ write(chunk: { position: number; data: Uint8Array }) {
        chunks.push({ position: chunk.position, data: chunk.data.slice() });
      } }) },
      config: { format: 'webm', video: { codec: 'vp8', resolution: H, fps: 30, bitrate: 4_000_000 }, audio: { enabled: false } },
    });
    check(result.type === 'success', `Mask export failed: ${JSON.stringify(result)}`);
    const bytes = new Uint8Array(Math.max(...chunks.map(chunk => chunk.position + chunk.data.length)));
    for (const chunk of chunks) bytes.set(chunk.data, chunk.position);
    const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(new Blob([bytes], { type: 'video/webm' })) });
    const track = await input.getPrimaryVideoTrack();
    check(track && track.displayWidth === W && track.displayHeight === H, 'The export is the scene\'s size');
    const sink = new CanvasSink(track!, { poolSize: 1 });
    let frame = 0;
    for await (const wrapped of sink.canvases(0, (expected.length + 0.5) / 30)) {
      if (frame >= expected.length) break;
      const decoded = wrapped.canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
      const pixels = sample(decoded);
      // VP8 is lossy: a solid colour comes back within a few levels.
      check(near(pixels[0]!, expected[frame]![0], 40) && near(pixels[1]!, expected[frame]![1], 40),
        `Export frame ${frame} shows ${JSON.stringify(pixels.map(p => [...p.slice(0, 3)]))}, preview ${JSON.stringify(preview[frame]!.map(p => [...p.slice(0, 3)]))}`);
      frame++;
    }
    check(frame === expected.length, `The export has every frame: ${frame}`);
    input.dispose?.();

    // ── The tool's commit, with the segmentation stubbed ──────
    // The export above is footage: the tool's frames, as the model would
    // have handed them over, go into the library and onto the clip.
    await checkCommit(library, new File([bytes], 'footage.webm', { type: 'video/webm' }), [half(true, 128), half(false, 128)], check);
  } finally {
    await forgetProjectBundle(projectId);
    mounted.dispose();
    disposeDecoders(world, world.get(Root)!);
    world.destroy();
    await library.dispose();
  }
}

/**
 * What the tool does once the model has followed the object: the frames go
 * into the library as `masks/<video>/Tracking <n>.mask` and the clip gets an
 * opacity effect holding a `<mask>` of them. No model runs: the frames are
 * made up. Before the person agrees to the download, a click on a video
 * fetches nothing and leaves no session behind.
 */
async function checkCommit(library: AssetLibrary, footage: File, masks: MaskFrame[], check: (value: unknown, message: string) => void) {
  const video = await library.store(footage, { name: 'footage.webm' });
  check(video.type === 'VIDEO', `The footage is a video: ${video.type}`);
  const world = createRuntimeWorld('object-mask-commit');
  world.set(Library, library);
  const document = createRuntimeDocument(world);
  const fetched: string[] = [];
  const realFetch = window.fetch;
  try {
    document.setProperty(document.stage, '__source', 'commit-stage');
    const scene = document.createElement('Scene');
    for (const [name, value] of Object.entries({ __source: 'commit-scene', active: true, width: 320, height: 180 })) document.setProperty(scene, name, value);
    document.insertNode(document.stage, scene);
    const clip = document.createElement('Rect');
    for (const [name, value] of Object.entries({ __source: 'commit-clip', width: 320, height: 180, end: 0.3 })) document.setProperty(clip, name, value);
    document.insertNode(scene, clip);
    const paint = document.createElement('VideoPaint');
    document.setProperty(paint, '__source', 'commit-paint');
    document.setProperty(paint, 'src', video.path);
    document.insertNode(clip, paint);
    for (let attempt = 0; attempt < 100 && !clip.entity.get(Cache)?.effects; attempt++) await new Promise(resolve => setTimeout(resolve, 10));

    // No download without the person's say-so.
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      fetched.push(String(input instanceof Request ? input.url : input));
      return realFetch(input, init);
    }) as typeof fetch;
    setObjectMaskModel('tiny');
    promptObjectMask(world, clip.entity, { x: 0.25, y: 0.5, label: 1 });
    for (let attempt = 0; attempt < 200 && getObjectTrack(); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    const load = objectMaskModelLoad();
    check(!getObjectTrack(), 'A click before the download leaves no session');
    check(load?.phase === 'needs-download' || (load?.phase === 'error' && /WebGPU/.test(load.error ?? '')),
      `The tool asks before downloading its model: ${JSON.stringify(load)}`);
    check(!fetched.some(url => /huggingface|hf\.co/.test(url)), `Nothing is fetched before the person agrees: ${fetched.join(', ')}`);
    window.fetch = realFetch;

    const track = {
      clip: clip.entity, seedFrame: 0, points: [{ x: 0.25, y: 0.5, label: 1 }], strokes: [], model: sam2Model('tiny'),
      decoded: null, seedMask: null, first: 0, masks, status: 'saving', completed: masks.length, error: null, controller: new AbortController(),
    } satisfies ObjectTrack;
    const mask = await commitObjectMask(world, track);
    check(mask, 'The tracked frames are committed');
    const stored = library.get('masks/footage/Tracking 1.mask') as MaskAsset | undefined;
    check(stored?.type === 'MASK' && stored.recipe?.source === video.id && stored.recipe.model === sam2Model('tiny').repo && Math.abs(stored.duration - 2 / 30) < 1e-9,
      `The mask file is in the library with its recipe: ${JSON.stringify(stored && { path: stored.path, recipe: stored.recipe })}`);
    const effect = clip.entity.get(Cache)?.effects.find((entity: Entity) => entity.get(Effect)?.type === EffectType.OPACITY);
    check(effect && effect.get(Cache)?.masks[0] === mask && mask!.get(AssetId)?.value === stored!.id, 'The clip has an opacity effect holding the mask');

    // A second object on the same video gets the next name and joins the cut-out.
    const second = await commitObjectMask(world, { ...track, masks: [...masks].reverse(), controller: new AbortController() });
    check(second && library.get('masks/footage/Tracking 2.mask') && effect!.get(Cache)?.masks.length === 2,
      `A second mask joins the same opacity effect: ${JSON.stringify({ second: !!second, file: !!library.get('masks/footage/Tracking 2.mask'), masks: effect!.get(Cache)?.masks.length, effects: clip.entity.get(Cache)?.effects.length })}`);

    // A locked clip takes no mask.
    getDocumentEditor(world).editProperty(clip.entity, 'locked', true);
    check(clip.entity.has(Locked), 'The clip locks');
    const before = library.list().length;
    check(await commitObjectMask(world, { ...track, masks: [masks[0]!], controller: new AbortController() }) === null, 'A locked clip takes no mask');
    check(library.list().length === before, 'A locked clip leaves no mask file behind');
  } finally {
    window.fetch = realFetch;
    document.dispose();
    world.destroy();
  }
}
