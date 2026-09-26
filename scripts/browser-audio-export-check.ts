import { AssetLibrary, type ProjectFS } from '@diffusionstudio/assets';
import { createRuntimeWorld, Library } from '../packages/runtime/src';
import { createRuntimeDocument } from '../packages/reconciler/src';
import { rememberProjectBundle, forgetProjectBundle } from '../apps/web/src/lib/db';
import { renderScene } from '../apps/web/src/context/render';
import type { Engine } from '../apps/web/src/engine';

export async function checkAudioExport(muted = false, mixed = false, rate = 1) {
  const sampleRate = 48000;
  const wav = new ArrayBuffer(44 + sampleRate * 2 * 2);
  const data = new DataView(wav);
  const label = (offset: number, text: string) => [...text].forEach((char, i) => data.setUint8(offset + i, char.charCodeAt(0)));
  label(0, 'RIFF'); data.setUint32(4, wav.byteLength - 8, true); label(8, 'WAVE'); label(12, 'fmt ');
  data.setUint32(16, 16, true); data.setUint16(20, 1, true); data.setUint16(22, 1, true);
  data.setUint32(24, sampleRate, true); data.setUint32(28, sampleRate * 2, true);
  data.setUint16(32, 2, true); data.setUint16(34, 16, true); label(36, 'data'); data.setUint32(40, wav.byteLength - 44, true);
  for (let i = 0; i < sampleRate * 2; i++) data.setInt16(44 + i * 2, Math.sin(i * 2 * Math.PI * 440 / sampleRate) * 8192, true);
  const files = new Map<string, File>();
  const fs: ProjectFS = {
    readManifest: async () => null, writeManifest: async () => {}, list: async () => [],
    stat: async path => { const file = files.get(path); return file ? { size: file.size, mtime: file.lastModified } : null; },
    file: async path => { const file = files.get(path); if (!file) throw Error('Missing fixture'); return file; },
    write: async (path, blob) => { files.set(path, new File([blob], path.split('/').pop()!)); },
    remove: async path => { files.delete(path); },
  };
  const library = new AssetLibrary(fs);
  const world = createRuntimeWorld('audio-export-fixture');
  world.set(Library, library);
  const document = createRuntimeDocument(world);
  const context = new AudioContext({ sampleRate });
  try {
    await library.store(new Blob([wav], { type: 'audio/wav' }), { name: 'tone.wav' });
    const scene = document.createElement('Scene');
    document.setProperty(scene, '__source', 'audio-scene');
    document.insertNode(document.stage, scene);
    await rememberProjectBundle('audio-export-fixture', `
      const { Stage, Scene, Audio, Animation, Rect } = require('@diffusionstudio/jsx');
      module.exports.default = () => Stage({ get children() {
        return Scene({ __source: 'audio-scene', width: 320, height: 180, get children() {
          return [${mixed ? "Rect({ width: 320, height: 180, end: 2, fill: '#000000' }), Rect({ width: 320, height: 180, start: 0.5, end: 1.5, fill: '#ff0000' })," : ''}
          Audio({ src: 'tone.wav', playbackRate: ${rate}, start: ${mixed ? 0.5 : 0}, end: ${mixed ? 1.5 : 2 / rate}, volume: -6, muted: ${muted}, get children() {
            return [Animation({ type: 'gain', duration: ${mixed ? 0.2 : 0.5 / rate} }), Animation({ type: 'gain', phase: 'out', duration: ${mixed ? 0.2 : 0.5 / rate} })];
          }})];
        }});
      }});
    `);
    const chunks: { position: number; data: Uint8Array }[] = [];
    const result = await renderScene({ world, stop() {}, start() {} } as unknown as Engine, {
      scene: scene.entity,
      target: { createWritable: async () => new WritableStream({ write(chunk: { position: number; data: Uint8Array }) {
        chunks.push({ position: chunk.position, data: chunk.data.slice() });
      } }) },
      config: { format: mixed ? 'webm' : 'ogg', video: mixed ? { codec: 'vp8', resolution: 180, fps: 30, bitrate: 500_000 } : { enabled: false }, audio: { codec: 'opus', sampleRate, numberOfChannels: 1 } },
    });
    if (result.type !== 'success') throw Error(`Audio export failed: ${JSON.stringify(result)}`);
    const bytes = new Uint8Array(Math.max(...chunks.map(chunk => chunk.position + chunk.data.length)));
    for (const chunk of chunks) bytes.set(chunk.data, chunk.position);
    // Audio decoding transfers its input; retain the container for video playback.
    const decoded = await context.decodeAudioData(bytes.slice().buffer);
    if (Math.abs(decoded.duration - 2 / rate) > 0.06) throw Error(`Wrong audio duration at ${rate}x: ${decoded.duration}`);
    const samples = decoded.getChannelData(0);
    const rms = (from: number, to: number) => {
      const part = samples.subarray(Math.round(from * decoded.sampleRate), Math.round(to * decoded.sampleRate));
      return Math.sqrt(part.reduce((sum, value) => sum + value * value, 0) / part.length);
    };
    const middle = rms(0.8 / rate, 1.2 / rate), head = rms(0, 0.08 / rate), tail = rms(1.92 / rate, 1.99 / rate);
    if (muted) {
      if (rms(0, decoded.duration) > 0.0001) throw Error('Muted audio must remain silent throughout export');
      return;
    }
    if (middle < 0.07 || middle > 0.105) throw Error(`Exported -6 dB tone has wrong level: ${middle}; windows=${Array.from({ length: 20 }, (_, i) => rms(i / 10, (i + 1) / 10)).join(',')}`);
    if (head > middle * 0.3 || tail > middle * 0.3) throw Error(`Exported fades missing: ${head}, ${middle}, ${tail}`);
    if (rate !== 1) {
      const start = Math.round(0.8 / rate * decoded.sampleRate);
      const end = Math.round(1.2 / rate * decoded.sampleRate);
      let crossings = 0;
      for (let i = start + 1; i < end; i++) if (samples[i - 1]! <= 0 && samples[i]! > 0) crossings++;
      const frequency = crossings * decoded.sampleRate / (end - start);
      if (Math.abs(frequency - 440) > 15) throw Error(`Speed ${rate} changed pitch: ${frequency} Hz`);
    }
    if (mixed) {
      if (rms(0, 0.45) > 0.0001 || rms(1.55, 1.99) > 0.0001) throw Error('Mixed export audio extends outside its timeline window');
      const url = URL.createObjectURL(new Blob([bytes], { type: 'video/webm' }));
      const video = globalThis.document.createElement('video');
      video.muted = true;
      globalThis.document.body.append(video);
      const canvas = globalThis.document.createElement('canvas');
      canvas.width = 320; canvas.height = 180;
      const pixels = canvas.getContext('2d')!;
      try {
        await new Promise<void>((resolve, reject) => {
          const times = [0.25, 0.8, 1.75];
          let index = 0;
          const timer = setTimeout(() => reject(Error('Mixed export playback timed out')), 10_000);
          const fail = (error: unknown) => { clearTimeout(timer); reject(error); };
          video.onerror = () => fail(Error(`Mixed export failed to decode: ${video.error?.code} ${video.error?.message}`));
          const frame: VideoFrameRequestCallback = (_, metadata) => {
            if (metadata.mediaTime >= times[index]!) {
              pixels.drawImage(video, 0, 0);
              const [r, g, b] = pixels.getImageData(50, 50, 1, 1).data;
              const red = index === 1;
              if (metadata.mediaTime > times[index]! + 0.15 || (red ? r! < 200 : r! > 30) || g! > 30 || b! > 30) {
                fail(Error(`Mixed export frame mismatch at ${metadata.mediaTime}: ${r},${g},${b}`));
                return;
              }
              index++;
              if (index === times.length) { clearTimeout(timer); resolve(); return; }
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
    await context.close(); await forgetProjectBundle('audio-export-fixture');
    document.dispose(); world.destroy(); await library.dispose();
  }
}
