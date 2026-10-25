import { createMemo, createResource, createSignal, For, Show } from 'solid-js';
import { useTrait, useWorld } from '@diffusionstudio/koota-solid';
import { AssetId, getAsset, resolveTranscript } from '@diffusionstudio/runtime';
import { Icon } from '@/components/ui/icon';
import { describeLongCue, editCaptionCue, findLongCues, seekToCue, splitCaptionCue } from '@/engine/caption-editing';
import type { Entity } from 'koota';

export function CaptionCues(props: { entity: Entity }) {
  const world = useWorld();
  const assetId = useTrait(() => props.entity, AssetId);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const [note, setNote] = createSignal('');
  const [data, { refetch }] = createResource(() => assetId()?.value, async id => {
    const asset = getAsset(world, id);
    if (!asset) return { id, cues: [], error: 'Caption source is unavailable' };
    try { return { id, cues: await resolveTranscript(asset), error: '' }; }
    catch (error) { return { id, cues: [], error: String(error) }; }
  });
  const long = createMemo(() => new Map(findLongCues(data()?.cues ?? []).map(cue => [cue.index, cue])));
  const fields: HTMLTextAreaElement[] = [];

  const run = async (change: () => Promise<void>) => {
    if (busy()) return;
    setBusy(true); setError(''); setNote('');
    try { await change(); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const save = (index: number, text: string, previous: string, id: string) => {
    if (text.trim() === previous.trim()) return;
    void run(() => editCaptionCue(world, props.entity, id, index, text));
  };
  const split = (index: number, id: string) => void run(async () => {
    await splitCaptionCue(world, props.entity, id, index);
    setNote(`Caption ${index + 1} is now two captions with the same words and timing.`);
  });
  /** Parks the playhead on the cue and puts the cursor in its text, ready to shorten. */
  const show = (index: number) => {
    const cue = data()?.cues[index];
    if (!cue) return;
    const onTimeline = seekToCue(world, props.entity, cue);
    setNote(onTimeline ? '' : `Caption ${index + 1} is trimmed off the timeline; the playhead is on the nearest frame it could be.`);
    const field = fields[index];
    field?.scrollIntoView({ block: 'nearest' });
    field?.focus({ preventScroll: true });
  };

  return <div class="mt-3 border-t border-border pt-3 min-w-0">
    <div class="text-xs font-medium mb-2">Caption text</div>
    <Show when={data.loading}><div role="status" class="text-xs text-muted-foreground">Loading captions...</div></Show>
    <Show when={error() || data()?.error}>
      <div role="alert" class="text-xs text-destructive break-words">{error() || data()?.error}</div>
      <button class="text-xs underline" onClick={() => { setError(''); void refetch(); }}>Reload captions</button>
    </Show>
    <Show when={long().size}>
      <div class="mb-2 text-xxs text-muted-foreground" data-long-cues>
        {long().size === 1
          ? 'One caption is long enough to be hard to read in time. Shorten its words or split it in two.'
          : `${long().size} captions are long enough to be hard to read in time. Shorten their words or split them in two.`}
      </div>
    </Show>
    <Show when={note()}><div role="status" class="mb-2 text-xxs text-muted-foreground">{note()}</div></Show>
    <fieldset disabled={busy() || data.loading} class="max-h-80 overflow-y-auto space-y-2 min-w-0" on:keydown={event => event.stopPropagation()}>
      <For each={data()?.cues}>{(cue, index) => {
        const id = data()!.id;
        const warning = () => long().get(index());
        return <div class="block text-xs min-w-0">
          <div class="flex items-center gap-1 min-w-0">
            <span class="text-muted-foreground">{index() + 1}</span>
            <Show when={warning()}>{w => <>
              <button
                type="button"
                class="flex min-w-0 items-center gap-1 rounded px-1 text-xxs text-muted-foreground hover:bg-accent hover:text-foreground"
                title="Show this caption on the timeline"
                onClick={() => show(index())}
              >
                <Icon name="alert-warning" class="size-3.5 text-amber-500" />
                <span class="truncate">{describeLongCue(w())}</span>
              </button>
              <Show when={cue.words.length > 1}>
                <button
                  type="button"
                  class="ml-auto shrink-0 flex items-center gap-0.5 rounded px-1 text-xxs text-muted-foreground hover:bg-accent hover:text-foreground"
                  onClick={() => split(index(), id)}
                >
                  <Icon name="split" class="size-3.5" />Split
                </button>
              </Show>
            </>}</Show>
          </div>
          <textarea
            ref={element => { fields[index()] = element; }}
            class="block w-full min-w-0 resize-y rounded border border-border bg-background p-2 text-foreground" rows={2}
            aria-label={`Caption ${index() + 1}`} value={cue.text}
            onBlur={event => save(index(), event.currentTarget.value, cue.text, id)} />
        </div>;
      }}</For>
    </fieldset>
    <Show when={busy()}><div role="status" class="text-xs text-muted-foreground">Saving caption...</div></Show>
  </div>;
}
