import { parseSubtitles, serializeSubtitles } from '../packages/runtime/src/media/caption/subtitles';
import { exportSourceSubtitles } from '../apps/web/src/engine/asset-actions';
import type { Asset } from '@diffusionstudio/assets';

export async function checkSubtitles() {
  const srt = parseSubtitles('\uFEFF2\r\n00:00:03,000 --> 00:00:04,500\r\nSecond line\r\n\r\n1\r\n00:00:01,000 --> 00:00:02,000\r\n<i>First</i>\r\nline');
  if (srt.length !== 2 || srt[0].text !== 'First line' || srt[1].text !== 'Second line')
    throw Error('SRT import must handle BOM, CRLF, multiline markup and cue ordering');
  if (srt[0].words[0].start !== 1 || srt[0].words.at(-1)?.end !== 2 || srt[1].words.at(-1)?.end !== 4.5)
    throw Error('Subtitle words must retain cue boundaries');
  const vtt = parseSubtitles(`WEBVTT

NOTE example time range
00:01.000 --> 00:02.000
This is not a caption

cue-one
00:02.000 --> 00:04.000 align:start position:10%
<v Speaker>Hello</v> <c.emphasis>there</c>

STYLE
::cue { color: red; }

cue-two
00:05.000 --> 00:05.000
Zero duration

cue-three
00:06.000 --> 00:05.000
Backwards
`);
  if (vtt.length !== 1 || vtt[0].text !== 'Hello there')
    throw Error('WebVTT metadata must not become captions; valid cue settings must be accepted');
  if (parseSubtitles('1\nnot a time --> 00:02.000\nInvalid').length)
    throw Error('Malformed timing must not create a cue');
  if (parseSubtitles('1\n00:00:00,000 --> 00:00:01,000\n{\\an8}Keep {braces}')[0]?.text !== 'Keep {braces}')
    throw Error('Only SSA override commands, not literal braces, should be stripped');
  const transcript = [{ text: 'A & B < C {literal}\nnext line', words: [{ text: 'A', start: 59.9996, end: 61.002 }] }];
  for (const format of ['srt', 'vtt'] as const) {
    const output = serializeSubtitles(transcript, format);
    if (!output.includes(format === 'srt' ? '00:01:00,000 --> 00:01:01,002' : '00:01:00.000 --> 00:01:01.002'))
      throw Error('Subtitle timestamp rounding must carry into minutes');
    const restored = parseSubtitles(output);
    if (restored[0]?.text !== 'A & B < C {literal} next line' || restored[0].words[0].start !== 60 || restored[0].words.at(-1)?.end !== 61.002)
      throw Error('Subtitle export/import must retain literal text and cue bounds');
    if ((format === 'vtt') !== output.startsWith('WEBVTT\n\n')) throw Error('Wrong subtitle header');
  }
  for (const words of [[], [{ text: 'bad', start: NaN, end: 1 }], [{ text: 'bad', start: 2, end: 1 }]]) {
    let rejected = false;
    try { serializeSubtitles([{ text: 'bad', words }], 'srt'); } catch { rejected = true; }
    if (!rejected) throw Error('Subtitle export must reject invalid cues');
  }
  const originalPicker = window.showSaveFilePicker;
  let saved = '', filename = '', reads = 0;
  const asset = { type: 'TRANSCRIPT', path: 'captions/interview.json', mimeType: 'application/json', handle: { async getFile() {
    reads++;
    return new File([JSON.stringify(transcript)], 'interview.json');
  } } } as Asset;
  try {
    window.showSaveFilePicker = async options => {
      filename = options?.suggestedName ?? '';
      return { createWritable: async () => new WritableStream({ write(chunk) { saved += new TextDecoder().decode(chunk); } }) } as FileSystemFileHandle;
    };
    await exportSourceSubtitles(asset, 'vtt');
    if (filename !== 'interview.vtt' || saved !== serializeSubtitles(transcript, 'vtt')) throw Error('Subtitle save action wrote incorrect file');
    window.showSaveFilePicker = async () => { throw new DOMException('Cancelled', 'AbortError'); };
    await exportSourceSubtitles(asset, 'srt');
    if (reads !== 1) throw Error('Cancelled export must not read the source');
  } finally { window.showSaveFilePicker = originalPicker; }
  const video = document.createElement('video');
  const track = document.createElement('track');
  const url = URL.createObjectURL(new Blob([saved], { type: 'text/vtt' }));
  video.append(track);
  document.body.append(video);
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Native subtitle decoding timed out')), 5000);
      track.onload = () => { clearTimeout(timer); resolve(); };
      track.onerror = () => { clearTimeout(timer); reject(Error('Browser rejected exported WebVTT')); };
      track.track.mode = 'hidden';
      track.src = url;
    });
    const cue = track.track.cues?.[0] as VTTCue | undefined;
    if (track.track.cues?.length !== 1 || cue?.startTime !== 60 || cue.endTime !== 61.002 || cue.getCueAsHTML().textContent !== transcript[0].text)
      throw Error('Native WebVTT decoding changed cue timing or literal text');
  } finally { video.remove(); URL.revokeObjectURL(url); }
}
