import { createRuntimeWorld, Source, isText, Chars } from '../packages/runtime/src';
import { mount, authoredElement } from '../packages/reconciler/src';
import { getDocumentEditor } from '../apps/web/src/engine/editor';
import { getEditHistory } from '../apps/web/src/engine/history';
import { shortcutSystem } from '../apps/web/src/engine/input/shortcuts';
import { Keys } from '../apps/web/src/engine/traits';
import { applyScopedEdits } from '../apps/web/src/engine/scoped-edits';
import { createEditWriter, flushPendingProjectEdits } from '../apps/web/src/projects/edits';
import { mainBridge } from '../apps/web/src/lib/ipc';
import { ProjectService } from '../purecut/lib/projects';
import { validateScopedEdits } from '../purecut/lib/scoped-edits';
import type { ProjectFiles } from '../purecut/lib/platform-files';

export async function checkScopedEdits() {
  const files = new Map<string, string>();
  const service = new ProjectService({
    root: async () => '/scoped',
    read: async path => { if (!files.has(path)) throw Error('Missing file'); return files.get(path)!; },
    write: async (path, text) => { files.set(path, text); },
  } as ProjectFiles);
  await service.init();
  const project = await service.call('projects:create');
  const compiled = await service.call('projects:compile', { dir: project.dir });
  const world = createRuntimeWorld('scoped-edits');
  const mounted = mount(compiled.code, world);
  const editor = getDocumentEditor(world);
  const history = getEditHistory(world);
  world.add(Keys);
  const shortcut = (redo = false) => {
    world.set(Keys, { held: new Set(['mod', 'z', ...(redo ? ['shift'] : [])]), pressed: new Set(['z']), lifted: new Set() });
    shortcutSystem(world);
    world.set(Keys, { held: new Set(), pressed: new Set(), lifted: new Set() });
  };
  const writer = createEditWriter(project.dir, world);
  const unsubscribe = editor.onEdit(edit => writer.push(edit));
  const previousBridge = mainBridge.call;
  mainBridge.call = ((channel, data) => service.call(channel, data)) as typeof mainBridge.call;
  const check = (condition: unknown, message: string) => { if (!condition) throw Error(message); };
  const reject = (action: () => unknown, expression: RegExp) => {
    try { action(); } catch (error) { check(expression.test(String(error)), String(error)); return; }
    throw Error('Expected invalid scoped edit to be rejected');
  };
  try {
    const texts = world.query(Source).filter(isText);
    check(texts.length >= 2, 'starter provides two text elements');
    const first = texts[0]!, second = texts[1]!;
    const source = first.get(Source)!.value;
    const secondSource = second.get(Source)!.value;
    const initialText = first.get(Chars)!.value;
    const oldOpacity = authoredElement(second)!.props.opacity;
    const priorX = authoredElement(first)!.props.x;
    editor.editProperty(first, 'x', 123);
    await flushPendingProjectEdits();
    const base = await service.readSource(project.dir);
    const edits = [
      { source, props: { x: 240, fontSize: 42 }, text: 'Reviewed heading' },
      { source: secondSource, props: { opacity: 0.5 } },
    ];
    const prepared = await service.call('purecut:prepare-edits', { dir: project.dir, baseHash: base.hash, edits });
    check((await service.readSource(project.dir)).hash === base.hash, 'preparing scoped edits does not write');
    applyScopedEdits(world, edits);
    await flushPendingProjectEdits();
    check((await service.readSource(project.dir)).source === prepared.source, 'editor saves the exact scoped proposal shown in review');
    check(first.get(Chars)?.value === 'Reviewed heading' && authoredElement(second)?.props.opacity === 0.5, 'all scoped edits reach the live document');
    shortcut();
    await flushPendingProjectEdits();
    check(first.get(Chars)?.value === initialText && authoredElement(first)?.props.x === 123, 'one undo restores all edits and retains prior placement');
    check((authoredElement(second)?.props.opacity ?? false) === (oldOpacity ?? false), 'one undo also restores the other element');
    shortcut();
    await flushPendingProjectEdits();
    check((authoredElement(first)?.props.x ?? false) === (priorX ?? false), 'older history remains available');
    shortcut(true); shortcut(true);
    await flushPendingProjectEdits();
    check(first.get(Chars)?.value === 'Reviewed heading' && authoredElement(second)?.props.opacity === 0.5, 'redo restores the grouped proposal');
    editor.editProperty(second, 'locked', true);
    await flushPendingProjectEdits();
    const beforeRejected = await service.readSource(project.dir);
    reject(() => applyScopedEdits(world, [
      { source, props: { x: 999 } }, { source: secondSource, props: { opacity: 0.8 } },
    ]), /locked/);
    check(authoredElement(first)?.props.x === 240, 'preflight avoids partially applying a batch with a locked target');
    reject(() => applyScopedEdits(world, [{ source: 'index.tsx:missing', props: { x: 1 } }]), /Missing/);
    reject(() => applyScopedEdits(world, [{ source, props: { start: 10, end: 2 } }]), /end after start/);
    for (const props of [{ src: 'https://example.com' }, { opacity: 2 }, { x: NaN }, { width: -1 }, { __proto__: 42, unknown: 1 }])
      reject(() => validateScopedEdits([{ source, props }]), /Unsupported/);
    reject(() => validateScopedEdits([{ source, props: { x: 1 } }, { source, props: { x: 2 } }]), /unique/);
    reject(() => validateScopedEdits([{ source: '../other.tsx:clip', props: { x: 1 } }]), /index.tsx/);
    await flushPendingProjectEdits();
    check((await service.readSource(project.dir)).hash === beforeRejected.hash, 'rejected edits leave saved source unchanged');
  } finally {
    unsubscribe(); writer.dispose();
    await flushPendingProjectEdits();
    mainBridge.call = previousBridge;
    mounted.dispose(); world.destroy();
  }
}
