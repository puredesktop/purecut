/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { For, Show, createMemo, createResource, createSignal, onCleanup } from 'solid-js';
import { ProgressSlider } from "@/components/ui/progress-slider";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Icon } from "@/components/ui/icon";
import { formatDuration } from "@/utils/formatters";
import { getAssetFile } from "@diffusionstudio/runtime";
import { derivePeaks, assetName } from "@diffusionstudio/assets";
import { useLibrary } from "@/engine/library";
import { useWorld } from '@diffusionstudio/koota-solid';
import { insertAsset, appendAsset } from '@/engine/insert-asset';
import { toast } from 'somoto';
import { createEffect } from 'solid-js';

import type { Asset } from '@diffusionstudio/assets';

type VisualAsset = Extract<Asset, { type: 'IMAGE' | 'VIDEO' | 'SEQUENCE' }>;

const keyOf = (asset: Asset): string => `${asset.id}:${asset.stat?.mtime ?? ''}`;

export function AssetInfoPreview(props: { asset: Asset }) {
  const library = useLibrary();
  const handle = createMemo(() => {
    // Same-content relinks retain the asset object but replace its file handle.
    library()?.assets();
    return props.asset.handle;
  });
  return <Show when={handle()} keyed>{_handle => <AssetFilePreview asset={props.asset} />}</Show>;
}

