/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createEffect, createMemo, createResource, createSignal, For, on, onCleanup, Show } from "solid-js";
import { useTrait, useWorld } from "@diffusionstudio/koota-solid";
import {
  AssetId, Caption, Color, Computed, FrameRate, TextStyle, colorToHex, getActiveEntity, getAsset, getWebFonts, loadWebFont,
  resolveTranscript, store,
} from "@diffusionstudio/runtime";
import { authoredElement } from "@diffusionstudio/reconciler";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cx } from "@/lib/cva";
import { applyCaptionStyle, editableCaptions } from "@/engine/caption-editing";
import { captureFrameWithoutCaptions } from "@/engine/caption-frame";
import { useProject } from "@/context/project";
import { CAPTION_PRESET_OPTIONS, captionStyleFor } from "./caption-types";
import {
  HEAVY_COVERAGE, SAMPLE_CUE, assessCaptionPaints, highlightColors, layoutCaption, paintCaptionSample, paintSampleBackdrop,
  previewText,
} from "./caption-preview";

import type { Transcript } from "@diffusionstudio/assets";
import type { Entity } from "koota";
import type { CaptionPresetOption } from "./caption-types";
import type { CaptionReadability } from "./caption-preview";

type Backdrop = "frame" | "bright" | "dark";
type PreviewResult = { readability: CaptionReadability; coverage: number };

const BACKDROP_LABELS: Record<Backdrop, string> = { frame: "This frame", bright: "Bright", dark: "Dark" };
const VERDICT_DOTS: Record<CaptionReadability["verdict"], string> = {
  clear: "bg-emerald-500", patchy: "bg-amber-500", lost: "bg-destructive",
};

/** What a preview's verdict says, naming the highlight when it is the paint that fails. */
function verdictLabel(readability: CaptionReadability): string {
  if (readability.verdict === "clear") return "Reads clearly";
  const what = readability.weakest === "highlight" ? "Highlight" : "Text";
  return readability.verdict === "lost" ? `${what} hard to read` : `${what} patchy`;
}

function formatTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

type Props = {
  entity: Entity;
  current: CaptionPresetOption;
  /** The caption's own slot colors, filled from the preset where the file says none. */
  currentColors: number[];
};

/**
 * Every preset on the picture the caption plays over, so a look is chosen on
 * the shot rather than in the abstract: the frame under the playhead with the
 * captions taken out, and the one picked also on a bright and a dark shot.
 * Each preview says whether the words would stay readable there and how much
 * of the picture they cover. Applying writes only `preset` and `colors` — the
 * transcript's words and timing stay — and is one undo step, for this caption
 * or for every caption in the project.
 */
