/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// File actions on the library, with the user told how they went: the
// mechanics live in @diffusionstudio/assets.

import { toast } from "somoto";
import { resolveTranscript, serializeSubtitles, type SubtitleFormat } from "@diffusionstudio/runtime";
import { importFiles as importFilesInto, pickFiles, saveAssetAs as saveAs } from "@diffusionstudio/assets";
import { insertAsset } from "./insert-asset";
import { forgetAssetMedia } from "./timeline/media";
import { forgetAssetPeaks } from "./timeline/peaks";

import type { World } from "koota";

import type { Asset, AssetLibrary } from "@diffusionstudio/assets";

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

/** Links files into the library at `folder` and reports whatever was skipped or refused. */
export async function importFiles(library: AssetLibrary, files: ReadonlyArray<File>, folder: string): Promise<Asset[]> {
  if (import.meta.env.VITE_PURECUT) {
    const assets: Asset[] = [];
    for (const file of files) {
      try { assets.push(await library.store(file, {folder, name:file.name})); }
      catch(error) { toast.error(`Could not import ${file.name}`, {description:(error as Error).message}); }
    }
    return assets;
  }
  const report = await importFilesInto(library, files, folder);

  if (report.unnamed.length) {
    toast("Some files could not be imported", { description: "Only files on this computer can be added to the library." });
  }
  for (const { source, error } of report.failed) {
    toast.error(`Could not import ${source.split(/[\\/]/).pop()}`, { description: error.message });
  }
  return report.assets;
}

/** Opens the file picker and imports what the user picks into `folder`. */
export async function pickAndImport(library: AssetLibrary, folder: string): Promise<Asset[]> {
  return importFiles(library, await pickFiles(), folder);
}

/**
 * Lets the user pick another file for `asset` and points it there; the JSX
 * keeps naming it by path. Returns the relinked asset, or null when the
 * picker was dismissed or the relink
 * failed (reported).
 */
export async function replaceAssetSource(library: AssetLibrary, asset: Asset): Promise<Asset | null> {
  try {
    const [file] = await pickFiles({ multiple: false });
    if (!file) return null;
    const path = library.fs.pathOf?.(file);
    const relinked = import.meta.env.VITE_PURECUT || !path
      ? await library.relinkFile(asset, file)
      : await library.relink(asset, path);
    // The picture and the waveform the timeline is showing are of the file
    // it used to be.
    forgetAssetMedia(asset.id);
    forgetAssetPeaks(asset.id);
    return relinked;
  } catch (error) {
    toast.error("Failed to replace", { description: (error as Error).message });
    return null;
  }
}

/** Inserts `asset` at the playhead of the active scene; tells the user when there is nowhere to put it. */
export function insertAssetAtPlayhead(world: World, asset: Asset): void {
  if (!insertAsset(world, asset)) {
    toast("Nothing to insert into", { description: "Open a project first." });
  }
}
