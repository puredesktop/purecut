import { Keys } from '@/engine/traits'
import { render } from 'solid-js/web'
import { ColorModeProvider } from '@kobalte/core'
import { AssetLibrary, type ProjectFS } from '@diffusionstudio/assets'
import {
  Library,
  getEntityChildren,
  Scene,
  resolveTranscript,
} from '@diffusionstudio/runtime'
import { mount, authoredTree } from '@diffusionstudio/reconciler'
import { EngineProvider, useEngineContext } from '@/engine'
import { getDocumentEditor } from '@/engine/editor'
import { getEditHistory } from '@/engine/history'
import { createEditWriter, flushPendingProjectEdits } from '@/projects/edits'
import { setEditorSession } from '@/dapi/session'
import { SpeechPanel } from '../purecut/speech/panel'
import {
  speechScene,
  assertCurrent,
  applySpeechCuts,
  addSpeechCaptions,
} from '../purecut/speech/editor'
import {
  speechOpen,
  setSpeechOpen,
  speechReview,
  applySpeechReview,
  setSpeechReview,
} from '../purecut/speech/review'
import { loadTranscript } from '../purecut/speech/store'
import { bridge } from '@purescience/platform-ui/bridge/client.mjs'
import { files } from '../purecut/lib/platform-files'
import { initializeTransport, request } from '../purecut/transport'
import { mainBridge } from '@/lib/ipc'
import { rememberProjectBundle } from '@/lib/db'
import { renderScene } from '@/context/render'
import '../apps/web/src/index.css'
import '../purecut/styles.css'

