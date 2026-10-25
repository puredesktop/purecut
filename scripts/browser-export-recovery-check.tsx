import { render } from 'solid-js/web';
import { toast, Toaster } from 'somoto';
import { AssetLibrary, type ProjectFS } from '@diffusionstudio/assets';
import { CanvasSource } from 'mediabunny';
import { bridge as storageBridge } from '@purescience/platform-ui/bridge/client.mjs';
import { Library } from '@diffusionstudio/runtime';
import { EngineProvider, useEngineContext, type Engine } from '../apps/web/src/engine';
import { createRuntimeDocument } from '../packages/reconciler/src';
import { ExportProvider, useExport } from '../apps/web/src/context/export';
import { ProjectProvider } from '../apps/web/src/context/project';
import { rememberProjectBundle, forgetProjectBundle } from '../apps/web/src/lib/db';
import { mainBridge } from '../apps/web/src/lib/ipc';
import { MAIN_CHANNELS } from '../purecut/editor-core/main-channels';
import { cancelRender, renderOverlay, type ExportConfig } from '../apps/web/src/context/render';
import type { ProjectInfo } from '../apps/web/src/projects';

const RECT_BUNDLE = `
  const { Stage, Scene, Rect } = require('@diffusionstudio/jsx');
  module.exports.default = () => Stage({ get children() {
    return Scene({ __source: 'retry-scene', name: 'Opening shot', width: 320, height: 180, get children() {
      return Rect({ width: 320, height: 180, end: 1, fill: '#163f41' });
    }});
  }});
`;

