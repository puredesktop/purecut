import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentToolInvokeContext } from "@purescience/platform-ui/bridge/react/usePlatformAgentTools";
import { PURECUT_ATOMIC_TOOL_SCHEMAS } from "./atomicToolSchemas";
import {
  EXPOSED_TOOL_NAMES,
  PURECUT_ALL_ATOMIC_TOOL_NAMES,
  PURECUT_CORE_TOOL_NAMES,
  PURECUT_EXTENDED_TOOL_NAMES,
  PURECUT_FUNCTION_NAMES,
  PURECUT_META_TOOL_NAMES,
} from "./catalog";
import {
  CutToolError,
  type CutCheckResult,
  type CutContextResult,
  type CutTrackStatusResult,
  type CutTranscriptResult,
  type PureCutAgentContext,
} from "./context";
import {
  findTranscriptPhraseMatches,
  parseScenesFromSource,
  summarizeSpeakers,
} from "./functions";
import {
  PURECUT_OPERATIONS_REGISTRY,
  buildPureCutHandlers,
} from "./operationsRegistry";

const SAMPLE_SOURCE = `
import { Stage } from "@diffusionstudio/jsx";

export default function Project() {
  return (
    <stage>
      <scene id="main" name="Main Edit" active width={1920} height={1080}>
        <rect id="clip-1" start={0} end={12}><videoPaint src="footage/talk.mp4" /></rect>
        <text id="title-1" start={1} end={5} fontSize={72} fill="#FFFFFF">Hello World</text>
      </scene>
      <scene id="highlight-1" name="Lisbon Clip" width={1920} height={1080}>
        <rect id="clip-2" start={0} end={6}><videoPaint src="footage/talk.mp4" /></rect>
      </scene>
    </stage>
  );
}
`;

function createMockContext(overrides: Partial<PureCutAgentContext> = {}): PureCutAgentContext {
  const defaultContext: CutContextResult = {
    rootDir: "/projects",
    projectDir: "/projects/demo.cut",
    currentTime: 2.5,
    fontFamilies: ["Inter", "Outfit"],
    generations: [],
    objectMasks: [
      {
        path: "masks/talk/Tracking 1.mask",
        video: "footage/talk.mp4",
        sourceIn: 0,
        clips: ["index.tsx:clip-1"],
      },
    ],
    source: SAMPLE_SOURCE,
    hash: "hash-v1",
  };

  const defaultCheck: CutCheckResult = {
    stats: { nodes: 4, byKind: { scene: 1, rect: 1, text: 1 }, depth: 2, duration: 12 },
    issues: [],
  };

  const defaultTrackStatus: CutTrackStatusResult = {
    status: "none",
    message: "No object tracking has been requested in this session.",
  };

  const defaultTranscript: CutTranscriptResult = {
    baseHash: "hash-v1",
    unit: "timeline seconds",
    duration: 12,
    total: 6,
    words: [
      { text: "We", start: 0.2, end: 0.4, speaker: "Speaker A" },
      { text: "um", start: 0.5, end: 0.7, speaker: "Speaker A" },
      { text: "moved", start: 0.8, end: 1.1, speaker: "Speaker A" },
      { text: "to", start: 1.15, end: 1.3, speaker: "Speaker A" },
      { text: "Lisbon", start: 1.35, end: 1.8, speaker: "Speaker A" },
      { text: "great", start: 2.0, end: 2.4, speaker: "Speaker B" },
    ],
    nextOffset: null,
    fillers: [{ key: "f1", text: "um", reason: "filler", start: 0.5, end: 0.7 }],
  };

  return {
    isHeld: vi.fn(() => false),
    getCutContext: vi.fn(async () => defaultContext),
    proposeCutEdits: vi.fn(async args => ({
      status: "awaiting_review",
      baseHash: args.baseHash,
      proposedHash: "hash-v2",
    })),
    proposeCutSource: vi.fn(async args => ({
      status: "awaiting_review",
      baseHash: args.baseHash,
      proposedHash: "hash-v2",
    })),
    replaceCutSource: vi.fn(async args => ({
      status: "saved",
      baseHash: args.baseHash,
      hash: "hash-v2",
      changed: true,
      sourceChars: String(args.source ?? "").length,
    })),
    checkCut: vi.fn(async () => defaultCheck),
    exportCut: vi.fn(async args => ({
      path: `/projects/demo.cut/renders/${args.id}.mp4`,
      width: 1920,
      height: 1080,
      duration: 12,
      size: 102400,
    })),
    trackCutObject: vi.fn(async args => ({
      status: "awaiting_person",
      request: "req-1",
      clip: args.clip,
      use: args.use ?? "cutout",
      message: "Opened Object mask tool.",
    })),
    getCutTrackStatus: vi.fn(async () => defaultTrackStatus),
    openCutTranscript: vi.fn(async () => ({
      status: "opened",
      message: "Transcript panel opened.",
    })),
    getCutTranscript: vi.fn(async () => defaultTranscript),
    proposeCutSpeechEdit: vi.fn(async args => ({
      status: "awaiting_review",
      cutCount: Array.isArray(args.ranges) ? args.ranges.length : 0,
      cuts: args.ranges ?? [],
      ...(args.mode === "highlight" ? { sceneName: args.title || "We moved" } : {}),
      remainingSeconds: 8,
    })),
    proposeCutSpeechCleanup: vi.fn(async () => ({
      status: "awaiting_review",
      cutCount: 1,
      cuts: [{ start: 0.5, end: 0.7 }],
      removedSeconds: 0.2,
    })),
    proposeCutCaptions: vi.fn(async () => ({
      status: "awaiting_review",
      message: "Caption generation ready for review.",
    })),
    ...overrides,
  };
}

