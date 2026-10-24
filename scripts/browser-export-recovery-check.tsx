import { render } from 'solid-js/web';
import { toast, Toaster } from 'somoto';
import { AssetLibrary, type ProjectFS } from '@diffusionstudio/assets';
import { CanvasSource } from 'mediabunny';
import { Library } from '@diffusionstudio/runtime';
import { EngineProvider, useEngineContext, type Engine } from '../apps/web/src/engine';
import { createRuntimeDocument } from '../packages/reconciler/src';
import { ExportProvider, useExport } from '../apps/web/src/context/export';
import { ProjectProvider } from '../apps/web/src/context/project';
import { rememberProjectBundle, forgetProjectBundle } from '../apps/web/src/lib/db';
import { mainBridge } from '../apps/web/src/lib/ipc';
import { MAIN_CHANNELS } from '../purecut/editor-core/main-channels';
import { type ExportConfig } from '../apps/web/src/context/render';
import type { ProjectInfo } from '../apps/web/src/projects';

const RECT_BUNDLE = `
  const { Stage, Scene, Rect } = require('@diffusionstudio/jsx');
  module.exports.default = () => Stage({ get children() {
    return Scene({ __source: 'retry-scene', name: 'Opening shot', width: 320, height: 180, get children() {
      return Rect({ width: 320, height: 180, end: 1, fill: '#163f41' });
    }});
  }});
`;

