# Optional speech editing

purecut can edit a recording by its transcript. The normal timeline, import,
manual editing and export work without any speech service or API key.

## Settings

Configure AssemblyAI or a local speech server in **puredesktop Settings → Speech**.
Credentials remain in puredesktop's credential vault. In **purecut app settings →
Speech editing**, enable or disable transcription, choose a configured provider
(or follow shared Speech settings), and set a daily attempt limit. No new model
runtime or API SDK is installed by purecut.

An audio provider must return individual word timestamps; a service that returns
only speaker turns, or the text-inferred speaker provider, cannot support word
cuts. Local-server owners should enable verbatim transcripts and return filler
words. AssemblyAI requests include `speaker_labels: true` and `disfluencies: true`.

Import one recording and add it to a scene. Open **Transcript**: the setup screen shows the recording, its duration and the configured speech service. Choose **Transcribe recording**. For cloud providers, explicitly
allow uploading the recording first. The host handles uploads, polling, provider
credentials, limits, cancellation, and provider transcript deletion. The app
receives only normalized speaker labels and word timings. No request is started
by opening a video, opening the panel, or by the drawer's read tools.

Missing credentials, an unavailable service or disabling transcription never
blocks normal editing. Existing saved transcripts remain usable offline. Refresh
the panel after changing settings. The transcript follows timeline edits and undo automatically.

## Edit speech

- Read the transcript beside the video. Click a word to seek; drag across text to select a passage. Shift-click also selects a range.
- Press **Delete/Backspace** or **Cut selection** to remove selected words from the video immediately and close the gaps. **⌘/Ctrl Z** undoes the cut; **⌘/Ctrl Shift Z** redoes it. The saved source recording stays intact. This edits the media; typing replacement dialogue is not supported.
- Expand **Clean up speech** for filler and pause tools. These bulk edits and drawer proposals retain **Preview result**, adjustable cut boundaries, and **Apply edit** before changing the timeline.
- **Review filler suggestions** selects “um”, “uh” and similar hesitations.
  **Include possible repetitions** also suggests repeated words and repeated
  phrases that may be false starts. These are heuristics: review intentional
  repetitions before applying. Arbitrary false starts can be selected manually.
- **Review pauses** uses Diffusion's audio waveform analysis, not transcript gaps.
  Set the minimum pause and retained duration. The planner protects word timings
  with a small margin, then offers the same preview and review controls.
- **Generate captions** reuses the saved transcript without another provider call.
  Captions are source-linked and trimmed with the recording. Use the existing
  caption inspector to edit text and styling, and subtitle export for SRT/VTT.
  Generating captions again replaces existing captions in this speech scene.
- **Create highlight** makes a separate scene from selected passages. Natural gaps
  between consecutive selected words are retained. The original scene and source
  media remain available, and the original scene stays active. Select the new
  scene on the canvas to use normal editing and export.
- Expand **Speaker names** to name the provider's generic speaker labels.

The drawer's `getCutTranscript` reads paginated words on the **edited timeline**.
It can find topics or quotes and call `proposeCutSpeechEdit` with a current revision
hash. `proposeCutSpeechCleanup` proposes filler/repetition cleanup or actual
waveform silence removal. `proposeCutCaptions` proposes caption generation from
the saved transcript. These tools share the UI's editing and undo implementation;
caption proposals explain that existing captions will be replaced. The proposal
appears in the same panel for preview and review (caption generation has Apply
and Discard). The complete drawer workflow is documented in `AGENTS.md`. The agent
cannot use these tools to silently upload media or apply an unreviewed speech edit.

## First-release scope

Speech editing supports one source recording per scene, including fragments of
that recording created by earlier speech edits, plus directly authored captions.
Video with embedded audio (including normal imported video-filled rectangles)
and audio-only recordings are supported. Overlapping
tracks, separate synchronized audio/video sources, nested sequences, animations,
transitions and speed-adjusted clips are rejected before editing. These still
work with the normal timeline tools; prepare a separate simple scene for speech
editing. Cuts align to project frames and may include a fraction of a frame around
word boundaries; preview and adjust close cuts where needed.

Transcripts do not update automatically when files outside purecut change. Reimport
changed media. The host can refuse another attempt on the same source that day;
its daily cap and duplicate-attempt policy remain in force.

## Storage and implementation

- `speech-<asset-content-id>.json` inside the `.cut` package stores original source
  word times and speaker names. Treat this as user content, just like the media.
- Generated caption assets are immutable revisions in the project media library.
  Cuts create trimmed caption assets so deleted words are removed from cue text
  as well as timing. Undo/redo restores the prior asset references and clip
  placement; source transcripts and media are never destructively edited.
- `purecut/speech/model.ts` owns interval arithmetic, timeline mapping, suggestions
  and caption grouping; `editor.ts` uses Diffusion's document editor and history.
- `client.ts` uses the existing public diarization bridge. There is no app-local
  relay, private shell IPC, or provider credential in a project or drawer result.
- `tools.ts` and `panel.tsx` share the same proposal and editing implementation.
- The host companion change enables the authenticated `cut` caller and forwards
  the optional `disfluencies` request field to AssemblyAI/local speech servers.

Run `npm run test:purecut:speech`, `npm run check:purecut` and
`npm run build:purecut`. Browser tests use synthetic audio and mocked provider
results; no credentials or paid transcription requests are needed. Live provider
quality still needs checking with representative recordings and a configured key.

For native verification on macOS, build purecut and the shell main/preload, start
the shell renderer, then run:

```sh
PURECUT_SHELL_URL=http://127.0.0.1:5170 npm run test:purecut:speech:native
```

This requires `ffmpeg`, `ffprobe`, and the installed macOS Samantha voice. It
generates a spoken video containing a filler and a long pause, runs an isolated
Electron profile/workspace with a controlled local speech server, and checks
word removal, undo/redo, pauses, captions, highlight proposals, export audio and
video, native playback and cold restart. No test recordings or credentials are
bundled with the app. The local server supplies known timestamps, so this verifies
the native integration rather than a third-party provider's recognition accuracy.
