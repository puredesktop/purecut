import { AssetLibrary, type ProjectFS } from '@diffusionstudio/assets';
import { createRuntimeWorld, Library } from '../packages/runtime/src';
import { createRuntimeDocument } from '../packages/reconciler/src';
import { rememberProjectBundle, forgetProjectBundle } from '../apps/web/src/lib/db';
import { renderScene } from '../apps/web/src/context/render';
import { CAPTION_PRESET_OPTIONS } from '../apps/web/src/components/sidebar-right/inspector/caption-types';
import type { Engine } from '../apps/web/src/engine';

type Counts = { white: number; green: number; cyan: number; red: number };

/**
 * Renders a Spotlight caption to video and reads the highlighted word's colour
 * back from the decoded frames. The default highlight is #19FF75 (upstream
 * f2a8258), and an authored `colors` entry still replaces it. Run with every
 * remote font host blocked: Spotlight's face, Outfit, ships inside the app, so
 * it must still load and draw.
 */
async function renderSpotlight(id: string, colors?: string[]): Promise<Counts> {
  const files = new Map<string, File>();
  const fs: ProjectFS = {
    readManifest: async () => null, writeManifest: async () => {}, list: async () => [],
    stat: async path => { const file = files.get(path); return file ? { size: file.size, mtime: file.lastModified } : null; },
    file: async path => { const file = files.get(path); if (!file) throw Error('Missing fixture'); return file; },
    write: async (path, blob) => { files.set(path, new File([blob], path.split('/').pop()!)); },
    remove: async path => { files.delete(path); },
  };
  const library = new AssetLibrary(fs);
  const world = createRuntimeWorld(id); world.set(Library, library);
  const document = createRuntimeDocument(world);
  try {
    // Two words in one group: the first is spoken (highlighted) from 0 to 1 s.
    const transcript = [{ text: 'MMM WWW', words: [{ text: 'MMM', start: 0, end: 1 }, { text: 'WWW', start: 1, end: 2 }] }];
    await library.store(new Blob([JSON.stringify(transcript)], { type: 'application/json' }), { name: 'captions.json' });
    const scene = document.createElement('Scene');
    document.setProperty(scene, '__source', 'caption-scene'); document.insertNode(document.stage, scene);
    const captions = document.createElement('Captions');
    document.setProperty(captions, 'src', 'captions.json'); document.setProperty(captions, 'end', 2);
    document.setProperty(captions, 'preset', 'spotlight');
    if (colors) document.setProperty(captions, 'colors', colors);
    document.insertNode(scene, captions);
    await rememberProjectBundle(id, `
      const { Stage, Scene, Rect, Captions } = require('@diffusionstudio/jsx');
      module.exports.default = () => Stage({ get children() {
        return Scene({ __source: 'caption-scene', width: 640, height: 360, get children() {
          return [Rect({ width: 640, height: 360, end: 2, fill: '#000000' }),
            Captions(${JSON.stringify({ src: 'captions.json', end: 2, preset: 'spotlight', ...(colors ? { colors } : {}) })})];
        }});
      }});
    `);
    const chunks: { position: number; data: Uint8Array }[] = [];
    const result = await renderScene({ world, stop() {}, start() {} } as unknown as Engine, {
      scene: scene.entity,
      target: { createWritable: async () => new WritableStream({ write(chunk: { position: number; data: Uint8Array }) {
        chunks.push({ position: chunk.position, data: chunk.data.slice() });
      } }) },
      config: { format: 'webm', video: { codec: 'vp8', resolution: 360, fps: 30, bitrate: 4_000_000 }, audio: { enabled: false } },
    });
    if (result.type !== 'success') throw Error(`Spotlight caption render failed: ${JSON.stringify(result)}`);
    const bytes = new Uint8Array(Math.max(...chunks.map(chunk => chunk.position + chunk.data.length)));
    for (const chunk of chunks) bytes.set(chunk.data, chunk.position);
    const url = URL.createObjectURL(new Blob([bytes], { type: 'video/webm' }));
    const video = globalThis.document.createElement('video'); video.muted = true;
    globalThis.document.body.append(video);
    const canvas = globalThis.document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
    const context = canvas.getContext('2d', { willReadFrequently: true })!;
    const count = (): Counts => {
      context.drawImage(video, 0, 0);
      const pixels = context.getImageData(0, 0, 640, 360).data;
      const counts = { white: 0, green: 0, cyan: 0, red: 0 };
      for (let i = 0; i < pixels.length; i += 4) {
        const r = pixels[i]!, g = pixels[i + 1]!, b = pixels[i + 2]!;
        if (r > 180 && g > 180 && b > 180) counts.white++;
        else if (g > 170 && r < 110 && b > 60 && b < 175) counts.green++; // #19FF75
        else if (g > 150 && r < 110 && b > 200) counts.cyan++; // old #24D5FF
        else if (r > 170 && g < 90 && b < 90) counts.red++;
      }
      return counts;
    };
    try {
      return await new Promise<Counts>((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('Spotlight caption playback timed out')), 10000);
        const fail = (error: unknown) => { clearTimeout(timer); reject(error); };
        video.onerror = () => fail(Error(`Spotlight caption decode failed: ${video.error?.message}`));
        video.onloadeddata = () => { void video.play().catch(fail); };
        const frame: VideoFrameRequestCallback = (_, metadata) => {
          if (metadata.mediaTime >= 0.4) {
            if (metadata.mediaTime > 0.9) { fail(Error(`Missed the highlighted word: first frame at ${metadata.mediaTime}`)); return; }
            clearTimeout(timer); resolve(count()); return;
          }
          video.requestVideoFrameCallback(frame);
        };
        video.requestVideoFrameCallback(frame); video.src = url; video.load();
      });
    } finally { video.pause(); video.removeAttribute('src'); video.load(); video.remove(); URL.revokeObjectURL(url); }
  } finally { await forgetProjectBundle(id); document.dispose(); world.destroy(); await library.dispose(); }
}

export async function checkCaptionPresetColours() {
  const slot = CAPTION_PRESET_OPTIONS.find(option => option.name === 'spotlight')?.slots[0]?.defaultColor;
  if (slot !== 0x19FF75) throw Error(`Inspector Spotlight highlight default must match the runtime (#19FF75), got ${slot?.toString(16)}`);

  const byDefault = await renderSpotlight('caption-colour-default');
  // The unspoken word stays white; the spoken one is the new green, never the old cyan.
  if (byDefault.white < 100) throw Error(`Spotlight caption text did not draw offline: ${JSON.stringify(byDefault)}`);
  const outfit = [...globalThis.document.fonts].find(face => face.family.replace(/["']/g, '') === 'Outfit');
  if (outfit?.status !== 'loaded') throw Error(`Bundled Outfit must load with remote font hosts blocked, got ${outfit?.status ?? 'no face'}`);
  if (byDefault.green < 100 || byDefault.cyan > 20)
    throw Error(`Spotlight highlight is not #19FF75: ${JSON.stringify(byDefault)}`);

  const authored = await renderSpotlight('caption-colour-authored', ['#ff0000']);
  if (authored.red < 100 || authored.green > 20)
    throw Error(`Authored Spotlight colors must replace the default highlight: ${JSON.stringify(authored)}`);
  return { byDefault, authored };
}