export async function checkExportRecovery(bridge: { call: (...args: any[]) => Promise<any> }) {
  const projectId = 'export-retry-fixture';
  const host = document.createElement('div');
  document.body.append(host);
  const originalBridgeCall = bridge.call;
  const originalStorageBridgeCall = storageBridge.call;
  const originalMainCall = mainBridge.call;
  const originalVideoAdd = CanvasSource.prototype.add;
  let api!: ReturnType<typeof useExport>;
  let engine!: Engine;
  let history: unknown[] = [];
  let historyVersion = 0;
  let failWrites = false;
  let failChunks = false;
  let writeAttempts = 0;
  let chunkAttempts = 0;
  let videoFramesAdded = 0;
  let aborts = 0;
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

  const handleBridgeCall = async (method: string, args: any[]) => {
    if (method === 'storage.readJson') return { value: structuredClone(history), version: String(historyVersion) };
    if (method === 'storage.writeJson') {
      history = structuredClone(args[0].value);
      historyVersion++;
      return { ok: true };
    }
    throw Error(`Unexpected export bridge call: ${method}`);
  };
  bridge.call = handleBridgeCall;
  storageBridge.call = handleBridgeCall;
  mainBridge.call = (async (channel: string) => {
    if (channel === MAIN_CHANNELS.FILE_WRITE_OPEN) {
      writeAttempts++;
      if (failWrites) throw Error('Fixture destination is full');
      return { id: 'retry-export-stream' };
    }
    if (channel === MAIN_CHANNELS.FILE_WRITE_CHUNK) {
      chunkAttempts++;
      if (failChunks && chunkAttempts > 1) throw Error('Fixture destination filled during export');
      return {};
    }
    if (channel === MAIN_CHANNELS.FILE_WRITE_CLOSE) return {};
    if (channel === MAIN_CHANNELS.FILE_WRITE_ABORT) { aborts++; return {}; }
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
  const retryAction = () => {
    const action = failure()?.action;
    check(action && typeof action === 'object' && 'label' in action && action.label === 'Retry export', 'failure must expose a Retry export action');
    return (action as { onClick: () => void }).onClick;
  };
  const retry = async (settled: () => unknown) => {
    retryAction();
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
    check(description.includes('. Details:'), `${stage} failure must separate error details from the next step`);
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
    await retry(() => renderAttempts === 2);
    await expectFailure('render', 'Try the export again');
    engine.stop = originalStop;
    toast.dismiss();

    await rememberProjectBundle(projectId, RECT_BUNDLE.replace("Rect({ width: 320, height: 180, end: 1, fill: '#163f41' })", "Video({ src: 'broken.webm', width: 320, height: 180, end: 1 })").replace("const { Stage, Scene, Rect }", "const { Stage, Scene, Video }"));
    library.resolve = (() => { decodeAttempts++; return Promise.reject(Error('Fixture media decode failure')); }) as typeof originalResolve;
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
    check(aborts === 1, 'a failed export must dispose its partial file');
    const staleRetry = retryAction();
    await retry(() => encodeAttempts === 2);
    await expectFailure('encode', 'resolution or another codec');
    check(aborts === 2, 'every failed retry must dispose its partial file');

    engine.stop = () => { throw Error('Later attempt failed before rendering'); };
    await api.exportScene(scene.entity, { ...config, format: 'ogg' });
    await expectFailure('render', 'Try the export again');
    engine.stop = originalStop;
    staleRetry();
    await wait(() => encodeAttempts === 3, 'an older Retry must keep its own settings');
    await expectFailure('encode', 'resolution or another codec');
    check(aborts === 3, 'an older Retry must clean up its own failed output');
    CanvasSource.prototype.add = originalVideoAdd;
    toast.dismiss();

    failWrites = true;
    await api.exportScene(scene.entity, config);
    await expectFailure('write', 'destination');
    const firstWriteAttempts = writeAttempts;
    await retry(() => writeAttempts === firstWriteAttempts + 1);
    await expectFailure('write', 'destination');
    failWrites = false;
    toast.dismiss();

    const chunkedConfig: ExportConfig = { ...config, chunkSize: 1024 };
    CanvasSource.prototype.add = (async function (this: CanvasSource, ...args: Parameters<CanvasSource['add']>) {
      await originalVideoAdd.apply(this, args);
      videoFramesAdded++;
    }) as typeof originalVideoAdd;
    failChunks = true;
    await api.exportScene(scene.entity, chunkedConfig);
    await expectFailure('write', 'free space');
    CanvasSource.prototype.add = originalVideoAdd;
    check(chunkAttempts === 2, 'the chunk-write fixture must fail after a successful chunk write');
    check(videoFramesAdded > 0 && videoFramesAdded < 24, 'the chunk write must fail while frames are still being encoded');
    check(aborts === 4, 'a chunk-write failure must dispose its partial file');
    const deletedSceneRetry = retryAction();
    failChunks = false;
    toast.dismiss();

    await rememberProjectBundle(projectId, RECT_BUNDLE.replace('end: 1', 'end: 600'));
    const beforeCancelWriteAttempts = writeAttempts;
    const pending = api.exportScene(scene.entity, config);
    await wait(() => renderOverlay(), 'long export did not start');
    await api.exportScene(scene.entity, { ...config, video: { ...config.video, bitrate: 123_456 } });
    const busy = toast.getHistory().find(entry => 'title' in entry && entry.title === 'Export already running');
    check(busy, 'a concurrent export must explain that an export is already running');
    check(!(busy as { action?: unknown }).action, 'a busy export must not offer Retry');
    await wait(() => writeAttempts > beforeCancelWriteAttempts, 'long export did not open its output file');
    await wait(() => (renderOverlay()?.progress ?? 0) > 0, 'long export did not start encoding');
    const beforeCancelAborts = aborts;
    cancelRender();
    await pending;
    check(aborts === beforeCancelAborts + 1, `a cancelled export must dispose its partial file (aborts ${beforeCancelAborts} -> ${aborts})`);

    await rememberProjectBundle(projectId, RECT_BUNDLE);
    await deletedSceneRetry();
    await wait(() => history.length === 1, 'successful retry did not finish');
    check(JSON.stringify((history[0] as { config: unknown }).config) === JSON.stringify(chunkedConfig), 'successful retry history must preserve every export setting');
    check(toast.getHistory().some(entry => 'title' in entry && entry.title === 'Export complete'), 'successful retry must report completion');

    scene.entity.destroy();
    deletedSceneRetry();
    await wait(() => toast.getHistory().some(entry => 'title' in entry && entry.title === 'Scene no longer available'), 'Retry after scene deletion must explain what happened');
  } finally {
    CanvasSource.prototype.add = originalVideoAdd;
    library.resolve = originalResolve;
    engine.stop = originalStop;
    runtimeDocument.dispose();
    dispose();
    host.remove();
    bridge.call = originalBridgeCall;
    storageBridge.call = originalStorageBridgeCall;
    mainBridge.call = originalMainCall;
    toast.dismiss();
    await library.dispose();
    await forgetProjectBundle(projectId);
  }
}
