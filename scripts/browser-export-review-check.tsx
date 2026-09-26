import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { ProjectProvider } from '../apps/web/src/context/project';
import { ExportHistory } from '../apps/web/src/components/command-bar/export-history';
import type { ProjectInfo } from '../apps/web/src/projects';

export async function checkExportReview(bytes: Uint8Array, bridge: { call: (...args: any[]) => Promise<any> }, inspectConfirmation?: () => Promise<void>) {
  const urls = [0, 1].map(() => URL.createObjectURL(new Blob([bytes], { type: 'video/webm' })));
  const wav = new ArrayBuffer(44 + 16000);
  const data = new DataView(wav);
  const label = (offset: number, text: string) => [...text].forEach((char, i) => data.setUint8(offset + i, char.charCodeAt(0)));
  label(0, 'RIFF'); data.setUint32(4, wav.byteLength - 8, true); label(8, 'WAVE');
  label(12, 'fmt '); data.setUint32(16, 16, true); data.setUint16(20, 1, true);
  data.setUint16(22, 1, true); data.setUint32(24, 8000, true); data.setUint32(28, 16000, true);
  data.setUint16(32, 2, true); data.setUint16(34, 16, true); label(36, 'data'); data.setUint32(40, 16000, true);
  for (let i = 0; i < 8000; i++) data.setInt16(44 + i * 2, Math.sin(i * 2 * Math.PI * 440 / 8000) * 4000, true);
  urls.push(URL.createObjectURL(new Blob([wav], { type: 'audio/wav' })));
  const host = document.createElement('div');
  document.body.append(host);
  const originalCall = bridge.call;
  const [open, setOpen] = createSignal(true);
  let version = 0;
  let unavailable = false;
  const trashed: string[] = [];
  let trashFails = false;
  let history = ['a', 'b', 'missing', 'invalid'].map((id, index) => ({
    id, projectId: 'review-fixture', path: `/fixture/renders/${id}.webm`,
    relativePath: id === 'invalid' ? '../outside.webm' : `renders/${id}.webm`,
    createdAt: `2026-01-0${4 - index}T00:00:00Z`, sourceHash: id,
    config: { format: 'webm', video: { fps: 30, resolution: 180 } },
  }));
  history.push({ id: 'audio', projectId: 'review-fixture', path: '/fixture/renders/audio.wav',
    relativePath: 'renders/audio.wav', createdAt: '2025-12-01T00:00:00Z', sourceHash: 'audio',
    config: { format: 'wav', video: { fps: 30, resolution: 180 } } });
  bridge.call = async (method, args) => {
    if (method === 'storage.readJson') {
      if (unavailable) throw Error('History temporarily unavailable');
      return { value: structuredClone(history), version: String(version) };
    }
    if (method === 'storage.writeJson') {
      history = args[0].value; version++;
      return { ok: true };
    }
    if (method === 'fs.previewUrl') {
      const path = args[0].path;
      if (path.endsWith('/missing.webm')) throw Error('Missing output');
      if (path.endsWith('/audio.wav')) return { url: urls[2], mimeType: 'audio/wav' };
      return { url: path.endsWith('/a.webm') ? urls[0] : urls[1], mimeType: 'video/webm' };
    }
    if (method === 'os.trash') {
      if (trashFails) throw Error('Trash unavailable');
      trashed.push(args[0]);
      return { ok: true };
    }
    throw Error(`Unexpected review bridge call: ${method}`);
  };
  const dispose = render(() => <ProjectProvider project={{ id: 'review-fixture', dir: '/fixture', displayName: 'Review fixture' } as ProjectInfo}>
    <ExportHistory open={open()} onOpenChange={setOpen} />
  </ProjectProvider>, host);
  const panel = () => document.querySelector('[role="dialog"][aria-label="Export history"]')!;
  const wait = async (predicate: () => unknown, message: string) => {
    const deadline = performance.now() + 10000;
    while (!predicate()) {
      if (performance.now() > deadline) throw Error(message);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  const choose = (name: string) => {
    const button = [...panel().querySelectorAll<HTMLButtonElement>('.cut-export-row button')]
      .find(button => button.querySelector('strong')?.textContent === name);
    if (!button) throw Error(`Missing export row: ${name}`);
    button.click();
  };
  try {
    await wait(() => panel()?.querySelector('video')?.readyState! >= 2, 'latest export did not load');
    const first = panel().querySelector('video')!;
    if (first.src !== urls[0] || first.videoWidth !== 320) throw Error('latest export must be selected and decoded');
    await first.play();
    await wait(() => first.currentTime > 0, 'export player does not advance');
    first.pause();
    choose('b.webm');
    await wait(() => panel()?.querySelector('video')?.src === urls[1], 'selecting another export did not replace the player');
    if (panel().querySelector('a[download]')?.getAttribute('download') !== 'b.webm') throw Error('download must follow selection');
    choose('audio.wav');
    await wait(() => panel()?.querySelector('audio')?.readyState! >= 2, 'audio export did not decode');
    if (panel().querySelector('video')) throw Error('audio export must not retain the video player');
    if (panel().querySelector('a[download]')?.textContent !== 'Download audio') throw Error('audio download label is wrong');
    const audio = panel().querySelector('audio')!;
    await audio.play();
    await wait(() => audio.currentTime > 0, 'audio export playback does not advance');
    audio.pause();
    choose('missing.webm');
    await wait(() => panel()?.textContent?.includes('The file may have moved'), 'missing file has no recovery message');
    if (panel().querySelector('video')) throw Error('missing output must not show the previous video');
    choose('a.webm');
    await wait(() => panel()?.querySelector('video')?.src === urls[0], 'valid output does not recover after missing file');
    choose('invalid.webm');
    await wait(() => panel()?.textContent?.includes('Invalid export location'), 'invalid location has no error');
    if (panel().querySelector('video')) throw Error('invalid path must not keep a stale player');
    setOpen(false);
    await wait(() => !panel(), 'history did not close');
    setOpen(true);
    await wait(() => panel()?.querySelectorAll('.cut-export-row').length === 5, 'history did not reload on reopening');
    unavailable = true;
    window.dispatchEvent(new Event('purecut:export-history-changed'));
    await wait(() => panel()?.textContent?.includes('Retry loading exports'), 'history storage failure must offer retry');
    unavailable = false;
    [...panel().querySelectorAll('button')].find(button => button.textContent === 'Retry loading exports')!.click();
    await wait(() => panel()?.querySelectorAll('.cut-export-row').length === 5, 'history retry did not restore entries');
    choose('b.webm');
    await wait(() => panel()?.querySelector('video')?.src === urls[1], 'history selection after retry failed');
    panel().querySelector<HTMLButtonElement>('[aria-label="Forget export b.webm"]')!.click();
    await wait(() => panel()?.querySelectorAll('.cut-export-row').length === 4, 'forget did not remove history entry');
    await wait(() => panel()?.querySelector('video')?.src === urls[0], 'forgetting the selected output did not select another video');
    if (trashed.length) throw Error('Forget must never trash files');
    const trashButton = () => panel().querySelector<HTMLButtonElement>('[aria-label="Move exported file to Trash"]')!;
    const confirmation = () => document.querySelector('[aria-label="Confirm export file removal"]');
    trashButton().click();
    await wait(confirmation, 'trash action needs confirmation');
    await wait(() => document.activeElement?.textContent === 'Cancel', 'confirmation must focus the safe action');
    await inspectConfirmation?.();
    [...confirmation()!.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Cancel')!.click();
    await wait(() => !confirmation(), 'Cancel must close the confirmation');
    if (trashed.length) throw Error('Cancel must leave the file intact');
    trashButton().click();
    trashFails = true;
    const confirm = () => [...confirmation()!.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Move to Trash')!;
    confirm().click();
    await wait(() => panel().textContent?.includes('Trash unavailable'), 'trash failure must be visible');
    if (trashed.length || !history.some(entry => entry.id === 'a')) throw Error('Failed trash must preserve history');
    trashFails = false;
    confirm().click();
    await wait(() => trashed.length === 1 && !history.some(entry => entry.id === 'a'), 'confirmed trash did not remove file and entry');
    if (trashed[0] !== '/fixture/renders/a.webm') throw Error('Trash targeted the wrong file');
    const { trashExport } = await import('../apps/web/src/lib/export-history');
    const rejectTrash = async (entry: typeof history[number], path: string, expected: RegExp) => {
      try { await trashExport(entry, '/fixture', path); }
      catch (error) {
        if (!expected.test(String(error))) throw error;
        if (trashed.length !== 1) throw Error('Rejected removal touched a file');
        return;
      }
      throw Error('Unsafe removal was accepted');
    };
    const source = { ...history[0]!, id: 'source', path: '/fixture/assets/source.webm', relativePath: undefined };
    history.push(source as typeof history[number]);
    await rejectTrash(source as typeof history[number], source.path, /source files/);
    const stale = { ...history[0]! };
    await rejectTrash(stale, '/fixture/renders/old-location.webm', /changed/);
    await rejectTrash({ ...stale, id: 'removed' }, stale.path, /changed/);
  } finally {
    dispose(); host.remove(); bridge.call = originalCall;
    for (const url of urls) URL.revokeObjectURL(url);
  }
}
