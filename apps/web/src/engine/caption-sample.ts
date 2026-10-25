/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Caption previews drawn by the runtime itself. A small world of its own
 * holds a scene the size of the project's and, for each preview, one
 * `<captions>` carrying the real caption's authored props and the preset
 * being tried. The preset's own decoder groups, places and styles it, and
 * the runtime's `renderText` lays it out (font metrics, leading between
 * lines, alignment, wrapping) and paints it (shadows, the intrinsic fill,
 * then the preset's paints and blends) — the same code playback runs — onto
 * the preview's canvas. Nothing here touches the project or its history.
 */

import {
  CaptionDecoderHandle, Computed, Offset, Position, RenderSurface, Size, TextCache, bindAsset, createRuntimeWorld, drawOnto,
  Library, resolveCaptionDecoder, store,
} from '@diffusionstudio/runtime';
import { createRuntimeDocument } from '@diffusionstudio/reconciler';

import type { Asset, AssetLibrary, Transcript } from '@diffusionstudio/assets';
import type { CaptionPreset } from '@diffusionstudio/jsx';
import type { RuntimeDocument } from '@diffusionstudio/reconciler';
import type { SceneNode } from '@diffusionstudio/runtime';

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** The authored props of a caption that shape how it looks; `src` and timing are not among them. */
export const CAPTION_LOOK_PROPS = [
  'fontSize', 'fontFamily', 'fontWeight', 'fontStyle', 'textAlign', 'textBaseline', 'textCase', 'letterSpacing',
  'leading', 'fill', 'x', 'y', 'offsetX', 'offsetY', 'verticalAlign',
] as const;

export type CaptionSampleRequest = {
  /** The project's scene size, in scene pixels. */
  scene: { width: number; height: number };
  /** Scene pixels to canvas pixels. */
  scale: number;
  /** The real caption's authored props; only the look props are read. */
  props: Record<string, unknown>;
  preset: CaptionPreset;
  /** Slot colors as hex, or false for the preset's own. */
  colors: string[] | false;
  /** What the caption says: its transcript, so groups and highlights follow playback. */
  transcript: Transcript;
  /** Transcript seconds to show. */
  seconds: number;
};

export type CaptionSample = {
  /** Scene-pixel bounds of the glyphs drawn, or null when nothing shows at that moment. */
  block: { x: number; y: number; width: number; height: number } | null;
};

export class CaptionSampler {
  private readonly world = createRuntimeWorld(`caption-sample-${crypto.randomUUID()}`);
  private readonly document: RuntimeDocument;
  private readonly scene: SceneNode;
  private readonly assets = new Map<string, Asset>();
  private queue: Promise<unknown> = Promise.resolve();
  private next = 0;
  private disposed = false;

  public constructor() {
    // The decoders read their transcript through the library; this one only
    // ever holds the transcript being previewed.
    this.world.set(Library, { get: (id: string) => this.assets.get(id) } as unknown as AssetLibrary);
    this.document = createRuntimeDocument(this.world);
    this.scene = this.document.createElement('Scene');
    this.document.insertNode(this.document.stage, this.scene);
  }

  /**
   * Draws one caption onto `ctx`, over what it already holds. Draws run one
   * at a time: the world has one caption on stage at once.
   */
  public draw(ctx: Ctx2D, request: CaptionSampleRequest): Promise<CaptionSample> {
    const run = this.queue.then(() => this.disposed ? { block: null } : this.drawNow(ctx, request));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async drawNow(ctx: Ctx2D, request: CaptionSampleRequest): Promise<CaptionSample> {
    const { world, document } = this;
    const computed = store(world, Computed);
    document.setProperty(this.scene, 'width', request.scene.width);
    document.setProperty(this.scene, 'height', request.scene.height);
    // Placement reads the parent's computed box, which a transform pass
    // would write; this world never runs one.
    computed.width[this.scene.entity.id()] = request.scene.width;
    computed.height[this.scene.entity.id()] = request.scene.height;

    const caption = document.createElement('Captions');
    for (const prop of CAPTION_LOOK_PROPS) {
      const value = request.props[prop];
      if (value !== undefined) document.setProperty(caption, prop, value);
    }
    document.setProperty(caption, 'preset', request.preset);
    document.setProperty(caption, 'colors', request.colors);
    document.insertNode(this.scene, caption);

    const asset = { id: `sample-${this.next++}`, type: 'VIDEO', transcript: request.transcript } as unknown as Asset;
    this.assets.set(asset.id, asset);
    const entity = caption.entity;
    try {
      bindAsset(entity, asset);
      const decoder = resolveCaptionDecoder(world, entity);
      if (!decoder) return { block: null };
      await decoder.initPromise;
      if (this.disposed) return { block: null };
      if (!decoder.styled) decoder.styled = decoder.applyStyles(world, entity);

      // Played up to the moment, as playback reaches it: a preset that
      // changes its look per line (Guinea's colors) is where playback has it.
      const starts = request.transcript.flatMap(cue => cue.words.map(word => word.start))
        .filter(start => start < request.seconds).sort((a, b) => a - b);
      for (const start of starts) decoder.seekTo(world, entity, start);
      decoder.seekTo(world, entity, request.seconds);

      const id = entity.id();
      const size = entity.get(Size);
      computed.width[id] = size?.width ?? 0;
      computed.height[id] = size?.height ?? 0;
      // Where the transform pass puts it: its placed position plus any
      // authored offset (systems/transform.ts adds the two).
      const placed = entity.get(Position) ?? { x: 0, y: 0 };
      const offset = entity.has(Offset) ? entity.get(Offset)! : { x: 0, y: 0 };
      const position = { x: placed.x + offset.x, y: placed.y + offset.y };

      ctx.save();
      ctx.scale(request.scale, request.scale);
      ctx.translate(position.x, position.y);
      // Shadows are sized in device pixels: the resolution scales them as
      // it does on the canvas.
      world.set(RenderSurface, { resolution: request.scale });
      try {
        drawOnto(ctx, () => decoder.draw(world, entity));
      } finally {
        ctx.restore();
      }

      const tokens = (store(world, TextCache).tokens[id] ?? []).flat().filter(token => token.chars.trim());
      if (!tokens.length) return { block: null };
      const left = Math.min(...tokens.map(token => token.left));
      const right = Math.max(...tokens.map(token => token.right));
      const top = Math.min(...tokens.map(token => token.top));
      const bottom = Math.max(...tokens.map(token => token.bottom));
      return { block: { x: position.x + left, y: position.y + top, width: right - left, height: bottom - top } };
    } finally {
      entity.get(CaptionDecoderHandle)?.dispose();
      document.removeNode(this.scene, caption);
      this.assets.delete(asset.id);
    }
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // An in-flight decoder may still be awaiting initialization. Let its
    // finally block release the caption before destroying the world it uses.
    void this.queue.then(() => {
      this.document.dispose();
      this.world.destroy();
    });
  }
}
