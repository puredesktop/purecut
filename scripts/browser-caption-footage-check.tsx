import { AssetLibrary, type ProjectFS, type Transcript } from '@diffusionstudio/assets';
import {
  Caption, CaptionType, Computed, Library, Mode, RenderSurface, Source, Workarea, createRuntimeWorld, getActiveEntity, setActive, store,
} from '../packages/runtime/src';
import { authoredElement, mount } from '../packages/reconciler/src';
import {
  applyCaptionStyle, cueSceneFrame, editableCaptions, findLongCues, seekToCue, splitCue, splitPoint,
} from '../apps/web/src/engine/caption-editing';
import { captureFrameWithoutCaptions } from '../apps/web/src/engine/caption-frame';
import { getDocumentEditor } from '../apps/web/src/engine/editor';
import { getEditHistory } from '../apps/web/src/engine/history';
import { forgetProjectBundle, rememberProjectBundle } from '../apps/web/src/lib/db';
import {
  assessReadability, layoutCaption, paintCaptionSample, paintSampleBackdrop, previewText,
} from '../apps/web/src/components/sidebar-right/inspector/caption-preview';
import { CAPTION_PRESET_OPTIONS, captionPresetTextStyle } from '../apps/web/src/components/sidebar-right/inspector/caption-types';
import { WorldProvider } from '@diffusionstudio/koota-solid';
import { render } from 'solid-js/web';
import { ProjectProvider } from '../apps/web/src/context/project';
import { CaptionCues } from '../apps/web/src/components/sidebar-right/inspector/caption-cues';
import { CaptionFootageCheck } from '../apps/web/src/components/sidebar-right/inspector/caption-footage-check';
import type { ProjectInfo } from '../apps/web/src/projects';

const words = (text: string, start: number, each: number) =>
  text.split(' ').map((word, i) => ({ text: word, start: start + i * each, end: start + (i + 1) * each - 0.02 }));
const cue = (text: string, start: number, each: number) => ({ text, words: words(text, start, each) });

const LONG_TEXT = 'This is a caption that carries far too much text for anyone to read, because it runs well past two lines of subtitles';
const fixture: Transcript = [
  cue('Short and clear.', 0, 0.4),
  cue(LONG_TEXT, 2, 0.2),
  cue('Slow words that stay on screen for ages', 8, 1.2),
];

/** The rules alone: which cues are long, how a split keeps words and timing, where a cue plays. */
function checkRules() {
  const long = findLongCues(fixture);
  if (long.map(c => c.index).join() !== '1,2') throw Error(`Long cues found: ${JSON.stringify(long)}`);
  if (!long[0]!.reasons.includes('characters') || !long[1]!.reasons.includes('seconds'))
    throw Error('Long cues must say whether text or time makes them long');

  const point = splitPoint(fixture[1]!);
  if (fixture[1]!.words[point - 1]!.text !== 'read,') throw Error(`Split should land after the comma, got word ${point}`);
  const split = splitCue(fixture, 1);
  if (split.length !== 4) throw Error('Split must leave one more cue');
  const before = fixture[1]!.words;
  const after = [...split[1]!.words, ...split[2]!.words];
  if (JSON.stringify(before) !== JSON.stringify(after)) throw Error('Split must keep every word and its timing');
  if (`${split[1]!.text} ${split[2]!.text}` !== LONG_TEXT) throw Error('Split must keep the words of the cue');
  let refused = false;
  try { splitCue([cue('One', 0, 1)], 0); } catch { refused = true; }
  if (!refused) throw Error('A one-word cue cannot be split');

  const at = cueSceneFrame({ origin: 30, playbackRate: 2, start: 30, end: 90, fps: 30 }, 1);
  if (at.frame !== 45 || !at.onTimeline) throw Error(`Cue frame wrong: ${JSON.stringify(at)}`);
  const trimmed = cueSceneFrame({ origin: 30, playbackRate: 1, start: 60, end: 90, fps: 30 }, 0.2);
  if (trimmed.frame !== 60 || trimmed.onTimeline) throw Error('A trimmed cue lands on the clip edge and says so');
}

/**
 * The previews on bright and dark shots, on a real canvas: white text with no
 * shadow vanishes on a white shirt and reads on a night shot; Classic's shadow
 * helps it on the bright one. Returns the drawn previews for a look.
 */
