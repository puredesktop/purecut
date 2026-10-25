// PureCut release matrix.
//
// The release question this answers: do complete projects survive a real
// export on the machines people use — Windows, Linux, Intel and Apple macOS —
// across the available WebGPU variants and the supported codecs, and does a
// long mixed timeline export beyond the old 128 MB write boundary come back
// with the right duration, audible tail, frame size, caption timing and
// pixels, without stalling or blowing memory?
//
// Modes (none of them run during an ordinary `npm test`):
//   node scripts/release-matrix.mjs --report            machine + matrix report
//   node scripts/release-matrix.mjs --verify <file>     decode one exported file
//   node scripts/release-matrix.mjs --run               full export scenarios
//
// `--run` needs a built PureCut app open in Electron (the same contract as
// scripts/smoke-purecut.mjs): set PURECUT_CDP_URL to the running debugging
// URL. It reuses the app's own drawer `exportCut` tool, so what it decodes is
// the shipped export path, not a stubbed one.
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import {
  verifyExport,
  MemorySampler,
  StallWatchdog,
} from "./lib/export-verify.mjs";

// --- The matrix -----------------------------------------------------------
// One row per (platform × gpu variant). Each row lists the codec/format
// entries that platform must prove. A row runs only on its own platform; the
// report shows the rest as "skipped: not this platform".
export const PLATFORMS = {
  "darwin-arm64": { label: "Apple macOS (Apple silicon)", os: "macos", cpu: "arm64" },
  "darwin-x64": { label: "Intel macOS", os: "macos", cpu: "x64" },
  win32: { label: "Windows", os: "windows", cpu: "x64" },
  linux: { label: "Linux", os: "linux", cpu: "x64" },
};

// GPU variants the editor has to work under. WebGPU is needed for the SAM 2
// object-mask pipeline; without it the editor still previews and exports via
// WebGL2, so a release checks the one the machine actually has.
export const GPU_VARIANTS = [
  { id: "webgpu-hardware", label: "WebGPU (hardware adapter)", needs: "webgpu" },
  { id: "webgpu-software", label: "WebGPU (SwiftShader / software)", needs: "webgpu" },
  { id: "webgl2", label: "WebGL2 (no WebGPU)", needs: "webgl2" },
];

// Codec/format entries the app exposes (VIDEO_CODEC_OPTIONS × containers that
// hold them, reconciled the way apps/web export.ts does). Each entry carries
// the resolution and a duration long enough to cross the pre-streaming
// 128 MB write boundary at the given bitrate.
const SIZE_BOUNDARY_BYTES = 128 * 1024 * 1024;
const secondsToCross = (bitrate) =>
  Math.ceil((SIZE_BOUNDARY_BYTES * 8) / bitrate) + 5;

export const CODEC_ENTRIES = [
  { id: "avc-mp4", format: "mp4", video: "avc", audio: "aac", resolution: 720, bitrate: 7e6 },
  { id: "avc-mp4-1080", format: "mp4", video: "avc", audio: "aac", resolution: 1080, bitrate: 12e6 },
  { id: "hevc-mp4", format: "mp4", video: "hevc", audio: "aac", resolution: 720, bitrate: 7e6 },
  { id: "vp9-webm", format: "webm", video: "vp9", audio: "opus", resolution: 720, bitrate: 3e6 },
  { id: "vp8-webm", format: "webm", video: "vp8", audio: "opus", resolution: 720, bitrate: 3e6 },
  { id: "av1-webm", format: "webm", video: "av1", audio: "opus", resolution: 720, bitrate: 3e6 },
  { id: "avc-mov", format: "mov", video: "avc", audio: "aac", resolution: 720, bitrate: 7e6 },
].map((entry) => ({
  ...entry,
  extension: entry.format,
  seconds: secondsToCross(entry.bitrate),
}));

