import { AssetLibrary, type ProjectFS } from '@diffusionstudio/assets';
import { createRuntimeWorld, AssetId, ImageDecoderHandle, Library, resolveImageDecoder } from '@diffusionstudio/runtime';
import { followRelink } from '../apps/web/src/engine/library';

export async function checkRelinkFiles() {
  const files = new Map<string, File>();
  let manifest: unknown = null;
  const fs: ProjectFS = {
    readManifest: async () => manifest,
    writeManifest: async value => { manifest = structuredClone(value); },
    list: async () => [],
    stat: async path => { const file = files.get(path); return file ? { size: file.size, mtime: file.lastModified } : null; },
    file: async path => { const file = files.get(path); if (!file) throw Error('Missing file'); return file; },
    write: async (path, blob) => { files.set(path, new File([blob], path.split('/').pop()!)); },
    remove: async path => { files.delete(path); },
  };
  const replacements: string[] = [];
  const library = new AssetLibrary(fs, { onRelink: (_, from) => replacements.push(from) });
  const picture = async (colour: string) => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 16;
    const context = canvas.getContext('2d')!;
    context.fillStyle = colour; context.fillRect(0, 0, 16, 16);
    const blob = await new Promise<Blob>(resolve => canvas.toBlob(value => resolve(value!), 'image/png'));
    return new File([blob], 'picture.png', { type: 'image/png' });
  };
  try {
    const original = await library.store(await picture('red'), { name: 'picture.png' });
    const oldBytes = files.get(original.source);
    const next = await library.relinkFile(original, await picture('blue'));
    if (next.path !== original.path || next.id === original.id || replacements[0] !== original.id)
      throw Error('File replacement must retain the library path and rebind the content id');
    if (files.get(original.source) !== oldBytes) throw Error('Replacement must preserve original bytes');
    if (!next.source.startsWith('assets/') || !files.has(next.source)) throw Error('Replacement must be project-owned');
    const count = files.size;
    try {
      await library.relinkFile(next, new File(['not media'], 'invalid.bin'));
      throw Error('Invalid replacement unexpectedly succeeded');
    } catch (error) {
      if (String(error).includes('unexpectedly succeeded')) throw error;
    }
    if (files.size !== count || library.get(next.id) !== next) throw Error('Failed replacement must preserve the asset and remove staged bytes');
    await library.flush();
    const world = createRuntimeWorld('relink-recovery');
    const reopened = new AssetLibrary(fs, { onRelink: (asset, from) => followRelink(world, asset, from) });
    world.set(Library, reopened);
    try {
      await reopened.load();
      const restored = reopened.get(next.id);
      if (restored?.path !== original.path || restored.source !== next.source) throw Error('Replacement must survive manifest reload');
      const replacementBytes = files.get(next.source)!;
      files.delete(next.source);
      await reopened.load();
      const missing = reopened.get(next.id);
      if (missing?.sourceError !== 'File not found' || missing.path !== original.path)
        throw Error('Missing media must retain its identity and expose a recovery state');
      const clip = world.spawn(AssetId({ value: missing.id }), ImageDecoderHandle);
      const otherClip = world.spawn(AssetId({ value: missing.id }));
      const failed = resolveImageDecoder(world, clip)!;
      const shared = resolveImageDecoder(world, otherClip)!;
      await Promise.all([failed.initPromise, shared.initPromise]);
      if (!failed.decoder.failed || !shared.decoder.failed)
        throw Error('Missing source must exercise an actual failed shared decoder');
      const recovered = await reopened.relinkFile(missing, replacementBytes);
      if (recovered.id !== next.id || recovered.sourceError)
        throw Error('Relinking identical bytes must clear the missing-media state');
      if (clip.get(ImageDecoderHandle) || otherClip.get(ImageDecoderHandle) || clip.get(AssetId)?.value !== recovered.id)
        throw Error('Same-content recovery must release stale decoders while preserving the clip binding');
      for (const target of [clip, otherClip]) {
        const decoded = resolveImageDecoder(world, target)!;
        await decoded.initPromise;
        const bitmap = decoded.decoder.getBitmap(16, 16);
        if (!bitmap || decoded.decoder.failed) throw Error('Recovered image must decode on every linked clip');
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 16;
        const context = canvas.getContext('2d')!;
        context.drawImage(bitmap, 0, 0);
        const pixel = context.getImageData(8, 8, 1, 1).data;
        if (pixel[0] !== 0 || pixel[1] !== 0 || pixel[2] !== 255 || pixel[3] !== 255)
          throw Error(`Recovery displayed incorrect pixels: ${[...pixel]}`);
      }
      await reopened.flush();
      if (JSON.stringify(manifest).includes('sourceError')) throw Error('Read errors must not be persisted');
      await reopened.load();
      if (reopened.get(next.id)?.sourceError) throw Error('Recovered media must remain available after reload');
    } finally { world.destroy(); await reopened.dispose(); }
  } finally { await library.dispose(); }
}
