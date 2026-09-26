# purecut technical reference

[Back to the README](../README.md) · [Development guide](development.md)

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
See [PURECUT.md](../PURECUT.md) for architecture, evidence and remaining product
qualification work.

## Upstream and licence

MPL-2.0 notices are retained; upstream authors and licenses are acknowledged below. The original README is
[README.upstream.md](../README.upstream.md). Upstream desktop release workflows
are removed; distribution uses the [puredesktop](https://puredesktop.ai) app build.
