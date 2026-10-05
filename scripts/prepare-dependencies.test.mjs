import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { prepareDependencies } from './prepare-dependencies.mjs';

test('nested workspace bootstrap installs missing packages and skips a ready tree', () => {
  const root = mkdtempSync(join(tmpdir(), 'purecut-deps-'));
  const previous = process.env.npm_execpath;
  try {
    mkdirSync(join(root, 'packages/runtime'), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ workspaces: ['packages/runtime'] }));
    writeFileSync(join(root, 'packages/runtime/package.json'), JSON.stringify({ name: '@diffusionstudio/runtime' }));
    const npm = join(root, 'npm.cjs');
    writeFileSync(npm, `require('node:fs').writeFileSync(${JSON.stringify(join(root, 'args.json'))}, JSON.stringify(process.argv.slice(2)))`);
    process.env.npm_execpath = npm;
    prepareDependencies(root);
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'args.json'), 'utf8')),
      ['--prefix', root, 'ci', '--legacy-peer-deps']);
    mkdirSync(join(root, 'node_modules/@diffusionstudio/runtime'), { recursive: true });
    mkdirSync(join(root, 'node_modules/koota'), { recursive: true });
    mkdirSync(join(root, 'node_modules/vite/bin'), { recursive: true });
    writeFileSync(join(root, 'node_modules/vite/bin/vite.js'), '');
    writeFileSync(npm, 'process.exit(42)');
    prepareDependencies(root);
    rmSync(join(root, 'node_modules/koota'), { recursive: true });
    assert.throws(() => prepareDependencies(root), /installation failed \(42\)/);
  } finally {
    if (previous === undefined) delete process.env.npm_execpath;
    else process.env.npm_execpath = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
