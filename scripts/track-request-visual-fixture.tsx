import { Tool, ToolType } from '../packages/runtime/src';
import { objectMaskModel, objectMaskModelLoad, objectMaskUse, setObjectMaskModelLoad } from '../apps/web/src/engine/object-mask/store';
import { pendingTrackRequest } from '../apps/web/src/engine/object-mask/request';
import { getDocumentEditor } from '../apps/web/src/engine/editor';
import { fixtureWorld } from './editor-visual-fixture';
import { stageInterview } from './mask-uses-visual-fixture';
import { getCutTrackStatus, trackCutObject } from '../purecut/track-object';

/**
 * Stages an assistant's request to track an object on the editor visual
 * fixture (see test-track-request-visual.mjs): the interview clip of
 * mask-uses-visual-fixture.tsx, and the drawer tool asking to blur the
 * figure's face. No model runs and nothing is downloaded: the window is
 * given a stand-in WebGPU adapter so the bar asks for the download rather
 * than saying WebGPU is missing, which headless browsers may not offer.
 */
export async function stageRequest() {
  const gpu = { requestAdapter: async () => ({}) };
  Object.defineProperty(navigator, 'gpu', { configurable: true, value: gpu });
  await stageInterview();
  getDocumentEditor(fixtureWorld!).clearSelection();
  fixtureWorld!.set(Tool, { value: ToolType.MOVE });
}

/** The drawer agent calls the tool, as the shell would. */
export function ask() {
  return trackCutObject({ clip: 'index.tsx:interview', at: { x: 0.445, y: 0.43 }, time: 0.4, use: 'blur', label: 'his face' });
}

/** Waits for the bar's model check, then says the model is here (as if downloaded before). */
export async function modelReady() {
  for (let i = 0; i < 100 && !objectMaskModelLoad(); i++) await new Promise(resolve => setTimeout(resolve, 20));
  setObjectMaskModelLoad({ id: objectMaskModel(), phase: 'ready', progress: null, error: null });
}

export async function modelNeedsDownload() {
  setObjectMaskModelLoad({ id: objectMaskModel(), phase: 'needs-download', progress: null, error: null });
}

export function state() {
  const request = pendingTrackRequest();
  return {
    tool: fixtureWorld!.get(Tool)?.value === ToolType.OBJECT_MASK ? 'object-mask' : 'other',
    use: objectMaskUse(),
    pending: !!request,
    point: request?.point ?? null,
    status: getCutTrackStatus(),
  };
}
