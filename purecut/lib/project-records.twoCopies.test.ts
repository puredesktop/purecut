// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { parse, stringify } from 'yaml'

import { ProjectRecords } from './project-records'
import type { ProjectFiles } from './platform-files'

/**
 * Two live copies of PureCut over one project folder: a normal tab and a copy held inside a page. Two real ProjectRecords
 * over one fake disk, each call in one queue, as the browser's project lock has two frames of one origin take turns. Every
 * read and write takes a turn of the event loop, as the shell's do.
 *
 * The source (index.tsx) is not here because it is already safe: edits are applied to the file as it is, inside that lock,
 * and a replacement names the hash it was made from, so one made from a stale copy is refused.
 */
const DIR = '/Videos/one.cut'
function disk(extra: Record<string, unknown> = {}) {
  const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0))
  const data = new Map<string, string>([
    [`${DIR}/package.json`, JSON.stringify({ projectId: 'p1', displayName: 'One', main: 'index.tsx', ...extra })],
    [`${DIR}/index.tsx`, 'export default () => <stage />'],
    [`${DIR}/assets.yml`, stringify({ version: 1, folders: ['Shared'], assets: [asset('shared')] })],
  ])
  const fs = {
    root: async () => '/Videos',
    read: async (path: string) => { const text = data.get(path); await tick(); if (text === undefined) throw new Error(`ENOENT ${path}`); return text },
    write: async (path: string, text: string) => { await tick(); data.set(path, text) },
    list: async () => [],
    remove: async () => undefined,
    file: async () => { throw new Error('no') },
    binary: async () => undefined,
  } as unknown as ProjectFiles
  return { data, fs }
}
function asset(id: string, extra: object = {}) {
  return { id, path: `assets/${id}.mp4`, type: 'video', ...extra }
}
type Disk = ReturnType<typeof disk>
let lock: Promise<unknown> = Promise.resolve()
const inTurn = <T,>(work: () => Promise<T>): Promise<T> => {
  const next = lock.then(work, work)
  lock = next.catch(() => undefined)
  return next
}
function copyOf(d: Disk) {
  const changes: string[] = []
  return { records: new ProjectRecords(d.fs, (dir, file) => { changes.push(`${dir}/${file}`) }), changes }
}
const manifest = (d: Disk) => parse(d.data.get(`${DIR}/assets.yml`)!) as { folders: string[]; assets: Array<{ id: string; note?: string }> }
const ids = (d: Disk) => manifest(d).assets.map(a => a.id).sort()
const config = (d: Disk) => (JSON.parse(d.data.get(`${DIR}/package.json`)!) as { diffusion?: Record<string, any> }).diffusion
const readManifest = (c: ReturnType<typeof copyOf>) => inTurn(() => c.records.readManifest(DIR))
const writeManifest = (c: ReturnType<typeof copyOf>, m: unknown) => inTurn(() => c.records.writeManifest(DIR, m))
const readConfig = (c: ReturnType<typeof copyOf>) => inTurn(() => c.records.readConfig(DIR))
const writeConfig = (c: ReturnType<typeof copyOf>, value: unknown) => inTurn(() => c.records.writeConfig(DIR, value))

async function bothRead(d: Disk) {
  const a = copyOf(d), b = copyOf(d)
  return { a, b, fromA: await readManifest(a), fromB: await readManifest(b) }
}

