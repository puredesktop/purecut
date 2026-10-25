// OPFS is shared by tabs. A lifetime Web Lock distinguishes an active file
// from leftovers after a crash/reload; the browser releases it with the tab.
const lockName = (name: string) => "purecut-opfs-" + name;
const stagingName = /^cut-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function holdMediaStaging(name: string): Promise<() => void> {
  return new Promise((resolve, reject) => {
    void navigator.locks.request(lockName(name), () =>
      new Promise<void>(release => resolve(release)),
    ).catch(reject);
  });
}

/** Called under purecut-project-io, before allocating new staging storage. */
export async function sweepMediaStaging(root: FileSystemDirectoryHandle) {
  const directory = root as FileSystemDirectoryHandle & {
    entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
  };
  for await (const [name, handle] of directory.entries()) {
    if (handle.kind !== "file" || !stagingName.test(name)) continue;
    await navigator.locks.request(lockName(name), { ifAvailable: true }, async lock => {
      if (lock) await root.removeEntry(name).catch(() => {});
    });
  }
}
