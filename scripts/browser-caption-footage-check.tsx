import { AssetLibrary, type ProjectFS, type Manifest, type Transcript } from '@diffusionstudio/assets';
import {
  Caption, CaptionType, Computed, Library, bindAsset, createRuntimeWorld, getActiveEntity, setActive, store,
} from '../packages/runtime/src';
import { authoredElement, createRuntimeDocument } from '../packages/reconciler/src';
import {
  applyCaptionStyle, cueSceneFrame, editableCaptions, findLongCues, seekToCue, splitCue, splitPoint,
} from '../apps/web/src/engine/caption-editing';
import { getDocumentEditor } from '../apps/web/src/engine/editor';
import { getEditHistory } from '../apps/web/src/engine/history';
import {
  assessReadability, layoutCaption, paintCaptionSample, paintSampleBackdrop, previewText,
} from '../apps/web/src/components/sidebar-right/inspector/caption-preview';
import { CAPTION_PRESET_OPTIONS, captionPresetTextStyle } from '../apps/web/src/components/sidebar-right/inspector/caption-types';
import { WorldProvider } from '@diffusionstudio/koota-solid';
import { render } from 'solid-js/web';
import { CaptionCues } from '../apps/web/src/components/sidebar-right/inspector/caption-cues';

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

  const files = new Map<string, File>();
  let manifest: Manifest | null = null;
  const fs: ProjectFS = {
    readManifest: async () => manifest, writeManifest: async value => { manifest = structuredClone(value); }, list: async () => [],
    stat: async path => { const file = files.get(path); return file ? { size: file.size, mtime: file.lastModified } : null; },
    file: async path => { const file = files.get(path); if (!file) throw Error('Missing fixture'); return file; },
    write: async (path, blob) => { files.set(path, new File([blob], path.split('/').pop()!)); },
    remove: async path => { files.delete(path); },
  };
  const library = new AssetLibrary(fs);
  const world = createRuntimeWorld('caption-footage');
  world.set(Library, library);
  const document = createRuntimeDocument(world);
  const host = globalThis.document.createElement('div');
  globalThis.document.body.append(host);
  let dispose = () => {};
  const until = async (condition: () => boolean) => {
    for (let i = 0; i < 200; i++) {
      if (condition()) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw Error(`Caption footage check timed out: ${host.textContent}`);
  };
  try {
    const asset = await library.store(new Blob([JSON.stringify(fixture)], { type: 'application/json' }), { name: 'talk.json' });
    const scene = document.createElement('Scene'); document.insertNode(document.stage, scene);
    setActive(world, scene.entity);
    const make = (source: string) => {
      const clip = document.createElement('Captions');
      document.setProperty(clip, '__source', source);
      document.setProperty(clip, 'src', asset.path);
      document.insertNode(scene, clip); bindAsset(clip.entity, asset);
      return clip.entity;
    };
    const first = make('captions-a');
    const second = make('captions-b');
    const locked = make('captions-c');
    const editor = getDocumentEditor(world);
    editor.editProperty(locked, 'locked', true);
    const history = getEditHistory(world);
    await Promise.resolve();

    // Apply to all: one step, preset and colors only, locked ones left alone.
    const { editable, skipped } = editableCaptions(world);
    if (editable.length !== 2 || skipped !== 1) throw Error(`Editable captions: ${editable.length}, skipped ${skipped}`);
    const applied = applyCaptionStyle(world, editable, { preset: 'guinea', colors: ['#112233', '#445566', '#778899'] });
    if (applied !== 2) throw Error('Apply to all must reach both unlocked captions');
    for (const entity of [first, second]) {
      if (entity.get(Caption)?.type !== CaptionType.GUINEA) throw Error('Apply to all did not change the preset');
      if (authoredElement(entity)?.props.src !== asset.path) throw Error('A style must not touch the transcript');
    }
    if (locked.get(Caption)?.type !== CaptionType.CLASSIC) throw Error('A locked caption must keep its look');
    await Promise.resolve();
    history.undo();
    if (first.get(Caption)?.type !== CaptionType.CLASSIC || second.get(Caption)?.type !== CaptionType.CLASSIC)
      throw Error('One undo must take the style off every caption it reached');
    if (authoredElement(first)?.props.preset !== undefined && authoredElement(first)?.props.preset !== false)
      throw Error('Undo must leave no preset in the file');
    history.redo();
    if (second.get(Caption)?.type !== CaptionType.GUINEA) throw Error('Redo must put the style back');
    history.undo();

    // Apply to this caption: only the one, Classic spelled as no preset.
    applyCaptionStyle(world, [first], { preset: 'stark', colors: false });
    if (first.get(Caption)?.type !== CaptionType.STARK || second.get(Caption)?.type !== CaptionType.CLASSIC)
      throw Error('Apply to this caption must reach only that caption');
    await Promise.resolve();
    history.undo();

    // Seeking to a cue: the caption starts a second into the scene.
    const computed = store(world, Computed);
    computed.origin[first.id()] = 30; computed.start[first.id()] = 30; computed.end[first.id()] = 600;
    computed.playbackRate[first.id()] = 1;
    if (!seekToCue(world, first, fixture[1]!)) throw Error('A cue on the timeline must say so');
    const playhead = computed.localTime[getActiveEntity(world)!.id()];
    if (playhead !== 30 + Math.round(2.1 * 30)) throw Error(`Seek landed on frame ${playhead}`);

    // The inspector: the warnings, and a split as one undoable step.
    dispose = render(() => <WorldProvider world={world}><CaptionCues entity={first} /></WorldProvider>, host);
    await until(() => host.querySelectorAll('textarea').length === 3);
    if (!host.querySelector('[data-long-cues]')?.textContent?.includes('2 captions')) throw Error('The long-cue summary is missing');
    const warning = [...host.querySelectorAll('button')].find(b => b.title === 'Show this caption on the timeline');
    if (!warning?.textContent?.includes('characters')) throw Error('The long cue warning must say why');
    setActive(world, scene.entity);
    computed.localTime[scene.entity.id()] = 0;
    warning.click();
    if (computed.localTime[scene.entity.id()] !== 93) throw Error('A warning must seek to its cue');
    if (globalThis.document.activeElement !== host.querySelectorAll('textarea')[1]) throw Error('A warning must put the cursor in its cue');
    const splitButton = [...host.querySelectorAll('button')].find(b => b.textContent === 'Split')!;
    splitButton.click();
    await until(() => host.querySelectorAll('textarea').length === 4);
    const revisedPath = authoredElement(first)?.props.src;
    if (revisedPath === asset.path) throw Error('A split must bind a revised transcript');
    const revised = JSON.parse(await (await (await library.resolve(String(revisedPath))).handle.getFile()).text()) as Transcript;
    if (JSON.stringify(revised.flatMap(c => c.words)) !== JSON.stringify(fixture.flatMap(c => c.words)))
      throw Error('A split must keep every word and its timing');
    await Promise.resolve();
    history.undo();
    if (authoredElement(first)?.props.src !== asset.path) throw Error('Undo must restore the unsplit captions');
    await until(() => host.querySelectorAll('textarea').length === 3);
  } finally { dispose(); host.remove(); document.dispose(); world.destroy(); await library.dispose(); }
  return drawn;
}
