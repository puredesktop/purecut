import { readPlatformStorageJson, writePlatformStorageJson } from '@purescience/platform-ui/bridge/storage.mjs';
import { readPlatformFilePreviewUrl } from '@purescience/platform-ui/bridge/fs.mjs';
import { trashPlatformPath } from '@purescience/platform-ui/bridge/os.mjs';

export type ExportRecord = {
  id: string;
  projectId: string;
  path: string;
  relativePath?: string;
  createdAt: string;
  sourceHash: string | null;
  config: unknown;
};

const request = { appSlug: 'cut', fileName: 'export-history.json' } as const;

export function isAudioExport(entry: ExportRecord): boolean {
  if (/\.(ogg|wav|mp3|m4a|flac|aac)$/i.test(entry.path)) return true;
  const config = entry.config;
  if (!config || typeof config !== 'object') return false;
  const { format, video } = config as { format?: unknown; video?: unknown };
  return format === 'ogg' || !!(video && typeof video === 'object' &&
    'enabled' in video && video.enabled === false);
}

export function exportDetails(entry: ExportRecord): string {
  const config = entry.config;
  if (!config || typeof config !== 'object') return 'Settings unavailable';
  const { format, video } = config as { format?: unknown; video?: unknown };
  const parts: string[] = [];
  if (typeof format === 'string' && /^(mp4|webm|mov|ogg)$/.test(format)) parts.push(format.toUpperCase());
  if (format === 'ogg') parts.push('Audio only');
  else if (video && typeof video === 'object') {
    const { enabled, resolution, fps, codec } = video as Record<string, unknown>;
    if (enabled === false) parts.push('Audio only');
    else {
      if (typeof resolution === 'number' && Number.isFinite(resolution) && resolution > 0) parts.push(`${resolution}p`);
      if (typeof fps === 'number' && Number.isFinite(fps) && fps > 0) parts.push(`${fps} fps`);
      if (typeof codec === 'string' && /^[a-z0-9-]{1,20}$/i.test(codec)) parts.push(codec.toUpperCase());
    }
  }
  return parts.join(' · ') || 'Settings unavailable';
}

export function exportPath(entry: ExportRecord, projectDir: string): string {
  if (!entry.relativePath) return entry.path;
  if (typeof entry.relativePath !== 'string' ||
    !/^renders\/[^/\\]+$/.test(entry.relativePath) || entry.relativePath.includes('\0') ||
    ['.', '..'].includes(entry.relativePath.slice('renders/'.length)))
    throw Error('Invalid export location.');
  return projectDir.replace(/[/\\]$/, '') + '/' + entry.relativePath;
}

function records(value: unknown): ExportRecord[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is ExportRecord => !!entry &&
    typeof entry.id === 'string' && typeof entry.projectId === 'string' &&
    typeof entry.path === 'string' && typeof entry.createdAt === 'string');
}

export async function listExports(projectId: string): Promise<ExportRecord[]> {
  const { value } = await readPlatformStorageJson(request);
  return records(value).filter(entry => entry.projectId === projectId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function update(change: (entries: ExportRecord[]) => ExportRecord[]) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const current = await readPlatformStorageJson(request);
    const result = await writePlatformStorageJson({ ...request,
      ifMatch: current.version, value: change(records(current.value)) });
    if (result.ok) {
      window.dispatchEvent(new Event('purecut:export-history-changed'));
      return;
    }
    if (!result.conflict) throw Error('Could not save export history.');
  }
  throw Error('Export history changed elsewhere. Please retry.');
}

export function rememberExport(entry: ExportRecord) {
  return update(entries => [...entries.filter(item => item.id !== entry.id), entry]);
}

/** Shared registration for UI and assistant exports after the file has finished writing. */
export function recordSuccessfulExport(options: {
  projectId: string; projectDir: string; path: string; sourceHash?: string; config: unknown;
}) {
  const { projectId, projectDir, path, sourceHash, config } = options;
  const prefix = projectDir.replace(/[/\\]$/, '') + '/';
  const relative = path.startsWith(prefix) ? path.slice(prefix.length) : undefined;
  return rememberExport({ id: crypto.randomUUID(), projectId, path,
    relativePath: relative && /^renders\/[^/\\]+$/.test(relative) ? relative : undefined,
    createdAt: new Date().toISOString(), sourceHash: sourceHash ?? null,
    config: structuredClone(config) });
}

/** Forgetting history never deletes the rendered file. */
export function forgetExport(id: string, projectId: string) {
  return update(entries => entries.filter(item => item.id !== id || item.projectId !== projectId));
}

/** The caller must confirm this exact path before invoking the destructive action. */
export async function trashExport(entry: ExportRecord, projectDir: string, confirmedPath: string) {
  const current = (await listExports(entry.projectId)).find(item => item.id === entry.id);
  if (!current || exportPath(current, projectDir) !== confirmedPath)
    throw Error('This export changed. Select it again before moving it to Trash.');
  const path = exportPath(current, projectDir);
  if (!path.startsWith('/') || path.includes('\\') || path.includes('\0') ||
    path.split('/').some(part => part === '..' || part === '.') ||
    !/\.(mp4|webm|mov|m4v|mkv|ogg|wav|mp3|m4a|flac|aac)$/i.test(path))
    throw Error('Invalid export file location.');
  const prefix = projectDir.replace(/\/$/, '') + '/';
  if (path.startsWith(prefix) && !/^renders\/[^/]+$/.test(path.slice(prefix.length)))
    throw Error('Project source files cannot be trashed from export history.');
  // Preview resolution also rejects directories and unavailable files.
  await readPlatformFilePreviewUrl(path);
  await trashPlatformPath(path);
  try { await forgetExport(entry.id, entry.projectId); }
  catch { throw Error('File moved to Trash, but history could not be updated. Remove its history entry separately.'); }
}

/** Update only the location; concurrent metadata changes must survive. */
export function relocateExport(id: string, projectId: string, path: string, projectDir: string) {
  if (!path || path.includes('\0')) throw Error('Invalid export location.');
  const prefix = projectDir.replace(/[/\\]$/, '') + '/';
  const relativePath = path.startsWith(prefix) ? path.slice(prefix.length) : undefined;
  return update(entries => {
    if (!entries.some(entry => entry.id === id && entry.projectId === projectId))
      throw Error('This export was removed from history.');
    return entries.map(entry => entry.id === id && entry.projectId === projectId
      ? { ...entry, path, relativePath: relativePath && /^renders\/[^/\\]+$/.test(relativePath) ? relativePath : undefined }
      : entry);
  });
}
