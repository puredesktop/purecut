import { bridge } from "@purescience/platform-ui/bridge/client.mjs";
import {
  registerAgentTools,
  onAgentToolInvoke,
} from "@purescience/platform-ui/bridge/agents";
import type { AgentToolHandlerResult } from "@purescience/platform-ui/bridge/react/usePlatformAgentTools";
import { request, runTool } from "./transport";
import { toast } from "somoto";
import { applyReviewedSource } from "./source-change";
import { heldInRoom } from "./held";
import {
  EXPOSED_TOOL_NAMES,
  PURECUT_EXTENDED_TOOL_NAMES,
} from "./agents/catalog";
import type {
  CutCheckResult,
  CutContextResult,
  CutTrackStatusResult,
  CutTranscriptResult,
  PureCutAgentContext,
} from "./agents/context";
import {
  PURECUT_OPERATIONS_REGISTRY,
  buildPureCutHandlers,
} from "./agents/operationsRegistry";

function announceSourceChange(change: Awaited<ReturnType<typeof applyReviewedSource>>) {
  const label = change.isApplied() ? "Undo" : "Redo";
  toast(change.isApplied() ? "Proposed edit applied" : "Proposed edit undone", {
    duration: 20000,
    action: {
      label,
      onClick: () => {
        void change.reverse().then(() => announceSourceChange(change)).catch(error => {
          toast.error(`Could not ${label.toLowerCase()} the proposed edit`, {
            description: error instanceof Error ? error.message : String(error),
          });
        });
      },
    },
  });
}

async function flushEditsAndRequireContext(): Promise<CutContextResult & { projectDir: string }> {
  await (await import("@/projects/edits")).flushPendingProjectEdits();
  const context = (await runTool("context")) as CutContextResult;
  if (!context.projectDir) throw Error("Open a video first");
  return context as CutContextResult & { projectDir: string };
}

const liveContext: PureCutAgentContext = {
  isHeld: () => heldInRoom(),
  async getCutContext() {
    await (await import("@/projects/edits")).flushPendingProjectEdits();
    const context = (await runTool("context")) as CutContextResult;
    const pendingTrack = (await import("./track-object")).pendingTrackSummary();
    return {
      ...context,
      ...(context.projectDir
        ? await request("purecut:source", { dir: context.projectDir })
        : {}),
      ...(pendingTrack ? { pendingTrack } : {}),
    };
  },
  async proposeCutEdits(args) {
    const context = await flushEditsAndRequireContext();
    const { validateScopedEdits } = await import("./lib/scoped-edits");
    const edits = validateScopedEdits(args.edits);
    const proposal = await request("purecut:prepare-edits", {
      dir: context.projectDir,
      baseHash: args.baseHash,
      edits,
    });
    const { sourceReview } = await import("./edit-review");
    if ((await runTool("context")).projectDir !== proposal.dir) {
      throw Error("The open project changed while preparing the edit.");
    }
    sourceReview.present(proposal, async reviewed => {
      const { flushPendingProjectEdits } = await import("@/projects/edits");
      const { requireEditorSession } = await import("@/dapi/session");
      const { applyScopedEdits } = await import("@/engine/scoped-edits");
      await flushPendingProjectEdits();
      const session = requireEditorSession();
      if (session.project.dir() !== reviewed.dir) {
        throw Error("Open the reviewed project before applying this edit.");
      }
      const current = await request("purecut:source", { dir: reviewed.dir });
      if (current.hash !== reviewed.baseHash || requireEditorSession() !== session) {
        throw Error("Project changed. Request a new proposal before applying.");
      }
      applyScopedEdits(session.world, edits);
      await flushPendingProjectEdits();
      toast("Proposed edits applied");
    });
    return { status: "awaiting_review", baseHash: proposal.baseHash, proposedHash: proposal.hash };
  },
  async proposeCutSource(args) {
    const context = await flushEditsAndRequireContext();
    const { sourceReview } = await import("./edit-review");
    const proposal = await request("purecut:prepare", { ...args, dir: context.projectDir });
    if ((await runTool("context")).projectDir !== proposal.dir) {
      throw Error("The open project changed while preparing the edit.");
    }
    sourceReview.present(proposal, async reviewed => {
      const change = await applyReviewedSource(reviewed, async edit => {
        await (await import("@/projects/edits")).flushPendingProjectEdits();
        const current = await runTool("context");
        if (current.projectDir !== edit.dir) {
          throw Error("Open the reviewed project before applying this edit.");
        }
        return request("purecut:replace", edit);
      });
      announceSourceChange(change);
    });
    return { status: "awaiting_review", baseHash: proposal.baseHash, proposedHash: proposal.hash };
  },
  async replaceCutSource(args) {
    const context = await flushEditsAndRequireContext();
    // The channel hands back the whole saved JSX (the reviewed-apply path keeps
    // it); the agent only needs the new hash, so the reply never echoes the source.
    const saved = await request("purecut:replace", { ...args, dir: context.projectDir });
    return {
      status: "saved",
      baseHash: args.baseHash,
      hash: saved.hash,
      changed: saved.hash !== args.baseHash,
      sourceChars: saved.source.length,
      next: "Pass hash as baseHash to the next edit. Call getCutContext to read the saved JSX.",
    };
  },
  async checkCut(args) {
    await flushEditsAndRequireContext();
    return (await runTool("check", { id: args.id })) as CutCheckResult;
  },
  async exportCut(args) {
    const context = await flushEditsAndRequireContext();
    return (await runTool("export", {
      id: args.id,
      path: `${context.projectDir}/renders/${String(args.id).replace(/[^a-zA-Z0-9_-]/g, "_")}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.mp4`,
    })) as Record<string, unknown>;
  },
  async trackCutObject(args) {
    await (await import("@/projects/edits")).flushPendingProjectEdits();
    // Object tracking: the person tracks, on this computer; the agent only asks and reads the outcome.
    return (await import("./track-object")).trackCutObject(args);
  },
  async getCutTrackStatus() {
    await (await import("@/projects/edits")).flushPendingProjectEdits();
    return (await import("./track-object")).getCutTrackStatus() as CutTrackStatusResult;
  },
  async openCutTranscript() {
    return (await (await import("./speech/tools")).speechTool(
      "openCutTranscript",
      {},
    )) as Record<string, unknown>;
  },
  async getCutTranscript(args) {
    return (await (await import("./speech/tools")).speechTool(
      "getCutTranscript",
      args,
    )) as CutTranscriptResult;
  },
  async proposeCutSpeechEdit(args) {
    return (await (await import("./speech/tools")).speechTool(
      "proposeCutSpeechEdit",
      args,
    )) as Record<string, unknown>;
  },
  async proposeCutSpeechCleanup(args) {
    return (await (await import("./speech/tools")).speechTool(
      "proposeCutSpeechCleanup",
      args,
    )) as Record<string, unknown>;
  },
  async proposeCutCaptions(args) {
    return (await (await import("./speech/tools")).speechTool(
      "proposeCutCaptions",
      args,
    )) as Record<string, unknown>;
  },
};

