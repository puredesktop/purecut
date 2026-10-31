# Upstream review — 31 October 2026

PureCut is adapted from [diffusionstudio/editor](https://github.com/diffusionstudio/editor). The histories are unrelated (see the [7 October review](UPSTREAM_REVIEW_20261007.md)), so upstream changes come in as cherry-picks or ports.

## Scope

- Last review: upstream 38ecaef (v0.210.0, 8 October).
- Upstream `main` is now af570c1 (v0.216.0, 19 October): 110 commits, not counting merges, touching 484 files under `apps/web/src`. More than half of those files are icons.
- PureCut was at 375d955.

## Imported

| Upstream | What it fixes | How |
| --- | --- | --- |
| e5efb56 | Shift + mouse wheel scrolls the timeline sideways, as it does elsewhere on macOS and Windows. | Cherry-pick. |
| 5ac1c05 | SVG files get thumbnails, and an SVG without width and height takes its size from its viewBox. | Cherry-pick. |
| a3cd943 | A file whose stat reports a fractional modification time was treated as changed on every open, so it was re-imported. | Ported (one line). |
| 83df6a2 | Deleting a track's last keyframes left an empty keyframe track behind in the file. | Ported to PureCut's `keyframes.tsx` and `deleteSelection`. |
| fc13c89 | Dragging several selected keyframes moved only those on screen; selected keyframes scrolled out of view or on a collapsed track stayed put. | Cherry-pick. Kept PureCut's lock check on trims. |
| 4e64fd8 (runtime part) | Guinea and Spotlight caption highlights set a colour the text did not draw; keyframed text shadows, strokes and fills drew their authored colour instead of the animated one. | Ported to PureCut's older text renderer (no stroke paint children). The paint-keyframe inspector rework in the same commit is not taken. |
| b8f0615 (detector only) | Pause cleanup's silences came from a fixed loudness threshold over the waveform picture drawn for the agent, so on a long recording they were only as precise as one picture column, about half a second for an hour. A noisy room also read as one long sound. | `silence/detect.ts` and its worker, unchanged, as `purecut/speech/silence-detect.ts` and `silence-worker.ts`. The pause review and `proposeCutSpeechCleanup` now find silences every 10 ms, against each recording's own noise floor, with no padding (`pauseCuts` keeps the retained pause and the margin around words). Music or steady noise has no silence to cut. |

## Not taken, by feature family

Most of upstream's new work builds on features PureCut has not adopted. In particular, the vector shapes and the inspector rework from v0.206–v0.210 were deferred on 7 October. Each family below would come in as a whole, with its prerequisites, as its own change.

| Family | Upstream commits | Why not now | What it needs |
| --- | --- | --- | --- |
| Shapes and vector paths: `<ellipse>`, `<polygon>`, `<path>` with vertex editing, pivot, stroke dash and caps, angular gradients, paint keyframes | eaacc15, 5552978, e13b7f9, 3dbdb22, 2c736e5, dd49464, d519017, d6c76e6, bdbe912, acb7092, 09f227f, 747a719, 4e64fd8 (UI), 8a1313b | PureCut's runtime and JSX have no ellipse, polygon or path elements, and no vector path traits. These came upstream between v0.206 and v0.210 and were not taken. | A runtime, reconciler and JSX catch-up, then the drawing tools and stroke inspector in PureCut's own panels. |
| Masks from any shape (the Mask tool replaces the Clip path tool; "Use as mask"; mask `type` channel) | 075732f, 783edc2, 6a45d56, e2d070f | Needs the shapes family first. It would also replace PureCut's Clip path tool, which was ported on 8 October. | The shapes family, then a decision on retiring the Clip path tool. |
| Silence removal as a command | b8f0615 (command and UI), b01a79a | PureCut already shortens pauses inside its transcript cleanup, with review before anything is cut, and never cuts words; a second command would duplicate it. Its detector is taken (above). | Nothing. |
| Right-click menus and arranging: node context menu, layer toggles, clean-up into a grid, multi-select of assets and folders, moving and renaming folders, pasting media from the clipboard, middle-ellipsis names | d3d2a0b, 6c6349a, efbc257, 7760cb5, fb8a924, c897d7b, 53aa33e, 893eab6, 82ebd30, 8d657e5, 7b3e1fc, 78b0580, d68a336, 8107138, 9ccaac4, 090669c, 9d8327b, e53775d, 2609b28, 5ac1c05 (taken) | Built on upstream's new command system and its menu components, and PureCut's sidebar and canvas menus are its own. | Port the engine actions (`align.ts` grid clean-up, clipboard import, folder moves) behind PureCut's existing menus. |
| Command palette, action bar and toolbar slots | bb4ac3b, 56a8f09, 748f31a, ec84c73, 9617d8a, 2a54059, f964e5c, 96d7242, c21f56a, 41ea0e2, db9a6f6, 66bed78, c95e6af, d8ca02a, 744dbcb, b8869dd, 3bf9f55, c530e9c, 5681fd9, 250c4cc, 0cd29c9 | PureCut has its own command bar and keys sheet. | Single ideas could be taken: recent commands; "export current frame" with presets; timeline navigation shortcuts. |
| Inspector and panel rework: floating inspector clamping and close, text panel font size, layout panel menus, segmented tabs tooltips, colour and opacity picker styling | d14c0f3, 81ab54f, 5b78463, 21cb4d0, 9f09a76, 83c38cc | These upstream panels are not in PureCut, whose inspector is its own. | Nothing, unless PureCut adopts these panels. |
| Canvas panning when the panels show or hide | bbb2fad, f3d3a08 | PureCut's canvas does not pan when its panels toggle. | Only if that behaviour is wanted. |

## Not relevant

- Projects dashboard, collections, moving and relocating project folders, multi-project delete, opening projects in code editors: 78fe83f, bd11bc6, 852b3d5, 83e734a, a5717bf, e5a4024, 58af160, 9a42b13, 450495c, 9bc577c, c6a5c72, 47d38fb, 1fc4d16. PureCut's documents are PureDesktop's.
- Credits, pricing and AI credit icons: ed4a04f, 5aeb751.
- Cloud generation, models and the prompt input: 7a2eee7, daeb15f, 29f214b, 5433bea, e836ffc (generation shimmer). PureCut uses only the drawer for inference.
- Agent chat and its desktop session: fb50341, c413432, 9b3983d.
- Desktop auto-update and window chrome: 98ea0c9, a567775.
- Version bumps, icon-only and icon-README commits: d3260cb, be7c406, b9dcc61, 17e09d1, f29396e, a54e415, 1e11b17, b1aa661, bd3a67d, 3970904, ed4a04f.
- Internal renames with no behaviour change: 0e57cd2.
- Upstream's timeline palette: db5a4e9. PureCut keeps its own.

## Adoption boundary

Nothing upstream changed the licence (MPL-2.0). PureCut's own export, OPFS, locking, speech and mask paths are unchanged.
