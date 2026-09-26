/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */


import { PEAK_BARS } from './derive/peaks';
import { deriveThumbnail, DEFAULT_THUMBNAIL_WIDTH } from './derive/thumbnail';
import { derivePlaybackProxy } from './derive/proxy';
import { deriveWaveform, downsamplePeaks } from './derive/waveform';

import type { ProjectFS } from './fs';
import type { Asset } from './types';

/** The project directory derived data is kept in. */
export const CACHE_DIR = 'cache';

/** Whether a project-relative path is inside the cache directory. */
export const isCacheFile = (path: string): boolean => path === CACHE_DIR || path.startsWith(`${CACHE_DIR}/`);

/** A kind of cached value: where it lives under `cache/`, and how it is stored. */
export interface CacheKind<T> {
	/** Subdirectory of `cache/`. */
	dir: string;
	/** File extension (no dot). */
	ext: string;
	encode(value: T): Blob;
	decode(blob: Blob): Promise<T>;
}

/** The asset bar's thumbnail: a WebP, stored as is. */
export const THUMBNAIL: CacheKind<Blob> = {
	dir: 'thumbnails',
	ext: 'webp',
	encode: (blob) => blob,
	decode: async (blob) => blob,
};

export const PLAYBACK_PROXY: CacheKind<Blob> = {
	dir: 'playback-proxies-v1', ext: 'webm', encode: blob => blob, decode: async blob => blob,
};

/** The rough waveform: one byte per bar, stored raw. */
export const PEAKS: CacheKind<Uint8ClampedArray> = {
	dir: 'peaks',
	ext: 'u8',
	encode: (peaks) => new Blob([peaks as Uint8ClampedArray<ArrayBuffer>]),
	decode: async (blob) => new Uint8ClampedArray(await blob.arrayBuffer()),
};

/**
 * The full waveform: the whole file at `WAVEFORM_PEAKS_PER_SECOND`, one byte
 * a peak and nothing else, so the peak at a moment of the file is the byte at
 * that moment's index. The one entry read a stretch at a time rather than
 * whole (see `ensure`) — an hour of audio is a few megabytes of it.
 */
export const WAVEFORM: CacheKind<Uint8ClampedArray> = {
	dir: 'waveforms',
	ext: 'u8',
	encode: (peaks) => new Blob([peaks as Uint8ClampedArray<ArrayBuffer>]),
	decode: async (blob) => new Uint8ClampedArray(await blob.arrayBuffer()),
};

/** What an entry is keyed by: an asset, or just its id. */
type Keyed = string | Pick<Asset, 'id'>;

const idOf = (keyed: Keyed): string => (typeof keyed === 'string' ? keyed : keyed.id);

export class AssetCache {
	private readonly fs: ProjectFS;
	/** Reads and derivations under way, by `kind.dir/id[@variant]`. */
	private readonly inflight = new Map<string, Promise<unknown>>();
	/** The same, for entries asked for as files rather than as values. */
	private readonly files = new Map<string, Promise<File | null>>();
	/** Every kind used, so `remove` and `prune` know which directories to look in. */
	private readonly kinds = new Map<string, CacheKind<unknown>>();
	private deriving = 0;
	private readonly waiting: (() => void)[] = [];
	private readonly revisions = new Map<string, number>();
	private readonly removals = new Map<string, Promise<void>>();
	private readonly writes = new Map<string, Promise<void>>();
	private readonly kindRevisions = new Map<string, number>();
	private clearing: Promise<void> | undefined;
	private readonly cancellation = new AbortController();

	public constructor(fs: ProjectFS) {
		this.fs = fs;
		this.register(THUMBNAIL);
		this.register(PEAKS);
		this.register(WAVEFORM);
		this.register(PLAYBACK_PROXY);
	}

	// -----------------------------------------------------------------------
	// Typed entries

