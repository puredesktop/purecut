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

## Shapes and vector paths (feat/shapes)

The engine packages (`packages/runtime`, `jsx`, `reconciler`) were merged three-way from upstream eeb02386 (10 October, the `<path>` primitive), taking PureCut's original baseline, b317412, as the common ancestor. That merge brings, as one piece:

- The new elements: `<ellipse>`, `<polygon pointCount>` and `<path d viewBox fillRule trimStart trimEnd trimOffset>`, with `d` keyframes that morph the outline. They are drawn, hit-tested and serialized, and work as clip paths.
- Strokes with `cap` and `dash`/`dashGap`/`dashOffset` (dashOffset can be keyframed), and stroke paint children.
- `<angularGradientPaint>`, and gradient geometry (`x1…y2`, `cx/cy/rx/ry`) as keyframeable props.
- `pivotX`/`pivotY`.
- Upstream's engine fixes from the same window.

It stops before 8a1313b, where upstream turns clip paths and masks into containers of shapes. That redesign would replace PureCut's own masks (`follow`, pixelate, the Clip path tool), so it waits for the masks family.

Kept from PureCut through the merge:

- Its hosted-generation hooks (`Ai`, `generate.*`, transcription requests, `SourceError.generated`), which upstream removed.
- Its bundled fonts: upstream fetches Google Fonts from an observer, and PureCut's caption styles still load their bundled faces.
- Its masks: `follow` and pixelate. A masked node's box is drawn as its shape.
- Its asset library. `entityAnchor` stays beside upstream's `entityPivot`.

Editor:

- The draw overlay draws ellipses and polygons.
- The toolbar's shape button has a menu (Rectangle R, Ellipse O, Polygon) and remembers the last shape picked.
- Appearance gains a polygon's Corners.
- The stroke inspector gains Line (solid or dashed, with dash and gap lengths) and Cap. Its icons are upstream's.
- The gradient picker offers Angular.

Not yet:

- ~~The Pen and path-edit tool~~ and ~~the on-canvas gradient handles~~: taken in feat/pen-tool (below).
- Stroke paint children in the inspector.

Checks: `scripts/browser-shapes-check.ts`, run by `test:purecut`, renders an ellipse, a pentagon, a dashed path and an angular gradient through the export and measures the frame (`/tmp/purecut-visual/shapes.png`).

## Pen, path editing and gradient handles (feat/pen-tool)

The editor half of the shapes family: upstream's `path-tool.tsx` (5552978, e13b7f9), `gradient-tool.ts` (acb7092) and the canvas parts of the pivot change (2c736e5), ported onto PureCut's editor.

How it fits PureCut:

- **Pointer dispatch.** PureCut already had upstream's hit regions and `DispatchedPointerEvent` (the object mask and the selection handles use them), so 3dbdb22's dispatch needed nothing new. What 3dbdb22 also did, moving the rect, ellipse, polygon, scene and text tools off the DOM draw overlay onto the HUD, is not taken: PureCut keeps `components/canvas/draw-overlay.tsx` for those. The Pen and the path editor draw on the HUD and push their own hit regions over the stage, as upstream's do, since the pen takes a press per vertex and the editor's targets are the outline's own points.
- **State.** Upstream's `DrawTool` trait (box tools and pen together) is `PenTool` here, holding only the pen's vertices and scene; `PathEditor` and `GradientTool` are upstream's.
- **Writing paths.** A pen path is written as `<path x y width height d viewBox>` with a `<stroke>`, its `d` in the box's pixels and its `viewBox` the box (`"0 0 width height"`), so it stretches when resized. Upstream writes no `viewBox` and, after an edit, folds it away; here the fit after an edit writes the box's pixels as the new `viewBox`. Resizing a path without one pins one first (upstream's `pinViewBox`).
- **Locking.** The editor will not go up on a locked path (or one inside a locked node) and goes down if its path is locked under it; Enter on a locked path falls through to selecting its children. Gradient handles are not drawn on a locked node. Edits go through `DocumentEditor`, which refuses locked targets anyway.
- **Toolbar and keys.** A Pen button (P) after the shapes, with a `cut-tool.pen` icon in the toolbar's style; it stays lit while a path is being edited. The Tools menu gains Ellipse, Polygon and Pen; the keys sheet gains O, P and Enter.
- **Additions over upstream.** Delete or Backspace takes back the pen's last vertex. A double-click on an already selected path lands on the selection mask rather than the path, so the mask's double-click opens the path editor too (upstream drills into children there and so does nothing for a path). The selection's handles step aside while the pen is drawing. The timeline names unnamed ellipses, polygons and paths.
- **Pivot.** The merged runtime turns a node about `entityPivot` (its `pivotX`/`pivotY`, else its anchor; a group without one about its origin), so the resize, rotate and move gestures, the clip path tool and the container bake now use it, Group (⌘G) authors a pivot at the members' center, and the inspector's anchor row is a Pivot row for a group or a node with a pivot (2c736e5's `pivot-row.tsx`). Before this the gestures still took the pivot as anchor × size, which the runtime no longer does for a group or a node with a pivot, so those jumped under a resize or rotation.
- **Gradient handles.** The gradient picker puts its paint's handles up while it is open (`beginGradientTool`), and takes them down on close.

Not taken: upstream's path inspector section (`inspector/path.tsx`: fill rule and trims), the trim icons, and stroke paint children in the inspector.

Checks: `scripts/test-editor-visual.mjs` drives the Pen in the full editor, in light and dark, through `scripts/pen-visual-fixture.tsx`: the toolbar's Pen button, a corner, a dragged smooth vertex and a click on the first vertex to close; Enter, a vertex dragged and Esc (the box refits, `viewBox` and all); a double-click, a click on the outline to add a vertex and Backspace to remove it; P, two clicks and Enter for an open path; and a linear gradient's end handle dragged on the canvas. Screenshots: `/tmp/purecut-visual/pen-drawing-*.png`, `path-edit-*.png`, `gradient-handles-*.png`.

## Not taken, by feature family

Most of upstream's new work builds on features PureCut has not adopted. In particular, the vector shapes and the inspector rework from v0.206–v0.210 were deferred on 7 October. Each family below would come in as a whole, with its prerequisites, as its own change.

| Family | Upstream commits | Why not now | What it needs |
| --- | --- | --- | --- |
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
