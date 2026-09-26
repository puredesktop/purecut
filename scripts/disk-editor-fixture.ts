export async function openDiskEditor(host: HTMLElement, root: string, dir?: string) {
  const { initializeTransport, request } = await import('../purecut/transport');
  const { files } = await import('../purecut/lib/platform-files');
  const { ProjectService } = await import('../purecut/lib/projects');
  const timings: { channel: string; ms: number }[] = [];
  const dispatch = ProjectService.prototype.dispatch;
  ProjectService.prototype.dispatch = async function(channel, data) {
    const start = performance.now();
    try { return await dispatch.call(this, channel, data); }
    finally { timings.push({ channel, ms: performance.now() - start }); }
  };
  const disk = (window as any).fixtureDisk as (method: string, path: string, value?: string) => Promise<any>;
  files.root = async () => root;
  files.read = path => disk('read', path);
  files.write = (path, value) => disk('write', path, value);
  files.list = path => disk('list', path);
  files.remove = path => disk('remove', path);
  files.file = async path => {
    const value = await disk('readBinary', path);
    return new File([Uint8Array.from(atob(value.base64), char => char.charCodeAt(0))], path.split('/').pop()!, { type: 'video/webm', lastModified: value.mtime });
  };
  files.binary = async (path, blob) => {
    const base64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]!);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
    await disk('writeBinary', path, base64);
  };
  // Workspace metadata has no meaning in this standalone browser. Project IO
  // still runs through the real service, transport, compiler and edit writer.
  const { bridge } = await import('@purescience/platform-ui/bridge/client.mjs');
  bridge.call = async (method: string, args: any[] = []) => {
    if (method === 'workspace.updateCurrentTab') return { updated: true };
    if (method === 'storage.readJson') return disk('storageRead', `${root}/export-history.json`);
    if (method === 'storage.writeJson') return disk('storageWrite', `${root}/export-history.json`, JSON.stringify(args[0]));
    if (method === 'fs.previewUrl') return { url: URL.createObjectURL(await files.file(args[0].path)), mimeType: 'video/webm' };
    throw Error(`Unexpected fixture workspace call: ${method}`);
  };
  await initializeTransport();
  const project = dir ? await request('projects:get', { dir }) : await request('projects:create', { displayName: 'Disk recovery verification' });
  const { openProjectFolder } = await import('../apps/web/src/projects/host');
  await openProjectFolder(project.dir);
  const { mountEditor } = await import('../purecut/entry');
  const { lightTheme } = await import('@purescience/platform-ui/theme/themes/light');
  const { themeToRootCssBlock } = await import('@purescience/platform-ui/theme/utils/cssVariables');
  const style = document.createElement('style');
  style.textContent = themeToRootCssBlock(lightTheme);
  document.head.append(style);
  document.documentElement.dataset.platformTheme = 'light';
  host.id = 'cut-editor';
  host.style.cssText = 'width:100vw;height:100vh;overflow:hidden';
  location.hash = `/projects/${project.id}`;
  const started = performance.now();
  const dispose = mountEditor(host);
  const { editorSession } = await import('../apps/web/src/dapi/session');
  const { Source, Chars, isText, isScene, Library } = await import('../packages/runtime/src');
  const { flushPendingProjectEdits } = await import('../apps/web/src/projects/edits');
  return {
    dir: project.dir,
    started,
    timings,
    state() {
      const session = editorSession();
      const text = session?.world.query(Source).filter(isText).map(entity => entity.get(Chars)?.value) ?? [];
      return { text, ready: text.length === 2, assets: session?.world.get(Library)?.list().map(asset => ({ type: asset.type, path: asset.path })) ?? [] };
    },
    async exportVideo(name: string) {
      await flushPendingProjectEdits();
      const world = editorSession()!.world;
      const scene = world.query(Source).find(isScene)!;
      const { ProjectConfig } = await import('../apps/web/src/engine/traits');
      await world.get(ProjectConfig)!.setExport(scene, { format: 'webm', video: { codec: 'vp8', resolution: 180, fps: 30, bitrate: 500_000 }, audio: { enabled: false } });
      const { runTool } = await import('../purecut/transport');
      return runTool('export', { id: scene.get(Source)!.value, path: `${project.dir}/renders/${name}.webm` });
    },
    async importVideo(path: string) {
      const world = editorSession()!.world;
      const library = world.get(Library)!;
      const asset = await library.store(await files.file(path), { name: 'round-trip.webm' });
      const { insertAsset } = await import('../apps/web/src/engine/insert-asset');
      if (!insertAsset(world, asset, { parent: world.query(Source).find(isScene)!, x: 900, y: 500, start: 0 })) throw Error('Video insertion failed');
      await flushPendingProjectEdits();
    },
    async propose() {
      const { cutTool } = await import('../purecut/drawer');
      const source = await request('purecut:source', { dir: project.dir });
      const world = editorSession()!.world;
      const title = world.query(Source).find(isText)!;
      return cutTool('proposeCutEdits', { baseHash: source.hash, edits: [{ source: title.get(Source)!.value, text: 'Saved across browser restart', props: {} }] });
    },
    async dispose() { await flushPendingProjectEdits(); dispose(); await flushPendingProjectEdits(); },
  };
}
