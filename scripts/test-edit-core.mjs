// Node checks for purecut/editor-core/edit-core.ts against an in-memory project.
// Covers text edits (upstream diffusionstudio/editor ae33eab): a text edit
// replaces only what an element says and keeps its paint, strokes and comments;
// prop writes over expressions (upstream a0f843f); and a text's `fill` going to
// the colour it is seen in (purecut/editor-core/text-colour.ts), as the review
// of a proposeCutEdits proposal writes it.
// Covers object masks and clip paths (upstream e63f1c7, cde1cc1, a6e27ef): the
// writes the object mask and clip path tools make round-trip through the file.
import { build } from 'esbuild';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

await mkdir('node_modules/.cache', { recursive: true });
const out = await mkdtemp(join('node_modules/.cache', 'purecut-edit-core-'));
const bundle = join(out, 'edit-core.mjs');
await build({
  entryPoints: ['purecut/editor-core/edit-core.ts'],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'esm',
  external: ['ts-morph'],
  logLevel: 'error',
});
const { applyEdits } = await import(pathToFileURL(resolve(bundle)).href);
const colourBundle = join(out, 'text-colour.mjs');
await build({
  entryPoints: ['purecut/editor-core/text-colour.ts'],
  outfile: colourBundle,
  bundle: true,
  platform: 'node',
  format: 'esm',
  external: ['ts-morph'],
  logLevel: 'error',
});
const { retargetTextColours } = await import(pathToFileURL(resolve(colourBundle)).href);
const scopedBundle = join(out, 'scoped-edits.mjs');
await build({
  entryPoints: ['purecut/lib/scoped-edits.ts'],
  outfile: scopedBundle,
  bundle: true,
  platform: 'node',
  format: 'esm',
  external: ['ts-morph'],
  logLevel: 'error',
});
const { validateScopedEdits } = await import(pathToFileURL(resolve(scopedBundle)).href);

const FILE = 'index.tsx';
function project(source) {
  const files = new Map([[FILE, source]]);
  return {
    files,
    context: {
      dir: '/project',
      io: {
        read: async (file) => { if (!files.has(file)) throw Error(`missing ${file}`); return files.get(file); },
        write: async (file, text) => { files.set(file, text); },
        files: async () => [...files.keys()],
      },
    },
  };
}

