import { AssetLibrary, MASK_FIELD_MAX, type MaskFrame, type ProjectFS } from '@diffusionstudio/assets';
import { sam2Model } from '@diffusionstudio/sam2/models';
import { BufferTarget, CanvasSource, Output, WebMOutputFormat } from 'mediabunny';
import { mount } from '../packages/reconciler/src';
import {
  Cache, Computed, Effect, EffectType, Library, Mode, RenderSurface, Root, Source, Tool, ToolType,
  assetSystem, createRuntimeWorld, disposeDecoders, getActiveEntity, motionSystem, playbackSystem, renderSystem,
  resetCamera, transformSystem,
} from '../packages/runtime/src';
import { setEditorSession } from '../apps/web/src/dapi/session';
import { getDocumentEditor } from '../apps/web/src/engine/editor';
import { getEditHistory } from '../apps/web/src/engine/history';
import { behindSubjectOf } from '../apps/web/src/engine/object-mask/uses';
import { getObjectTrack, objectMaskUse, setObjectTrack } from '../apps/web/src/engine/object-mask/store';
import { cancelObjectMask, finishTrackedObject, promptObjectMask } from '../apps/web/src/engine/object-mask/tracking';
import {
  pendingTrackRequest, settleTrackRequestOf, settleTrackRequestOnClose, settleTrackRequestOnToolDown,
} from '../apps/web/src/engine/object-mask/request';
import { getCutTrackStatus, trackCutObject } from '../purecut/track-object';
import type { ObjectTrack } from '../apps/web/src/engine/object-mask/store';
import type { Entity } from 'koota';

/**
 * The drawer agent's `trackCutObject` / `getCutTrackStatus` (PureCut). No
 * model runs: tracking is stubbed by handing the tool's last step
 * (`finishTrackedObject`) hand-made frames, what the model would have
 * followed. The request opens the tool on the clip with the suggested point
 * and use and writes nothing; confirming writes the mask and its use as one
 * undo step and says so; cancelling, putting the tool down, closing the
 * project or removing the clip leave the project as it was and say why; a
 * second request while one waits, and bad clips, are refused. Accepting the
 * point before the model is here fetches nothing.
 */
