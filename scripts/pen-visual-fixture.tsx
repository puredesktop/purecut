import { ColorStop, LinearGradientPaint } from '@diffusionstudio/reconciler';
import {
  Computed, Paint, PaintType, RenderSurface, Selected, Source, Tool, ToolType, VectorPath, ViewBox,
  entityWorldMat, getLinearGradientLine, getPathGeometry, getPathTransform, getViewMatrix, isPath, multiply2D, store, transformPoint, vertexCount,
} from '../packages/runtime/src';
import { getDocumentEditor, type EntityEdit } from '../apps/web/src/engine/editor';
import { beginGradientTool } from '../apps/web/src/engine/gradient-tool';
import { PathEditor, PenTool } from '../apps/web/src/engine/traits';
import { fixtureWorld } from './editor-visual-fixture';
import type { Entity } from 'koota';

/**
 * Reads the editor visual fixture back for the Pen check in
 * test-editor-visual.mjs, which drives the toolbar and the stage with the
 * mouse and keyboard like a person: where a document point is in the page,
 * what the editor wrote, and the path it made. Nothing here draws or edits
 * the path; only the gradient handles are staged (a gradient paint added and
 * its tool put up, as its picker would).
 */
const world = () => {
  if (!fixtureWorld) throw Error('Mount the editor visual fixture first');
  return fixtureWorld;
};

const edits: EntityEdit[] = [];
let unsubscribe: (() => void) | null = null;

/** Starts recording what the editor writes, from now. */
export function recordEdits(): void {
  unsubscribe?.();
  edits.length = 0;
  unsubscribe = getDocumentEditor(world()).onEdit((edit) => edits.push(edit));
}

/** The edits since `recordEdits`, as plain data. */
export function recordedEdits(): EntityEdit[] {
  return JSON.parse(JSON.stringify(edits));
}

/** A device-pixel point of the stage canvas, in the page. */
function toPage(point: { x: number; y: number }): { x: number; y: number } {
  const surface = world().get(RenderSurface)!;
  const canvas = surface.canvas as HTMLCanvasElement;
  const rect = canvas.getBoundingClientRect();
  return { x: rect.left + point.x / surface.resolution, y: rect.top + point.y / surface.resolution };
}

/** Where document point (x, y) is in the page. */
export function documentToPage(x: number, y: number): { x: number; y: number } {
  return toPage(transformPoint(getViewMatrix(world()), x, y));
}

function thePath(): Entity {
  const path = world().query(VectorPath).find((entity) => isPath(entity) && entity.get(Source)?.value !== undefined);
  if (!path) throw Error('No path on the stage');
  return path;
}

/** The path the pen made: its props as the traits hold them, and its vertices in the page. */
export function readPath() {
  const w = world();
  const path = thePath();
  const geometry = getPathGeometry(w, path)!;
  const { sx, sy, tx, ty } = getPathTransform(w, path);
  const mat = multiply2D(entityWorldMat(w, path), { a: sx, b: 0, c: 0, d: sy, e: tx, f: ty });
  const anchors = geometry.subpaths.flatMap(({ points, closed }) => {
    const count = vertexCount({ points, closed });
    // A vertex's anchor is the end of the segment before it (see `anchorIndices` in path-tool).
    return Array.from({ length: count }, (_, v) => toPage(transformPoint(mat, points[6 * v]!, points[6 * v + 1]!)));
  });
  const computed = store(w, Computed);
  return {
    source: path.get(Source)!.value,
    selected: path.has(Selected),
    closed: geometry.subpaths.every((subpath) => subpath.closed),
    vertices: anchors.length,
    anchors,
    width: computed.width[path.id()],
    height: computed.height[path.id()],
    viewBox: path.get(ViewBox) ?? null,
    tool: ToolType[w.get(Tool)!.value],
    editing: w.get(PathEditor)!.entity === path,
    penVertices: w.get(PenTool)!.vertices.length,
  };
}

export function readTool(): string {
  return ToolType[world().get(Tool)!.value];
}

/** Gives the background a linear gradient and puts its handles up, as opening its picker does. */
export function stageGradient() {
  const w = world();
  const editor = getDocumentEditor(w);
  const background = w.query(Source).find((entity) => entity.get(Source)?.value === 'visual-background')!;
  const [paint] = editor.insertElement(background, () => (
    <LinearGradientPaint>
      <ColorStop offset={0} color="#163f41" />
      <ColorStop offset={1} color="#e2a64e" />
    </LinearGradientPaint>
  ));
  if (!paint || paint.get(Paint)?.value !== PaintType.LINEAR_GRADIENT) throw Error('The gradient paint did not land');
  beginGradientTool(w, background, paint);
  return readGradient();
}

/** The staged gradient's line ends in the page, its props, and the tool that is up. */
export function readGradient() {
  const w = world();
  const background = w.query(Source).find((entity) => entity.get(Source)?.value === 'visual-background')!;
  const paint = w.query(Paint).find((entity) => entity.get(Paint)?.value === PaintType.LINEAR_GRADIENT)!;
  const computed = store(w, Computed);
  const line = getLinearGradientLine(w, paint, computed.width[background.id()]!, computed.height[background.id()]!);
  const mat = entityWorldMat(w, background);
  return {
    source: paint.get(Source)?.value,
    start: toPage(transformPoint(mat, line.start.x, line.start.y)),
    end: toPage(transformPoint(mat, line.end.x, line.end.y)),
    tool: ToolType[w.get(Tool)!.value],
  };
}