function checkReadability(): Record<string, string> {
  const scene = { width: 1920, height: 1080 };
  const canvas = document.createElement('canvas');
  const drawn: Record<string, string> = {};
  const verdicts: Record<string, string> = {};
  for (const option of CAPTION_PRESET_OPTIONS) {
    for (const backdrop of ['bright', 'dark'] as const) {
      canvas.width = 480; canvas.height = 270;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      const scale = canvas.width / scene.width;
      paintSampleBackdrop(ctx, backdrop, canvas.width, canvas.height);
      const style = captionPresetTextStyle(option);
      const text = previewText(option.look, fixture[1]!, 2.5);
      const layout = layoutCaption(option.look, style, text, scene, (value, font) => { ctx.font = font; return ctx.measureText(value).width; });
      if (!text.lines.length || layout.block.width <= 0) throw Error(`${option.label} laid out nothing`);
      if (layout.block.x < 0 || layout.block.x + layout.block.width > scene.width + 1)
        throw Error(`${option.label} runs off the picture: ${JSON.stringify(layout.block)}`);
      const { x, y, width, height } = layout.block;
      const pixels = ctx.getImageData(Math.floor(x * scale), Math.floor(y * scale), Math.ceil(width * scale), Math.ceil(height * scale)).data;
      verdicts[`${option.name}:${backdrop}`] = assessReadability(pixels, 0xffffff, option.look).verdict;
      paintCaptionSample(ctx, { look: option.look, style, layout, text, fill: 0xffffff, colors: option.slots.map(s => s.defaultColor), scale });
      drawn[`${option.name}-${backdrop}`] = canvas.toDataURL('image/png');
    }
  }
  if (verdicts['whisper:bright'] !== 'lost') throw Error(`White Whisper on a bright shot must read as lost: ${JSON.stringify(verdicts)}`);
  if (verdicts['whisper:dark'] !== 'clear') throw Error(`White Whisper on a dark shot must read clearly: ${JSON.stringify(verdicts)}`);
  if (verdicts['classic:bright'] === 'lost') throw Error(`Classic's shadow must help on a bright shot: ${JSON.stringify(verdicts)}`);
  const grey = new Uint8ClampedArray(400).fill(128);
  if (assessReadability(grey, 0xffffff, { difference: true }).verdict !== 'lost') throw Error('Stark vanishes on mid grey');
  const spotlight = previewText(CAPTION_PRESET_OPTIONS.find(o => o.name === 'spotlight')!.look, fixture[0]!, 0.5);
  if (spotlight.activeWord?.index !== 1) throw Error('Spotlight marks the word being spoken');
  const paper = previewText(CAPTION_PRESET_OPTIONS.find(o => o.name === 'paper')!.look, fixture[2]!, 8.1);
  if (paper.lines.length !== 2) throw Error('Paper shows two lines');
  return drawn;
}

