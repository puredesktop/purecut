/**
 * Exposed PureCut operations (must stay in sync 1:1 with `plugin.json` -> `app.agents.tools[].name`).
 *
 * 3-tier exposure (built on `@purescience/platform-ui/bridge/appFunctions`):
 *   1. 4 composite `function` workflows (`fn_*`) — replace 2–10 atomic round-trips each
 *   2. 4 core atomic tools (~31% of 13) — indispensable direct context/editing/export verbs
 *   3. 3 universal escape-hatch meta-tools (`discoverAppTools`, `callExtendedReadTool`, `callExtendedTool`)
 *      providing full on-demand access to the remaining 9 specialist atomic tools.
 */
export const PURECUT_FUNCTION_NAMES = [
  "fn_inspectCutProject",
  "fn_analyzeCutSpeech",
  "fn_proposeSpeechWorkflow",
  "fn_trackOrInspectObjectMask",
] as const;

export const PURECUT_CORE_TOOL_NAMES = [
  "getCutContext",
  "proposeCutEdits",
  "proposeCutSource",
  "exportCut",
] as const;

export const PURECUT_META_TOOL_NAMES = [
  "discoverAppTools",
  "callExtendedReadTool",
  "callExtendedTool",
] as const;

export const EXPOSED_TOOL_NAMES = [
  ...PURECUT_FUNCTION_NAMES,
  ...PURECUT_CORE_TOOL_NAMES,
  ...PURECUT_META_TOOL_NAMES,
] as const;

/** Keep in sync with `plugin.json` -> `app.agents.tools[].name`. */
export const PURECUT_AGENT_TOOL_NAMES = EXPOSED_TOOL_NAMES;

export type PureCutAgentToolName = (typeof PURECUT_AGENT_TOOL_NAMES)[number];

export const PURECUT_EXTENDED_TOOL_NAMES = [
  "replaceCutSource",
  "checkCut",
  "trackCutObject",
  "getCutTrackStatus",
  "openCutTranscript",
  "getCutTranscript",
  "proposeCutSpeechEdit",
  "proposeCutSpeechCleanup",
  "proposeCutCaptions",
] as const;

export type PureCutExtendedToolName = (typeof PURECUT_EXTENDED_TOOL_NAMES)[number];

export const PURECUT_ALL_ATOMIC_TOOL_NAMES = [
  ...PURECUT_CORE_TOOL_NAMES,
  ...PURECUT_EXTENDED_TOOL_NAMES,
] as const;

export type PureCutAtomicToolName = (typeof PURECUT_ALL_ATOMIC_TOOL_NAMES)[number];
