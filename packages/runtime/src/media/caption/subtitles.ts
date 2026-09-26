/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Transcript } from '@diffusionstudio/assets';

const TIMESTAMP_RE = /(?:\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3}/g;

export type SubtitleFormat = 'srt' | 'vtt';

/** Exports source cues, without applying a timeline clip's trims or speed. */
export function serializeSubtitles(transcript: Transcript, format: SubtitleFormat): string {
  const timestamp = (milliseconds: number) => {
    const hours = Math.floor(milliseconds / 3600000);
    const minutes = Math.floor(milliseconds / 60000) % 60;
    const seconds = Math.floor(milliseconds / 1000) % 60;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}${format === 'srt' ? ',' : '.'}${String(milliseconds % 1000).padStart(3, '0')}`;
  };
  const cues = transcript.map((segment, index) => {
    if (!segment.words.length || segment.words.some(word => !Number.isFinite(word.start) || !Number.isFinite(word.end) || word.start < 0 || word.end <= word.start))
      throw new Error(`Caption ${index + 1} has invalid word timings`);
    const start = Math.round(Math.min(...segment.words.map(word => word.start)) * 1000);
    const end = Math.round(Math.max(...segment.words.map(word => word.end)) * 1000);
    if (end <= start) throw new Error(`Caption ${index + 1} is shorter than one millisecond`);
    const text = segment.text.replace(/\r\n?/g, '\n').replace(/\n\s*\n/g, '\n').trim();
    if (!text) throw new Error(`Caption ${index + 1} is empty`);
    return { start, end, text: text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') };
  }).sort((a, b) => a.start - b.start);
  const body = cues.map((cue, index) => `${index + 1}\n${timestamp(cue.start)} --> ${timestamp(cue.end)}\n${cue.text}\n`).join('\n');
  return (format === 'vtt' ? 'WEBVTT\n\n' : '') + body;
}

function parseTimestamp(raw: string): number {
  return raw
    .replace(',', '.')
    .split(':')
    .reduce((acc, part) => acc * 60 + Number(part), 0);
}

/**
 * Parses SRT or WebVTT text into a `Transcript`. Each cue becomes one segment
 * (a sentence boundary for grouping). Cues carry no word timings, so each
 * word's window is synthesized proportional to its length within the cue.
 */
export function parseSubtitles(text: string): Transcript {
  const transcript: Transcript = [];
  const blocks = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split(/\n{2,}/);

  for (const block of blocks) {
    const lines = block.split('\n');
    if (/^(?:NOTE(?:[ \t]|$)|STYLE(?:[ \t]|$)|REGION(?:[ \t]|$))/.test(lines[0])) continue;
    const timingIndex = lines.findIndex((line) => line.includes('-->'));
    if (timingIndex === -1) continue; // WEBVTT header, NOTE/STYLE/REGION blocks, stray indices

    const timestamps = lines[timingIndex].match(TIMESTAMP_RE);
    if (!timestamps || timestamps.length < 2) continue;
    const start = parseTimestamp(timestamps[0]);
    const end = parseTimestamp(timestamps[1]);
    if (!(end > start)) continue;

    // Strip inline markup: HTML/VTT tags (<i>, <c.class>, <00:01.000>) and
    // SSA-style overrides ({\an8}).
    const content = lines
      .slice(timingIndex + 1)
      .join(' ')
      .replace(/<[^>]*>/g, '')
      .replace(/\{\\[^}]*\}/g, '')
      .replace(/&(amp|lt|gt|nbsp);/g, (_, name: string) => ({ amp: '&', lt: '<', gt: '>', nbsp: ' ' })[name]!);

    const tokens = content.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;

    const total = tokens.reduce((acc, token) => acc + token.length, 0);
    const duration = end - start;
    let elapsed = 0;
    const words = tokens.map((token) => {
      const wordStart = start + (elapsed / total) * duration;
      elapsed += token.length;
      return { text: token, start: wordStart, end: start + (elapsed / total) * duration };
    });

    transcript.push({ text: tokens.join(' '), words });
  }

  return transcript.sort((a, b) => a.words[0].start - b.words[0].start);
}