function invoke(shortName: string, args: Record<string, unknown> = {}): AgentToolInvokeContext {
  return {
    toolCallId: `call-${shortName}`,
    shortName,
    arguments: args,
  };
}

describe("PureCut Operations Registry invariants & plugin.json sync", () => {
  it("reports accurate 3-tier exposure counts and catalog parity", () => {
    const audit = PURECUT_OPERATIONS_REGISTRY.auditSummary();
    expect(audit).toEqual({
      appSlug: "cut",
      functions: 4,
      coreTools: 4,
      extendedTools: 9,
      metaTools: 3,
      totalExposed: 11,
      totalAtomicTools: 13,
      totalRegistered: 17,
      schemaReductionPercent: 15,
    });

    expect(PURECUT_OPERATIONS_REGISTRY.functions.map(f => f.name)).toEqual([
      ...PURECUT_FUNCTION_NAMES,
    ]);
    expect(PURECUT_OPERATIONS_REGISTRY.coreTools.map(t => t.name)).toEqual([
      ...PURECUT_CORE_TOOL_NAMES,
    ]);
    expect(PURECUT_OPERATIONS_REGISTRY.extendedToolNames).toEqual([
      ...PURECUT_EXTENDED_TOOL_NAMES,
    ]);
    expect(PURECUT_OPERATIONS_REGISTRY.exposedToolNames).toEqual([
      ...EXPOSED_TOOL_NAMES,
    ]);
    expect(PURECUT_OPERATIONS_REGISTRY.allAtomicToolNames).toEqual([
      ...PURECUT_ALL_ATOMIC_TOOL_NAMES,
    ]);
    expect(PURECUT_META_TOOL_NAMES).toEqual([
      "discoverAppTools",
      "callExtendedReadTool",
      "callExtendedTool",
    ]);
  });

  it("matches plugin.json app.agents.tools 1:1", () => {
    const manifestPath = resolve(process.cwd(), "plugin.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(manifest.app.agents.tools).toEqual(PURECUT_OPERATIONS_REGISTRY.manifestTools);
  });

  it("satisfies check-manifests rules on every exposed and atomic tool", () => {
    const releaseVerbs = ["send", "merge", "publish", "deposit", "deploy", "post"];
    const validRisks = new Set(["read", "write", "destructive", "external", "release"]);

    for (const tool of PURECUT_OPERATIONS_REGISTRY.manifestTools) {
      expect(validRisks.has(tool.risk)).toBe(true);
      expect(typeof tool.requiresApproval).toBe("boolean");
      const normalizedDesc = tool.description.trim().replace(/\s+/g, " ");
      expect(normalizedDesc.length).toBeGreaterThanOrEqual(80);
      const firstDescWord = normalizedDesc.split(/[^A-Za-z]+/)[0]?.toLowerCase() ?? "";
      const firstNameWord =
        tool.name
          .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
          .split(/[^A-Za-z]+/)[0]
          ?.toLowerCase() ?? "";
      for (const verb of releaseVerbs) {
        expect([verb, `${verb}s`, `${verb}es`, `${verb}ing`, `${verb.replace(/e$/, "")}ing`]).not.toContain(
          firstDescWord,
        );
        expect([verb, `${verb}s`, `${verb}es`, `${verb}ing`, `${verb.replace(/e$/, "")}ing`]).not.toContain(
          firstNameWord,
        );
      }
    }

    // All 13 atomic schemas must also have >= 80-char descriptions and valid risks
    expect(PURECUT_ATOMIC_TOOL_SCHEMAS).toHaveLength(13);
    for (const schema of PURECUT_ATOMIC_TOOL_SCHEMAS) {
      expect(validRisks.has(schema.risk)).toBe(true);
      expect(typeof schema.requiresApproval).toBe("boolean");
      expect(schema.description.trim().replace(/\s+/g, " ").length).toBeGreaterThanOrEqual(80);
    }
  });

  it("builds a handler for every exposed tool name", () => {
    const ctx = createMockContext();
    const handlers = buildPureCutHandlers(() => ctx);
    expect(Object.keys(handlers).sort()).toEqual([...EXPOSED_TOOL_NAMES].sort());
  });
});

describe("PureCut JSX & transcript pure helpers", () => {
  it("parses scenes, active scene, dimensions, and element counts from JSX", () => {
    const overview = parseScenesFromSource(SAMPLE_SOURCE);
    expect(overview.activeSceneId).toBe("main");
    expect(overview.scenes).toEqual([
      { id: "main", name: "Main Edit", active: true, width: 1920, height: 1080 },
      { id: "highlight-1", name: "Lisbon Clip", active: false, width: 1920, height: 1080 },
    ]);
    expect(overview.elementCounts).toEqual({
      scene: 2,
      rect: 2,
      text: 1,
    });
  });

  it("summarizes speakers and locates exact timeline phrase matches", () => {
    const words = [
      { text: "We", start: 0.2, end: 0.4, speaker: "Alice" },
      { text: "moved", start: 0.5, end: 0.9, speaker: "Alice" },
      { text: "to", start: 0.95, end: 1.1, speaker: "Alice" },
      { text: "Lisbon!", start: 1.15, end: 1.6, speaker: "Alice" },
      { text: "Awesome.", start: 2.0, end: 2.5, speaker: "Bob" },
    ];
    expect(summarizeSpeakers(words)).toEqual([
      { speaker: "Alice", wordCount: 4, speakingSeconds: 1.2, firstStart: 0.2, lastEnd: 1.6 },
      { speaker: "Bob", wordCount: 1, speakingSeconds: 0.5, firstStart: 2, lastEnd: 2.5 },
    ]);
    const matches = findTranscriptPhraseMatches(words, ["moved to lisbon"]);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      query: "moved to lisbon",
      start: 0.5,
      end: 1.6,
      speakers: ["Alice"],
      matchedText: "moved to Lisbon!",
    });
  });
});

