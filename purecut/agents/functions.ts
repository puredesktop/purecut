import {
  defineAppFunction,
  type AppFunctionDefinition,
} from "@purescience/platform-ui/bridge/appFunctions";
import { heldRefusal } from "../lib/held-rules";
import {
  CutToolError,
  type CutCheckResult,
  type CutObjectMaskSummary,
  type CutTranscriptFiller,
  type CutTranscriptWord,
  type PureCutAgentContext,
} from "./context";

export interface ParsedCutScene {
  id: string;
  name: string | null;
  active: boolean;
  width: number | null;
  height: number | null;
}

export interface ParsedCutSourceOverview {
  scenes: ParsedCutScene[];
  activeSceneId: string | null;
  elementCounts: Record<string, number>;
}

const ELEMENT_TAGS = [
  "scene",
  "rect",
  "text",
  "video",
  "audio",
  "image",
  "path",
  "ellipse",
  "polygon",
  "effect",
  "mask",
] as const;

function parseNumberAttr(attrs: string, attrName: string): number | null {
  const braced = attrs.match(new RegExp(`\\b${attrName}\\s*=\\s*\\{\\s*([0-9]+(?:\\.[0-9]+)?)\\s*\\}`));
  if (braced) return Number(braced[1]);
  const quoted = attrs.match(new RegExp(`\\b${attrName}\\s*=\\s*["']([0-9]+(?:\\.[0-9]+)?)["']`));
  if (quoted) return Number(quoted[1]);
  return null;
}

function parseStringAttr(attrs: string, attrName: string): string | null {
  const match = attrs.match(new RegExp(`\\b${attrName}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`));
  return match ? (match[1] ?? match[2] ?? null) : null;
}

function parseBooleanAttr(attrs: string, attrName: string): boolean {
  const explicitFalse = new RegExp(`\\b${attrName}\\s*=\\s*\\{\\s*false\\s*\\}`);
  if (explicitFalse.test(attrs)) return false;
  const present = new RegExp(`\\b${attrName}(?:\\s*=\\s*\\{\\s*true\\s*\\}|(?=\\s|>|/|$))`);
  return present.test(attrs);
}

/** Deterministically parse `<scene ...>` headers and element tag counts from PureCut JSX. */
export function parseScenesFromSource(source: string | undefined): ParsedCutSourceOverview {
  if (!source) {
    return { scenes: [], activeSceneId: null, elementCounts: {} };
  }
  const scenes: ParsedCutScene[] = [];
  const sceneTagRe = /<scene\b([^>]*?)>/gi;
  let match: RegExpExecArray | null;
  while ((match = sceneTagRe.exec(source)) !== null) {
    const attrs = match[1] ?? "";
    const id = parseStringAttr(attrs, "id");
    if (!id) continue;
    scenes.push({
      id,
      name: parseStringAttr(attrs, "name"),
      active: parseBooleanAttr(attrs, "active"),
      width: parseNumberAttr(attrs, "width"),
      height: parseNumberAttr(attrs, "height"),
    });
  }

  const elementCounts: Record<string, number> = {};
  for (const tag of ELEMENT_TAGS) {
    const count = (source.match(new RegExp(`<${tag}\\b`, "gi")) ?? []).length;
    if (count > 0) elementCounts[tag] = count;
  }

  const activeScene = scenes.find(scene => scene.active) ?? scenes[0] ?? null;
  return {
    scenes,
    activeSceneId: activeScene?.id ?? null,
    elementCounts,
  };
}

export interface SpeakerStat {
  speaker: string;
  wordCount: number;
  speakingSeconds: number;
  firstStart: number;
  lastEnd: number;
}

