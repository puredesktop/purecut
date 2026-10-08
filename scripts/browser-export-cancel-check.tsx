import { render } from 'solid-js/web';
import { createRuntimeWorld } from '../packages/runtime/src';
import { createRuntimeDocument } from '../packages/reconciler/src';
import { rememberProjectBundle, forgetProjectBundle } from '../apps/web/src/lib/db';
import { renderScene, renderOverlay } from '../apps/web/src/context/render';
import { RenderProgress } from '../apps/web/src/components/sidebar-right/inspector/export-progress';
import type { Engine } from '../apps/web/src/engine';

/**
 * The export overlay's cancel button asks first. Drives a real render through
 * the same overlay ExportProvider mounts: Cancel opens the confirmation, Keep
 * exporting (and Escape) leave the encode running, Stop export cancels it, the
 * overlay closes and the preview engine restarts exactly once. An audio-only
 * render says so, and confirming during capture setup still cancels.
 */
export async function checkExportCancel(inspect?: (stage: 'progress' | 'confirm') => Promise<void>) {
  const name = 'export-cancel-fixture';
  const world = createRuntimeWorld(name);
  const document = createRuntimeDocument(world);
  const scene = document.createElement('Scene');
  document.setProperty(scene, '__source', 'cancel-scene');
  document.insertNode(document.stage, scene);
  // Long enough that the encode is still running after every interaction.
  await rememberProjectBundle(name, `
    const { Stage, Scene, Rect } = require('@diffusionstudio/jsx');
    module.exports.default = () => Stage({ get children() {
      return Scene({ __source: 'cancel-scene', width: 320, height: 180, get children() {
        return [Rect({ width: 320, height: 180, end: 600, fill: '#163f41' }),
          Rect({ x: 40, y: 80, width: 240, height: 20, end: 600, fill: '#e2a64e' })];
      }});
    }});
  `);
  let stopped = 0, started = 0, writes = 0;
  const engine = { world, stop: () => stopped++, start: () => started++ } as unknown as Engine;
  const target = { createWritable: async () => new WritableStream({ write() { writes++; } }) };
  const host = globalThis.document.createElement('div');
  globalThis.document.body.append(host);
  const dispose = render(() => <RenderProgress />, host);

  const check = (value: unknown, message: string) => { if (!value) throw Error(message); };
  const wait = async (predicate: () => unknown, message: string, ms = 15000) => {
    const deadline = performance.now() + ms;
    while (!predicate()) {
      if (performance.now() > deadline) throw Error(message);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  const overlay = () => globalThis.document.querySelector<HTMLElement>('[role="dialog"][aria-label="Export progress"]');
  const confirmation = () => globalThis.document.querySelector<HTMLElement>('[role="alertdialog"]');
  const button = (root: ParentNode | null, label: string) => {
    const found = [...(root?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(b => b.textContent?.trim() === label);
    if (!found) throw Error(`Missing button: ${label}`);
    return found;
  };
  const progress = () => renderOverlay()?.progress ?? 0;
  const shownProgress = () => Number(overlay()?.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow'));

  try {
    // --- Video export: keep exporting, then stop.
    const pending = renderScene(engine, { scene: scene.entity, target,
      config: { format: 'webm', video: { codec: 'vp8', resolution: 180, fps: 30, bitrate: 300_000 }, audio: { enabled: false } } });
    await wait(() => overlay(), 'export overlay did not open');
    check(overlay()!.textContent?.includes('Exporting video...'), 'video export must say it is exporting video');
    await wait(() => progress() > 0, `encode did not start (progress ${progress()}, writes ${writes})`, 30000);
    check(shownProgress() === progress(), 'overlay must show the render progress');
    await inspect?.('progress');

    button(overlay(), 'Cancel export').click();
    await wait(confirmation, 'Cancel must ask for confirmation');
    check(confirmation()!.textContent?.includes('Stop exporting?'), 'confirmation names the decision');
    await wait(() => globalThis.document.activeElement?.textContent?.trim() === 'Keep exporting', 'confirmation must focus the safe action');
    const whileAsking = progress();
    await wait(() => progress() > whileAsking, 'export must keep running while the confirmation is open');
    await inspect?.('confirm');

    button(confirmation(), 'Keep exporting').click();
    await wait(() => !confirmation(), 'Keep exporting must close the confirmation');
    check(overlay(), 'Keep exporting must leave the export overlay open');
    const afterKeep = progress();
    await wait(() => progress() > afterKeep, 'export must continue after Keep exporting');
    check(started === 0, 'preview engine must stay stopped while exporting');

    button(overlay(), 'Cancel export').click();
    await wait(confirmation, 'Cancel must ask again');
    globalThis.document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await wait(() => !confirmation(), 'Escape must close the confirmation');
    check(overlay() && renderOverlay(), 'Escape must keep the export running');

    button(overlay(), 'Cancel export').click();
    await wait(confirmation, 'Cancel must ask a third time');
    const before = progress();
    button(confirmation(), 'Stop export').click();
    const result = await pending;
    check(result.type === 'canceled', `confirmed stop must cancel: ${JSON.stringify(result)}`);
    check(before < 100, 'cancel must land before the encode finished');
    await wait(() => !overlay() && !confirmation(), 'overlay and confirmation must close after cancelling');
    check(!renderOverlay(), 'render slot must be released');
    check(stopped === 1 && started === 1, `engine must stop once and restart once (stopped ${stopped}, started ${started})`);

    // --- Audio-only export, stopped during capture setup.
    const audio = renderScene(engine, { scene: scene.entity, target,
      config: { format: 'ogg', video: { enabled: false }, audio: { codec: 'opus', sampleRate: 48000, numberOfChannels: 1 } } });
    await wait(() => overlay(), 'audio export overlay did not open');
    check(overlay()!.textContent?.includes('Exporting audio...'), 'audio-only export must say it is exporting audio');
    check(!overlay()!.textContent?.includes('Exporting video...'), 'audio-only export must not claim video');
    button(overlay(), 'Cancel export').click();
    await wait(confirmation, 'audio Cancel must ask for confirmation');
    button(confirmation(), 'Stop export').click();
    const audioResult = await audio;
    check(audioResult.type === 'canceled', `confirmed stop must cancel the audio export: ${JSON.stringify(audioResult)}`);
    await wait(() => !overlay() && !confirmation(), 'audio overlay must close after cancelling');
    check(stopped === 2 && started === 2, `engine must restart after the audio cancel (stopped ${stopped}, started ${started})`);

    // --- A finished render closes an open confirmation with it.
    await rememberProjectBundle(name, `
      const { Stage, Scene, Rect } = require('@diffusionstudio/jsx');
      module.exports.default = () => Stage({ get children() {
        return Scene({ __source: 'cancel-scene', width: 320, height: 180, get children() {
          return Rect({ width: 320, height: 180, end: 1, fill: '#163f41' });
        }});
      }});
    `);
    const short = renderScene(engine, { scene: scene.entity, target,
      config: { format: 'webm', video: { codec: 'vp8', resolution: 180, fps: 30, bitrate: 300_000 }, audio: { enabled: false } } });
    await wait(() => overlay(), 'short export overlay did not open');
    button(overlay(), 'Cancel export').click();
    const shortResult = await short;
    check(shortResult.type === 'success', `unconfirmed cancel must not stop the export: ${JSON.stringify(shortResult)}`);
    await wait(() => !overlay() && !confirmation(), 'a finished export must take its confirmation with it');
    check(stopped === 3 && started === 3, 'engine restarts after a finished export');
  } finally {
    dispose();
    host.remove();
    await forgetProjectBundle(name);
  }
}