const cases = {
  async 'keeps a text paint when what it says changes'() {
    const { files, context } = project(`export default () => <scene id="s"></scene>;\n`);
    await applyEdits(context, [
      { kind: 'insert', source: 'pending#1', parent: `${FILE}:s`, tag: 'text', props: {}, text: 'Text' },
      { kind: 'insert', source: 'pending#2', parent: 'pending#1', tag: 'solidPaint', props: { color: '#FFFFFF' } },
    ]);
    const id = /<text id="([^"]+)"/.exec(files.get(FILE))[1];
    const result = await applyEdits(context, [{ kind: 'set', source: `${FILE}:${id}`, props: {}, text: 'Hello' }]);
    assert.deepEqual(result.skipped, []);
    assert.match(files.get(FILE), /<text id="[^"]+">Hello\s*<solidPaint id="[^"]+" color="#FFFFFF" \/>\s*<\/text>/);
  },
  async 'replaces every part of what a text says, and only that'() {
    const { files, context } = project(
      `export default () => (\n  <text id="t">\n    Hello {name}!\n    <solidPaint color="#FFFFFF" />\n    {/* note */}\n  </text>\n);\n`,
    );
    const result = await applyEdits(context, [{ kind: 'set', source: `${FILE}:t`, props: {}, text: 'Bye' }]);
    assert.deepEqual(result.skipped, []);
    assert.ok(
      files.get(FILE).includes(`  <text id="t">\n    Bye\n    <solidPaint color="#FFFFFF" />\n    {/* note */}\n  </text>`),
      files.get(FILE),
    );
  },
  async 'replaces plain text in place'() {
    const { files, context } = project(`export default () => <scene id="s"><text id="t">Old words</text></scene>;\n`);
    const result = await applyEdits(context, [{ kind: 'set', source: `${FILE}:t`, props: {}, text: 'New words' }]);
    assert.deepEqual(result.skipped, []);
    assert.ok(files.get(FILE).includes('<text id="t">New words</text>'), files.get(FILE));
  },
  async 'opens a self-closing text around new text'() {
    const { files, context } = project(`export default () => <scene id="s"><text id="t" fontSize={40} /></scene>;\n`);
    const result = await applyEdits(context, [{ kind: 'set', source: `${FILE}:t`, props: {}, text: 'Hi' }]);
    assert.deepEqual(result.skipped, []);
    assert.match(files.get(FILE), /<text id="t" fontSize=\{40\}>Hi<\/text>/);
  },
  async 'says text first in an element that holds only a paint'() {
    const { files, context } = project(`export default () => <scene id="s"><text id="t"><solidPaint color="#000000" /></text></scene>;\n`);
    const result = await applyEdits(context, [{ kind: 'set', source: `${FILE}:t`, props: {}, text: 'Hi' }]);
    assert.deepEqual(result.skipped, []);
    assert.match(files.get(FILE), /<text id="t">Hi<solidPaint color="#000000" \/><\/text>/);
  },
  // Upstream a0f843f: the canvas shows an edit before the file has it, and an
  // export and the next open render the file, so an edit the write left out
  // would move back. The user wins: a prop is written over a literal and over
  // an expression alike.
  async 'writes a prop over a literal and over an expression alike'() {
    const { files, context } = project(
      `const X = 100;\nexport default () => <video id="clip" x={X} y={20} rotation={ticker() * 2} />;\n`,
    );
    const result = await applyEdits(context, [
      { kind: 'set', source: `${FILE}:clip`, props: { x: 555, y: 42, rotation: 90 } },
    ]);
    assert.deepEqual(result.skipped, []);
    assert.ok(files.get(FILE).includes(`<video id="clip" x={555} y={42} rotation={90} />`), files.get(FILE));
    // The constant is someone else's too, and stays.
    assert.ok(files.get(FILE).includes(`const X = 100;`), files.get(FILE));
  },
  // A text's colour is the colour you see: `fill` on a text lands on its
  // topmost visible solid paint, or on its own fill/color without one. The
  // prepare path of proposeCutEdits runs exactly this (retarget, then apply).
  async 'recolours the solid paint a T-tool-style text is seen in'() {
    const { files, context } = project(
      `export default () => <scene id="s"><text id="t" x={10}>Text<solidPaint id="p" color="#FFFFFF" /></text></scene>;\n`,
    );
    const edits = await retargetTextColours(context.io, [{ kind: 'set', source: `${FILE}:t`, props: { fill: '#FF0000' } }]);
    assert.deepEqual(edits, [{ kind: 'set', source: `${FILE}:p`, props: { color: '#FF0000' } }]);
    const result = await applyEdits(context, edits);
    assert.deepEqual(result.skipped, []);
    assert.ok(files.get(FILE).includes('<text id="t" x={10}>Text<solidPaint id="p" color="#FF0000" /></text>'), files.get(FILE));
  },
  async 'keeps the other props and the words on the text while the paint takes the colour'() {
    const { files, context } = project(
      `export default () => <scene id="s"><text id="t" x={10}>Text<solidPaint id="p" color="#FFFFFF" /></text></scene>;\n`,
    );
    const edits = await retargetTextColours(context.io, [
      { kind: 'set', source: `${FILE}:t`, props: { x: 20, fill: '#FF0000' }, text: 'Hello' },
    ]);
    assert.deepEqual(edits, [
      { kind: 'set', source: `${FILE}:t`, props: { x: 20 }, text: 'Hello' },
      { kind: 'set', source: `${FILE}:p`, props: { color: '#FF0000' } },
    ]);
    await applyEdits(context, edits);
    assert.ok(files.get(FILE).includes('<text id="t" x={20}>Hello<solidPaint id="p" color="#FF0000" /></text>'), files.get(FILE));
  },
  async 'passes over a hidden paint to the topmost visible one'() {
    const { files, context } = project(
      `export default () => <text id="t">Hi<solidPaint id="a" color="#000000" /><solidPaint id="b" color="#00FF00" hidden /><linearGradientPaint id="g" hidden /></text>;\n`,
    );
    const edits = await retargetTextColours(context.io, [{ kind: 'set', source: `${FILE}:t`, props: { fill: '#FF0000' } }]);
    assert.deepEqual(edits, [{ kind: 'set', source: `${FILE}:a`, props: { color: '#FF0000' } }]);
    await applyEdits(context, edits);
    assert.ok(files.get(FILE).includes('<solidPaint id="a" color="#FF0000" /><solidPaint id="b" color="#00FF00" hidden />'), files.get(FILE));
  },
  async 'writes the own fill of a text no paint covers'() {
    const { files, context } = project(`export default () => <text id="t" fill="#ffffff">Hi</text>;\n`);
    const edits = await retargetTextColours(context.io, [{ kind: 'set', source: `${FILE}:t`, props: { fill: '#FF0000' } }]);
    assert.deepEqual(edits, [{ kind: 'set', source: `${FILE}:t`, props: { fill: '#FF0000' } }]);
    await applyEdits(context, edits);
    assert.ok(files.get(FILE).includes('<text id="t" fill="#FF0000">Hi</text>'), files.get(FILE));
  },
  async 'writes color, not a second fill, on a text that spells its colour as color'() {
    const { files, context } = project(`export default () => <text id="t" color="#FFFFFF">Text</text>;\n`);
    const edits = await retargetTextColours(context.io, [{ kind: 'set', source: `${FILE}:t`, props: { fill: '#FF0000' } }]);
    assert.deepEqual(edits, [{ kind: 'set', source: `${FILE}:t`, props: { color: '#FF0000' } }]);
    await applyEdits(context, edits);
    assert.ok(files.get(FILE).includes('<text id="t" color="#FF0000">Text</text>'), files.get(FILE));
  },
  async 'recolours the solid paint a rect is seen in, not its covered fill'() {
    const { files, context } = project(`export default () => <rect id="r" fill="#000000"><solidPaint id="p" color="#FFFFFF" /></rect>;\n`);
    const edits = await retargetTextColours(context.io, [{ kind: 'set', source: `${FILE}:r`, props: { fill: '#FF0000' } }]);
    assert.deepEqual(edits, [{ kind: 'set', source: `${FILE}:p`, props: { color: '#FF0000' } }]);
    await applyEdits(context, edits);
    assert.ok(files.get(FILE).includes('<rect id="r" fill="#000000"><solidPaint id="p" color="#FF0000" /></rect>'), files.get(FILE));
  },
  async 'writes the own fill of a rect no paint covers'() {
    const { context } = project(`export default () => <rect id="r" fill="#000000" />;\n`);
    const edits = [{ kind: 'set', source: `${FILE}:r`, props: { fill: '#FF0000' } }];
    assert.deepEqual(await retargetTextColours(context.io, edits), edits);
  },
  async 'leaves fill on a video alone'() {
    const { context } = project(`export default () => <video id="v" fill="#000000"><solidPaint id="p" color="#FFFFFF" /></video>;\n`);
    const edits = [{ kind: 'set', source: `${FILE}:v`, props: { fill: '#FF0000' } }];
    assert.deepEqual(await retargetTextColours(context.io, edits), edits);
  },
  async 'writes an object mask the way the tool commits it'() {
    const { files, context } = project(`export default () => <scene id="s"><rect id="clip" width={640} height={360}><videoPaint src="clip.mp4" /></rect></scene>;\n`);
    const result = await applyEdits(context, [
      { kind: 'insert', source: 'pending#1', parent: `${FILE}:clip`, tag: 'effect', props: { type: 'opacity', value: 1 } },
      { kind: 'insert', source: 'pending#2', parent: 'pending#1', tag: 'mask', props: { src: 'masks/clip/Tracking 1.mask', sourceIn: 1.5 } },
    ]);
    assert.deepEqual(result.skipped, []);
    const source = files.get(FILE);
    assert.match(source, /<effect id="[^"]+" type="opacity" value=\{1\}>\s*<mask id="[^"]+" src="masks\/clip\/Tracking 1\.mask" sourceIn=\{1\.5\} \/>\s*<\/effect>/, source);
    assert.match(source, /<videoPaint src="clip\.mp4" \/>/, source);
  },
  async 'sets, clears and removes mask props'() {
    const { files, context } = project(`export default () => <scene id="s"><rect id="r"><effect id="e" type="blur" value={8}><mask id="m" src="masks/a/Tracking 1.mask" /></effect></rect></scene>;\n`);
    let result = await applyEdits(context, [{ kind: 'set', source: `${FILE}:m`, props: { inverted: true, smoothing: 0.5, blur: 4, opacity: 0.8 } }]);
    assert.deepEqual(result.skipped, []);
    assert.ok(files.get(FILE).includes('<mask id="m" src="masks/a/Tracking 1.mask" inverted smoothing={0.5} blur={4} opacity={0.8} />'), files.get(FILE));
    result = await applyEdits(context, [{ kind: 'set', source: `${FILE}:m`, props: { inverted: false } }]);
    assert.deepEqual(result.skipped, []);
    assert.ok(files.get(FILE).includes('<mask id="m" src="masks/a/Tracking 1.mask" smoothing={0.5} blur={4} opacity={0.8} />'), files.get(FILE));
    result = await applyEdits(context, [{ kind: 'remove', source: `${FILE}:m` }]);
    assert.deepEqual(result.skipped, []);
    assert.ok(!files.get(FILE).includes('<mask'), files.get(FILE));
    assert.match(files.get(FILE), /<effect id="e" type="blur" value=\{8\}>\s*<\/effect>/);
  },
  async 'makes a rect a clip path the way the clip path tool does'() {
    const { files, context } = project(`export default () => <scene id="s"><text id="t" end={4}>Wipe</text><rect id="r" x={10} width={200} height={80} /></scene>;\n`);
    const result = await applyEdits(context, [
      { kind: 'move', source: `${FILE}:r`, parent: `${FILE}:t` },
      { kind: 'set', source: `${FILE}:r`, props: { clipPath: true, x: 0 } },
    ]);
    assert.deepEqual(result.skipped, []);
    assert.match(files.get(FILE), /<text id="t" end=\{4\}>Wipe\s*<rect id="r" x=\{0\} width=\{200\} height=\{80\} clipPath \/>\s*<\/text>/, files.get(FILE));
  },
};

