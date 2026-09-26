import { AssetLibrary, type ProjectFS } from '@diffusionstudio/assets';
import { createRuntimeWorld, Library } from '../packages/runtime/src';
import { createRuntimeDocument } from '../packages/reconciler/src';
import { rememberProjectBundle, forgetProjectBundle } from '../apps/web/src/lib/db';
import { renderScene } from '../apps/web/src/context/render';
import type { Engine } from '../apps/web/src/engine';
import { checkPlaybackProxy } from './browser-playback-proxy-check';

export async function checkVideoSpeedExport() {
  const files = new Map<string, File>();
  const fs: ProjectFS = {
    readManifest: async () => null, writeManifest: async () => {}, list: async () => [],
    stat: async path => { const file = files.get(path); return file ? { size: file.size, mtime: file.lastModified } : null; },
    file: async path => { const file = files.get(path); if (!file) throw Error(`Missing ${path}`); return file; },
    write: async (path, blob) => { files.set(path, new File([blob], path.split('/').pop()!)); },
    remove: async path => { files.delete(path); },
  };
  const library = new AssetLibrary(fs);
  const world = createRuntimeWorld('video-speed-fixture');
  world.set(Library, library);
  const document = createRuntimeDocument(world);
  const scene = document.createElement('Scene');
  document.setProperty(scene, '__source', 'speed-scene');
  document.insertNode(document.stage, scene);
  const encode = async (children: string) => {
    await rememberProjectBundle('video-speed-fixture', `
      const { Stage, Scene, Rect, Video } = require('@diffusionstudio/jsx');
      module.exports.default = () => Stage({ get children() {
        return Scene({ __source: 'speed-scene', width: 320, height: 180, get children() { return ${children}; }});
      }});
    `);
    const chunks: { position: number; data: Uint8Array }[] = [];
    const result = await renderScene({ world, stop() {}, start() {} } as unknown as Engine, {
      scene: scene.entity,
      target: { createWritable: async () => new WritableStream({ write(chunk: { position: number; data: Uint8Array }) {
        chunks.push({ position: chunk.position, data: chunk.data.slice() });
      } }) },
      config: { format: 'webm', video: { codec: 'vp8', resolution: 180, fps: 30, bitrate: 500_000 }, audio: { enabled: false } },
    });
    if (result.type !== 'success') throw Error(`Speed export failed: ${JSON.stringify(result)}`);
    const bytes = new Uint8Array(Math.max(...chunks.map(chunk => chunk.position + chunk.data.length)));
    for (const chunk of chunks) bytes.set(chunk.data, chunk.position);
    return new Blob([bytes], { type: 'video/webm' });
  };
  try {
    const source = await encode("[Rect({ width: 320, height: 180, end: 1, fill: '#ff0000' }), Rect({ width: 320, height: 180, start: 1, end: 2, fill: '#0000ff' })]");
    const asset = await library.store(source, { name: 'colours.webm' });
    if (asset.type !== 'VIDEO') throw Error('Video fixture not recognized');
    await checkPlaybackProxy(asset, library, fs, world);
    for (const rate of [2, 0.5]) {
      const output = await encode(`Video({ src: 'colours.webm', width: 320, height: 180, sourceIn: 0.25, playbackRate: ${rate}, end: ${1.75 / rate} })`);
      const url = URL.createObjectURL(output);
      const video = globalThis.document.createElement('video');
      video.muted = true;
      globalThis.document.body.append(video);
      const canvas = globalThis.document.createElement('canvas');
      canvas.width = 320; canvas.height = 180;
      const context = canvas.getContext('2d')!;
      try {
        await new Promise<void>((resolve, reject) => {
          // The second sample is blue only if the source-in trim is applied.
          const times = [0.5 / rate, 0.85 / rate];
          let index = 0;
          const timer = setTimeout(() => reject(Error(`Speed ${rate} playback timed out`)), 10_000);
          const fail = (error: unknown) => { clearTimeout(timer); reject(error); };
          video.onerror = () => fail(Error(`Speed ${rate} decode failed: ${video.error?.message}`));
          video.onloadedmetadata = () => {
            if (!Number.isFinite(video.duration) || Math.abs(video.duration - 1.75 / rate) > 0.07) {
              fail(Error(`Speed ${rate} wrong output duration: ${video.duration}`));
            }
          };
          const frame: VideoFrameRequestCallback = (_, metadata) => {
            if (metadata.mediaTime >= times[index]!) {
              context.drawImage(video, 0, 0);
              const [r, g, b] = context.getImageData(100, 90, 1, 1).data;
              const expectedRed = index === 0;
              if (metadata.mediaTime > times[index]! + 0.15 || g! > 30 || (expectedRed ? r! < 200 || b! > 30 : b! < 200 || r! > 30)) {
                fail(Error(`Speed ${rate} wrong source frame at ${metadata.mediaTime}: ${r},${g},${b}`));
                return;
              }
              if (++index === times.length) { clearTimeout(timer); resolve(); return; }
            }
            video.requestVideoFrameCallback(frame);
          };
          video.requestVideoFrameCallback(frame);
          video.src = url;
          void video.play().catch(fail);
        });
      } finally {
        video.pause(); video.removeAttribute('src'); video.load(); video.remove(); URL.revokeObjectURL(url);
      }
    }
  } finally {
    await forgetProjectBundle('video-speed-fixture');
    document.dispose(); world.destroy(); await library.dispose();
  }
}
