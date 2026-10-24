/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createContext, useContext, onCleanup, onMount } from "solid-js";
import { toast } from "somoto";
import { canEncodeVideo } from "mediabunny";
import { useWorld } from "@diffusionstudio/koota-solid";
import { asExportError, computeOutputSize, type ExportStage } from "@diffusionstudio/encoder";
import { Computed, FrameRate, getActiveEntity } from "@diffusionstudio/runtime";
import { assert, downloadObject } from "@/utils";
import { ownsKeyboardEvent } from '@/engine/input/keyboard-target';
import { useEngineContext } from "@/engine";
import { useProject } from "@/context/project";
import { ElectronWritableFileHandle } from "@/lib/electron-file-writable";
import { track } from "@/lib/analytics";
import { RenderProgress } from "@/components/sidebar-right/inspector/export-progress";
import { renderScene, renderOverlay, type ExportConfig } from "@/context/render";
import { recordSuccessfulExport } from '@/lib/export-history';
import {
  MIME_TYPES,
  getDefaultExportTemplate,
} from "@/components/sidebar-right/inspector/export-templates";

import type { Entity } from "koota";
import type { JSX, Accessor } from "solid-js";

type ExportContextValue = {
  exportScene: (scene: Entity, config: ExportConfig) => Promise<void>;
  exportCurrentFrame: () => Promise<void>;
  exporting: Accessor<boolean>;
};

const ExportContext = createContext<ExportContextValue>();

