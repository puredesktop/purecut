import { createRuntimeWorld } from '../packages/runtime/src';
import { mainBridge } from '../apps/web/src/lib/ipc';
import { createEditWriter, flushPendingProjectEdits } from '../apps/web/src/projects/edits';

export async function checkWriterDisposal() {
  const world = createRuntimeWorld('writer-disposal');
  const previous = mainBridge.call;
  const batches: any[] = [];
  let release!: (value: any) => void;
  let writer: ReturnType<typeof createEditWriter> | undefined;
  let drain: Promise<void> | undefined;
  let flushed: Promise<void> | undefined;
  let destroyed = false;
  try {
    mainBridge.call = (async (channel: string, data: any) => {
      if (channel !== 'projects:write') throw Error(`Unexpected writer channel: ${channel}`);
      batches.push(data);
      if (batches.length === 1) return new Promise(resolve => { release = resolve; });
      return {};
    }) as typeof mainBridge.call;
    writer = createEditWriter('/writer.cut', world);
    writer.push({ kind: 'insert', source: 'pending:clip', parent: 'index.tsx:scene', tag: 'Rect', props: { x: 10 } });
    drain = writer.drain();
    writer.push({ kind: 'prop', source: 'pending:clip', name: 'x', value: 42 });
    writer.dispose();
    world.destroy(); destroyed = true;
    let settled = false;
    flushed = flushPendingProjectEdits().then(() => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 0));
    if (settled) throw Error('Global flush returned while a disposed writer still had an active save');
    release({ ids: { 'pending:clip': 'index.tsx:clip' } });
    await Promise.all([drain, flushed]);
    if (batches.length !== 2 || batches[1].edits[0]?.source !== 'index.tsx:clip' || batches[1].edits[0]?.props.x !== 42)
      throw Error('Disposed writer lost a held edit or failed to remap its inserted source');
    if (batches.some(batch => batch.dir !== '/writer.cut')) throw Error('Disposed writes escaped their original project');
    await flushPendingProjectEdits();
    if (batches.length !== 2) throw Error('Completed disposed writer wrote again');
  } finally {
    release?.({ ids: { 'pending:clip': 'index.tsx:clip' } });
    await Promise.allSettled([drain, flushed].filter(Boolean));
    writer?.dispose();
    if (!destroyed) world.destroy();
    mainBridge.call = previous;
  }
}
