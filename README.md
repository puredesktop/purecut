<p><img src="docs/assets/app-icon.svg" width="88" height="88" alt="purecut icon"></p>

# purecut

## What purecut does

A local video editor adapted from Diffusion Studio. Assemble media on a timeline, edit recordings by selecting transcript text, generate aligned captions, and keep the visual edit and JSX project source in sync before exporting video. Speech features are optional: ordinary editing and export work without a transcription service.

## App layout

| Area | What you use it for |
| --- | --- |
| **Media and project controls** | Bring source media into the project and manage project-level actions. |
| **Preview** | Watch the current composition and check the result at the playhead. |
| **Transcript** | Read speech beside the preview, drag-select words, and cut passages with Delete/Backspace. Search, cleanup suggestions, captions, and highlights are available here. |
| **Timeline** | Arrange clips and tracks, adjust timing, and navigate the edit. |
| **Editing controls** | Adjust the selected clip or composition and access video export. |

The app also uses the shared [puredesktop](https://puredesktop.ai) shell and drawer agent. Panels can vary with the current view and selection.

## Getting started

1. Create or open a `.cut` project, then import your media.
2. Arrange clips on the timeline and use the preview to check edits before exporting.
3. For speech editing, add one recording to a scene, open **Transcript**, check the recording and configured speech service, and choose **Transcribe recording**. Cloud transcription requires your upload consent.
4. Select transcript words and press **Delete/Backspace** or **Cut selection** to remove that passage and close the gap. Use **⌘/Ctrl Z** to undo.
5. Expand **Clean up speech** to review filler words or shorten actual silence. Use **Generate captions** for subtitles, or select a passage and choose **Create highlight** for a separate scene.
6. Preview the result and export when ready. Original media remains intact.

Read the [app guide](docs/app-guide.md) for development, loading, and source-layout details, and the [speech-editing guide](docs/speech-editing.md) for providers, review, captions, and supported scene types.

The drawer agent can read/search saved transcripts and propose cuts, highlights, filler cleanup, pause shortening, and captions. Agent proposals are reviewed before application; agents cannot silently start transcription. See [agents.md](agents.md) for all 11 registered tools.

Speech editing requires a compatible [puredesktop](https://puredesktop.ai) host with shared Speech services and purecut access enabled. Configure AssemblyAI or a compatible local provider in **Settings → Speech**; choose providers and limits in the app settings. Existing saved transcripts can be edited without making a new transcription request.

## Develop and customize

We welcome **developers and vibecoders alike**. You can add features to purecut, develop a fork, or create a new app for [puredesktop](https://puredesktop.ai).

### Use Claude Code, Codex, or your own tools

Open a local source checkout or a purefactory project's folder in your preferred coding tool. Ask it to read this README, `plugin.json`, `package.json`, `agents.md`, and the [development guide](docs/development.md) before making changes. Review the changes, run the app's checks, and test it inside [puredesktop](https://puredesktop.ai). This source may require matching shared platform packages; a browser preview alone does not provide desktop services.

The [development guide](docs/development.md) explains how to start Claude Code or Codex in the project, work on this repository, and load your app into the desktop.

### Use purefactory inside the desktop

Open **purefactory** (Factory) to describe a new app, or select an available app project and request a feature. Use **Open folder** to continue with external tools and **Open app** to test the result. You can also request a local app change through the app's drawer where app-development integration is available; distinguish changing the app from editing its current document.

Use **Share** in purefactory to create a `.pureapp` package. In current builds, install it through **Settings → System → Install an app → Choose package…**. See the [development guide](docs/development.md#load-and-share-your-app) for the full workflow and version differences.

## Developer accounts and the marketplace

We welcome **developers and vibecoders alike**. Go to [puredesktop.ai](https://puredesktop.ai) and [create a developer account](https://puredesktop.ai/developers) to join the developer community and submit your app for review.

Bring improvements to this app, develop a fork, or build something entirely new. We welcome **open-source and proprietary projects alike** to the [puredesktop](https://puredesktop.ai) marketplace. Support for **paid apps is coming soon**, so you will be able to charge for your apps if you choose. Forks and redistributed dependencies must follow their applicable licenses.

For developer access, app submissions, or marketplace questions, contact [info@puredesktop.ai](mailto:info@puredesktop.ai).

## Open source and contributions

A timeline video editor adapted from the open-source [Diffusion Studio](https://github.com/diffusionstudio/editor) project (MPL-2.0).

Anyone may use, study, modify, and share this software under the applicable licenses.
We welcome pull requests, bug reports, documentation improvements, and new ideas.
See [CONTRIBUTING.md](CONTRIBUTING.md) for how to contribute.

### License

This project retains the upstream [Mozilla Public License 2.0](LICENSE).
Copyright (c) 2026 pure.science inc applies to its contributions; upstream copyrights and notices remain in force.
MPL-covered code and modifications are not relicensed as MIT.

### Major open-source projects

| Project / source | Homepage or documentation | Support the maintainers |
| --- | --- | --- |
| [diffusionstudio/editor](https://github.com/diffusionstudio/editor) | [Homepage / docs](https://diffusion.studio) | — |
| [solidjs/solid](https://github.com/solidjs/solid) | [Homepage / docs](https://solidjs.com) | [Open Collective](https://opencollective.com/solid) |
| [Vanilagy/mediabunny](https://github.com/Vanilagy/mediabunny) | [Homepage / docs](https://mediabunny.dev/) | [GitHub Sponsors](https://github.com/sponsors/Vanilagy) · [Ko-fi](https://ko-fi.com/vanilagy) |
| [pmndrs/koota](https://github.com/pmndrs/koota) | [Project home](https://github.com/pmndrs/koota) | — |
| [software-mansion/TypeGPU](https://github.com/software-mansion/TypeGPU) | [Homepage / docs](https://typegpu.com) | [GitHub Sponsors](https://github.com/sponsors/software-mansion) |
| [babel/babel](https://github.com/babel/babel) | [Homepage / docs](https://babel.dev) | [GitHub Sponsors](https://github.com/sponsors/babel) · [Open Collective](https://opencollective.com/babel) |
| [react/react](https://github.com/react/react) | [Homepage / docs](https://react.dev) | — |
| [styled-components/styled-components](https://github.com/styled-components/styled-components) | [Homepage / docs](https://styled-components.com) | [GitHub Sponsors](https://github.com/sponsors/quantizor) · [Open Collective](https://opencollective.com/styled-components) |

Thank you to these projects and their contributors. Additional direct dependencies,
upstream links, and asset notices are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).


A local timeline video editor for [puredesktop](https://puredesktop.ai), adapted from
[Diffusion Studio](https://github.com/diffusionstudio/editor). purecut keeps a
visual timeline and JSX composition in sync, with the normal [puredesktop](https://puredesktop.ai) agent
drawer. It is separate from PureVideo.

## Integrated editor dependencies

This module includes the browser editor, compiler, media runtime and export
packages. It does not install or ship Diffusion Studio's standalone Electron
app, CLI, MCP server, agent host, or Claude Agent SDK. Agent execution belongs
to the [puredesktop](https://puredesktop.ai) shell and uses its shared drawer.
The shared platform UI and bridge packages are still required from the host
checkout. Speech services remain optional.

Workspaces are explicitly listed in `package.json`. Run
`npm run check:dependencies` after importing upstream changes; it checks the
manifests and complete lockfile for standalone runtime dependencies.

## Develop and build

Clone as `apps/purecut` in the [puredesktop](https://puredesktop.ai) checkout, then:

```sh
npm --prefix "$PWD" install
npm run dev
```

Use an explicit `--prefix` when installing inside the parent npm workspace.
The upstream `patch-package` postinstall is required. Development defaults to
port 5560 and accepts the shell's `--port` override. Open it through [puredesktop](https://puredesktop.ai);
a standalone browser has no filesystem bridge. The matching host must supply the shared platform packages and speech bridge; this repository does not contain the host.

`npm run build` produces `dist/index.html` and assets for the standard
`built-static` app runtime. There is no app server or sidecar at runtime.
The React AppFrame is built separately from the Solid editor. Both use the
public platform package; project compilation happens in the browser.

Projects are `.cut` folders in the workspace's `.appdata/PureCut` directory.
Imported media is copied into the package. MP4 exports go in its `renders`
folder. Existing `.cut` folders can also be opened through the shell catalog.

## Verify

```sh
npm run typecheck
npm run test:purecut
npm run test:purecut:speech
npm run build
npm run puredesktop:check
PURECUT_CDP_URL=http://127.0.0.1:9333 npm run test:purecut:browser
```

Unit/integration tests require Chrome. The last command additionally requires
ffmpeg/ffprobe and an already-open **built-static** PureCut in an Electron
instance with remote debugging enabled. It creates a separate QA project,
imports a synthetic video with audio through the picker handler, edits through
the drawer tool implementation, checks the scene, exports MP4, verifies audio
at the end, reloads, and returns to the previous document. The QA package is
retained as evidence; it does not edit the previous document.

## Boundaries

Filesystem access uses the standard platform bridge. AppFrame owns shared
chrome and the shell owns the agent conversation. Upstream hosted generation,
account login and internal chat are not mounted in the PureCut entry.

Media reads/writes currently have a 128 MB limit. Projects contain executable
JSX and must be trusted; compilation/import checks are not a security sandbox.
See [PURECUT.md](PURECUT.md) for architecture, evidence and remaining product
qualification work.

## Upstream and licence

MPL-2.0 notices are retained; upstream authors and licenses are acknowledged below. The original README is
[README.upstream.md](README.upstream.md). Upstream desktop release workflows
are removed; distribution uses the [puredesktop](https://puredesktop.ai) app build.
