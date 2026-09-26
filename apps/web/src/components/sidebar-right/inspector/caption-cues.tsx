import { createResource, createSignal, For, Show } from 'solid-js';
import { useTrait, useWorld } from '@diffusionstudio/koota-solid';
import { AssetId, getAsset, resolveTranscript } from '@diffusionstudio/runtime';
import { editCaptionCue } from '@/engine/caption-editing';
import type { Entity } from 'koota';

export function CaptionCues(props: { entity: Entity }) {
  const world = useWorld();
  const assetId = useTrait(() => props.entity, AssetId);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const [data, { refetch }] = createResource(() => assetId()?.value, async id => {
    const asset = getAsset(world, id);
    if (!asset) return { id, cues: [], error: 'Caption source is unavailable' };
    try { return { id, cues: await resolveTranscript(asset), error: '' }; }
    catch (error) { return { id, cues: [], error: String(error) }; }
  });
  const save = async (index: number, text: string, previous: string, id: string) => {
    if (text.trim() === previous.trim() || busy()) return;
    setBusy(true); setError('');
    try { await editCaptionCue(world, props.entity, id, index, text); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  return <div class="mt-3 border-t border-border pt-3 min-w-0">
    <div class="text-xs font-medium mb-2">Caption text</div>
    <Show when={data.loading}><div role="status" class="text-xs text-muted-foreground">Loading captions...</div></Show>
    <Show when={error() || data()?.error}>
      <div role="alert" class="text-xs text-destructive break-words">{error() || data()?.error}</div>
      <button class="text-xs underline" onClick={() => { setError(''); void refetch(); }}>Reload captions</button>
    </Show>
    <fieldset disabled={busy() || data.loading} class="max-h-80 overflow-y-auto space-y-2 min-w-0" on:keydown={event => event.stopPropagation()}>
      <For each={data()?.cues}>{(cue, index) => {
        const id = data()!.id;
        return <label class="block text-xs">
        <span class="text-muted-foreground">{index() + 1}</span>
        <textarea class="block w-full min-w-0 resize-y rounded border border-border bg-background p-2 text-foreground" rows={2}
          aria-label={`Caption ${index() + 1}`} value={cue.text}
          onBlur={event => void save(index(), event.currentTarget.value, cue.text, id)} />
      </label>;
      }}</For>
    </fieldset>
    <Show when={busy()}><div role="status" class="text-xs text-muted-foreground">Saving caption...</div></Show>
  </div>;
}
