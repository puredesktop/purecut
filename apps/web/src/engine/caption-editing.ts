import { AssetId, Caption, Library, getAsset, resolveTranscript, serializeSubtitles } from '@diffusionstudio/runtime';
import { authoredElement } from '@diffusionstudio/reconciler';
import type { Transcript } from '@diffusionstudio/assets';
import type { Entity, World } from 'koota';
import { getDocumentEditor } from './editor';
import { containsLocked } from './locking';

export function replaceCueText(transcript: Transcript, index: number, text: string): Transcript {
  const cue = transcript[index];
  if (!cue) throw new Error('This caption cue no longer exists');
  serializeSubtitles([cue], 'vtt');
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) throw new Error('Caption text cannot be empty');
  if (tokens.join(' ') === cue.text) return transcript;
  const start = Math.min(...cue.words.map(word => word.start));
  const end = Math.max(...cue.words.map(word => word.end));
  const total = tokens.reduce((sum, token) => sum + token.length, 0);
  let consumed = 0;
  const words = tokens.map(token => {
    const wordStart = start + consumed / total * (end - start);
    consumed += token.length;
    return { text: token, start: wordStart, end: start + consumed / total * (end - start) };
  });
  return transcript.map((segment, i) => i === index ? { text: tokens.join(' '), words } : segment);
}

export async function editCaptionCue(world: World, entity: Entity, assetId: string, index: number, text: string): Promise<void> {
  const library = world.get(Library);
  const source = authoredElement(entity)?.props.src;
  const current = () => entity.isAlive() && entity.has(Caption) && !containsLocked(world, entity)
    && world.get(Library) === library && entity.get(AssetId)?.value === assetId && authoredElement(entity)?.props.src === source;
  if (!library || !current()) throw new Error('The caption changed or is locked. Reload it before editing.');
  const asset = getAsset(world, assetId);
  if (!asset) throw new Error('Caption source is unavailable');
  const transcript = await resolveTranscript(asset);
  const next = replaceCueText(transcript, index, text);
  if (JSON.stringify(next) === JSON.stringify(transcript)) return;
  if (!current()) throw new Error('The caption changed while loading');
  const revised = await library.store(new Blob([JSON.stringify(next)], { type: 'application/json' }), {
    folder: 'captions', name: `edited-${crypto.randomUUID()}.json`,
  });
  await library.flush();
  if (!current()) throw new Error('The caption changed while saving. The revision remains in the library.');
  getDocumentEditor(world).editProperty(entity, 'src', revised.path);
}
