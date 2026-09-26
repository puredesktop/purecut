import { Show, createSignal, onCleanup, onMount } from 'solid-js';
import { toast } from 'somoto';
import { useTrait, useWorld } from '@diffusionstudio/koota-solid';
import { Computed, FrameRate, Playback, stopPlayback, togglePlayback } from '@diffusionstudio/runtime';
import { useActiveScene, useDerived } from '@/engine';
import { seekBy, seekToCut } from '@/engine/input/shortcuts';
import { zoomBy, zoomToFit } from '@/engine/camera';
import { useCameraScale } from '@/engine/hooks/use-camera';
import { Button } from '../ui/button';
import { Icon } from '../ui/icon';
import { formatFrames } from '../timeline/time-format';
import { useLayout } from '@/context/layout';

export function PlaybackControls() {
  const world = useWorld();
  const { uiVisible, toggleUI } = useLayout();
  const scene = useActiveScene();
  const scale = useCameraScale();
  const playback = useTrait(scene, Playback);
  const rate = useTrait(world, FrameRate);
  const time = useDerived(() => scene()?.get(Computed)?.localTime ?? 0);
  const [fullscreen, setFullscreen] = createSignal(false);
  onMount(() => {
    const sync = () => setFullscreen(!!document.fullscreenElement);
    sync();
    document.addEventListener('fullscreenchange', sync);
    onCleanup(() => document.removeEventListener('fullscreenchange', sync));
  });
  const toggleFullscreen = async (event: MouseEvent & { currentTarget: HTMLButtonElement }) => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else {
        const preview = event.currentTarget.closest('[data-cut-preview]');
        if (preview instanceof HTMLElement) await preview.requestFullscreen();
      }
    } catch (error) {
      toast.error('Fullscreen unavailable', { description: error instanceof Error ? error.message : String(error) });
    }
  };
  const step = (frames: number) => {
    const current = scene();
    if (!current) return;
    stopPlayback(world, current);
    seekBy(world, frames);
  };
  return <div class="cut-playback-controls" role="group" aria-label="Preview playback">
    <Button size="icon" variant="ghost" aria-label="Previous cut" title="Previous cut" disabled={!scene()} onClick={() => seekToCut(world, -1)}><Icon name="keyframe-go-to-previous" /></Button>
    <Button size="icon" variant="ghost" aria-label="Previous frame" title="Previous frame" disabled={!scene()} onClick={() => step(-1)}><Icon name="chevron-left" /></Button>
    <Button size="icon" variant="ghost" aria-label={playback()?.playing ? 'Pause preview' : 'Play preview'} title={playback()?.playing ? 'Pause' : 'Play'} disabled={!scene()} onClick={() => { const current = scene(); if (current) togglePlayback(world, current); }}>
      <Show when={playback()?.playing} fallback={<Icon name="play" />}><Icon name="pause" /></Show>
    </Button>
    <Button size="icon" variant="ghost" aria-label="Next frame" title="Next frame" disabled={!scene()} onClick={() => step(1)}><Icon name="chevron-right" /></Button>
    <Button size="icon" variant="ghost" aria-label="Next cut" title="Next cut" disabled={!scene()} onClick={() => seekToCut(world, 1)}><Icon name="keyframe-go-to-next" /></Button>
    <output class="cut-preview-time" aria-label="Preview timecode">{formatFrames(time(), rate()?.value ?? 30, 'timecode')}</output>
    <Button size="icon" variant="ghost" aria-label="Zoom preview out" title="Zoom out" disabled={scale() <= 0.05} onClick={() => zoomBy(world, 1 / 1.2)}><Icon name="minus" /></Button>
    <output class="cut-preview-zoom" aria-label="Preview zoom">{Math.round(scale() * 100)}%</output>
    <Button size="icon" variant="ghost" aria-label="Zoom preview in" title="Zoom in" disabled={scale() >= 16} onClick={() => zoomBy(world, 1.2)}><Icon name="plus-add" /></Button>
    <Button size="icon" variant="ghost" aria-label="Fit preview" title="Fit preview" onClick={() => zoomToFit(world)}><Icon name="frame" /></Button>
    <Button size="icon" variant="ghost" aria-label={uiVisible() ? 'Review video' : 'Return to editing'} title={uiVisible() ? 'Review video' : 'Return to editing'} aria-pressed={!uiVisible()} onClick={toggleUI}><Icon name={uiVisible() ? 'eye-on' : 'sidebar'} /></Button>
    <Button size="icon" variant="ghost" aria-label={fullscreen() ? 'Exit fullscreen preview' : 'Fullscreen preview'} title={fullscreen() ? 'Exit fullscreen' : 'Fullscreen preview'} aria-pressed={fullscreen()} onClick={toggleFullscreen}><Icon name="tool.scene-frame" /></Button>
  </div>;
}
