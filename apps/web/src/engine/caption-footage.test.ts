import { describe, expect, it, vi } from 'vitest';

// The runtime builds a few geometry constants as it loads; Node has no
// DOMMatrix, and nothing here draws, so an identity stand-in is enough.
vi.hoisted(() => {
  const scope = globalThis as Record<string, unknown>;
  scope.DOMMatrix ??= class {
    a = 1; b = 0; c = 0; d = 1; e = 0; f = 0;
    multiply() { return this; } inverse() { return this; } translate() { return this; } scale() { return this; }
  };
  scope.HTMLCanvasElement ??= class {};
  scope.HTMLElement ??= class {};
  scope.Element ??= class {};
  scope.Node ??= class {};
  scope.Text ??= class {};
  scope.HTMLImageElement ??= class {};
  scope.HTMLVideoElement ??= class {};
});
// The frame capture renders through the app's project loader and the
// encoder; only its preparation of the capture world is under test here.
vi.mock('./capture', () => ({ createCapture: vi.fn() }));
vi.mock('@diffusionstudio/encoder', () => ({ createImageEncoder: vi.fn(), decodePng: vi.fn() }));
import { AssetLibrary, type Manifest, type ProjectFS, type Transcript } from '@diffusionstudio/assets';
import {
  Caption, CaptionType, Color, Computed, FontStyle, Hidden, Library, TextAlign, TextBaseline, TextCase, TextStyle, Workarea,
  bindAsset, createRuntimeWorld, getActiveEntity, setActive, store,
} from '@diffusionstudio/runtime';
import { authoredElement, createRuntimeDocument } from '@diffusionstudio/reconciler';
import {
  applyCaptionStyle, cueSceneFrame, describeLongCue, editableCaptions, findLongCues, seekToCue, splitCaptionCue, splitCue, splitPoint,
} from './caption-editing';
import { prepareCaptionFrame } from './caption-frame';
import { getDocumentEditor } from './editor';
import { getEditHistory } from './history';
import {
  assessCaptionPaints, assessReadability, highlightColors,
} from '../components/sidebar-right/inspector/caption-preview';
import {
  CAPTION_PRESET_OPTIONS, captionStyleFor,
} from '../components/sidebar-right/inspector/caption-types';

const words = (text: string, start: number, each: number) =>
  text.split(' ').map((word, i) => ({ text: word, start: start + i * each, end: start + (i + 1) * each - 0.02 }));
const cue = (text: string, start: number, each: number) => ({ text, words: words(text, start, each) });

const LONG_TEXT = 'This is a caption that carries far too much text for anyone to read, because it runs well past two lines of subtitles';
const fixture: Transcript = [
  cue('Short and clear.', 0, 0.4),
  cue(LONG_TEXT, 2, 0.2),
  cue('Slow words that stay on screen for ages', 8, 1.2),
];
const option = (name: string) => CAPTION_PRESET_OPTIONS.find(o => o.name === name)!;

/** A patch of picture, as RGBA: a white shirt, a night sky, mid grey. */
const patch = (r: number, g: number, b: number, size = 64) => {
  const pixels = new Uint8ClampedArray(size * 4);
  for (let i = 0; i < pixels.length; i += 4) { pixels[i] = r; pixels[i + 1] = g; pixels[i + 2] = b; pixels[i + 3] = 255; }
  return pixels;
};
const BRIGHT = patch(250, 248, 240);
const DARK = patch(20, 26, 38);

describe('long caption cues', () => {
  it('flags cues with too much text or too long on screen, and says why', () => {
    const long = findLongCues(fixture);
    expect(long.map(c => c.index)).toEqual([1, 2]);
    expect(long[0]!.reasons).toEqual(['characters']);
    expect(long[1]!.reasons).toEqual(['seconds']);
    expect(describeLongCue(long[0]!)).toMatch(/^\d+ characters, more than two lines$/);
    expect(describeLongCue(long[1]!)).toMatch(/seconds on screen/);
    expect(findLongCues([cue('Short and clear.', 0, 0.4)])).toEqual([]);
  });

  it('splits at a natural break, keeping every word and its timing', () => {
    expect(fixture[1]!.words[splitPoint(fixture[1]!) - 1]!.text).toBe('read,');
    const split = splitCue(fixture, 1);
    expect(split).toHaveLength(4);
    expect([...split[1]!.words, ...split[2]!.words]).toEqual(fixture[1]!.words);
    expect(`${split[1]!.text} ${split[2]!.text}`).toBe(LONG_TEXT);
    expect(split[0]).toBe(fixture[0]);
    expect(() => splitCue([cue('One', 0, 1)], 0)).toThrow(/one word/);
    expect(() => splitCue(fixture, 1, 0)).toThrow(/between two of its words/);
  });

  it('maps a cue to the scene frame it plays on', () => {
    expect(cueSceneFrame({ origin: 30, playbackRate: 2, start: 30, end: 90, fps: 30 }, 1)).toEqual({ frame: 45, onTimeline: true });
    expect(cueSceneFrame({ origin: 30, playbackRate: 1, start: 60, end: 90, fps: 30 }, 0.2)).toEqual({ frame: 60, onTimeline: false });
  });
});

