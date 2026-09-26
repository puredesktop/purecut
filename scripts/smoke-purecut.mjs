// Runs against an already-open built PureCut app in Electron, never a private server.
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
const endpoint = process.env.PURECUT_CDP_URL;
if (!endpoint)
  throw Error(
    "Set PURECUT_CDP_URL to the running Electron debugging URL and open PureCut.",
  );
const { webSocketDebuggerUrl } = await (
  await fetch(endpoint + "/json/version")
).json();
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
const call = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(Error(method + " timed out"));
    }, 120000);
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
const evaluate = async (expression) => {
  const r = await call(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true },
    sessionId,
  );
  if (r.exceptionDetails)
    throw Error(
      r.exceptionDetails.exception?.description || r.exceptionDetails.text,
    );
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
  "./assets/" +
  assets.find((n) => n.startsWith(name + "-") && n.endsWith(".js"));
const drawer = JSON.stringify(chunk("drawer")),
  files = JSON.stringify(chunk("platform-files"));
const temp = await mkdtemp(join(tmpdir(), "purecut-electron-"));
const fixture = join(temp, "tone.mp4");
let originalHash;
try {
  execFileSync("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=320x180:rate=30",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000",
    "-t",
    "2",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    fixture,
  ]);
  // Flush the user's document through the same tool boundary before switching away.
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
  // Supply a real local File to the regular picker change handler (no OS dialog automation).
  await evaluate(
    `(async()=>{const file=await(await import(${files})).files.file(${JSON.stringify(fixture)});const original=HTMLInputElement.prototype.click;HTMLInputElement.prototype.click=function(){if(this.type!=='file')return original.call(this);const data=new DataTransfer();data.items.add(file);this.files=data.files;this.dispatchEvent(new Event('change'));};try{Array.from(document.querySelectorAll('button')).find(e=>e.textContent.trim()==='Import media').click();}finally{HTMLInputElement.prototype.click=original;}})()`,
  );
  await wait(`document.body?.innerText.includes('tone.mp4')`);
  await evaluate(
    `(async()=>{const {cutTool}=await import(${drawer});const c=await cutTool('getCutContext');await cutTool('replaceCutSource',{source:c.source.replace(/<text[\\s\\S]*<\\/scene>/,'<video src="tone.mp4" width={1280} height={720} end={2} /></scene>'),baseHash:c.hash});})()`,
  );
  await new Promise((r) => setTimeout(r, 1000));
  const result = await evaluate(
    `(async()=>{const {cutTool}=await import(${drawer});const c=await cutTool('getCutContext');const id=c.source.match(/<scene[^>]*id="([^"]+)"/)[1];return {dir:c.projectDir,check:await cutTool('checkCut',{id}),render:await cutTool('exportCut',{id}),sharedMemory:typeof SharedArrayBuffer!=='undefined'};})()`,
  );
  assert.equal(result.check.stats.byKind.video, 1);
  assert.equal(result.render.duration, 2);
  const probe = JSON.parse(
    execFileSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "stream=codec_type,duration",
        "-of",
        "json",
        result.render.path,
      ],
      { encoding: "utf8" },
    ),
  );
  assert.ok(
    probe.streams.some(
      (s) =>
        s.codec_type === "video" && Math.abs(Number(s.duration) - 2) < 0.05,
    ),
  );
  assert.ok(
    probe.streams.some(
      (s) => s.codec_type === "audio" && Number(s.duration) >= 1.95,
    ),
  );
  const samples = execFileSync("ffmpeg", [
    "-v",
    "error",
    "-ss",
    "1.7",
    "-i",
    result.render.path,
    "-vn",
    "-f",
    "f32le",
    "-",
  ]);
  const floats = new Float32Array(
    samples.buffer,
    samples.byteOffset,
    Math.floor(samples.length / 4),
  );
  assert.ok(
    [...floats].some((v) => Math.abs(v) > 0.01),
    "Audio tail must contain signal",
  );
  await evaluate("location.reload()");
  await wait(`document.body?.innerText.includes('tone.mp4')`);
  assert.ok(
    await evaluate(
      `(async()=>{const {cutTool}=await import(${drawer});return (await cutTool('getCutContext')).source.includes('tone.mp4')})()`,
    ),
  );
  console.log(JSON.stringify({ pass: true, ...result }, null, 2));
  // Retain the QA project as evidence; return to the user's previous document.
} finally {
  if (originalHash)
    await evaluate("location.hash=" + JSON.stringify(originalHash)).catch(
      () => {},
    );
  ws.close();
  await rm(temp, { recursive: true, force: true });
}
