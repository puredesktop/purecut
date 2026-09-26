import { AssetLibrary, type ProjectFS } from '@diffusionstudio/assets';
import { createRuntimeWorld, Library, Workarea, getSourceFrameAt } from '../packages/runtime/src';
import { createRuntimeDocument } from '../packages/reconciler/src';
import { collectSceneSubtitles } from '../apps/web/src/engine/subtitle-export';
import { SubtitleExport } from '../apps/web/src/components/sidebar-right/inspector/subtitle-export';
import { WorldProvider } from '@diffusionstudio/koota-solid';
import { render } from 'solid-js/web';
import { parseSubtitles } from '../packages/runtime/src/media/caption/subtitles';

export async function checkTimelineSubtitles() {
  const files = new Map<string, File>();
  const fs: ProjectFS = {
    readManifest: async () => null, writeManifest: async () => {}, list: async () => [],
    stat: async path => { const file = files.get(path); return file ? { size: file.size, mtime: file.lastModified } : null; },
    file: async path => { const file = files.get(path); if (!file) throw Error('Missing fixture'); return file; },
    write: async (path, blob) => { files.set(path, new File([blob], path.split('/').pop()!)); },
    remove: async path => { files.delete(path); },
  };
  const library = new AssetLibrary(fs);
  const world = createRuntimeWorld('timeline-subtitles'); world.set(Library, library);
  const document = createRuntimeDocument(world);
  const transcript = [
    { text: 'trimmed', words: [{ text: 'trimmed', start: 0, end: 2 }] },
    { text: 'first second', words: [{ text: 'first', start: 2, end: 4 }, { text: 'second', start: 4, end: 6 }] },
    { text: 'later', words: [{ text: 'later', start: 6, end: 8 }] },
  ];
  try {
    const asset = await library.store(new Blob([JSON.stringify(transcript)], { type: 'application/json' }), { name: 'captions.json' });
    const scene = document.createElement('Scene'); document.insertNode(document.stage, scene);
    const background = document.createElement('Rect'); document.setProperty(background, 'end', 10); document.insertNode(scene, background);
    const clip = document.createElement('Captions');
    for (const [key, value] of Object.entries({ src: asset.path, start: 4, end: 8, sourceIn: 2, playbackRate: 2 })) document.setProperty(clip, key, value);
    document.insertNode(scene, clip);
    if (getSourceFrameAt(clip.entity, 120) !== 60) throw Error('Fixture source mapping is not the expected trimmed 2x timeline');
    scene.entity.add(Workarea); scene.entity.set(Workarea, { start: 135, end: 180 });
    const output = await collectSceneSubtitles(world, scene.entity);
    if (output.length !== 1 || output[0].text !== 'first second' || output[0].words[0].start !== 0 || output[0].words[0].end !== 0.5 || output[0].words[1].start !== 0.5 || output[0].words[1].end !== 1.5)
      throw Error(`Timeline subtitles do not match trimmed, sped-up work area: ${JSON.stringify(output)}`);
    const pending = collectSceneSubtitles(world, scene.entity);
    document.setProperty(clip, 'playbackRate', 0.5);
    if (JSON.stringify(await pending) !== JSON.stringify(output)) throw Error('Subtitle export mixed timeline revisions while reading source');
    document.setProperty(clip, 'playbackRate', 2);
    const host = globalThis.document.createElement('div');
    globalThis.document.body.append(host);
    const previousPicker = window.showSaveFilePicker;
    let saved = '', filename = '';
    window.showSaveFilePicker = async options => {
      filename = options?.suggestedName ?? '';
      return { createWritable: async () => new WritableStream({ write(bytes) { saved += new TextDecoder().decode(bytes); } }) } as FileSystemFileHandle;
    };
    const dispose = render(() => <WorldProvider world={world}><SubtitleExport scene={scene.entity} /></WorldProvider>, host);
    try {
      const button = host.querySelector<HTMLButtonElement>('[aria-label="Export subtitles"]')!;
      if (!button) throw Error('Subtitle export action is missing');
      button.click();
      for (let i = 0; i < 200 && (!saved || button.disabled); i++) await new Promise(resolve => setTimeout(resolve, 10));
      const cues = parseSubtitles(saved);
      if (button.disabled || filename !== 'subtitles.srt' || cues[0]?.text !== 'first second' || cues[0].words[0].start !== 0 || cues[0].words.at(-1)?.end !== 1.5)
        throw Error(`Subtitle export control wrote incorrect work-area output: ${filename}: ${saved}`);
    } finally { dispose(); host.remove(); window.showSaveFilePicker = previousPicker; }
    document.setProperty(clip, 'hidden', true);
    if ((await collectSceneSubtitles(world, scene.entity)).length) throw Error('Hidden captions were exported');
    document.setProperty(clip, 'hidden', false);
    document.setProperty(scene, 'hidden', true);
    if ((await collectSceneSubtitles(world, scene.entity)).length) throw Error('Captions from a hidden parent were exported');
    document.setProperty(scene, 'hidden', false);
    scene.entity.set(Workarea, { start: 0, end: 0 });
    const full = await collectSceneSubtitles(world, scene.entity);
    if (full[0]?.words[0].start !== 4 || full.at(-1)?.words.at(-1)?.end !== 7) throw Error('Full-scene export lost caption placement');
    document.setProperty(clip, 'playbackRate', 0.5);
    const slow = await collectSceneSubtitles(world, scene.entity);
    if (slow[0]?.words[0].start !== 4 || slow.at(-1)?.words.at(-1)?.end !== 8) throw Error(`Slow caption mapping failed: ${JSON.stringify(slow)}`);
    document.setProperty(clip, 'hidden', true);
    const group = document.createElement('Group');
    document.setProperty(group, 'start', 2); document.setProperty(group, 'end', 4); document.insertNode(scene, group);
    const nested = document.createElement('Captions');
    for (const [key, value] of Object.entries({ src: asset.path, start: 1, end: 5 })) document.setProperty(nested, key, value);
    document.insertNode(group, nested);
    const grouped = await collectSceneSubtitles(world, scene.entity);
    if (grouped.length !== 1 || grouped[0].text !== 'trimmed' || grouped[0].words[0].start !== 3 || grouped[0].words[0].end !== 4)
      throw Error(`Subtitle export must clip nested captions to parent span: ${JSON.stringify(grouped)}`);
  } finally { document.dispose(); world.destroy(); await library.dispose(); }
}