	/**
	 * The asset's thumbnail (IMAGE, VIDEO, or SEQUENCE by its first frame):
	 * a WebP `width` wide at the asset's own aspect ratio, or null when none
	 * can be made. Widths other than the default are kept as variants.
	 */
	public thumbnail(asset: Asset, width = DEFAULT_THUMBNAIL_WIDTH): Promise<Blob | null> {
		const variant = width === DEFAULT_THUMBNAIL_WIDTH ? undefined : `${width}`;
		return this.get(THUMBNAIL, asset, () => this.derive(async () => {
			const file = await asset.handle.getFile();
			this.cancellation.signal.throwIfAborted();
			return deriveThumbnail(file, asset.mimeType, width);
		}), variant);
	}

	/**
	 * The asset's rough waveform, or null when it has no audio. Cut down from
	 * the full one, so a file is decoded once however many resolutions of it
	 * are asked for.
	 */
	public peaks(asset: Asset): Promise<Uint8ClampedArray | null> {
		return this.get(PEAKS, asset, async () => {
			const waveform = await this.waveform(asset);
			return waveform && downsamplePeaks(new Uint8ClampedArray(await waveform.arrayBuffer()), PEAK_BARS);
		});
	}

	/**
	 * The file the asset's full waveform is stored in, derived first where
	 * there is none, or null when it has no audio. A file rather than its
	 * bytes: the timeline draws the stretch of a clip that is on screen by
	 * reading the bytes that stretch covers (`file.slice(from, to)`) and no
	 * more.
	 */
	public waveform(asset: Asset): Promise<File | null> {
		return this.ensure(WAVEFORM, asset, () => this.derive(async () => deriveWaveform(await asset.handle.getFile(), undefined, this.cancellation.signal)));
	}

	public playbackProxy(asset: Asset, progress?: (value: number) => void): Promise<File | null> {
		if (asset.type !== 'VIDEO') return Promise.resolve(null);
		return this.ensure(PLAYBACK_PROXY, asset, () => this.derive(async () =>
			derivePlaybackProxy(await asset.handle.getFile(), this.cancellation.signal, progress)));
	}

	public cachedPlaybackProxy(asset: Asset): Promise<File | null> {
		if (asset.type !== 'VIDEO') return Promise.resolve(null);
		return this.ensure(PLAYBACK_PROXY, asset, async () => null);
	}

	// -----------------------------------------------------------------------
	// Generic entries

	/**
	 * The cached value for (kind, asset[, variant]): read from disk, else
	 * `produce()`d and written there. Concurrent calls share one result; a null
	 * from `produce` (nothing to derive) is not stored.
	 */
	public get<T>(kind: CacheKind<T>, keyed: Keyed, produce: () => Promise<T | null>, variant?: string): Promise<T | null> {
		if (this.cancellation.signal.aborted) return Promise.resolve(null);
		this.register(kind);
		const key = this.key(kind, keyed, variant);
		const running = this.inflight.get(key);
		if (running) return running as Promise<T | null>;

		const id = idOf(keyed), current = this.currentRevision(id, kind.dir);
		const promise = (async () => {
			await Promise.all([this.removals.get(id), this.clearing]);
			return current() ? this.load(kind, key, produce, current) : null;
		})().finally(() => { if (this.inflight.get(key) === promise) this.inflight.delete(key); });
		this.inflight.set(key, promise);
		return promise;
	}

	/**
	 * The file (kind, asset[, variant]) is stored in, `produce()`d and written
	 * there first where there is none: for entries whose consumer reads a
	 * stretch of them at a time rather than all of them at once. Concurrent
	 * calls share one derivation; null when there was nothing to derive.
	 */
	public ensure<T>(kind: CacheKind<T>, keyed: Keyed, produce: () => Promise<T | null>, variant?: string): Promise<File | null> {
		if (this.cancellation.signal.aborted) return Promise.resolve(null);
		this.register(kind);
		const key = this.key(kind, keyed, variant);
		const running = this.files.get(key);
		if (running) return running;

		const id = idOf(keyed), current = this.currentRevision(id, kind.dir);
		const promise = (async () => {
			await Promise.all([this.removals.get(id), this.clearing]);
			return current() ? this.loadFile(kind, key, produce, current) : null;
		})().finally(() => { if (this.files.get(key) === promise) this.files.delete(key); });
		this.files.set(key, promise);
		return promise;
	}