export async function checkExportRecovery(bridge: { call: (...args: any[]) => Promise<any> }, inspect?: () => Promise<void>) {
  const projectId = 'export-retry-fixture';
  const host = document.createElement('div');
  document.body.append(host);
  const originalBridgeCall = bridge.call;
  const originalMainCall = mainBridge.call;
  const originalVideoAdd = CanvasSource.prototype.add;
  let api!: ReturnType<typeof useExport>;
  let engine!: Engine;
  let history: unknown[] = [];
  let historyVersion = 0;
  let failWrites = false;
  let writeAttempts = 0;
  const check = (value: unknown, message: string) => { if (!value) throw Error(message); };
  const wait = async (predicate: () => unknown, message: string) => {
    const deadline = performance.now() + 10000;
    while (!predicate()) {
      if (performance.now() > deadline) throw Error(message);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  const config: ExportConfig = {
    format: 'webm',
    video: { enabled: true, codec: 'vp8', resolution: 180, fps: 24, bitrate: 432_109 },
    audio: { enabled: false, codec: 'opus', sampleRate: 44100, numberOfChannels: 1 },
  };
  const configSnapshot = structuredClone(config);

  bridge.call = async (method, args) => {
    if (method === 'storage.readJson') return { value: structuredClone(history), version: String(historyVersion) };
    if (method === 'storage.writeJson') {
      history = structuredClone(args[0].value);
      historyVersion++;
      return { ok: true };
    }
    throw Error(`Unexpected export bridge call: ${method}`);
  };
  mainBridge.call = (async (channel: string) => {
    if (channel === MAIN_CHANNELS.FILE_WRITE_OPEN) {
      writeAttempts++;
      if (failWrites) throw Error('Fixture destination is full');
      return { id: 'retry-export-stream' };
    }
    if (channel === MAIN_CHANNELS.FILE_WRITE_CHUNK || channel === MAIN_CHANNELS.FILE_WRITE_CLOSE || channel === MAIN_CHANNELS.FILE_WRITE_ABORT) return {};
    throw Error(`Unexpected export main call: ${channel}`);
  }) as typeof mainBridge.call;

  const Probe = () => {
    api = useExport();
    engine = useEngineContext();
    return null;
  };
  const dispose = render(() => <>
    <ProjectProvider project={{ id: projectId, dir: '', displayName: 'Retry fixture' } as ProjectInfo}>
      <EngineProvider projectId={projectId}>
        <ExportProvider><Probe /></ExportProvider>
      </EngineProvider>
    </ProjectProvider>
    <Toaster />
  </>, host);
  const runtimeDocument = createRuntimeDocument(engine.world);
  const scene = runtimeDocument.createElement('Scene');
  runtimeDocument.setProperty(scene, '__source', 'retry-scene');
  runtimeDocument.setProperty(scene, 'name', 'Opening shot');
  runtimeDocument.insertNode(runtimeDocument.stage, scene);

  let decodeAttempts = 0;
  const files = new Map<string, File>();
  const fs: ProjectFS = {
    readManifest: async () => null, writeManifest: async () => {}, list: async () => [],
    stat: async path => files.has(path) ? { size: files.get(path)!.size, mtime: 0 } : null,
    file: async path => {
      if (path.endsWith('broken.webm')) decodeAttempts++;
      const file = files.get(path);
      if (!file) throw Error(`Missing ${path}`);
      return file;
    },
    write: async () => {}, remove: async path => { files.delete(path); },
  };
  const library = new AssetLibrary(fs);
  const originalResolve = library.resolve;
  engine.world.set(Library, library);

  const failure = () => toast.getHistory().filter(entry => 'title' in entry && entry.title === 'Export failed').at(-1);
  let lastFailure: unknown;
  const retry = async (settled: () => unknown) => {
    const action = failure()?.action;
    check(action && typeof action === 'object' && 'label' in action && action.label === 'Retry export', 'failure must expose a Retry export action');
    const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent?.trim() === 'Retry export');
    check(button, 'Retry export must be a real button');
    button!.click();
    await wait(settled, 'retried export did not settle');
  };
  const expectFailure = async (stage: string, nextStep: string) => {
    await wait(() => failure() && failure() !== lastFailure, `${stage} failure was not reported`);
    const current = failure()!;
    lastFailure = current;
    const description = String(current.description ?? '');
    check(description.includes(nextStep), `${stage} failure must explain the next step: ${description}`);
    check(current.duration === Infinity, `${stage} failure must keep Retry available`);
    check(JSON.stringify(config) === JSON.stringify(configSnapshot), `${stage} failure changed the selected settings`);
  };

  const originalStop = engine.stop;
  try {
    await rememberProjectBundle(projectId, RECT_BUNDLE);
    let renderAttempts = 0;
    engine.stop = () => { renderAttempts++; throw Error('Fixture render failure'); };
    toast('Unrelated notice', { duration: Infinity });
    await api.exportScene(scene.entity, config);
    await expectFailure('render', 'Try the export again');
    check(host.textContent?.includes('Unrelated notice'), 'export failures must not dismiss unrelated notifications');
    await inspect?.();
    await retry(() => renderAttempts === 2);
    await expectFailure('render', 'Try the export again');
    engine.stop = originalStop;
    toast.dismiss();

    await rememberProjectBundle(projectId, RECT_BUNDLE.replace("Rect({ width: 320, height: 180, end: 1, fill: '#163f41' })", "Video({ src: 'broken.webm', width: 320, height: 180, end: 1 })").replace("const { Stage, Scene, Rect }", "const { Stage, Scene, Video }"));
    library.resolve = (() => { decodeAttempts++; throw Error('Fixture media decode failure'); }) as typeof originalResolve;
    await api.exportScene(scene.entity, config);
    await expectFailure('decode', 'source media');
    const firstDecodeAttempts = decodeAttempts;
    await retry(() => decodeAttempts > firstDecodeAttempts);
    await expectFailure('decode', 'source media');
    library.resolve = originalResolve;
    toast.dismiss();

    await rememberProjectBundle(projectId, RECT_BUNDLE);
    let encodeAttempts = 0;
    CanvasSource.prototype.add = (async () => { encodeAttempts++; throw Error('Fixture encoder failure'); }) as typeof originalVideoAdd;
    await api.exportScene(scene.entity, config);
    await expectFailure('encode', 'resolution or another codec');
    await retry(() => encodeAttempts === 2);
    await expectFailure('encode', 'resolution or another codec');
    CanvasSource.prototype.add = originalVideoAdd;
    toast.dismiss();

    failWrites = true;
    await api.exportScene(scene.entity, config);
    await expectFailure('write', 'destination');
    const firstWriteAttempts = writeAttempts;
    await retry(() => writeAttempts === firstWriteAttempts + 1);
    await expectFailure('write', 'destination');
    failWrites = false;
    await retry(() => history.length === 1);
    check(JSON.stringify((history[0] as { config: unknown }).config) === JSON.stringify(configSnapshot), 'successful retry history must preserve every export setting');
    check(toast.getHistory().some(entry => 'title' in entry && entry.title === 'Export complete'), 'successful retry must report completion');
  } finally {
    CanvasSource.prototype.add = originalVideoAdd;
    library.resolve = originalResolve;
    engine.stop = originalStop;
    runtimeDocument.dispose();
    dispose();
    host.remove();
    bridge.call = originalBridgeCall;
    mainBridge.call = originalMainCall;
    toast.dismiss();
    await library.dispose();
    await forgetProjectBundle(projectId);
  }
}
