# PureCut architecture and verification

## Source of truth and ownership

A `.cut` package contains `index.tsx`, `package.json`, `assets.yml`, copied
`assets/`, and optional `renders/`. The timeline, inspector and shared agent
drawer edit the same JSX. Imported projects are trusted executable content.

- `purecut/frame.tsx`: public AppFrame, bridge readiness, loading/errors and
  initial/subsequent viewport resource delivery.
- `purecut/integration.ts`, `entry.tsx`: React/Solid boundary and editor mounting.
- `purecut/lib/projects.ts`: app-owned project domain operations, source
  compilation/writeback, revision checks and media write staging.
- `purecut/lib/platform-files.ts`: standard platform filesystem/storage helpers.
  Binary reads avoid fetching custom-scheme preview URLs from the app iframe.
- `purecut/lib/compiler.ts`, `purecut/editor-core/`: browser compilation,
  in-memory source edits and renderer protocol definitions. The upstream
  standalone desktop, CLI and agent host are removed.
- `purecut/transport.ts`: translates upstream editor domain messages to the
  in-process project service. Its `window.desktop` shim is app-local; it does
  not access the shell's private `window.platformShell` interface.
- `purecut/drawer.ts`: eleven manifest-declared tools, registered after readiness.
  No internal agent, account, backend inference, or separate chat is mounted.

## Appearance

PureCut follows the desktop light/dark setting. AppFrame supplies the theme;
Kobalte controls and portals mirror it without a separate saved theme preference.
Panels use the shared glass/chrome tokens and a transparent iframe background.
Timeline ruler/keyframe colours follow the mode; media and authored scene colours
are unchanged. The floating toolbar uses a stronger surface for legibility over
video. Verify by switching the desktop theme while a project remains open.

## Lifecycle and persistence

AppFrame wraps loading, errors and ready state. The public viewport hook handles
explicit resource opens; the editor flushes pending writes before an explicit
open or agent operation. A loaded project binds its directory to the shell tab.
Binding failures are visible. Manual edits debounce to bridge writes. Agent
source changes require a matching SHA-256 revision and compile before saving.
A second read detects external changes during compilation; this is not an
atomic compare-and-swap filesystem transaction.

Operations serialize across same-origin tabs using Web Locks. Media writes
stage in OPFS, supporting random-access MP4 output, before committing via the
binary bridge. Reads reject truncated data. No private HTTP endpoints, runtime
Node service, service token, or Vite middleware is needed. `dist/index.html`
works through the normal `pure-app` protocol.

## Verification

- `npm run typecheck`: upstream web, compiler, adapter and React frame types.
- `npm run test:purecut`: browser compiler, stable ids, manual/source edits,
  stale revisions, invalid imports, path traversal, bounded binary reads,
  byte preservation, random-access export writes and project reopen.
- `npm run build`: static artifact. PureDesktop validates `plugin.json` when
  loading the app.
- `npm run test:purecut:browser`: actual built app in Electron; real local
  A/V import, drawer source edit, scene check, MP4 export with audible tail,
  and reload persistence. Runs without a Vite runtime or Node sidecar.
- Local user-reported MP4 import regression: `final3-opening-hold.mp4`,
  5,523,327 bytes, imports and reopens; playback decodes 1920×1080 / 29.4 seconds.

## Known limits and follow-up qualification

- The binary bridge uses complete files: 128 MB per media import/export. OPFS
  staging does not make the final bridge transfer streaming. Long exports and
  large audio buffers need separate memory/performance qualification.
- Browser JSX/TypeScript compilation is lazy-loaded but is a large bundle.
- One `index.tsx` entry per package; no multi-file source editor. No automatic
  external filesystem watching, project duplication or project deletion UI.
- JSX is executable trusted code. Import restrictions and path validation do
  not sandbox scripts or prevent symlink traversal in user-managed packages.
- Electron testing here is macOS. Other OS/GPU/codec combinations, long mixed
  timelines and installer distribution need release qualification.
- The shell owns model invocation/approval; tool integration tests do not
  certify the quality of every model's editing decisions.

These are product/release limits, not dependencies on an app-specific shell
service. The local preview launcher uses ordinary installed-app discovery and
must not coexist with another discovered app carrying the same `cut` identity.

## Document overlay

PureCut uses the platform `DocumentSwitcher` for its landing surface and header
picker (also Cmd/Ctrl+O). Existing valid `.cut` packages are registered with the
shared document library; opening records a recent document. New/open transitions
flush pending timeline edits before changing projects. Package metadata supplies
the video title; the editor and drawer still share the same saved JSX.

Rename updates package metadata. Move, duplicate and delete are guarded in the
picker pending app-owned rebinding/identity support; they must not fall through to
uncoordinated generic folder actions. The system chooser opens a folder picker
and validates the selected package before navigation.

Verified in built Electron: overlay creation, local media import, agent source
edit, MP4 export and reopening via `test:purecut:browser`. Shared generated-name
handling is covered by the platform documentDisplay tests.

