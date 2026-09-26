import { createRuntimeWorld, Computed, setPlayhead, playbackSystem } from '../packages/runtime/src';
import { createRuntimeDocument } from '../packages/reconciler/src';
import { createTimelineController } from '../apps/web/src/engine/timeline/controller';
import { TimelineSurface } from '../apps/web/src/engine/timeline/surface';
import { ensureTimelineView, getResolution, getScrollX, getScrollY, setResolution, setScrollX, setScrollY } from '../apps/web/src/engine/timeline/view';
import { TIMELINE_PADDING_LEFT } from '../apps/web/src/engine/timeline/config';

export function checkTimelineView() {
  const world = createRuntimeWorld('view-regression');
  const document = createRuntimeDocument(world);
  const check = (value: unknown, message: string) => { if (!value) throw Error(message); };
  try {
    const scene = document.createElement('Scene');
    document.setProperty(scene, 'active', true);
    document.setProperty(scene, 'end', 120);
    document.insertNode(document.stage, scene);
    const entity = scene.entity;
    world.add(TimelineSurface);
    const canvas = globalThis.document.createElement('canvas');
    Object.defineProperty(canvas, 'clientWidth', { value: 800 });
    world.get(TimelineSurface)!.canvas = canvas;
    ensureTimelineView(world, entity);
    const controller = createTimelineController(world);
    setResolution(world, entity, 1);
    setScrollX(world, entity, 1000);
    setScrollY(world, entity, 75);
    setPlayhead(world, entity, 0); playbackSystem(world);
    controller.zoomAtPlayhead(2);
    check(getResolution(world, entity) === 2 && getScrollX(world, entity) === 1200,
      'offscreen playhead zoom preserves the center frame instead of jumping to playhead');
    setPlayhead(world, entity, 1300); playbackSystem(world);
    const before = (1300 - getScrollX(world, entity)) * getResolution(world, entity);
    controller.zoomAtPlayhead(1.25);
    check(Math.abs((1300 - getScrollX(world, entity)) * getResolution(world, entity) - before) < 0.001,
      'visible playhead remains at the same pixel during zoom');
    controller.fit();
    const resolution = getResolution(world, entity);
    const duration = entity.get(Computed)!.duration;
    check(Math.abs(-getScrollX(world, entity) * resolution - TIMELINE_PADDING_LEFT) < 0.001,
      'fit places frame zero at left padding');
    check(Math.abs((duration - getScrollX(world, entity)) * resolution - (800 - TIMELINE_PADDING_LEFT)) < 0.001,
      'fit places sequence end inside right padding');
    check(entity.get(Computed)!.localTime === 1300 && getScrollY(world, entity) === 75,
      'view changes preserve playhead and vertical scroll');
  } finally { document.dispose(); world.destroy(); }
}
