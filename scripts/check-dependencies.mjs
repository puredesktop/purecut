import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const json = async path => JSON.parse(await readFile(new URL(path, root), 'utf8'));
const manifest = await json('package.json');
const lock = await json('package-lock.json');
const workspaces = ['apps/web', 'packages/assets', 'packages/dapi', 'packages/encoder',
  'packages/jsx', 'packages/koota-solid', 'packages/reconciler', 'packages/runtime'];
assert.deepEqual(manifest.workspaces, workspaces, 'Review changes to the integrated editor workspace allowlist');
assert.deepEqual(lock.packages[''].workspaces, workspaces, 'Lockfile workspace list is stale');
const forbidden = /^(?:electron|update-electron-app|@electron-forge\/.*|@electron\/.*|@anthropic-ai\/.*|@openai\/codex(?:-.*)?|@modelcontextprotocol\/sdk|@diffusionstudio\/(?:desktop|cli|agent-chat))$/;
for (const [path, pkg] of Object.entries(lock.packages)) {
  const name = path.split('node_modules/').at(-1);
  assert(!forbidden.test(name) && !forbidden.test(pkg.name ?? ''), `Standalone runtime in lockfile: ${path}`);
  assert(!pkg.extraneous, `Extraneous lockfile entry: ${path}`);
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const name of Object.keys(pkg[field] ?? {})) {
      assert(!forbidden.test(name), `Standalone runtime dependency: ${path} -> ${name}`);
    }
  }
}
for (const path of ['apps/desktop', 'apps/cli', 'packages/agent-chat']) {
  await assert.rejects(access(new URL(path, root)), `Remove unused standalone source: ${path}`);
}
for (const path of ['', ...workspaces]) {
  const pkg = await json(path ? `${path}/package.json` : 'package.json');
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    assert.deepEqual(pkg[field] ?? {}, lock.packages[path][field] ?? {}, `Stale ${field} in lockfile: ${path}`);
  }
}
console.log('Integrated editor dependency boundary passed: no standalone desktop, CLI, or agent runtime.');
