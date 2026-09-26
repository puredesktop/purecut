import * as Babel from "@babel/standalone";
import solid from "babel-preset-solid";
import {
  sourcePlugin,
  canonicalizeTagsPlugin,
  inspectPlugin,
} from "../editor-core/source";
export { applyEdits, stampProject } from "../editor-core/edit-core";
export function compile(source: string) {
  try {
    const result = Babel.transform(source, {
      filename: "index.tsx",
      parserOpts: { plugins: ["jsx"] },
      plugins: [
        function imports() {
          return {
            visitor: {
              ImportDeclaration(p: any) {
                if (
                  !["solid-js", "@diffusionstudio/jsx"].includes(
                    p.node.source.value,
                  )
                )
                  throw p.buildCodeFrameError(
                    "Only solid-js and @diffusionstudio/jsx imports are supported",
                  );
              },
              CallExpression(p: any) {
                if (p.node.callee.type === "Import")
                  throw p.buildCodeFrameError(
                    "Dynamic imports are not supported",
                  );
              },
            },
          };
        },
        [sourcePlugin, { file: "index.tsx" }],
        canonicalizeTagsPlugin,
        [inspectPlugin, { file: "index.tsx" }],
        "transform-modules-commonjs",
      ],
      presets: [
        [solid, { generate: "universal", moduleName: "@diffusionstudio/jsx" }],
        [
          "typescript",
          { onlyRemoveTypeImports: true, isTSX: true, allExtensions: true },
        ],
      ],
    });
    return { ok: true, code: result.code! };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}
