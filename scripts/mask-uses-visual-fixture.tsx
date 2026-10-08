import { AssetLibrary, MASK_FIELD_MAX, type MaskAsset, type MaskFrame, type ProjectFS } from '@diffusionstudio/assets';
import { BufferTarget, CanvasSource, Output, WebMOutputFormat } from 'mediabunny';
import { Rect, VideoPaint } from '@diffusionstudio/reconciler';
import { Library, Selected, Source, Tool, ToolType, getActiveEntity, setPlayhead } from '../packages/runtime/src';
import { getDocumentEditor } from '../apps/web/src/engine/editor';
import { encodeObjectMask } from '../apps/web/src/engine/object-mask/commit';
import { objectMaskModel, setObjectMaskModelLoad } from '../apps/web/src/engine/object-mask/store';
import { addPrivacyEffect, clearBehindSubject, setBehindSubject, subjectChoices } from '../apps/web/src/engine/object-mask/uses';
import { mainBridge } from '../apps/web/src/lib/ipc';
import { fixtureWorld } from './editor-visual-fixture';
import type { Entity } from 'koota';

/**
 * Stages the behind-subject and privacy UI on the editor visual fixture (see
 * test-mask-uses-visual.mjs): an interview clip of a figure walking, made
 * here, with a hand-made mask that follows the figure — what the Object mask
 * tool would have tracked. No model runs and nothing is downloaded.
 */
const W = 1280, H = 720, FRAMES = 60, GRID = 128;
const figureX = (frame: number) => 520 + (frame / FRAMES) * 240;
/** Whether (x, y) of the frame is on the figure: a head and shoulders. */
const onFigure = (frame: number, x: number, y: number) => {
  const cx = figureX(frame);
  return Math.hypot(x - cx, y - 300) < 78 || (y > 380 && Math.abs(x - cx) < 150 - Math.max(0, 420 - y));
};

async function footage(): Promise<Blob> {
  const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  const target = new BufferTarget();
  const output = new Output({ format: new WebMOutputFormat(), target });
  const source = new CanvasSource(canvas, { codec: 'vp8', bitrate: 4_000_000 });
  output.addVideoTrack(source, { frameRate: 30 });
  await output.start();
  for (let frame = 0; frame < FRAMES; frame++) {
    const sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, '#d9c7a8'); sky.addColorStop(1, '#8a6f4e');
    ctx.fillStyle = sky; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#5b4632';
    for (let i = 0; i < 6; i++) ctx.fillRect(i * 230 + 40, 120, 120, 420);
    const cx = figureX(frame);
    ctx.fillStyle = '#2f3b52';
    ctx.beginPath(); ctx.moveTo(cx - 150, H); ctx.lineTo(cx - 150, 440); ctx.quadraticCurveTo(cx - 140, 380, cx - 60, 380);
    ctx.lineTo(cx + 60, 380); ctx.quadraticCurveTo(cx + 140, 380, cx + 150, 440); ctx.lineTo(cx + 150, H); ctx.fill();
    ctx.fillStyle = '#c99b78';
    ctx.beginPath(); ctx.arc(cx, 300, 78, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#3a2a1f';
    ctx.beginPath(); ctx.arc(cx, 278, 80, Math.PI, 0); ctx.fill();
    await source.add(frame / 30, 1 / 30);
  }
  await output.finalize();
  return new Blob([target.buffer!], { type: 'video/webm' });
}

function maskFrames(): MaskFrame[] {
  return Array.from({ length: FRAMES }, (_, frame) => ({
    field: Int8Array.from({ length: GRID * GRID }, (_, i) =>
      onFigure(frame, ((i % GRID) + 0.5) * (W / GRID), (Math.floor(i / GRID) + 0.5) * (H / GRID)) ? MASK_FIELD_MAX : -MASK_FIELD_MAX),
    score: 1, iou: 0.95,
  }));
}

let staged: { world: NonNullable<typeof fixtureWorld>; clip: Entity; title: Entity; library: AssetLibrary; video: { id: string; path: string } } | null = null;

const select = (entity: Entity) => {
  const world = staged!.world;
  for (const other of world.query(Selected)) other.remove(Selected);
  getDocumentEditor(world).select(entity);
};

