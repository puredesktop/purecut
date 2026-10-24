// Shared decode/verify helpers for PureCut release exports.
//
// Everything here runs with only ffmpeg + ffprobe on the PATH and is safe to
// reuse from the Electron smoke test, the browser speech/mask checks, and the
// release matrix. The checks answer the release question directly: does the
// saved file actually look and sound like the preview, and did the render
// finish and stay under control?
import { execFileSync } from "node:child_process";

const FFMPEG = process.env.FFMPEG_BIN || "ffmpeg";
const FFPROBE = process.env.FFPROBE_BIN || "ffprobe";

const run = (bin, args, opts = {}) =>
  execFileSync(bin, args, { encoding: "buffer", maxBuffer: opts.maxBuffer ?? 512 * 1024 * 1024 });

/** ffprobe JSON for a file, normalized to the fields the checks need. */
export function probeMedia(path) {
  const raw = JSON.parse(
    run(FFPROBE, [
      "-v", "error",
      "-show_streams",
      "-show_format",
      "-of", "json",
      path,
    ], { maxBuffer: 64 * 1024 * 1024 }).toString("utf8"),
  );
  const streams = raw.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video");
  const audio = streams.find((s) => s.codec_type === "audio");
  const firstDuration = streams
    .map((s) => Number(s.duration))
    .find((d) => Number.isFinite(d));
  // `format.duration` can be the string "N/A" for an incomplete container, in
  // which case a stream's own duration (when present) is the better answer.
  const formatDuration = Number(raw.format?.duration);
  return {
    duration: Number.isFinite(formatDuration) ? formatDuration : (firstDuration ?? NaN),
    width: video ? Number(video.width) : 0,
    height: video ? Number(video.height) : 0,
    videoCodec: video?.codec_name,
    audioCodec: audio?.codec_name,
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    pixelFormat: video?.pix_fmt,
  };
}

/**
 * Decode a mono window of audio to f32 and return its RMS. `from`/`to` are
 * seconds. The signal measure used by "audible tail" and "silence" checks:
 * 0 for digital silence, ~1 for a full-scale sine.
 */
export function audioRms(path, { from, to, sampleRate = 48000 }) {
  const samples = run(FFMPEG, [
    "-v", "error",
    "-ss", String(from),
    "-t", String(to - from),
    "-i", path,
    "-vn",
    "-ac", "1",
    "-ar", String(sampleRate),
    "-f", "f32le",
    "-",
  ]);
  const floats = new Float32Array(
    samples.buffer,
    samples.byteOffset,
    Math.floor(samples.length / 4),
  );
  if (floats.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < floats.length; i++) sum += floats[i] * floats[i];
  return Math.sqrt(sum / floats.length);
}

/**
 * Average RGB of a crop at a time, decoded to raw rgb24. `rect` is
 * { x, y, w, h }. Returns { r, g, b } in 0-255.
 */
export function pixelAt(path, time, rect = { x: 0, y: 0, w: 2, h: 2 }) {
  const { x = 0, y = 0, w = 2, h = 2 } = rect;
  const bytes = run(FFMPEG, [
    "-v", "error",
    "-ss", String(time),
    "-i", path,
    "-frames:v", "1",
    "-vf", `crop=${w}:${h}:${x}:${y},format=rgb24`,
    "-f", "rawvideo",
    "-",
  ]);
  const pixels = Math.floor(bytes.length / 3);
  if (pixels === 0) return { r: 0, g: 0, b: 0 };
  let r = 0, g = 0, b = 0;
  for (let i = 0; i < pixels; i++) {
    r += bytes[i * 3];
    g += bytes[i * 3 + 1];
    b += bytes[i * 3 + 2];
  }
  return { r: r / pixels, g: g / pixels, b: b / pixels };
}