export function summarizeSpeakers(words: readonly CutTranscriptWord[]): SpeakerStat[] {
  const bySpeaker = new Map<
    string,
    { wordCount: number; speakingSeconds: number; firstStart: number; lastEnd: number }
  >();
  for (const word of words) {
    const key =
      typeof word.speaker === "string" && word.speaker.trim()
        ? word.speaker.trim()
        : "unlabelled";
    const start = typeof word.start === "number" && Number.isFinite(word.start) ? word.start : 0;
    const end = typeof word.end === "number" && Number.isFinite(word.end) ? word.end : start;
    const dur = Math.max(0, end - start);
    const existing = bySpeaker.get(key);
    if (!existing) {
      bySpeaker.set(key, {
        wordCount: 1,
        speakingSeconds: dur,
        firstStart: start,
        lastEnd: end,
      });
    } else {
      existing.wordCount += 1;
      existing.speakingSeconds += dur;
      existing.firstStart = Math.min(existing.firstStart, start);
      existing.lastEnd = Math.max(existing.lastEnd, end);
    }
  }
  return [...bySpeaker.entries()]
    .map(([speaker, stat]) => ({
      speaker,
      wordCount: stat.wordCount,
      speakingSeconds: Math.round(stat.speakingSeconds * 100) / 100,
      firstStart: Math.round(stat.firstStart * 100) / 100,
      lastEnd: Math.round(stat.lastEnd * 100) / 100,
    }))
    .sort((a, b) => b.wordCount - a.wordCount || a.speaker.localeCompare(b.speaker));
}

export interface PhraseMatch {
  query: string;
  start: number;
  end: number;
  wordStartIndex: number;
  wordEndIndex: number;
  speakers: string[];
  matchedText: string;
  contextExcerpt: string;
}