/** Puts the interview clip under the title, with nothing tracked yet, and selects the title. */
export async function stageInterview() {
  const world = fixtureWorld;
  if (!world) throw Error('Mount the editor visual fixture first');
  // Writes from the editor land nowhere, the fixture has no project folder,
  // but answer with names for what they insert, as a write does.
  const call = mainBridge.call;
  let named = 0;
  mainBridge.call = (async (channel: string, ...args: unknown[]) => {
    if (channel !== 'projects:write') return (call as (...a: unknown[]) => unknown)(channel, ...args);
    const { edits } = args[0] as { edits: { kind: string; source: string; props?: Record<string, unknown> }[] };
    const ids: Record<string, string> = {};
    for (const edit of edits) {
      if (edit.kind === 'insert') ids[edit.source] = `index.tsx:${edit.props?.name === 'Interview' ? 'interview' : `fixture${++named}`}`;
    }
    return { skipped: [], ids };
  }) as typeof mainBridge.call;

  const files = new Map<string, File>();
  const fs: ProjectFS = {
    readManifest: async () => null, writeManifest: async () => {}, list: async () => [],
    stat: async path => { const file = files.get(path); return file ? { size: file.size, mtime: file.lastModified } : null; },
    file: async path => { const file = files.get(path); if (!file) throw Error(`Missing fixture ${path}`); return file; },
    write: async (path, data) => { files.set(path, new File([data], path.split('/').pop()!)); },
    remove: async path => { files.delete(path); },
  };
  const library = new AssetLibrary(fs);
  const video = await library.store(await footage(), { folder: 'footage', name: 'interview.webm' });
  world.set(Library, library);

  const byStamp = (stamp: string) => world.query(Source).find((entity) => entity.get(Source)?.value === stamp)!;
  const scene = getActiveEntity(world)!;
  const title = byStamp('visual-title');
  const editor = getDocumentEditor(world);
  // Called rather than written as JSX: this file's JSX is the DOM's, not the composition's.
  const [clip] = editor.insertElement(scene, () =>
    Rect({ name: 'Interview', width: W, height: H, end: 12, get children() { return VideoPaint({ src: video.path }); } }), title);
  for (let i = 0; i < 100 && clip!.get(Source)?.value !== 'index.tsx:interview'; i++) await new Promise((resolve) => setTimeout(resolve, 20));
  staged = { world, clip: clip!, title, library, video };
  setPlayhead(world, scene, 24);
  select(title);
}

/** Tracks the figure (by hand) and selects the title: the section offers the subject. */
export async function trackFigure() {
  const { library, video } = staged!;
  const blob = encodeObjectMask({ width: W, height: H }, 30, GRID, maskFrames(), {
    model: 'fixture', source: video.id, first: 0, seedFrame: 0, points: [{ x: 0.5, y: 0.4, label: 1 as const }],
  });
  await library.store(blob, { folder: 'masks/interview', name: 'Tracking 1.mask' }) as MaskAsset;
  select(staged!.title);
}

/** Puts the title behind the figure, as the section's menu does. */
export function putTitleBehind() {
  const { world, title } = staged!;
  const [choice] = subjectChoices(world, title);
  if (!choice || !setBehindSubject(world, title, choice)) throw Error('No subject to put the title behind');
  select(title);
}

/** Takes the title out from behind and pixelates the figure instead, selecting the clip. */
export function pixelateFigure() {
  const { world, title, clip } = staged!;
  clearBehindSubject(world, title);
  const [choice] = subjectChoices(world, title);
  if (!addPrivacyEffect(world, clip, choice!.source, 'pixelate')) throw Error('The clip takes no pixelation');
  select(clip);
}

/** The Object mask tool up with its model as if downloaded, so the whole bar shows. */
export async function openObjectMaskTool() {
  const { world, clip } = staged!;
  select(clip);
  world.set(Tool, { value: ToolType.OBJECT_MASK });
  // The bar asks for the download first (the model is not here); once its check is in, say it is.
  await new Promise((resolve) => setTimeout(resolve, 800));
  setObjectMaskModelLoad({ id: objectMaskModel(), phase: 'ready', progress: null, error: null });
}

export function closeObjectMaskTool() {
  staged!.world.set(Tool, { value: ToolType.MOVE });
}
