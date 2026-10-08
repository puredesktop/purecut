import { AssetLibrary, basename, type ProjectFS } from '@diffusionstudio/assets';
import { createRuntimeWorld, Computed, Library, Position, setPlayhead, playbackSystem, motionSystem } from '../packages/runtime/src';
import { createRuntimeDocument } from '../packages/reconciler/src';

/**
 * Runtime fixes taken from upstream diffusionstudio/editor on 2026-10-07:
 * preset animations compound with the authored value (f00276f), text motion
 * leaves no stale copy of the text behind (d302d4b), a caption inside a
 * sequence is placed against the scene (1a10ee1), and basename trims
 * trailing and backslash separators (9c9768d).
 */
export async function checkUpstreamRuntimeFixes() {
  const check = (value: unknown, message: string) => { if (!value) throw Error(message); };

  check(basename('media/clip.mp4') === 'clip.mp4', 'basename keeps the last segment');
  check(basename('media/folder/') === 'folder', 'basename ignores a trailing slash');
  check(basename('media\\clip.mp4') === 'clip.mp4', 'basename splits on a backslash');

  const files = new Map<string, File>();
  const fs: ProjectFS = {
    readManifest: async () => null, writeManifest: async () => {}, list: async () => [],
    stat: async path => { const file = files.get(path); return file ? { size: file.size, mtime: file.lastModified } : null; },
    file: async path => { const file = files.get(path); if (!file) throw Error('Missing fixture'); return file; },
    write: async (path, blob) => { files.set(path, new File([blob], path.split('/').pop()!)); },
    remove: async path => { files.delete(path); },
  };
  const library = new AssetLibrary(fs);
  const world = createRuntimeWorld('upstream-runtime-fixes');
  world.set(Library, library);
  const document = createRuntimeDocument(world);
  try {
    const scene = document.createElement('Scene');
    for (const [name, value] of Object.entries({ __source: 'upstream-scene', active: true, width: 640, height: 360 }))
      document.setProperty(scene, name, value);
    document.insertNode(document.stage, scene);

    // A fade-in on a clip at 80% opacity lands on 80%, not 100%.
    const clip = document.createElement('Rect');
    for (const [name, value] of Object.entries({ __source: 'upstream-clip', start: 0, end: 4, opacity: 0.8 }))
      document.setProperty(clip, name, value);
    document.insertNode(scene, clip);
    const fade = document.createElement('Animation');
    document.setProperty(fade, 'type', 'fade');
    document.setProperty(fade, 'duration', 1);
    document.insertNode(clip, fade);
    const opacityAt = (frame: number) => {
      setPlayhead(world, scene.entity, frame); playbackSystem(world); motionSystem(world);
      return clip.entity.get(Computed)!.opacity;
    };
    check(opacityAt(0) === 0, 'Fade-in starts transparent');
    const middle = opacityAt(15);
    check(middle > 0 && middle < 0.8, `Fade-in midway stays under the authored opacity: ${middle}`);
    check(Math.abs(opacityAt(29) - 0.8) < 1e-6, `Fade-in ends on the authored opacity: ${opacityAt(29)}`);
    check(opacityAt(15) === middle, 'Sampling the same frame twice does not compound');

    // Once text motion has run, the text shows its current words, not a copy.
    const text = document.createElement('Text');
    for (const [name, value] of Object.entries({ __source: 'upstream-text', start: 0, end: 4 }))
      document.setProperty(text, name, value);
    document.insertNode(scene, text);
    document.insertNode(text, document.createTextNode('First words'));
    const appear = document.createElement('Animation');
    document.setProperty(appear, 'type', 'appearWord');
    document.setProperty(appear, 'duration', 1);
    document.insertNode(text, appear);
    setPlayhead(world, scene.entity, 10); playbackSystem(world); motionSystem(world);
    check(text.entity.get(Computed)!.chars !== undefined, 'Text motion writes the revealed words while it plays');
    setPlayhead(world, scene.entity, 60); playbackSystem(world); motionSystem(world);
    check(text.entity.get(Computed)!.chars === undefined, 'After text motion the renderer reads the live text');

    // A caption in a sequence is placed against the scene, not the sequence.
    const transcript = [{ text: 'PLACED', words: [{ text: 'PLACED', start: 0, end: 1 }] }];
    await library.store(new Blob([JSON.stringify(transcript)], { type: 'application/json' }), { name: 'captions.json' });
    const sequence = document.createElement('Sequence');
    document.setProperty(sequence, '__source', 'upstream-sequence');
    document.insertNode(scene, sequence);
    const captions = document.createElement('Captions');
    for (const [name, value] of Object.entries({ __source: 'upstream-captions', src: 'captions.json', end: 2 }))
      document.setProperty(captions, name, value);
    document.insertNode(sequence, captions);
    let placed: { x: number; y: number } | undefined;
    for (let attempt = 0; attempt < 100 && !placed; attempt++) {
      placed = captions.entity.get(Position);
      if (!placed) await new Promise(resolve => setTimeout(resolve, 20));
    }
    check(placed, 'Caption in a sequence must be placed');
    const box = captions.entity.get(Computed)!;
    check(placed!.y >= 0 && placed!.y + box.height <= 360, `Caption in a sequence sits inside the scene: y=${placed!.y}, h=${box.height}`);
  } finally { document.dispose(); world.destroy(); }
}
