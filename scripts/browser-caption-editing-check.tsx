import { AssetLibrary, type ProjectFS, type Manifest } from '@diffusionstudio/assets';
import { createRuntimeWorld, Library, bindAsset, resolveCaptionDecoder, Chars } from '../packages/runtime/src';
import { authoredElement, createRuntimeDocument } from '../packages/reconciler/src';
import { editCaptionCue, replaceCueText } from '../apps/web/src/engine/caption-editing';
import { getDocumentEditor } from '../apps/web/src/engine/editor';
import { getEditHistory } from '../apps/web/src/engine/history';
import { WorldProvider } from '@diffusionstudio/koota-solid';
import { render } from 'solid-js/web';
import { CaptionCues } from '../apps/web/src/components/sidebar-right/inspector/caption-cues';

export async function checkCaptionEditing() {
  const files = new Map<string, File>();
  let manifest: Manifest | null = null;
  const fs: ProjectFS = {
    readManifest: async () => manifest, writeManifest: async value => { manifest = structuredClone(value); }, list: async () => [],
    stat: async path => { const file = files.get(path); return file ? { size: file.size, mtime: file.lastModified } : null; },
    file: async path => { const file = files.get(path); if (!file) throw Error('Missing fixture'); return file; },
    write: async (path, blob) => { files.set(path, new File([blob], path.split('/').pop()!)); },
    remove: async path => { files.delete(path); },
  };
  const library = new AssetLibrary(fs);
  const world = createRuntimeWorld('caption-editing');
  world.set(Library, library);
  const document = createRuntimeDocument(world);
  const host = globalThis.document.createElement('div');
  globalThis.document.body.append(host);
  let dispose = () => {};
  const until = async (condition: () => boolean) => {
    for (let i = 0; i < 200; i++) {
      if (condition()) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw Error(`Caption inspector timed out: ${host.textContent}`);
  };
  const transcript = [{ text: 'Original words', words: [{ text: 'Original', start: 1, end: 2 }, { text: 'words', start: 2, end: 3 }] }];
  try {
    const changed = replaceCueText(transcript, 0, 'Corrected caption words');
    if (changed[0].words[0].start !== 1 || changed[0].words.at(-1)?.end !== 3 || transcript[0].text !== 'Original words')
      throw Error('Caption correction must preserve cue bounds and original data');
    const original = await library.store(new Blob([JSON.stringify(transcript)], { type: 'application/json' }), { name: 'original.json' });
    const originalBytes = await files.get(original.source)!.text();
    const scene = document.createElement('Scene'); document.insertNode(document.stage, scene);
    const clip = document.createElement('Captions');
    document.setProperty(clip, '__source', 'caption-clip');
    document.setProperty(clip, 'src', original.path);
    document.insertNode(scene, clip); bindAsset(clip.entity, original);
    const history = getEditHistory(world);
    const originalDecoder = resolveCaptionDecoder(world, clip.entity)!;
    await until(() => originalDecoder.ready);
    dispose = render(() => <WorldProvider world={world}><CaptionCues entity={clip.entity} /></WorldProvider>, host);
    await until(() => !!host.querySelector('textarea'));
    let timelineKeys = 0;
    host.addEventListener('keydown', () => timelineKeys++);
    const field = host.querySelector('textarea')!;
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    if (timelineKeys) throw Error('Caption typing shortcuts escaped to timeline');
    field.focus(); field.value = ''; field.blur();
    await until(() => !!host.querySelector('[role="alert"]'));
    if (!host.textContent?.includes('cannot be empty') || authoredElement(clip.entity)?.props.src !== original.path)
      throw Error('Invalid caption must show an error without changing the source');
    host.querySelector('button')!.click();
    await until(() => host.querySelector('textarea')?.value === 'Original words' && !host.querySelector('[role="alert"]'));
    const corrected = host.querySelector('textarea')!;
    corrected.focus(); corrected.value = 'Corrected caption words'; corrected.blur();
    await until(() => authoredElement(clip.entity)?.props.src !== original.path && !host.querySelector('[role="status"]'));
    const revisedPath = authoredElement(clip.entity)?.props.src;
    if (revisedPath === original.path || typeof revisedPath !== 'string') throw Error('Caption correction must bind a new source');
    const revised = await library.resolve(revisedPath);
    if (JSON.parse(await (await revised.handle.getFile()).text())[0].text !== 'Corrected caption words') throw Error('Revised cue was not saved');
    if (await files.get(original.source)!.text() !== originalBytes) throw Error('Caption edit overwrote original bytes');
    const reopenedLibrary = new AssetLibrary(fs);
    const reopenedWorld = createRuntimeWorld('caption-editing-reopen');
    reopenedWorld.set(Library, reopenedLibrary);
    const reopenedDocument = createRuntimeDocument(reopenedWorld);
    try {
      await reopenedLibrary.load();
      const reopenedScene = reopenedDocument.createElement('Scene');
      reopenedDocument.insertNode(reopenedDocument.stage, reopenedScene);
      const reopenedClip = reopenedDocument.createElement('Captions');
      const savedProps = JSON.parse(JSON.stringify(authoredElement(clip.entity)!.props));
      for (const [key, value] of Object.entries(savedProps)) reopenedDocument.setProperty(reopenedClip, key, value);
      reopenedDocument.insertNode(reopenedScene, reopenedClip);
      const decoder = resolveCaptionDecoder(reopenedWorld, reopenedClip.entity);
      if (!decoder) throw Error('Saved caption revision was not resolvable after library reload');
      await until(() => decoder.ready);
      decoder.seekTo(reopenedWorld, reopenedClip.entity, 1.01);
      if (!reopenedClip.entity.get(Chars)?.value.includes('Corrected')) throw Error('Reopened caption lost the correction');
    } finally { reopenedDocument.dispose(); reopenedWorld.destroy(); await reopenedLibrary.dispose(); }
    const correctedDecoder = resolveCaptionDecoder(world, clip.entity)!;
    await until(() => correctedDecoder.ready);
    correctedDecoder.seekTo(world, clip.entity, 1.01);
    if (correctedDecoder === originalDecoder || !clip.entity.get(Chars)?.value.includes('Corrected'))
      throw Error('Caption correction did not refresh preview text');
    await Promise.resolve(); history.undo();
    if (authoredElement(clip.entity)?.props.src !== original.path) throw Error('Undo did not restore original caption source');
    await until(() => host.querySelector('textarea')?.value === 'Original words');
    const undoneDecoder = resolveCaptionDecoder(world, clip.entity)!;
    await until(() => undoneDecoder.ready);
    undoneDecoder.seekTo(world, clip.entity, 1.01);
    if (!clip.entity.get(Chars)?.value.includes('Original')) throw Error('Undo did not restore preview text');
    history.redo();
    if (authoredElement(clip.entity)?.props.src !== revisedPath) throw Error('Redo did not restore corrected caption source');
    await until(() => host.querySelector('textarea')?.value === 'Corrected caption words');
    getDocumentEditor(world).editProperty(clip.entity, 'locked', true);
    const before = files.size;
    let rejected = false;
    try { await editCaptionCue(world, clip.entity, revised.id, 0, 'Locked change'); } catch { rejected = true; }
    if (!rejected || files.size !== before) throw Error('Locked caption edits must not write assets');
    getDocumentEditor(world).editProperty(clip.entity, 'locked', false);
    bindAsset(clip.entity, revised);
    const write = fs.write;
    let release!: () => void;
    let started!: () => void;
    const pendingWrite = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    fs.write = async (path, blob) => { started(); await gate; await write(path, blob); };
    const pending = editCaptionCue(world, clip.entity, revised.id, 0, 'A stale correction').then(() => false, () => true);
    await pendingWrite;
    getDocumentEditor(world).editProperty(clip.entity, 'src', original.path);
    bindAsset(clip.entity, original);
    release();
    if (!(await pending) || authoredElement(clip.entity)?.props.src !== original.path)
      throw Error('A stale caption save must not replace a newer source choice');
  } finally { dispose(); host.remove(); document.dispose(); world.destroy(); await library.dispose(); }
}
