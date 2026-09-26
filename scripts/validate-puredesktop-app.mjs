import { readFile, access } from "node:fs/promises";
import { build } from "esbuild";
import { tmpdir } from "node:os";
import { join } from "node:path";
const manifest = JSON.parse(await readFile("plugin.json", "utf8"));
const pkg = JSON.parse(await readFile("package.json", "utf8"));
for (const key of ["dev", "build", "typecheck", "puredesktop:check"])
  if (!pkg.scripts[key]) throw Error("Missing script " + key);
if (manifest.id !== manifest.app.slug) throw Error("App identity mismatch");
if (
  !manifest.permissions.includes("filesystem") ||
  !manifest.permissions.includes("agents")
)
  throw Error("Missing bridge permissions");
await access("dist/index.html");
const output = join(
  tmpdir(),
  "purecut-manifest-schema-" + process.pid + ".mjs",
);
await build({
  stdin: {
    contents: `import {AppManifestSchema} from '../../packages/shell/src/modules/apps/app/manifest.ts'; export default AppManifestSchema;`,
    resolveDir: process.cwd(),
    loader: "ts",
  },
  outfile: output,
  bundle: true,
  nodePaths: [join(process.cwd(), "node_modules")],
  platform: "node",
  format: "esm",
  external: ["electron"],
  logLevel: "silent",
});
try {
  const { default: schema } = await import(output);
  schema.parse(manifest);
} finally {
  await (await import("node:fs/promises")).rm(output, { force: true });
}
const expected = ["getCutContext", "proposeCutEdits", "proposeCutSource", "replaceCutSource", "checkCut", "exportCut", "openCutTranscript", "getCutTranscript", "proposeCutSpeechEdit", "proposeCutSpeechCleanup", "proposeCutCaptions"];
if (
  JSON.stringify(manifest.app.agents.tools.map((t) => t.name)) !==
  JSON.stringify(expected)
)
  throw Error("Drawer tool declarations differ");
const drawer = await readFile("purecut/drawer.ts", "utf8");
const registration = drawer.match(/tools:\s*(\[[^\]]*\])/);
if (!registration || JSON.stringify(JSON.parse(registration[1]).sort()) !== JSON.stringify([...expected].sort()))
  throw Error("Runtime drawer registration differs from manifest");
const guide = await readFile("agents.md", "utf8");
for (const name of expected) if (!guide.includes(name)) throw Error("Agent guide is missing " + name);
console.log(
  "PASS: current ps-suite manifest schema, identity, permissions, standard scripts and dist/index.html",
);