describe('the media library, saved whole from each copy\'s memory', () => {
  it('both add an asset, neither having looked: both stay', async () => {
    const d = disk()
    const { a, b, fromA, fromB } = await bothRead(d)
    await writeManifest(a, { ...fromA, assets: [asset('from-a'), ...fromA.assets] })
    await writeManifest(b, { ...fromB, assets: [asset('from-b'), ...fromB.assets] })
    expect(ids(d)).toEqual(['from-a', 'from-b', 'shared'])
  })

  it('both add at the same moment: both stay', async () => {
    const d = disk()
    const { a, b, fromA, fromB } = await bothRead(d)
    await Promise.all([
      writeManifest(a, { ...fromA, assets: [asset('from-a'), ...fromA.assets] }),
      writeManifest(b, { ...fromB, assets: [asset('from-b'), ...fromB.assets] }),
    ])
    expect(ids(d)).toEqual(['from-a', 'from-b', 'shared'])
  })

  it('an asset one removed stays removed when the other saves from its older view', async () => {
    const d = disk()
    const { a, b, fromA, fromB } = await bothRead(d)
    await writeManifest(a, { ...fromA, assets: [] })
    await writeManifest(b, { ...fromB, assets: [asset('from-b'), ...fromB.assets] })
    expect(ids(d)).toEqual(['from-b'])
  })

  it('a folder one added stays, and one removed stays removed', async () => {
    const d = disk()
    const { a, b, fromA, fromB } = await bothRead(d)
    await writeManifest(a, { ...fromA, folders: ['Added'] })
    await writeManifest(b, { ...fromB, assets: [asset('from-b'), ...fromB.assets] })
    expect(manifest(d).folders).toEqual(['Added'])
  })

  it('tells the copy that merged, so it shows what the other added', async () => {
    const d = disk()
    const { a, b, fromA, fromB } = await bothRead(d)
    await writeManifest(a, { ...fromA, assets: [asset('from-a'), ...fromA.assets] })
    await writeManifest(b, { ...fromB, assets: [asset('from-b'), ...fromB.assets] })
    expect(b.changes).toContain(`${DIR}/assets.yml`)
  })
})

describe('the project\'s settings, saved whole from each copy\'s memory', () => {
  const start = { export: { s1: { format: 'mp4' } }, other: 1 }

  it('export settings for two scenes from two stale copies: both stay', async () => {
    const d = disk({ diffusion: start })
    const a = copyOf(d), b = copyOf(d)
    const fromA = await readConfig(a), fromB = await readConfig(b)
    await writeConfig(a, { ...fromA, export: { ...fromA.export, s2: { format: 'webm' } } })
    await writeConfig(b, { ...fromB, export: { ...fromB.export, s3: { format: 'gif' } } })
    expect(config(d)!.export).toEqual({ s1: { format: 'mp4' }, s2: { format: 'webm' }, s3: { format: 'gif' } })
  })

  it('what one removed stays removed, and a rename is not lost to a save of settings', async () => {
    const d = disk({ diffusion: start })
    const a = copyOf(d), b = copyOf(d)
    const fromA = await readConfig(a), fromB = await readConfig(b)
    await writeConfig(a, { other: 1 })
    await inTurn(() => a.records.rename(DIR, 'Renamed'))
    await writeConfig(b, { ...fromB, other: 2 })
    void fromA
    expect(config(d)).toEqual({ other: 2 })
    expect(JSON.parse(d.data.get(`${DIR}/package.json`)!).displayName).toBe('Renamed')
  })
})

describe('a copy picks up what the other did', () => {
  const look = (c: ReturnType<typeof copyOf>) => inTurn(() => (c.records as unknown as { look: (dir: string) => Promise<void> }).look(DIR))
  const saveSource = (d: Disk, text: string) => d.data.set(`${DIR}/index.tsx`, text)

  it('its first look only learns where things stand, and a look that finds nothing new is quiet', async () => {
    const d = disk()
    const a = copyOf(d)
    await look(a)
    await look(a)
    expect(a.changes).toEqual([])
  })

  it('hears of the source, the library and the settings the other saved', async () => {
    const d = disk()
    const a = copyOf(d), b = copyOf(d)
    await look(b)
    saveSource(d, 'from the other copy')
    const fromA = await readManifest(a)
    await writeManifest(a, { ...fromA, assets: [asset('from-a')] })
    await writeConfig(a, { other: 3 })
    await look(b)
    expect(b.changes.sort()).toEqual([`${DIR}/assets.yml`, `${DIR}/index.tsx`, `${DIR}/package.json`])
  })

  it('does not hear of its own saves', async () => {
    const d = disk()
    const a = copyOf(d)
    await look(a)
    await inTurn(() => (a.records as unknown as { ownSource: (dir: string, text: string) => Promise<void> }).ownSource(DIR, 'mine'))
    saveSource(d, 'mine')
    a.changes.length = 0
    const m = await readManifest(a)
    await writeManifest(a, { ...m, folders: ['Mine'] })
    await writeConfig(a, { mine: 1 })
    await look(a)
    expect(a.changes).toEqual([])
  })
})
