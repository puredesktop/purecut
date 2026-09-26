import { ALL_FORMATS, BlobSource, CanvasSink, Input } from 'mediabunny';
import { AssetCache, AssetLibrary, type ProjectFS, type VideoAsset } from '@diffusionstudio/assets';
import { AssetId, Mode, VideoBuffer, VideoExporter, playbackAsset, resolveVideoDecoder, setPlaybackProxy } from '../packages/runtime/src';
import type { World } from 'koota';

export async function checkPlaybackProxy(asset: VideoAsset, library: AssetLibrary, fs: ProjectFS, world: World) {
  const file = await library.cache.playbackProxy(asset);
  if (!file) throw Error('Playback proxy generation failed');
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track || await input.getPrimaryAudioTrack()) throw Error('Proxy must have video only');
    if (Math.abs(await input.computeDuration() - 2) > 0.05) throw Error('Proxy changed duration');
    if (await track.getDisplayWidth() !== 320 || await track.getDisplayHeight() !== 180)
      throw Error('Small proxy source was unexpectedly resized');
    const sink = new CanvasSink(track);
    for (const [time, red] of [[0.2, true], [1.2, false]] as const) {
      const frame = await sink.getCanvas(time);
      if (!frame) throw Error('Missing proxy frame');
      const canvas = new OffscreenCanvas(1, 1);
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(frame.canvas, 0, 0, 1, 1);
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
      if (g! > 30 || (red ? r! < 200 || b! > 30 : b! < 200 || r! > 30))
        throw Error(`Proxy changed content at ${time}: ${r},${g},${b}`);
    }
  } finally { input.dispose(); }
  const cache = new AssetCache(fs);
  try {
    const persisted = await cache.playbackProxy({ ...asset, handle: { getFile: async () => { throw Error('Cached proxy must not reread original'); } } });
    if (!persisted || persisted.size !== file.size) throw Error('Proxy did not survive cache recreation');
  } finally { cache.dispose(); }
  setPlaybackProxy(asset, file);
  library.update(asset, { playbackProxy: true });
  const manifest = library.manifest();
  const record = manifest.assets.find(entry => entry.id === asset.id)!;
  if ('playbackHandle' in record || 'handle' in record || !('playbackProxy' in record) || record.playbackProxy !== true)
    throw Error('Proxy preference or transient handle serialization is incorrect');
  for (const enabled of [true, false]) {
    let reads = 0;
    const restored = new AssetLibrary({
      ...fs,
      readManifest: async () => ({ ...manifest, assets: [{ ...record, playbackProxy: enabled, playbackHandle: {} }] }),
      stat: async path => path === asset.source ? asset.stat! : fs.stat(path),
      file: async path => {
        if (path === asset.source) throw Error('Restoring proxy must not reread original');
        reads++;
        return fs.file(path);
      },
    });
    try {
      await restored.load();
      const video = restored.get(asset.id) as VideoAsset;
      for (let attempt = 0; enabled && !video.playbackHandle && attempt < 100; attempt++)
        await new Promise(resolve => setTimeout(resolve, 10));
      if (!!video.playbackHandle !== enabled || (enabled && !reads))
        throw Error('Saved proxy choice was not restored correctly');
      if (enabled && (await playbackAsset(video).handle.getFile()).size !== file.size)
        throw Error('Restored proxy differs from cached file');
    } finally { await restored.dispose(); }
  }
  const missing = new AssetLibrary({
    ...fs,
    readManifest: async () => ({ ...manifest, assets: [record] }),
    stat: async path => path === asset.source ? asset.stat! : fs.stat(path),
    file: async () => { throw Error('Missing cache must not trigger encoding'); },
  });
  try {
    await missing.load();
    await new Promise(resolve => setTimeout(resolve, 50));
    const video = missing.get(asset.id) as VideoAsset;
    if (video.playbackHandle || playbackAsset(video) !== video)
      throw Error('Missing proxy did not fall back to original');
  } finally { await missing.dispose(); }
  library.update(asset, { playbackProxy: false });
  setPlaybackProxy(asset, null);
  const cancelled = new AssetCache(fs);
  const cancelledAsset = { ...asset, id: `${asset.id}-cancelled` };
  const cancelledFile = await cancelled.playbackProxy(cancelledAsset, () => cancelled.dispose());
  if (cancelledFile || await fs.stat(`cache/playback-proxies-v1/${cancelledAsset.id}.webm`))
    throw Error('Closing the cache persisted a partial proxy');
  cancelled.dispose();
  const entity = world.spawn(AssetId({ value: asset.id }));
  try {
    setPlaybackProxy(asset, file);
    world.set(Mode, { value: 'realtime' });
    const preview = resolveVideoDecoder(world, entity);
    if (!(preview instanceof VideoBuffer) || preview.asset.handle !== playbackAsset(asset).handle || preview.asset.handle === asset.handle)
      throw Error('Live preview did not select proxy');
    await preview.initialized;
    world.set(Mode, { value: 'offline-video' });
    const exported = resolveVideoDecoder(world, entity);
    if (!(exported instanceof VideoExporter) || exported.asset.handle !== asset.handle)
      throw Error('Export selected proxy instead of original');
    await exported.initialized;
    setPlaybackProxy(asset, null);
    world.set(Mode, { value: 'realtime' });
    const original = resolveVideoDecoder(world, entity);
    if (!(original instanceof VideoBuffer) || original.asset.handle !== asset.handle)
      throw Error('Switching proxy off did not restore original');
    await original.initialized;
  } finally {
    setPlaybackProxy(asset, null);
    entity.destroy();
    world.set(Mode, { value: 'realtime' });
  }
}
