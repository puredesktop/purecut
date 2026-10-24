import { AssetLibrary, type ImportOutcome, type ProjectFS } from '@diffusionstudio/assets';
import { createRuntimeWorld, AssetId, ChildOf, ItemIndex, Name, Scene, Stage } from '@diffusionstudio/runtime';
import { describeImport, missingMediaMessage, scenesUsing } from '../apps/web/src/engine/import-outcomes';
import { followSelection, replacementStep } from '../apps/web/src/engine/media-replacement';
import { getEditHistory } from '../apps/web/src/engine/history';
import { replaceAssetSource } from '../apps/web/src/engine/asset-actions';
import { followRelink } from '../apps/web/src/engine/library';
import { undoEdit, redoEdit } from '../apps/web/src/engine/input/shortcuts';
import { AssetSelection } from '../apps/web/src/engine/traits';

/**
 * Importing several files at once says what became of every one of them, a
 * rejected file leaves nothing behind, and replacing media keeps its kind,
 * undoes, and survives a reload.
 */
export async function checkMediaImport() {
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
  const picture = async (colour: string, name = 'picture.png') => {
    const canvas = new OffscreenCanvas(8, 8);
    const context = canvas.getContext('2d')!;
    context.fillStyle = colour; context.fillRect(0, 0, 8, 8);
    return new File([await canvas.convertToBlob({ type: 'image/png' })], name, { type: 'image/png' });
  };
  const subtitles = new File(['1\n00:00:00,000 --> 00:00:01,000\nHello\n'], 'notes.srt');
  const statuses = (outcomes: ImportOutcome[]) => outcomes.map(outcome => `${outcome.name}:${outcome.status}`).join(' ');
  const check = (ok: unknown, message: string) => { if (!ok) throw Error(message); };

  const library = new AssetLibrary(fs);
  try {
    // Files linked from disk: mixed, with a duplicate name, duplicate bytes, an unsupported file and a missing one.
    files.set('/in/a/picture.png', await picture('red'));
    files.set('/in/b/picture.png', await picture('green'));
    files.set('/in/c/copy.png', files.get('/in/a/picture.png')!);
    files.set('/in/readme.bin', new File(['not media'], 'readme.bin'));
    const linked = await library.import(['/in/a/picture.png', '/in/b/picture.png', '/in/readme.bin', '/in/gone.mov']);
    check(linked.outcomes, 'An import must report an outcome for every file');
    // Files of one name probe in parallel: whichever lands first keeps the name.
    const pictures = linked.outcomes.slice(0, 2).map(outcome => outcome.status).sort().join();
    check(pictures === 'added,renamed' && statuses(linked.outcomes.slice(2)) === 'readme.bin:failed gone.mov:failed',
      `Outcomes must follow the files picked, one each: ${statuses(linked.outcomes)}`);
    const renamed = linked.outcomes.find(outcome => outcome.status === 'renamed');
    check(renamed?.status === 'renamed' && renamed.asset.path === 'picture 2.png' && library.get('picture.png'),
      'Files of one name imported together must each get a path of their own, and say what they were filed as');
    const [, , unsupported, missing] = linked.outcomes;
    check(unsupported!.status === 'failed' && /video, audio, image/.test(unsupported!.reason), `Unsupported files need a useful reason: ${unsupported!.status === 'failed' && unsupported!.reason}`);
    check(missing!.status === 'failed' && /moved or deleted/.test(missing!.reason), 'A missing file needs a useful reason');
    check(linked.assets.length === 2 && linked.failed.length === 2 && library.list().length === 2,
      'Successful imports must be kept beside the refusals');

    const summary = describeImport(linked.outcomes);
    check(summary.title === '2 of 4 files added' && summary.rows.length === 3 && summary.rows.filter(row => row.failed).length === 2,
      `The summary must count what was added and list every other file: ${JSON.stringify(summary)}`);

    // The same bytes again, under another name: named as the asset already holding them.
    const red = library.bySource('/in/a/picture.png')!;
    const again = await library.import(['/in/c/copy.png', '/in/a/picture.png']);
    check(statuses(again.outcomes) === 'copy.png:duplicate picture.png:duplicate' && again.outcomes.every(outcome => outcome.status === 'duplicate' && outcome.asset === red),
      `Importing bytes the library has must say so: ${statuses(again.outcomes)}`);
    check(again.assets.length === 2 && library.list().length === 2, 'A duplicate still answers with its asset, and adds nothing');
    check(describeImport(again.outcomes).title === '0 of 2 files added', 'A summary of duplicates says nothing was added');

    // Files without a path are copied into the project: a refused one must leave nothing behind.
    const before = files.size;
    const stored = [
      await library.importFile(await picture('blue', 'blue.png')),
      await library.importFile(new File(['not media'], 'blob.bin')),
      await library.importFile(await picture('blue', 'again.png')),
      await library.importFile(await picture('yellow', 'blue.png')),
    ];
    check(statuses(stored) === 'blue.png:added blob.bin:failed again.png:duplicate blue.png:renamed', `Copied imports must report outcomes: ${statuses(stored)}`);
    check(files.size === before + 2, `Refused and duplicate copies must not stay in the project (${files.size - before} files written)`);
    // A name freed by a rename still has its old file under it: a new import must not write over it.
    const yellow = library.get('blue 2.png')!;
    const yellowBytes = files.get(yellow.source);
    library.rename(yellow, 'sun.png');
    const freed = await library.importFile(await picture('white', 'blue 2.png'));
    check(freed.status === 'renamed' && files.get(yellow.source) === yellowBytes && library.get('sun.png') === yellow,
      'Importing under a renamed asset\'s old name must not overwrite its file');

    // Replace media: of the same kind only, and undoable.
    const original = library.get('blue.png')!;
    const kept = { id: original.id, source: original.source };
    let refusal = '';
    try { await library.relinkFile(original, subtitles); } catch (error) { refusal = (error as Error).message; }
    check(/image/.test(refusal) && /notes\.srt/.test(refusal), `Replacing an image with subtitles must be refused with a reason: ${refusal}`);
    check(library.get(kept.id) === original && files.size === before + 3, 'A refused replacement must leave the asset and the project as they were');

    const world = createRuntimeWorld('media-import-check');
    const relinked: string[] = [];
    const replacing = new AssetLibrary(fs, { onRelink: (asset, from) => { relinked.push(`${from}>${asset.id}`); followRelink(world, asset, from); } });
    try {
      await library.flush();
      await replacing.load();
      const target = replacing.get(kept.id)!;

      // Bytes another asset holds cannot stand in: one asset per content id, so it would drop that one.
      const sun = replacing.get('sun.png')!;
      let clash = '';
      try { await replacing.relinkFile(target, files.get(sun.source)!); } catch (error) { clash = (error as Error).message; }
      check(/already in the library as "sun\.png"/.test(clash) && replacing.get(sun.id) === sun && replacing.get(kept.id) === target && relinked.length === 0,
        `Replacing with media already in the library must be refused, keeping both assets: ${clash}`);

      // A replacement is a step of the project's history: Undo and Redo, the selection following.
      const previous = { ...target };
      world.add(AssetSelection({ id: kept.id }));
      const next = await replacing.relinkFile(target, await picture('purple'));
      followSelection(world, next, kept.id);
      check(next.id !== kept.id && next.path === 'blue.png' && world.get(AssetSelection)?.id === next.id, 'A replacement keeps the library path and the selection');
      const step = replacementStep(replacing, previous, next, { changed: (asset, from) => followSelection(world, asset, from) });
      const history = getEditHistory(world);
      history.recordLibraryStep(step);
      check(history.canUndo(), 'A replacement must be a step Undo can reach');
      history.undo();
      await step.settled();
      const restored = replacing.get(kept.id)!;
      check(restored?.source === kept.source && !restored.sourceError && world.get(AssetSelection)?.id === kept.id,
        'Undo must point the asset back at its own bytes and keep it selected');
      check(relinked.join() === `${kept.id}>${next.id},${next.id}>${kept.id}`, `Undo must rebind clips to the restored id: ${relinked.join()}`);
      check(files.has(next.source) && history.canRedo(), 'Undo must keep the replacement\'s bytes for Redo');
      history.redo();
      await step.settled();
      check(step.current().id === next.id && step.current().source === next.source && world.get(AssetSelection)?.id === next.id,
        'Redo must point the asset at the replacement again');
      history.undo();
      await step.settled();
      check(replacing.get(kept.id)?.source === kept.source && world.get(AssetSelection)?.id === kept.id, 'Undo again must restore the old file');
      let stale = '';
      try { await replacing.restore(next, previous); } catch (error) { stale = (error as Error).message; }
      check(/no longer be undone/.test(stale) && replacing.list().filter(asset => asset.path === 'blue.png').length === 1,
        'Undoing the same replacement twice must be refused, not bring back a second asset');

      // Exercise the same action as the grid, without an inspector callback.
      // Only the browser picker is substituted; import, history and bindings are real.
      const pick = HTMLInputElement.prototype.click;
      const replaceWith = async (colour: string) => {
        const file = await picture(colour);
        HTMLInputElement.prototype.click = function () {
          const transfer = new DataTransfer(); transfer.items.add(file);
          this.files = transfer.files;
          this.dispatchEvent(new Event('change'));
        };
        try { return await replaceAssetSource(world, replacing, replacing.get('blue.png')!); }
        finally { HTMLInputElement.prototype.click = pick; }
      };
      const until = async (test: () => boolean) => {
        for (let i = 0; i < 100; i++) {
          if (test()) return;
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        throw Error('Normal Undo/Redo did not restore the media and selection');
      };
      history.reset();
      const bound = world.spawn(AssetId({ value: kept.id }));
      const first = await replaceWith('orange');
      check(first && bound.get(AssetId)?.value === first.id, 'Grid replacement must rebind clips');
      const secondReplacement = await replaceWith('pink');
      check(secondReplacement, 'A second replacement must succeed');
      // Restoring the second step creates a fresh instance of the first asset.
      // Two quick Undo commands must still restore both steps, in order.
      undoEdit(world); undoEdit(world);
      await until(() => replacing.get('blue.png')?.source === kept.source);
      check(bound.get(AssetId)?.value === kept.id && world.get(AssetSelection)?.id === kept.id,
        'Normal Undo must restore clip bindings and inspector selection');
      redoEdit(world); redoEdit(world);
      await until(() => replacing.get('blue.png')?.source === secondReplacement!.source);
      check(bound.get(AssetId)?.value === secondReplacement!.id && world.get(AssetSelection)?.id === secondReplacement!.id,
        'Normal Redo must restore clip bindings and inspector selection');
      undoEdit(world); undoEdit(world);
      await until(() => replacing.get('blue.png')?.source === kept.source);

      // Reload: what was kept stays, and a missing file names its scenes.
      await replacing.flush();
      const reopened = new AssetLibrary(fs);
      try {
        await reopened.load();
        check(reopened.get(kept.id)?.source === kept.source, 'An undone replacement must stay undone after reload');
        check(reopened.list().length === 5, `Reload must hold exactly the accepted imports: ${reopened.list().map(asset => asset.path)}`);
        check(reopened.get('blue.png') && reopened.get('sun.png'), 'Every library path the JSX names must still resolve after reload');
        files.delete('/in/a/picture.png');
        await reopened.load();
        const lost = reopened.bySource('/in/a/picture.png')!;
        check(lost.sourceError, 'A missing file must load as unavailable');
        const stage = world.spawn(Stage);
        const intro = world.spawn(Scene, Name({ value: 'Intro' }), ItemIndex({ value: 0 }), ChildOf(stage));
        const second = world.spawn(Scene, ItemIndex({ value: 1 }), ChildOf(stage));
        world.spawn(AssetId({ value: lost.id }), ChildOf(intro));
        world.spawn(AssetId({ value: lost.id }), ChildOf(world.spawn(ChildOf(second))));
        world.spawn(AssetId({ value: lost.id }), ChildOf(second));
        check(scenesUsing(world, lost.id).join() === 'Intro,Scene 2', `A missing file must name the scenes it is in: ${scenesUsing(world, lost.id)}`);
        const message = missingMediaMessage(world, lost) ?? '';
        check(message.includes('picture.png is no longer at /in/a/picture.png') && message.includes('used in Intro and Scene 2') && message.includes('another image'),
          `The missing-media message must name the file and its scenes: ${message}`);
        check(missingMediaMessage(world, reopened.get(kept.id)!) === undefined, 'Media that plays has no missing-media message');
      } finally { await reopened.dispose(); }
    } finally { world.destroy(); await replacing.dispose(); }
  } finally { await library.dispose(); }
}
