import { AssetLibrary, type ProjectFS } from '@diffusionstudio/assets';
import { createRuntimeWorld, Library } from '../packages/runtime/src';
import { createRuntimeDocument } from '../packages/reconciler/src';
import { rememberProjectBundle, forgetProjectBundle } from '../apps/web/src/lib/db';
import { renderScene } from '../apps/web/src/context/render';
import type { Engine } from '../apps/web/src/engine';

type Pixel = [r: number, g: number, b: number];

/**
 * The shapes and line styles from upstream diffusionstudio/editor (eaacc15,
 * d519017, acb7092 and the `<path>` primitive) drawn through PureCut's own
 * export, read back from the decoded frame: an ellipse's corners stay empty,
 * a five-cornered polygon is filled at its middle and not at the box's
 * corner, a dashed stroke on a path breaks into dashes, and an angular
 * gradient changes colour around its centre at one radius. Returns the frame
 * as a PNG data URL, to look at.
 */
export async function checkShapes(): Promise<{ frame: string; dashes: number }> {
  const id = 'shapes-check';
  const files = new Map<string, File>();
  const fs: ProjectFS = {
    readManifest: async () => null, writeManifest: async () => {}, list: async () => [],
    stat: async path => { const file = files.get(path); return file ? { size: file.size, mtime: file.lastModified } : null; },
    file: async path => { const file = files.get(path); if (!file) throw Error('Missing fixture'); return file; },
    write: async (path, blob) => { files.set(path, new File([blob], path.split('/').pop()!)); },
    remove: async path => { files.delete(path); },
  };
  const library = new AssetLibrary(fs);
  const world = createRuntimeWorld(id); world.set(Library, library);
  const document = createRuntimeDocument(world);
  const element = (parent: ReturnType<typeof document.createElement> | typeof document.stage, type: string, props: Record<string, unknown>) => {
    const node = document.createElement(type);
    for (const [name, value] of Object.entries(props)) document.setProperty(node, name, value);
    document.insertNode(parent, node);
    return node;
  };
  try {
    const scene = element(document.stage, 'Scene', { __source: 'shapes-scene', width: 640, height: 360 });
    element(scene, 'Rect', { width: 640, height: 360, end: 1, fill: '#000000' });
    element(scene, 'Ellipse', { x: 20, y: 20, width: 180, height: 120, end: 1, fill: '#ffffff' });
    element(scene, 'Polygon', { x: 230, y: 20, width: 160, height: 160, pointCount: 5, end: 1, fill: '#ff0000' });
    const path = element(scene, 'Path', { x: 20, y: 220, width: 380, height: 100, d: 'M0 50 L380 50', end: 1 });
    element(path, 'Stroke', { color: '#00ff00', width: 12, dash: 20, dashGap: 20 });
    const angular = element(scene, 'Rect', { x: 440, y: 40, width: 180, height: 180, end: 1 });
    const sweep = element(angular, 'AngularGradientPaint', {});
    element(sweep, 'ColorStop', { offset: 0, color: '#ff0000' });
    element(sweep, 'ColorStop', { offset: 1, color: '#0000ff' });
    await rememberProjectBundle(id, `
      const { Stage, Scene, Rect, Ellipse, Polygon, Path, Stroke, AngularGradientPaint, ColorStop } = require('@diffusionstudio/jsx');
      module.exports.default = () => Stage({ get children() {
        return Scene({ __source: 'shapes-scene', width: 640, height: 360, get children() {
          return [
            Rect({ width: 640, height: 360, end: 1, fill: '#000000' }),
            Ellipse({ x: 20, y: 20, width: 180, height: 120, end: 1, fill: '#ffffff' }),
            Polygon({ x: 230, y: 20, width: 160, height: 160, pointCount: 5, end: 1, fill: '#ff0000' }),
            Path({ x: 20, y: 220, width: 380, height: 100, d: 'M0 50 L380 50', end: 1, get children() {
              return Stroke({ color: '#00ff00', width: 12, dash: 20, dashGap: 20 });
            } }),
            Rect({ x: 440, y: 40, width: 180, height: 180, end: 1, get children() {
              return AngularGradientPaint({ get children() {
                return [ColorStop({ offset: 0, color: '#ff0000' }), ColorStop({ offset: 1, color: '#0000ff' })];
              } });
            } }),
          ];
        }});
      }});
    `);
    const chunks: { position: number; data: Uint8Array }[] = [];
    const result = await renderScene({ world, stop() {}, start() {} } as unknown as Engine, {
      scene: scene.entity,
      target: { createWritable: async () => new WritableStream({ write(chunk: { position: number; data: Uint8Array }) {
        chunks.push({ position: chunk.position, data: chunk.data.slice() });
      } }) },
      config: { format: 'webm', video: { codec: 'vp8', resolution: 360, fps: 30, bitrate: 6_000_000 }, audio: { enabled: false } },
    });
    if (result.type !== 'success') throw Error(`Shapes render failed: ${JSON.stringify(result)}`);
    const bytes = new Uint8Array(Math.max(...chunks.map(chunk => chunk.position + chunk.data.length)));
    for (const chunk of chunks) bytes.set(chunk.data, chunk.position);
    const url = URL.createObjectURL(new Blob([bytes], { type: 'video/webm' }));
    const video = globalThis.document.createElement('video'); video.muted = true;
    globalThis.document.body.append(video);
    const canvas = globalThis.document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
    const context = canvas.getContext('2d', { willReadFrequently: true })!;
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('Shapes playback timed out')), 10000);
        video.onerror = () => { clearTimeout(timer); reject(Error(`Shapes decode failed: ${video.error?.message}`)); };
        video.onloadeddata = () => { video.currentTime = 0.4; };
        video.onseeked = () => { clearTimeout(timer); context.drawImage(video, 0, 0); resolve(); };
        video.src = url; video.load();
      });
    } finally { video.removeAttribute('src'); video.load(); video.remove(); URL.revokeObjectURL(url); }

    const at = (x: number, y: number): Pixel => {
      const [r, g, b] = context.getImageData(x, y, 1, 1).data;
      return [r!, g!, b!];
    };
    const dark = ([r, g, b]: Pixel) => r < 60 && g < 60 && b < 60;
    const fail = (what: string, pixel: Pixel) => { throw Error(`${what}: got rgb(${pixel.join(', ')})`); };

    // The ellipse: filled white at its centre, nothing in its box's corner.
    const ellipseCentre = at(110, 80);
    if (ellipseCentre.some(v => v < 200)) fail('Ellipse centre must be white', ellipseCentre);
    if (!dark(at(26, 26))) fail("An ellipse's box corner must stay empty", at(26, 26));
    // The polygon: red in the middle, empty at the box's bottom-left corner (a pentagon's corners do not reach it).
    const polygonCentre = at(310, 110);
    if (!(polygonCentre[0] > 180 && polygonCentre[1] < 80)) fail('Polygon centre must be red', polygonCentre);
    if (!dark(at(234, 176))) fail("A pentagon's box corner must stay empty", at(234, 176));
    // The dashed stroke: green and gaps alternating along the line, about every 20 px.
    let dashes = 0, inDash = false;
    for (let x = 22; x < 398; x++) {
      const [r, g, b] = at(x, 270);
      const green = g > 150 && r < 100 && b < 100;
      if (green && !inDash) dashes++;
      inDash = green;
    }
    if (dashes < 7 || dashes > 11) throw Error(`A 20/20 dash over 380 px must draw about 10 dashes, got ${dashes}`);
    // The angular gradient: one radius round the centre, red where the sweep starts (to the right), blue near its end (above).
    const start = at(530 + 60, 130 + 4), end = at(530, 130 - 60);
    if (!(start[0] > start[2] + 60)) fail('Angular gradient must start red to the right of its centre', start);
    if (!(end[2] > end[0] + 60)) fail('Angular gradient must turn to blue above its centre', end);
    return { frame: canvas.toDataURL('image/png'), dashes };
  } finally { await forgetProjectBundle(id); document.dispose(); world.destroy(); await library.dispose(); }
}