/** Luma (rec. 709 weights) of a crop at a time — used for caption presence. */
export function brightnessAt(path, time, rect) {
  const { r, g, b } = pixelAt(path, time, rect);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const near = (a, b, tol) => Math.abs(a - b) <= tol;

/**
 * Run the full release decode spec against an exported file.
 *
 * spec:
 *   duration:   { expected, tolerance? }
 *   dimensions: { width, height }
 *   codecs:     { video?, audio? }
 *   audibleTail:{ from, to, minRms }
 *   silence:    [{ from, to, maxRms }]           (optional)
 *   pixels:     [{ at, rect?, expect: {r,g,b}, tolerance? }]  (optional)
 *   caption:    { window: [from,to], rect, presentLuma?, absentLuma? }  (optional)
 *
 * Returns { pass, checks: [{ name, pass, detail }] }.
 */
export function verifyExport(path, spec) {
  const probe = probeMedia(path);
  const checks = [];
  const check = (name, pass, detail) => checks.push({ name, pass, detail });

  if (spec.duration) {
    const { expected, tolerance = 0.15 } = spec.duration;
    const ok = near(probe.duration, expected, tolerance);
    check("duration", ok, `expected ${expected}s ±${tolerance}s, got ${probe.duration.toFixed(3)}s`);
  }
  if (spec.dimensions) {
    const { width, height } = spec.dimensions;
    const ok = probe.width === width && probe.height === height;
    check("dimensions", ok, `expected ${width}x${height}, got ${probe.width}x${probe.height}`);
  }
  if (spec.codecs?.video) {
    const ok = probe.videoCodec === spec.codecs.video;
    check("videoCodec", ok, `expected ${spec.codecs.video}, got ${probe.videoCodec}`);
  }
  if (spec.codecs?.audio) {
    const ok = probe.audioCodec === spec.codecs.audio;
    check("audioCodec", ok, `expected ${spec.codecs.audio}, got ${probe.audioCodec}`);
  }
  if (spec.audibleTail) {
    const { from, to, minRms } = spec.audibleTail;
    const rms = audioRms(path, { from, to });
    check("audibleTail", rms >= minRms, `RMS ${rms.toFixed(4)} in [${from},${to}]s (need ≥ ${minRms})`);
  }
  for (const [i, s] of (spec.silence ?? []).entries()) {
    const rms = audioRms(path, { from: s.from, to: s.to });
    check(`silence[${i}]`, rms <= s.maxRms, `RMS ${rms.toFixed(4)} in [${s.from},${s.to}]s (need ≤ ${s.maxRms})`);
  }
  for (const [i, p] of (spec.pixels ?? []).entries()) {
    const got = pixelAt(path, p.at, p.rect);
    const tol = p.tolerance ?? 30;
    const ok = near(got.r, p.expect.r, tol) && near(got.g, p.expect.g, tol) && near(got.b, p.expect.b, tol);
    check(`pixel[${i}]`, ok, `at ${p.at}s expected rgb(${p.expect.r},${p.expect.g},${p.expect.b}) ±${tol}, got rgb(${got.r.toFixed(0)},${got.g.toFixed(0)},${got.b.toFixed(0)})`);
  }
  if (spec.caption) {
    const [from, to] = spec.caption.window;
    const rect = spec.caption.rect;
    const presentLuma = spec.caption.presentLuma ?? 140;
    const absentLuma = spec.caption.absentLuma ?? 120;
    const mid = (from + to) / 2;
    const during = brightnessAt(path, mid, rect);
    const before = brightnessAt(path, Math.max(0, from - (to - from) / 2), rect);
    const after = brightnessAt(path, to + (to - from) / 2, rect);
    const present = during >= presentLuma;
    const absent = before <= absentLuma && after <= absentLuma;
    check(
      "captionTiming",
      present && absent,
      `caption region luma during ${during.toFixed(0)}, before ${before.toFixed(0)}, after ${after.toFixed(0)} (present ≥ ${presentLuma}, absent ≤ ${absentLuma})`,
    );
  }

  return { pass: checks.every((c) => c.pass), probe, checks };
}

/** Samples process RSS (and any extra gauge) until stopped; keeps the peak. */
export class MemorySampler {
  #timer = null;
  #extra = null;
  peak = 0;
  peakAt = null;
  samples = 0;
  startedAt = 0;

  constructor(intervalMs = 250, extra = null) {
    this.intervalMs = intervalMs;
    this.#extra = extra;
  }
  start() {
    this.startedAt = Date.now();
    const tick = () => {
      this.samples += 1;
      const rss = process.memoryUsage().rss;
      const extra = this.#extra?.() ?? 0;
      const total = rss + extra;
      if (total > this.peak) {
        this.peak = total;
        this.peakAt = Date.now();
      }
    };
    tick();
    this.#timer = setInterval(tick, this.intervalMs);
    return this;
  }
  stop() {
    clearInterval(this.#timer);
    return this.result();
  }
  result() {
    return {
      peakBytes: this.peak,
      peakMb: Math.round((this.peak / 1024 / 1024) * 10) / 10,
      samples: this.samples,
      seconds: Math.round((Date.now() - this.startedAt) / 10) / 100,
    };
  }
}

/** Flags a render as stalled if it goes `timeoutMs` without a heartbeat. */
export class StallWatchdog {
  #timer = null;
  #last = 0;
  stalled = false;
  stalledAt = null;
  onStall = null;

  constructor(timeoutMs = 120000, onStall = null) {
    this.timeoutMs = timeoutMs;
    this.onStall = onStall;
  }
  start() {
    this.#last = Date.now();
    // Tick fast enough to catch short test timeouts, capped so a multi-minute
    // render isn't woken every few ms.
    const tick = Math.max(50, Math.min(1000, this.timeoutMs / 2));
    this.#timer = setInterval(() => {
      if (!this.stalled && Date.now() - this.#last > this.timeoutMs) {
        this.stalled = true;
        this.stalledAt = Date.now();
        this.onStall?.();
      }
    }, tick);
    return this;
  }
  beat() {
    this.#last = Date.now();
    this.stalled = false;
  }
  stop() {
    clearInterval(this.#timer);
    return this.result();
  }
  result() {
    return { stalled: this.stalled, stalledAt: this.stalledAt };
  }
}