export function ExportProvider(props: { children: JSX.Element }) {
  const engine = useEngineContext();
  const world = useWorld();
  const project = useProject();

  const exporting = () => !!renderOverlay();

  const sceneDurationSeconds = (scene: Entity) =>
    (scene.get(Computed)?.duration ?? 0) / (world.get(FrameRate)?.value || 30);

  const failureToast = "export-failure";

  const nextStep: Record<ExportStage, string> = {
    render: "Try the export again. If it keeps failing, check the scene for unsupported content.",
    decode: "Check that the source media is available and playable, then retry.",
    encode: "Try a lower resolution or another codec, then retry.",
    write: "Check that the destination folder is available and has free space, then retry.",
  };

  const showBusy = () => {
    toast.error("Export already running", {
      description: "Wait for it to finish or cancel it before starting another export.",
    });
  };

  const showFailure = (reason: unknown, attempt: { scene: Entity; config: ExportConfig }) => {
    const error = asExportError("render", reason);
    console.error("Export failed:", error);
    toast.dismiss(failureToast);
    toast.error("Export failed", {
      id: failureToast,
      description: `${nextStep[error.stage]} Details: ${error.message}`,
      duration: Infinity,
      closeButton: true,
      action: {
        label: "Retry export",
        onClick: () => void exportScene(attempt.scene, attempt.config),
      },
    });
    return error;
  };

  const exportScene: ExportContextValue["exportScene"] = async (scene, config) => {
    if (!scene?.isAlive()) {
      toast.error("Scene no longer available", {
        description: "The scene for this export has been deleted, so it cannot be retried.",
      });
      return;
    }
    if (renderOverlay()) {
      showBusy();
      return;
    }
    toast.dismiss(failureToast);

    const format = config.format ?? "mp4";
    const mimeType = MIME_TYPES[format];

    // Fail before the save picker: an unencodable configuration is known
    // right away, and the encoder would only find out after a file was
    // picked and the render machinery spun up.
    const videoEnabled = format !== "ogg" && config.video?.enabled !== false;
    if (videoEnabled) {
      const computed = scene.get(Computed);
      const codec = config.video?.codec ?? "avc";
      const { width, height } = computeOutputSize(
        computed?.width || 1920,
        computed?.height || 1080,
        config.video?.resolution ?? 1080,
      );
      const encodable = await canEncodeVideo(codec, {
        width,
        height,
        bitrate: config.video?.bitrate ?? 10e6,
      });
      if (!encodable) {
        toast.error("Export not supported", {
          description:
            `This browser cannot encode ${codec.toUpperCase()} at ${width}×${height}. ` +
            "Choose a lower resolution, a lower bitrate, or another codec.",
        });
        return;
      }
    }

    const name = project.name().replace(/\s+/g, "-").toLowerCase();

    let target: FileSystemFileHandle;
    try {
      target = import.meta.env.VITE_PURECUT ? new ElectronWritableFileHandle(`${project.dir()}/renders/${name}-${Date.now()}.${format}`) as unknown as FileSystemFileHandle : await window.showSaveFilePicker({
        suggestedName: `${name}.${format}`,
        types: [
          {
            description: format,
            accept: {
              [mimeType]: [`.${format}`],
            } as Record<`${string}/${string}`, `.${string}`[]>,
          },
        ],
      });
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      toast.error("Failed to start export", {
        description: (e as Error).message,
      });
      return;
    }

    const attempt = { scene, config: structuredClone(config) };
    const disposePartial = async () => {
      if (target instanceof ElectronWritableFileHandle) await target.dispose().catch(() => {});
    };
    track('export_started', {
      format,
      resolution: attempt.config.video?.resolution,
      fps: attempt.config.video?.fps,
      video_codec: attempt.config.video?.codec,
      audio_codec: attempt.config.audio?.codec,
      scene_duration_s: Math.round(sceneDurationSeconds(scene)),
    });
    const startedAt = performance.now();
    const exportProjectId = project.id();
    const exportDir = project.dir();

    try {
      if (import.meta.env.VITE_PURECUT) {
        const { flushPendingProjectEdits } = await import('@/projects/edits');
        await flushPendingProjectEdits();
      }
      const result = await renderScene(engine, { scene, target, config: attempt.config, dir: exportDir });

      if (result.type === "error") {
        await disposePartial();
        const error = showFailure(result.error, attempt);
        track('export_failed', {
          format,
          stage: error.stage,
          duration_ms: Math.round(performance.now() - startedAt),
          error: error.message.slice(0, 200) || 'unknown',
        });
      } else if (result.type === "canceled") {
        await disposePartial();
      } else {
        if (import.meta.env.VITE_PURECUT && target instanceof ElectronWritableFileHandle) {
          try {
            await recordSuccessfulExport({ projectId: exportProjectId, projectDir: exportDir,
              path: target.path, sourceHash: result.sourceHash, config: attempt.config });
          } catch (error) {
            toast.error('Video saved, but export history could not be updated', {
              description: (error as Error).message,
            });
          }
        }
        toast.dismiss(failureToast);
        toast("Export complete", {
          description: "Your video has been successfully exported",
        });
        track('export_completed', {
          format,
          resolution: attempt.config.video?.resolution,
          fps: attempt.config.video?.fps,
          scene_duration_s: Math.round(sceneDurationSeconds(scene)),
          duration_ms: Math.round(performance.now() - startedAt),
        });
      }
    } catch (e) {
      await disposePartial();
      if (e instanceof Error && e.message.includes("An export is already running")) {
        showBusy();
        return;
      }
      const error = showFailure(e, attempt);
      track('export_failed', {
        format,
        stage: error.stage,
        duration_ms: Math.round(performance.now() - startedAt),
        error: error.message.slice(0, 200) || 'unknown',
      });
    }
  };

  const exportCurrentFrame: ExportContextValue["exportCurrentFrame"] = async () => {
    const blob = await engine.snapshot();

    if (!blob) {
      toast.error("Failed to capture frame");
      return;
    }

    const projectName = project.name().replace(/\s+/g, "-").toLowerCase();
    await downloadObject(blob, `${projectName}-frame.png`);
  };

  const exportActiveScene = () => {
    const scene = getActiveEntity(world);
    if (scene === null) {
      return toast("No active scene to export");
    }
    void exportScene(scene, getDefaultExportTemplate());
  };

  /**
   * Export is the provider's command, so its keys are bound here rather than
   * in the engine's shortcut table: ⌘E writes the active scene, ⇧⌘E the frame
   * on screen — the same two the File menu lists.
   */
  const handleShortcut = (event: KeyboardEvent) => {
    if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "e") return;
    if (ownsKeyboardEvent(event) || event.altKey) return;
    // PureCut's command bar owns Cmd/Ctrl+E and opens settings, not a render.
    if (import.meta.env.VITE_PURECUT && !event.shiftKey) return;

    event.preventDefault();
    if (event.shiftKey) void exportCurrentFrame();
    else exportActiveScene();
  };

  onMount(() => document.addEventListener("keydown", handleShortcut));
  onCleanup(() => document.removeEventListener("keydown", handleShortcut));

  return (
    <ExportContext.Provider value={{ exportScene, exportCurrentFrame, exporting }}>
      {props.children}
      <RenderProgress />
    </ExportContext.Provider>
  );
}

export function useExport() {
  const ctx = useContext(ExportContext);
  assert(ctx, "useExport must be used within ExportProvider");
  return ctx;
}
