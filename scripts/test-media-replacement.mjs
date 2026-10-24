// Headless regression checks of the actual library, replacement action and
// project history. Only media probing, the picker and renderer services are
// substituted; no browser or host is needed.
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const out = await mkdtemp(join(process.cwd(), '.media-test-'));
const root = process.cwd();
const stubs = {
  renderer: `export const Source = {}; export const getEntityChildren = () => []; export const resolveTranscript = () => []; export const serializeSubtitles = () => '';`,
  reconciler: `export const authoredElement = () => null; export const renderAuthored = () => {};`,
  editor: `export const getDocumentEditor = world => world.editor;`,
  traits: `export const AssetSelection = 'selection';`,
  toast: `export const toast = Object.assign((_, options) => {globalThis.lastToast = options;}, {error: () => {}});`,
  caches: `export const forgetAssetMedia = () => {}; export const forgetAssetPeaks = () => {}; export const insertAsset = () => {};`,
  assets: `export * from ${JSON.stringify(join(root, 'packages/assets/src/library.ts'))}; export {assetName} from ${JSON.stringify(join(root, 'packages/assets/src/types.ts'))}; export const pickFiles = async () => [globalThis.picked]; export const importFiles = () => {}; export const saveAssetAs = () => {}; export const droppedFiles = () => {};`,
  outcomes: `export const describeImport = () => ({});`,
};
try {
  await build({
    stdin: { contents: `export {AssetLibrary} from './packages/assets/src/library'; export {replaceAssetSource} from './apps/web/src/engine/asset-actions'; export {getEditHistory} from './apps/web/src/engine/history';`, resolveDir: root },
    outfile: join(out, 'test.mjs'), bundle: true, platform: 'node', format: 'esm', logLevel: 'error',
    define: {'import.meta.env.VITE_PURECUT': 'true'},
    plugins: [{ name: 'renderer-services', setup(b) {
      b.onResolve({ filter: /./ }, args => {
        let key;
        if (args.path === '@diffusionstudio/runtime') key = 'renderer';
        if (args.path === '@diffusionstudio/reconciler') key = 'reconciler';
        if (args.path === '@diffusionstudio/assets') key = 'assets';
        if (args.path === 'somoto') key = 'toast';
        if (args.path === './editor') key = 'editor';
        if (args.path === './traits') key = 'traits';
        if (/^\.\/(timeline\/(media|peaks)|insert-asset)$/.test(args.path)) key = 'caches';
        if (args.path === './import-outcomes') key = 'outcomes';
        if (key) return {path: key, namespace: 'stub'};
      });
      b.onLoad({ filter: /./, namespace: 'stub' }, args => ({contents: stubs[args.path], resolveDir: root}));
    }}],
  });
  const {AssetLibrary, replaceAssetSource, getEditHistory} = await import(pathToFileURL(join(out, 'test.mjs')));
  let manifest;
  const files = new Map([['a.png', new File(['a'], 'a.png')], ['b.png', new File(['b'], 'b.png')]]);
  const fs = {
    readManifest: async () => manifest, writeManifest: async value => {manifest = structuredClone(value);},
    list: async () => [], stat: async () => ({size: 1, mtime: 0}),
    file: async path => files.get(path), write: async (path, file) => {files.set(path, file);}, remove: async path => {files.delete(path);},
  };
  const world = {editor: {onEdit() {}, onRename() {}, replayEdits: fn => fn()},
    selection: null, has: () => true, get() {return {id: this.selection};}, set(_, value) {this.selection = value.id;}};
  const bindings = ['a', 'b'];
  const library = new AssetLibrary(fs, {onRelink: (asset, from) => {
    bindings.forEach((id, i) => {if (id === from) bindings[i] = asset.id;});
  }});
  // Deterministic probe, otherwise the real AssetLibrary paths and manifest.
  library.describeSource = async (source, options) => ({
    ...options, id: await files.get(source).text(), source, type: 'IMAGE', mimeType: 'image/png',
    width: 1, height: 1, createdAt: '2026-01-01', handle: {getFile: () => fs.file(source)},
  });
  library.revive = async record => ({...record, handle: {getFile: () => fs.file(record.source)}});
  try {
    await library.import(['a.png', 'b.png']);
    world.selection = 'a';
    const history = getEditHistory(world);
    const replace = async id => {
      globalThis.picked = new File([id], `${id}.png`);
      return replaceAssetSource(world, library, library.get('a.png'));
    };
    globalThis.picked = undefined;
    assert.equal(await replaceAssetSource(world, library, library.get('a.png')), null, 'Cancelling the picker must leave the project alone');
    assert.equal(history.canUndo(), false);
    const fileCount = files.size;
    assert.equal(await replace('b'), null, 'Already-imported media must be refused');
    assert.equal(library.list().length, 2);
    assert.equal(files.size, fileCount, 'Refused replacement must clean up its staged file');
    assert.equal(history.canUndo(), false, 'Refused replacement must not add a step');
    await library.flush(); await library.load();
    assert.equal(library.get('a.png').id, 'a'); assert.equal(library.get('b.png').id, 'b');
    let earlierUndone = false;
    history.recordLibraryStep({undo: () => {earlierUndone = true;}, redo: () => {earlierUndone = false;}});
    const first = await replace('c');
    assert.ok(first); assert.deepEqual(bindings, ['c', 'b']);
    const toastUndo = globalThis.lastToast.action.onClick;
    assert.equal(globalThis.lastToast.action.label, 'Undo');
    toastUndo();
    const waitFor = async (id, source) => {
      for (let i = 0; i < 100; i++) {
        const asset = library.get('a.png');
        if (asset?.id === id && (source === undefined || asset.source === source)) return;
        await new Promise(resolve => setTimeout(resolve, 1));
      }
      assert.fail(`Undo/Redo did not restore ${id}; current=${library.get('a.png')?.id}`);
    };
    await waitFor('a'); assert.deepEqual(bindings, ['a', 'b']); assert.equal(world.selection, 'a');
    await library.flush(); await library.load();
    assert.equal(library.get('a.png').id, 'a'); assert.equal(library.get('b.png').id, 'b');
    history.redo(); await waitFor('c'); assert.equal(world.selection, 'c');
    // Identical bytes keep their id but move to a new source. Waiting on
    // the id alone would pass before Undo/Redo has actually done anything.
    const firstSource = library.get('a.png').source;
    const same = await replace('c');
    assert.ok(same);
    const sameSource = same.source;
    assert.notEqual(sameSource, firstSource);
    world.selection = 'b';
    history.undo(); await waitFor('c', firstSource);
    assert.equal(world.selection, 'b', 'Undo must not steal selection from another asset');
    history.redo(); await waitFor('c', sameSource);
    assert.equal(world.selection, 'b', 'Redo must not steal selection from another asset');
    history.undo(); await waitFor('c', firstSource);
    world.selection = 'c';
    await replace('d');
    toastUndo();
    assert.equal(library.get('a.png').id, 'd', 'An older toast must not undo a newer replacement');
    history.undo(); history.undo(); await waitFor('a');
    assert.deepEqual(bindings, ['a', 'b']); assert.equal(world.selection, 'a');
    history.redo(); history.redo(); await waitFor('d');
    assert.deepEqual(bindings, ['d', 'b']); assert.equal(world.selection, 'd');
    await library.flush(); await library.load();
    assert.equal(library.get('a.png').id, 'd'); assert.equal(library.get('b.png').id, 'b');
    assert.equal(earlierUndone, false, 'Undoing replacements must leave earlier edits alone');
    console.log('PASS: collision rejection, grid action, Undo/Redo, repeated replacement, selection, bindings and reload');
  } finally {await library.dispose(); delete globalThis.picked; delete globalThis.lastToast;}
} finally {await rm(out, {recursive:true, force:true});}