describe("PureCut composite App Functions", () => {
  it("fn_inspectCutProject gathers context, scene checks, track status, and transcript readiness", async () => {
    const ctx = createMockContext();
    const handlers = buildPureCutHandlers(() => ctx);
    const res = await handlers.fn_inspectCutProject!(invoke("fn_inspectCutProject", {}));
    const parsed = JSON.parse(res.content);

    expect(parsed.ok).toBe(true);
    expect(parsed.opClass).toBe("function");
    expect(parsed.function).toBe("fn_inspectCutProject");
    expect(parsed.data.projectOpen).toBe(true);
    expect(parsed.data.activeSceneId).toBe("main");
    expect(parsed.data.scenes).toHaveLength(2);
    expect(parsed.data.checks).toHaveLength(1);
    expect(parsed.data.checks[0].sceneId).toBe("main");
    expect(parsed.data.exportReady).toBe(true);
    expect(parsed.data.transcript).toMatchObject({
      available: true,
      status: "ready",
      totalWords: 6,
      fillerCount: 1,
    });
    expect(parsed.data.source).toContain('<scene id="main"');
    expect(ctx.checkCut).toHaveBeenCalledWith({ id: "main" });
  });

  it("fn_inspectCutProject checks all scenes and omits source when requested", async () => {
    const ctx = createMockContext({
      checkCut: vi.fn(async args => ({
        stats: { nodes: 2, byKind: { scene: 1 }, depth: 1, duration: 5 },
        issues:
          args.id === "highlight-1"
            ? [{ code: "black-frames", severity: "warning", message: "Gap at end" }]
            : [],
      })),
    });
    const handlers = buildPureCutHandlers(() => ctx);
    const res = await handlers.fn_inspectCutProject!(
      invoke("fn_inspectCutProject", {
        checkAllScenes: true,
        includeSource: false,
        includeTranscriptSummary: false,
      }),
    );
    const parsed = JSON.parse(res.content);

    expect(parsed.data.checks).toHaveLength(2);
    expect(parsed.data.totalErrors).toBe(0);
    expect(parsed.data.totalWarnings).toBe(1);
    expect(parsed.data.exportReady).toBe(true);
    expect(parsed.data.source).toBeUndefined();
    expect(parsed.data.transcript).toBeNull();
    expect(ctx.getCutTranscript).not.toHaveBeenCalled();
  });

  it("fn_inspectCutProject handles closed project cleanly", async () => {
    const ctx = createMockContext({
      getCutContext: vi.fn(async () => ({
        rootDir: "/projects",
        projectDir: null,
        currentTime: null,
        fontFamilies: ["Inter"],
        generations: [],
        objectMasks: [],
      })),
    });
    const handlers = buildPureCutHandlers(() => ctx);
    const res = await handlers.fn_inspectCutProject!(invoke("fn_inspectCutProject", {}));
    const parsed = JSON.parse(res.content);

    expect(parsed.data.projectOpen).toBe(false);
    expect(parsed.data.exportReady).toBe(false);
    expect(ctx.checkCut).not.toHaveBeenCalled();
  });

  it("fn_analyzeCutSpeech paginates transcript pages and finds phrase ranges", async () => {
    const getCutTranscript = vi
      .fn()
      .mockResolvedValueOnce({
        baseHash: "hash-p1",
        duration: 30,
        total: 4,
        words: [
          { text: "Hello", start: 0.1, end: 0.5, speaker: "Host" },
          { text: "everyone", start: 0.6, end: 1.0, speaker: "Host" },
        ],
        nextOffset: 2,
        fillers: [{ text: "uh", reason: "filler", start: 1.2, end: 1.4 }],
      })
      .mockResolvedValueOnce({
        baseHash: "hash-p1",
        duration: 30,
        total: 4,
        words: [
          { text: "welcome", start: 1.5, end: 2.0, speaker: "Guest" },
          { text: "back", start: 2.1, end: 2.5, speaker: "Guest" },
        ],
        nextOffset: null,
        fillers: [],
      });

    const ctx = createMockContext({ getCutTranscript });
    const handlers = buildPureCutHandlers(() => ctx);
    const res = await handlers.fn_analyzeCutSpeech!(
      invoke("fn_analyzeCutSpeech", { queries: ["welcome back"] }),
    );
    const parsed = JSON.parse(res.content);

    expect(getCutTranscript).toHaveBeenCalledTimes(2);
    expect(parsed.data.baseHash).toBe("hash-p1");
    expect(parsed.data.pagesFetched).toBe(2);
    expect(parsed.data.scannedWords).toBe(4);
    expect(parsed.data.speakers).toHaveLength(2);
    expect(parsed.data.matches).toEqual([
      expect.objectContaining({
        query: "welcome back",
        start: 1.5,
        end: 2.5,
        speakers: ["Guest"],
      }),
    ]);
    expect(parsed.data.words).toBeUndefined();
  });

  it("fn_analyzeCutSpeech returns no-transcript status cleanly", async () => {
    const ctx = createMockContext({
      getCutTranscript: vi.fn(async () => ({
        status: "no-transcript",
        message: "No transcript saved yet.",
      })),
    });
    const handlers = buildPureCutHandlers(() => ctx);
    const res = await handlers.fn_analyzeCutSpeech!(invoke("fn_analyzeCutSpeech", {}));
    const parsed = JSON.parse(res.content);

    expect(parsed.data.status).toBe("no-transcript");
    expect(parsed.data.baseHash).toBeNull();
  });

  it("fn_proposeSpeechWorkflow fetches fresh baseHash and dispatches all 5 speech actions", async () => {
    const recordOperation = vi.fn();
    const ctx = createMockContext();
    const handlers = buildPureCutHandlers(() => ctx, { recordOperation });

    const hlRes = await handlers.fn_proposeSpeechWorkflow!(
      invoke("fn_proposeSpeechWorkflow", {
        action: "highlight",
        title: "Moving to Lisbon",
        ranges: [{ start: 0.2, end: 1.8 }],
      }),
    );
    expect(JSON.parse(hlRes.content).data).toMatchObject({
      action: "highlight",
      baseHash: "hash-v1",
      status: "awaiting_review",
      sceneName: "Moving to Lisbon",
    });
    expect(ctx.proposeCutSpeechEdit).toHaveBeenCalledWith({
      baseHash: "hash-v1",
      mode: "highlight",
      title: "Moving to Lisbon",
      ranges: [{ start: 0.2, end: 1.8 }],
    });

    await handlers.fn_proposeSpeechWorkflow!(
      invoke("fn_proposeSpeechWorkflow", { action: "fillers", includeRepetitions: true }),
    );
    expect(ctx.proposeCutSpeechCleanup).toHaveBeenCalledWith({
      baseHash: "hash-v1",
      mode: "fillers",
      includeRepetitions: true,
    });

    await handlers.fn_proposeSpeechWorkflow!(
      invoke("fn_proposeSpeechWorkflow", {
        action: "pauses",
        minimumSeconds: 2,
        retainSeconds: 0.4,
      }),
    );
    expect(ctx.proposeCutSpeechCleanup).toHaveBeenCalledWith({
      baseHash: "hash-v1",
      mode: "pauses",
      minimumSeconds: 2,
      retainSeconds: 0.4,
    });

    await handlers.fn_proposeSpeechWorkflow!(
      invoke("fn_proposeSpeechWorkflow", { action: "captions" }),
    );
    expect(ctx.proposeCutCaptions).toHaveBeenCalledWith({ baseHash: "hash-v1" });
    expect(recordOperation).toHaveBeenCalledTimes(4);
  });

  it("fn_proposeSpeechWorkflow opens transcript panel when no transcript exists and validates args", async () => {
    const recordOperation = vi.fn();
    const ctx = createMockContext({
      getCutTranscript: vi.fn(async () => ({
        status: "no-transcript",
        message: "Open transcript panel.",
      })),
    });
    const handlers = buildPureCutHandlers(() => ctx, { recordOperation });

    const res = await handlers.fn_proposeSpeechWorkflow!(
      invoke("fn_proposeSpeechWorkflow", { action: "captions" }),
    );
    const parsed = JSON.parse(res.content);
    expect(parsed.data.status).toBe("no-transcript");
    expect(parsed.data.openedPanel).toBe(true);
    expect(ctx.openCutTranscript).toHaveBeenCalledTimes(1);
    expect(recordOperation).not.toHaveBeenCalled();

    await expect(
      handlers.fn_proposeSpeechWorkflow!(
        invoke("fn_proposeSpeechWorkflow", { action: "delete" }),
      ),
    ).rejects.toThrow(CutToolError);
  });

  it("fn_trackOrInspectObjectMask reuses existing masks, avoids duplicates, and guards held copies", async () => {
    const ctx = createMockContext();
    const handlers = buildPureCutHandlers(() => ctx);

    // 1. Inspect existing mask for clip-1
    const inspectRes = await handlers.fn_trackOrInspectObjectMask!(
      invoke("fn_trackOrInspectObjectMask", { action: "inspect", clip: "index.tsx:clip-1" }),
    );
    expect(JSON.parse(inspectRes.content).data).toMatchObject({
      hasExistingMask: true,
      canRequestNewTrack: true,
    });

    // 2. Request on clip-1 without forceNew -> advises reuse, does not open tool
    const reuseRes = await handlers.fn_trackOrInspectObjectMask!(
      invoke("fn_trackOrInspectObjectMask", {
        action: "request",
        clip: "index.tsx:clip-1",
        use: "blur",
      }),
    );
    expect(JSON.parse(reuseRes.content).data.status).toBe("existing_mask_available");
    expect(ctx.trackCutObject).not.toHaveBeenCalled();

    // 3. Request with forceNew: true -> opens Object mask tool
    const newTrackRes = await handlers.fn_trackOrInspectObjectMask!(
      invoke("fn_trackOrInspectObjectMask", {
        action: "request",
        clip: "index.tsx:clip-1",
        use: "blur",
        label: "his face",
        forceNew: true,
      }),
    );
    expect(JSON.parse(newTrackRes.content).data.status).toBe("awaiting_person");
    expect(ctx.trackCutObject).toHaveBeenCalledWith({
      clip: "index.tsx:clip-1",
      use: "blur",
      label: "his face",
    });

    // 4. Request when tracking is already pending -> returns already_pending
    const pendingCtx = createMockContext({
      getCutTrackStatus: vi.fn(async () => ({
        status: "pending",
        waitingFor: "click",
        message: "The person has not clicked the subject yet.",
      })),
    });
    const pendingHandlers = buildPureCutHandlers(() => pendingCtx);
    const pendingRes = await pendingHandlers.fn_trackOrInspectObjectMask!(
      invoke("fn_trackOrInspectObjectMask", {
        action: "request",
        clip: "index.tsx:clip-2",
      }),
    );
    expect(JSON.parse(pendingRes.content).data.status).toBe("already_pending");
    expect(pendingCtx.trackCutObject).not.toHaveBeenCalled();

    // 5. Held copy refuses request
    const heldCtx = createMockContext({ isHeld: vi.fn(() => true) });
    const heldHandlers = buildPureCutHandlers(() => heldCtx);
    await expect(
      heldHandlers.fn_trackOrInspectObjectMask!(
        invoke("fn_trackOrInspectObjectMask", {
          action: "request",
          clip: "index.tsx:clip-2",
        }),
      ),
    ).rejects.toThrow(/full app/i);
  });
});

