import {
  listPlatformFiles,
  readPlatformTextFile,
  writePlatformTextFile,
  readPlatformFilePreviewUrl,
  writePlatformFileBlob,
  deletePlatformFile,
} from "@purescience/platform-ui/bridge/fs.mjs";
import { readPlatformStorageJson } from "@purescience/platform-ui/bridge/storage.mjs";
export const join = (base: string, relative: string) => {
  if (/^[a-z]:|^[/\\]|(^|[/\\])\.\.([/\\]|$)|\0/i.test(relative))
    throw Error("Invalid project-relative path");
  return base.replace(/[/\\]$/, "") + "/" + relative;
};
export function projectPath(base: string, value: string) {
  const b = base.replaceAll("\\", "/").replace(/\/$/, ""),
    v = String(value).replaceAll("\\", "/");
  if (v === b) return base;
  if (v.startsWith(b + "/")) return join(base, v.slice(b.length + 1));
  return join(base, value);
}
export const parent = (p: string) => p.replace(/[/\\][^/\\]+$/, "");
export const basename = (p: string) => p.split(/[/\\]/).pop()!;
export const files = {
  async root() {
    const { path } = await readPlatformStorageJson({
      appSlug: "cut",
      fileName: "purecut-settings.json",
    });
    return join(parent(path), "PureCut");
  },
  read: readPlatformTextFile,
  write: writePlatformTextFile,
  async list(path: string) {
    return (await listPlatformFiles(path)).entries;
  },
  remove: deletePlatformFile,
  async file(path: string) {
    // Let Chromium receive the native stream as a Blob instead of copying a
    // complete base64 string through IPC and decoding it on the editor thread.
    const { url, mimeType, modifiedAt } = await readPlatformFilePreviewUrl(path);
    const response = await fetch(url);
    if (!response.ok)
      throw Error(`Could not read media (${response.status}): ${basename(path)}`);
    const blob = await response.blob();
    const lastModified = modifiedAt ? Date.parse(modifiedAt) : NaN;
    return new File([blob], basename(path), {
      type: blob.type || mimeType,
      ...(Number.isFinite(lastModified) ? { lastModified } : {}),
    });
  },
  async binary(path: string, blob: Blob) {
    await writePlatformFileBlob(path, blob);
  },
};
export type ProjectFiles = typeof files;