	/** Drops every entry of an asset on disk. */
	public async remove(keyed: Keyed): Promise<void> {
		const id = idOf(keyed);
		this.revisions.set(id, (this.revisions.get(id) ?? 0) + 1);
		const matches = (key: string) => key.split('/')[1] === id || key.split('/')[1]?.startsWith(`${id}@`);
		for (const key of this.inflight.keys()) if (matches(key)) this.inflight.delete(key);
		for (const key of this.files.keys()) if (matches(key)) this.files.delete(key);
		const previous = this.removals.get(id);
		const clearing = this.clearing;
		const pendingWrites = [...this.writes].filter(([key]) => matches(key)).map(([, promise]) => promise);
		const removal = (async () => {
			await Promise.all([previous, clearing]);
			await Promise.allSettled(pendingWrites);
			for (const kind of this.kinds.values()) {
				const entries = await this.fs.list(`${CACHE_DIR}/${kind.dir}`).catch(() => []);
				for (const entry of entries) {
					if (entry.name === `${id}.${kind.ext}` || entry.name.startsWith(`${id}@`)) {
						await this.fs.remove(`${CACHE_DIR}/${kind.dir}/${entry.name}`).catch(() => {});
					}
				}
			}
		})();
		this.removals.set(id, removal);
		try { await removal; }
		finally { if (this.removals.get(id) === removal) this.removals.delete(id); }
	}

	/** Removes entries on disk whose asset is not among `keep`. */
	public async prune(keep: Iterable<string>): Promise<void> {
		const ids = new Set(keep);
		const removals = new Map<string, Promise<void>>();
		const pruneId = (id: string) => {
			if (!ids.has(id) && !removals.has(id)) removals.set(id, this.remove(id));
		};
		for (const key of [...this.inflight.keys(), ...this.files.keys()]) pruneId(key.split('/')[1]!.split('@')[0]!);
		for (const kind of this.kinds.values()) {
			const entries = await this.fs.list(`${CACHE_DIR}/${kind.dir}`).catch(() => []);
			for (const entry of entries) {
				if (entry.kind !== 'file') continue;
				const stem = entry.name.split('.')[0]!.split('@')[0]!;
				// Active assets are owned by their invalidation; do not erase a
				// replacement written after that removal has already completed.
				if (ids.has(stem) || removals.has(stem)) continue;
				await this.fs.remove(`${CACHE_DIR}/${kind.dir}/${entry.name}`).catch(() => {});
			}
		}
		await Promise.all(removals.values());
	}

	/** Deletes everything on disk; one kind, or all of it. */
	public async clear(kind?: CacheKind<unknown>): Promise<void> {
		const directories = kind ? [kind.dir] : [...this.kinds.keys()];
		for (const dir of directories) this.kindRevisions.set(dir, (this.kindRevisions.get(dir) ?? 0) + 1);
		const matches = (key: string) => !kind || key.startsWith(`${kind.dir}/`);
		for (const key of this.inflight.keys()) if (matches(key)) this.inflight.delete(key);
		for (const key of this.files.keys()) if (matches(key)) this.files.delete(key);
		const pending = [this.clearing, ...this.removals.values(), ...[...this.writes].filter(([key]) => matches(key)).map(([, promise]) => promise)];
		const clearing = (async () => {
			await Promise.allSettled(pending);
			await this.fs.remove(kind ? `${CACHE_DIR}/${kind.dir}` : CACHE_DIR).catch(() => {});
		})();
		this.clearing = clearing;
		try { await clearing; }
		finally { if (this.clearing === clearing) this.clearing = undefined; }
	}

	// -----------------------------------------------------------------------

	/** Stops queued derivations and active waveform workers without deleting cache. */
	public dispose(): void {
		this.cancellation.abort();
		for (const wake of this.waiting.splice(0)) wake();
	}