## Object masks and clip paths

Ported from upstream (see `docs/UPSTREAM_REVIEW_20261007.md`). A `<rect
clipPath>` clips its parent to its box (`<rect mask>`, the old spelling, still
reads). A `<mask src="masks/<video>/Tracking <n>.mask">` under an `<effect>`
limits that effect to a tracked object; under `opacity` it is a cut-out. Mask
files are project assets (`.mask`, the model's per-frame field plus the recipe
that made it), written by the Object mask tool (M). Preview and export draw
them through the same `MaskDecoder` and layer passes.

The tool runs SAM 2.1 on this computer: `packages/sam2`, ONNX Runtime Web on
WebGPU, with the runtime's WebAssembly bundled in `dist/`. This is on-device
vision, not a language model, and the drawer agent cannot run it. The weights
are not shipped. The first time a model is needed, the bar over the canvas
names its size and source (Hugging Face, pinned revision, Apache-2.0) and
fetches nothing until the person chooses **Download**. Files are kept in the
app origin's private file system (`models/`), resume after an interrupted
download, and are re-used offline. Without WebGPU, or without a connection
before the first download, the bar says so and the rest of the editor is
unaffected.

| Model | Download | Input |
| --- | --- | --- |
| SAM 2.1 Tiny (default) | 83 MB | 512 px |
| SAM 2.1 Small | 112 MB | 1024 px |
| SAM 2.1 Base | 183 MB | 1024 px |
| SAM 2.1 Large | 475 MB | 1024 px |

Shell requirements: none beyond what `pure-app` already grants (standard,
secure, fetch, CORS, stream). The app documents carry no CSP, so the
`huggingface.co` and `*.hf.co` fetches are allowed; WebGPU is not gated by the
iframe's `allow` list. App frames are not cross-origin isolated, so ONNX
Runtime's WebAssembly fallback is single-threaded; the models run on WebGPU.

Verified by `browser-object-mask-check` (in `test:purecut`): the mask file
format, library and thumbnail, the compiler's `<mask>` and SVG handling,
preview and decoded-export pixels for a moving mask, clip paths and the legacy
spelling, the tool's commit with segmentation stubbed, locked clips, and that
nothing is fetched before consent. Edit-core round trips are in
`test:purecut:edit-core`.

### What a mask is used for

The tool's bar picks what **Confirm** makes of the tracked object (**Use
as**, remembered): **Cut out** (an `opacity` effect on the clip), **Blur** or
**Pixelate** (a privacy `blur` or `pixelate` effect on the clip, limited to
the object), or **Behind text** (every text above the clip that plays with
it goes behind the object). Each is one document edit and one undo step,
spelled in the JSX like anything else (`engine/object-mask/uses.tsx`).

Behind subject is a node's `opacity` effect holding an inverted `<mask
follow="<clip id>">`: the mask is placed in the followed clip's box and timed
by its footage, so the node is cut away where the subject is and the subject
shows through from the clip below. A text's inspector has a **Behind
subject** section to pick the subject, change it or turn it off, and before
anything is tracked it says how to track one with the Object mask tool.

`pixelate` is an effect of the runtime (block size in px of the node, drawn
as a layer pass in the preview and the export alike). Blur effects, a node's
own blur and a mask's feather are measured in px of the node, so a privacy
blur is as strong in a 4K export as in the preview.

Verified by `browser-mask-uses-check` (in `test:purecut`) with a hand-made
mask: pixels of preview and decoded export agree for behind subject, blur and
pixelate; the editor's commands undo in one step and round-trip through
`applyEdits` and the compiler. `scripts/test-mask-uses-visual.mjs` takes the
screenshots.

### The assistant asks to track an object

The drawer agent never runs a model. `trackCutObject({clip, at?, time?, use?,
label?})` validates the clip (a directly authored, unlocked video clip in the
open scene), moves the playhead there, and picks the Object mask tool aimed at
that clip with `use` preselected. The agent's `at` is drawn on the video as a
dashed "Suggested" ring, not a prompt; a note above the bar says the assistant
asked, for what, and to click the subject or **Use suggested point**. Opening
writes nothing to the project, and returns `awaiting_person` at once. The
model's download consent is the bar's own, unchanged.

The person's Confirm runs the normal tracking and commit
(`finishTrackedObject`): one undo step. Cancel, Esc, another tool, closing the
project or removing the clip end the request as cancelled; no WebGPU ends it as
unavailable. `getCutTrackStatus` reports pending (with what is awaited),
done (mask path, the use confirmed, how many elements took it), cancelled,
unavailable or failed, with a message the agent can relay. One request at a
time (`engine/object-mask/request.ts`).

Verified by `browser-track-request-check` (in `test:purecut`) with stubbed
tracking and `scripts/test-track-request-visual.mjs` (screenshots, Cancel in
the bar).
