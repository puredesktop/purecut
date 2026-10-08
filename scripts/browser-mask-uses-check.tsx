import { AssetLibrary, MASK_FIELD_MAX, type MaskAsset, type MaskFrame, type ProjectFS } from '@diffusionstudio/assets';
import { ALL_FORMATS, BlobSource, CanvasSink, Input } from 'mediabunny';
import { mount } from '../packages/reconciler/src';
import {
  Cache, Effect, EffectType, Library, Mask, Mode, RenderSurface, Root, Source,
  assetSystem, createRuntimeWorld, disposeDecoders, motionSystem, playbackSystem, renderSystem, resetCamera,
  setPlayhead, transformSystem,
} from '../packages/runtime/src';
import { rememberProjectBundle, forgetProjectBundle } from '../apps/web/src/lib/db';
import { renderScene } from '../apps/web/src/context/render';
import { getDocumentEditor } from '../apps/web/src/engine/editor';
import { getEditHistory } from '../apps/web/src/engine/history';
import { encodeObjectMask } from '../apps/web/src/engine/object-mask/commit';
import {
  addPrivacyEffect, behindSubjectOf, clearBehindSubject, setBehindSubject,
} from '../apps/web/src/engine/object-mask/uses';
import type { Engine } from '../apps/web/src/engine';
import type { EntityEdit } from '../apps/web/src/engine/editor';
import type { ObjectMaskSource } from '../apps/web/src/engine/object-mask/copy';
import type { Entity, World } from 'koota';

/**
 * What a tracked mask is used for (PureCut): text behind a subject, and a
 * privacy blur or pixelation. No model runs: the masks are a hand-made
 * file, the left half of the frame, then the right half, then a frame the
 * object was not found on — what the Object mask tool would have written.
 *
 * - Behind subject: a green title over a red clip in the scene's top-right
 *   quarter, with an inverted mask following the clip. Where the subject
 *   is, the clip shows over the title; elsewhere the title shows; once the
 *   clip ends, the title shows everywhere. Preview and export agree.
 * - The editor's commands: one undo step on, one off, and what they write
 *   goes through the file writer, compiles and renders the same.
 * - Privacy: black and white stripes blurred or pixelated inside the mask
 *   and untouched outside, on every frame of preview and export; a stronger
 *   blur or bigger blocks show as such.
 */