export async function checkCaptionFootage(): Promise<Record<string, string>> {
  checkRules();
  const drawn = checkReadability();
  const check = (value: unknown, message: string) => { if (!value) throw Error(message); };

  const files = new Map<string, File>();
  const fs: ProjectFS = {
    readManifest: async () => null, writeManifest: async () => {}, list: async () => [],
    stat: async path => { const file = files.get(path); return file ? { size: file.size, mtime: file.lastModified } : null; },
    file: async path => { const file = files.get(path); if (!file) throw Error('Missing fixture'); return file; },
    write: async (path, blob) => { files.set(path, new File([blob], path.split('/').pop()!)); },
    remove: async path => { files.delete(path); },
  };
  const library = new AssetLibrary(fs);
  const asset = await library.store(new Blob([JSON.stringify(fixture)], { type: 'application/json' }), { name: 'talk.json' });
  const { compile } = await import('../purecut/compiler-runtime.js') as { compile(source: string): { ok: boolean; code?: string; error?: string } };
  const compiled = compile(`export default () => (
    <stage>
      <scene active id="footage-scene" width={640} height={360} fill="#101820" workarea={[10, 20]}>
        <rect id="early" width={640} height={360} end={10} fill="#101820" />
        <rect id="late" width={640} height={360} start={10} end={20} fill="#ffffff" />
        <captions id="captions-a" src="${asset.path}" preset="spotlight" colors={['#000000']}
          fontSize={96} fontFamily="Inter" fontWeight="bold" fontStyle="italic" letterSpacing={2} end={20} />
        <captions id="captions-b" src="${asset.path}" preset="spotlight" end={20} />
        <captions id="captions-c" src="${asset.path}" preset="spotlight" locked end={20} />
      </scene>
    </stage>
  );`);
  check(compiled.ok, `The caption footage fixture compiles: ${compiled.error}`);

  const projectId = 'caption-footage-fixture';
  await rememberProjectBundle(projectId, compiled.code!);
  const world = createRuntimeWorld(projectId);
  world.set(Library, library);
  world.set(Mode, { value: 'realtime' });
  const surface = globalThis.document.createElement('canvas');
  world.set(RenderSurface, { canvas: surface, ctx: surface.getContext('2d'), resolution: 1 });
  const mounted = mount(compiled.code!, world);
  const byStamp = (stamp: string) => world.query(Source).find(entity => entity.get(Source)?.value === `index.tsx:${stamp}`)!;
  const scene = byStamp('footage-scene');
  const first = byStamp('captions-a');
  const second = byStamp('captions-b');
  const locked = byStamp('captions-c');
  check(scene && first && second && locked, 'The caption footage fixture mounts');
  setActive(world, scene);
  const host = globalThis.document.createElement('div');
  globalThis.document.body.append(host);
  let dispose = () => {};
  const until = async (condition: () => boolean) => {
    for (let i = 0; i < 500; i++) {
      if (condition()) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw Error(`Caption footage check timed out: ${host.textContent}`);
  };
  try {
    const computed = store(world, Computed);
    computed.localTime[scene.id()] = 60;
    computed.localTime[first.id()] = 60;

    // The real capture path: at two seconds the footage is dark, although the
    // ten-to-twenty-second work area would make the old relative capture white.
    const frame = await captureFrameWithoutCaptions(world, scene);
    const proof = globalThis.document.createElement('canvas');
    proof.width = frame.width; proof.height = frame.height;
    const proofContext = proof.getContext('2d')!;
    proofContext.drawImage(frame, 0, 0);
    frame.close();
    const pixel = proofContext.getImageData(0, 0, 1, 1).data;
    check(pixel[0]! < 40 && pixel[1]! < 40 && pixel[2]! < 40,
      `Capture must use the absolute playhead before the work area, got ${[...pixel].join(',')}`);
    check(scene.get(Workarea)?.start === 300, 'Capture must leave the editor work area intact');

    const history = getEditHistory(world);
    await Promise.resolve();

    // Apply to all: one step, preset and colors only, locked ones left alone.
    const { editable, skipped } = editableCaptions(world);
    check(editable.length === 2 && skipped === 1, `Editable captions: ${editable.length}, skipped ${skipped}`);
    const applied = applyCaptionStyle(world, editable, { preset: 'guinea', colors: ['#112233', '#445566', '#778899'] });
    check(applied === 2, 'Apply to all must reach both unlocked captions');
    for (const entity of [first, second]) {
      check(entity.get(Caption)?.type === CaptionType.GUINEA, 'Apply to all did not change the preset');
      check(authoredElement(entity)?.props.src === asset.path, 'A style must not touch the transcript');
    }
    check(locked.get(Caption)?.type === CaptionType.SPOTLIGHT, 'A locked caption must keep its look');
    await Promise.resolve();
    history.undo();
    check(first.get(Caption)?.type === CaptionType.SPOTLIGHT && second.get(Caption)?.type === CaptionType.SPOTLIGHT,
      'One undo must take the style off every caption it reached');
    check(authoredElement(first)?.props.preset === 'spotlight', 'Undo must restore the authored preset');
    history.redo();
    check(second.get(Caption)?.type === CaptionType.GUINEA, 'Redo must put the style back');
    history.undo();

    // Apply to this caption: only the one.
    applyCaptionStyle(world, [first], { preset: 'stark', colors: false });
    check(first.get(Caption)?.type === CaptionType.STARK && second.get(Caption)?.type === CaptionType.SPOTLIGHT,
      'Apply to this caption must reach only that caption');
    await Promise.resolve();
    history.undo();

    // Seeking to a cue: the caption starts a second into the scene.
    computed.origin[first.id()] = 30; computed.start[first.id()] = 30; computed.end[first.id()] = 600;
    computed.playbackRate[first.id()] = 1;
    check(seekToCue(world, first, fixture[1]!), 'A cue on the timeline must say so');
    const playhead = computed.localTime[getActiveEntity(world)!.id()];
    check(playhead === 30 + Math.round(2.1 * 30), `Seek landed on frame ${playhead}`);

    // The cue editor: the warnings, and a split as one undoable step.
    dispose = render(() => <WorldProvider world={world}><CaptionCues entity={first} /></WorldProvider>, host);
    await until(() => host.querySelectorAll('textarea').length === 3);
    check(host.querySelector('[data-long-cues]')?.textContent?.includes('2 captions'), 'The long-cue summary is missing');
    const warning = [...host.querySelectorAll('button')].find(b => b.title === 'Show this caption on the timeline');
    check(warning?.textContent?.includes('characters'), 'The long cue warning must say why');
    setActive(world, scene);
    computed.localTime[scene.id()] = 0;
    warning!.click();
    check(computed.localTime[scene.id()] === 93, 'A warning must seek to its cue');
    check(globalThis.document.activeElement === host.querySelectorAll('textarea')[1], 'A warning must put the cursor in its cue');
    const splitButton = [...host.querySelectorAll('button')].find(b => b.textContent === 'Split')!;
    splitButton.click();
    await until(() => host.querySelectorAll('textarea').length === 4);
    const revisedPath = authoredElement(first)?.props.src;
    check(revisedPath !== asset.path, 'A split must bind a revised transcript');
    const revised = JSON.parse(await (await (await library.resolve(String(revisedPath))).handle.getFile()).text()) as Transcript;
    check(JSON.stringify(revised.flatMap(c => c.words)) === JSON.stringify(fixture.flatMap(c => c.words)),
      'A split must keep every word and its timing');
    await Promise.resolve();
    history.undo();
    check(authoredElement(first)?.props.src === asset.path, 'Undo must restore the unsplit captions');
    await until(() => host.querySelectorAll('textarea').length === 3);
    dispose();
    dispose = () => {};

    // The actual footage panel, including its real frame capture and Apply
    // buttons. The authored Spotlight has white text but a black highlight.
    computed.localTime[scene.id()] = 60;
    computed.localTime[first.id()] = 60;
    dispose = render(() => <ProjectProvider project={{ id: projectId, dir: '', displayName: 'Caption footage' } as ProjectInfo}>
      <WorldProvider world={world}>
        <CaptionFootageCheck entity={first} current={CAPTION_PRESET_OPTIONS.find(o => o.name === 'spotlight')!} currentColors={[0x000000]} />
      </WorldProvider>
    </ProjectProvider>, host);
    await until(() => host.textContent?.includes('Frame at 0:02') === true);
    check(host.textContent?.includes('Highlight hard to read'), 'The panel must judge the black highlight on dark footage');
    const preview = host.querySelector<HTMLCanvasElement>('canvas[aria-label="Spotlight on this frame"]')!;
    const previewPixel = preview.getContext('2d')!.getImageData(0, 0, 1, 1).data;
    check(previewPixel[0]! < 40 && previewPixel[1]! < 40 && previewPixel[2]! < 40,
      'The panel preview must show the captured playhead frame');

    const whisper = [...host.querySelectorAll<HTMLButtonElement>('button[role="radio"]')]
      .find(button => button.textContent?.includes('Whisper'))!;
    whisper.click();
    const applyThis = [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Apply to this caption')!;
    applyThis.click();
    await Promise.resolve();
    check(first.get(Caption)?.type === CaptionType.WHISPER && second.get(Caption)?.type === CaptionType.SPOTLIGHT,
      'Apply to this caption in the panel must change only the selected caption');
    check(authoredElement(first)?.props.fontSize === 96 && authoredElement(first)?.props.fontStyle === 'italic',
      'Applying a preview must preserve the authored style shown in that preview');

    const applyAll = [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Apply to all captions')!;
    applyAll.click();
    await Promise.resolve();
    check(first.get(Caption)?.type === CaptionType.WHISPER && second.get(Caption)?.type === CaptionType.WHISPER,
      'Apply to all captions in the panel must change every unlocked caption');
    check(locked.get(Caption)?.type === CaptionType.SPOTLIGHT, 'Apply to all in the panel must leave locked captions alone');

    computed.localTime[scene.id()] = 30;
    computed.localTime[first.id()] = 30;
    const refresh = [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Use playhead frame')!;
    refresh.click();
    await until(() => host.textContent?.includes('Frame at 0:01') === true);
  } finally {
    dispose();
    host.remove();
    mounted.dispose();
    world.destroy();
    await forgetProjectBundle(projectId);
    await library.dispose();
  }
  return drawn;
}
