# Upstream review — 7 October 2026

PureCut is adapted from [diffusionstudio/editor](https://github.com/diffusionstudio/editor). This repository's history was restarted ("Initial clean purecut source"), so it shares no commits with upstream, and upstream changes come in as cherry-picks or ports, not merges.

## Scope and baseline

- PureCut's engine baseline is upstream v0.205.1 (b317412, 2026-09-14).
- Upstream `main` is now at 38ecaef (v0.210.0, 2026-10-08): 145 commits touching 476 files.
- PureCut was at 63562ec. Its `packages/` code is mostly upstream as-is. `apps/desktop/src/edit.ts` now lives at `purecut/editor-core/edit-core.ts`.

## Imported

| Upstream | What it fixes | How |
| --- | --- | --- |
| d302d4b | Text motion left a stale copy of the text in `Computed.chars`, so a static node could keep showing old words, captions in particular. | Cherry-pick. |
| f00276f | Preset animations overwrote authored values: a fade-in on a clip at 80% opacity ended at 100%. Presets now scale or shift the authored value, and overlapping presets compound. | Cherry-pick. Every compounded property is reset each frame by `resetAnimatedValues`. |
| 1a10ee1 | A caption inside a `<sequence>` was placed against the sequence, which reads 0×0 on its first pass. | Cherry-pick. |
| 9c9768d | `basename` failed on a trailing slash or on Windows separators. | Cherry-pick. |
| ae33eab | A text edit replaced all of an element's children, so its `<solidPaint>`, strokes and comments were lost. | Ported to `edit-core.ts`. |
| f2d6f55 | Alt-drag duplicates the selection, then moves the copies. | Cherry-pick, adapted: a selection that contains a locked node is not duplicated. |

## Deferred

| Upstream | Why | What would qualify it |
| --- | --- | --- |
| a0f843f: the user's edit overwrites prop expressions (`x={MARGIN}`) | Behaviour change: an inspector or drawer edit would replace authored expressions where it is now reported as skipped. It fixes the snap-back where the canvas shows a value the file does not hold. | A product decision on authored expressions versus the snap-back. |
| b195be7, a2ff215: text colour row edits `color`; Source rows move into Appearance | This is an inspector restructure, and PureCut's inspector is customised. The text-colour problem it touches is tracked separately: a text's own colour is drawn beneath its paint children. | A PureCut-specific fix for text colour. |
| 1f04768: no waveform for audio inside a scene | Every PureCut project nests its media in a `<scene>`, so this would hide all waveforms on the stage. | Not needed in its upstream form. |
| 1199553: export cancel confirmation | UI only. PureCut's export path already has its own cancel handling. | Only if the cancel experience needs redesign. |
| f2a8258: caption preset colours | Changes how existing projects look. | A design decision. |
| fc63b73: Google Fonts | Fetches fonts over the network, while PureCut ships bundled fonts (#24). | An offline and privacy policy for fonts. |
| Object masks and clip paths (SAM 2.1; e63f1c7…cde1cc1, 6ce9321, 5c685e1, 22d32d9, 794c5d8) | A large feature with ONNX models and new JSX types. | Its own adoption project. |

## Not relevant

The rest is out of scope for PureCut:

- Windows build and signing, and the CLI (`dapi` → `diffusion`).
- The desktop tray, MCP and skill installs, and analytics.
- Purchases, credits and upgrade dialogs.
- Cloud generative AI: generate and job endpoints, model menus, and generation placement. PureCut uses only the drawer for inference.
- The agent chat and dashboard UI.
- Version bumps.

## Verification

All results below are from this branch, inside a ps-suite `main` worktree (cc9de679d):

- `tsc` for `apps/web/tsconfig.app.json`, `purecut/tsconfig.json` and `purecut/tsconfig.frame.json`: 0 PureCut errors, the same as the base. The only errors come from ps-suite packages, because the worktree has no root install.
- `check:dependencies`: pass. `npm run build`: pass, in 17 s.
- `test:purecut:edit-core` (new): 5/5 pass. Without the ae33eab port, 3/5 fail.
- `test:purecut`, including the new `browser-upstream-runtime-check`: pass. `test:purecut:tools`: pass. `test:purecut:disk`: pass.

## Adoption boundary

Nothing upstream changed the licence (MPL-2.0). PureCut's own export, OPFS, locking and speech paths are untouched.
