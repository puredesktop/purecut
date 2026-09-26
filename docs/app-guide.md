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

You can edit and develop this module outside [puredesktop](https://puredesktop.ai) with your own tools, then register or install it in the desktop. Alternatively, work on your local version through purefactory or the app’s drawer agent. These are ways to develop the same app source; your changes stay local until you choose to share them.

### Prepare the development environment

This repository currently references local `@purescience/platform-*` packages and, for some apps, build helpers from the parent suite. Provide the matching shared packages and build configuration when working with this source. For a new standalone app or an adaptation of this module, follow the published [app API guide](https://puredesktop.ai/docs/apps/) for the supported bridge and project setup.

Run the scripts from this app’s `package.json` in that configured environment:

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the app’s development entry point. |
| `npm run build` | Build the app bundle. |
| `npm run typecheck` | Check the source’s TypeScript types. |
| `npm test` | Run the app’s tests. |

Use the package manager and installation procedure required by your development environment. The presence of these scripts does not mean this checkout includes every shared package needed to run them.

### Load your local module

1. Start the development server and note its local URL. Keep `plugin.json` consistent with the app’s entry point, identity, and required permissions.
2. Use **File → Register App…** in a current version of [puredesktop](https://puredesktop.ai), enter the app URL and name, and select the permissions the module needs. Open it from **Browse Apps**.
3. Continue editing with your external tools, then reload and test the app in the desktop. Browser development can exercise UI where the app supports it; the desktop supplies the file, account, and agent services needed by integrated features.
4. For a packaged app, follow the platform packaging guide. The documented workflow uses **Share** from the project in purefactory to produce a `.pureapp` package and **File → Install App…** to load it on another installation.

When making a fork that should coexist with the original, give it a distinct app identity and update its manifest consistently. See the [integration guide](https://puredesktop.ai/docs/apps/) for current registration and packaging details.

### Change your local version inside the desktop

In **purefactory**, open the app project and describe the feature or change you want. You can also ask the app’s **drawer agent** to change your local version. Be explicit that the request concerns the app’s source or behavior when that is your intent, rather than the open document. Review the diff, run appropriate checks, and reload the app. You can retain the result privately, publish a fork, or send a pull request upstream.

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

[Create a developer account on puredesktop.ai](https://puredesktop.ai/developers) to take part in the developer community and submit apps for review. We welcome contributions to this app, forks that take it in a different direction, and entirely new apps to offer on [puredesktop](https://puredesktop.ai).

We welcome **open-source and proprietary projects alike** to the [puredesktop](https://puredesktop.ai) marketplace. A marketplace with support for **paid apps is coming soon**, so developers will be able to charge for their apps if they choose. When distributing a fork, follow the licenses of the code and dependencies you use.

For more information about developer accounts, app submissions, or the upcoming marketplace, contact [info@puredesktop.ai](mailto:info@puredesktop.ai).

Video projects contain executable JSX and should be opened only from trusted sources. See [PURECUT.md](../PURECUT.md) for editor architecture and media limits.

## Contributing

We welcome pull requests, bug reports, new features, and documentation improvements. You may modify and distribute this app under its applicable licenses. See [CONTRIBUTING.md](../CONTRIBUTING.md), [LICENSE](../LICENSE), and [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).
