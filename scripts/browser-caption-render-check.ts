import { AssetLibrary, type ProjectFS } from '@diffusionstudio/assets';
import { createRuntimeWorld, Library, resolveCaptionDecoder, SourceError } from '../packages/runtime/src';
import { createRuntimeDocument } from '../packages/reconciler/src';
import { rememberProjectBundle, forgetProjectBundle } from '../apps/web/src/lib/db';
import { renderScene } from '../apps/web/src/context/render';
import { collectSceneSubtitles } from '../apps/web/src/engine/subtitle-export';
import type { Engine } from '../apps/web/src/engine';

export async function checkCaptionRendering(startsAtZero = false) {
  const files = new Map<string, File>();
  const fs: ProjectFS = {
    readManifest: async () => null, writeManifest: async () => {}, list: async () => [],
    stat: async path => { const file = files.get(path); return file ? { size: file.size, mtime: file.lastModified } : null; },
    file: async path => { const file = files.get(path); if (!file) throw Error('Missing fixture'); return file; },
    write: async (path, blob) => { files.set(path, new File([blob], path.split('/').pop()!)); },
    remove: async path => { files.delete(path); },
  };
  const library = new AssetLibrary(fs);
  const world = createRuntimeWorld('caption-render-fixture'); world.set(Library, library);
  const document = createRuntimeDocument(world);
  try {
    const cueStart = startsAtZero ? 0 : 0.5;
    const transcript = [{ text: 'VISIBLE', words: [{ text: 'VISIBLE', start: cueStart, end: 1.5 }] }];
    await library.store(new Blob([JSON.stringify(transcript)], { type: 'application/json' }), { name: 'captions.json' });
    const scene = document.createElement('Scene');
    document.setProperty(scene, '__source', 'caption-scene'); document.insertNode(document.stage, scene);
    const captions = document.createElement('Captions');
    document.setProperty(captions, 'src', 'captions.json'); document.setProperty(captions, 'end', 2); document.insertNode(scene, captions);
    const subtitles = await collectSceneSubtitles(world, scene.entity);
    if (subtitles[0]?.words[0].start !== cueStart || subtitles[0].words[0].end !== 1.5) throw Error('Caption render fixture subtitle timing is wrong');
    await rememberProjectBundle('caption-render-fixture', `
      const { Stage, Scene, Rect, Captions } = require('@diffusionstudio/jsx');
      module.exports.default = () => Stage({ get children() {
        return Scene({ __source: 'caption-scene', width: 640, height: 360, get children() {
          return [Rect({ width: 640, height: 360, end: 2, fill: '#000000' }),
            Captions({ src: 'captions.json', end: 2, fontSize: 32, fontFamily: 'Arial', fill: '#ffffff' })];
        }});
      }});
    `);
    const chunks: { position: number; data: Uint8Array }[] = [];
    const result = await renderScene({ world, stop() {}, start() {} } as unknown as Engine, {
      scene: scene.entity,
      target: { createWritable: async () => new WritableStream({ write(chunk: { position: number; data: Uint8Array }) {
        chunks.push({ position: chunk.position, data: chunk.data.slice() });
      } }) },
      config: { format: 'webm', video: { codec: 'vp8', resolution: 360, fps: 30, bitrate: 1_000_000 }, audio: { enabled: false } },
    });
    if (result.type !== 'success') throw Error(`Caption render failed: ${JSON.stringify(result)}`);
    const bytes = new Uint8Array(Math.max(...chunks.map(chunk => chunk.position + chunk.data.length)));
    for (const chunk of chunks) bytes.set(chunk.data, chunk.position);
    const url = URL.createObjectURL(new Blob([bytes], { type: 'video/webm' }));
    const video = globalThis.document.createElement('video'); video.muted = true;
    globalThis.document.body.append(video);
    const canvas = globalThis.document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
    const context = canvas.getContext('2d')!;
    const brightPixels = () => {
      context.drawImage(video, 0, 0);
      const pixels = context.getImageData(0, 0, 640, 360).data;
      let bright = 0;
      for (let i = 0; i < pixels.length; i += 4) if (pixels[i]! > 180 && pixels[i + 1]! > 180 && pixels[i + 2]! > 180) bright++;
      return bright;
    };
    try {
      await new Promise<void>((resolve, reject) => {
        const times = [0.25, 0.8, 1.75]; let index = 0;
        const timer = setTimeout(() => reject(Error('Caption video playback timed out')), 10000);
        const fail = (error: unknown) => { clearTimeout(timer); reject(error); };
        video.onerror = () => fail(Error(`Caption video decode failed: ${video.error?.message}`));
        video.onloadeddata = () => {
          const bright = brightPixels();
          if (startsAtZero ? bright < 100 : bright > 10) {
            fail(Error(`First-frame caption mismatch: startsAtZero=${startsAtZero}, bright=${bright}`)); return;
          }
          void video.play().catch(fail);
        };
        const frame: VideoFrameRequestCallback = (_, metadata) => {
          if (metadata.mediaTime >= times[index]!) {
            const bright = brightPixels();
            const visible = metadata.mediaTime >= subtitles[0].words[0].start && metadata.mediaTime < subtitles[0].words[0].end;
            if (metadata.mediaTime > times[index]! + 0.15 || (visible ? bright < 100 : bright > 10)) {
              fail(Error(`Caption pixels disagree with subtitle timing at ${metadata.mediaTime}: ${bright} bright pixels`)); return;
            }
            if (++index === times.length) { clearTimeout(timer); resolve(); return; }
          }
          video.requestVideoFrameCallback(frame);
        };
        video.requestVideoFrameCallback(frame); video.src = url; video.load();
      });
    } finally { video.pause(); video.removeAttribute('src'); video.load(); video.remove(); URL.revokeObjectURL(url); }
    const invalid = await library.store(new Blob(['not valid json'], { type: 'application/json' }), { name: 'invalid-captions.json' });
    document.setProperty(captions, 'src', invalid.path);
    const failed = resolveCaptionDecoder(world, captions.entity)!;
    let rejected = false;
    try { await failed.initPromise; } catch { rejected = true; }
    if (!rejected || !captions.entity.get(SourceError)?.value || failed.ready)
      throw Error('Invalid captions must reject initialization and expose a source error');
  } finally { await forgetProjectBundle('caption-render-fixture'); document.dispose(); world.destroy(); await library.dispose(); }
}
