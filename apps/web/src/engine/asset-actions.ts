/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// File actions on the library, with the user told how they went: the
// mechanics live in @diffusionstudio/assets.

import { toast } from "somoto";
import { resolveTranscript, serializeSubtitles, type SubtitleFormat } from "@diffusionstudio/runtime";
import { assetName, importFiles as importFilesInto, pickFiles, saveAssetAs as saveAs } from "@diffusionstudio/assets";
import { insertAsset } from "./insert-asset";
import { describeImport } from "./import-outcomes";
import { getEditHistory } from "./history";
import { followSelection, replacementStep } from "./media-replacement";
import { forgetAssetMedia } from "./timeline/media";
import { forgetAssetPeaks } from "./timeline/peaks";

import type { World } from "koota";

import type { Asset, AssetLibrary, ImportOutcome } from "@diffusionstudio/assets";

export { droppedFiles, pickFiles } from "@diffusionstudio/assets";

/** Saves a copy of an asset's file where the user says; reports failure. */
export async function saveAssetAs(asset: Pick<Asset, "handle" | "mimeType" | "path">): Promise<void> {
  try {
    await saveAs(asset);
  } catch (error) {
    toast.error("Failed to save", { description: (error as Error).message });
  }
}

export async function exportSourceSubtitles(asset: Asset, format: SubtitleFormat): Promise<void> {
  const path = `${asset.path.replace(/\.[^/.]+$/, '')}.${format}`;
  const mimeType = format === 'srt' ? 'application/x-subrip' : 'text/vtt';
  await saveAssetAs({ path, mimeType, handle: { async getFile() {
    const transcript = await resolveTranscript(asset);
    if (!transcript.length) throw new Error('This asset has no caption cues');
    return new File([serializeSubtitles(transcript, format)], path.split('/').pop()!, { type: mimeType });
  } } });
}

export interface ImportReport {
  /** What became of every file, in the order they were given. */
  outcomes: ImportOutcome[];
  /** The assets the files came to (a duplicate's being the one already there). */
  assets: Asset[];
}

/**
 * Takes files into the library at `folder`. Every file is tried and has an
 * outcome. With `report: "toast"` (the default) what was not simply added
 * is told in one toast; a caller showing the outcomes itself passes "none".
 */
export async function importFiles(
  library: AssetLibrary, files: ReadonlyArray<File>, folder: string,
  options: { report?: "toast" | "none" } = {},
): Promise<ImportReport> {
  let outcomes: ImportOutcome[];
  if (import.meta.env.VITE_PURECUT) {
    outcomes = [];
    for (const file of files) outcomes.push(await library.importFile(file, { folder }));
  } else {
    outcomes = (await importFilesInto(library, files, folder)).outcomes;
  }
  const assets = outcomes.flatMap(outcome => outcome.status === "failed" ? [] : [outcome.asset]);
  if ((options.report ?? "toast") === "toast") toastImport(outcomes);
  return { outcomes, assets };
}

/** One toast for an import with something to say: the refusals, with their reasons. */
function toastImport(outcomes: ImportOutcome[]): void {
  const summary = describeImport(outcomes);
  const failed = summary.rows.filter(row => row.failed);
  if (!failed.length) return;
  toast.error(summary.title, { description: failed.map(row => `${row.name}: ${row.detail}`).join("\n") });
}

/** Opens the file picker and imports what the user picks into `folder`. */
export async function pickAndImport(
  library: AssetLibrary, folder: string, options: { report?: "toast" | "none" } = {},
): Promise<ImportReport> {
  return importFiles(library, await pickFiles(), folder, options);
}

/**
 * Lets the user pick another file of the same kind for `asset` and points it
 * there; the JSX keeps naming it by path, so every clip using it plays the
 * new file. A file of another kind, or one the library already holds as
 * another asset, is refused with why. The replacement is a step of the
 * project's edit history, so Undo puts the old file back and Redo the new
 * one, and the selection follows the asset through each. Returns the
 * relinked asset, or null when the picker was dismissed or the relink failed
 * (reported).
 */
export async function replaceAssetSource(world: World, library: AssetLibrary, asset: Asset): Promise<Asset | null> {
  const previous = { ...asset };
  try {
    const [file] = await pickFiles({ multiple: false });
    if (!file) return null;
    const path = library.fs.pathOf?.(file);
    const relinked = import.meta.env.VITE_PURECUT || !path
      ? await library.relinkFile(asset, file)
      : await library.relink(asset, path, file.name);
    forgetReplacedMedia(previous.id);
    followSelection(world, relinked, previous.id);
    const undo = getEditHistory(world).recordLibraryStep(replacementStep(library, previous, relinked, {
      forget: forgetReplacedMedia,
      changed: (next, from) => followSelection(world, next, from),
      failed: error => toast.error("Could not change the media back", { description: error.message }),
    }));
    toast(`Replaced ${assetName(asset)}`, {
      description: `Every clip using it now plays ${file.name}. Undo puts the old file back.`,
      action: { label: "Undo", onClick: () => {
        if (!undo()) toast("Undo newer edits first", { description: "Use the project's Undo command to return to this replacement." });
      } },
    });
    return relinked;
  } catch (error) {
    toast.error("Could not replace media", { description: (error as Error).message });
    return null;
  }
}

/** The picture and the waveform the timeline shows of an asset's old bytes. */
function forgetReplacedMedia(id: string): void {
  forgetAssetMedia(id);
  forgetAssetPeaks(id);
}

/** Inserts `asset` at the playhead of the active scene; tells the user when there is nowhere to put it. */
export function insertAssetAtPlayhead(world: World, asset: Asset): void {
  if (!insertAsset(world, asset)) {
    toast("Nothing to insert into", { description: "Open a project first." });
  }
}