function normalizeToken(text: string): string {
  return text.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

/** Find phrase occurrences across timeline words and return exact edited-timeline ranges. */
export function findTranscriptPhraseMatches(
  words: readonly CutTranscriptWord[],
  queries: readonly string[],
  maxMatchesPerQuery = 20,
): PhraseMatch[] {
  const results: PhraseMatch[] = [];
  const normalizedWords = words.map(w => normalizeToken(String(w.text ?? "")));
  for (const rawQuery of queries) {
    const query = rawQuery.trim();
    if (!query) continue;
    const queryTokens = query
      .split(/\s+/)
      .map(normalizeToken)
      .filter(Boolean);
    if (!queryTokens.length) continue;

    let foundForQuery = 0;
    for (let i = 0; i <= normalizedWords.length - queryTokens.length; i++) {
      let matched = true;
      for (let j = 0; j < queryTokens.length; j++) {
        if (normalizedWords[i + j] !== queryTokens[j]) {
          matched = false;
          break;
        }
      }
      if (!matched) continue;
      const startIndex = i;
      const endIndex = i + queryTokens.length - 1;
      const firstWord = words[startIndex]!;
      const lastWord = words[endIndex]!;
      const ctxStart = Math.max(0, startIndex - 6);
      const ctxEnd = Math.min(words.length, endIndex + 7);
      const speakers = [
        ...new Set(
          words
            .slice(startIndex, endIndex + 1)
            .map(w => (typeof w.speaker === "string" && w.speaker.trim() ? w.speaker.trim() : null))
            .filter((s): s is string => s !== null),
        ),
      ];
      results.push({
        query,
        start: Math.round(firstWord.start * 1000) / 1000,
        end: Math.round(lastWord.end * 1000) / 1000,
        wordStartIndex: startIndex,
        wordEndIndex: endIndex,
        speakers,
        matchedText: words
          .slice(startIndex, endIndex + 1)
          .map(w => w.text)
          .join(" "),
        contextExcerpt: words
          .slice(ctxStart, ctxEnd)
          .map(w => w.text)
          .join(" "),
      });
      foundForQuery += 1;
      if (foundForQuery >= maxMatchesPerQuery) break;
    }
  }
  return results;
}

function summarizeFillers(fillers: readonly CutTranscriptFiller[]) {
  const byReason: Record<string, number> = {};
  for (const filler of fillers) {
    const key = typeof filler.reason === "string" && filler.reason ? filler.reason : "filler";
    byReason[key] = (byReason[key] ?? 0) + 1;
  }
  return {
    count: fillers.length,
    byReason,
    sample: fillers.slice(0, 15),
  };
}

function masksMatchingClip(
  masks: readonly CutObjectMaskSummary[],
  clip: string | undefined,
): CutObjectMaskSummary[] {
  if (!clip) return [...masks];
  const trimmed = clip.trim();
  const bare = trimmed.startsWith("index.tsx:") ? trimmed.slice("index.tsx:".length) : trimmed;
  return masks.filter(mask =>
    mask.clips.some(c => c === trimmed || c === `index.tsx:${bare}` || c === bare),
  );
}

/**
 * PureCut's 4 composite App Functions (`fn_*`), each replacing 2–10 atomic round-trips
 * with one auditable, deterministic workflow call.
 */
export const PURECUT_FUNCTIONS: readonly AppFunctionDefinition<PureCutAgentContext>[] = [
  defineAppFunction<PureCutAgentContext>({
    name: "fn_inspectCutProject",
    category: "inspection",
    risk: "read",
    requiresApproval: false,
    replaces: ["getCutContext", "checkCut", "getCutTrackStatus", "getCutTranscript"],
    description:
      "Inspect the open PureCut project in one call: reads context, hash, playhead, fonts, objectMasks, and JSX, parses scenes, runs structural checks, checks tracking status, and summarizes transcript availability.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        sceneId: {
          type: "string",
          description: "Optional scene id to check; defaults to the active scene.",
        },
        checkAllScenes: {
          type: "boolean",
          description: "Check every scene in the JSX instead of only the active scene (default false).",
        },
        includeSource: {
          type: "boolean",
          description: "Include full JSX source (default true; false for compact summary).",
        },
        includeTranscriptSummary: {
          type: "boolean",
          description: "Include saved transcript readiness, word count, and filler count (default true).",
        },
      },
    },
    run: async (ctx, args) => {
      const includeSource = args.includeSource !== false;
      const checkAllScenes = args.checkAllScenes === true;
      const includeTranscriptSummary = args.includeTranscriptSummary !== false;
      const requestedSceneId =
        typeof args.sceneId === "string" && args.sceneId.trim()
          ? args.sceneId.trim()
          : null;

      const context = await ctx.getCutContext();
      const trackStatus = await ctx.getCutTrackStatus();
      const parsed = parseScenesFromSource(context.source);

      if (!context.projectDir) {
        return {
          mutated: false,
          summary: "No PureCut project is currently open.",
          data: {
            projectOpen: false,
            rootDir: context.rootDir,
            projectDir: null,
            currentTime: context.currentTime,
            fontFamilies: context.fontFamilies,
            generations: context.generations,
            objectMasks: context.objectMasks ?? [],
            pendingTrack: context.pendingTrack ?? null,
            trackStatus,
            scenes: [],
            activeSceneId: null,
            elementCounts: {},
            checks: [],
            totalErrors: 0,
            totalWarnings: 0,
            exportReady: false,
            transcript: null,
          },
        };
      }

      const targetSceneIds: string[] = requestedSceneId
        ? [requestedSceneId]
        : checkAllScenes
          ? parsed.scenes.map(s => s.id)
          : parsed.activeSceneId
            ? [parsed.activeSceneId]
            : [];

      const checks: Array<{
        sceneId: string;
        stats?: CutCheckResult["stats"];
        issues?: CutCheckResult["issues"];
        errorCount: number;
        warningCount: number;
        error?: string;
      }> = [];

      let totalErrors = 0;
      let totalWarnings = 0;

      for (const id of targetSceneIds) {
        try {
          const result = await ctx.checkCut({ id });
          const issues = Array.isArray(result.issues) ? result.issues : [];
          const errorCount = issues.filter(i => i.severity === "error").length;
          const warningCount = issues.filter(i => i.severity === "warning").length;
          totalErrors += errorCount;
          totalWarnings += warningCount;
          checks.push({
            sceneId: id,
            stats: result.stats,
            issues,
            errorCount,
            warningCount,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          totalErrors += 1;
          checks.push({
            sceneId: id,
            errorCount: 1,
            warningCount: 0,
            error: message,
          });
        }
      }

      let transcript: Record<string, unknown> | null = null;
      if (includeTranscriptSummary) {
        try {
          const probe = await ctx.getCutTranscript({ offset: 0, limit: 1 });
          if (probe.status === "no-transcript") {
            transcript = {
              available: false,
              status: "no-transcript",
              message: probe.message ?? "No saved transcript for this scene.",
            };
          } else {
            transcript = {
              available: true,
              status: "ready",
              baseHash: probe.baseHash ?? context.hash ?? null,
              duration: probe.duration ?? null,
              totalWords: probe.total ?? 0,
              fillerCount: Array.isArray(probe.fillers) ? probe.fillers.length : 0,
            };
          }
        } catch (error) {
          transcript = {
            available: false,
            status: "unavailable",
            reason: error instanceof Error ? error.message : String(error),
          };
        }
      }

      const failedGenerations = (context.generations ?? []).filter(
        g => g.state === "failed",
      ).length;
      const activeGenerations = (context.generations ?? []).filter(
        g => g.state === "generating",
      ).length;
      const exportReady =
        targetSceneIds.length > 0 &&
        totalErrors === 0 &&
        failedGenerations === 0 &&
        activeGenerations === 0;

      const summary = `Inspected PureCut project (${parsed.scenes.length} scene(s), ${totalErrors} error(s), ${totalWarnings} warning(s), ${(context.objectMasks ?? []).length} object mask(s), exportReady=${exportReady}).`;

      return {
        mutated: false,
        summary,
        data: {
          projectOpen: true,
          rootDir: context.rootDir,
          projectDir: context.projectDir,
          hash: context.hash ?? null,
          currentTime: context.currentTime,
          fontFamilies: context.fontFamilies,
          generations: context.generations,
          objectMasks: context.objectMasks ?? [],
          pendingTrack: context.pendingTrack ?? null,
          trackStatus,
          scenes: parsed.scenes,
          activeSceneId: parsed.activeSceneId,
          elementCounts: parsed.elementCounts,
          checks,
          totalErrors,
          totalWarnings,
          exportReady,
          transcript,
          ...(includeSource && context.source !== undefined ? { source: context.source } : {}),
        },
      };
    },
  }),

  defineAppFunction<PureCutAgentContext>({
    name: "fn_analyzeCutSpeech",
    category: "speech",
    risk: "read",
    requiresApproval: false,
    replaces: ["getCutTranscript"],
    description:
      "Read and analyze the saved transcript across pages without uploading audio. Returns fresh baseHash, duration, per-speaker stats, filler summary, exact {start, end} phrase matches, and optional timestamped words.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        queries: {
          type: "array",
          maxItems: 20,
          items: { type: "string" },
          description: "Exact phrases to locate with edited-timeline {start, end} ranges.",
        },
        speaker: {
          type: "string",
          description: "Optional case-insensitive speaker filter.",
        },
        includeWords: {
          type: "boolean",
          description: "Include timestamped words (default false with queries, true otherwise).",
        },
        maxWords: {
          type: "integer",
          minimum: 1,
          maximum: 2500,
          description: "Max returned words (default 500; scans up to 5000).",
        },
      },
    },
    run: async (ctx, args) => {
      const queries: string[] = Array.isArray(args.queries)
        ? args.queries
            .filter((q): q is string => typeof q === "string" && q.trim().length > 0)
            .slice(0, 20)
        : [];
      const speakerFilter =
        typeof args.speaker === "string" && args.speaker.trim()
          ? args.speaker.trim().toLowerCase()
          : null;
      const includeWords =
        typeof args.includeWords === "boolean"
          ? args.includeWords
          : queries.length === 0;
      const maxWords =
        typeof args.maxWords === "number" && Number.isInteger(args.maxWords)
          ? Math.max(1, Math.min(2500, args.maxWords))
          : 500;

      const PAGE_SIZE = 500;
      const MAX_PAGES = 10;
      const allWords: CutTranscriptWord[] = [];
      let baseHash: string | null = null;
      let duration: number | null = null;
      let totalWords = 0;
      let fillers: CutTranscriptFiller[] = [];
      let nextOffset: number | null = 0;
      let pagesFetched = 0;

      while (nextOffset !== null && pagesFetched < MAX_PAGES) {
        const page = await ctx.getCutTranscript({
          offset: nextOffset,
          limit: PAGE_SIZE,
        });
        if (page.status === "no-transcript") {
          return {
            mutated: false,
            summary: "No saved transcript exists for the active scene.",
            data: {
              status: "no-transcript",
              baseHash: null,
              message:
                page.message ??
                "Open the transcript panel to transcribe with a configured service.",
              nextAction:
                "Call fn_proposeSpeechWorkflow (with openPanelIfNoTranscript: true) or openCutTranscript via callExtendedTool so the user can review setup and start optional transcription.",
            },
          };
        }
        if (pagesFetched === 0) {
          baseHash = page.baseHash ?? null;
          duration = typeof page.duration === "number" ? page.duration : null;
          totalWords = typeof page.total === "number" ? page.total : 0;
          fillers = Array.isArray(page.fillers) ? page.fillers : [];
        }
        const pageWords = Array.isArray(page.words) ? page.words : [];
        allWords.push(...pageWords);
        pagesFetched += 1;
        if (
          typeof page.nextOffset === "number" &&
          page.nextOffset > nextOffset &&
          pageWords.length > 0
        ) {
          nextOffset = page.nextOffset;
        } else {
          nextOffset = null;
        }
      }

      const filteredWords = speakerFilter
        ? allWords.filter(
            w =>
              typeof w.speaker === "string" &&
              w.speaker.trim().toLowerCase() === speakerFilter,
          )
        : allWords;

      const speakers = summarizeSpeakers(allWords);
      const matches = queries.length
        ? findTranscriptPhraseMatches(filteredWords, queries)
        : [];
      const fillerSummary = summarizeFillers(fillers);
      const transcriptExcerpt = filteredWords
        .slice(0, 120)
        .map(w => w.text)
        .join(" ");

      const summary = `Analyzed saved transcript (${allWords.length}/${totalWords || allWords.length} words across ${pagesFetched} page(s), ${speakers.length} speaker(s), ${fillerSummary.count} filler suggestion(s)${queries.length ? `, ${matches.length} phrase match(es)` : ""}).`;

      return {
        mutated: false,
        summary,
        data: {
          status: "ready",
          baseHash,
          unit: "timeline seconds",
          duration,
          totalWords: totalWords || allWords.length,
          scannedWords: allWords.length,
          truncated: nextOffset !== null,
          pagesFetched,
          speakers,
          fillerSummary,
          ...(queries.length ? { matches } : {}),
          transcriptExcerpt,
          ...(includeWords
            ? {
                words: filteredWords.slice(0, maxWords),
                wordsTruncated: filteredWords.length > maxWords,
              }
            : {}),
        },
      };
    },
  }),

  defineAppFunction<PureCutAgentContext>({
    name: "fn_proposeSpeechWorkflow",
    category: "speech",
    risk: "write",
    requiresApproval: false,
    replaces: [
      "getCutTranscript",
      "openCutTranscript",
      "proposeCutSpeechEdit",
      "proposeCutSpeechCleanup",
      "proposeCutCaptions",
    ],
    description:
      "Prepare a speech edit proposal with a fresh baseHash: delete ranges, create a highlight scene, clean up fillers, shorten silences, or generate captions from the saved transcript. Presents for user review; never mutates directly.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: {
          type: "string",
          enum: ["delete", "highlight", "fillers", "pauses", "captions"],
          description: "Speech workflow to propose.",
        },
        ranges: {
          type: "array",
          minItems: 1,
          maxItems: 500,
          description: "Edited-timeline {start, end} ranges (required for delete/highlight).",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              start: { type: "number", minimum: 0 },
              end: { type: "number", exclusiveMinimum: 0 },
            },
            required: ["start", "end"],
          },
        },
        title: {
          type: "string",
          maxLength: 200,
          description: "Optional highlight scene name describing the passage.",
        },
        includeRepetitions: {
          type: "boolean",
          description: "For fillers: include repeated-word suggestions (default false).",
        },
        minimumSeconds: {
          type: "number",
          exclusiveMinimum: 0,
          description: "For pauses: min silence seconds to shorten (default 1.5).",
        },
        retainSeconds: {
          type: "number",
          minimum: 0,
          description: "For pauses: retained pause seconds (default 0.3, < minimumSeconds).",
        },
        openPanelIfNoTranscript: {
          type: "boolean",
          description: "Open transcript setup panel if no transcript exists (default true).",
        },
      },
      required: ["action"],
    },
    run: async (ctx, args) => {
      const action = typeof args.action === "string" ? args.action : "";
      if (!["delete", "highlight", "fillers", "pauses", "captions"].includes(action)) {
        throw new CutToolError(
          'action must be one of "delete", "highlight", "fillers", "pauses", or "captions".',
        );
      }
      if ((action === "delete" || action === "highlight") && (!Array.isArray(args.ranges) || args.ranges.length === 0)) {
        throw new CutToolError(
          `action "${action}" requires a non-empty ranges array of {start, end} edited-timeline seconds.`,
        );
      }

      const openPanelIfNoTranscript = args.openPanelIfNoTranscript !== false;
      const transcript = await ctx.getCutTranscript({ offset: 0, limit: 1 });
      if (transcript.status === "no-transcript") {
        let panelResult: Record<string, unknown> | null = null;
        if (openPanelIfNoTranscript) {
          panelResult = await ctx.openCutTranscript();
        }
        return {
          mutated: false,
          summary: openPanelIfNoTranscript
            ? "No saved transcript found; opened PureCut's transcript panel so the user can transcribe."
            : "No saved transcript found; nothing proposed.",
          data: {
            action,
            status: "no-transcript",
            openedPanel: openPanelIfNoTranscript,
            ...(panelResult ? { panel: panelResult } : {}),
            message:
              transcript.message ??
              "Open the transcript panel to transcribe with a configured service.",
          },
        };
      }

      const baseHash = transcript.baseHash;
      if (typeof baseHash !== "string" || !baseHash) {
        throw new CutToolError("Could not read a valid transcript baseHash.");
      }

      let proposal: Record<string, unknown>;
      if (action === "delete" || action === "highlight") {
        proposal = await ctx.proposeCutSpeechEdit({
          baseHash,
          mode: action,
          ranges: args.ranges,
          ...(action === "highlight" && args.title !== undefined ? { title: args.title } : {}),
        });
      } else if (action === "fillers") {
        proposal = await ctx.proposeCutSpeechCleanup({
          baseHash,
          mode: "fillers",
          ...(args.includeRepetitions !== undefined
            ? { includeRepetitions: args.includeRepetitions }
            : {}),
        });
      } else if (action === "pauses") {
        proposal = await ctx.proposeCutSpeechCleanup({
          baseHash,
          mode: "pauses",
          ...(args.minimumSeconds !== undefined ? { minimumSeconds: args.minimumSeconds } : {}),
          ...(args.retainSeconds !== undefined ? { retainSeconds: args.retainSeconds } : {}),
        });
      } else {
        proposal = await ctx.proposeCutCaptions({ baseHash });
      }

      const status = typeof proposal.status === "string" ? proposal.status : "awaiting_review";
      const awaitingReview = status === "awaiting_review";
      const summary = awaitingReview
        ? `Prepared PureCut speech proposal (${action}) for user review in the transcript panel.`
        : `PureCut speech workflow (${action}) finished with status "${status}"; nothing changed.`;

      return {
        mutated: awaitingReview,
        summary,
        data: {
          action,
          baseHash,
          ...proposal,
        },
      };
    },
  }),

  defineAppFunction<PureCutAgentContext>({
    name: "fn_trackOrInspectObjectMask",
    category: "tracking",
    risk: "write",
    requiresApproval: false,
    replaces: ["getCutContext", "getCutTrackStatus", "trackCutObject"],
    description:
      "Inspect existing tracked object masks and tracking status, or request the person to track a subject in a video clip (cutout, blur, pixelate, behind). Reuses existing masks, avoids duplicate requests, and refuses in held copies.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: {
          type: "string",
          enum: ["inspect", "request"],
          description: '"inspect" (default) lists masks/status; "request" opens the Object mask tool.',
        },
        clip: {
          type: "string",
          description: 'Video clip "index.tsx:<id>" to filter or target (required for request).',
        },
        at: {
          type: "object",
          additionalProperties: false,
          properties: {
            x: { type: "number", minimum: 0, maximum: 1 },
            y: { type: "number", minimum: 0, maximum: 1 },
          },
          required: ["x", "y"],
          description: "Optional suggested frame point (0-1 from top-left).",
        },
        time: {
          type: "number",
          minimum: 0,
          description: "Optional timeline second within the clip.",
        },
        use: {
          type: "string",
          enum: ["cutout", "blur", "pixelate", "behind"],
          description: "Preselected mask use (default cutout).",
        },
        label: {
          type: "string",
          maxLength: 60,
          description: 'Short subject label shown to the user (e.g. "his face").',
        },
        forceNew: {
          type: "boolean",
          description: "Allow new tracking even when the clip already has a mask (default false).",
        },
      },
    },
    run: async (ctx, args) => {
      const action =
        args.action === undefined ? "inspect" : typeof args.action === "string" ? args.action : "";
      if (action !== "inspect" && action !== "request") {
        throw new CutToolError('action must be "inspect" or "request".');
      }

      const clip =
        typeof args.clip === "string" && args.clip.trim() ? args.clip.trim() : undefined;

      if (action === "request") {
        const refused = heldRefusal(ctx.isHeld(), "trackCutObject");
        if (refused) throw new CutToolError(refused);
        if (!clip) {
          throw new CutToolError(
            'action "request" requires "clip" as "index.tsx:<id>" from getCutContext or fn_inspectCutProject.',
          );
        }
      }

      const context = await ctx.getCutContext();
      const trackStatus = await ctx.getCutTrackStatus();
      const allMasks = context.objectMasks ?? [];
      const matchingMasks = masksMatchingClip(allMasks, clip);
      const pendingTrack = context.pendingTrack ?? null;
      const isPending = Boolean(pendingTrack) || trackStatus.status === "pending";

      if (action === "inspect") {
        return {
          mutated: false,
          summary: `Found ${matchingMasks.length} matching object mask(s) (${allMasks.length} total); track status is "${trackStatus.status}".`,
          data: {
            action: "inspect",
            clip: clip ?? null,
            objectMasks: allMasks,
            matchingMasks,
            hasExistingMask: matchingMasks.length > 0,
            pendingTrack,
            trackStatus,
            canRequestNewTrack: !isPending && !ctx.isHeld(),
          },
        };
      }

      if (isPending) {
        return {
          mutated: false,
          summary: "An object tracking request is already waiting for the person; did not open a duplicate request.",
          data: {
            action: "request",
            status: "already_pending",
            clip: clip!,
            pendingTrack,
            trackStatus,
            matchingMasks,
            message:
              trackStatus.message ||
              "An object tracking request is already in progress. Wait for the person to finish and then inspect status again.",
          },
        };
      }

      if (matchingMasks.length > 0 && args.forceNew !== true) {
        return {
          mutated: false,
          summary: `Found ${matchingMasks.length} existing tracked mask(s) for ${clip}; reuse them instead of re-tracking, or pass forceNew: true for a different subject.`,
          data: {
            action: "request",
            status: "existing_mask_available",
            clip: clip!,
            matchingMasks,
            trackStatus,
            message:
              "Existing tracked mask(s) already cover this clip's footage. Reuse them in proposeCutSource / proposeCutEdits, or re-call with forceNew: true if you need to track a different object.",
          },
        };
      }

      const trackResult = await ctx.trackCutObject({
        clip: clip!,
        ...(args.at !== undefined ? { at: args.at } : {}),
        ...(args.time !== undefined ? { time: args.time } : {}),
        ...(args.use !== undefined ? { use: args.use } : {}),
        ...(args.label !== undefined ? { label: args.label } : {}),
      });

      return {
        mutated: true,
        summary: `Opened PureCut's Object mask tool on ${clip} for user confirmation (awaiting_person).`,
        data: {
          action: "request",
          existingMasks: matchingMasks,
          ...trackResult,
        },
      };
    },
  }),
];