// proposeCutEdits guard: a colour never becomes words.
Object.assign(cases, {
  async 'rejects text that is only a colour'() {
    for (const text of ['#DF2626', 'DF2626', '#fff', 'rgb(223, 38, 38)'])
      assert.throws(() => validateScopedEdits([{ source: `${FILE}:t`, text }]), /not its colour/, text);
  },
  async 'rejects a recolour that also changes the words'() {
    assert.throws(() => validateScopedEdits([{ source: `${FILE}:t`, props: { fill: '#DF2626' }, text: 'Hello' }]), /must not change the words/);
  },
  async 'accepts ordinary words, including hex-letter words, and a recolour on its own'() {
    for (const text of ['facade', 'decade', '#1 hit', 'A conversation about design'])
      assert.equal(validateScopedEdits([{ source: `${FILE}:t`, text }])[0].text, text);
    assert.deepEqual(validateScopedEdits([{ source: `${FILE}:t`, props: { fill: '#DF2626' } }])[0].props, { fill: '#DF2626' });
  },
});

let failed = 0;
for (const [name, run] of Object.entries(cases)) {
  try { await run(); console.log(`ok   ${name}`); }
  catch (error) { failed++; console.log(`FAIL ${name}\n     ${error.message.split('\n').join('\n     ')}`); }
}
await rm(out, { recursive: true, force: true });
console.log(`${Object.keys(cases).length - failed}/${Object.keys(cases).length} passed`);
process.exit(failed ? 1 : 0);