export async function checkTrackRequests() {
  const { compile } = await import('../purecut/compiler-runtime.js') as { compile(source: string): { ok: boolean; code?: string; error?: string } };
  const check = (value: unknown, message: string) => { if (!value) throw Error(message); };
  const rejects = (fn: () => unknown, pattern: RegExp, label: string) => {
    try { fn(); } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      check(pattern.test(message), `${label}: unexpected refusal "${message}"`);
      return message;
    }
    throw Error(`${label}: expected a refusal`);
  };
  const W = 64, H = 36, FRAMES = 6, GRID = 16;

  // Footage: six frames, made here.
  const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
  const paint = canvas.getContext('2d')!;
  const target = new BufferTarget();
  const output = new Output({ format: new WebMOutputFormat(), target });
  const source = new CanvasSource(canvas, { codec: 'vp8', bitrate: 500_000 });
  output.addVideoTrack(source, { frameRate: 30 });
  await output.start();
  for (let frame = 0; frame < FRAMES; frame++) {
    paint.fillStyle = '#204060'; paint.fillRect(0, 0, W, H);
    paint.fillStyle = '#e0c0a0'; paint.fillRect(10 + frame * 4, 8, 16, 20);
    await source.add(frame / 30, 1 / 30);
  }
  await output.finalize();

  const files = new Map<string, File>();
  const fs: ProjectFS = {
    readManifest: async () => null, writeManifest: async () => {}, list: async () => [],
    stat: async path => { const file = files.get(path); return file ? { size: file.size, mtime: file.lastModified } : null; },
    file: async path => { const file = files.get(path); if (!file) throw Error(`Missing fixture ${path}`); return file; },
    write: async (path, data) => { files.set(path, new File([data], path.split('/').pop()!)); },
    remove: async path => { files.delete(path); },
  };
  const library = new AssetLibrary(fs);
  const video = await library.store(new Blob([target.buffer!], { type: 'video/webm' }), { name: 'footage.webm' });
  check(video.type === 'VIDEO', `The footage is a video: ${video.type}`);

  const compiled = compile(`export default () => (
  <stage>
    <scene active id="tscene" width={${W}} height={${H}} fill="#000000">
      <rect id="clip" name="Interview" width={${W}} height={${H}} end={0.2}><videoPaint src="${video.path}" /></rect>
      <text id="title" x={4} y={4} width={40} height={10} fontSize={8} end={0.2} fill="#ffffff">Title</text>
      <rect id="plain" width={10} height={10} end={0.2} fill="#ff0000" />
      <rect id="bolted" locked width={${W}} height={${H}} end={0.2}><videoPaint src="${video.path}" /></rect>
      {[0, 1].map((i) => <rect id="looped" x={i * 10} width={10} height={10} end={0.2}><videoPaint src="${video.path}" /></rect>)}
      <rect id="late" width={${W}} height={${H}} start={0.1} end={0.2}><videoPaint src="${video.path}" /></rect>
    </scene>
  </stage>
);`);
  check(compiled.ok, `The fixture compiles: ${compiled.error}`);

  const world = createRuntimeWorld('track-request-fixture');
  world.set(Library, library);
  world.set(Mode, { value: 'realtime' });
  const surface = document.createElement('canvas'); surface.width = W; surface.height = H;
  world.set(RenderSurface, { canvas: surface, ctx: surface.getContext('2d')!, resolution: 1 });
  const mounted = mount(compiled.code!, world);
  resetCamera(world);
  const settle = async () => {
    for (let i = 0; i < 3; i++) {
      assetSystem(world); playbackSystem(world); motionSystem(world); transformSystem(world); renderSystem(world);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  await settle();
  setEditorSession({ world, project: { dir: () => '/track-fixture' }, engine: {} as never });

  const fetched: string[] = [];
  const realFetch = window.fetch;
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    fetched.push(String(input instanceof Request ? input.url : input));
    return realFetch(input, init);
  }) as typeof fetch;

  const editor = getDocumentEditor(world);
  const history = getEditHistory(world);
  const edits: unknown[] = [];
  const stop = editor.onEdit(edit => edits.push(edit));
  const byStamp = (stamp: string) => world.query(Source).find(entity => entity.get(Source)?.value === `index.tsx:${stamp}`) as Entity;
  const clip = byStamp('clip');
  const title = byStamp('title');
  const effects = (entity: Entity) => entity.get(Cache)?.effects ?? [];
  const results: string[] = [];
  try {
    check(clip && title, 'The fixture mounts');
    check(getActiveEntity(world), 'The scene is active');

    // ── Refusals ────────────────────────────────────────────
    rejects(() => trackCutObject({ clip: 'clip' }), /index\.tsx:<id>/, 'A bare id');
    rejects(() => trackCutObject({ clip: 'index.tsx:nope' }), /no index\.tsx:nope/, 'A missing clip');
    rejects(() => trackCutObject({ clip: 'index.tsx:plain' }), /not a video clip/, 'A clip without video');
    rejects(() => trackCutObject({ clip: 'index.tsx:bolted' }), /locked/, 'A locked clip');
    rejects(() => trackCutObject({ clip: 'index.tsx:looped' }), /loop/, 'A loop-generated clip');
    rejects(() => trackCutObject({ clip: 'index.tsx:clip', at: { x: 2, y: 0.5 } }), /`at`/, 'A point off the frame');
    rejects(() => trackCutObject({ clip: 'index.tsx:clip', time: 5 }), /outside/, 'A time outside the clip');
    rejects(() => trackCutObject({ clip: 'index.tsx:clip', use: 'erase' }), /`use`/, 'An unknown use');
    rejects(() => trackCutObject({ clip: 'index.tsx:late', use: 'behind' }), /no(ne)? above it/, 'Behind with no text above');
    check(!pendingTrackRequest() && edits.length === 0, 'Refusals open nothing and write nothing');
    check(getCutTrackStatus().status === 'none', 'Before any request there is nothing to report');
    results.push('9 refusals');

    // ── Ask, then confirm (tracking stubbed) ───────────────
    world.set(Tool, { value: ToolType.MOVE });
    const asked = trackCutObject({ clip: 'index.tsx:clip', at: { x: 0.3, y: 0.5 }, time: 0.1, use: 'blur', label: 'his face' });
    check(asked.status === 'awaiting_person' && /Nothing has changed/.test(asked.message), `The tool returns awaiting_person: ${JSON.stringify(asked)}`);
    const request = pendingTrackRequest();
    check(request?.clip === clip && request.point?.x === 0.3 && request.use === 'blur' && request.label === 'his face' && request.clipName === 'Interview',
      `The request is held with its point, use and label: ${JSON.stringify(request && { ...request, world: undefined, clip: undefined })}`);
    check(world.get(Tool)?.value === ToolType.OBJECT_MASK, 'The Object mask tool is up');
    check(objectMaskUse() === 'blur', `Blur is picked in the bar: ${objectMaskUse()}`);
    check((getActiveEntity(world)!.get(Computed)?.localTime ?? -1) === 3, 'The playhead is on the asked time (0.1s, frame 3)');
    check(!getObjectTrack(), 'The point is a suggestion, not a prompt');
    check(edits.length === 0 && effects(clip).length === 0, `Asking writes nothing: ${JSON.stringify(edits)}`);
    const pending = getCutTrackStatus() as { status: string; waitingFor?: string; message: string };
    check(pending.status === 'pending' && ['click', 'download-consent'].includes(pending.waitingFor ?? '') && /Nothing has changed/.test(pending.message),
      `Pending says what is awaited: ${JSON.stringify(pending)}`);

    const again = rejects(() => trackCutObject({ clip: 'index.tsx:clip' }), /already waiting/, 'A second request while one waits');
    check(/his face/.test(again), `The refusal names the open request: ${again}`);

    const half = (left: boolean): MaskFrame => ({
      field: Int8Array.from({ length: GRID * GRID }, (_, i) => ((i % GRID < GRID / 2) === left ? MASK_FIELD_MAX : -MASK_FIELD_MAX)),
      score: 1, iou: 0.9,
    });
    const tracked = (): ObjectTrack => ({
      clip, seedFrame: 3, points: [{ x: 0.3, y: 0.5, label: 1 }], strokes: [], model: sam2Model('tiny'),
      decoded: null, seedMask: null, first: 0, masks: Array.from({ length: FRAMES }, (_, i) => half(i < 3)), status: 'tracking',
      completed: FRAMES, error: null, controller: new AbortController(),
    });
    // As the person's prompt and Confirm leave it, then the model's frames, then the tool's last step.
    const track = tracked();
    setObjectTrack(track);
    await finishTrackedObject(world, track);
    const done = getCutTrackStatus() as { status: string; mask?: string; use?: string; applied?: number; message: string; next?: string };
    check(done.status === 'done' && done.mask === 'masks/footage/Tracking 1.mask' && done.use === 'blur' && done.applied === 1 && /next|getCutContext/.test(done.next ?? ''),
      `Done reports the mask and its use: ${JSON.stringify(done)}`);
    const blur = effects(clip).find(effect => effect.get(Effect)?.type === EffectType.LAYER_BLUR);
    check(blur && blur.get(Cache)?.masks.length === 1, 'The clip has a blur effect holding the mask');
    check(world.get(Tool)?.value === ToolType.MOVE && !pendingTrackRequest(), 'The tool is put down and the request is over');
    await Promise.resolve();
    history.undo();
    check(effects(clip).length === 0, 'One undo takes the blur off');
    history.redo();
    check(effects(clip).length === 1, 'Redo puts it back');
    results.push('confirm -> blur, one undo');

    // ── Ask, then cancel ───────────────────────────────────
    const before = edits.length;
    const effectsBefore = effects(clip).length;
    trackCutObject({ clip: 'index.tsx:clip', at: { x: 0.5, y: 0.5 }, use: 'pixelate' });
    cancelObjectMask(world);
    const cancelled = getCutTrackStatus() as { status: string; message: string };
    check(cancelled.status === 'cancelled' && /Nothing was tracked/.test(cancelled.message) && /unchanged/.test(cancelled.message),
      `Cancel is reported in words: ${JSON.stringify(cancelled)}`);
    check(edits.length === before && effects(clip).length === effectsBefore && library.list().filter(a => a.type === 'MASK').length === 1,
      'Cancelling leaves the project as it was');
    check(world.get(Tool)?.value === ToolType.MOVE, 'Cancel puts the tool down');
    results.push('cancel');

    // ── Taking the point before the model is here ──────────
    trackCutObject({ clip: 'index.tsx:clip', at: { x: 0.3, y: 0.5 }, use: 'cutout' });
    promptObjectMask(world, clip, { x: 0.3, y: 0.5, label: 1 });
    for (let i = 0; i < 300 && getObjectTrack(); i++) await new Promise(resolve => setTimeout(resolve, 10));
    check(!getObjectTrack(), 'Without the model the prompt leaves no session');
    check(!fetched.some(url => /huggingface|hf\.co/.test(url)), `Nothing is downloaded: ${fetched.join(', ')}`);
    const blocked = getCutTrackStatus() as { status: string; waitingFor?: string; message: string };
    if (blocked.status === 'pending') {
      check(blocked.waitingFor === 'download-consent' && /agreed to download/.test(blocked.message), `Pending on the download: ${JSON.stringify(blocked)}`);
      cancelObjectMask(world);
      const declined = getCutTrackStatus() as { status: string; message: string };
      check(declined.status === 'cancelled' && /without downloading/.test(declined.message), `Declining the download is said so: ${JSON.stringify(declined)}`);
      results.push('download declined');
    } else {
      check(blocked.status === 'unavailable' && /WebGPU/.test(blocked.message), `No WebGPU is said so: ${JSON.stringify(blocked)}`);
      cancelObjectMask(world);
      check(getCutTrackStatus().status === 'unavailable', 'Cancelling after does not rewrite the outcome');
      results.push('no WebGPU -> unavailable');
    }

    // ── Other ways a request ends ──────────────────────────
    trackCutObject({ clip: 'index.tsx:clip' });
    world.set(Tool, { value: ToolType.MOVE });
    settleTrackRequestOnToolDown(world);
    check(getCutTrackStatus().status === 'cancelled' && /put the Object mask tool down/.test(getCutTrackStatus().message), 'Another tool declines the request');
    trackCutObject({ clip: 'index.tsx:clip' });
    settleTrackRequestOnClose(world);
    check(/project was closed/.test(getCutTrackStatus().message), 'Closing the project cancels the request');
    trackCutObject({ clip: 'index.tsx:clip' });
    settleTrackRequestOf(clip);
    check(/clip was removed/.test(getCutTrackStatus().message), 'Removing the clip cancels the request');
    cancelObjectMask(world);
    results.push('tool down, close, removal');

    // ── Behind text ────────────────────────────────────────
    trackCutObject({ clip: 'index.tsx:clip', at: { x: 0.3, y: 0.5 }, use: 'behind', label: 'her' });
    const behindTrack = tracked();
    setObjectTrack(behindTrack);
    await finishTrackedObject(world, behindTrack);
    const behind = getCutTrackStatus() as { status: string; mask?: string; use?: string; applied?: number };
    check(behind.status === 'done' && behind.use === 'behind' && behind.applied === 1 && /^masks\/footage\/Tracking \d\.mask$/.test(behind.mask ?? ''),
      `Behind reports the text it put behind the subject: ${JSON.stringify(behind)}`);
    check(behindSubjectOf(world, title)?.clip === clip, 'The title is behind the subject');
    await Promise.resolve();
    history.undo();
    check(!behindSubjectOf(world, title), 'One undo brings the title back in front');
    results.push('confirm -> behind text, one undo');
  } finally {
    stop();
    window.fetch = realFetch;
    cancelObjectMask(world);
    setEditorSession(null);
    mounted.dispose();
    disposeDecoders(world, world.get(Root)!);
    world.destroy();
    await library.dispose();
  }
  return `PASS: track requests (${results.join(', ')})`;
}
