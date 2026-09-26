import { AssetId, Caption, Computed, FrameRate, Hidden, Workarea, getAsset, getEntityTree, getParentEntity, resolveTranscript, serializeSubtitles, type SubtitleFormat } from '@diffusionstudio/runtime';
import type { Transcript } from '@diffusionstudio/assets';
import type { Entity, World } from 'koota';
import { saveAssetAs } from './asset-actions';

/** Snapshot timeline geometry before awaiting source files. */
export async function collectSceneSubtitles(world: World, scene: Entity): Promise<Transcript> {
  const fps = world.get(FrameRate)?.value ?? 30;
  const sceneEnd = scene.get(Computed)?.end ?? 0;
  const workarea = scene.get(Workarea);
  const from = workarea ? Math.max(0, Math.min(sceneEnd, workarea.start)) : 0;
  const to = workarea ? Math.max(from, Math.min(sceneEnd, workarea.end || sceneEnd)) : sceneEnd;
  const clips = getEntityTree(world, scene).filter(entity => entity.has(Caption)).flatMap(entity => {
    const timing = entity.get(Computed);
    if (!timing) return [];
    let start = Math.max(from, timing.start), end = Math.min(to, timing.end);
    for (let parent: Entity | null = entity; parent; parent = getParentEntity(parent)) {
      if (parent.has(Hidden)) return [];
      const bounds = parent.get(Computed);
      if (bounds) { start = Math.max(start, bounds.start); end = Math.min(end, bounds.end); }
      if (parent === scene) break;
    }
    if (end <= start) return [];
    const asset = getAsset(world, entity.get(AssetId)?.value ?? '');
    if (!asset) throw new Error('A caption source is unavailable. Load it before exporting subtitles.');
    const rate = timing.playbackRate;
    if (!(rate > 0) || !Number.isFinite(rate)) throw new Error('Caption playback rate is invalid');
    return [{ asset, start, end, origin: timing.origin, rate }];
  });
  const output: Transcript = [];
  for (const clip of clips) {
    const transcript = await resolveTranscript(clip.asset);
    serializeSubtitles(transcript, 'vtt');
    for (const cue of transcript) {
      const words = cue.words.map(word => ({
        text: word.text,
        start: (Math.max(clip.start, clip.origin + word.start * fps / clip.rate) - from) / fps,
        end: (Math.min(clip.end, clip.origin + word.end * fps / clip.rate) - from) / fps,
      })).filter(word => Math.round(word.end * 1000) > Math.round(word.start * 1000));
      if (words.length) output.push({ text: words.map(word => word.text).join(' '), words });
    }
  }
  return output.sort((a, b) => a.words[0].start - b.words[0].start);
}

export async function exportSceneSubtitles(world: World, scene: Entity, format: SubtitleFormat): Promise<void> {
  const snapshot = collectSceneSubtitles(world, scene);
  // Attach rejection handling immediately while the user considers the save dialog.
  const result = snapshot.then(cues => ({ cues }), error => ({ error }));
  const name = `subtitles.${format}`;
  const mimeType = format === 'vtt' ? 'text/vtt' : 'application/x-subrip';
  await saveAssetAs({ path: name, mimeType, handle: { async getFile() {
    const value = await result;
    if ('error' in value) throw value.error;
    if (!value.cues.length) throw new Error('No visible captions in the work area');
    return new File([serializeSubtitles(value.cues, format)], name, { type: mimeType });
  } } });
}