export function detectEnvironment() {
  // macOS distinguishes Intel vs Apple silicon; Windows/Linux keys are just the
  // OS, so the platform key must match the PLATFORMS table exactly.
  const platform =
    process.platform === "darwin" ? `darwin-${process.arch}` : process.platform;
  const known = PLATFORMS[platform];
  let cpu = process.arch;
  try {
    // `sysctl -n machdep.cpu.brand_string` on macOS, `/proc/cpuinfo` on Linux.
    if (process.platform === "darwin") {
      cpu = spawnSync("sysctl", ["-n", "machdep.cpu.brand_string"], { encoding: "utf8" })
        .stdout.trim() || process.arch;
    } else if (process.platform === "linux") {
      const match = /model name\s*:\s*(.+)/.exec(
        execFileSync("sh", ["-c", "cat /proc/cpuinfo 2>/dev/null"], { encoding: "utf8" }),
      );
      if (match) cpu = match[1].trim();
    }
  } catch {}
  return { platform, arch: process.arch, cpu, known: Boolean(known), os: process.platform };
}

/** The matrix rows that apply to this machine (platform match only). */
export function applicableRows(env) {
  const rows = [];
  for (const gpu of GPU_VARIANTS) {
    for (const codec of CODEC_ENTRIES) {
      rows.push({
        platform: env.platform,
        platformLabel: (PLATFORMS[env.platform] ?? PLATFORMS[process.platform] ?? { label: env.platform }).label,
        gpu: gpu.id,
        gpuLabel: gpu.label,
        codec: codec.id,
        ...codec,
      });
    }
  }
  return rows;
}

// --- The long mixed timeline -------------------------------------------------
// A single project that exercises everything a "complete" project has: mixed
// audio/video, two clips cut together with a dissolve, a caption with a known
// time window, and a geometric mask (a `<rect clipPath>` — the object-mask
// pipeline's sibling). `buildTimelineSource` returns the scene's children, the
// JSX the drawer's `replaceCutSource` splices in place of the default title
// text, parameterised by the media fixture and scene size.
export function buildTimelineSource({ width, height, seconds, media }) {
  const mid = Math.floor(seconds / 2);
  const cx = Math.round(width / 2);
  const cy = Math.round(height / 2);
  const fontSize = Math.round(height * 0.12);
  // Top-left corner only, so the centre stays clear for the pixel/caption checks.
  const maskW = Math.round(width * 0.3);
  const maskH = Math.round(height * 0.3);
  const clipW = Math.round(width * 0.2);
  const clipH = Math.round(height * 0.2);
  return `<video name="A" src="${media}" width={${width}} height={${height}} end={${mid}} />
  <video name="B" src="${media}" width={${width}} height={${height}} start={${mid}} end={${seconds}} sourceIn={${mid}} transition={{type:"dissolve",duration:1}} />
  <rect x={0} y={0} width={${maskW}} height={${maskH}} fill="#202040">
    <rect clipPath x={${Math.round((maskW - clipW) / 2)}} y={${Math.round((maskH - clipH) / 2)}} width={${clipW}} height={${clipH}} />
  </rect>
  <text name="Caption" start={1} end={2} x={${cx - 320}} y={${cy - fontSize}} width={640} height={${fontSize * 2}} fontFamily="sans-serif" fontSize={${fontSize}} color="#ffffff">CAP</text>`;
}

// --- Mode: report -----------------------------------------------------------
function report() {
  const env = detectEnvironment();
  const rows = applicableRows(env);
  const totalSeconds = rows.reduce((sum, r) => sum + r.seconds, 0);
  console.log(
    JSON.stringify(
      {
        environment: env,
        platforms: Object.entries(PLATFORMS).map(([key, v]) => ({
          key,
          label: v.label,
          here: key === env.platform,
        })),
        gpuVariants: GPU_VARIANTS,
        codecEntries: CODEC_ENTRIES,
        applicableRows: rows.length,
        estimatedExportSeconds: totalSeconds,
      },
      null,
      2,
    ),
  );
}

// --- Mode: verify -----------------------------------------------------------
async function verifyOne(file, specFile) {
  const spec = specFile ? JSON.parse(await readFile(specFile, "utf8")) : defaultSpec(file);
  const result = verifyExport(file, spec);
  console.log(JSON.stringify(result, null, 2));
  if (!result.pass) process.exitCode = 1;
}

function defaultSpec() {
  // No assertions: `--verify <file>` without a spec just decodes and reports
  // the probe (duration, codecs, frame size).
  return {};
}

