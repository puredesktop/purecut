<p><img src="docs/assets/app-icon.svg" width="88" height="88" alt="purecut icon"></p>

# purecut

**Edit video on a timeline or through its transcript.** An app for [puredesktop](https://puredesktop.ai).

[Get started](#getting-started) · [App guide](docs/app-guide.md) · [Develop](docs/development.md) · [Developer account](https://puredesktop.ai/developers)

## What it does

A local video editor adapted from Diffusion Studio. Assemble media on a timeline, edit recordings by selecting transcript text, generate aligned captions, and keep the visual edit and JSX project source in sync before exporting video. Speech features are optional: ordinary editing and export work without a transcription service.

## Requirements

Use a compatible [puredesktop](https://puredesktop.ai) build for desktop integration, storage, and the app drawer. Developer setup is covered in the [development guide](docs/development.md).

**Speech editing is optional.** New transcription requires shared Speech access in a compatible host and AssemblyAI or a compatible local provider configured in **Settings → Speech**. Cloud transcription asks for upload consent. Saved transcripts remain editable without a new request; ordinary editing and export need no speech service.

## Getting started

1. Create or open a `.cut` project, then import your media.
2. Arrange clips on the timeline and use the preview to check edits before exporting.
3. For speech editing, add one recording to a scene, open **Transcript**, check the recording and configured speech service, and choose **Transcribe recording**. Cloud transcription requires your upload consent.
4. Select transcript words and press **Delete/Backspace** or **Cut selection** to remove that passage and close the gap. Use **⌘/Ctrl Z** to undo.
5. Expand **Clean up speech** to review filler words or shorten actual silence. Use **Generate captions** for subtitles, or select a passage and choose **Create highlight** for a separate scene.
6. Preview the result and export when ready. Original media remains intact.

## App layout

| Area | What you use it for |
| --- | --- |
| **Media and project controls** | Bring source media into the project and manage project-level actions. |
| **Preview** | Watch the current composition and check the result at the playhead. |
| **Transcript** | Read speech beside the preview, drag-select words, and cut passages with Delete/Backspace. Search, cleanup suggestions, captions, and highlights are available here. |
| **Timeline** | Arrange clips and tracks, adjust timing, and navigate the edit. |
| **Editing controls** | Adjust the selected clip or composition and access video export. |

The app also uses the shared [puredesktop](https://puredesktop.ai) shell and drawer agent. Panels can vary with the current view and selection.

## Working with the agent

Open the app’s drawer in [puredesktop](https://puredesktop.ai) and describe what you want to do. For example:

> Find the passage about the launch in this transcript.
>
> Propose removing filler words and generating captions.

The app exposes 11 tools, including `getCutContext`, `getCutTranscript`. See [agents.md](agents.md) for workflows and [plugin.json](plugin.json) for the complete tool schemas and approval flags. Transcript cuts, cleanup, highlights, and captions are proposals you review before applying. The agent cannot silently start transcription.

## Files and data

Projects are `.cut` folders containing JSX source and copied media; MP4 renders are saved in the project’s `renders` folder. Transcript cuts leave original media intact. Cloud transcription sends the selected recording to the chosen provider after consent.

## Develop and customize

We welcome **developers and vibecoders alike**. Fork purecut, add a feature, or use what you learn to build a new app.

| Develop your way | Workflow |
| --- | --- |
| **Claude Code, Codex, or your editor** | Open the app’s source folder, read `README.md`, `plugin.json`, `package.json`, and `agents.md`, then make changes and run the app’s checks. Test inside [puredesktop](https://puredesktop.ai) with matching shared platform packages. |
| **purefactory** | Choose **Start building** for a new app, or select an available app project to extend it. Use **Open folder** for external tools and **Open app** to test. |
| **App drawer** | Request a local app change where app-development integration is available. Make clear whether you want to change the app itself or its current document. |

Use **Share** in purefactory to create a `.pureapp` package, then **Settings → System → Install an app → Choose package…** to load it in current builds. Source availability and integration vary by host build.

Follow the [development guide](docs/development.md) for Claude Code/Codex commands, app-specific setup and checks, and packaging. A standalone browser preview does not provide every desktop service.

## Documentation and limitations

| Guide | What it covers |
| --- | --- |
| [App guide](docs/app-guide.md) | App overview, source layout, and usage. |
| [Development guide](docs/development.md) | External coding tools, purefactory, checks, and installation. |
| [Agent guide](agents.md) | App-specific agent workflows and constraints. |
| [Technical reference](docs/technical-reference.md) | Architecture, file formats, detailed controls, and checks. |
| [Speech editing](docs/speech-editing.md) | Providers, transcript cuts, cleanup, captions, and highlights. |

Speech editing currently supports one source recording per speech scene. Bridge media reads/writes have a 128 MB limit. Only open trusted JSX projects. This app contains the integrated browser editor and media packages; it does not ship the upstream standalone Electron, CLI, MCP server, or Claude Agent SDK.

## Contributing and marketplace

We welcome **developers and vibecoders alike**. Go to [puredesktop.ai](https://puredesktop.ai) and [create a developer account](https://puredesktop.ai/developers) to join the developer community and submit your app for review.

Bring improvements to this app, develop a fork, or build something entirely new. We welcome **open-source and proprietary projects alike** to the [puredesktop](https://puredesktop.ai) marketplace. Support for **paid apps is coming soon**, so you will be able to charge for your apps if you choose. Forks and redistributed dependencies must follow their applicable licenses.

For developer access, app submissions, or marketplace questions, contact [info@puredesktop.ai](mailto:info@puredesktop.ai).

Anyone may use, study, modify, and share this app under its applicable licenses. We welcome pull requests, bug reports, and documentation improvements. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Credits and license

A timeline video editor adapted from the open-source [Diffusion Studio](https://github.com/diffusionstudio/editor) project (MPL-2.0).

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
