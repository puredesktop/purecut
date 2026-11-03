import { expect, it } from 'vitest'
import { mergeConfig, mergeManifest } from './record-merge'

const a = (id: string, note = '') => ({ id, note })

it('a change to an asset by either stays, and mine wins the same one', () => {
  const base = { assets: [a('one'), a('two')] }
  const merged = mergeManifest(base, { assets: [a('one', 'mine'), a('two')] }, { assets: [a('one', 'theirs'), a('two', 'theirs')] })
  expect(merged.assets).toEqual([a('one', 'mine'), a('two', 'theirs')])
})

it('lists what they added first, the library showing the newest first', () => {
  const base = { assets: [a('one')] }
  expect(mergeManifest(base, { assets: [a('mine'), a('one')] }, { assets: [a('theirs'), a('one')] }).assets?.map(x => x.id)).toEqual(['theirs', 'mine', 'one'])
})

it('settings merge key by key and exports scene by scene; empty comes to nothing', () => {
  const base = { export: { s1: 1 }, other: 1 }
  expect(mergeConfig(base, { export: { s1: 1, s2: 2 }, other: 1 }, { export: { s1: 1, s3: 3 }, other: 5 })).toEqual({ export: { s1: 1, s2: 2, s3: 3 }, other: 5 })
  expect(mergeConfig(base, { other: 1 }, { export: { s1: 1 }, other: 1 })).toEqual({ other: 1 })
  expect(mergeConfig({ a: 1 }, null, { a: 1 })).toBeNull()
})