function AssetFilePreview(props: { asset: Asset }) {
  const world = useWorld();
  const [markIn, setMarkIn] = createSignal(0);
  const [markOut, setMarkOut] = createSignal(0);
  createEffect(() => {
    const asset = props.asset;
    setMarkIn(0);
    setMarkOut(asset.type === 'VIDEO' || asset.type === 'AUDIO' ? asset.duration : 0);
  });
  const library = useLibrary();
  let mediaRef: HTMLMediaElement | undefined;
  let prevObjectUrl: string | undefined;
  let disposed = false;

  const [objectUrl] = createResource(
    () => keyOf(props.asset),
    async () => {
      if (prevObjectUrl) {
        URL.revokeObjectURL(prevObjectUrl);
        prevObjectUrl = undefined;
      }

      try {
        const file = await getAssetFile(props.asset);
        if (disposed) return undefined;
        prevObjectUrl = URL.createObjectURL(file);
        return prevObjectUrl;
      } catch {
        return undefined;
      }
    },
  );

  const [peaks] = createResource(
    () => props.asset.type === 'AUDIO' ? keyOf(props.asset) : null,
    async () => {
      const cache = library()?.cache;
      if (cache) return cache.peaks(props.asset);
      return derivePeaks(await getAssetFile(props.asset));
    },
  );

  const [duration, setDuration] = createSignal(0);
  const [currentTime, setCurrentTime] = createSignal(0);
  const [playing, setPlaying] = createSignal(false);
  const [reviewingRange, setReviewingRange] = createSignal(false);
  const validRange = () => Number.isFinite(markIn()) && Number.isFinite(markOut()) &&
    markIn() >= 0 && markOut() > markIn() && markOut() <= duration() && !props.asset.sourceError;
  const updateTime = (event: Event & { currentTarget: HTMLMediaElement }) => {
    const media = event.currentTarget;
    if (reviewingRange() && media.currentTime >= markOut()) {
      media.pause();
      media.currentTime = markOut();
      setReviewingRange(false);
    }
    setCurrentTime(media.currentTime);
  };
  const playRange = async () => {
    if (!mediaRef || !validRange()) return;
    mediaRef.currentTime = markIn();
    setCurrentTime(markIn());
    setReviewingRange(true);
    try { await mediaRef.play(); } catch { setReviewingRange(false); setPlaying(false); }
  };

  const isImage = createMemo(() => props.asset.type === 'IMAGE' || props.asset.type === 'SEQUENCE');
  const isVideo = createMemo(() => props.asset.type === 'VIDEO');
  const isAudio = createMemo(() => props.asset.type === 'AUDIO');
  const isTranscript = createMemo(() => props.asset.type === 'TRANSCRIPT');
  const canPlay = createMemo(() => isVideo() || isAudio());

  const showProgress = createMemo(() => canPlay());

  const progress = createMemo(() => {
    const mediaDuration = duration();
    if (mediaDuration === 0) return 0;
    return (currentTime() / mediaDuration) * 100;
  });

  const setProgress = (value: number) => {
    setReviewingRange(false);
    const mediaDuration = duration();
    if (mediaDuration === 0 || !mediaRef) return;
    const nextTime = (value / 100) * mediaDuration;
    mediaRef.currentTime = nextTime;
    setCurrentTime(nextTime);
  };

  const togglePlayback = () => {
    setReviewingRange(false);
    if (!mediaRef) return;

    if (mediaRef.paused) {
      void mediaRef.play().catch(() => setPlaying(false));
      return;
    }

    mediaRef.pause();
  };

  const timeLabel = createMemo(() => {
    return `${formatDuration(currentTime())} / ${formatDuration(duration())}`;
  });

  const aspectRatio = createMemo(() => {
    if (isAudio() || isTranscript()) return '16 / 9';

    const visualAsset = props.asset as VisualAsset;
    if (visualAsset.width > 0 && visualAsset.height > 0) {
      return `${visualAsset.width} / ${visualAsset.height}`;
    }

    return undefined;
  });

  onCleanup(() => {
    disposed = true;
    mediaRef?.pause();
    if (prevObjectUrl) {
      URL.revokeObjectURL(prevObjectUrl);
      prevObjectUrl = undefined;
    }
  });

  return (
    <div class="flex flex-col gap-2">
      <div
        class="group relative w-full overflow-clip rounded-md border border-border bg-accent"
        style={{ 'aspect-ratio': aspectRatio() }}
      >
        <Show when={isTranscript()}>
          <div class="absolute inset-0 bg-caption-background overflow-clip">
            <div class="absolute top-1 left-1 h-4 px-1 flex items-center bg-overlay rounded-sm">
              <span class="text-xxs leading text-white">Captions</span>
            </div>
            <div class="absolute top-[54%] bottom-1 left-1 right-0 flex items-center gap-0.5 overflow-clip">
              <div class="bg-caption-accent h-full rounded-sm shrink-0" style={{ width: '74px', 'min-width': '16px' }} />
              <div class="bg-caption-accent h-full rounded-sm shrink-0" style={{ width: '32px' }} />
              <div class="bg-caption-accent h-full rounded-sm shrink-0" style={{ width: '72px', 'min-width': '16px' }} />
              <div class="bg-caption-accent h-full rounded-sm shrink-0" style={{ width: '72px', 'min-width': '16px' }} />
            </div>
          </div>
        </Show>
        <Show when={objectUrl()}>
          {url => (
            <>
              <Show when={isVideo()}>
                <video
                  class="size-full object-cover"
                  ref={el => mediaRef = el}
                  src={url()}
                  controls={false}
                  preload='metadata'
                  playsinline
                  onTimeUpdate={updateTime}
                  onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
                  onPlay={() => setPlaying(true)}
                  onPause={() => setPlaying(false)}
                  onEnded={() => setPlaying(false)}
                />
              </Show>
              <Show when={isAudio()}>
                <div class="absolute inset-0 py-2 bg-audio-background">
                  <div class="flex items-center justify-center w-full h-full">
                    <Show when={peaks()}>
                      <For each={Array.from(peaks()!)}>
                        {value => {
                          const height = Math.min(Math.max(2, (value / 255) * 100), 98);
                          return <div class="bg-audio-primary flex-1 rounded-sm" style={{ height: `${height}%` }} />;
                        }}
                      </For>
                    </Show>
                  </div>
                </div>
                <audio
                  ref={el => mediaRef = el}
                  src={url()}
                  controls={false}
                  preload='metadata'
                  class="hidden"
                  onTimeUpdate={updateTime}
                  onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
                  onPlay={() => setPlaying(true)}
                  onPause={() => setPlaying(false)}
                  onEnded={() => setPlaying(false)}
                />
              </Show>
              <Show when={isImage()}>
                <img class="size-full object-cover" src={url()} alt={assetName(props.asset)} />
              </Show>
            </>
          )}
        </Show>
        <Show when={canPlay()}>
          <div class="absolute inset-0 bg-overlay opacity-0 transition-opacity group-hover:opacity-100 flex items-center justify-center">
            <div class="absolute left-1 top-1 z-10 flex h-4 items-center justify-center rounded-sm bg-overlay px-1">
              <span class="font-mono text-xxs text-foreground">
                {timeLabel()}
              </span>
            </div>
            <Tooltip>
              <TooltipTrigger
                as={Button}
                type="button"
                size="icon-square"
                variant="default"
                onClick={togglePlayback}
              >
                <Icon name={playing() ? "controls-pause" : "controls-play"} class="size-6" />
              </TooltipTrigger>
              <TooltipContent>{playing() ? "Pause" : "Play"}</TooltipContent>
            </Tooltip>
          </div>
        </Show>
      </div>
      <Show when={showProgress()} fallback={<div class="h-3" />}>
        <div class="h-11 flex items-center">
          <ProgressSlider class="w-full" value={progress()} minValue={0} maxValue={100} onChange={setProgress} />
        </div>
      </Show>
      <Show when={canPlay()}>
        <div class="grid grid-cols-2 gap-2 text-xs" on:keydown={event => event.stopPropagation()}>
          <label class="min-w-0 flex flex-col gap-1">In (s)
            <input aria-label="Source in" type="number" min="0" max={markOut()} step="0.001"
              class="w-full min-w-0 rounded bg-input p-2" value={markIn()}
              onInput={event => setMarkIn(event.currentTarget.valueAsNumber)} />
          </label>
          <label class="min-w-0 flex flex-col gap-1">Out (s)
            <input aria-label="Source out" type="number" min={markIn()} max={duration()} step="0.001"
              class="w-full min-w-0 rounded bg-input p-2" value={markOut()}
              onInput={event => setMarkOut(event.currentTarget.valueAsNumber)} />
          </label>
          <Button variant="secondary" onClick={() => setMarkIn(currentTime())}>Mark in</Button>
          <Button variant="secondary" onClick={() => setMarkOut(currentTime())}>Mark out</Button>
          <div class="col-span-2 flex items-center gap-2 min-w-0">
            <Tooltip>
              <TooltipTrigger as={Button} size="icon-square" variant="secondary"
                aria-label={reviewingRange() && playing() ? 'Pause selected range' : 'Play selected range'}
                disabled={!validRange()} onClick={() => {
                  if (reviewingRange() && playing()) { mediaRef?.pause(); setReviewingRange(false); }
                  else void playRange();
                }}>
                <Icon name={reviewingRange() && playing() ? 'controls-pause' : 'controls-play'} />
              </TooltipTrigger>
              <TooltipContent>Play selected range</TooltipContent>
            </Tooltip>
            <span class="flex-1 text-muted-foreground">{validRange() ? formatDuration(markOut() - markIn()) : 'Invalid range'}</span>
            <Button variant="ghost" onClick={() => {
              setReviewingRange(false); setMarkIn(0); setMarkOut(duration());
            }}>Reset range</Button>
          </div>
          <Button class="col-span-2" disabled={!validRange()}
            onClick={() => insertAsset(world, props.asset, { sourceRange: { in: markIn(), out: markOut() } })}>
            Insert range at playhead
          </Button>
          <Button class="col-span-2" variant="secondary" disabled={!validRange()}
            onClick={() => {
              if (!appendAsset(world, props.asset, { sourceRange: { in: markIn(), out: markOut() } }))
                toast.error('Could not append to this container');
            }}>Append range to end</Button>
        </div>
      </Show>
    </div>
  );
}
