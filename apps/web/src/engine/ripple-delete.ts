import { ChildOf, Computed, Selected, Source, getActiveEntity, getParentEntity, isSequence } from '@diffusionstudio/runtime';
import type { Entity, World } from 'koota';
import { getDocumentEditor } from './editor';
import { moveEntityTo } from './timing';
import { containsLocked } from './locking';
import { toast } from 'somoto';

type Span = [number, number];

function merge(spans: Span[]): Span[] {
  const result: Span[] = [];
  for (const [start, end] of spans.sort((a, b) => a[0] - b[0])) {
    if (!Number.isFinite(start) || Number.isNaN(end) || end <= start) continue;
    const last = result.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else result.push([start, end]);
  }
  return result;
}

/** Close only newly vacated time, preserving overlap and synchronization across tracks. */
export function rippleDeleteSelection(world: World): void {
  const scene = getActiveEntity(world);
  if (!scene) return;
  if (containsLocked(world, scene)) {
    toast('Unlock the tracks before ripple deleting to preserve synchronization.');
    return;
  }
  const insideScene = (entity: Entity) => {
    for (let parent = getParentEntity(entity); parent; parent = getParentEntity(parent)) {
      if (parent === scene) return true;
    }
    return false;
  };
  const selected = [...world.query(Selected)].filter(entity => insideScene(entity) && !!entity.get(Source)?.value);
  if (!selected.length) return;
  const doomed = new Set(selected);
  const isDoomed = (entity: Entity) => {
    for (let node: Entity | null = entity; node && node !== scene; node = getParentEntity(node)) {
      if (doomed.has(node)) return true;
    }
    return false;
  };
  const units: Entity[] = [];
  const collect = (parent: Entity) => {
    for (const child of world.query(ChildOf(parent))) {
      if (isSequence(child)) collect(child);
      else if (child.has(Computed)) units.push(child);
    }
  };
  collect(scene);
  const span = (entity: Entity): Span => {
    const time = entity.get(Computed)!;
    return [time.start, time.end];
  };
  const removed = merge(units.filter(isDoomed).map(span).filter(([, end]) => Number.isFinite(end)));
  const survivors = units.filter(entity => !isDoomed(entity));
  const occupied = merge(survivors.map(span));
  const gaps: Span[] = [];
  for (const [start, end] of removed) {
    let cursor = start;
    for (const [from, to] of occupied) {
      if (to <= cursor) continue;
      if (from >= end) break;
      if (from > cursor) gaps.push([cursor, Math.min(from, end)]);
      cursor = Math.max(cursor, to);
      if (cursor >= end) break;
    }
    if (cursor < end) gaps.push([cursor, end]);
  }
  // Capture positions before mutations alter computed container bounds.
  const moves = survivors.map(entity => {
    const start = entity.get(Computed)!.start;
    const shift = gaps.reduce((total, [from, to]) => total + Math.max(0, Math.min(start, to) - from), 0);
    return { entity, start: start - shift, shift };
  });
  getDocumentEditor(world).remove(selected);
  for (const { entity, start, shift } of moves) {
    if (shift && entity.isAlive()) moveEntityTo(world, entity, start);
  }
}
