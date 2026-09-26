import type { VideoAsset } from '@diffusionstudio/assets';

const proxies = new WeakMap<VideoAsset['handle'], VideoAsset>();

export function setPlaybackProxy(asset: VideoAsset, file: File | null): void {
  proxies.delete(asset.handle);
  if (!file) { delete asset.playbackHandle; return; }
  asset.playbackHandle = { getFile: async () => file };
}

export function playbackAsset(asset: VideoAsset): VideoAsset {
  if (!asset.playbackHandle) return asset;
  const cached = proxies.get(asset.handle);
  if (cached?.handle === asset.playbackHandle) return cached;
  const proxy = { ...asset, handle: asset.playbackHandle };
  proxies.set(asset.handle, proxy);
  return proxy;
}