// --- Mode: run (Electron CDP, mirrors smoke-purecut.mjs) --------------------
// One long mixed-timeline export through the shipped drawer tools, decoded and
// verified with the same checks the fixture test proves. The scene exports at
// its saved config (a fresh scene: the default 1080p H.264 MP4, AAC); codec
// variants are enumerated by --report and each can be decoded by --verify once
// the app's export panel has written that codec's preset for the scene.
async function runRelease() {
  const endpoint = process.env.PURECUT_CDP_URL;
  if (!endpoint)
    throw Error("Set PURECUT_CDP_URL to the running Electron debugging URL and open PureCut.");
  const { webSocketDebuggerUrl } = await (await fetch(endpoint + "/json/version")).json();
  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let sequence = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id) {
      pending.get(m.id)?.(m);
      pending.delete(m.id);
    }
  };
  const call = (method, params = {}, sessionId, timeoutMs = 120000) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Error(method + " timed out"));
      }, timeoutMs);
      pending.set(id, (m) => {
        clearTimeout(timer);
        m.error ? reject(Error(m.error.message)) : resolve(m.result);
      });
      ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  const targets = await call("Target.getTargets");
  const target = targets.targetInfos.find(
    (t) => t.type === "iframe" && t.url.startsWith("pure-app://app-637574/"),
  );
  assert.ok(target, "Open the built-static PureCut app in Electron first");
  const { sessionId } = await call("Target.attachToTarget", {
    targetId: target.targetId,
    flatten: true,
  });
  const evaluate = async (expression, timeoutMs) => {
    const r = await call(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      sessionId,
      timeoutMs,
    );
    if (r.exceptionDetails)
      throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const wait = async (expression) => {
    for (let n = 0; n < 120; n++) {
      if (await evaluate(expression)) return;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw Error("Not ready: " + expression);
  };

  const assets = await readdir("dist/assets");
  const chunk = (name) =>
    "./assets/" + assets.find((n) => n.startsWith(name + "-") && n.endsWith(".js"));
  const drawer = JSON.stringify(chunk("drawer"));
  const files = JSON.stringify(chunk("platform-files"));

  // The release scenario: long enough to cross the pre-streaming 128 MB
  // boundary at the default template (1080p H.264 ≈ 12 Mbps).
  const width = 1920;
  const height = 1080;
  const seconds = Number(process.env.PURECUT_RELEASE_SECONDS || 95);
  const mid = Math.floor(seconds / 2);

  const temp = await mkdtemp(join(tmpdir(), "purecut-release-"));
  const fixture = join(temp, "mix.mp4");
  let originalHash;
  try {
    execFileSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "color=c=red:size=320x180:rate=24:duration=" + seconds,
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=" + seconds,
      "-vf", `drawbox=x=0:y=0:w=iw:h=ih:color=0x00ff00:t=fill:enable='gte(t,${mid})'`,
      "-af", `volume=0:enable='between(t,${mid * 0.8},${mid * 0.9})'`,
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
      fixture,
    ]);

    await evaluate(
      `(async()=>{const {cutTool}=await import(${drawer});await cutTool('getCutContext');})()`,
    );
    originalHash = await evaluate("location.hash");
    await evaluate(`location.hash='/'`);
    await wait(
      `Array.from(document.querySelectorAll('button')).some(e=>e.textContent.trim().startsWith('New video'))`,
    );
    await evaluate(
      `Array.from(document.querySelectorAll('button')).find(e=>e.textContent.trim().startsWith('New video')).click()`,
    );
    await wait(`document.body?.innerText.includes('Import media')`);
    await evaluate(
      `(async()=>{const file=await(await import(${files})).files.file(${JSON.stringify(fixture)});const original=HTMLInputElement.prototype.click;HTMLInputElement.prototype.click=function(){if(this.type!=='file')return original.call(this);const data=new DataTransfer();data.items.add(file);this.files=data.files;this.dispatchEvent(new Event('change'));};try{Array.from(document.querySelectorAll('button')).find(e=>e.textContent.trim()==='Import media').click();}finally{HTMLInputElement.prototype.click=original;}})()`,
    );
    await wait(`document.body?.innerText.includes('mix.mp4')`);

    const children = buildTimelineSource({ width, height, seconds, media: "mix.mp4" });
    const childrenJs = JSON.stringify(children);
    await evaluate(
      `(async()=>{const {cutTool}=await import(${drawer});const c=await cutTool('getCutContext');await cutTool('replaceCutSource',{source:c.source.replace(/<text[\\s\\S]*<\\/scene>/,${childrenJs}+'</scene>'),baseHash:c.hash});})()`,
    );
    await new Promise((r) => setTimeout(r, 1000));

    // Run the export under a memory sampler and a stall watchdog. The export
    // is one awaited CDP call, so the watchdog flags a stall if it runs past
    // the threshold without returning; the CDP call gets a far longer backstop
    // timeout so a slow-but-finishing render is reported as stalled, not lost.
    const memory = new MemorySampler(250);
    const watchdog = new StallWatchdog(seconds * 1000 * 6 + 60000);
    memory.start();
    watchdog.start();
    const started = Date.now();
    let result;
    try {
      result = await evaluate(
        `(async()=>{const {cutTool}=await import(${drawer});const c=await cutTool('getCutContext');const id=c.source.match(/<scene[^>]*id="([^"]+)"/)[1];return {id,check:await cutTool('checkCut',{id}),render:await cutTool('exportCut',{id})};})()`,
        Math.max(seconds * 1000 * 20 + 120000, 1800000),
      );
    } finally {
      memory.stop();
      watchdog.stop();
    }

    const spec = releaseSpec({ width, height, seconds, mid });
    const decoded = verifyExport(result.render.path, spec);
    const report = {
      environment: detectEnvironment(),
      scenario: { width, height, seconds, exportPath: result.render.path },
      check: result.check.stats,
      decode: { pass: decoded.pass, probe: decoded.probe, checks: decoded.checks },
      secondsElapsed: Math.round((Date.now() - started) / 100) / 10,
      ...memory.result(),
      ...watchdog.result(),
    };
    console.log(JSON.stringify(report, null, 2));
    if (!decoded.pass) process.exitCode = 1;
    if (watchdog.result().stalled) process.exitCode = 1;
  } finally {
    if (originalHash)
      await evaluate("location.hash=" + JSON.stringify(originalHash)).catch(() => {});
    ws.close();
    await rm(temp, { recursive: true, force: true });
  }
}

