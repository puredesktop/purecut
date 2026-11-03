/**
 * Three-way merges of what the editor saves whole. `base` is what this copy last read, `mine` is what it is saving, and
 * `theirs` is the file as another copy left it. A change either made stays; where both changed one thing, mine wins, being
 * the later save; something either removed stays removed.
 */
export interface ManifestShape {
  version?: number;
  folders?: string[];
  assets?: Array<{ id: string }>;
  [key: string]: unknown;
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function mergeEntries<T>(base: readonly T[], mine: readonly T[], theirs: readonly T[], key: (item: T) => string): T[] {
  const index = (items: readonly T[]) => new Map(items.map(item => [key(item), item]));
  const inBase = index(base), inMine = index(mine), inTheirs = index(theirs);
  const merged: T[] = [];
  // Theirs first when new: the library lists the newest first.
  for (const item of theirs) if (!inBase.has(key(item)) && !inMine.has(key(item))) merged.push(item);
  for (const item of mine) {
    const k = key(item), had = inBase.get(k), other = inTheirs.get(k);
    if (had === undefined) merged.push(item); // mine alone
    else if (other !== undefined) merged.push(same(item, had) ? other : item);
    // else: they removed it
  }
  return merged;
}

export function mergeManifest(base: ManifestShape, mine: ManifestShape, theirs: ManifestShape): ManifestShape {
  return {
    ...theirs,
    ...mine,
    folders: mergeEntries(base.folders ?? [], mine.folders ?? [], theirs.folders ?? [], folder => folder),
    assets: mergeEntries(base.assets ?? [], mine.assets ?? [], theirs.assets ?? [], asset => asset.id),
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

function mergeRecord(base: Record<string, unknown>, mine: Record<string, unknown>, theirs: Record<string, unknown>, deep: readonly string[] = []) {
  const merged: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(base), ...Object.keys(mine), ...Object.keys(theirs)])) {
    const value = deep.includes(key) && isRecord(mine[key] ?? {}) && isRecord(theirs[key] ?? {}) && (key in mine || key in theirs)
      ? mergeRecord(isRecord(base[key]) ? base[key] : {}, (mine[key] as Record<string, unknown>) ?? {}, (theirs[key] as Record<string, unknown>) ?? {})
      : same(mine[key], base[key]) ? theirs[key] : mine[key];
    if (value !== undefined && !(deep.includes(key) && isRecord(value) && !Object.keys(value).length)) merged[key] = value;
  }
  return merged;
}

/** The settings key by key, and a scene's export settings by scene, so two copies setting up two scenes both stay. */
export function mergeConfig(base: unknown, mine: unknown, theirs: unknown): Record<string, unknown> | null {
  const merged = mergeRecord(isRecord(base) ? base : {}, isRecord(mine) ? mine : {}, isRecord(theirs) ? theirs : {}, ["export"]);
  return Object.keys(merged).length ? merged : null;
}
