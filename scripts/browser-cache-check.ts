import { AssetCache, THUMBNAIL } from '../packages/assets/src/cache';
import type { ProjectFS } from '../packages/assets/src/fs';
import type { Asset } from '../packages/assets/src/types';
import { deriveWaveform } from '../packages/assets/src/derive/waveform';
import { AssetLibrary } from '../packages/assets/src/library';

export async function checkCacheWrites() {
  const files = new Map<string, File>();
  let releaseWrite!: () => void;
  let startedWrite!: () => void;
  const writing = new Promise<void>(resolve => { startedWrite = resolve; });
  const gate = new Promise<void>(resolve => { releaseWrite = resolve; });
  let failWrite = false;
  let listings = 0;
  let beforeWrite: (() => Promise<void>) | undefined;
  const fs: ProjectFS = {
    readManifest: async () => null, writeManifest: async () => {},
    list: async dir => { listings++; return [...files].filter(([path]) => path.startsWith(dir + '/')).map(([path, file]) => ({ name: path.slice(dir.length + 1), kind: 'file' as const, size: file.size, mtime: file.lastModified })); },
    stat: async path => { const file = files.get(path); return file ? { size: file.size, mtime: file.lastModified } : null; },
    file: async path => { const file = files.get(path); if (!file) throw Error('Missing cache entry'); return file; },
    write: async (path, blob) => {
      startedWrite(); await gate;
      await beforeWrite?.();
      if (failWrite) throw Error('Cache unavailable');
      files.set(path, new File([blob], path));
    },
    remove: async path => { for (const key of files.keys()) if (key === path || key.startsWith(path + '/')) files.delete(key); },
  };
  const cache = new AssetCache(fs);
  let derivations = 0;
  const produce = async () => { derivations++; return new Blob(['thumbnail']); };
  const first = cache.get(THUMBNAIL, 'asset', produce);
  await writing;
  // Let the original get settle if it incorrectly releases the shared request.
  await new Promise(resolve => setTimeout(resolve, 0));
  const second = cache.get(THUMBNAIL, 'asset', produce);
  releaseWrite();
  const [a, b] = await Promise.all([first, second]);
  if (derivations !== 1 || a !== b) throw Error('Concurrent cache callers repeated derivation during persistence');
  await cache.get(THUMBNAIL, 'asset', produce);
  if (derivations !== 1) throw Error('Persisted cache was not reused');
  failWrite = true;
  const result = await cache.get(THUMBNAIL, 'unwritable', produce);
  if (await result?.text() !== 'thumbnail') throw Error('Cache write failure hid the derived value');
  failWrite = false;
  await cache.get(THUMBNAIL, 'unwritable', produce);
  if (!files.has('cache/thumbnails/unwritable.webp')) throw Error('Cache write failure did not permit retry');
  const canvas = new OffscreenCanvas(16, 16);
  const context = canvas.getContext('2d')!;
  context.fillStyle = '#00ff00'; context.fillRect(0, 0, 16, 16);
  const png = new File([await canvas.convertToBlob({ type: 'image/png' })], 'green.png', { type: 'image/png' });
  let active = 0, peak = 0, reads = 0;
  const assets = Array.from({ length: 10 }, (_, i) => ({
    id: `bounded-${i}`, mimeType: 'image/png', handle: { getFile: async () => {
      reads++; active++; peak = Math.max(peak, active);
      try {
        await new Promise(resolve => setTimeout(resolve, 15));
        if (i === 0) throw Error('Unavailable source');
        return png;
      } finally { active--; }
    } },
  } as unknown as Asset));
  const thumbnails = await Promise.all(assets.map(asset => cache.thumbnail(asset, 16)));
  if (peak !== 2 || reads !== 10 || thumbnails[0] !== null || thumbnails.slice(1).some(value => !value))
    throw Error(`Thumbnail queue failed: peak=${peak}, reads=${reads}`);
  const bitmap = await createImageBitmap(thumbnails[1]!);
  context.drawImage(bitmap, 0, 0); bitmap.close();
  const pixel = context.getImageData(8, 8, 1, 1).data;
  if (pixel[1]! < 200 || pixel[0]! > 30 || pixel[2]! > 30) throw Error('Queued thumbnail pixels were incorrect');
  await cache.thumbnail(assets[1]!, 16);
  if (reads !== 10) throw Error('Thumbnail cache hit decoded the source again');
  let releaseDerivation!: () => void;
  let startedDerivation!: () => void;
  const started = new Promise<void>(resolve => { startedDerivation = resolve; });
  const obsolete = cache.get(THUMBNAIL, 'replaced', async () => {
    startedDerivation();
    await new Promise<void>(resolve => { releaseDerivation = resolve; });
    return new Blob(['obsolete']);
  });
  await started;
  await cache.remove('replaced');
  const fresh = await cache.get(THUMBNAIL, 'replaced', async () => new Blob(['fresh']));
  releaseDerivation();
  if (await obsolete !== null) throw Error('Invalidated derivation returned stale data');
  if (await fresh?.text() !== 'fresh' || await files.get('cache/thumbnails/replaced.webp')?.text() !== 'fresh')
    throw Error('Obsolete derivation overwrote its replacement');
  await cache.remove('replaced');
  if (files.has('cache/thumbnails/replaced.webp')) throw Error('Removal retained persisted cache');
  let allowWrite!: () => void;
  let writingOld!: () => void;
  const oldWriteStarted = new Promise<void>(resolve => { writingOld = resolve; });
  beforeWrite = async () => {
    beforeWrite = undefined;
    writingOld();
    await new Promise<void>(resolve => { allowWrite = resolve; });
  };
  const oldFile = cache.ensure(THUMBNAIL, 'during-write', async () => new Blob(['old write']));
  await oldWriteStarted;
  const removing = cache.remove('during-write');
  const replacement = cache.ensure(THUMBNAIL, 'during-write', async () => new Blob(['replacement']));
  allowWrite();
  await removing;
  if (await oldFile !== null) throw Error('Invalidated file request returned stale data');
  if (await (await replacement)?.text() !== 'replacement') throw Error('Replacement did not wait for removal');
  if (await files.get('cache/thumbnails/during-write.webp')?.text() !== 'replacement') throw Error('Removal erased a fresh cache write');
  for (const operation of ['clear-all', 'clear-kind', 'prune']) {
    const otherKind = { ...THUMBNAIL, dir: 'other' };
    await cache.get(otherKind, 'kept', async () => new Blob(['kept']));
    let release!: () => void, began!: () => void;
    const begun = new Promise<void>(resolve => { began = resolve; });
    const pending = cache.get(THUMBNAIL, 'discarded', async () => {
      began(); await new Promise<void>(resolve => { release = resolve; });
      return new Blob(['discarded']);
    });
    await begun;
    if (operation === 'prune') await cache.prune(['kept']);
    else await cache.clear(operation === 'clear-kind' ? THUMBNAIL : undefined);
    const newest = cache.get(THUMBNAIL, 'discarded', async () => new Blob(['newest']));
    release();
    if (await pending !== null || await (await newest)?.text() !== 'newest') throw Error(`${operation} retained obsolete derivation`);
    if (await files.get('cache/thumbnails/discarded.webp')?.text() !== 'newest') throw Error(`${operation} lost its fresh replacement`);
    if (files.has('cache/other/kept.webp') !== (operation !== 'clear-all')) throw Error(`${operation} affected the wrong cache scope`);
    await cache.remove('discarded');
  }
  for (let i = 0; i < 40; i++) files.set(`cache/thumbnails/unused-${i}.webp`, new File(['old'], 'old.webp'));
  listings = 0;
  await cache.prune(['kept']);
  // Four built-in cache kinds (including proxies) plus this fixture's custom kind.
  if (listings !== 5 || [...files.keys()].some(path => path.includes('unused-')))
    throw Error(`Disk pruning rescanned directories per asset: ${listings}`);
  const closingLibrary = new AssetLibrary(fs);
  const closingCache = closingLibrary.cache;
  let closeReads = 0;
  const releases: (() => void)[] = [];
  const closingAssets = Array.from({ length: 8 }, (_, i) => ({ id: `closing-${i}`, mimeType: 'image/png', handle: {
    getFile: async () => {
      closeReads++;
      await new Promise<void>(resolve => releases.push(resolve));
      return png;
    },
  } } as unknown as Asset));
  const jobs = closingAssets.map(asset => closingCache.thumbnail(asset));
  while (releases.length < 2) await new Promise(resolve => setTimeout(resolve, 0));
  await closingLibrary.dispose();
  const queued = await Promise.all(jobs.slice(2));
  if (queued.some(Boolean) || closeReads !== 2) throw Error('Closing cache started queued source reads');
  for (const release of releases) release();
  if ((await Promise.all(jobs)).some(Boolean)) throw Error('Closed cache returned stale derivations');
  if ([...files.keys()].some(path => path.includes('closing-'))) throw Error('Closed cache persisted derived data');
  if (await closingCache.thumbnail(closingAssets[0]!) !== null || closeReads !== 2) throw Error('Closed cache accepted new work');
  const abort = new AbortController();
  const waveform = deriveWaveform(png, undefined, abort.signal);
  abort.abort();
  try { await waveform; throw Error('Waveform cancellation did not reject'); }
  catch (error) { if (!(error instanceof DOMException) || error.name !== 'AbortError') throw error; }
}
