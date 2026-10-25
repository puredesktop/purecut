/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createSignal } from "solid-js";
import { createEncoder } from "@diffusionstudio/encoder";

import { ElectronWritableFileHandle } from "@/lib/electron-file-writable";
import { createCapture } from "@/engine/capture";
import { version } from "../../package.json";

import type { Entity } from "koota";
import type { EncoderConfig, ExportResult } from "@diffusionstudio/encoder";
import type { Capture } from "@/engine/capture";
import type { Engine } from "@/engine";

/**
 * Unified scene render path, used by the UI export (`ExportProvider.exportScene`)
 * and the agent's export tool (`dapi/handlers/export`): the export progress
 * overlay, the engine stop/start lifecycle, the capture world the encode runs
 * against, progress reporting, and cancel wiring all live in {@link renderScene}.
 */

/** The encoder settings a render takes: the encoder's, less how it is driven. */
export type ExportConfig = Omit<
  EncoderConfig,
  "target" | "scene" | "onProgress" | "realizeScene" | "comment"
>;

export type RenderOverlayState = {
  /** No video track is encoded: video is off, or the container is audio-only. */
  audioOnly: boolean;
  progress: number;
  remaining?: { minutes: number; seconds: number };
};

const PROGRESS_LOG_STEP = 2;

const [overlay, setOverlay] = createSignal<RenderOverlayState | null>(null);
let cancelActive: (() => void) | undefined;

/** Reactive overlay state; `null` when no render is in flight. Read by `<ExportProgress>`. */
export const renderOverlay = overlay;

/** Cancel the render currently in flight, if any. Wired to the overlay's Cancel button. */
export function cancelRender() {
  cancelActive?.();
}

export type RenderSceneOptions = {
  /** Scene entity to encode. */
  scene: Entity;
  /** Where to write the output (a save-picker handle in the UI, a file path handle from the CLI). */
  target: NonNullable<EncoderConfig["target"]>;
  /** Encoder settings (resolution, codecs, format, ...). */
  config?: Partial<EncoderConfig>;
  /** The project's folder, so the encode compiles the sources as they are now. */
  dir?: string;
};

export async function renderScene(
  engine: Engine,
  { scene, target, config, dir }: RenderSceneOptions,
): Promise<ExportResult & { sourceHash?: string }> {
  if (overlay()) throw Error('An export is already running. Wait for it to finish or cancel it first.');
  const world = engine.world;

  const audioOnly = config?.video?.enabled === false || config?.format === "ogg";

  let cancelled = false;
  let aborting: Promise<void> | undefined;
  const cancelTarget = () => {
    cancelled = true;
    // finalize() waits for stream close, including the platform upload. Abort
    // the handle now rather than waiting for render() to return to its caller.
    if (target instanceof ElectronWritableFileHandle) {
      aborting = Promise.resolve(aborting).then(() => target.dispose()).catch(error => {
        console.warn("[export] Could not abort output", error);
      });
    }
  };
  cancelActive = cancelTarget;
  setOverlay({ audioOnly, progress: 0, remaining: undefined });

  let logged = -1;
  const logProgress = (percent: number) => {
    if (percent - logged < PROGRESS_LOG_STEP && percent < 100) return;
    logged = percent;
    console.info(`[export] ${percent}%`);
  };

  engine.stop();

  let capture: Capture | undefined;
  try {
    capture = await createCapture(world, scene, {
      dir,
      frameRate: config?.video?.fps,
      mode: audioOnly ? "offline-audio" : "offline-video",
    });
    if (cancelled) return { type: 'canceled' };

    const encoder = await createEncoder(capture.world, {
      ...config,
      target,
      comment: `Made with PureCut (Diffusion Studio engine v${version})`,
      onProgress(p) {
        const percent = Math.round((p.progress / p.total) * 100);
        logProgress(percent);
        setOverlay((prev) =>
          prev
            ? {
                ...prev,
                progress: percent,
                remaining: {
                  minutes: p.remaining.getUTCMinutes(),
                  seconds: p.remaining.getUTCSeconds(),
                },
              }
            : prev,
        );
      },
    });

    cancelActive = () => { encoder.cancel(); cancelTarget(); };
    if (cancelled) { encoder.cancel(); cancelTarget(); }
    const result = await encoder.render();
    // Success means publication won the race: a late Cancel cannot undo the
    // atomic commit. Earlier cancellation uses our flag, since the editor
    // transport carries failures as text and does not preserve error names.
    if (result.type !== 'success' && cancelled)
      return { type: 'canceled' };
    return { ...result, sourceHash: capture.sourceHash };
  } catch (error) {
    if (cancelled) return { type: 'canceled' };
    throw error;
  } finally {
    await aborting;
    cancelActive = undefined;
    setOverlay(null);
    try { capture?.dispose(); }
    finally { engine.start(); }
  }
}
