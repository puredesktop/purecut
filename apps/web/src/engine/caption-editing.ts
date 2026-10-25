import {
  AssetId, Caption, Computed, FrameRate, Library, getActiveEntity, getAsset, resolveTranscript, serializeSubtitles,
  setPlayhead, stopPlayback, store,
} from '@diffusionstudio/runtime';
import { authoredElement } from '@diffusionstudio/reconciler';
import type { CaptionPreset } from '@diffusionstudio/jsx';
import type { Transcript } from '@diffusionstudio/assets';
import type { Entity, World } from 'koota';
import { getDocumentEditor, isLooped } from './editor';
import { getEditHistory } from './history';
import { containsLocked } from './locking';

type Cue = Transcript[number];

/**
 * Two lines of 42 characters: the longest cue most subtitle guides (and the
 * platforms that publish them) let a viewer read in one glance.
 */
export const LONG_CUE_CHARACTERS = 84;
/** Past this long on screen, a cue usually holds more than one thought. */
export const LONG_CUE_SECONDS = 7;

export type LongCueReason = 'characters' | 'seconds';

export interface LongCue {
  index: number;
  /** Source-transcript seconds, the same clock the cue's words use. */
  start: number;
  end: number;
  characters: number;
  seconds: number;
  reasons: LongCueReason[];
}

/** Where a cue starts and ends: its first word's start and last word's end. */
export function cueBounds(cue: Cue): { start: number; end: number } {
  return {
    start: Math.min(...cue.words.map(word => word.start)),
    end: Math.max(...cue.words.map(word => word.end)),
  };
}

/**
 * The cues a viewer will struggle to read in time: more text than two lines
 * hold, or on screen long enough to hold more than one thought. A cue with no
 * words has no time to be read in and is left to the subtitle export to refuse.
 */
export function findLongCues(
  transcript: Transcript,
  limits: { characters?: number; seconds?: number } = {},
): LongCue[] {
  const maxCharacters = limits.characters ?? LONG_CUE_CHARACTERS;
  const maxSeconds = limits.seconds ?? LONG_CUE_SECONDS;
  const long: LongCue[] = [];
  transcript.forEach((cue, index) => {
    if (!cue.words.length) return;
    const { start, end } = cueBounds(cue);
    const characters = cue.text.trim().length;
    const seconds = end - start;
    const reasons: LongCueReason[] = [];
    if (characters > maxCharacters) reasons.push('characters');
    if (seconds > maxSeconds) reasons.push('seconds');
    if (reasons.length) long.push({ index, start, end, characters, seconds, reasons });
  });
  return long;
}

/** What makes a long cue long, in words for the person shortening it. */
export function describeLongCue(cue: LongCue): string {
  const parts: string[] = [];
  if (cue.reasons.includes('characters')) parts.push(`${cue.characters} characters, more than two lines`);
  if (cue.reasons.includes('seconds')) parts.push(`${cue.seconds.toFixed(1)} seconds on screen`);
  return parts.join(' · ');
}

const BREAKS = ['.', '!', '?', ';', ':', ','];

/**
 * The word a cue splits before: the boundary nearest the middle of its text,
 * preferring one just after a punctuation mark when such a boundary is not
 * much further from the middle. Always leaves at least one word on each side.
 */
