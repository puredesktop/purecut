// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const answer = vi.hoisted(() => ({ value: null as unknown }))
vi.mock('@purescience/platform-ui/bridge/client.mjs', () => ({ bridge: { call: vi.fn(async () => answer.value) } }))
vi.mock('@purescience/platform-ui/bridge/methods.mjs', () => ({ PLATFORM_BRIDGE_METHODS: { WORKSPACE_ADJACENT_APP: 'workspace.adjacentApp' } }))

import { HeldNoVideo, useCopyRole, type CopyRole } from './held-frame'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root, seen: CopyRole
function Probe() { seen = useCopyRole(); return null }
const held = { tabId: 'held:1', name: 'the conversation', heldInRoom: true }
const hosted = (shell: Window, top: Window) => {
  vi.spyOn(window, 'parent', 'get').mockReturnValue(shell)
  vi.spyOn(window, 'top', 'get').mockReturnValue(top)
}
const fromShell = (app: unknown) => act(async () => {
  window.dispatchEvent(new MessageEvent('message', { source: window.parent as never, data: { type: 'pure:adjacent-app', app } }))
})

beforeEach(() => { answer.value = null; root = createRoot(document.createElement('div')) })
afterEach(async () => { await act(async () => root.unmount()); vi.restoreAllMocks() })

const shell = {} as Window
it('the whole app in a tab: known once the shell answers, and neither compact nor a second copy', async () => {
  hosted(shell, shell)
  await act(async () => root.render(<Probe />))
  expect(seen).toEqual({ known: true, compact: false, second: false })
})

it('stays unknown until the shell answers, so the editor has started nothing', async () => {
  hosted(shell, shell)
  let release!: (value: unknown) => void
  const { bridge } = await import('@purescience/platform-ui/bridge/client.mjs')
  vi.mocked(bridge.call).mockReturnValueOnce(new Promise(resolve => { release = resolve }))
  await act(async () => root.render(<Probe />))
  expect(seen.known).toBe(false)
  await act(async () => release(held))
  expect(seen).toEqual({ known: true, compact: true, second: true })
})

it('held on the Personal agent\'s page: compact, and let go it is the whole app, no longer a second copy', async () => {
  hosted(shell, shell)
  answer.value = held
  await act(async () => root.render(<Probe />))
  expect(seen).toEqual({ known: true, compact: true, second: true })
  await fromShell(null)
  expect(seen).toEqual({ known: true, compact: false, second: false })
})

it('held in a room: compact, and grown to the full app it is still a second copy', async () => {
  hosted({} as Window, {} as Window)
  answer.value = held
  await act(async () => root.render(<Probe />))
  expect(seen).toEqual({ known: true, compact: true, second: true })
  await fromShell(null)
  expect(seen).toEqual({ known: true, compact: false, second: true })
})

it('beside an app in split view: the whole app', async () => {
  hosted(shell, shell)
  answer.value = { tabId: 'tab', name: 'PureMail' }
  await act(async () => root.render(<Probe />))
  expect(seen).toEqual({ known: true, compact: false, second: false })
})

it('held with no video: a quiet line, with nothing to press that would start work', async () => {
  const host = document.createElement('div')
  const view = createRoot(host)
  await act(async () => view.render(<HeldNoVideo />))
  expect(host.textContent).toContain('No video open here')
  expect(host.querySelector('button')).toBeNull()
  await act(async () => view.unmount())
})

it('has no style that can apply with compact off: every selector starts from the compact frame', () => {
  const rules = readFileSync(join(process.cwd(), 'purecut/compact-in-room.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const selectors = [...rules.matchAll(/([^{}]+)\{/g)].flatMap(m => m[1]!.split(',')).map(s => s.trim())
  expect(selectors.length).toBeGreaterThan(10)
  for (const selector of selectors) expect(selector).toMatch(/^(\[data-compact-room\]|html\[data-held-in-room\]:has\(\[data-compact-room\]\))/)
})
