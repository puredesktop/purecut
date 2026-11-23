export class CutToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CutToolError";
  }
}

export interface CutObjectMaskSummary {
  path: string;
  video: string | null;
  sourceIn: number;
  clips: string[];
}

export interface CutGenerationSummary {
  element: string | null;
  name: string | null;
  state: "generating" | "failed" | "done";
  error?: string;
  asset?: string;
}

export interface CutPendingTrackSummary {
  request: string;
  clip: string;
  subject: string;
  use: string;
}

export interface CutContextResult {
  rootDir: string | null;
  projectDir: string | null;
  currentTime: number | null;
  fontFamilies: string[];
  generations: CutGenerationSummary[];
  objectMasks?: CutObjectMaskSummary[];
  source?: string;
  hash?: string;
  pendingTrack?: CutPendingTrackSummary;
  [key: string]: unknown;
}

export interface CutCheckIssue {
  code: string;
  severity: "error" | "warning";
  message: string;
  node?: string;
  ranges?: Array<{ start: number; end: number }>;
}

export interface CutCheckResult {
  stats: {
    nodes: number;
    byKind: Record<string, number>;
    depth: number;
    duration: number;
  };
  issues: CutCheckIssue[];
  [key: string]: unknown;
}

export interface CutTranscriptWord {
  text: string;
  start: number;
  end: number;
  speaker?: string | null;
  [key: string]: unknown;
}

export interface CutTranscriptFiller {
  key?: string;
  text?: string;
  reason?: string;
  start: number;
  end: number;
  [key: string]: unknown;
}

export interface CutTranscriptResult {
  status?: string;
  message?: string;
  baseHash?: string;
  unit?: string;
  duration?: number;
  total?: number;
  words?: CutTranscriptWord[];
  nextOffset?: number | null;
  fillers?: CutTranscriptFiller[];
  [key: string]: unknown;
}

export interface CutTrackStatusResult {
  status: string;
  request?: string;
  clip?: string;
  subject?: string;
  askedUse?: string;
  waitingFor?: string;
  modelError?: string;
  mask?: string;
  use?: string;
  applied?: number;
  note?: string;
  next?: string;
  message: string;
  [key: string]: unknown;
}

/**
 * Dependency-injected runtime context for PureCut's agent operations.
 * Kept pure of DOM / SolidJS / transport globals so the registry and composite
 * App Functions can be tested deterministically in Node.
 */
export interface PureCutAgentContext {
  isHeld: () => boolean;
  getCutContext: () => Promise<CutContextResult>;
  proposeCutEdits: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  proposeCutSource: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  replaceCutSource: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  checkCut: (args: Record<string, unknown>) => Promise<CutCheckResult>;
  exportCut: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  trackCutObject: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  getCutTrackStatus: () => Promise<CutTrackStatusResult>;
  openCutTranscript: () => Promise<Record<string, unknown>>;
  getCutTranscript: (args: Record<string, unknown>) => Promise<CutTranscriptResult>;
  proposeCutSpeechEdit: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  proposeCutSpeechCleanup: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  proposeCutCaptions: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
}
