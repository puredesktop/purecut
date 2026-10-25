// Node-side release-matrix checks: prove the decode/verify helpers and the
// matrix enumeration are correct against a real, ffmpeg-generated export
// fixture. No browser is needed — these run anywhere ffmpeg is on PATH, which
// is the part of the release gate that every CI host can run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  probeMedia,
  audioRms,
  pixelAt,
  brightnessAt,
  verifyExport,
  MemorySampler,
  StallWatchdog,
} from "./lib/export-verify.mjs";
import {
  PLATFORMS,
  GPU_VARIANTS,
  CODEC_ENTRIES,
  detectEnvironment,
  applicableRows,
  buildTimelineSource,
} from "./release-matrix.mjs";

const hasFFmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

// 6s, 320x180: red 0-3s, green 3-6s; a white "caption" box during 1-2s; a
// 2.6-3.8s audio hole; otherwise a 440 Hz tone (audible right to the tail).
function makeFixture(dir) {
  const path = join(dir, "fixture.mp4");
  execFileSync("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=c=red:size=320x180:rate=30:duration=6",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=6",
    "-vf",
    "drawbox=x=0:y=0:w=iw:h=ih:color=0x00ff00:t=fill:enable='gte(t,3)'," +
      "drawbox=x=20:y=80:w=280:h=40:color=white:t=fill:enable='between(t,1,2)'",
    "-af", "volume=0:enable='between(t,2.6,3.8)'",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
    path,
  ]);
  return path;
}

test("probeMedia reads duration, codecs and frame size", { skip: !hasFFmpeg && "ffmpeg missing" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "cut-release-"));
  try {
    const path = makeFixture(dir);
    const probe = probeMedia(path);
    assert.ok(Math.abs(probe.duration - 6) < 0.2, `duration ${probe.duration}`);
    assert.equal(probe.width, 320);
    assert.equal(probe.height, 180);
    assert.equal(probe.videoCodec, "h264");
    assert.equal(probe.audioCodec, "aac");
    assert.equal(probe.hasVideo, true);
    assert.equal(probe.hasAudio, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("verifyExport passes the full release spec", { skip: !hasFFmpeg && "ffmpeg missing" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "cut-release-"));
  try {
    const path = makeFixture(dir);
    const result = verifyExport(path, {
      duration: { expected: 6, tolerance: 0.2 },
      dimensions: { width: 320, height: 180 },
      codecs: { video: "h264", audio: "aac" },
      audibleTail: { from: 5.2, to: 5.4, minRms: 0.01 },
      silence: [{ from: 2.7, to: 3.7, maxRms: 0.005 }],
      pixels: [
        { at: 0.5, expect: { r: 200, g: 0, b: 0 }, tolerance: 60 }, // red half
        { at: 3.5, expect: { r: 0, g: 200, b: 0 }, tolerance: 60 }, // green half
      ],
      caption: { window: [1, 2], rect: { x: 20, y: 80, w: 280, h: 40 } },
    });
    assert.equal(result.pass, true, JSON.stringify(result.checks));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("verifyExport flags a wrong duration and a lost tail", { skip: !hasFFmpeg && "ffmpeg missing" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "cut-release-"));
  try {
    const path = makeFixture(dir);
    const wrongDuration = verifyExport(path, { duration: { expected: 3, tolerance: 0.2 } });
    assert.equal(wrongDuration.pass, false);
    assert.equal(wrongDuration.checks.find((c) => c.name === "duration").pass, false);

    const silentTail = verifyExport(path, {
      audibleTail: { from: 2.7, to: 3.7, minRms: 0.01 }, // that window is muted
    });
    assert.equal(silentTail.pass, false);
    assert.equal(silentTail.checks.find((c) => c.name === "audibleTail").pass, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("audioRms and pixelAt agree with the fixture", { skip: !hasFFmpeg && "ffmpeg missing" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "cut-release-"));
  try {
    const path = makeFixture(dir);
    assert.ok(audioRms(path, { from: 0.5, to: 1.0 }) > 0.05, "tone is loud");
    assert.ok(audioRms(path, { from: 3.0, to: 3.5 }) < 0.005, "muted window is silent");
    const red = pixelAt(path, 0.5);
    const green = pixelAt(path, 4);
    assert.ok(red.r > 150 && red.g < 80, `red half: ${JSON.stringify(red)}`);
    assert.ok(green.g > 150 && green.r < 80, `green half: ${JSON.stringify(green)}`);
    const caption = brightnessAt(path, 1.5, { x: 20, y: 80, w: 280, h: 40 });
    const noCaption = brightnessAt(path, 2.5, { x: 20, y: 80, w: 280, h: 40 });
    assert.ok(caption > noCaption, `caption brighter when present (${caption} vs ${noCaption})`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("matrix enumerates the four platforms and supported codecs", () => {
  assert.deepEqual(Object.keys(PLATFORMS), ["darwin-arm64", "darwin-x64", "win32", "linux"]);
  assert.deepEqual(GPU_VARIANTS.map((g) => g.id), ["webgpu-hardware", "webgpu-software", "webgl2"]);
  const videos = CODEC_ENTRIES.map((c) => c.video);
  for (const codec of ["avc", "hevc", "vp9", "vp8", "av1"]) {
    assert.ok(videos.includes(codec), `matrix includes ${codec}`);
  }
  // Every "beyond the size boundary" entry really is long enough to cross
  // 128 MB at its bitrate.
  for (const c of CODEC_ENTRIES) {
    const bytes = (c.bitrate / 8) * c.seconds;
    assert.ok(
      bytes > 128 * 1024 * 1024,
      `${c.id}: ${(bytes / 1024 / 1024).toFixed(0)} MB must exceed 128 MB`,
    );
  }
});

test("detectEnvironment and applicableRows are consistent", () => {
  const env = detectEnvironment();
  assert.ok(env.platform, "platform detected");
  assert.ok(["darwin", "win32", "linux"].includes(env.os), "known os");
  const rows = applicableRows(env);
  assert.ok(rows.length > 0, "rows for the current platform");
  assert.ok(rows.every((r) => r.platform === env.platform));
});

test("buildTimelineSource includes captions, a transition and a mask", () => {
  const source = buildTimelineSource({ width: 1920, height: 1080, seconds: 90, media: "mix.mp4" });
  assert.ok(source.includes("<text"), "caption");
  assert.ok(source.includes("clipPath"), "mask");
  assert.ok(source.includes("transition=") && source.includes("dissolve"), "transition");
  assert.ok(source.includes('src="mix.mp4"'), "media");
});

test("MemorySampler and StallWatchdog track their state", async () => {
  const memory = new MemorySampler(50).start();
  await new Promise((r) => setTimeout(r, 120));
  const mem = memory.stop();
  assert.ok(mem.peakBytes > 0);
  assert.ok(mem.samples >= 2);

  const stalled = [];
  const watchdog = new StallWatchdog(80, () => stalled.push(true)).start();
  watchdog.beat();
  await new Promise((r) => setTimeout(r, 200));
  const wd = watchdog.stop();
  assert.equal(wd.stalled, true, "no heartbeat for > timeout flags a stall");
  assert.equal(stalled.length, 1);
});
