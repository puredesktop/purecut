import { Show, createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { useWorld } from '@diffusionstudio/koota-solid';
import { Cache, Chars, Color, Computed, Hidden, Paint, PaintType, Source, isText } from '../packages/runtime/src';
import { mount, authoredElement } from '../packages/reconciler/src';
import { EngineProvider, useEngineContext, type Engine } from '../apps/web/src/engine';
import { getDocumentEditor } from '../apps/web/src/engine/editor';
import { getEditHistory } from '../apps/web/src/engine/history';
import { shortcutSystem } from '../apps/web/src/engine/input/shortcuts';
import { Keys } from '../apps/web/src/engine/traits';
import { applyScopedEdits } from '../apps/web/src/engine/scoped-edits';
import { createEditWriter, flushPendingProjectEdits } from '../apps/web/src/projects/edits';
import { mainBridge } from '../apps/web/src/lib/ipc';
import { TextColorSettings } from '../apps/web/src/components/sidebar-right/inspector/text-color';
import { ProjectService } from '../purecut/lib/projects';
import type { ProjectFiles } from '../purecut/lib/platform-files';
import type { Entity, World } from 'koota';

// One text of each kind a project holds: drawn with the upstream T tool (its
// colour a solid paint child), written by a project or an agent (`fill`), and
// drawn with PureCut's T tool (`color`).
const SOURCE = `export default function Project() {
  return <stage><scene active name="Colours" width={1280} height={720} fill="#ffffff">
    <text name="Painted" x={100} y={100} fontSize={40} end={6}>Painted<solidPaint color="#FFFFFF" /></text>
    <text name="Filled" x={100} y={200} fontSize={40} fill="#10162a" end={6}>Filled</text>
    <text name="Coloured" x={100} y={300} fontSize={40} color="#FFFFFF" end={6}>Coloured</text>
  </scene></stage>;
}`;

const RED = 0xff0000;
/** Where the file holds a text's red once the inspector wrote it. */
const SAVED_RED = {
  Painted: 'Painted<solidPaint[^>]*color="#FF0000"',
  Filled: 'name="Filled"[^>]*fill="#FF0000"',
  Coloured: 'name="Coloured"[^>]*color="#FF0000"',
} as const;
const PROPOSED = 0xdf2626;

/**
 * The colour a text is drawn in, read the way the renderer reads it
 * (packages/runtime/src/utils/text.ts): the topmost visible solid in the
 * text's fill cache, else its intrinsic Computed colour.
 */
function seenColour(text: Entity): number | undefined {
  const fills = (text.get(Cache)?.fills ?? []).filter(fill => !fill.has(Hidden));
  const top = fills.at(-1);
  if (top) return top.get(Paint)?.value === PaintType.SOLID ? top.get(Color)?.value : undefined;
  return text.has(Color) ? text.get(Computed)?.color : undefined;
}

/**
 * A text's colour is the colour you see: the inspector's colour row and a
 * proposeCutEdits `fill` both recolour what is visible, whichever way the
 * text spells its colour; the reviewed source is what apply saves; one undo
 * takes each back.
 */
export async function checkTextColours() {
  const check = (condition: unknown, message: string) => { if (!condition) throw Error(message); };
  const files = new Map<string, string>();
  const service = new ProjectService({
    root: async () => '/text-colour',
    read: async path => { if (!files.has(path)) throw Error('Missing file'); return files.get(path)!; },
    write: async (path, text) => { files.set(path, text); },
  } as ProjectFiles);
  await service.init();
  const project = await service.call('projects:create');
  const entry = [...files.keys()].find(path => path.startsWith(project.dir) && path.endsWith('/index.tsx'))!;
  files.set(entry, SOURCE);
  const compiled = await service.call('projects:compile', { dir: project.dir });
  check(compiled.ok, `fixture compiles: ${compiled.error}`);

  const host = document.createElement('div');
  document.body.append(host);
  let engine!: Engine;
  let world!: World;
  // The inspector's colour section for whichever text is "selected".
  const [selected, setSelected] = createSignal<Entity>();
  const Probe = () => { engine = useEngineContext(); world = useWorld(); return null; };
  const disposeEngine = render(() => <EngineProvider projectId="text-colour-check">
    <Probe />
    <Show when={selected()} keyed>{text => <TextColorSettings selection={[text]} />}</Show>
  </EngineProvider>, host);
  const mounted = mount(compiled.code, world);
  const editor = getDocumentEditor(world);
  getEditHistory(world);
  world.add(Keys);
  const undo = () => {
    world.set(Keys, { held: new Set(['mod', 'z']), pressed: new Set(['z']), lifted: new Set() });
    shortcutSystem(world);
    world.set(Keys, { held: new Set(), pressed: new Set(), lifted: new Set() });
  };
  const writer = createEditWriter(project.dir, world);
  const unsubscribe = editor.onEdit(edit => writer.push(edit));
  const previousBridge = mainBridge.call;
  mainBridge.call = ((channel, data) => service.call(channel, data)) as typeof mainBridge.call;
  // Computed and the fill cache are the systems' to write: let a few frames run.
  const frames = async (count = 3) => {
    const start = engine.frame();
    for (let i = 0; i < 200 && engine.frame() < start + count; i++) await new Promise(requestAnimationFrame);
    check(engine.frame() >= start + count, 'engine ticks');
  };
  const hex = (value: number | undefined) => value === undefined ? 'none' : `#${value.toString(16).padStart(6, '0')}`;
  engine.start();
  try {
    const texts = Object.fromEntries(world.query(Source).filter(isText).map(text => [authoredElement(text)!.props.name as string, text]));
    const all = ['Painted', 'Filled', 'Coloured'] as const;
    check(all.every(name => texts[name]), 'fixture mounts its three texts');
    await frames();
    const before = Object.fromEntries(all.map(name => [name, seenColour(texts[name]!)]));
    check(before.Painted === 0xffffff && before.Filled === 0x10162a && before.Coloured === 0xffffff,
      `fixture colours: ${all.map(name => hex(before[name])).join(' ')}`);

    // The inspector: one colour row per text, and typing red into it
    // recolours what is seen, in one undoable step.
    for (const name of all) {
      const text = texts[name]!;
      setSelected(text);
      try {
        await frames();
        const fields = host.querySelectorAll<HTMLInputElement>('input[type="text"]');
        check(fields.length === 1, `${name}: the inspector shows exactly one colour row (${fields.length})`);
        const field = fields[0]!;
        check(field.value.toUpperCase() === hex(before[name]).slice(1).toUpperCase(),
          `${name}: the row shows the seen colour ${hex(before[name])}, not ${field.value}`);
        field.focus();
        field.value = 'FF0000';
        field.dispatchEvent(new InputEvent('input', { bubbles: true }));
        field.blur();
        await frames();
        check(seenColour(text) === RED, `${name}: the inspector recolours what is seen (${hex(seenColour(text))})`);
        await flushPendingProjectEdits();
        const saved = (await service.readSource(project.dir)).source;
        check(new RegExp(SAVED_RED[name]).test(saved), `${name}: the file takes the colour where it is seen\n${saved}`);
        undo();
        await frames();
        check(seenColour(text) === before[name], `${name}: one undo restores ${hex(before[name])} (${hex(seenColour(text))})`);
        await flushPendingProjectEdits();
      } finally { setSelected(undefined); }
    }
    check((await service.readSource(project.dir)).source.match(/#FF0000/i) === null, 'undo takes every inspector edit out of the file');

    // proposeCutEdits: the review (prepare, on source) and the apply (on the
    // live document) recolour the same thing, and only the colour.
    const base = await service.readSource(project.dir);
    const edits = all.map(name => ({ source: texts[name]!.get(Source)!.value, props: { fill: '#DF2626' } }));
    const prepared = await service.call('purecut:prepare-edits', { dir: project.dir, baseHash: base.hash, edits });
    check((await service.readSource(project.dir)).hash === base.hash, 'preparing does not write');
    check(/<solidPaint[^>]*color="#DF2626"/.test(prepared.source), 'review recolours the painted text\'s paint');
    check(/name="Filled"[^>]*fill="#DF2626"/.test(prepared.source), 'review recolours the filled text\'s fill');
    check(/name="Coloured"[^>]*color="#DF2626"/.test(prepared.source) && !/name="Coloured"[^>]*fill=/.test(prepared.source),
      'review recolours the coloured text\'s color, adding no fill');
    check(!/>#DF2626</.test(prepared.source), 'review never puts the colour in what a text says');
    applyScopedEdits(world, edits);
    await flushPendingProjectEdits();
    await frames();
    const applied = (await service.readSource(project.dir)).source;
    check(applied === prepared.source, `apply saves exactly the reviewed source\n--- prepared\n${prepared.source}\n--- applied\n${applied}`);
    for (const name of all) {
      check(seenColour(texts[name]!) === PROPOSED, `${name}: proposal recolours what is seen (${hex(seenColour(texts[name]!))})`);
      check(texts[name]!.get(Chars)?.value === name, `${name}: proposal leaves the words alone`);
    }
    undo();
    await frames();
    for (const name of all) check(seenColour(texts[name]!) === before[name], `${name}: one undo takes the whole proposal back`);
  } finally {
    engine.stop();
    unsubscribe(); writer.dispose();
    await flushPendingProjectEdits();
    mainBridge.call = previousBridge;
    mounted.dispose();
    disposeEngine();
    host.remove();
  }
}
