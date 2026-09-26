import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url));
process.chdir(root);
await import("./check-runtime.mjs");
await import("./build-compiler.mjs");
await build({absWorkingDir:root,entryPoints:["purecut/integration.ts"],outfile:"purecut/integration-runtime.js",bundle:false,format:"esm",platform:"browser"});
const require = createRequire(import.meta.url);
await build({
  absWorkingDir: root,
  entryPoints: ["purecut/frame.tsx"],
  outfile: "purecut/frame-runtime.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  jsx: "automatic",
  jsxImportSource: "react",
  alias: {
    react: dirname(require.resolve("react/package.json")),
    "react-dom": dirname(require.resolve("react-dom/package.json")),
  },
  nodePaths: [root + "node_modules"],
  define: { "process.env.NODE_ENV": process.argv.includes("--build") ? '"production"' : '"development"' },
  external: ["./integration-runtime.js"],
  plugins: [
    {
      name: "raw-svg",
      setup(b) {
        b.onResolve({ filter: /\.svg\?raw$/ }, (a) => ({
          path: require.resolve(a.path.replace("?raw", "")),
          namespace: "raw-svg",
        }));
        b.onLoad({ filter: /.*/, namespace: "raw-svg" }, async (a) => ({
          contents: await readFile(a.path, "utf8"),
          loader: "text",
        }));
      },
    },
  ],
});
if (process.argv.includes("--prepare")) process.exit(0);
const args = process.argv.slice(2);
const building = args.includes("--build");
const child = spawn(
  process.execPath,
  [
    "node_modules/vite/bin/vite.js",
    ...(building ? ["build"] : []),
    "--config",
    "purecut/vite.config.mjs",
    ...args.filter((a) => a !== "--build"),
  ],
  { stdio: "inherit", cwd: root },
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill(signal));
child.on("exit", (code) => process.exit(code ?? 0));
