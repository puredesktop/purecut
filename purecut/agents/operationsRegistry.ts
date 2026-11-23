import {
  createAppOperationsRegistry,
  defineAppTool,
  type AppAtomicToolDefinition,
  type BuildHandlersOptions,
} from "@purescience/platform-ui/bridge/appFunctions";
import type {
  AgentToolHandler,
  AgentToolHandlerResult,
} from "@purescience/platform-ui/bridge/react/usePlatformAgentTools";
import { heldRefusal } from "../lib/held-rules";
import { PURECUT_ATOMIC_TOOL_SCHEMAS } from "./atomicToolSchemas";
import { CutToolError, type PureCutAgentContext } from "./context";
import { PURECUT_FUNCTIONS } from "./functions";

type AtomicRunner = (
  ctx: PureCutAgentContext,
  args: Record<string, unknown>,
) => Promise<unknown>;

const ATOMIC_RUNNERS: Record<string, AtomicRunner> = {
  getCutContext: ctx => ctx.getCutContext(),
  proposeCutEdits: (ctx, args) => ctx.proposeCutEdits(args),
  proposeCutSource: (ctx, args) => ctx.proposeCutSource(args),
  replaceCutSource: (ctx, args) => ctx.replaceCutSource(args),
  checkCut: (ctx, args) => ctx.checkCut(args),
  exportCut: (ctx, args) => ctx.exportCut(args),
  trackCutObject: (ctx, args) => ctx.trackCutObject(args),
  getCutTrackStatus: ctx => ctx.getCutTrackStatus(),
  openCutTranscript: ctx => ctx.openCutTranscript(),
  getCutTranscript: (ctx, args) => ctx.getCutTranscript(args),
  proposeCutSpeechEdit: (ctx, args) => ctx.proposeCutSpeechEdit(args),
  proposeCutSpeechCleanup: (ctx, args) => ctx.proposeCutSpeechCleanup(args),
  proposeCutCaptions: (ctx, args) => ctx.proposeCutCaptions(args),
};

function toJsonResult(value: unknown): AgentToolHandlerResult {
  return { content: JSON.stringify(value) };
}

const atomicTools: AppAtomicToolDefinition<PureCutAgentContext>[] =
  PURECUT_ATOMIC_TOOL_SCHEMAS.map(schema =>
    defineAppTool<PureCutAgentContext>({
      ...schema,
      run: async (ctx, args) => {
        const runner = ATOMIC_RUNNERS[schema.name];
        if (!runner) {
          throw new CutToolError(
            `Missing atomic tool handler for "${schema.name}".`,
          );
        }
        return toJsonResult(await runner(ctx, args));
      },
    }),
  );

/**
 * PureCut's unified Operations Registry built on `@purescience/platform-ui/bridge/appFunctions`:
 *   - 4 composite `function` workflows (`fn_*`, always exposed)
 *   - 4 core atomic tools (~31% of 13, always exposed)
 *   - 3 universal escape-hatch meta-tools (always exposed)
 *   - 9 extended specialist atomic tools (hidden by default, 100% reachable on demand)
 */
export const PURECUT_OPERATIONS_REGISTRY =
  createAppOperationsRegistry<PureCutAgentContext>({
    appSlug: "cut",
    appName: "PureCut",
    functions: PURECUT_FUNCTIONS,
    tools: atomicTools,
  });

export function buildPureCutHandlers(
  getCtx: () => PureCutAgentContext,
  options: BuildHandlersOptions<PureCutAgentContext> = {},
): Record<string, AgentToolHandler> {
  const customBeforeInvoke = options.beforeInvoke;
  return PURECUT_OPERATIONS_REGISTRY.buildHandlers(getCtx, {
    createError: message => new CutToolError(message),
    ...options,
    beforeInvoke: async guard => {
      const refused = heldRefusal(guard.ctx.isHeld(), guard.name);
      if (refused) throw new CutToolError(refused);
      await customBeforeInvoke?.(guard);
    },
  });
}
