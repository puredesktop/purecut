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
  Name,
  Scene,
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
  highlightSceneName,
  type Clip,
  type Range,
  type Transcript,
} from './model'
import type { Entity } from 'koota'
import type { AudioAsset, VideoAsset } from '@diffusionstudio/assets'

export type SpeechScene = ReturnType<typeof speechScene>
const finite = (v: unknown, fallback: number) =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback
/** The names of the scenes in the project, for keeping a new one distinct. */
export function sceneNames(world: SpeechScene['world']): string[] {
  return world.query(Scene).map(scene => scene.get(Name)?.value ?? '').filter(Boolean)
}
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
/** Why the open scene cannot be transcribed or edited by speech. */
export class SpeechSceneError extends Error {
  constructor(
    readonly reason: 'no-recording' | 'unsupported',
    message: string,
  ) {
    super(message)
    this.name = 'SpeechSceneError'
  }
}
export function speechScene(options: { keepOtherLayers?: boolean } = {}) {
  const session = requireEditorSession(),
    { world } = session
  const scene = getActiveEntity(world)
  if (!scene || !isScene(scene))
    throw new SpeechSceneError('no-recording', 'Open a scene with a speech clip first.')
  if (containsLocked(world, scene))
    throw new SpeechSceneError('unsupported', 'Unlock this scene before speech editing.')
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
    throw new SpeechSceneError(
      'unsupported',
      'Speech editing requires a directly authored scene without scene-level trimming or retiming.',
    )
  const children = getEntityChildren(world, scene)
  if (!children.length)
    throw new SpeechSceneError('no-recording', 'Add a video or audio clip to the scene first.')
  const fps = world.get(FrameRate)?.value ?? 30
  const quantize = (n: number) => Math.round(n * fps) / fps
  const keptLayers: Entity[] = []
  const editableChildren = children.filter(entity => {
    const layer = authoredTree(world, entity)
    if (options.keepOtherLayers && layer && !layer.children.length &&
        ['text', 'rect', 'circle', 'ellipse', 'path', 'line', 'sequence'].includes(layer.tag.toLowerCase()) &&
        !findGeometryAsset(world, entity) && !isLooped(entity)) {
      keptLayers.push(entity)
      return false
    }
    return true
  })
  const units = editableChildren.map(entity => {
    const tree = authoredTree(world, entity)
    if (
      !tree ||
      !(
        speechMediaTree(tree) ||
        (tree.tag.toLowerCase() === 'captions' && !tree.children.length)
      ) ||
      isLooped(entity)
    )
      throw new SpeechSceneError(
        'unsupported',
        'This scene has text, shapes, or other layers that transcript editing cannot safely cut. Create a separate scene containing only your video or audio recording, then open Transcript there. Existing captions are supported.',
      )
    if (
      numeric(tree.props.playbackRate, 1) !== 1 ||
      tree.props.syncTo ||
      tree.props.transition ||
      tree.props.animate
    )
      throw new SpeechSceneError(
        'unsupported',
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
      throw new SpeechSceneError('unsupported', 'Wait for the clip duration to load.')
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
  if (!media.length)
    throw new SpeechSceneError('no-recording', 'Add a video or audio clip to the scene first.')
  if (
    !asset ||
    !['VIDEO', 'AUDIO'].includes(asset.type) ||
    media.some(u => u.asset?.id !== asset.id)
  )
    throw new SpeechSceneError(
      'unsupported',
      'Speech editing currently works with one source recording per scene.',
    )
  if (media.some((u, i) => i > 0 && u.start < media[i - 1].end - 0.001))
    throw new SpeechSceneError('unsupported', 'Speech clips must not overlap.')
  const end = Math.max(...units.map(u => u.end))
  return {
    session,
    world,
    scene,
    tree,
    units,
    keptLayers,
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
/**
 * Cuts the recording in place, or, given a highlight name (even an empty one),
 * keeps only the uncut parts in a new scene beside the original and answers
 * with that scene and the name it got. The original scene is left as it is.
 */
export async function applySpeechCuts(
  snapshot: SpeechScene,
  cuts: Range[],
  highlightName?: string,
  highlightDefault?: string,
): Promise<{ scene: Entity; name: string } | undefined> {
  await flushPendingProjectEdits()
  assertCurrent(snapshot)
  const removed = frameRanges(
    cuts,
    snapshot.world.get(FrameRate)?.value ?? 30,
    snapshot.end,
  )
  if (!removed.length && highlightName === undefined)
    throw Error('Select words or a suggested cut first.')
  if (highlightName !== undefined && snapshot.keptLayers.length)
    throw Error('Create highlights in a scene with only the recording and captions.')
  const replacements = snapshot.units.flatMap(unit =>
    plannedTrees({ ...snapshot, units: [unit] }, removed).map(tree => ({ tree, anchor: unit.entity })),
  )
  const trees = replacements.map(item => item.tree)
  if (!trees.some(speechMediaTree))
    throw Error('Keep at least some of the recording.')
  if (trees.length > 2000) throw Error('Apply fewer cuts in one batch.')
  await trimCaptionTrees(snapshot, trees)
  assertCurrent(snapshot)
  const editor = getDocumentEditor(snapshot.world),
    history = getEditHistory(snapshot.world)
  stopPlayback(snapshot.world, snapshot.scene)
  let created: Entity | undefined, name = ''
  history.beginGesture()
  try {
    if (highlightName !== undefined) {
      const parent = getParentEntity(snapshot.scene)
      if (!parent) throw Error('Scene has no stage.')
      const scenes = getEntityChildren(snapshot.world, parent).filter(isScene)
      const tree = cleanTree(snapshot.tree)
      name = highlightSceneName(highlightName, highlightDefault, sceneNames(snapshot.world))
      tree.props.name = name
      // Beside the scenes already on the stage, never on top of an earlier
      // highlight: each one stays findable on the canvas.
      tree.props.x = Math.max(...scenes.map(scene => {
        const props = authoredTree(snapshot.world, scene)?.props ?? {}
        return finite(props.x, 0) + finite(props.width, 1280)
      })) + 80
      tree.children = trees
      ;[created] = editor.insertElement(parent, () => renderAuthored(tree))
      if (!created) throw Error('Could not create the highlight.')
      // Activation is deliberately outside edit history. Keep the original
      // active so undoing this insertion cannot leave the project with no scene.
    } else {
      const created: Entity[] = []
      try {
        for (const { tree, anchor } of replacements) {
          const nodes = editor.insertElement(snapshot.scene, () => renderAuthored(tree), anchor)
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
  return created ? { scene: created, name } : undefined
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
