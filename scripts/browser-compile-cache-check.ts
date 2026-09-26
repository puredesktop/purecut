import { ProjectService } from '../purecut/lib/projects';
import { readCompiledSource } from '../purecut/lib/compile-cache';
import type { ProjectFiles } from '../purecut/lib/platform-files';

export async function checkCompileCache() {
  const stored = new Map<string, string>();
  let failCache = false;
  let changeDuringRead: (() => void) | undefined;
  const fs = {
    root: async () => '/compile-cache',
    read: async (path: string) => {
      const result = stored.get(path);
      if (path.endsWith('compiled-source.json')) changeDuringRead?.();
      if (result === undefined) throw Error('Missing fixture file');
      return result;
    },
    write: async (path: string, value: string) => {
      if (failCache && path.endsWith('compiled-source.json')) throw Error('Cache unavailable');
      stored.set(path, value);
    },
  } as ProjectFiles;
  const service = new ProjectService(fs);
  await service.init();
  const { dir } = await service.call('projects:create');
  const compiled = await service.call('projects:compile', { dir });
  const key = `${dir}/cache/compiled-source.json`;
  const source = await service.readSource(dir);
  const valid = stored.get(key)!;
  const check = (value: unknown, message: string) => { if (!value) throw Error(message); };
  check(await readCompiledSource(fs, dir, source.hash) === compiled.code, 'Fresh output must be reusable');
  check((await service.call('projects:compile', { dir })).code === compiled.code, 'Cache hit must return identical output');
  for (const field of ['compilerHash', 'sourceHash', 'codeHash', 'code', 'version']) {
    stored.set(key, JSON.stringify({ ...JSON.parse(valid), [field]: 'invalid' }));
    check(await readCompiledSource(fs, dir, source.hash) === null, `Changed ${field} must invalidate cache`);
  }
  stored.set(key, '{broken');
  check((await service.call('projects:compile', { dir })).code === compiled.code, 'Corrupt cache must rebuild');
  stored.set(`${dir}/index.tsx`, source.source.replace('Welcome to PureCut', 'Changed outside'));
  const changed = await service.call('projects:compile', { dir });
  check(changed.code.includes('Changed outside') && changed.sourceHash !== source.hash, 'External source changes must compile');
  stored.delete(key);
  failCache = true;
  check((await service.call('projects:compile', { dir })).ok, 'Cache write failure must not fail compilation');
  const current = await service.readSource(dir);
  await service.call('purecut:replace', { dir, baseHash: current.hash, source: current.source.replace('Changed outside', 'Saved without cache') });
  check((await service.readSource(dir)).source.includes('Saved without cache'), 'Cache write failure must not fail source saving');
  failCache = false;
  const beforeRace = await service.call('projects:compile', { dir });
  changeDuringRead = () => { stored.set(`${dir}/index.tsx`, source.source); changeDuringRead = undefined; };
  const snapshot = await service.call('projects:compile', { dir });
  check(snapshot.code === beforeRace.code && snapshot.sourceHash === beforeRace.sourceHash, 'Concurrent source changes must not relabel a cached snapshot');
  check((await service.readSource(dir)).source === source.source, 'Reading cached output must preserve external source changes');
}
