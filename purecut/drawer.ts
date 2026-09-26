import { bridge } from "@purescience/platform-ui/bridge/client.mjs";
import {
  registerAgentTools,
  onAgentToolInvoke,
} from "@purescience/platform-ui/bridge/agents";
import { request, runTool } from "./transport";
import { toast } from "somoto";
import { applyReviewedSource } from "./source-change";

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
export async function cutTool(name: string, args: any = {}) {
  if (["getCutTranscript", "proposeCutSpeechEdit", "proposeCutSpeechCleanup", "proposeCutCaptions", "openCutTranscript"].includes(name))
    return (await import("./speech/tools")).speechTool(name,args);
  await (await import("@/projects/edits")).flushPendingProjectEdits();
  const context = await runTool("context");
  if (name === "getCutContext")
    return {
      ...context,
      ...(context.projectDir
        ? await request("purecut:source", { dir: context.projectDir })
        : {}),
    };
  if (!context.projectDir) throw Error("Open a video first");
  if (name === "proposeCutEdits") {
    const { validateScopedEdits } = await import("./lib/scoped-edits");
    const edits = validateScopedEdits(args.edits);
    const proposal = await request("purecut:prepare-edits", { dir: context.projectDir, baseHash: args.baseHash, edits });
    const { sourceReview } = await import("./edit-review");
    if ((await runTool("context")).projectDir !== proposal.dir) throw Error("The open project changed while preparing the edit.");
    sourceReview.present(proposal, async reviewed => {
      const { flushPendingProjectEdits } = await import("@/projects/edits");
      const { requireEditorSession } = await import("@/dapi/session");
      const { applyScopedEdits } = await import("@/engine/scoped-edits");
      await flushPendingProjectEdits();
      const session = requireEditorSession();
      if (session.project.dir() !== reviewed.dir) throw Error("Open the reviewed project before applying this edit.");
      const current = await request("purecut:source", { dir: reviewed.dir });
      if (current.hash !== reviewed.baseHash || requireEditorSession() !== session)
        throw Error("Project changed. Request a new proposal before applying.");
      applyScopedEdits(session.world, edits);
      await flushPendingProjectEdits();
      toast("Proposed edits applied");
    });
    return { status: "awaiting_review", baseHash: proposal.baseHash, proposedHash: proposal.hash };
  }
  if (name === "proposeCutSource") {
    const { sourceReview } = await import("./edit-review");
    const proposal = await request("purecut:prepare", { ...args, dir: context.projectDir });
    if ((await runTool("context")).projectDir !== proposal.dir)
      throw Error("The open project changed while preparing the edit.");
    sourceReview.present(proposal, async reviewed => {
      const change = await applyReviewedSource(reviewed, async edit => {
        await (await import("@/projects/edits")).flushPendingProjectEdits();
        const current = await runTool("context");
        if (current.projectDir !== edit.dir) throw Error("Open the reviewed project before applying this edit.");
        return request("purecut:replace", edit);
      });
      announceSourceChange(change);
    });
    return { status: "awaiting_review", baseHash: proposal.baseHash, proposedHash: proposal.hash };
  }
  if (name === "replaceCutSource")
    return request("purecut:replace", { ...args, dir: context.projectDir });
  if (name === "checkCut") return runTool("check", { id: args.id });
  if (name === "exportCut")
    return runTool("export", {
      id: args.id,
      path: `${context.projectDir}/renders/${String(args.id).replace(/[^a-zA-Z0-9_-]/g, "_")}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.mp4`,
    });
  throw Error("Unknown PureCut tool");
}
if (window.parent !== window)
  void bridge
    .waitForReady()
    .then(async () => {
      onAgentToolInvoke(async ({ shortName, arguments: args, toolCallId }) => ({
        toolCallId,
        content: JSON.stringify(await cutTool(shortName, args)),
      }));
      await registerAgentTools({
        tools: ["getCutTranscript", "proposeCutSpeechEdit", "proposeCutSpeechCleanup", "proposeCutCaptions", "openCutTranscript", "getCutContext", "proposeCutEdits", "proposeCutSource", "replaceCutSource", "checkCut", "exportCut"],
      });
    })
    .catch(console.error);
