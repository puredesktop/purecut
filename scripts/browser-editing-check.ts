import { createRuntimeWorld, Computed, getSourceFrameAt, setPlayhead, playbackSystem, motionSystem } from '../packages/runtime/src';
import { createRuntimeDocument, authoredElement } from '../packages/reconciler/src';
import { getDocumentEditor } from '../apps/web/src/engine/editor';
import { getEditHistory } from '../apps/web/src/engine/history';
import { changePlaybackRate, trimToPlayhead } from '../apps/web/src/engine/timing';
import { insertAsset, appendAsset } from '../apps/web/src/engine/insert-asset';
import type { VideoAsset } from '@diffusionstudio/assets';
import { getScrollX, getResolution } from '../apps/web/src/engine/timeline/view';
import { TIMELINE_PADDING_LEFT } from '../apps/web/src/engine/timeline/config';
import { seekToCut } from '../apps/web/src/engine/input/shortcuts';

export async function checkEverydayEditing() {
  const world = createRuntimeWorld('everyday-editing');
  const document = createRuntimeDocument(world);
  const check = (value: unknown, message: string) => { if (!value) throw Error(message); };
  try {
    document.setProperty(document.stage, '__source', 'editing-stage');
    const scene = document.createElement('Scene');
    document.setProperty(scene, '__source', 'editing-scene');
    document.setProperty(scene, 'active', true);
    document.insertNode(document.stage, scene);
    const clip = document.createElement('Rect');
    for (const [name, value] of Object.entries({ __source: 'editing-clip', start: 2, end: 8, sourceIn: 1 }))
      document.setProperty(clip, name, value);
    document.insertNode(scene, clip);
    const editor = getDocumentEditor(world);
    const history = getEditHistory(world);
    changePlaybackRate(world, clip.entity, 2);
    const fast = clip.entity.get(Computed)!;
    check(fast.start === 60 && fast.end === 150, `Speed must anchor the start and halve the duration: ${fast.start},${fast.end}`);
    check(getSourceFrameAt(clip.entity, 60) === 30 && getSourceFrameAt(clip.entity, 90) === 90,
      'Speed must retain source-in and double source progression');
    await Promise.resolve(); history.undo();
    check(clip.entity.get(Computed)?.end === 240, 'Undo must restore the original duration');
    history.redo();
    check(clip.entity.get(Computed)?.end === 150, 'Redo must restore the speed change');
    changePlaybackRate(world, clip.entity, 0.5);
    check(clip.entity.get(Computed)?.start === 60 && clip.entity.get(Computed)?.end === 420,
      'Slower playback must lengthen the same source window');
    check(getSourceFrameAt(clip.entity, 120) === 60, 'Half speed must halve source progression');
    const saved = JSON.parse(JSON.stringify(authoredElement(clip.entity)!));
    const reopenedWorld = createRuntimeWorld('speed-reopen');
    const reopenedDocument = createRuntimeDocument(reopenedWorld);
    try {
      const reopenedScene = reopenedDocument.createElement('Scene');
      reopenedDocument.insertNode(reopenedDocument.stage, reopenedScene);
      const reopenedClip = reopenedDocument.createElement('Rect');
      for (const [name, value] of Object.entries(saved.props)) reopenedDocument.setProperty(reopenedClip, name, value);
      reopenedDocument.insertNode(reopenedScene, reopenedClip);
      check(reopenedClip.entity.get(Computed)?.start === 60 && reopenedClip.entity.get(Computed)?.end === 420,
        'Serialized speed edits must reconstruct the same clip window');
      check(getSourceFrameAt(reopenedClip.entity, 120) === 60, 'Serialized speed edits must preserve the source mapping');
    } finally { reopenedDocument.dispose(); reopenedWorld.destroy(); }
    changePlaybackRate(world, clip.entity, 1);
    editor.editProperty(clip.entity, 'locked', true);
    changePlaybackRate(world, clip.entity, 2);
    check(clip.entity.get(Computed)?.end === 240, 'Speed changes must respect clip locks');
    editor.editProperty(clip.entity, 'locked', false);
    for (const rate of [0, -1, NaN, Infinity]) changePlaybackRate(world, clip.entity, rate);
    check(clip.entity.get(Computed)?.end === 240, 'Invalid speed must leave timing unchanged');
    const fade = document.createElement('Animation');
    document.setProperty(fade, 'type', 'fade');
    document.setProperty(fade, 'duration', 1);
    document.insertNode(clip, fade);
    const sample = (frame: number) => {
      setPlayhead(world, scene.entity, frame); playbackSystem(world); motionSystem(world);
      return clip.entity.get(Computed)!.opacity;
    };
    check(sample(60) === 0, 'Fade-in starts transparent at the trimmed clip edge');
    const middle = sample(75);
    check(middle > 0 && middle < 1, 'Fade-in has an intermediate opacity');
    check(sample(90) === 1, 'Fade-in restores authored opacity after its duration');
    document.setProperty(fade, 'phase', 'out');
    check(sample(209) === 1 && sample(239) === 0, 'Fade-out reaches transparent on the last visible frame');
    const trimmed = document.createElement('Rect');
    for (const [name, value] of Object.entries({ __source: 'source-trimmed', start: 2, sourceIn: 1, sourceOut: 7 }))
      document.setProperty(trimmed, name, value);
    document.insertNode(scene, trimmed);
    changePlaybackRate(world, trimmed.entity, 2);
    check(trimmed.entity.get(Computed)?.end === 150, 'Source-out-only clips must scale without an authored timeline end');
    check(authoredElement(trimmed.entity)?.props.end === undefined, 'Speed must not pin an originally implicit end');
    changePlaybackRate(world, trimmed.entity, 1);
    editor.editProperty(trimmed.entity, 'end', 20);
    changePlaybackRate(world, trimmed.entity, 2);
    check(trimmed.entity.get(Computed)?.end === 150, 'Source-out must still cap an explicit end after speed changes');
    const asset = { id: 'range-fixture', type: 'VIDEO', path: 'range.webm', source: 'range.webm',
      width: 320, height: 180, duration: 10, frameRate: 30, mimeType: 'video/webm',
      handle: { getFile: async () => new File([], 'range.webm') } } as VideoAsset;
    const inserted = insertAsset(world, asset, { parent: scene.entity, start: 3, sourceRange: { in: 2, out: 5 } });
    check(inserted, 'Range insertion should create a clip');
    check(inserted!.get(Computed)?.start === 90 && inserted!.get(Computed)?.end === 180,
      'Inserted range must last three seconds at the requested timeline position');
    check(getSourceFrameAt(inserted!, 90) === 60, 'Inserted range must begin at source in');
    check(authoredElement(inserted!)?.props.sourceOut === 5, 'Inserted range must preserve source out');
    await Promise.resolve(); history.undo();
    check(!inserted!.isAlive(), 'Range insertion must be undoable');
    history.redo();
    for (const range of [{ in: -1, out: 2 }, { in: 2, out: 2 }, { in: 0, out: 11 }, { in: NaN, out: 2 }])
      check(insertAsset(world, asset, { parent: scene.entity, sourceRange: range }) === null,
        'Invalid ranges must not create clips');
    const tail = Math.max(...scene.children.map(child => child.entity.get(Computed)?.end ?? 0));
    document.setProperty(scene, 'end', tail / 30);
    const appended = appendAsset(world, asset, { parent: scene.entity, sourceRange: { in: 2, out: 5 } });
    check(appended?.get(Computed)?.start === tail, 'Append must start after existing clips');
    check(appended?.get(Computed)?.end === tail + 90, 'Append must retain the chosen source duration');
    check(scene.entity.get(Computed)?.end === tail + 90, 'Append must extend an explicit scene end');
    check(scene.entity.get(Computed)?.localTime === tail, 'Append should seek to the new clip');
    check(Math.abs((tail - getScrollX(world, scene.entity)) * getResolution(world, scene.entity) - TIMELINE_PADDING_LEFT) < 0.01,
      'Append should reveal the new clip with timeline padding');
    history.undo();
    check(!appended!.isAlive() && scene.entity.get(Computed)?.end === tail,
      'Append and scene extension must undo together');
    setPlayhead(world, scene.entity, 0);
    seekToCut(world, 1);
    check(scene.entity.get(Computed)?.localTime === 60, 'Next cut must seek to the first clip boundary');
    seekToCut(world, -1);
    check(scene.entity.get(Computed)?.localTime === 0, 'Previous cut must return to the sequence start');
    const hidden = document.createElement('Rect');
    document.setProperty(hidden, 'start', 0.5);
    document.setProperty(hidden, 'end', 1);
    document.setProperty(hidden, 'hidden', true);
    document.insertNode(scene, hidden);
    seekToCut(world, 1);
    check(scene.entity.get(Computed)?.localTime === 60, 'Cut navigation must skip hidden clips');
    document.setProperty(scene, 'workarea', [2.5, 4]);
    setPlayhead(world, scene.entity, 0);
    seekToCut(world, 1);
    check(scene.entity.get(Computed)?.localTime === 75, 'Cut navigation must respect the work-area start');
    setPlayhead(world, scene.entity, 119);
    seekToCut(world, 1);
    check(scene.entity.get(Computed)?.localTime === 120, 'Cut navigation must stop at the work-area end');
    seekToCut(world, 1);
    check(scene.entity.get(Computed)?.localTime === 120, 'Next cut at the last boundary must stay put');
    const trimTarget = document.createElement('Rect');
    for (const [key, value] of Object.entries({ __source: 'playhead-trim', start: 2, end: 6, sourceIn: 1 }))
      document.setProperty(trimTarget, key, value);
    document.insertNode(scene, trimTarget);
    setPlayhead(world, scene.entity, 90);
    trimToPlayhead(world, trimTarget.entity, 'start');
    check(trimTarget.entity.get(Computed)?.start === 90 && trimTarget.entity.get(Computed)?.end === 180,
      'Trim start must retain the tail');
    check(getSourceFrameAt(trimTarget.entity, 90) === 60, 'Trim start must advance the source window');
    history.undo();
    check(trimTarget.entity.get(Computed)?.start === 60, 'Trim start must undo in one step');
    trimToPlayhead(world, trimTarget.entity, 'end');
    check(trimTarget.entity.get(Computed)?.end === 90, 'Trim end must stop at the playhead');
    history.undo();
    document.setProperty(trimTarget, 'locked', true);
    trimToPlayhead(world, trimTarget.entity, 'end');
    check(trimTarget.entity.get(Computed)?.end === 180, 'Trim command must respect locks');
    document.setProperty(trimTarget, 'locked', false);
    setPlayhead(world, scene.entity, 300);
    trimToPlayhead(world, trimTarget.entity, 'end');
    check(trimTarget.entity.get(Computed)?.end === 180, 'Trim command must not extend past a clip');
  } finally { document.dispose(); world.destroy(); }
}