	private register(kind: CacheKind<unknown>): void {
		if (!this.kinds.has(kind.dir)) this.kinds.set(kind.dir, kind);
	}

	private currentRevision(id: string, dir: string): () => boolean {
		const assetRevision = this.revisions.get(id), kindRevision = this.kindRevisions.get(dir);
		return () => !this.cancellation.signal.aborted && this.revisions.get(id) === assetRevision && this.kindRevisions.get(dir) === kindRevision;
	}

	/** Bound expensive decoders/workers, not cache reads or nested peak lookups. */
	private async derive<T>(produce: () => Promise<T>): Promise<T> {
		this.cancellation.signal.throwIfAborted();
		if (this.deriving >= 2) await new Promise<void>(resolve => this.waiting.push(resolve));
		else this.deriving++;
		this.cancellation.signal.throwIfAborted();
		try { return await produce(); }
		finally {
			const next = this.waiting.shift();
			if (next) next();
			else this.deriving--;
		}
	}

	private key(kind: CacheKind<unknown>, keyed: Keyed, variant?: string): string {
		return `${kind.dir}/${idOf(keyed)}${variant ? `@${variant}` : ''}`;
	}

	/** The file of an entry: `cache/<dir>/<id>[@variant].<ext>`. */
	private pathOf(kind: CacheKind<unknown>, key: string): string {
		return `${CACHE_DIR}/${key}.${kind.ext}`;
	}

	private async load<T>(kind: CacheKind<T>, key: string, produce: () => Promise<T | null>, current: () => boolean): Promise<T | null> {
		const stored = await this.read(kind, key);
		if (!current()) return null;
		if (stored !== undefined) return stored;

		let value: T | null;
		try {
			value = await produce();
		} catch (error) {
			if (current()) console.warn(`[assets] could not derive ${key}:`, error);
			value = null;
		}
		// Keep the shared request alive until a subsequent disk read can find it.
		if (!current()) return null;
		if (value !== null) await this.write(kind, key, value);
		return current() ? value : null;
	}

	/**
	 * The entry's file, derived and written where there is none.
	 */
	private async loadFile<T>(kind: CacheKind<T>, key: string, produce: () => Promise<T | null>, current: () => boolean): Promise<File | null> {
		const path = this.pathOf(kind, key);
		const stored = await this.fileAt(path);
		if (!current()) return null;
		if (stored && stored.size > 0) return stored;

		let value: T | null;
		try {
			value = await produce();
		} catch (error) {
			if (current()) console.warn(`[assets] could not derive ${key}:`, error);
			value = null;
		}
		if (value === null || !current()) return null;

		await this.write(kind, key, value);
		if (!current()) return null;
		const file = await this.fileAt(path);
		return current() ? file : null;
	}

	/** The file at a cache path, or null when it is missing or unreadable. */
	private async fileAt(path: string): Promise<File | null> {
		try {
			if (!(await this.fs.stat(path))) return null;
			return await this.fs.file(path);
		} catch {
			return null;
		}
	}

	/** The entry on disk, or undefined when missing or unreadable. */
	private async read<T>(kind: CacheKind<T>, key: string): Promise<T | undefined> {
		const path = this.pathOf(kind, key);
		try {
			if (!(await this.fs.stat(path))) return undefined;
			return await kind.decode(await this.fs.file(path));
		} catch {
			return undefined;
		}
	}

	private async write<T>(kind: CacheKind<T>, key: string, value: T): Promise<void> {
		const writing = this.persist(kind, key, value);
		this.writes.set(key, writing);
		try { await writing; }
		finally { if (this.writes.get(key) === writing) this.writes.delete(key); }
	}

	private async persist<T>(kind: CacheKind<T>, key: string, value: T): Promise<void> {
		try {
			await this.fs.write(this.pathOf(kind, key), kind.encode(value));
		} catch (error) {
			console.warn(`[assets] could not write cache entry ${key}:`, error);
		}
	}
}
