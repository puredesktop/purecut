/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getAssetFile } from '@diffusionstudio/runtime'
import { DEFAULT_SILENCE_OPTIONS } from './silence-detect'
import type { AudioAsset, VideoAsset } from '@diffusionstudio/assets'
import type { Range } from './model'
import type { SilenceOptions } from './silence-detect'
import type { SilenceRequest, SilenceResponse } from './silence-worker'

/**
 * Pause cleanup's silences: measured against the recording's own noise floor,
 * so a quiet room and a noisy one are cut alike, at 10 ms steps however long
 * the file is. No padding: pauseCuts keeps the retained pause and a margin
 * around every transcribed word itself, so the silence is reported as heard.
 */
export const PAUSE_SILENCE_OPTIONS: SilenceOptions = { ...DEFAULT_SILENCE_OPTIONS, padding: 0 }

/**
 * The silent stretches of an asset's audio, in seconds of the source. Empty
 * when there is no clear silence to tell apart (music, constant noise) or no
 * audio track. Decoded off the main thread, one block at a time.
 */
export async function findAssetSilences(
  asset: AudioAsset | VideoAsset,
  options: SilenceOptions = PAUSE_SILENCE_OPTIONS,
): Promise<Range[]> {
  const file = await getAssetFile(asset)
  const worker = new Worker(new URL('./silence-worker.ts', import.meta.url), { type: 'module' })
  try {
    const silences = await new Promise<SilenceResponse>((resolve, reject) => {
      worker.onmessage = ({ data }: MessageEvent<SilenceResponse>) => resolve(data)
      worker.onerror = event => reject(Error(event.message || 'Listening for pauses failed.'))
      worker.postMessage({ file, start: 0, end: asset.duration, options } satisfies SilenceRequest)
    })
    if ('error' in silences) throw Error(silences.error)
    return (silences.silences ?? []).map(([start, end]) => ({ start, end }))
  } finally {
    worker.terminate()
  }
}
