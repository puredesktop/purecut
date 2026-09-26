import { ALL_FORMATS, BlobSource, Conversion, Input, Output, StreamTarget, WebMOutputFormat } from 'mediabunny';

/** Video-only, seek-friendly preview. Audio and exports retain the source file. */
export async function derivePlaybackProxy(file: Blob, signal: AbortSignal, progress?: (value: number) => void): Promise<Blob> {
  signal.throwIfAborted();
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  let conversion: Conversion | undefined;
  const abort = () => { void conversion?.cancel().catch(() => undefined); };
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw Error('No video track for playback proxy');
    const width = await track.getDisplayWidth();
    const height = await track.getDisplayHeight();
    const scale = Math.min(1, 1280 / width, 720 / height);
    // Blob slices retain already-written data without a growing JS byte array.
    let blob = new Blob([]);
    const target = new StreamTarget(new WritableStream({
      write(chunk) {
        signal.throwIfAborted();
        if (chunk.position > blob.size) throw Error('Unexpected gap in proxy output');
        blob = new Blob([blob.slice(0, chunk.position), new Blob([chunk.data]), blob.slice(chunk.position + chunk.data.length)]);
      },
    }), { chunked: true, chunkSize: 1024 * 1024 });
    const output = new Output({ format: new WebMOutputFormat(), target });
    conversion = await Conversion.init({
      input, output,
      video: {
        codec: 'vp8', width: Math.max(2, Math.round(width * scale / 2) * 2),
        height: Math.max(2, Math.round(height * scale / 2) * 2), fit: 'contain',
        bitrate: 2_000_000, keyFrameInterval: 0.5, forceTranscode: true,
        allowRotationMetadata: false,
      },
      audio: { discard: true },
    });
    if (!conversion.isValid || !conversion.utilizedTracks.length) throw Error('Playback proxy encoding is unavailable');
    conversion.onProgress = value => progress?.(value);
    signal.addEventListener('abort', abort, { once: true });
    signal.throwIfAborted();
    await conversion.execute();
    signal.throwIfAborted();
    return new Blob([blob], { type: 'video/webm' });
  } finally {
    signal.removeEventListener('abort', abort);
    await conversion?.cancel().catch(() => undefined);
    input.dispose();
  }
}