describe('caption previews', () => {
  it('judges the highlight colors, not only the base text', () => {
    const spotlight = option('spotlight').look;
    // A black spoken word on a night shot: the white text reads, the word does not.
    expect(assessReadability(DARK, 0xffffff, spotlight).verdict).toBe('clear');
    const black = assessCaptionPaints(DARK, { text: 0xffffff, highlights: highlightColors(spotlight, [0x000000]) }, spotlight);
    expect(black).toMatchObject({ verdict: 'lost', weakest: 'highlight' });
    // Guinea cycles through all three slots: one failing slot fails the preset.
    const guinea = option('guinea').look;
    expect(highlightColors(guinea, [1, 2, 3])).toEqual([1, 2, 3]);
    const third = assessCaptionPaints(DARK, { text: 0xffffff, highlights: highlightColors(guinea, [0xf55353, 0xfeb139, 0x101010]) }, guinea);
    expect(third).toMatchObject({ verdict: 'lost', weakest: 'highlight' });
    const allGood = assessCaptionPaints(DARK, { text: 0xffffff, highlights: highlightColors(guinea, [0xf55353, 0xfeb139, 0xf6f54d]) }, guinea);
    expect(allGood.verdict).toBe('clear');
    // Presets without a color accent have no highlight to judge.
    expect(highlightColors(option('paper').look, [0x000000])).toEqual([]);
  });

  it('judges white captions lost on a bright shot and clear on a dark one', () => {
    const whisper = option('whisper').look;
    expect(assessReadability(BRIGHT, 0xffffff, whisper).verdict).toBe('lost');
    expect(assessReadability(DARK, 0xffffff, whisper).verdict).toBe('clear');
    // Classic's shadow darkens what is behind the letters.
    expect(assessReadability(patch(150, 150, 150), 0xffffff, option('classic').look).verdict).toBe('clear');
    expect(assessReadability(patch(150, 150, 150), 0xffffff, whisper).verdict).toBe('lost');
    // Stark inverts the picture: clear on white and black, gone on mid grey.
    const stark = option('stark').look;
    expect(assessReadability(BRIGHT, 0xffffff, stark).verdict).toBe('clear');
    expect(assessReadability(patch(128, 128, 128), 0xffffff, stark).verdict).toBe('lost');
    // A shot half white, half dark is patchy.
    const mixed = new Uint8ClampedArray([...patch(250, 250, 250, 20), ...patch(10, 10, 10, 80)]);
    expect(assessReadability(mixed, 0xffffff, whisper).verdict).toBe('patchy');
  });
});

describe('previews follow the caption the document will draw', () => {
  it('uses the caption\'s own style over each preset, as applying the preset would', () => {
    const world = createRuntimeWorld(`caption-style-${Math.random()}`);
    const document = createRuntimeDocument(world);
    try {
      const scene = document.createElement('Scene'); document.insertNode(document.stage, scene);
      const clip = document.createElement('Captions');
      document.setProperty(clip, '__source', 'captions-styled');
      const authored = { fontSize: 140, fontFamily: 'Inter', fontWeight: 'bold', textCase: 'upper', letterSpacing: 4, fill: '#ffcc00' };
      for (const [key, value] of Object.entries(authored)) document.setProperty(clip, key, value);
      document.insertNode(scene, clip);
      for (const preset of CAPTION_PRESET_OPTIONS) {
        // What the document writes when the preset changes, against the preview's reading of it.
        document.setProperty(clip, 'preset', preset.name);
        const drawn = clip.entity.get(TextStyle)!;
        const { style, fill } = captionStyleFor(preset, authoredElement(clip.entity)!.props);
        for (const key of ['fontSize', 'fontFamily', 'fontWeight', 'fontStyle', 'textAlign', 'textBaseline', 'textCase', 'letterSpacing', 'leading'] as const)
          expect(style[key], `${preset.name} ${key}`).toBe(drawn[key]);
        expect(fill, preset.name).toBe(clip.entity.get(Color)?.value);
        expect(style).toMatchObject({ fontSize: 140, fontFamily: 'Inter', fontWeight: '700', textCase: TextCase.UPPER, letterSpacing: 4 });
      }
    } finally { document.dispose(); world.destroy(); }
  });

  it('uses renderer defaults when an authored override is invalid', () => {
    const { style } = captionStyleFor(option('whisper'), {
      fontSize: 0, fontFamily: ' ', fontWeight: 'heavy', fontStyle: 'sideways', textAlign: 'justify',
      textBaseline: 'hanging', textCase: 'title', leading: 0, letterSpacing: 'wide',
    });
    expect(style).toEqual({
      fontSize: 16, fontFamily: 'Inter', fontWeight: '400', fontStyle: FontStyle.NORMAL,
      textAlign: TextAlign.LEFT, textBaseline: TextBaseline.TOP, textCase: TextCase.ORIGINAL,
      leading: 1, letterSpacing: undefined,
    });
  });

  it('captures the playhead frame even before a work area that starts later', () => {
    const world = createRuntimeWorld(`caption-frame-${Math.random()}`);
    const document = createRuntimeDocument(world);
    try {
      const scene = document.createElement('Scene'); document.insertNode(document.stage, scene);
      const clip = document.createElement('Captions');
      document.setProperty(clip, '__source', 'captions-frame');
      document.insertNode(scene, clip);
      // A work area from 10 s at 30 fps, with the playhead at 2 s.
      scene.entity.add(Workarea);
      scene.entity.set(Workarea, { start: 300, end: 600 });
      const frame = prepareCaptionFrame(world, scene.entity, 60);
      expect(frame).toBe(60);
      expect(scene.entity.has(Workarea)).toBe(false);
      expect(clip.entity.has(Hidden)).toBe(true);
    } finally { document.dispose(); world.destroy(); }
  });
});