export async function speechFixture(host: HTMLElement) {
  const text = new Map<string, string>(),
    binary = new Map<string, File>()
  let manifest: any = null
  let configured = false,
    started = 0,
    cancelled = 0
  const originalCall = bridge.call
  bridge.call = async (method: string, args: any[] = []) => {
    if (method === 'settings.app.get') return {} as any
    if (method === 'diarization.status')
      return {
        providers: [
          {
            id: 'assemblyai',
            label: 'AssemblyAI',
            input: 'audio',
            kind: 'cloud',
            available: configured,
          },
        ],
        selected: 'assemblyai',
      } as any
    if (method === 'diarization.start') {
      if (!args[0].consent.cloudUpload || !args[0].disfluencies)
        throw Error('Missing consent or filler retention')
      started++
      return { jobId: 'fixture' } as any
    }
    if (method === 'diarization.job')
      return {
        state: 'done',
        result: {
          status: 'completed',
          words: [
            { text: 'Hello', startMs: 0, endMs: 500, speaker: 'SPEAKER_00' },
            { text: 'um', startMs: 1000, endMs: 1500, speaker: 'SPEAKER_00' },
            {
              text: 'world.',
              startMs: 2000,
              endMs: 2500,
              speaker: 'SPEAKER_00',
            },
            { text: 'Next', startMs: 4000, endMs: 4500, speaker: 'SPEAKER_01' },
          ],
        },
      } as any
    if (method === 'diarization.cancel') {
      cancelled++
      return undefined as any
    }
    return originalCall(method, args)
  }
  files.root = async () => '/speech-fixture'
  files.read = async p => {
    if (!text.has(p)) throw Error('Missing file')
    return text.get(p)!
  }
  files.write = async (p, s) => {
    text.set(p, s)
  }
  files.list = async dir =>
    [...text.keys()]
      .filter(p => p.startsWith(dir + '/'))
      .map(p => ({
        name: p.slice(dir.length + 1),
        path: p,
        isDirectory: false,
      })) as any
  const fs: ProjectFS = {
    readManifest: async () => manifest,
    writeManifest: async m => {
      manifest = m
    },
    list: async () => [],
    stat: async p => {
      const f = binary.get(p)
      return f ? { size: f.size, mtime: f.lastModified } : null
    },
    file: async p => {
      const f = binary.get(p)
      if (!f) throw Error('Missing media')
      return f
    },
    write: async (p, b) => {
      binary.set(p, new File([b], p))
    },
    remove: async p => {
      binary.delete(p)
    },
  }
  const library = new AssetLibrary(fs)
  const recording = await (await fetch('/speech-media.mp4')).blob()
  const asset = await library.store(recording, { name: 'speech.mp4' })
  await initializeTransport()
  mainBridge.call = ((channel, data) =>
    request(channel, data)) as typeof mainBridge.call
  const project = await request('projects:create', {
    displayName: 'Speech verification',
  })
  text.set(
    project.dir + '/index.tsx',
    `export default function Project(){return <stage><scene active name="Speech" width={320} height={180}><rect end={6} width={320} height={180}><videoPaint src="${asset.path}"/></rect></scene></stage>}`,
  )
  let engine!: ReturnType<typeof useEngineContext>
  const Content = () => {
    engine = useEngineContext()
    return <SpeechPanel />
  }
  const dispose = render(
    () => (
      <ColorModeProvider initialColorMode="light">
        <EngineProvider projectId="speech-fixture">
          <Content />
        </EngineProvider>
      </ColorModeProvider>
    ),
    host,
  )
  // Attach actual canvas keyboard listeners: transcript keys must never reach
  // timeline deletion, even when a video clip is selected.
  const canvas = document.createElement('canvas')
  canvas.style.cssText = 'position:absolute;pointer-events:none;visibility:hidden;width:1px;height:1px;left:-10px'
  host.append(canvas)
  engine.mount(canvas)
  const world = engine.world
  world.set(Library, library)
  let mounted = mount(
    (await request('projects:compile', { dir: project.dir })).code,
    world,
  )
  const editor = getDocumentEditor(world),
    history = getEditHistory(world)
  let writer = createEditWriter(project.dir, world),
    off = editor.onEdit(e => writer.push(e))
  setEditorSession({ world, engine, project: { dir: () => project.dir } })
  setSpeechOpen(true)
  return {
    configure() {
      configured = true
    },
    state() {
      let scene
      try {
        scene = speechScene()
      } catch {}
      return {
        started,
        timelineKeys: [...(world.get(Keys)?.pressed ?? [])],
        cancelled,
        open: speechOpen(),
        proposal: !!speechReview(),
        canUndo: history.canUndo(),
        units: scene?.units.map(u => ({
          tag: u.tree.tag,
          start: u.start,
          end: u.end,
          sourceIn: u.sourceIn,
        })),
        source: text.get(project.dir + '/index.tsx'),
      }
    },
    async undo() {
      history.undo()
      await flushPendingProjectEdits()
    },
    async redo() {
      history.redo()
      await flushPendingProjectEdits()
    },
    async stale() {
      const s = speechScene()
      editor.editProperty(s.media[0].entity, 'volume', -3)
      await flushPendingProjectEdits()
    },
    async locked() {
      const s = speechScene()
      editor.editProperty(s.media[0].entity, 'locked', true)
      await flushPendingProjectEdits()
    },
    async coreChecks() {
      const scene = speechScene()
      const stable = (value: unknown) =>
        JSON.stringify(value, (_key, v) => (v === false ? undefined : v))
      const selectionSnapshot = speechScene()
      editor.editProperty(scene.media[0].entity, 'selected', true)
      await flushPendingProjectEdits()
      assertCurrent(selectionSnapshot)
      editor.editProperty(scene.media[0].entity, 'selected', false)
      await flushPendingProjectEdits()
      assertCurrent(selectionSnapshot)
      const before = stable(authoredTree(world, scene.scene))
      const stale = speechScene()
      editor.editProperty(scene.media[0].entity, 'volume', -6)
      await flushPendingProjectEdits()
      let rejected = false
      try {
        await applySpeechCuts(stale, [{ start: 1, end: 1.5 }])
      } catch {
        rejected = true
      }
      if (!rejected) throw Error('Stale cut applied')
      history.undo()
      await flushPendingProjectEdits()
      if (stable(authoredTree(world, speechScene().scene)) !== before)
        throw Error('Stale test undo changed the scene')
      const transcript = await loadTranscript(speechScene())
      if (!transcript) throw Error('Transcript missing')
      await addSpeechCaptions(speechScene(), transcript)
      await applySpeechCuts(speechScene(), [{ start: 1, end: 1.5 }])
      let current = speechScene()
      if (
        current.media.length !== 2 ||
        current.media[1].start !== 1 ||
        current.media[1].sourceIn !== 1.5
      )
        throw Error('Ripple mapping is wrong')
      const captions = current.units.filter(
        u => u.tree.tag.toLowerCase() === 'captions',
      )
      if (
        captions.length !== 2 ||
        captions[1].start !== 1 ||
        captions[1].sourceIn !== 1.5
      )
        throw Error('Caption mapping diverged')
      const survivingCues = (
        await Promise.all(captions.map(c => resolveTranscript(c.asset!)))
      ).flat()
      if (
        survivingCues.some(
          c => c.words.some(w => w.text === 'um') || /\bum\b/.test(c.text),
        )
      )
        throw Error('Deleted words remained in caption text')
      history.undo()
      await flushPendingProjectEdits()
      if (speechScene().media.length !== 1)
        throw Error('Cut did not undo as one step')
      history.redo()
      await flushPendingProjectEdits()
      if (speechScene().media.length !== 2) throw Error('Cut did not redo')
      const code = (await request('projects:compile', { dir: project.dir }))
        .code
      off()
      writer.dispose()
      mounted.dispose()
      mounted = mount(code, world)
      history.reset()
      writer = createEditWriter(project.dir, world)
      off = editor.onEdit(e => writer.push(e))
      current = speechScene()
      if (current.media.length !== 2 || !(await loadTranscript(current)))
        throw Error('Reopen lost cuts or transcript')
      await rememberProjectBundle('speech-fixture', code)
      return {
        children: getEntityChildren(world, current.scene).length,
        duration: current.end,
      }
    },
    async agentSpeechChecks() {
      const { cutTool } = await import('../purecut/drawer')
      for (const mode of ['fillers', 'pauses']) {
        const context = await cutTool('getCutTranscript') as any
        const before = text.get(project.dir + '/index.tsx')
        const originalScene = speechScene().fingerprint
        const result = await cutTool('proposeCutSpeechCleanup', {
          baseHash: context.baseHash, mode, minimumSeconds: 0.5, retainSeconds: 0.1,
        }) as any
        if (result.status !== 'awaiting_review' || !result.cuts.length) throw Error('Cleanup proposal missing')
        if (text.get(project.dir + '/index.tsx') !== before) throw Error('Cleanup wrote before review')
        const proposal = speechReview()!
        const oldEnd = speechScene().end
        await applySpeechReview(proposal)
        if (speechScene().end >= oldEnd) throw Error('Reviewed cleanup did not shorten recording')
        history.undo()
        await flushPendingProjectEdits()
        setSpeechReview(null)
        if (speechScene().fingerprint !== originalScene) throw Error('Cleanup undo did not restore scene')
      }
      for (const name of ['proposeCutSpeechCleanup', 'proposeCutCaptions']) {
        let rejected = false
        try { await cutTool(name, { baseHash: 'outdated', mode: 'fillers' }) } catch { rejected = true }
        if (!rejected) throw Error('Agent speech tool accepted stale revision')
      }
      const context = await cutTool('getCutTranscript') as any
      const before = text.get(project.dir + '/index.tsx')
      let invalid = false
      try { await cutTool('proposeCutSpeechCleanup', {baseHash: context.baseHash, mode: 'pauses', minimumSeconds: 1, retainSeconds: 2}) } catch { invalid = true }
      if (!invalid) throw Error('Invalid pause options accepted')
      const result = await cutTool('proposeCutCaptions', {baseHash: context.baseHash}) as any
      if (result.status !== 'awaiting_review' || !speechReview()?.captions) throw Error('Caption proposal missing')
      if (text.get(project.dir + '/index.tsx') !== before) throw Error('Captions wrote before review')
    },
    async highlightChecks() {
      const { speechTool } = await import('../purecut/speech/tools')
      const context = (await speechTool('getCutTranscript', {})) as any
      if (context.words.some((w: any) => w.text === 'um'))
        throw Error('Drawer transcript includes removed speech')
      const original = speechScene().scene
      const before = text.get(project.dir + '/index.tsx')
      await speechTool('proposeCutSpeechEdit', {
        baseHash: context.baseHash,
        mode: 'highlight',
        title: 'Short extract',
        ranges: [{ start: 3, end: 4.5 }],
      })
      if (text.get(project.dir + '/index.tsx') !== before)
        throw Error('Proposal wrote before review')
      const proposal = speechReview()!
      await applySpeechCuts(
        proposal.snapshot,
        proposal.cuts,
        proposal.highlightName,
      )
      const highlight = world.query(Scene).find(scene => scene !== original)
      const highlightEnd =
        highlight &&
        Math.max(
          ...authoredTree(world, highlight)!.children.map(child =>
            Number(child.props.end),
          ),
        )
      if (
        world.query(Scene).length !== 2 ||
        highlightEnd !== 1.5 ||
        speechScene().scene !== original
      )
        throw Error('Highlight did not create a separate trimmed scene')
      if (getEntityChildren(world, original).length !== 4)
        throw Error('Highlight changed original scene')
      history.undo()
      await flushPendingProjectEdits()
      if (speechScene().scene !== original)
        throw Error('Highlight undo lost the active scene')
      if (world.query(Scene).length !== 1) throw Error('Highlight did not undo')
      const staleContext = (await speechTool('getCutTranscript', {})) as any
      editor.editProperty(speechScene().media[0].entity, 'volume', -5)
      await flushPendingProjectEdits()
      let rejected = false
      try {
        await speechTool('proposeCutSpeechEdit', {
          baseHash: staleContext.baseHash,
          mode: 'delete',
          ranges: [{ start: 0, end: 1 }],
        })
      } catch {
        rejected = true
      }
      if (!rejected) throw Error('Stale drawer request applied')
      history.undo()
      await flushPendingProjectEdits()
    },
    async exportAudio() {
      const s = speechScene()
      const chunks: { position: number; data: Uint8Array }[] = []
      const result = await renderScene(
        engine,
        {
          scene: s.scene,
          target: {
            createWritable: async () =>
              new WritableStream({
                write(c: { position: number; data: Uint8Array }) {
                  chunks.push({ position: c.position, data: c.data.slice() })
                },
              }),
          },
          format: 'webm',
          video: { codec: 'vp8', resolution: 180, fps: 30, bitrate: 500000 },
          audio: { enabled: true, bitrate: 128000 },
        },
        () => {},
      )
      const bytes = new Uint8Array(
        Math.max(...chunks.map(c => c.position + c.data.length)),
      )
      for (const c of chunks) bytes.set(c.data, c.position)
      return {
        result,
        base64: btoa(Array.from(bytes, b => String.fromCharCode(b)).join('')),
      }
    },
    async dispose() {
      setSpeechOpen(false)
      setEditorSession(null)
      off()
      writer.dispose()
      mounted.dispose()
      dispose()
      await library.dispose()
      bridge.call = originalCall
    },
  }
}