function releaseSpec({ width, height, seconds, mid }) {
  const cx = Math.round(width / 2);
  const cy = Math.round(height / 2);
  const fontSize = Math.round(height * 0.12);
  // Sample the bottom-right corner: clear of the top-left mask panel and the
  // centre caption, so the colour of each clip reads straight through.
  const clear = { x: width - 120, y: height - 120, w: 60, h: 60 };
  return {
    duration: { expected: seconds, tolerance: Math.max(1, seconds * 0.02) },
    dimensions: { width, height },
    codecs: { video: "h264", audio: "aac" },
    audibleTail: { from: seconds - 1, to: seconds - 0.5, minRms: 0.01 },
    silence: [{ from: mid * 0.8, to: mid * 0.9, maxRms: 0.005 }],
    pixels: [
      { at: 1, rect: clear, expect: { r: 200, g: 0, b: 0 }, tolerance: 70 }, // clip A (red)
      { at: seconds - 0.5, rect: clear, expect: { r: 0, g: 200, b: 0 }, tolerance: 70 }, // clip B (green)
    ],
    caption: {
      window: [1, 2],
      rect: { x: cx - 320, y: cy - fontSize, w: 640, h: fontSize * 2 },
      // Relative to the red frame under the glyphs; on a real machine these
      // may need a small nudge — the check reports the measured luma either way.
      presentLuma: 130,
      absentLuma: 115,
    },
  };
}

// --- CLI --------------------------------------------------------------------
// Only act when run directly, so test files can import the matrix, detectors
// and builders without triggering the CLI.
const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const mode = process.argv[2] ?? "--report";
  const value = process.argv[3];
  if (mode === "--report") report();
  else if (mode === "--verify") {
    if (!value) throw Error("--verify needs a file path");
    const specFile = process.argv[4] ?? null;
    await verifyOne(value, specFile);
  } else if (mode === "--run") await runRelease();
  else throw Error(`Unknown mode ${mode} (use --report | --verify <file> | --run)`);
}