describe('applying a caption style', () => {
  const setup = async () => {
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
    const world = createRuntimeWorld(`caption-footage-${Math.random()}`);
    world.set(Library, library);
    const document = createRuntimeDocument(world);
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
    const captions = [make('captions-a'), make('captions-b'), make('captions-c')];
    const history = getEditHistory(world);
    const dispose = async () => { document.dispose(); world.destroy(); await library.dispose(); };
    return { world, library, asset, captions, history, dispose };
  };

  it('applies to every unlocked caption as one undo step, leaving words and timing alone', async () => {
    const { world, asset, captions: [first, second, locked], history, dispose } = await setup();
    try {
      getDocumentEditor(world).editProperty(locked!, 'locked', true);
      await Promise.resolve();
      const { editable, skipped } = editableCaptions(world);
      expect(editable).toEqual([first, second]);
      expect(skipped).toBe(1);
      expect(applyCaptionStyle(world, editable, { preset: 'guinea', colors: ['#112233', '#445566', '#778899'] })).toBe(2);
      for (const entity of [first!, second!]) {
        expect(entity.get(Caption)?.type).toBe(CaptionType.GUINEA);
        expect(entity.get(Caption)?.colors).toEqual([0x112233, 0x445566, 0x778899]);
        expect(authoredElement(entity)?.props.src).toBe(asset.path);
      }
      expect(locked!.get(Caption)?.type).toBe(CaptionType.CLASSIC);
      await Promise.resolve();
      history.undo();
      expect(first!.get(Caption)?.type).toBe(CaptionType.CLASSIC);
      expect(second!.get(Caption)?.type).toBe(CaptionType.CLASSIC);
      expect(authoredElement(first!)?.props.colors ?? false).toBe(false);
      history.redo();
      expect(second!.get(Caption)?.type).toBe(CaptionType.GUINEA);
    } finally { await dispose(); }
  });

  it('applies to this caption only, and spells Classic as no preset', async () => {
    const { world, captions: [first, second], history, dispose } = await setup();
    try {
      applyCaptionStyle(world, [first!], { preset: 'stark', colors: false });
      expect(first!.get(Caption)?.type).toBe(CaptionType.STARK);
      expect(second!.get(Caption)?.type).toBe(CaptionType.CLASSIC);
      await Promise.resolve();
      applyCaptionStyle(world, [first!], { preset: 'classic', colors: false });
      expect(authoredElement(first!)?.props.preset ?? false).toBe(false);
      await Promise.resolve();
      history.undo();
      expect(first!.get(Caption)?.type).toBe(CaptionType.STARK);
    } finally { await dispose(); }
  });

  it('seeks to a long cue and splits it as one undoable source change', async () => {
    const { world, library, asset, captions: [first], history, dispose } = await setup();
    try {
      const computed = store(world, Computed);
      Object.assign(computed.origin, { [first!.id()]: 30 });
      Object.assign(computed.start, { [first!.id()]: 30 });
      Object.assign(computed.end, { [first!.id()]: 600 });
      Object.assign(computed.playbackRate, { [first!.id()]: 1 });
      expect(seekToCue(world, first!, fixture[1]!)).toBe(true);
      expect(computed.localTime[getActiveEntity(world)!.id()]).toBe(30 + Math.round(2.1 * 30));

      await splitCaptionCue(world, first!, asset.id, 1);
      const revisedPath = authoredElement(first!)?.props.src;
      expect(revisedPath).not.toBe(asset.path);
      const revised = JSON.parse(await (await (await library.resolve(String(revisedPath))).handle.getFile()).text()) as Transcript;
      expect(revised).toHaveLength(4);
      expect(revised.flatMap(c => c.words)).toEqual(fixture.flatMap(c => c.words));
      await Promise.resolve();
      history.undo();
      expect(authoredElement(first!)?.props.src).toBe(asset.path);
    } finally { await dispose(); }
  });
});
