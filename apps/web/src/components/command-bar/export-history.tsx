import { For, Show, createEffect, createMemo, createResource, createSignal, onMount, onCleanup, untrack } from 'solid-js';
import { Dialog, DialogPortal, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '../ui/dialog';
import { Button } from '../ui/button';
import { useProject } from '@/context/project';
import { exportDetails, exportPath, forgetExport, isAudioExport, listExports, relocateExport, trashExport, type ExportRecord } from '@/lib/export-history';
import { Icon } from '../ui/icon';
import { openPlatformFileDialog } from '@purescience/platform-ui/bridge/dialog.mjs';
import { readPlatformFilePreviewUrl } from '@purescience/platform-ui/bridge/fs.mjs';
import { revealPlatformPath } from '@purescience/platform-ui/bridge/os.mjs';

export function ExportHistory(props: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const project = useProject();
  const [selected, setSelected] = createSignal<ExportRecord>();
  const [error, setError] = createSignal('');
  const [locating, setLocating] = createSignal(false);
  const [trashTarget, setTrashTarget] = createSignal<{ entry: ExportRecord; path: string; dir: string }>();
  const [trashing, setTrashing] = createSignal(false);
  let cancelTrash: HTMLButtonElement | undefined;
  createEffect(() => { if (!props.open || trashTarget()?.entry.projectId !== project.id()) setTrashTarget(undefined); });
  createEffect(() => {
    const id = project.id();
    if (selected()?.projectId !== id) { setSelected(undefined); setError(''); }
  });
  const [entries, { refetch }] = createResource(() => props.open ? project.id() : false, listExports);
  const refreshEntries = () => { void Promise.resolve(refetch()).catch(() => {}); };
  createEffect(() => {
    if (!props.open || entries.loading || entries.error) return;
    const records = entries()?.filter(entry => entry.projectId === project.id());
    if (!records) return;
    const current = untrack(selected);
    const next = records.find(entry => entry.id === current?.id) ?? records[0];
    setSelected(next);
    if (next?.id !== current?.id) setError('');
  });
  onMount(() => {
    const refresh = () => { if (props.open) refreshEntries(); };
    window.addEventListener('purecut:export-history-changed', refresh);
    onCleanup(() => window.removeEventListener('purecut:export-history-changed', refresh));
  });
  const location = createMemo(() => {
    const entry = selected();
    try { return { path: entry ? exportPath(entry, project.dir()) : undefined, error: '' }; }
    catch (cause) { return { path: undefined, error: String(cause) }; }
  });
  const selectedPath = () => location().path;
  const [preview] = createResource(() => props.open ? selectedPath() : undefined,
    async path => ({ ...await readPlatformFilePreviewUrl(path), path }));
  const locate = async () => {
    const entry = selected();
    if (!entry || locating()) return;
    const projectDir = project.dir();
    setLocating(true);
    setError('');
    try {
      const path = await openPlatformFileDialog();
      if (!path) return;
      if (!/\.(mp4|webm|mov|m4v|mkv|ogg|wav|mp3)$/i.test(path))
        throw Error('Choose an exported video or audio file.');
      await readPlatformFilePreviewUrl(path);
      await relocateExport(entry.id, entry.projectId, path, projectDir);
      const fresh = await refetch();
      if (project.id() === entry.projectId && selected()?.id === entry.id)
        setSelected(fresh?.find(item => item.id === entry.id));
    } catch (cause) { setError(String(cause)); }
    finally { setLocating(false); }
  };
  const remove = async (entry: ExportRecord) => {
    try {
      await forgetExport(entry.id, project.id());
      if (selected()?.id === entry.id) setSelected(undefined);
      await refetch();
    } catch (cause) { setError(String(cause)); }
  };
  const confirmTrash = async () => {
    const target = trashTarget();
    if (!target || trashing()) return;
    setTrashing(true); setError('');
    try {
      await trashExport(target.entry, target.dir, target.path);
      setTrashTarget(undefined);
      await refetch();
    } catch (cause) { setError(String(cause)); }
    finally { setTrashing(false); }
  };
  return <Dialog open={props.open} onOpenChange={props.onOpenChange}>
    <DialogPortal><DialogContent role="dialog" aria-label="Export history" class="cut-export-history w-[calc(100vw-32px)] sm:max-w-[1100px]" onKeyDown={event => { if (event.key !== 'Escape') event.stopPropagation(); }}>
      <DialogHeader><DialogTitle>Export history</DialogTitle></DialogHeader>
      <Show when={entries.loading}><p role="status">Loading exports...</p></Show>
      <Show when={entries.error || error()}><p role="alert">{String(entries.error || error())}</p></Show>
      <Show when={entries.error}><Button onClick={refreshEntries}>Retry loading exports</Button></Show>
      <div class="cut-export-review">
        <section aria-label="Export playback">
          <Show when={selected()} fallback={<p>Select an export to review.</p>}>
            <p>{exportDetails(selected()!)}</p>
            <Show when={typeof selected()?.sourceHash === 'string' ? selected()?.sourceHash : undefined}>{hash => <p class="cut-export-path" title={hash()}>Source revision: {hash().slice(0, 12)}</p>}</Show>
            <Show when={location().error}><p role="alert">{location().error}</p></Show>
            <Show when={preview.loading}><p role="status">Loading media...</p></Show>
            <Show when={preview.error}><p role="alert">This export could not be opened. The file may have moved or been deleted.</p></Show>
            <Show keyed when={selectedPath() && !preview.loading && !preview.error && preview()?.path === selectedPath() ? preview() : undefined}>{item => <>
              <Show when={isAudioExport(selected()!)} fallback={<video src={item.url} controls preload="metadata" onError={() => setError('This output cannot be played. Reveal the file to inspect it.')} />}>
                <audio aria-label="Export audio playback" src={item.url} controls preload="metadata" onError={() => setError('This output cannot be played. Reveal the file to inspect it.')} />
              </Show>
              <a href={item.url} download={selected()?.path.split('/').pop()}>Download {isAudioExport(selected()!) ? 'audio' : 'video'}</a>
            </>}</Show>
            <Button variant="ghost" disabled={!selectedPath()} onClick={() => { const path = selectedPath(); if (path) void revealPlatformPath(path).catch(e => setError(String(e))); }}>Reveal in Finder</Button>
            <p class="cut-export-path">{selectedPath()}</p>
            <Button variant="outline" disabled={locating()} onClick={() => void locate()}>{locating() ? 'Locating...' : 'Locate file...'}</Button>
            <Button variant="ghost" aria-label="Move exported file to Trash" title="Move exported file to Trash" disabled={!selectedPath() || trashing()} onClick={() => setTrashTarget({ entry: selected()!, path: selectedPath()!, dir: project.dir() })}><Icon name="trash" /></Button>
          </Show>
        </section>
        <section aria-label="Saved exports">
          <Show when={!entries.loading && !entries.error && !entries()?.length}><p>No exports yet.</p></Show>
          <For each={entries.error ? [] : entries()}>{entry => <div class="cut-export-row">
            <button aria-pressed={selected()?.id === entry.id} onClick={() => { setError(''); setSelected(entry); }}>
              <strong>{entry.path.split('/').pop()}</strong>
              <small>{new Date(entry.createdAt).toLocaleString()}</small>
              <small>{exportDetails(entry)}</small>
            </button>
            <Button variant="ghost" title="Remove history entry, keep file" aria-label={`Forget export ${entry.path.split('/').pop()}`} onClick={() => void remove(entry)}>Remove</Button>
          </div>}</For>
        </section>
      </div>
      <Dialog open={!!trashTarget()} onOpenChange={open => { if (!open && !trashing()) setTrashTarget(undefined); }}>
        <DialogPortal><DialogContent class="cut-export-confirmation" role="alertdialog" aria-label="Confirm export file removal" showCloseButton={false}
          onOpenAutoFocus={event => { event.preventDefault(); cancelTrash?.focus(); }}
          onEscapeKeyDown={event => { if (trashing()) event.preventDefault(); }}
          onPointerDownOutside={event => event.preventDefault()}>
          <DialogHeader><DialogTitle>Move exported file to Trash?</DialogTitle></DialogHeader>
          <p class="cut-export-path">{trashTarget()?.path}</p>
          <DialogDescription>Other references to this file will stop working. You can restore the file from Trash.</DialogDescription>
          <Show when={error()}><p role="alert">{error()}</p></Show>
          <DialogFooter>
            <Button ref={cancelTrash} variant="outline" disabled={trashing()} onClick={() => setTrashTarget(undefined)}>Cancel</Button>
            <Button disabled={trashing()} onClick={() => void confirmTrash()}>{trashing() ? 'Moving...' : 'Move to Trash'}</Button>
          </DialogFooter>
        </DialogContent></DialogPortal>
      </Dialog>
    </DialogContent></DialogPortal>
  </Dialog>;
}
