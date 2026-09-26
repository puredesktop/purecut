import {
  authoredTree,
  renderAuthored,
  type AuthoredTree,
} from '@diffusionstudio/reconciler'
import {
  findGeometryAsset,
  Computed,
  FrameRate,
  Source,
  Stage,
  getActiveEntity,
  getEntityChildren,
  getLibrary,
  getParentEntity,
  isScene,
  setPlayhead,
  resolveTranscript,
  stopPlayback,
  togglePlayback,
} from '@diffusionstudio/runtime'
import { SOURCE_ATTR, LOOP_ATTR } from '@diffusionstudio/jsx'
import { getDocumentEditor, isLooped } from '@/engine/editor'
import { getEditHistory } from '@/engine/history'
import { containsLocked } from '@/engine/locking'
import { flushPendingProjectEdits } from '@/projects/edits'
import { requireEditorSession } from '@/dapi/session'
import {
  frameRanges,
  subtract,
  rippleTime,
  captions,
  trimCaptionCues,
  type Clip,
  type Range,
  type Transcript,
} from './model'
import type { Entity } from 'koota'
import type { AudioAsset, VideoAsset } from '@diffusionstudio/assets'

export type SpeechScene = ReturnType<typeof speechScene>
const numeric = (v: unknown, fallback: number) => {
  if (v === undefined || v === false) return fallback
  if (typeof v !== 'number' || !Number.isFinite(v))
    throw Error('Speech editing requires numeric clip timing.')
  return v
}
// Selection and viewport state do not change the media being edited.
const viewProps = new Set(['selected', 'active', 'camera', 'expanded', 'clipHeight', 'timeline', 'playhead'])
function speechFingerprint(tree: AuthoredTree | undefined): string {
  const stable = (node: AuthoredTree): AuthoredTree => ({
    ...node,
    props: Object.fromEntries(Object.entries(node.props).filter(([key]) => !viewProps.has(key))),
    children: node.children.map(stable),
  })
  return JSON.stringify(tree ? stable(tree) : null)
}
function cleanTree(tree: AuthoredTree): AuthoredTree {
  const props = Object.fromEntries(
    Object.entries(tree.props).filter(([, value]) => value !== false),
  )
  for (const k of [SOURCE_ATTR, LOOP_ATTR, 'id', 'selected', 'active'])
    delete props[k]
  return { ...tree, props, children: tree.children.map(cleanTree) }
}
function speechMediaTree(tree: AuthoredTree): boolean {
  if (['video', 'audio'].includes(tree.tag.toLowerCase()))
    return tree.children.length === 0
  // Normal media imports use a rectangle filled by one video paint. Timing
  // belongs to the rectangle; preserve that structure and its visual props.
  return (
    tree.tag.toLowerCase() === 'rect' &&
    tree.children.length === 1 &&
    tree.children[0].tag.toLowerCase() === 'videopaint' &&
    tree.children[0].children.length === 0 &&
    !tree.children[0].props.frameRate
  )
}
export function speechScene() {
  const session = requireEditorSession(),
    { world } = session
  const scene = getActiveEntity(world)
  if (!scene || !isScene(scene))
    throw Error('Open a scene with a speech clip first.')
  if (containsLocked(world, scene))
    throw Error('Unlock this scene before speech editing.')
  const tree = authoredTree(world, scene)
  if (
    !tree ||
    !getParentEntity(scene)?.has(Stage) ||
    isLooped(scene) ||
    numeric(tree.props.sourceIn, 0) !== 0 ||
    numeric(tree.props.start, 0) !== 0 ||
    numeric(tree.props.playbackRate, 1) !== 1 ||
    (tree.props.end !== undefined && tree.props.end !== false) ||
    (tree.props.sourceOut !== undefined && tree.props.sourceOut !== false)
  )
    throw Error(
      'Speech editing requires a directly authored scene without scene-level trimming or retiming.',
    )
  const children = getEntityChildren(world, scene)
  if (!children.length)
    throw Error('Add a video or audio clip to the scene first.')
  const fps = world.get(FrameRate)?.value ?? 30
  const quantize = (n: number) => Math.round(n * fps) / fps
  const units = children.map(entity => {
    const tree = authoredTree(world, entity)
    if (
      !tree ||
      !(
        speechMediaTree(tree) ||
        (tree.tag.toLowerCase() === 'captions' && !tree.children.length)
      ) ||
      isLooped(entity)
    )
      throw Error(
        'Speech editing currently supports a single speech track and captions. Use a separate scene for layered compositions.',
      )
    if (
      numeric(tree.props.playbackRate, 1) !== 1 ||
      tree.props.syncTo ||
      tree.props.transition ||
      tree.props.animate
    )
      throw Error(
        'Remove retiming, animation or transitions before speech editing.',
      )
    const asset = findGeometryAsset(world, entity)
    const sourceIn = quantize(numeric(tree.props.sourceIn, 0)),
      start = quantize(numeric(tree.props.start, 0))
    const duration = asset && 'duration' in asset ? asset.duration : 0
    const end = quantize(
      numeric(
        tree.props.end,
        start + numeric(tree.props.sourceOut, duration) - sourceIn,
      ),
    )
    if (!(start >= 0 && sourceIn >= 0 && end > start && Number.isFinite(end)))
      throw Error('Wait for the clip duration to load.')
    return {
      entity,
      tree,
      asset,
      start,
      end,
      sourceIn,
      source: entity.get(Source)!.value,
    }
  })
  const media = units
    .filter(u => u.tree.tag.toLowerCase() !== 'captions')
    .sort((a, b) => a.start - b.start)
  const asset = media[0]?.asset
  if (
    !asset ||
    !['VIDEO', 'AUDIO'].includes(asset.type) ||
    media.some(u => u.asset?.id !== asset.id)
  )
    throw Error(
      'Speech editing currently works with one source recording per scene.',
    )
  if (media.some((u, i) => i > 0 && u.start < media[i - 1].end - 0.001))
    throw Error('Speech clips must not overlap.')
  const end = Math.max(...units.map(u => u.end))
  return {
    session,
    world,
    scene,
    tree,
    units,
    media,
    asset: asset as AudioAsset | VideoAsset,
    end,
    fingerprint: speechFingerprint(tree),
  }
}
export function assertCurrent(snapshot: SpeechScene) {
  if (
    requireEditorSession() !== snapshot.session ||
    getActiveEntity(snapshot.world) !== snapshot.scene ||
    !snapshot.scene.isAlive() ||
    speechFingerprint(authoredTree(snapshot.world, snapshot.scene)) !==
      snapshot.fingerprint ||
    containsLocked(snapshot.world, snapshot.scene)
  )
    throw Error('The scene changed. Review the speech edit again.')
}
export function clips(snapshot: SpeechScene): Clip[] {
  return snapshot.media.map(({ start, end, sourceIn, source }) => ({
    start,
    end,
    sourceIn,
    source,
  }))
}
export function plannedTrees(
  snapshot: SpeechScene,
  cuts: Range[],
): AuthoredTree[] {
  const removed = frameRanges(
    cuts,
    snapshot.world.get(FrameRate)?.value ?? 30,
    snapshot.end,
  )
  return snapshot.units.flatMap(unit =>
    subtract(unit, removed).map(span => {
      const tree = cleanTree(unit.tree)
      tree.props = {
        ...tree.props,
        start: rippleTime(span.start, removed),
        end: rippleTime(span.end, removed),
        sourceIn: unit.sourceIn + span.start - unit.start,
      }
      delete tree.props.sourceOut
      return tree
    }),
  )
}
async function captionAsset(
  snapshot: SpeechScene,
  cues: Parameters<typeof trimCaptionCues>[0],
  start: number,
  end: number,
) {
  const library = getLibrary(snapshot.world)
  const asset = await library.store(
    new Blob([JSON.stringify(trimCaptionCues(cues, start, end))], {
      type: 'application/json',
    }),
    {
      folder: 'captions',
      name: `speech-${crypto.randomUUID()}.json`,
    },
  )
  await library.flush()
  assertCurrent(snapshot)
  return asset.path
}
async function trimCaptionTrees(snapshot: SpeechScene, trees: AuthoredTree[]) {
  const library = getLibrary(snapshot.world)
  for (const tree of trees) {
    if (tree.tag.toLowerCase() !== 'captions') continue
    const asset = library.get(String(tree.props.src))
    if (!asset) throw Error('Caption source is unavailable.')
    const cues = await resolveTranscript(asset)
    assertCurrent(snapshot)
    const start = numeric(tree.props.sourceIn, 0)
    const end =
      start + numeric(tree.props.end, 0) - numeric(tree.props.start, 0)
    tree.props.src = await captionAsset(snapshot, cues, start, end)
  }
}
export async function applySpeechCuts(
  snapshot: SpeechScene,
  cuts: Range[],
  highlightName?: string,
) {
  await flushPendingProjectEdits()
  assertCurrent(snapshot)
  const removed = frameRanges(
    cuts,
    snapshot.world.get(FrameRate)?.value ?? 30,
    snapshot.end,
  )
  if (!removed.length && highlightName === undefined)
    throw Error('Select words or a suggested cut first.')
  const trees = plannedTrees(snapshot, removed)
  if (!trees.some(speechMediaTree))
    throw Error('Keep at least some of the recording.')
  if (trees.length > 2000) throw Error('Apply fewer cuts in one batch.')
  await trimCaptionTrees(snapshot, trees)
  assertCurrent(snapshot)
  const editor = getDocumentEditor(snapshot.world),
    history = getEditHistory(snapshot.world)
  stopPlayback(snapshot.world, snapshot.scene)
  history.beginGesture()
  try {
    if (highlightName !== undefined) {
      const parent = getParentEntity(snapshot.scene)
      if (!parent) throw Error('Scene has no stage.')
      const tree = cleanTree(snapshot.tree)
      tree.props.name = highlightName.trim().slice(0, 100) || 'Highlight'
      tree.props.x =
        numeric(tree.props.x, 0) + numeric(tree.props.width, 1280) + 80
      tree.children = trees
      const [next] = editor.insertElement(parent, () => renderAuthored(tree))
      if (!next) throw Error('Could not create the highlight.')
      // Activation is deliberately outside edit history. Keep the original
      // active so undoing this insertion cannot leave the project with no scene.
    } else {
      const created: Entity[] = []
      try {
        for (const tree of trees) {
          const nodes = editor.insertElement(snapshot.scene, () =>
            renderAuthored(tree),
          )
          if (!nodes.length) throw Error('Could not insert the edited clip.')
          created.push(...nodes)
        }
      } catch (error) {
        editor.remove(created)
        throw error
      }
      editor.remove(snapshot.units.map(u => u.entity))
      setPlayhead(snapshot.world, snapshot.scene, 0)
    }
  } finally {
    history.endGesture()
  }
  await flushPendingProjectEdits()
}
export async function addSpeechCaptions(
  snapshot: SpeechScene,
  transcript: Transcript,
) {
  await flushPendingProjectEdits()
  assertCurrent(snapshot)
  const paths = await Promise.all(
    snapshot.media.map(clip =>
      captionAsset(
        snapshot,
        captions(transcript.words),
        clip.sourceIn,
        clip.sourceIn + clip.end - clip.start,
      ),
    ),
  )
  assertCurrent(snapshot)
  const editor = getDocumentEditor(snapshot.world),
    history = getEditHistory(snapshot.world)
  history.beginGesture()
  try {
    const created: Entity[] = []
    try {
      for (const [index, clip] of snapshot.media.entries()) {
        const nodes = editor.insertElement(snapshot.scene, () =>
          renderAuthored({
            tag: 'captions',
            props: {
              src: paths[index],
              start: clip.start,
              end: clip.end,
              sourceIn: clip.sourceIn,
              name: 'Speech captions',
            },
            children: [],
          }),
        )
        if (!nodes.length) throw Error('Could not insert captions.')
        created.push(...nodes)
      }
    } catch (error) {
      editor.remove(created)
      throw error
    }
    editor.remove(
      snapshot.units
        .filter(u => u.tree.tag.toLowerCase() === 'captions')
        .map(u => u.entity),
    )
  } finally {
    history.endGesture()
  }
  await flushPendingProjectEdits()
}
export function previewCuts(
  snapshot: SpeechScene,
  cuts: Range[],
  complete: () => void,
): () => void {
  assertCurrent(snapshot)
  const kept = subtract(
    { start: 0, end: snapshot.end },
    frameRanges(cuts, snapshot.world.get(FrameRate)?.value ?? 30, snapshot.end),
  )
  if (!kept.length) throw Error('Nothing would remain after these cuts.')
  const fps = snapshot.world.get(FrameRate)?.value ?? 30
  let index = 0,
    stopped = false
  const stop = () => {
    if (stopped) return
    stopped = true
    clearInterval(timer)
    if (snapshot.scene.isAlive()) stopPlayback(snapshot.world, snapshot.scene)
    complete()
  }
  const timer = setInterval(() => {
    try {
      assertCurrent(snapshot)
    } catch {
      stop()
      return
    }
    const t = (snapshot.scene.get(Computed)?.localTime ?? 0) / fps
    if (t >= kept[index].end - 1 / fps) {
      index++
      if (index === kept.length) {
        stop()
        return
      }
      setPlayhead(snapshot.world, snapshot.scene, kept[index].start * fps)
    }
  }, 16)
  stopPlayback(snapshot.world, snapshot.scene)
  setPlayhead(snapshot.world, snapshot.scene, kept[0].start * fps)
  togglePlayback(snapshot.world, snapshot.scene)
  return stop
}
