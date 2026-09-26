# Develop purecut and build new apps

Developers and vibecoders are welcome. [Create a developer account on puredesktop.ai](https://puredesktop.ai/developers) to join the community and submit apps for review. You can use Claude Code, Codex, your preferred editor, or purefactory inside [puredesktop](https://puredesktop.ai).

## Choose your starting point

| Goal | Start here |
| --- | --- |
| Add a feature to purecut | Fork or clone this repository and prepare its shared dependencies, or select its editable project in purefactory when available. |
| Build a new app | Create it in purefactory, then continue there or use **Open folder** to work on the generated project externally. |
| Use an app someone shared | Install their `.pureapp` package using the desktop's installer. |

## Work on this repository

1. Fork [puredesktop/purecut](https://github.com/puredesktop/purecut) if you want your own repository, then clone your fork locally. Create a branch for your change.
2. Read the [app guide](app-guide.md), [package.json](../package.json), [plugin.json](../plugin.json), and [agents.md](../agents.md). Check package scripts, local dependency paths, build helpers, and TypeScript configuration before installing dependencies.
3. Provide the matching shared platform packages and parent build configuration used by this source. Some app repositories reference local `@purescience/platform-*` packages or suite helpers; cloning this repository does not supply those packages. Use a compatible development checkout or ask [info@puredesktop.ai](mailto:info@puredesktop.ai) about developer access. Do not replace workspace packages blindly with similarly named npm packages.
4. Install dependencies using the package manager and lockfile for that configured environment. For purecut, run `npm --prefix "$PWD" install` from its app directory when it sits inside a parent npm workspace. Keep required postinstall patches enabled.
5. Open the app project directory in your coding tool, make a focused change, review the diff, and run the relevant checks below. Test desktop integration in a compatible host as well as any supported browser preview.

For a new independent app, starting in purefactory provides the scaffold matched to your desktop. The website's older scaffold commands are not a prerequisite for this workflow.

## Develop with Claude Code or Codex

Install and sign in to your chosen coding tool using its official instructions: [Claude Code quickstart](https://code.claude.com/docs/en/quickstart) or [Codex CLI](https://developers.openai.com/codex/cli/). Open the local project folder in the tool, or start its CLI from that folder:

```sh
cd /path/to/your/app
claude
```

Or, using Codex:

```sh
cd /path/to/your/app
codex
```

Give the coding agent the [app API documentation](https://puredesktop.ai/docs/apps/) and [downloadable developer guide](https://puredesktop.ai/skills/puredesktop-app-agent-guide.md), along with this repository's documentation. Use the checked-out project and installed desktop as the authority when older website instructions differ.

For example:

> Read README.md, docs/development.md, plugin.json, package.json, and agents.md. Add [describe the feature] to purecut. First identify the affected UI and domain logic. Preserve the app's existing bridge and document behavior, update relevant drawer tools and their documentation, then run the available checks. Explain how I can try the change in the desktop.

Review the diff and try the result yourself. Coding tools work on the app's source; they do not need their own runtime embedded in the finished app. The desktop supplies its shared agent services. `agents.md` describes the in-app agent contract; do not assume it replaces your coding tool's own project instructions.

## Create or extend an app with purefactory

1. Open **purefactory** (Factory) in [puredesktop](https://puredesktop.ai). Describe a new app and choose **Start building**. Follow the requirements, design, and build steps, reviewing the proposed work.
2. To add features to an existing app, select its available app-development project and describe the change. In a source development build, **Show the suite's own apps** exposes editable built-in projects. Packaged installations do not automatically expose every bundled app's source; use an editable project or the development checkout for those changes.
3. Use **Open app** to try the app and **Open folder** to locate its source. You can edit that same project with Claude Code, Codex, or your editor, then return to purefactory. Pause active development work before editing the same files externally.
4. Ask for one concrete feature, review the changes, and check the result. Where the app's drawer offers app-development integration, you can request a change there too. Say that you want to change the app itself, rather than its current document.

Generated app-development projects live in your workspace's `Apps/` folder. Keep their project metadata and manifest intact so purefactory can continue working on them.

## Check your changes

In the configured app directory, this repository provides these commands:

```sh
npm run typecheck
npm run check:dependencies
npm run test:purecut
npm run test:purecut:speech
npm run build
npm run puredesktop:check
```

Check the scripts and the [app guide](app-guide.md) for any test prerequisites. Run the relevant tests for your change and build before manifest validation. A successful browser preview or build does not establish that desktop features work: test opening, saving, closing and reopening, and the affected file, account, or drawer-agent workflow inside the desktop. For a new generated project, use that project's own scripts.

## Load and share your app

**During development:** use **Open app** for an existing purefactory project. In a compatible source development checkout, the host discovers app manifests and its runner starts development apps as needed. A Vite URL by itself is not an installed app, and arbitrary hosted-URL registration is not supported.

**To share or install a project:**

1. Finish or pause active app-development tasks and dev-agent work. Use **Share** on the purefactory project to create a `.pureapp` file.
2. In current builds, open **Settings → System → Install an app → Choose package…** and select the file. Older releases may expose **File → Install App…** instead.
3. The installer validates the package, extracts one project into the workspace's `Apps/` folder, and refreshes the app registry. Open it from the app browser or its purefactory project and test the installed result.
4. The installer rejects an already-existing project folder ID. Work on the existing local project for iterative development; do not assume installing the same package overwrites it. Give a fork a distinct app identity when it should coexist with the original.

A `.pureapp` is a project package with a required header, not an arbitrary ZIP renamed with another extension. Packaging omits `node_modules`; the app must still have usable dependency declarations. Include only the project material you intend to share, without credentials or unrelated private files.

## Share your work

We welcome pull requests, forks, and new apps from **developers and vibecoders alike**. Go to [puredesktop.ai](https://puredesktop.ai) and [create a developer account](https://puredesktop.ai/developers) to submit an app for review. Open-source and proprietary projects are welcome; paid-app support is coming soon. Follow the licenses of this source and its dependencies when distributing a fork. Contact [info@puredesktop.ai](mailto:info@puredesktop.ai) for developer access and marketplace information.

See [CONTRIBUTING.md](../CONTRIBUTING.md), [LICENSE](../LICENSE), and [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).
