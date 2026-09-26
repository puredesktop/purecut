import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
await build({
  absWorkingDir: fileURLToPath(new URL("../", import.meta.url)),
  entryPoints: ["purecut/lib/compiler.ts"],
  outfile: "purecut/compiler-runtime.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  define: { "process.env.NODE_ENV": '"production"', "process.env": "{}" },
  plugins: [
    {
      name: "in-memory-compiler",
      setup(b) {
        b.onResolve({ filter: /^(node:.*|fs|os|path|tinyglobby)$/ }, (a) => ({
          path:
            a.path === "path" || a.path === "node:path"
              ? require.resolve("path-browserify")
              : require.resolve("../purecut/lib/node-unavailable.cjs"),
        }));
      },
    },
  ],
});