export function splitPoint(cue: Cue): number {
  const words = cue.words;
  if (words.length < 2) throw new Error('A caption of one word cannot be split');
  const total = words.reduce((sum, word) => sum + word.text.length + 1, -1);
  let best = 1;
  let bestScore = Infinity;
  let before = 0;
  for (let i = 1; i < words.length; i++) {
    before += words[i - 1]!.text.length + (i > 1 ? 1 : 0);
    const distance = Math.abs(before - total / 2) / total;
    const score = BREAKS.some(mark => words[i - 1]!.text.endsWith(mark)) ? distance - 0.2 : distance;
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

/**
 * Splits one cue into two at a word boundary (`splitPoint` unless given).
 * The words are the same words with the same times: nothing is retimed or
 * reworded, so the captions play exactly as before, only in two cues.
 */
export function splitCue(transcript: Transcript, index: number, at?: number): Transcript {
  const cue = transcript[index];
  if (!cue) throw new Error('This caption cue no longer exists');
  const point = at ?? splitPoint(cue);
  if (!Number.isInteger(point) || point < 1 || point >= cue.words.length)
    throw new Error('A caption splits between two of its words');
  const half = (words: Cue['words']): Cue => ({
    text: words.map(word => word.text).join(' '),
    words: words.map(word => ({ ...word })),
  });
  const first = half(cue.words.slice(0, point));
  const second = half(cue.words.slice(point));
  return [...transcript.slice(0, index), first, second, ...transcript.slice(index + 1)];
}

export function replaceCueText(transcript: Transcript, index: number, text: string): Transcript {
  const cue = transcript[index];
  if (!cue) throw new Error('This caption cue no longer exists');
  serializeSubtitles([cue], 'vtt');
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) throw new Error('Caption text cannot be empty');
  if (tokens.join(' ') === cue.text) return transcript;
  const { start, end } = cueBounds(cue);
  const total = tokens.reduce((sum, token) => sum + token.length, 0);
  let consumed = 0;
  const words = tokens.map(token => {
    const wordStart = start + consumed / total * (end - start);
    consumed += token.length;
    return { text: token, start: wordStart, end: start + consumed / total * (end - start) };
  });
  return transcript.map((segment, i) => i === index ? { text: tokens.join(' '), words } : segment);
}

/**
 * Stores a revision of a caption's transcript as a new library file and
 * points the caption at it: one `src` edit, so one undo step, and the file it
 * replaced stays untouched for that undo to return to. Refuses when the
 * caption changed, was locked or lost its library while the revision was
 * being made.
 */
export async function reviseCaptionTranscript(
  world: World, entity: Entity, assetId: string, revise: (transcript: Transcript) => Transcript,
): Promise<void> {
  const library = world.get(Library);
  const source = authoredElement(entity)?.props.src;
  const current = () => entity.isAlive() && entity.has(Caption) && !containsLocked(world, entity)
    && world.get(Library) === library && entity.get(AssetId)?.value === assetId && authoredElement(entity)?.props.src === source;
  if (!library || !current()) throw new Error('The caption changed or is locked. Reload it before editing.');
  const asset = getAsset(world, assetId);
  if (!asset) throw new Error('Caption source is unavailable');
  const transcript = await resolveTranscript(asset);
  const next = revise(transcript);
  if (JSON.stringify(next) === JSON.stringify(transcript)) return;
  if (!current()) throw new Error('The caption changed while loading');
  const revised = await library.store(new Blob([JSON.stringify(next)], { type: 'application/json' }), {
    folder: 'captions', name: `edited-${crypto.randomUUID()}.json`,
  });
  await library.flush();
  if (!current()) throw new Error('The caption changed while saving. The revision remains in the library.');
  getDocumentEditor(world).editProperty(entity, 'src', revised.path);
}

export function editCaptionCue(world: World, entity: Entity, assetId: string, index: number, text: string): Promise<void> {
  return reviseCaptionTranscript(world, entity, assetId, transcript => replaceCueText(transcript, index, text));
}

export function splitCaptionCue(world: World, entity: Entity, assetId: string, index: number): Promise<void> {
  return reviseCaptionTranscript(world, entity, assetId, transcript => splitCue(transcript, index));
}

/**
 * The scene frame a moment of a caption's transcript plays on, inverting the
 * playback system's `localTime = (sceneFrame - origin) * playbackRate`.
 * `onTimeline` is false when that moment is trimmed off the clip; the frame
 * is then the nearest one the clip still shows.
 */
export function cueSceneFrame(
  timing: { origin: number; playbackRate: number; start: number; end: number; fps: number },
  seconds: number,
): { frame: number; onTimeline: boolean } {
  const rate = timing.playbackRate || 1;
  const frame = Math.round(timing.origin + seconds * timing.fps / rate);
  const last = Math.max(timing.start, timing.end - 1);
  const clamped = Math.min(last, Math.max(timing.start, frame));
  return { frame: clamped, onTimeline: clamped === frame };
}

/**
 * Parks the active scene's playhead on a cue so the person sees it where it
 * plays: a moment into its first word, where every preset already shows it.
 * Returns whether the cue is on the timeline at all.
 */
export function seekToCue(world: World, entity: Entity, cue: Cue): boolean {
  const scene = getActiveEntity(world);
  if (!scene || !cue.words.length) return false;
  const computed = store(world, Computed);
  const id = entity.id();
  const { start, end } = cueBounds(cue);
  const { frame, onTimeline } = cueSceneFrame({
    origin: computed.origin[id] ?? 0,
    playbackRate: computed.playbackRate[id] || 1,
    start: computed.start[id] ?? 0,
    end: computed.end[id] ?? 0,
    fps: world.get(FrameRate)?.value ?? 30,
  }, start + Math.min(0.1, (end - start) / 2));
  stopPlayback(world, scene);
  setPlayhead(world, scene, frame);
  return onTimeline;
}

/** A caption's look: the preset that draws it and the colors in its slots. */
export interface CaptionStyle {
  preset: CaptionPreset;
  /** Hex colors, one per slot; `false` leaves every slot at the preset's own. */
  colors: string[] | false;
}

/** Every caption in the document that an edit may reach: not locked, not loop-made. */
export function editableCaptions(world: World): { editable: Entity[]; skipped: number } {
  const editable: Entity[] = [];
  let skipped = 0;
  for (const entity of world.query(Caption)) {
    if (!authoredElement(entity)) continue;
    if (containsLocked(world, entity) || isLooped(entity)) skipped++;
    else editable.push(entity);
  }
  return { editable, skipped };
}

/**
 * Gives captions a style as one undo step. Only `preset` and `colors` are written: `src` — the
 * transcript's words and timing — and authored placement are left as they are.
 * Classic is the preset a caption plays with none, so it is spelled as none.
 */
export function applyCaptionStyle(world: World, entities: Entity[], style: CaptionStyle): number {
  const editor = getDocumentEditor(world);
  const history = getEditHistory(world);
  let applied = 0;
  // Bracketed as a gesture: a step that never merges with the one before,
  // so two Applies in quick succession are still two undos.
  history.beginGesture();
  try {
    for (const entity of entities) {
      if (!entity.isAlive() || !entity.has(Caption) || containsLocked(world, entity) || isLooped(entity)) continue;
      editor.editProperty(entity, 'colors', style.colors);
      editor.editProperty(entity, 'preset', style.preset === 'classic' ? false : style.preset);
      applied++;
    }
  } finally {
    history.endGesture();
  }
  return applied;
}
