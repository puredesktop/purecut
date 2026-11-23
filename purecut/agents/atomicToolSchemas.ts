import type {
  AppOperationExposure,
  AppOperationRisk,
} from "@purescience/platform-ui/bridge/appFunctions";

export interface AtomicToolSchemaSpec {
  name: string;
  exposure: AppOperationExposure;
  category: string;
  risk: AppOperationRisk;
  requiresApproval: boolean;
  releaseButton?: string;
  deletesPermanently?: boolean;
  riskWhen?: Record<string, "write" | "destructive" | "external" | "release">;
  requiresCapabilities?: Array<"vision">;
  description: string;
  inputSchema: Record<string, unknown> & { type: "object" };
}

/**
 * All 13 atomic PureCut tools with 3-tier exposure metadata:
 *   - "always" (4, ~31%): core context, scoped/source review proposals, and approval-gated MP4 export.
 *   - "extended" (9, ~69%): specialist direct-replace, structural check, object-mask tracking,
 *     and transcript/speech/caption tools discoverable via `discoverAppTools` and callable via
 *     `callExtendedReadTool` / `callExtendedTool` with zero loss of functionality.
 */
export const PURECUT_ATOMIC_TOOL_SCHEMAS: readonly AtomicToolSchemaSpec[] = [
  // ── Core atomic tools (exposure: 'always') ───────────────────────────────
  {
    name: "getCutContext",
    exposure: "always",
    category: "context",
    risk: "read",
    requiresApproval: false,
    description:
      "Read the open timeline project JSX, revision hash, playhead, fonts, objectMasks (masks the user tracked, each with its .mask path, footage, sourceIn and the clip ids playing that footage) and pendingTrack (a trackCutObject request still waiting for the person). Read before edits.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "proposeCutEdits",
    exposure: "always",
    category: "editing",
    risk: "write",
    requiresApproval: false,
    description:
      "Propose scoped changes to directly authored elements for user review. Apply uses normal editor undo as one step and preserves prior history. Prefer for timing, placement, appearance and text edits. Read getCutContext first; use index.tsx:<stable element id> targets. Does not edit video by transcript or change asset sources. Locked or loop-generated targets are rejected.",
    inputSchema: {
      type: "object",
      properties: {
        baseHash: {
          type: "string",
        },
        edits: {
          type: "array",
          minItems: 1,
          maxItems: 100,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              source: {
                type: "string",
              },
              text: {
                type: "string",
                maxLength: 20000,
                description:
                  "The words a text element says, replacing its current words. Not for styling: to recolour a text use props.fill.",
              },
              props: {
                type: "object",
                additionalProperties: false,
                properties: {
                  x: {
                    type: "number",
                  },
                  y: {
                    type: "number",
                  },
                  width: {
                    type: "number",
                  },
                  height: {
                    type: "number",
                  },
                  rotation: {
                    type: "number",
                  },
                  opacity: {
                    type: "number",
                  },
                  fontSize: {
                    type: "number",
                  },
                  fill: {
                    type: "string",
                    description:
                      "Hex colour such as #DF2626. On a text or rect this is the colour it is seen in: it recolours the element's topmost visible solid paint (or its own fill when it has none). Never put a colour in `text`; `text` is only what the element says.",
                  },
                  start: {
                    type: "number",
                  },
                  end: {
                    type: "number",
                  },
                  value: {
                    type: "number",
                    description:
                      "An <effect>'s amount: blur radius or pixelate block size in px (privacy strength), hueRotate degrees, 0-1 otherwise.",
                  },
                  blur: {
                    type: "number",
                    description:
                      "On a <mask>: its feather in px. On a node: its own blur in px.",
                  },
                },
              },
            },
            required: ["source"],
          },
        },
      },
      required: ["baseHash", "edits"],
    },
  },
  {
    name: "proposeCutSource",
    exposure: "always",
    category: "editing",
    risk: "write",
    requiresApproval: false,
    description:
      "Propose edited project JSX for the user to review and apply. Read getCutContext first and use its baseHash. Does not save until the user applies the proposal. Preserve unrelated content and stable ids. Prefer this over direct replacement. For clip paths, object masks, privacy blur and text behind a subject see agents.md: reuse existing .mask files only (getCutContext objectMasks); the user's Object mask tool makes them, and when none exists ask the user to track the subject with it.",
    inputSchema: {
      type: "object",
      properties: {
        source: {
          type: "string",
        },
        baseHash: {
          type: "string",
        },
      },
      required: ["source", "baseHash"],
    },
  },
  {
    name: "exportCut",
    exposure: "always",
    category: "export",
    risk: "write",
    requiresApproval: true,
    description:
      "Render a scene from the open PureCut project to an MP4 video file in the project renders folder using a scene id from getCutContext. Only call when explicitly requested by the user; export does not prove transcript accuracy or speech-cut quality (review playback for those). Refuses when held inside a page.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
        },
      },
      required: ["id"],
    },
  },

  // ── Extended specialist tools (exposure: 'extended') ─────────────────────
  {
    name: "replaceCutSource",
    exposure: "extended",
    category: "editing",
    risk: "write",
    requiresApproval: true,
    description:
      "Replace the open project JSX using its current baseHash. Compiles before saving. Preserve unrelated content and stable ids. Replies with status saved and the new hash (pass it as baseHash next), not the source; call getCutContext to read the saved JSX.",
    inputSchema: {
      type: "object",
      properties: {
        source: {
          type: "string",
        },
        baseHash: {
          type: "string",
        },
      },
      required: ["source", "baseHash"],
    },
  },
  {
    name: "checkCut",
    exposure: "extended",
    category: "inspection",
    risk: "read",
    requiresApproval: false,
    description:
      "Inspect the active scene or a specific node subtree in the open PureCut project for missing media sources, black-frame gaps, zero-duration or never-visible elements, and composition problems without rendering. Pass a scene or node id from getCutContext; structural check only, not a visual review.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "trackCutObject",
    exposure: "extended",
    category: "tracking",
    risk: "write",
    requiresApproval: false,
    description:
      "Ask the person to track an object (a face, a person, a plate) in a video clip, to blur, pixelate or cut it out or put a text behind it. You never run a model and cannot see the video: give the clip, optionally the point where you believe the subject is (0-1 of the clip's frame) and the time. PureCut opens its Object mask tool on that clip with your point shown as a suggestion and the use preselected; the person clicks the subject or takes your point, agrees to the one-time model download if needed, and confirms. Tracking runs in the app on this computer. Returns awaiting_person immediately: nothing has changed yet. One request at a time; locked, loop-generated and non-video clips are rejected. Afterwards call getCutTrackStatus.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        clip: {
          type: "string",
          description:
            "The video clip, index.tsx:<id> (see getCutContext objectMasks[].clips or the JSX).",
        },
        at: {
          type: "object",
          additionalProperties: false,
          properties: {
            x: {
              type: "number",
              minimum: 0,
              maximum: 1,
            },
            y: {
              type: "number",
              minimum: 0,
              maximum: 1,
            },
          },
          required: ["x", "y"],
          description:
            "Suggested point on the subject, 0-1 from the top left of the clip's video frame. Only a suggestion the person confirms or replaces.",
        },
        time: {
          type: "number",
          minimum: 0,
          description:
            "Seconds on the scene timeline to show; must be within the clip. Defaults to the playhead, or the clip's start.",
        },
        use: {
          type: "string",
          enum: ["cutout", "blur", "pixelate", "behind"],
          description:
            "What the mask is for: cutout (keep only the object), blur or pixelate (hide it), behind (put the texts above the clip behind it). Default cutout. The person may change it.",
        },
        label: {
          type: "string",
          maxLength: 60,
          description:
            'What to call the object in the request the person sees, e.g. "his face".',
        },
      },
      required: ["clip"],
    },
  },
  {
    name: "getCutTrackStatus",
    exposure: "extended",
    category: "tracking",
    risk: "read",
    requiresApproval: false,
    description:
      "What came of the latest trackCutObject request: pending (with what the person still has to do), done (the new mask path and the use applied; the source already changed, read getCutContext), cancelled, unavailable (no WebGPU on this computer) or failed, each with a message you can relay. Reads app state only; call it when the person says they are done, not in a loop.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "openCutTranscript",
    exposure: "extended",
    category: "speech",
    risk: "write",
    requiresApproval: false,
    description:
      "Open the transcript panel. The user can optionally transcribe using their configured speech provider. Does not start transcription or upload audio.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "getCutTranscript",
    exposure: "extended",
    category: "speech",
    risk: "read",
    requiresApproval: false,
    description:
      "Read saved transcript words and speaker labels on the active scene timeline, plus revision hash. Use pagination; query finds exact phrases in nearby words. No upload or transcription. Use this to find passages for highlights and unwanted speech.",
    inputSchema: {
      type: "object",
      properties: {
        offset: {
          type: "integer",
          minimum: 0,
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 500,
        },
        query: {
          type: "string",
        },
      },
    },
  },
  {
    name: "proposeCutSpeechEdit",
    exposure: "extended",
    category: "speech",
    risk: "write",
    requiresApproval: false,
    description:
      "Propose removal of spoken passages or create a separate highlight scene from selected passages. Read getCutTranscript first. Ranges are edited timeline seconds, not original media seconds. Deletions close gaps across speech and captions. Highlight preserves the original scene and adds a new named scene beside it (title names it; the reply gives sceneName). User reviews before anything changes. Keep context and natural pauses between words; do not invent quotations. Replies with cutCount and the first 50 cuts (cutsNotListed says how many more); the review holds them all.",
    inputSchema: {
      type: "object",
      properties: {
        baseHash: {
          type: "string",
        },
        mode: {
          type: "string",
          enum: ["delete", "highlight"],
        },
        title: {
          type: "string",
          maxLength: 200,
          description:
            'Highlight only: a short name for the new scene, about what is said in it (e.g. "Why we moved to Lisbon"), not "Highlight". Leave it out to offer the first words of the passage. The person can change it in the review; a name already used by another scene gets a number added. Ignored for delete.',
        },
        ranges: {
          type: "array",
          minItems: 1,
          maxItems: 500,
          items: {
            type: "object",
            properties: {
              start: {
                type: "number",
                minimum: 0,
              },
              end: {
                type: "number",
                exclusiveMinimum: 0,
              },
            },
            required: ["start", "end"],
            additionalProperties: false,
          },
        },
      },
      required: ["baseHash", "mode", "ranges"],
      additionalProperties: false,
    },
  },
  {
    name: "proposeCutSpeechCleanup",
    exposure: "extended",
    category: "speech",
    risk: "write",
    requiresApproval: false,
    description:
      "Propose filler/repetition removal or shorten real audio silences, measured against the recording's own background noise (music or steady noise has none). Read getCutTranscript for the current baseHash first. Optional speech service is only needed to create the saved transcript. No uploads. User reviews and applies; nothing changes immediately. Repetitions are suggestions, not certain mistakes. Replies with cutCount, removedSeconds and the first 50 cuts (cutsNotListed says how many more); the review holds them all.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        baseHash: {
          type: "string",
        },
        mode: {
          type: "string",
          enum: ["fillers", "pauses"],
        },
        includeRepetitions: {
          type: "boolean",
          default: false,
        },
        minimumSeconds: {
          type: "number",
          exclusiveMinimum: 0,
          default: 1.5,
        },
        retainSeconds: {
          type: "number",
          minimum: 0,
          default: 0.3,
        },
      },
      required: ["baseHash", "mode"],
    },
  },
  {
    name: "proposeCutCaptions",
    exposure: "extended",
    category: "speech",
    risk: "write",
    requiresApproval: false,
    description:
      "Propose generating captions from the saved transcript. Read getCutTranscript for the current baseHash first. No new transcription or upload. Replaces existing captions in the active speech scene only after user review; normal Undo restores them.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        baseHash: {
          type: "string",
        },
      },
      required: ["baseHash"],
    },
  },
];
