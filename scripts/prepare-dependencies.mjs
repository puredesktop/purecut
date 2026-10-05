import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// The suite's npm install does not traverse this app's nested workspaces.
// Bootstrap them before importing the editor runtime or build tooling.
export function prepareDependencies(root) {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const packages = manifest.workspaces.map(workspace =>
    JSON.parse(readFileSync(join(root, workspace, 'package.json'), 'utf8')).name,
  );
  if (packages.every(name => existsSync(join(root, 'node_modules', name))) &&
      existsSync(join(root, 'node_modules/vite/bin/vite.js')) &&
      existsSync(join(root, 'node_modules/koota'))) return;

  console.log('[purecut] Installing nested editor workspaces and runtime patches…');
  const npm = process.env.npm_execpath;
  const result = spawnSync(npm ? process.execPath : (process.platform === 'win32' ? 'npm.cmd' : 'npm'),
    [...(npm ? [npm] : []), '--prefix', root, 'ci', '--legacy-peer-deps'],
    { cwd: root, stdio: 'inherit', env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`PureCut dependency installation failed (${result.status ?? result.signal}).`);
}