describe("Extended escape-hatch routing, refusals, and held-copy guards", () => {
  it("discoverAppTools lists and searches all 9 extended tools with accurate invokeVia", async () => {
    const ctx = createMockContext();
    const handlers = buildPureCutHandlers(() => ctx);

    const allRes = await handlers.discoverAppTools!(invoke("discoverAppTools", {}));
    const allParsed = JSON.parse(allRes.content);
    expect(allParsed.totalMatched).toBe(9);
    expect(allParsed.operations.map((o: { name: string }) => o.name).sort()).toEqual(
      [...PURECUT_EXTENDED_TOOL_NAMES].sort(),
    );

    const speechRes = await handlers.discoverAppTools!(
      invoke("discoverAppTools", { category: "speech" }),
    );
    const speechParsed = JSON.parse(speechRes.content);
    expect(speechParsed.totalMatched).toBe(5);

    const descRes = await handlers.discoverAppTools!(
      invoke("discoverAppTools", {
        names: ["checkCut", "replaceCutSource", "getCutContext", "fn_inspectCutProject"],
      }),
    );
    const ops = JSON.parse(descRes.content).operations;
    expect(ops).toEqual([
      expect.objectContaining({ name: "checkCut", invokeVia: "callExtendedReadTool" }),
      expect.objectContaining({ name: "replaceCutSource", invokeVia: "callExtendedTool" }),
      expect.objectContaining({ name: "getCutContext", invokeVia: "direct" }),
      expect.objectContaining({ name: "fn_inspectCutProject", invokeVia: "direct" }),
    ]);
  });

  it("callExtendedReadTool routes read-only extended tools and refuses mutating/exposed tools", async () => {
    const ctx = createMockContext();
    const handlers = buildPureCutHandlers(() => ctx);

    const checkRes = await handlers.callExtendedReadTool!(
      invoke("callExtendedReadTool", { tool: "checkCut", arguments: { id: "main" } }),
    );
    expect(JSON.parse(checkRes.content).stats.nodes).toBe(4);
    expect(ctx.checkCut).toHaveBeenCalledWith({ id: "main" });

    const trackStatusRes = await handlers.callExtendedReadTool!(
      invoke("callExtendedReadTool", { tool: "getCutTrackStatus" }),
    );
    expect(JSON.parse(trackStatusRes.content).status).toBe("none");

    const transcriptRes = await handlers.callExtendedReadTool!(
      invoke("callExtendedReadTool", {
        tool: "getCutTranscript",
        arguments: { offset: 0, limit: 10, query: "Lisbon" },
      }),
    );
    expect(JSON.parse(transcriptRes.content).baseHash).toBe("hash-v1");
    expect(ctx.getCutTranscript).toHaveBeenCalledWith({ offset: 0, limit: 10, query: "Lisbon" });

    // Refuses mutating extended tool
    await expect(
      handlers.callExtendedReadTool!(
        invoke("callExtendedReadTool", {
          tool: "replaceCutSource",
          arguments: { baseHash: "hash-v1", source: "<stage />" },
        }),
      ),
    ).rejects.toThrow(/callExtendedTool/i);

    // Refuses directly exposed tool
    await expect(
      handlers.callExtendedReadTool!(
        invoke("callExtendedReadTool", { tool: "getCutContext" }),
      ),
    ).rejects.toThrow(/directly/i);

    // Refuses unknown tool
    await expect(
      handlers.callExtendedReadTool!(
        invoke("callExtendedReadTool", { tool: "doesNotExist" }),
      ),
    ).rejects.toThrow(/Unknown extended tool/i);
  });

  it("callExtendedTool routes mutating extended tools and refuses read-only/exposed tools", async () => {
    const recordOperation = vi.fn();
    const ctx = createMockContext();
    const handlers = buildPureCutHandlers(() => ctx, { recordOperation });

    const replaceRes = await handlers.callExtendedTool!(
      invoke("callExtendedTool", {
        tool: "replaceCutSource",
        arguments: { baseHash: "hash-v1", source: "<stage />" },
      }),
    );
    expect(JSON.parse(replaceRes.content)).toMatchObject({ status: "saved", hash: "hash-v2" });
    expect(recordOperation).toHaveBeenCalledWith(
      ctx,
      "extended.replaceCutSource",
      "Executed extended tool replaceCutSource",
    );

    const openRes = await handlers.callExtendedTool!(
      invoke("callExtendedTool", { tool: "openCutTranscript" }),
    );
    expect(JSON.parse(openRes.content).status).toBe("opened");

    const trackRes = await handlers.callExtendedTool!(
      invoke("callExtendedTool", {
        tool: "trackCutObject",
        arguments: { clip: "index.tsx:clip-1", use: "pixelate" },
      }),
    );
    expect(JSON.parse(trackRes.content).status).toBe("awaiting_person");

    await handlers.callExtendedTool!(
      invoke("callExtendedTool", {
        tool: "proposeCutSpeechEdit",
        arguments: { baseHash: "hash-v1", mode: "delete", ranges: [{ start: 0.5, end: 0.7 }] },
      }),
    );
    await handlers.callExtendedTool!(
      invoke("callExtendedTool", {
        tool: "proposeCutSpeechCleanup",
        arguments: { baseHash: "hash-v1", mode: "fillers" },
      }),
    );
    await handlers.callExtendedTool!(
      invoke("callExtendedTool", {
        tool: "proposeCutCaptions",
        arguments: { baseHash: "hash-v1" },
      }),
    );
    expect(ctx.proposeCutSpeechEdit).toHaveBeenCalledTimes(1);
    expect(ctx.proposeCutSpeechCleanup).toHaveBeenCalledTimes(1);
    expect(ctx.proposeCutCaptions).toHaveBeenCalledTimes(1);

    // Refuses read-only extended tool
    await expect(
      handlers.callExtendedTool!(
        invoke("callExtendedTool", { tool: "checkCut", arguments: { id: "main" } }),
      ),
    ).rejects.toThrow(/callExtendedReadTool/i);

    // Refuses directly exposed tool
    await expect(
      handlers.callExtendedTool!(
        invoke("callExtendedTool", {
          tool: "proposeCutSource",
          arguments: { baseHash: "hash-v1", source: "<stage />" },
        }),
      ),
    ).rejects.toThrow(/directly/i);
  });

  it("enforces held-copy refusals uniformly across direct and extended calls", async () => {
    const ctx = createMockContext({ isHeld: vi.fn(() => true) });
    const handlers = buildPureCutHandlers(() => ctx);

    // exportCut (direct core) refused in held copy
    await expect(
      handlers.exportCut!(invoke("exportCut", { id: "main" })),
    ).rejects.toThrow(/full app/i);

    // trackCutObject (extended) refused in held copy via beforeInvoke
    await expect(
      handlers.callExtendedTool!(
        invoke("callExtendedTool", {
          tool: "trackCutObject",
          arguments: { clip: "index.tsx:clip-1" },
        }),
      ),
    ).rejects.toThrow(/full app/i);

    // Read and proposal tools remain allowed in held copy
    const ctxRes = await handlers.getCutContext!(invoke("getCutContext"));
    expect(JSON.parse(ctxRes.content).hash).toBe("hash-v1");

    const checkRes = await handlers.callExtendedReadTool!(
      invoke("callExtendedReadTool", { tool: "checkCut", arguments: { id: "main" } }),
    );
    expect(JSON.parse(checkRes.content).stats.nodes).toBe(4);
  });
});
