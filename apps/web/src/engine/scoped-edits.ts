import { Source, isText } from '@diffusionstudio/runtime';
import { authoredElement } from '@diffusionstudio/reconciler';
import { getDocumentEditor, isLooped } from './editor';
import { getEditHistory } from './history';
import { containsLocked } from './locking';
import { validateScopedEdits } from '../../../../purecut/lib/scoped-edits';
import type { World } from 'koota';

export function applyScopedEdits(world: World, input: unknown): void {
  const edits = validateScopedEdits(input);
  const entities = world.query(Source);
  // Validate every target before the first mutation, including indirect locks.
  const targets = edits.map(edit => {
    const matches = entities.filter(entity => entity.isAlive() && entity.get(Source)?.value === edit.source);
    if (matches.length !== 1) throw Error(`Missing or ambiguous element: ${edit.source}`);
    const entity = matches[0]!;
    const authored = authoredElement(entity);
    if (!authored || isLooped(entity)) throw Error('Scoped edits require a directly authored element.');
    if (containsLocked(world, entity)) throw Error(`Element is locked: ${edit.source}`);
    if (edit.text !== undefined && !isText(entity)) throw Error('Text changes require a text element.');
    if (edit.props.fontSize !== undefined && !isText(entity)) throw Error('Font size requires a text element.');
    if (edit.props.start !== undefined || edit.props.end !== undefined) {
      const start = edit.props.start ?? authored.props.start ?? 0;
      const end = edit.props.end ?? authored.props.end;
      if (typeof start !== 'number' || (end !== undefined && (typeof end !== 'number' || end <= start)))
        throw Error('Timing edits require a numeric end after start.');
    }
    return { entity, edit };
  });
  const editor = getDocumentEditor(world);
  const history = getEditHistory(world);
  history.beginGesture();
  try {
    for (const { entity, edit } of targets) {
      for (const [name, value] of Object.entries(edit.props)) editor.editProperty(entity, name, value);
      if (edit.text !== undefined) editor.editText(entity, edit.text);
    }
  } finally { history.endGesture(); }
}
