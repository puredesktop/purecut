/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { z } from "zod";
import { defineTool } from "../tool";

const GenerationRow = z.object({
  element: z
    .string()
    .nullable()
    .describe("the element's source stamp, `<file>:<key or position>`; null for an entity no element produced"),
  name: z.string().nullable(),
  state: z.enum(["generating", "failed", "done"]),
  error: z.string().optional().describe("what the generation failed with, on failed rows"),
  asset: z
    .string()
    .optional()
    .describe("the library path the generation landed as, on done rows — ready for media_probe and its siblings"),
});

const ObjectMaskRow = z.object({
  path: z.string().describe("the `.mask` file in the library, for a `<mask src>`"),
  video: z.string().nullable().describe("library path of the footage it was tracked on; null when that video is gone"),
  sourceIn: z.number().describe("seconds: the footage's source time of the mask's first frame, for the `<mask sourceIn>`"),
  clips: z
    .array(z.string())
    .describe("source stamps (`<file>:<id>`) of the clips that play that footage: the ids a `<mask follow>` can name"),
});

/**
 * What the project's source cannot say: the JSX already holds the scenes,
 * the selection, and the work area, so the report is only the folders, the
 * playhead, the fonts actually registered, and where generations stand.
 */
export const context = defineTool({
  name: "context",
  title: "App context",
  description:
    "Report the current app context: the folder new projects are created in (always reported), the folder of the project the app has open (null when none is), where its playhead sits in seconds, the registered font families, where its `generate.*` declarations stand, and the object masks the user tracked. Poll it to wait for generations without blocking.",
  input: z.object({}),
  output: z.object({
    rootDir: z.string().nullable().describe("folder new projects are created in; null until one has been chosen"),
    projectDir: z.string().nullable().describe("absolute path of the open project; null when none is open"),
    currentTime: z
      .number()
      .nullable()
      .describe("playhead in seconds, the unit the source places clips in; null when no scene is active or no project is open"),
    fontFamilies: z
      .array(z.string())
      .describe("families registered in the world drawing the project; the editor default is always among them"),
    generations: z.array(GenerationRow),
    objectMasks: z
      .array(ObjectMaskRow)
      .optional()
      .describe("masks the user tracked with the Object mask tool, in the library whether or not the JSX uses them yet"),
  }),
  environment: "renderer",
});

export type GenerationRow = z.output<typeof GenerationRow>;
export type ObjectMaskRow = z.output<typeof ObjectMaskRow>;
