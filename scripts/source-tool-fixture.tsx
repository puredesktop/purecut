import { render } from 'solid-js/web';
import { ColorModeProvider } from '@kobalte/core';
import { SourceEditReview, sourceReview } from '../purecut/edit-review';
import { Toaster } from '../apps/web/src/components/ui/sonner';
import '../apps/web/src/index.css';
import '../purecut/styles.css';

export async function mountSourceToolFixture(host: HTMLElement) {
  // Bind transport before importing the tool bridge, just as desktop bootstrap does.
  const { initializeTransport, request } = await import('../purecut/transport');
  const { files } = await import('../purecut/lib/platform-files');
  const originalFiles = { ...files };
  const stored = new Map<string, string>();
  files.root = async () => '/tool-fixture';
  files.read = async path => {
    if (!stored.has(path)) throw Error('Missing fixture file');
    return stored.get(path)!;
  };
  files.write = async (path, value) => { stored.set(path, value); };
  await initializeTransport();
  const project = await request('projects:create', { displayName: 'Tool review fixture' });
  const compiled = await request('projects:compile', { dir: project.dir });
  const { createRuntimeWorld, Source, isText, Chars } = await import('../packages/runtime/src');
  const { mount, authoredElement } = await import('../packages/reconciler/src');
  const { getDocumentEditor } = await import('../apps/web/src/engine/editor');
  const { getEditHistory } = await import('../apps/web/src/engine/history');
  const { createEditWriter, flushPendingProjectEdits } = await import('../apps/web/src/projects/edits');
  const { editorSession, setEditorSession, requireEditorSession } = await import('../apps/web/src/dapi/session');
  const world = createRuntimeWorld('tool-review-fixture');
  const mounted = mount(compiled.code, world);
  const editor = getDocumentEditor(world);
  const history = getEditHistory(world);
  const writer = createEditWriter(project.dir, world);
  const unsubscribe = editor.onEdit(edit => writer.push(edit));
  setEditorSession({ world, project: { dir: () => project.dir }, engine: {} as any });
  const { toolBridge } = await import('../apps/web/src/dapi/bridge');
  const { context } = await import('../apps/web/src/dapi/handlers/context');
  const unregister = toolBridge.register({ context } as any, signal => ({
    signal, session: editorSession, requireSession: requireEditorSession,
    app: { openProject: async () => { throw Error('No fixture navigation'); }, user: () => null, requireUser: () => { throw Error('No fixture account'); } },
  }));
  const { cutTool } = await import('../purecut/drawer');
  const texts = world.query(Source).filter(isText);
  const first = texts[0]!, second = texts[1]!;
  const initial = await request('purecut:source', { dir: project.dir });
  const initialText = first.get(Chars)!.value;
  const disposeView = render(() => <ColorModeProvider initialColorMode="light"><SourceEditReview /><Toaster /></ColorModeProvider>, host);
  return {
    initial,
    initialText,
    async propose() {
      const current = await cutTool('getCutContext');
      return cutTool('proposeCutEdits', { baseHash: current.hash, edits: [
        { source: first.get(Source)!.value, text: 'A reviewed tool edit', props: { x: 200 } },
        { source: second.get(Source)!.value, props: { opacity: 0.5 } },
      ] });
    },
    read: () => request('purecut:source', { dir: project.dir }),
    state: () => ({ text: first.get(Chars)!.value, x: authoredElement(first)?.props.x, canUndo: history.canUndo(), error: sourceReview.error(), proposed: !!sourceReview.proposal() }),
    async undo() { history.undo(); await flushPendingProjectEdits(); },
    async lockSecond() { editor.editProperty(second, 'locked', true); await flushPendingProjectEdits(); },
    closeProject: () => setEditorSession(null),
    async changeOutside() {
      const current = await request('purecut:source', { dir: project.dir });
      return request('purecut:replace', { dir: project.dir, baseHash: current.hash, source: current.source.replace('Welcome to PureCut', 'External newer title') });
    },
    async dispose() {
      disposeView(); unregister(); setEditorSession(null); unsubscribe(); writer.dispose();
      await flushPendingProjectEdits(); mounted.dispose(); world.destroy(); Object.assign(files, originalFiles);
    },
  };
}
