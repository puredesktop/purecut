/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createEffect, createMemo, For, onCleanup, Show } from 'solid-js';
import { useVolumeMeter, type ChannelLevels } from '@/hooks/use-volume-meter';
import { cx } from '@/lib/cva';

const MIN_DB = -60;
const MAX_DB = 3;

/** Maps a linear amplitude (0–1+) to a meter percentage (0–100). */
function amplitudeToMeterPct(amplitude: number): number {
  if (amplitude <= 0) return 0;

  const db = 20 * Math.log10(amplitude);

  if (db <= MIN_DB) return 0;
  if (db >= MAX_DB) return 100;

  return ((db - MIN_DB) / (MAX_DB - MIN_DB)) * 100;
}

/** Maps a level in dB to a meter percentage (0 at the floor, 100 at the top). */
function dbToMeterPct(db: number): number {
  return ((Math.max(MIN_DB, Math.min(MAX_DB, db)) - MIN_DB) / (MAX_DB - MIN_DB)) * 100;
}

/** Healthy up to -12 dB, hot to -3 dB, too loud above it. */
const GREEN_END = dbToMeterPct(-12);
const YELLOW_END = dbToMeterPct(-3);

/**
 * One continuous ramp rather than three slabs: the level reads as a single
 * bar that warms as it climbs. The stops sit on the dB zones above.
 */
const METER_GRADIENT = `linear-gradient(to top,
  var(--color-meter-green) 0%, var(--color-meter-green) ${GREEN_END - 4}%,
  var(--color-meter-yellow) ${GREEN_END + 4}%, var(--color-meter-yellow) ${YELLOW_END - 2}%,
  var(--color-meter-red) ${YELLOW_END + 2}%)`;

/** Scale marks, placed at the level they name — not spread evenly. */
const SCALE_MARKS = [0, -6, -12, -24, -48];

type VolumeMeterProps = {
  audioNode?: GainNode;
};

export function VolumeMeter(props: VolumeMeterProps) {
  const meter = useVolumeMeter();

  createEffect(() => {
    if (props.audioNode) {
      meter.connect(props.audioNode);
    } else {
      meter.disconnect();
    }
  });

  onCleanup(() => meter.disconnect());

  return (
    <div class="cut-meter relative flex gap-0.5 w-2.5" title={meter.error() ?? undefined}>
      <button type="button" class="cut-meter-clip absolute -top-3 left-1/2 -translate-x-1/2 size-1.5 rounded-full"
        classList={{ 'bg-meter-red': meter.clipped(), 'bg-input': !meter.clipped() }}
        aria-label={meter.error() ? 'Audio meter unavailable' : 'Reset clipping warning'}
        aria-pressed={meter.clipped()} disabled={!props.audioNode || !!meter.error()}
        title={meter.error() ?? (meter.clipped() ? 'Clipping detected. Reset warning' : 'No clipping detected')}
        onClick={meter.resetClipping} />
      <VerticalMeter channel={0} levels={meter.levels} />
      <VerticalMeter channel={1} levels={meter.levels} />
    </div>
  );
}

type VerticalMeterProps = {
  channel: number;
  levels: () => ChannelLevels[];
  class?: string;
};

function VerticalMeter(props: VerticalMeterProps) {
  const level = () => {
    const ch = props.levels()[props.channel];
    return ch ?? { rms: 0, peak: 0 };
  };

  const rmsPct = () => amplitudeToMeterPct(level().rms);
  const peakPct = () => amplitudeToMeterPct(level().peak);

  const indicatorOffset = () => `${peakPct()}%`;
  const indicatorClass = () => {
    const pct = peakPct();
    if (pct >= YELLOW_END) return "bg-meter-red";
    if (pct >= GREEN_END) return "bg-meter-yellow";
    return "bg-meter-green";
  };

  return (
    <div class={cx("cut-meter-bar h-full relative w-full overflow-clip rounded-full bg-input", props.class)}>
      <div
        class="absolute inset-0 rounded-full transition-[clip-path] duration-75 ease-out"
        style={{ background: METER_GRADIENT, "clip-path": `inset(${100 - rmsPct()}% 0 0 0 round 999px)` }}
      />

      {/* Peak hold: a short pill in the colour of the zone it reached. */}
      <Show when={peakPct() > 0.5}>
        <div
          class={cx("absolute inset-x-0 h-0.5 rounded-full", indicatorClass())}
          style={{ bottom: `calc(${indicatorOffset()} - 1px)` }}
        />
      </Show>
    </div>
  );
}

/**
 * 0 dB (unity) sits at 50% (middle of the track).
 * Top = SLIDER_MAX_DB, bottom = SLIDER_MIN_DB.
 */
const SLIDER_MAX_DB = -MIN_DB;   // +60 dB at top (symmetric around 0)
const SLIDER_MIN_DB = MIN_DB;    // -60 dB at bottom

/** Maps a dB value to a slider percentage (0%=top, 100%=bottom). */
function dbToSliderPct(db: number): number {
  const clamped = Math.max(SLIDER_MIN_DB, Math.min(SLIDER_MAX_DB, db));
  return ((SLIDER_MAX_DB - clamped) / (SLIDER_MAX_DB - SLIDER_MIN_DB)) * 100;
}

