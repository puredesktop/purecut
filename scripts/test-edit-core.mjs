// Node checks for purecut/editor-core/edit-core.ts against an in-memory project.
// Covers text edits (upstream diffusionstudio/editor ae33eab): a text edit
// replaces only what an element says and keeps its paint, strokes and comments.
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
};

let failed = 0;
for (const [name, run] of Object.entries(cases)) {
  try { await run(); console.log(`ok   ${name}`); }
  catch (error) { failed++; console.log(`FAIL ${name}\n     ${error.message.split('\n').join('\n     ')}`); }
}
await rm(out, { recursive: true, force: true });
console.log(`${Object.keys(cases).length - failed}/${Object.keys(cases).length} passed`);
process.exit(failed ? 1 : 0);
