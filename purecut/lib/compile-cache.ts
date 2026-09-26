import { join, type ProjectFiles } from './platform-files';

const revision = import.meta.env.VITE_PURECUT_COMPILER_HASH;
const cachePath = (dir: string) => join(dir, 'cache/compiled-source.json');
const digest = async (code: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code))), byte => byte.toString(16).padStart(2, '0')).join('');

export async function readCompiledSource(fs: ProjectFiles, dir: string, sourceHash: string): Promise<string | null> {
  if (!revision) return null;
  try {
    const cached = JSON.parse(await fs.read(cachePath(dir)));
    return cached.version === 1 && cached.compilerHash === revision && cached.sourceHash === sourceHash && typeof cached.code === 'string' && cached.code.length > 0 && cached.codeHash === await digest(cached.code)
      ? cached.code : null;
  } catch { return null; }
}

export async function rememberCompiledSource(fs: ProjectFiles, dir: string, sourceHash: string, code: string): Promise<void> {
  if (!revision) return;
  try {
    await fs.write(cachePath(dir), JSON.stringify({ version: 1, compilerHash: revision, sourceHash, code, codeHash: await digest(code) }));
  } catch {
    // A cache is optional: read-only folders and storage failures must not
    // turn a successful compile or source save into a failed operation.
  }
}