const drawerHandlers = buildPureCutHandlers(() => liveContext);
const extendedReadToolNames = new Set(
  PURECUT_OPERATIONS_REGISTRY.extendedTools
    .filter(tool => tool.risk === "read")
    .map(tool => tool.name),
);

async function invokeExposedCutTool(
  name: string,
  args: Record<string, unknown> = {},
  toolCallId = "",
): Promise<AgentToolHandlerResult> {
  // Statically key-preserving dispatch so `scripts/check-manifests.mjs`
  // verifies every manifest tool has a registered handler.
  if ((EXPOSED_TOOL_NAMES as readonly string[]).includes(name)) {
    const handler = drawerHandlers[name];
    if (handler) {
      return handler({ toolCallId, shortName: name, arguments: args });
    }
  }
  throw Error("Unknown PureCut tool");
}

/**
 * Direct programmatic entry point used by internal tests/fixtures and the drawer bridge.
 * Supports both exposed tools/functions (`EXPOSED_TOOL_NAMES`) and extended atomic tools
 * (routed through the registry's extended escape hatches so all guards run uniformly).
 */
export async function cutTool(name: string, args: any = {}) {
  const normalizedArgs: Record<string, unknown> =
    args && typeof args === "object" && !Array.isArray(args) ? args : {};
  if ((EXPOSED_TOOL_NAMES as readonly string[]).includes(name)) {
    const result = await invokeExposedCutTool(name, normalizedArgs);
    return JSON.parse(result.content);
  }
  if ((PURECUT_EXTENDED_TOOL_NAMES as readonly string[]).includes(name)) {
    const metaTool = extendedReadToolNames.has(name)
      ? "callExtendedReadTool"
      : "callExtendedTool";
    const result = await invokeExposedCutTool(metaTool, {
      tool: name,
      arguments: normalizedArgs,
    });
    return JSON.parse(result.content);
  }
  throw Error("Unknown PureCut tool");
}

if (window.parent !== window)
  void bridge
    .waitForReady()
    .then(async () => {
      onAgentToolInvoke(async ({ shortName, arguments: args, toolCallId }) => {
        const result = await invokeExposedCutTool(
          shortName,
          args && typeof args === "object" && !Array.isArray(args)
            ? (args as Record<string, unknown>)
            : {},
          toolCallId,
        );
        return {
          toolCallId,
          content: result.content,
          ...(result.images?.length ? { images: result.images } : {}),
        };
      });
      await registerAgentTools({
        tools: [...EXPOSED_TOOL_NAMES],
      });
    })
    .catch(console.error);
