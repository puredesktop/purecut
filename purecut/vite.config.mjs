import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import svg from "vite-plugin-solid-svg";
import tailwindcss from "@tailwindcss/vite";
import typegpu from "unplugin-typegpu/vite";
import { fileURLToPath } from "node:url";
import { readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";

const manifest = JSON.parse(
  readFileSync(new URL("../plugin.json", import.meta.url), "utf8"),
);
const at = (p) => fileURLToPath(new URL(p, import.meta.url));
export default defineConfig({
  root: at("../"),
  base: "./",
  plugins: [
    {
      name: "purecut-entry",
      configureServer(s) {
        s.middlewares.use((req, _res, next) => {
          if (req.url === "/") req.url = "/index.html";
          next();
        });
      },
    },
    solid(),
    svg({ defaultAsComponent: true }),
    tailwindcss(),
    typegpu(),
  ],
  define: {
    APP_VERSION: JSON.stringify("0.1.0"),
    "import.meta.env.VITE_PURECUT": "true",
    "import.meta.env.VITE_PURECUT_COMPILER_HASH": JSON.stringify(createHash('sha256').update(readFileSync(new URL('./compiler-runtime.js', import.meta.url))).digest('hex')),
  },
  resolve: {
    alias: {
      "@": at("../apps/web/src"),
      "@editor-core": at("./editor-core"),
    },
  },
  server: {
    host: "127.0.0.1",
    port: Number(new URL(manifest.entrypoint.url).port),
    strictPort: true,
    fs: { allow: [at("../../../"), realpathSync(at("../node_modules"))] },
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "credentialless",
    },
  },
  build: {
    outDir: "dist",
    rollupOptions: { input: at("../index.html") },
  },
});