export async function checkMaskUses() {
  const { compile, applyEdits } = await import('../purecut/compiler-runtime.js') as {
    compile(source: string): { ok: boolean; code?: string; error?: string };
    applyEdits(context: unknown, edits: unknown[]): Promise<{ skipped: string[]; error?: string }>;
  };
  const check = (value: unknown, message: string) => { if (!value) throw Error(message); };
  const W = 320, H = 180, GRID = 8;

  const half = (left: boolean): MaskFrame => ({
    field: Int8Array.from({ length: GRID * GRID }, (_, i) => ((i % GRID < GRID / 2) === left ? MASK_FIELD_MAX : -MASK_FIELD_MAX)),
    score: 1, iou: 0.9,
  });
  const blob = encodeObjectMask({ width: W, height: H }, 30, GRID, [half(true), half(false), null], {
    model: 'fixture', source: 'video-id', first: 0, seedFrame: 0, points: [{ x: 0.25, y: 0.5, label: 1 as const }],
  });

  const files = new Map<string, File>();
  const fs: ProjectFS = {
    readManifest: async () => null, writeManifest: async () => {}, list: async () => [],
    stat: async path => { const file = files.get(path); return file ? { size: file.size, mtime: file.lastModified } : null; },
    file: async path => { const file = files.get(path); if (!file) throw Error(`Missing fixture ${path}`); return file; },
    write: async (path, data) => { files.set(path, new File([data], path.split('/').pop()!)); },
    remove: async path => { files.delete(path); },
  };
  const library = new AssetLibrary(fs);
  const asset = await library.store(blob, { folder: 'masks/clip', name: 'Tracking 1.mask' }) as MaskAsset;
  const source: ObjectMaskSource = { asset, name: 'Tracking 1', sourceIn: 0 };
  const compiled = (text: string) => {
    const result = compile(text);
    check(result.ok, `The fixture compiles: ${result.error}\n${text}`);
    return result.code!;
  };

  type Pixel = number[];
  const near = (a: ArrayLike<number>, b: ArrayLike<number>, tolerance: number) => [0, 1, 2].every((i) => Math.abs(a[i]! - b[i]!) <= tolerance);
  const show = (pixels: Pixel[]) => JSON.stringify(pixels.map((p) => p.slice(0, 3)));

  /**
   * Mounts `code`, renders `frames` of scene `scene` in the preview until
   * `expect` holds for each (decoders land asynchronously), then exports the
   * scene and decodes it again. Both sample `points`.
   */
  async function renderBoth(code: string, scene: string, points: [number, number][], frames: number, expect: (frame: number, pixels: Pixel[]) => string | null, exported = true) {
    const projectId = `mask-uses-${Math.random().toString(36).slice(2)}`;
    const world = createRuntimeWorld(projectId);
    world.set(Library, library);
    world.set(Mode, { value: 'realtime' });
    const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    world.set(RenderSurface, { canvas, ctx, resolution: 1 });
    const mounted = mount(code, world);
    resetCamera(world);
    const sample = (c: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D) => points.map(([x, y]) => [...c.getImageData(x, y, 1, 1).data]);
    try {
      const sceneEntity = world.query(Source).find((entity) => entity.get(Source)?.value === `index.tsx:${scene}`);
      check(sceneEntity, `Scene ${scene} mounts`);
      const preview: Pixel[][] = [];
      for (let frame = 0; frame < frames; frame++) {
        let pixels: Pixel[] = [];
        let problem: string | null = null;
        for (let attempt = 0; attempt < 100; attempt++) {
          setPlayhead(world, sceneEntity!, frame);
          assetSystem(world); playbackSystem(world); motionSystem(world); transformSystem(world); renderSystem(world);
          pixels = sample(ctx);
          problem = expect(frame, pixels);
          if (!problem) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        check(!problem, `Preview frame ${frame}: ${problem} ${show(pixels)}`);
        preview.push(pixels);
      }
      if (!exported) return { world, preview, exportedFrames: [] as Pixel[][], dispose: () => { mounted.dispose(); disposeDecoders(world, world.get(Root)!); world.destroy(); } };

      await rememberProjectBundle(projectId, code);
      const chunks: { position: number; data: Uint8Array }[] = [];
      const result = await renderScene({ world, stop() {}, start() {} } as unknown as Engine, {
        scene: sceneEntity!,
        target: { createWritable: async () => new WritableStream({ write(chunk: { position: number; data: Uint8Array }) {
          chunks.push({ position: chunk.position, data: chunk.data.slice() });
        } }) },
        config: { format: 'webm', video: { codec: 'vp8', resolution: H, fps: 30, bitrate: 6_000_000 }, audio: { enabled: false } },
      });
      await forgetProjectBundle(projectId);
      check(result.type === 'success', `Export failed: ${JSON.stringify(result)}`);
      const bytes = new Uint8Array(Math.max(...chunks.map((chunk) => chunk.position + chunk.data.length)));
      for (const chunk of chunks) bytes.set(chunk.data, chunk.position);
      const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(new Blob([bytes], { type: 'video/webm' })) });
      const track = await input.getPrimaryVideoTrack();
      check(track && track.displayWidth === W && track.displayHeight === H, 'The export is the scene\'s size');
      const sink = new CanvasSink(track!, { poolSize: 1 });
      const exportedFrames: Pixel[][] = [];
      for await (const wrapped of sink.canvases(0, (frames + 0.5) / 30)) {
        if (exportedFrames.length >= frames) break;
        exportedFrames.push(sample(wrapped.canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D));
      }
      input.dispose?.();
      check(exportedFrames.length === frames, `The export has every frame: ${exportedFrames.length}`);
      return { world, preview, exportedFrames, dispose: () => { mounted.dispose(); disposeDecoders(world, world.get(Root)!); world.destroy(); } };
    } catch (error) {
      mounted.dispose(); disposeDecoders(world, world.get(Root)!); world.destroy();
      throw error;
    }
  }

  /** Preview and export agree at every point of every frame, within what VP8 loses. */
  const sameInExport = (label: string, run: { preview: Pixel[][]; exportedFrames: Pixel[][] }) => {
    run.preview.forEach((pixels, frame) => pixels.forEach((pixel, i) =>
      check(near(pixel, run.exportedFrames[frame]![i]!, 40),
        `${label}: export frame ${frame} point ${i} is ${show([run.exportedFrames[frame]![i]!])}, preview ${show([pixel])}`)));
  };

  // ── Behind subject ────────────────────────────────────────
  // The clip is the top-right quarter; its subject is the clip's left half
  // on frame 0 and its right half on frame 1, and nothing on frame 2. The
  // clip ends after frame 2; the title runs on to frame 5.
  const RED = [255, 0, 0], GREEN = [0, 255, 0];
  const behindPoints: [number, number][] = [[200, 45], [280, 45], [80, 45], [200, 135]];
  const behindExpected = (frame: number): Pixel[] => [
    frame === 0 ? RED : GREEN, frame === 1 ? RED : GREEN, GREEN, GREEN,
  ];
  const behindExpect = (frame: number, pixels: Pixel[]) =>
    pixels.every((pixel, i) => near(pixel, behindExpected(frame)[i]!, 2)) ? null : `expected ${show(behindExpected(frame))}`;
  const scene = (title: string) => `export default () => (
  <stage>
    <scene active id="bscene" width={${W}} height={${H}} fill="#0000ff">
      <rect id="clip" x={${W / 2}} width={${W / 2}} height={${H / 2}} end={0.1} fill="#ff0000" />
      ${title}
    </scene>
  </stage>
);`;
  const plainTitle = `<rect id="title" width={${W}} height={${H}} end={0.2} fill="#00ff00" />`;
  const behindTitle = `<rect id="title" width={${W}} height={${H}} end={0.2} fill="#00ff00">
        <effect id="behind" type="opacity" value={1}>
          <mask id="subject" src="${asset.path}" follow="clip" inverted />
        </effect>
      </rect>`;

  const handWritten = await renderBoth(compiled(scene(behindTitle)), 'bscene', behindPoints, 6, behindExpect);
  try {
    sameInExport('Behind subject', handWritten);
  } finally { handWritten.dispose(); }

  // The editor's command, on the title without the effect: one step on, one
  // step off, and what it writes renders the same once it is in the file.
  const plainCode = compiled(scene(plainTitle));
  const plain = await renderBoth(plainCode, 'bscene', behindPoints, 2, (_, pixels) =>
    pixels.slice(0, 3).every((pixel) => near(pixel, GREEN, 2)) ? null : 'the title covers the clip', false);
  let writtenSource = '';
  try {
    const world = plain.world;
    const byStamp = (stamp: string) => world.query(Source).find((entity) => entity.get(Source)?.value === `index.tsx:${stamp}`)!;
    const clip = byStamp('clip'), title = byStamp('title');
    const editor = getDocumentEditor(world);
    const history = getEditHistory(world);
    const edits: EntityEdit[] = [];
    const stop = editor.onEdit((edit) => edits.push(edit));
    const mask = setBehindSubject(world, title, { clip, id: 'clip', clipName: 'Clip', source });
    stop();
    const behind = behindSubjectOf(world, title);
    check(mask && behind && behind.mask === mask && behind.clip === clip && behind.follow === 'clip', 'Behind subject puts an inverted mask following the clip on the title');
    check(mask!.get(Mask)?.inverted && mask!.get(Mask)?.follow === 'clip' && behind!.effect.get(Effect)?.type === EffectType.OPACITY, 'The mask is inverted, follows the clip, under opacity');
    await Promise.resolve();
    history.undo();
    check(!behindSubjectOf(world, title) && (title.get(Cache)?.effects.length ?? 0) === 0, 'One undo takes behind subject off whole');
    history.redo();
    check(behindSubjectOf(world, title), 'Redo puts it back');
    check(clearBehindSubject(world, title) && !behindSubjectOf(world, title), 'Turning it off removes the effect');
    await Promise.resolve();
    history.undo();
    check(behindSubjectOf(world, title), 'One undo turns it back on');

    // Through the file writer, the compiler and the renderer.
    const text = new Map([['index.tsx', scene(plainTitle)]]);
    const context = { dir: '/project', io: {
      read: async (file: string) => text.get(file)!, write: async (file: string, value: string) => { text.set(file, value); }, files: async () => [...text.keys()],
    } };
    const sourceEdits = edits.map((edit) => edit.kind === 'prop' ? { kind: 'set', source: edit.source, props: { [edit.name]: edit.value } } : edit);
    const written = await applyEdits(context, sourceEdits);
    check(written.skipped.length === 0 && !written.error, `The edit writes: ${JSON.stringify(written)}`);
    writtenSource = text.get('index.tsx')!;
    check(/<effect id="[^"]+" type="opacity" value=\{1\}>\s*<mask id="[^"]+" src="masks\/clip\/Tracking 1\.mask" follow="clip" inverted \/>\s*<\/effect>/.test(writtenSource), `The file says behind subject: ${writtenSource}`);
  } finally { plain.dispose(); }
  const reopened = await renderBoth(compiled(writtenSource), 'bscene', behindPoints, 6, behindExpect, false);
  reopened.dispose();

  // ── Privacy blur and pixelation ───────────────────────────
  // Black with white stripes 10px wide every 20px. The mask covers the left
  // half on frame 0 and the right half on frame 1.
  const stripes = Array.from({ length: W / 20 }, (_, i) => `<rect x={${i * 20}} width={10} height={${H}} fill="#ffffff" />`).join('');
  const privacy = (effect: string) => `export default () => (
  <stage>
    <scene active id="pscene" width={${W}} height={${H}} fill="#000000">
      <rect id="street" width={${W}} height={${H}} end={0.1} fill="#000000">
        ${stripes}
        ${effect}
      </rect>
    </scene>
  </stage>
);`;
  const masked = (type: string, value: number) => `<effect type="${type}" value={${value}}><mask src="${asset.path}" /></effect>`;
  // A white stripe's middle and the black gap's, on each side.
  const privacyPoints: [number, number][] = [[45, 90], [55, 90], [205, 90], [215, 90]];
  const contrast = (pixels: Pixel[], side: 0 | 1) => Math.abs(pixels[side * 2]![0]! - pixels[side * 2 + 1]![0]!);
  const hidden = (limit: number) => (frame: number, pixels: Pixel[]) => {
    if (frame > 1) return null;
    const inside = frame === 0 ? 0 : 1, outside = frame === 0 ? 1 : 0;
    if (contrast(pixels, outside) < 250) return `outside the mask the stripes must stay sharp (${contrast(pixels, outside)})`;
    if (contrast(pixels, inside) > limit) return `inside the mask the stripes must be hidden (${contrast(pixels, inside)} > ${limit})`;
    return null;
  };

  const blurred = await renderBoth(compiled(privacy(masked('blur', 12))), 'pscene', privacyPoints, 2, hidden(60));
  const blurContrast = blurred.preview.map((pixels, frame) => contrast(pixels, frame === 0 ? 0 : 1));
  try { sameInExport('Privacy blur', blurred); } finally { blurred.dispose(); }
  const lightBlur = await renderBoth(compiled(privacy(masked('blur', 3))), 'pscene', privacyPoints, 2, hidden(250), false);
  const lightContrast = lightBlur.preview.map((pixels, frame) => contrast(pixels, frame === 0 ? 0 : 1));
  lightBlur.dispose();
  check(lightContrast.every((value, frame) => value > blurContrast[frame]! + 60), `A stronger blur hides more: ${lightContrast} vs ${blurContrast}`);

  const pixelated = await renderBoth(compiled(privacy(masked('pixelate', 40))), 'pscene', privacyPoints, 2, hidden(20));
  try { sameInExport('Pixelate', pixelated); } finally { pixelated.dispose(); }
  // Small blocks keep the stripes apart: a 5px block of a 10px stripe is all white or all black.
  const small = await renderBoth(compiled(privacy(masked('pixelate', 5))), 'pscene', privacyPoints, 2, (frame, pixels) =>
    frame > 1 || contrast(pixels, frame === 0 ? 0 : 1) > 200 ? null : 'small blocks keep the stripes', false);
  small.dispose();

  // Pixelation unmasked is the whole clip; the editor's command writes it masked, in one step.
  const whole = await renderBoth(compiled(privacy(`<effect type="pixelate" value={40} />`)), 'pscene', privacyPoints, 1,
    (_, pixels) => contrast(pixels, 0) < 20 && contrast(pixels, 1) < 20 ? null : 'an unmasked pixelation covers the clip', false);
  whole.dispose();

  const command = await renderBoth(compiled(privacy('')), 'pscene', privacyPoints, 1, (_, pixels) =>
    contrast(pixels, 0) > 250 ? null : 'the stripes start sharp', false);
  try {
    const world: World = command.world;
    const street = world.query(Source).find((entity) => entity.get(Source)?.value === 'index.tsx:street') as Entity;
    const history = getEditHistory(world);
    const effect = addPrivacyEffect(world, street, source, 'pixelate');
    check(effect?.get(Effect)?.type === EffectType.PIXELATE && effect.get(Cache)?.masks.length === 1, 'Pixelate adds a pixelate effect holding the mask');
    await Promise.resolve();
    history.undo();
    check((street.get(Cache)?.effects.length ?? 0) === 0, 'One undo takes the pixelation off');
  } finally { command.dispose(); }

  await library.dispose();
}
