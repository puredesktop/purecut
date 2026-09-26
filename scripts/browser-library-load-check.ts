import { AssetLibrary, type ProjectFS, type AssetRecord } from '@diffusionstudio/assets';

export async function checkLibraryLoad() {
  let active = 0;
  let peak = 0;
  let reads = 0;
  const records: AssetRecord[] = Array.from({ length: 40 }, (_, index) => ({
    id: `asset-${index}`, path: `clip-${index}.png`, source: `assets/clip-${index}.png`,
    type: 'IMAGE', width: 16, height: 16, mimeType: 'image/png',
    createdAt: '2026-01-01T00:00:00Z', stat: { size: 100, mtime: 1 },
  }));
  const fs: ProjectFS = {
    readManifest: async () => ({ version: 1, folders: [], assets: records }),
    writeManifest: async () => {},
    list: async () => [],
    stat: async path => {
      active++; peak = Math.max(peak, active); reads++;
      try {
        // Vary completion order to exercise stable library ordering.
        const index = Number(path.match(/clip-(\d+)/)?.[1]);
        await new Promise(resolve => setTimeout(resolve, index % 4 === 0 ? 12 : 1));
        if (index === 13) return null;
        if (index === 27) throw Error('Volume unavailable');
        return { size: 100, mtime: 1 };
      } finally { active--; }
    },
    file: async () => { throw Error('Unchanged media must not be decoded during load'); },
    write: async () => {}, remove: async () => {},
  };
  const library = new AssetLibrary(fs);
  try {
    await library.load();
    if (peak !== 4 || active !== 0 || reads !== 40) throw Error(`Unbounded or incomplete load: peak=${peak}, reads=${reads}`);
    if (library.list().map(asset => asset.id).join() !== records.map(asset => asset.id).join())
      throw Error('Async file reads must not reorder the library');
    if (!library.get('asset-13')?.sourceError || library.get('asset-27')?.sourceError !== 'Volume unavailable')
      throw Error('One unavailable file must not abort the rest of the library');
  } finally { await library.dispose(); }

  const canvas = new OffscreenCanvas(16, 16);
  canvas.getContext('2d')!.fillRect(0, 0, 16, 16);
  const png = await canvas.convertToBlob({ type: 'image/png' });
  const file = new File([png], 'saved.png', { type: 'image/png', lastModified: 1234 });
  let saved: ReturnType<AssetLibrary['manifest']> = { version: 1, folders: [], assets: [] };
  let fileReads = 0;
  const storedFs: ProjectFS = {
    readManifest: async () => structuredClone(saved),
    writeManifest: async value => { saved = structuredClone(value); },
    stat: async () => ({ size: file.size, mtime: file.lastModified }),
    file: async () => { fileReads++; return file; },
    list: async () => [], write: async () => {}, remove: async () => {},
  };
  const stored = new AssetLibrary(storedFs);
  try {
    await stored.store(file, { name: file.name });
    await stored.flush();
    const record = saved.assets[0] as AssetRecord;
    record.stat = { size: file.size, mtime: 0 };
    fileReads = 0;
    await stored.load();
    await stored.flush();
    if (fileReads !== 1 || (saved.assets[0] as AssetRecord).stat?.mtime !== file.lastModified)
      throw Error('Refreshed media metadata must be persisted');
    await stored.load();
    if (fileReads !== 1) throw Error('Unchanged media was decoded again after metadata refresh');
  } finally { await stored.dispose(); }
}