/** Maps a slider percentage (0%=top, 100%=bottom) to a dB value. */
function sliderPctToDb(pct: number): number {
  const clamped = Math.max(0, Math.min(100, pct));
  return SLIDER_MAX_DB - (clamped / 100) * (SLIDER_MAX_DB - SLIDER_MIN_DB);
}

type VolumeControlProps = {
  label?: string;
  volume: number;
  onVolumeChange(volume: number): void;
  disabled?: boolean;
};

export function VolumeControl(props: VolumeControlProps) {
  const knobPct = createMemo(() => dbToSliderPct(props.volume));

  let trackRef!: HTMLDivElement;
  let finishDrag: (() => void) | undefined;
  onCleanup(() => finishDrag?.());
  createEffect(() => { if (props.disabled) finishDrag?.(); });
  const changeVolume = (value: number) => {
    if (!props.disabled && Number.isFinite(value))
      props.onVolumeChange(Math.max(SLIDER_MIN_DB, Math.min(SLIDER_MAX_DB, value)));
  };

  const handlePointerDown = (e: PointerEvent) => {
    if (props.disabled || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    finishDrag?.();
    trackRef.focus();
    const pointerId = e.pointerId;
    trackRef.setPointerCapture(pointerId);

    const update = (clientY: number) => {
      const rect = trackRef.getBoundingClientRect();
      if (rect.height <= 0) return;
      const pct = ((clientY - rect.top) / rect.height) * 100;
      const db = sliderPctToDb(pct);
      changeVolume(db);
    };

    update(e.clientY);

    const onMove = (ev: PointerEvent) => { if (ev.pointerId === pointerId) update(ev.clientY); };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onEnd);
      window.removeEventListener('pointercancel', onEnd);
      window.removeEventListener('blur', onUp);
      trackRef.removeEventListener('lostpointercapture', onEnd);
      if (trackRef.hasPointerCapture(pointerId)) trackRef.releasePointerCapture(pointerId);
      finishDrag = undefined;
    };
    const onEnd = (event: PointerEvent) => { if (event.pointerId === pointerId) onUp(); };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onEnd);
    window.addEventListener('pointercancel', onEnd);
    window.addEventListener('blur', onUp);
    trackRef.addEventListener('lostpointercapture', onEnd);
    finishDrag = onUp;
  };

  return (
    <div
      ref={trackRef}
      role="slider"
      aria-label={props.label ?? 'Volume'}
      aria-orientation="vertical"
      aria-valuemin={SLIDER_MIN_DB}
      aria-valuemax={SLIDER_MAX_DB}
      aria-valuenow={props.volume}
      aria-valuetext={`${props.volume} dB`}
      aria-disabled={props.disabled ?? false}
      tabIndex={props.disabled ? -1 : 0}
      class="cut-fader group relative w-4 h-full mr-2 rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      style={{ 'touch-action': 'none' }}
      classList={{ 'opacity-50 pointer-events-none': props.disabled }}
      onPointerDown={handlePointerDown}
      onDblClick={() => changeVolume(0)}
      on:keydown={event => {
        event.stopPropagation();
        if (event.key === 'Escape') { finishDrag?.(); return; }
        if (!['ArrowUp', 'ArrowRight', 'ArrowDown', 'ArrowLeft', 'PageUp', 'PageDown', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const step = event.key.startsWith('Page') ? 6 : event.shiftKey ? 10 : 1;
        changeVolume(event.key === 'Home' ? SLIDER_MIN_DB : event.key === 'End' ? SLIDER_MAX_DB
          : props.volume + (['ArrowUp', 'ArrowRight', 'PageUp'].includes(event.key) ? step : -step));
      }}
    >
      {/* The rail, with the stretch between unity and the thumb lit, so a
          boost or a cut reads at a glance. */}
      <div class="absolute inset-y-0 left-1/2 -translate-x-1/2 w-0.5 rounded-full bg-input pointer-events-none" />
      <div
        class="absolute left-1/2 -translate-x-1/2 w-0.5 rounded-full bg-primary/70 pointer-events-none"
        style={{ top: `${Math.min(50, knobPct())}%`, bottom: `${100 - Math.max(50, knobPct())}%` }}
      />
      {/* Unity (0 dB) notch. */}
      <div class="absolute left-0 w-1 top-1/2 h-px bg-muted-foreground/50 pointer-events-none" />
      <div
        class="cut-fader-thumb absolute left-1/2 -translate-x-1/2 -translate-y-1/2 w-4 h-2.5 rounded-full bg-foreground shadow-[0_1px_4px_rgba(0,0,0,0.4)] pointer-events-none transition-transform group-hover:scale-110 group-active:scale-110"
        style={{ top: `${knobPct()}%` }}
      >
        <div class="absolute inset-x-1 top-1/2 h-px -translate-y-1/2 bg-background/60" />
      </div>
    </div>
  );
}

export function MeterScale() {
  return (
    <div class="soundboard-scale relative h-full w-5 ml-1.5" aria-hidden="true">
      <For each={SCALE_MARKS}>
        {(db) => (
          <span
            class="soundboard-mark absolute left-0 -translate-y-1/2 text-xxs leading-none font-mono tabular-nums text-muted-foreground"
            style={{ top: `${100 - dbToMeterPct(db)}%` }}
          >
            {db === 0 ? '0' : `−${-db}`}
          </span>
        )}
      </For>
    </div>
  );
}
