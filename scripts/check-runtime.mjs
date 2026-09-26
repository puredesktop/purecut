import assert from 'node:assert/strict';
import { createWorld, trait, Or } from 'koota';

// Scene queries span multiple trait bitmask generations. An unpatched Koota
// silently drops matching nodes here, producing an empty preview and export.
const world = createWorld();
try {
  const first = trait();
  const entity = world.spawn(first);
  for (let i = 0; i < 40; i++) world.query(trait());
  const last = trait();
  world.query(last);
  assert.deepEqual([...world.query(Or(first, last))], [entity],
    'PureCut runtime patch is missing. Run npm run postinstall in the PureCut repository.');
} finally {
  world.destroy();
}