export function CaptionFootageCheck(props: Props) {
  const world = useWorld();
  const project = useProject();
  const assetId = useTrait(() => props.entity, AssetId);

  const [candidate, setCandidate] = createSignal<CaptionPresetOption>(props.current);
  createEffect(on(() => props.current, current => setCandidate(current), { defer: true }));
  const [notice, setNotice] = createSignal("");

  // What the shot is: rendered once when the panel opens and again on request,
  // since a render is a second, offline pass over the whole project.
  const [shot, setShot] = createSignal<{ frame: ImageBitmap | null; at: number; error: string } | null>(null);
  const [capturing, setCapturing] = createSignal(false);
  const sceneSize = () => {
    const scene = getActiveEntity(world);
    const computed = store(world, Computed);
    const width = scene ? computed.width[scene.id()] : undefined;
    const height = scene ? computed.height[scene.id()] : undefined;
    return { width: width || 1920, height: height || 1080 };
  };
  const captionSeconds = () => {
    const computed = store(world, Computed);
    const fps = world.get(FrameRate)?.value ?? 30;
    return (computed.localTime[props.entity.id()] ?? 0) / fps;
  };
  const capture = async () => {
    const scene = getActiveEntity(world);
    if (!scene || capturing()) return;
    setCapturing(true);
    const at = captionSeconds();
    try {
      const frame = await captureFrameWithoutCaptions(world, scene, project.dir());
      shot()?.frame?.close();
      setShot({ frame, at, error: "" });
    } catch (error) {
      setShot({ frame: null, at, error: error instanceof Error ? error.message : String(error) });
    } finally {
      setCapturing(false);
    }
  };
  void capture();
  onCleanup(() => shot()?.frame?.close());

  const [transcript] = createResource(() => assetId()?.value, async (id): Promise<Transcript> => {
    const asset = getAsset(world, id);
    return asset ? resolveTranscript(asset).catch(() => []) : [];
  });

  /** The cue playing when the frame was taken, or the next one, or a stand-in. */
  const sample = createMemo(() => {
    const at = shot()?.at ?? 0;
    const cues = transcript() ?? [];
    const playing = cues.find(cue => cue.words.length && at >= cue.words[0]!.start && at <= cue.words.at(-1)!.end);
    const next = cues.find(cue => cue.words.length && cue.words[0]!.start >= at);
    const cue = playing ?? next ?? cues.find(c => c.words.length) ?? SAMPLE_CUE;
    return { cue, seconds: playing ? at : cue.words[0]!.start };
  });

  // The caption's own style props, which a preset change keeps: the TextStyle
  // and Color traits move when they are edited, so reading them re-runs the
  // previews.
  const textStyle = useTrait(() => props.entity, TextStyle);
  const baseColor = useTrait(() => props.entity, Color);
  const authored = () => {
    textStyle();
    baseColor();
    return authoredElement(props.entity)?.props ?? {};
  };
  /** Each preset's style on this caption: the preset with the caption's overrides over it. */
  const styleFor = (option: CaptionPresetOption) => captionStyleFor(option, authored());

  // Every font the previews draw in, loaded before anything is measured in it.
  const fontKey = createMemo(() => [...new Set(CAPTION_PRESET_OPTIONS.map(option => {
    const { style } = styleFor(option);
    return `${style.fontWeight}|${style.fontFamily}`;
  }))].join("\n"));
  const [fontsReady] = createResource(fontKey, async key => {
    const fonts = key.split("\n").map(entry => entry.split("|") as [string, string]);
    const web = new Set(getWebFonts().map(font => font.family));
    await Promise.all([...new Set(fonts.map(([, family]) => family))].filter(family => web.has(family)).map(family =>
      loadWebFont(world, family as Parameters<typeof loadWebFont>[1]).catch(() => undefined)));
    if (typeof document !== "undefined" && document.fonts) {
      await Promise.all(fonts.map(([weight, family]) => document.fonts.load(`${weight} 48px "${family}"`).catch(() => [])));
    }
    return true;
  });
  const placement = () => {
    const authored = authoredElement(props.entity)?.props;
    const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : undefined;
    return { x: number(authored?.x), y: number(authored?.y), align: props.entity.get(Caption)?.verticalAlign };
  };
  const colorsFor = (option: CaptionPresetOption) =>
    option === props.current ? props.currentColors : option.slots.map(slot => slot.defaultColor);

  /**
   * Draws one preview and reports how it reads. The backdrop is drawn and
   * sampled under the text block before the text goes on, so what is
   * measured is the picture the words have to stand out from.
   */
  const paint = (canvas: HTMLCanvasElement, option: CaptionPresetOption, backdrop: Backdrop) => {
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    const scene = sceneSize();
    const scale = canvas.width / scene.width;
    canvas.height = Math.round(scene.height * scale);
    const frame = shot()?.frame;
    if (backdrop === "frame") {
      if (frame) ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
      else {
        ctx.fillStyle = "#808080";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
    } else paintSampleBackdrop(ctx, backdrop, canvas.width, canvas.height);

    const { style, fill } = styleFor(option);
    const colors = colorsFor(option);
    const { cue, seconds } = sample();
    const text = previewText(option.look, cue, seconds);
    const measure = (value: string, font: string) => {
      ctx.font = font;
      return ctx.measureText(value).width;
    };
    const layout = layoutCaption(option.look, style, text, scene, measure, placement());
    const { x, y, width, height } = layout.block;
    let readability: CaptionReadability = { lost: 0, verdict: "clear", weakest: "text" };
    if (width > 0 && height > 0) {
      const px = Math.max(0, Math.floor(x * scale));
      const py = Math.max(0, Math.floor(y * scale));
      const pw = Math.min(canvas.width - px, Math.ceil(width * scale));
      const ph = Math.min(canvas.height - py, Math.ceil(height * scale));
      if (pw > 0 && ph > 0) {
        readability = assessCaptionPaints(
          ctx.getImageData(px, py, pw, ph).data,
          { text: fill, highlights: highlightColors(option.look, colors) },
          option.look,
        );
      }
    }
    paintCaptionSample(ctx, { look: option.look, style, layout, text, fill, colors, scale });
    return { readability, coverage: layout.coverage };
  };

  const Preview = (previewProps: {
    option: CaptionPresetOption;
    backdrop: Backdrop;
    width: number;
    onResult?: (result: PreviewResult) => void;
  }) => {
    let canvas!: HTMLCanvasElement;
    createEffect(() => {
      if (!fontsReady()) return;
      shot();
      sample();
      authored();
      const result = paint(canvas, previewProps.option, previewProps.backdrop);
      if (result) previewProps.onResult?.(result);
    });
    return <canvas
      ref={canvas}
      width={previewProps.width}
      class="block w-full h-auto rounded-sm bg-muted"
      aria-label={`${previewProps.option.label} on ${BACKDROP_LABELS[previewProps.backdrop].toLowerCase()}`}
    />;
  };

  const [results, setResults] = createSignal<Record<string, PreviewResult>>({});
  const record = (key: string) => (result: PreviewResult) =>
    setResults(previous => ({ ...previous, [key]: result }));

  const apply = (scope: "this" | "all") => {
    const option = candidate();
    const style = {
      preset: option.name,
      colors: option === props.current && props.entity.get(Caption)?.colors?.length
        ? colorsFor(option).map(colorToHex)
        : false as const,
    };
    const { editable, skipped } = scope === "all" ? editableCaptions(world) : { editable: [props.entity], skipped: 0 };
    const applied = applyCaptionStyle(world, editable, style);
    const what = applied === 1 ? "this caption" : `${applied} captions`;
    const left = skipped === 1
      ? " One caption is locked or made by a loop, so it was left as it was."
      : skipped ? ` ${skipped} captions are locked or made by a loop, so they were left as they were.` : "";
    setNotice(applied
      ? `${option.label} is on ${what}. Undo takes it back in one step.${left}`
      : "Nothing changed: the caption is locked or made by a loop.");
  };

  const captionCount = () => editableCaptions(world).editable.length;
  /** A preview's verdict; none for the frame while no frame is rendered (a failed refresh leaves the old one). */
  const detail = (backdrop: Backdrop) =>
    backdrop === "frame" && !shot()?.frame ? undefined : results()[`${candidate().name}:${backdrop}`];

  return <section class="mt-3 border-t border-border pt-3 min-w-0" aria-label="Captions on the footage">
    <div class="flex items-center gap-2 mb-1">
      <div class="text-xs font-medium">On the footage</div>
      <Button
        variant="ghost"
        size="small"
        class="ml-auto gap-1 text-muted-foreground"
        disabled={capturing()}
        onClick={() => void capture()}
      >
        <Icon name={capturing() ? "spinner-loader" : "rerun"} class={cx("size-4", capturing() && "animate-spin")} />
        Use playhead frame
      </Button>
    </div>
    <div class="text-xxs text-muted-foreground mb-2" role="status">
      <Show when={!capturing()} fallback="Rendering the frame…">
        <Show
          when={!shot()?.error}
          fallback={<>The frame could not be rendered, so the bright and dark samples stand in. {shot()?.error}</>}
        >
          Frame at {formatTime(shot()?.at ?? 0)}, captions hidden. Each preview is a sample of the preset.
        </Show>
      </Show>
    </div>

    <div class="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Caption presets">
      <For each={CAPTION_PRESET_OPTIONS}>{option => {
        // Without a rendered frame the tile stands on the bright shot, and its
        // verdict is filed under that shot, never passed off as the frame's.
        const backdrop = (): Backdrop => shot()?.frame ? "frame" : "bright";
        const verdict = () => results()[`${option.name}:${backdrop()}`]?.readability;
        return <button
          type="button"
          role="radio"
          aria-checked={candidate() === option}
          class={cx(
            "min-w-0 rounded-md p-1 text-left outline-none transition-colors hover:bg-accent focus-visible:ring-1 focus-visible:ring-primary",
            candidate() === option && "bg-accent ring-1 ring-primary",
          )}
          onClick={() => { setCandidate(option); setNotice(""); }}
        >
          <Preview option={option} backdrop={backdrop()} width={320} onResult={result => record(`${option.name}:${backdrop()}`)(result)} />
          <div class="mt-1 flex items-center gap-1 text-xs min-w-0">
            <span class="truncate">{option.label}</span>
            <Show when={option === props.current}>
              <span class="text-xxs text-muted-foreground">· in use</span>
            </Show>
          </div>
          <Show when={verdict()}>{v =>
            <div class="flex items-center gap-1 text-xxs text-muted-foreground">
              <span class={cx("size-1.5 rounded-full shrink-0", VERDICT_DOTS[v().verdict])} aria-hidden="true" />
              {verdictLabel(v())}
            </div>}
          </Show>
        </button>;
      }}</For>
    </div>

    <div class="mt-3 text-xs font-medium">{candidate().label} on three shots</div>
    <div class="mt-1 grid grid-cols-3 gap-1.5">
      <For each={["frame", "bright", "dark"] as Backdrop[]}>{backdrop =>
        <div class="min-w-0">
          <Show when={backdrop !== "frame" || shot()?.frame} fallback={<div class="aspect-video rounded-sm bg-muted" />}>
            <Show when={candidate()} keyed>{option =>
              <Preview option={option} backdrop={backdrop} width={240} onResult={record(`${option.name}:${backdrop}`)} />}
            </Show>
          </Show>
          <div class="mt-0.5 text-xxs text-muted-foreground truncate">{BACKDROP_LABELS[backdrop]}</div>
          <Show when={detail(backdrop)}>{result =>
            <div class="flex items-center gap-1 text-xxs">
              <span class={cx("size-1.5 rounded-full shrink-0", VERDICT_DOTS[result().readability.verdict])} aria-hidden="true" />
              <span class="truncate">{verdictLabel(result().readability)}</span>
            </div>}
          </Show>
        </div>}
      </For>
    </div>
    <Show when={detail("frame") ?? detail("bright")}>{result =>
      <div class={cx("mt-1.5 text-xxs", result().coverage > HEAVY_COVERAGE ? "text-foreground" : "text-muted-foreground")}>
        Covers {Math.max(1, Math.round(result().coverage * 100))}% of the picture
        {result().coverage > HEAVY_COVERAGE ? ", which hides a lot of the shot." : "."}
      </div>}
    </Show>

    <div class="mt-2 flex flex-wrap gap-1.5">
      <Button size="default" class="text-xs" disabled={candidate() === props.current} onClick={() => apply("this")}>
        Apply to this caption
      </Button>
      <Button variant="secondary" size="default" class="text-xs" disabled={captionCount() < 2 && candidate() === props.current} onClick={() => apply("all")}>
        Apply to all captions
      </Button>
    </div>
    <Show when={notice()}>
      <div role="status" class="mt-1.5 text-xxs text-muted-foreground">{notice()}</div>
    </Show>
  </section>;
}
