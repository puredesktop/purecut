# purecut app guide

A local video editor adapted from Diffusion Studio. Assemble imported media on a timeline, preview a composition, and keep the visual edit and JSX project source in sync before exporting video.

## Workspace layout

| Area | What you use it for |
| --- | --- |
| **Media and project controls** | Bring source media into the project and manage project-level actions. |
| **Preview** | Watch the current composition and check the result at the playhead. |
| **Timeline** | Arrange clips and tracks, adjust timing, and navigate the edit. |
| **Editing controls** | Adjust the selected clip or composition and access video export. |

## Working with purecut

1. Create or open a `.cut` project, then import your media.
2. Arrange clips on the timeline and use the preview to check edits before exporting.
3. Save the project with its source and media references; export video from the editor when ready.

## Optional transcript editing

Add one recording to a scene, then open **Transcript**. The setup screen shows the recording and speech provider before you start. Configure a compatible provider in [puredesktop](https://puredesktop.ai) **Settings → Speech**. App settings control whether speech editing is enabled, provider selection and the daily attempt limit. Cloud uploads require explicit consent in the transcription panel.

Once a transcript is available, read it beside the video, drag-select a word or passage, and press **Delete/Backspace** or **Cut selection**. The corresponding media is removed and gaps close. **⌘/Ctrl Z** restores the edit. **Clean up speech** offers reviewed filler/repetition suggestions and waveform-based pause shortening. **Generate captions** creates source-aligned subtitles; **Create highlight** proposes a new scene from selected passages while preserving the original.

The drawer agent can read/search transcripts and propose the same cuts, cleanup, highlights and captions for review. It does not start uploads. See [agents.md](../agents.md) and the [speech-editing guide](speech-editing.md) for tools, settings, limitations and storage. A compatible host speech bridge is required for new transcription; normal editing and export remain available without it.

## Development and loading

We welcome **developers and vibecoders alike**. [Create a developer account on puredesktop.ai](https://puredesktop.ai/developers), then use Claude Code, Codex, your own editor, or purefactory to develop this app or create a new one.

The [development guide](development.md) covers preparing this repository's shared dependencies, starting a coding agent, adding features in purefactory, and checking the result in the desktop. It includes the commands available in this repository.

Use **Open folder** in purefactory to edit a project externally, and **Open app** to test it. Use **Share** to create a `.pureapp` package, then **Settings → System → Install an app → Choose package…** in current builds to install it. Older versions may provide **File → Install App…**. A development server URL alone does not install an app.

To extend this app in purefactory, select its editable project when available. Source development builds can expose the suite's own apps; packaged installations do not expose every built-in app's source. See [create or extend an app](development.md#create-or-extend-an-app-with-purefactory) for that distinction and the app drawer workflow.

## Source layout

| Path | Purpose |
| --- | --- |
| [plugin.json](../plugin.json) | Desktop app manifest. |
| [package.json](../package.json) | Workspace scripts and dependencies. |
| [purecut](../purecut) | Desktop-specific editor integration and project tooling. |
| [apps/web](../apps/web) | Upstream-derived editor UI and web code. |
| [scripts](../scripts) | Development, build, and validation tools. |
| [PURECUT.md](../PURECUT.md) | Editor architecture and integration details. |
| [docs](../docs) | Additional technical documentation. |

## Developer accounts and the marketplace

We welcome **developers and vibecoders alike**. Go to [puredesktop.ai](https://puredesktop.ai) and [create a developer account](https://puredesktop.ai/developers) to join the developer community and submit your app for review.

Bring improvements to this app, develop a fork, or build something entirely new. We welcome **open-source and proprietary projects alike** to the [puredesktop](https://puredesktop.ai) marketplace. Support for **paid apps is coming soon**, so you will be able to charge for your apps if you choose. Forks and redistributed dependencies must follow their applicable licenses.

For developer access, app submissions, or marketplace questions, contact [info@puredesktop.ai](mailto:info@puredesktop.ai).

## Contributing

We welcome pull requests, bug reports, new features, and documentation improvements. You may modify and distribute this app under its applicable licenses. See [CONTRIBUTING.md](../CONTRIBUTING.md), [LICENSE](../LICENSE), and [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).
