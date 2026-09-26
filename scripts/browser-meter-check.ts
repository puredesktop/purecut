import { createRoot } from 'solid-js';
import { useVolumeMeter } from '../apps/web/src/hooks/use-volume-meter';

export async function checkMeters() {
  const original = globalThis.AudioWorkletNode;
  const nodes: FakeWorklet[] = [];
  class FakeWorklet {
    closed = false;
    disconnected = false;
    port = { onmessage: null as ((event: { data: Float32Array }) => void) | null,
      close: () => { this.closed = true; } };
    constructor() { nodes.push(this); }
    disconnect() { this.disconnected = true; }
  }
  globalThis.AudioWorkletNode = FakeWorklet as unknown as typeof AudioWorkletNode;
  let finishModule!: () => void;
  let loads = 0;
  const moduleReady = new Promise<void>(resolve => { finishModule = resolve; });
  const context = { audioWorklet: { addModule: () => { loads++; return moduleReady; } } };
  const connections = new Set<FakeWorklet>();
  const gain = { context, connect: (node: FakeWorklet) => connections.add(node),
    disconnect: (node: FakeWorklet) => connections.delete(node) } as unknown as GainNode;
  let first!: ReturnType<typeof useVolumeMeter>, second!: ReturnType<typeof useVolumeMeter>;
  const dispose = createRoot(dispose => { first = useVolumeMeter(); second = useVolumeMeter(); return dispose; });
  const check = (value: unknown, message: string) => { if (!value) throw Error(message); };
  try {
    const a = first.connect(gain);
    const b = second.connect(gain);
    check(loads === 1, 'concurrent meters load the worklet module once');
    finishModule();
    await Promise.all([a, b]);
    check(nodes.length === 1 && connections.size === 1, 'meters share one audio graph tap');
    nodes[0]!.port.onmessage!({ data: new Float32Array([0.25, 1.1]) });
    check(first.levels()[0]!.peak > 1 && second.levels()[0]!.peak > 1, 'shared peak reaches both meters');
    check(first.clipped() && second.clipped(), 'peak above full scale latches clipping warnings');
    nodes[0]!.port.onmessage!({ data: new Float32Array([0.1, 0.4]) });
    check(first.clipped(), 'clipping remains visible after the transient has passed');
    first.resetClipping();
    check(!first.clipped() && second.clipped(), 'reset clears only this meter warning');
    first.disconnect();
    check(connections.size === 1 && !nodes[0]!.closed, 'one subscriber cannot tear down another meter');
    second.disconnect();
    check(connections.size === 0 && nodes[0]!.closed && nodes[0]!.disconnected, 'last subscriber releases input, output, and message port');
    const stale = first.connect(gain);
    first.disconnect();
    const replacement = first.connect(gain);
    await Promise.all([stale, replacement]);
    check(connections.size === 1, 'stale subscription does not remove the replacement');
    const node = [...connections][0]!;
    node.port.onmessage!({ data: new Float32Array([0.1, 0.4]) });
    check(Math.abs(first.levels()[0]!.peak - 0.4) < 0.001, 'replacement still receives audio levels');
    let fail = true;
    const badGain = { ...gain, context: { audioWorklet: { addModule: async () => { if (fail) throw Error('Worklet unavailable'); } } } } as unknown as GainNode;
    await first.connect(badGain);
    check(first.error() === 'Worklet unavailable', 'worklet failure is exposed without an unhandled rejection');
    fail = false;
    await first.connect(badGain);
    check(!first.error() && connections.size === 1, 'worklet setup can recover after a failure');
  } finally {
    dispose(); globalThis.AudioWorkletNode = original;
  }
  check(connections.size === 0, 'unmount releases remaining meter connections');
  // Exercise the actual processor as well as the subscription lifecycle.
  const audio = new OfflineAudioContext(2, 48000, 48000);
  const signal = audio.createConstantSource();
  signal.offset.value = 1.2;
  const realGain = audio.createGain();
  signal.connect(realGain);
  realGain.connect(audio.destination);
  let realMeter!: ReturnType<typeof useVolumeMeter>;
  const disposeReal = createRoot(dispose => { realMeter = useVolumeMeter(); return dispose; });
  try {
    await realMeter.connect(realGain);
    check(!realMeter.error(), `real worklet loads: ${realMeter.error()}`);
    signal.start();
    await audio.startRendering();
    const deadline = performance.now() + 3000;
    while (!realMeter.clipped() && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    check(realMeter.clipped() && realMeter.levels()[0]!.peak >= 1, 'actual audio processor reports full-scale clipping');
  } finally { disposeReal(); signal.disconnect(); realGain.disconnect(); }
}
