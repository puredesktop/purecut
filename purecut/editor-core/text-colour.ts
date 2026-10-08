/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// PureCut: a text's colour is the colour you see, over source. The live rule
// is `textColourTarget` (apps/web/src/engine/text-colour.ts), which applying a
// proposeCutEdits proposal uses; this is the same rule for the review of that
// proposal, so the diff the user approves is what apply writes. Keep the two
// in step.

import { Project, SyntaxKind } from "ts-morph";
import { ID_ATTR, formatSource, parseSource } from "@diffusionstudio/jsx";

import type { JsxOpeningElement, JsxSelfClosingElement, Node, SourceFile } from "ts-morph";
import type { SourceSet } from "./edit-types";

type JsxTag = JsxOpeningElement | JsxSelfClosingElement;

/** Every JSX element in document order — the numbering `./source` uses. */
function tags(sourceFile: SourceFile): JsxTag[] {
  const found: JsxTag[] = [];
  sourceFile.forEachDescendant((node: Node) => {
    if (node.isKind(SyntaxKind.JsxSelfClosingElement)) found.push(node);
    else if (node.isKind(SyntaxKind.JsxElement)) found.push(node.getOpeningElement());
  });
  return found;
}

const tagName = (tag: JsxTag): string => tag.getTagNameNode().getText();
const lower = (name: string): string => name.charAt(0).toLowerCase() + name.slice(1);

function idOf(tag: JsxTag): string | undefined {
  return tag
    .getAttribute(ID_ATTR)
    ?.asKind(SyntaxKind.JsxAttribute)
    ?.getInitializer()
    ?.asKind(SyntaxKind.StringLiteral)
    ?.getLiteralValue();
}

const hasAttribute = (tag: JsxTag, name: string): boolean => tag.getAttribute(name) !== undefined;

/** `hidden` or `hidden={true}`: anything else draws. */
function isHidden(tag: JsxTag): boolean {
  const attribute = tag.getAttribute("hidden")?.asKind(SyntaxKind.JsxAttribute);
  if (!attribute) return false;
  const initializer = attribute.getInitializer();
  if (!initializer) return true;
  return initializer.asKind(SyntaxKind.JsxExpression)?.getExpression()?.getKind() === SyntaxKind.TrueKeyword;
}

/**
 * Where a text's visible colour is written: the topmost (last) visible
 * `<solidPaint>` among its child elements, as `color`; without one, the text
 * itself, as the intrinsic prop it already spells (`color` when only that is
 * written, `fill` otherwise).
 */
function colourTarget(text: JsxTag): { tag: JsxTag; name: "color" | "fill" } {
  const element = text.getParentIfKind(SyntaxKind.JsxElement);
  const solids = (element?.getJsxChildren() ?? []).flatMap((child) => {
    const tag = child.isKind(SyntaxKind.JsxSelfClosingElement)
      ? child
      : child.isKind(SyntaxKind.JsxElement)
        ? child.getOpeningElement()
        : undefined;
    return tag && lower(tagName(tag)) === "solidPaint" && !isHidden(tag) ? [tag] : [];
  });
  const top = solids.at(-1);
  if (top) return { tag: top, name: "color" };
  const name = !hasAttribute(text, "fill") && hasAttribute(text, "color") ? "color" : "fill";
  return { tag: text, name };
}

/**
 * Rewrites the `fill` of every edit that targets a `<text>` or `<rect>` onto where that
 * text's visible colour lives (see `colourTarget`): a set on its topmost
 * visible solid paint child, or the text's own intrinsic prop. Edits to
 * anything else, and edits without `fill`, pass through unchanged.
 */
export async function retargetTextColours(
  io: { read(file: string): Promise<string> },
  edits: SourceSet[],
): Promise<SourceSet[]> {
  if (!edits.some((edit) => edit.props.fill !== undefined)) return edits;

  const project = new Project({ useInMemoryFileSystem: true, skipLoadingLibFiles: true });
  const files = new Map<string, SourceFile>();
  const out: SourceSet[] = [];

  for (const edit of edits) {
    const address = parseSource(edit.source);
    const { fill, ...rest } = edit.props;
    if (fill === undefined || !address) {
      out.push(edit);
      continue;
    }

    let sourceFile = files.get(address.file);
    if (!sourceFile) {
      sourceFile = project.createSourceFile(address.file, await io.read(address.file), { overwrite: true });
      files.set(address.file, sourceFile);
    }

    const all = tags(sourceFile);
    const matches =
      typeof address.locator === "number"
        ? all.slice(address.locator, address.locator + 1)
        : all.filter((tag) => idOf(tag) === address.locator);
    // A text, or a plain <rect>: `fill` on either is the colour it is seen in
    // (hasSeenColour in apps/web/src/engine/text-colour.ts).
    const text = matches.length === 1 && ["text", "rect"].includes(lower(tagName(matches[0]!))) ? matches[0]! : undefined;
    if (!text) {
      out.push(edit);
      continue;
    }

    const target = colourTarget(text);
    if (target.tag === text) {
      // The intrinsic: the same element, under the name it already has.
      out.push({ ...edit, props: { ...rest, [target.name]: fill } });
      continue;
    }

    if (Object.keys(rest).length || edit.text !== undefined) out.push({ ...edit, props: rest });
    const id = idOf(target.tag);
    out.push({
      kind: "set",
      source: formatSource(address.file, id ?? all.indexOf(target.tag)),
      props: { color: fill },
    });
  }

  return out;
}
