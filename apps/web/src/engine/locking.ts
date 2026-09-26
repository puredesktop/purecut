import { Locked, getEntityTree, getParentEntity } from '@diffusionstudio/runtime';
import type { Entity, World } from 'koota';

export function isEditLocked(entity: Entity): boolean {
  for (let node: Entity | null = entity; node; node = getParentEntity(node)) {
    if (node.has(Locked)) return true;
  }
  return false;
}

/** Editing a container must not indirectly transform or remove its locked children. */
export function containsLocked(world: World, entity: Entity): boolean {
  return isEditLocked(entity) || getEntityTree(world, entity).some(child => child.has(Locked));
}
