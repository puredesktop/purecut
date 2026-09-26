import { createEngine } from '../apps/web/src/engine/create-engine';
import { createRuntimeDocument } from '../packages/reconciler/src';
import { AudioBusHandle, Computed, Soloed, setPlayhead } from '../packages/runtime/src';

export function checkAudioPreviewOrder() {
  const engine = createEngine('audio-preview-order');
  const document = createRuntimeDocument(engine.world);
  try {
    const scene = document.createElement('Scene');
    document.setProperty(scene, 'active', true);
    document.insertNode(document.stage, scene);
    const clip = document.createElement('Rect');
    document.setProperty(clip, 'end', 2);
    document.setProperty(clip, 'volume', -6);
    document.insertNode(scene, clip);
    const fade = document.createElement('Animation');
    document.setProperty(fade, 'type', 'gain');
    document.setProperty(fade, 'duration', 0.5);
    document.insertNode(clip, fade);
    let applied: number | undefined;
    clip.entity.add(AudioBusHandle);
    clip.entity.set(AudioBusHandle, {
      sync: () => { applied = clip.entity.get(Computed)?.volume; },
      mute: () => { applied = -Infinity; },
      disconnect() {},
    } as any);
    const step = (frame: number) => {
      setPlayhead(engine.world, scene.entity, frame);
      (engine as unknown as { runSystems(): void }).runSystems();
    };
    step(0);
    if (applied !== -Infinity) throw Error(`First preview frame must apply the current fade: ${applied}`);
    step(30);
    if (Number(applied) !== -6) throw Error(`Preview must restore authored volume without a one-frame lag: ${applied}`);
    step(0);
    if (applied !== -Infinity) throw Error('Seeking back must immediately apply the fade');
    const other = document.createElement('Rect');
    document.setProperty(other, 'end', 2);
    document.insertNode(scene, other);
    let otherApplied: number | undefined;
    other.entity.add(AudioBusHandle);
    other.entity.set(AudioBusHandle, {
      sync: () => { otherApplied = other.entity.get(Computed)?.volume; },
      mute: () => { otherApplied = -Infinity; }, disconnect() {},
    } as any);
    clip.entity.add(Soloed);
    step(30);
    if (Number(applied) !== -6 || otherApplied !== -Infinity) throw Error('Solo must silence unrelated clips');
    clip.entity.remove(Soloed);
    scene.entity.add(AudioBusHandle, Soloed);
    scene.entity.set(AudioBusHandle, { sync() {}, mute() {}, disconnect() {} } as any);
    step(30);
    if (Number(applied) !== -6 || Number(otherApplied) !== 0) throw Error('Soloing a container must preserve its audible children');
  } finally { document.dispose(); engine.dispose(); }
}
