import { chromium } from "playwright";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { mkdir } from 'node:fs/promises';
const port = 5562;
const server = spawn(
  process.execPath,
  ["scripts/purecut-dev.mjs", "--port", String(port)],
  { stdio: "pipe" },
);
let log = "";
server.stdout.on("data", (d) => (log += d));
server.stderr.on("data", (d) => (log += d));
let browser;
try {
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/`)).ok) break;
    } catch {}
    if (i > 120) throw Error(log);
    await new Promise((r) => setTimeout(r, 250));
  }
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.exposeFunction('inspectExportConfirmation', async () => {
    await mkdir('/tmp/purecut-visual', { recursive: true });
    for (const mode of ['light', 'dark']) for (const width of [1440, 640, 375]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(async mode => {
        const { fixtureThemeCss } = await import('/scripts/editor-visual-fixture.tsx');
        document.documentElement.dataset.platformTheme = mode;
        let style = document.getElementById('review-theme-fixture');
        if (!style) { style = document.createElement('style'); style.id = 'review-theme-fixture'; document.head.append(style); }
        style.textContent = fixtureThemeCss(mode);
      }, mode);
      await page.waitForTimeout(300);
      const dialog = page.getByRole('alertdialog', { name: 'Move exported file to Trash?' });
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).focus();
      for (let i = 0; i < 3; i++) {
        await page.keyboard.press('Tab');
        if (!await dialog.evaluate(element => element.contains(document.activeElement))) throw Error('Trash confirmation leaked keyboard focus');
      }
      const box = await dialog.boundingBox();
      if (!box || box.x < 15 || box.x + box.width > width - 15 || box.y < 0 || box.y + box.height > 900) throw Error(`Trash confirmation lacks viewport margins: ${JSON.stringify(box)} ${await dialog.evaluate(e => {
        const rules = [];
        const visit = list => { for (const rule of list) { if (rule.selectorText && e.matches(rule.selectorText) && /width|background/.test(rule.cssText)) rules.push(rule.cssText); if (rule.cssRules) visit(rule.cssRules); } };
        for (const sheet of document.styleSheets) { try { visit(sheet.cssRules); } catch {} }
        return rules.join('\n');
      })}`);
      await page.screenshot({ path: `/tmp/purecut-visual/trash-${mode}-${width}.png` });
    }
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.evaluate(() => {
      document.getElementById('review-theme-fixture')?.remove();
      document.documentElement.dataset.platformTheme = 'light';
    });
  });
  const result = await page.evaluate(
    async (bridgeUrl) => {
      const { ProjectService } = await import("/purecut/lib/projects.ts");
      await (await import('/scripts/browser-compile-cache-check.ts')).checkCompileCache();
      await (await import('/scripts/browser-scoped-edits-check.ts')).checkScopedEdits();
      await (await import('/scripts/browser-writer-disposal-check.ts')).checkWriterDisposal();
      await (await import('/scripts/browser-source-change-check.ts')).checkSourceChanges();
      await (await import('/scripts/browser-source-review-check.tsx')).checkSourceReview();
      await (await import('/scripts/browser-project-status-check.tsx')).checkProjectStatus();
      await (await import('/scripts/browser-project-resolution-check.tsx')).checkProjectResolution();
      await (await import('/scripts/browser-layout-check.tsx')).checkResponsiveLayout();
      await (await import('/scripts/browser-meter-check.ts')).checkMeters();
      await (await import('/scripts/browser-fader-check.tsx')).checkFaders();
      (await import('/scripts/browser-timeline-view-check.ts')).checkTimelineView();
      await (await import('/scripts/browser-lock-check.ts')).checkLocks();
      await (await import('/scripts/browser-relink-check.ts')).checkRelinkFiles();
      await (await import('/scripts/browser-media-safety-check.tsx')).checkMediaSafety();
      await (await import('/scripts/browser-library-load-check.ts')).checkLibraryLoad();
      await (await import('/scripts/browser-cache-check.ts')).checkCacheWrites();
      await (await import('/scripts/browser-subtitle-check.ts')).checkSubtitles();
      await (await import('/scripts/browser-caption-editing-check.tsx')).checkCaptionEditing();
      await (await import('/scripts/browser-subtitle-timeline-check.tsx')).checkTimelineSubtitles();
      await (await import('/scripts/browser-caption-render-check.ts')).checkCaptionRendering();
      await (await import('/scripts/browser-caption-render-check.ts')).checkCaptionRendering(true);
      await (await import('/scripts/browser-video-speed-check.ts')).checkVideoSpeedExport();
      await (await import('/scripts/browser-editing-check.ts')).checkEverydayEditing();
      const reviewVideo = await (await import('/scripts/browser-timeline-check.ts')).checkTimeline();
      await (await import('/scripts/browser-audio-export-check.ts')).checkAudioExport();
      await (await import('/scripts/browser-audio-export-check.ts')).checkAudioExport(true);
      await (await import('/scripts/browser-audio-export-check.ts')).checkAudioExport(false, true);
      await (await import('/scripts/browser-audio-export-check.ts')).checkAudioExport(false, false, 2);
      await (await import('/scripts/browser-audio-export-check.ts')).checkAudioExport(false, false, 0.5);
      (await import('/scripts/browser-audio-preview-check.ts')).checkAudioPreviewOrder();
      const sharedMemoryDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'SharedArrayBuffer');
      if (!sharedMemoryDescriptor || typeof SharedArrayBuffer === 'undefined')
        throw Error('Audio regression server must enable shared memory to verify both export paths');
      if (sharedMemoryDescriptor && typeof SharedArrayBuffer !== 'undefined') {
        try {
          Object.defineProperty(globalThis, 'SharedArrayBuffer', { configurable: true, value: undefined });
          await (await import('/scripts/browser-audio-export-check.ts')).checkAudioExport();
          await (await import('/scripts/browser-audio-export-check.ts')).checkAudioExport(false, true);
          await (await import('/scripts/browser-audio-export-check.ts')).checkAudioExport(false, false, 2);
          await (await import('/scripts/browser-audio-export-check.ts')).checkAudioExport(false, false, 0.5);
        } finally { Object.defineProperty(globalThis, 'SharedArrayBuffer', sharedMemoryDescriptor); }
      }
      const { createEngine } = await import('/apps/web/src/engine/create-engine.ts');
      const previewEngine = createEngine('preview-recovery-test');
      try {
        const runSystems = previewEngine.runSystems;
        previewEngine.runSystems = () => { throw Error('Fixture render failure'); };
        previewEngine.start();
        await new Promise(requestAnimationFrame);
        if (previewEngine.running() || previewEngine.failure() !== 'Fixture render failure')
          throw Error('Preview failures must stop the loop and expose an error');
        previewEngine.runSystems = runSystems;
        previewEngine.start();
        await new Promise(requestAnimationFrame);
        if (!previewEngine.running() || previewEngine.failure() || previewEngine.frame() < 1)
          throw Error('Preview retry must resume frame updates');
      } finally { previewEngine.dispose(); }
      const { join } = await import("/purecut/lib/platform-files.ts");
      const store = new Map(),
        blobs = new Map();
      const fs = {
        root: async () => "/projects",
        read: async (p) => {
          if (!store.has(p)) throw Error("Missing file");
          return store.get(p);
        },
        write: async (p, s) => store.set(p, s),
        list: async () => [],
        remove: async (p) => store.delete(p),
        binary: async (p, b) =>
          blobs.set(p, [...new Uint8Array(await b.arrayBuffer())]),
        file: async () => new File([], "test"),
      };
      const check = (v, m) => {
          if (!v) throw Error(m);
        },
        reject = async (fn, re) => {
          try {
            await fn();
          } catch (e) {
            check(re.test(e.message), e.message);
            return;
          }
          throw Error("Expected rejection");
        };
      const { files } = await import("/purecut/lib/platform-files.ts");
      const { ownsKeyboardEvent } = await import('/apps/web/src/engine/input/keyboard-target.ts');
      const keyboardTarget = (html, key, options = {}) => {
        const host = document.createElement('div');
        host.innerHTML = html;
        document.body.append(host);
        let owned;
        host.addEventListener('keydown', event => { owned = ownsKeyboardEvent(event); });
        host.firstElementChild.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...options }));
        host.remove();
        return owned;
      };
      check(keyboardTarget('<select><option>One</option></select>', 'ArrowDown'), 'select owns navigation');
      check(keyboardTarget('<div role="dialog"><button>Close</button></div>', 'Delete'), 'dialog protects selection');
      check(keyboardTarget('<div contenteditable="true">Title</div>', 'Backspace'), 'text editing owns deletion');
      check(keyboardTarget('<button>Play</button>', ' '), 'button owns space activation');
      check(keyboardTarget('<canvas></canvas>', 'Tab'), 'tab navigation remains native');
      check(keyboardTarget('<canvas></canvas>', 'a', { isComposing: true }), 'composition cannot edit timeline');
      check(!keyboardTarget('<canvas></canvas>', 'Delete'), 'canvas retains delete shortcut');
      const handledShortcut = new KeyboardEvent('keydown', { key: 'e', ctrlKey: true, cancelable: true });
      handledShortcut.preventDefault();
      check(ownsKeyboardEvent(handledShortcut), 'handled export shortcut cannot trigger twice');
      const { bridge } = await import(bridgeUrl);
      await (await import('/scripts/browser-export-review-check.tsx')).checkExportReview(reviewVideo, bridge, () => window.inspectExportConfirmation());
      const originalCall = bridge.call;
      const originalFetch = window.fetch;
      const mediaUrl = URL.createObjectURL(new Blob([new Uint8Array([0, 1, 2, 255])], { type: 'video/mp4' }));
      try {
        bridge.call = async (method, args) => {
          check(method === "fs.previewUrl", "media uses native file protocol, not base64 IPC");
          check(args[0].path === '/projects/assets/clip.mp4', 'media preview path');
          return {
            url: mediaUrl,
            mimeType: "video/mp4",
            modifiedAt: '2026-01-02T03:04:05.678Z',
          };
        };
        const media = await files.file("/projects/assets/clip.mp4");
        check(
          media.name === "clip.mp4" && media.type === "video/mp4",
          "media metadata",
        );
        check(media.lastModified === Date.parse('2026-01-02T03:04:05.678Z'), 'native disk modification time survives materialization');
        check(
          [...new Uint8Array(await media.arrayBuffer())].join(",") ===
            "0,1,2,255",
          "binary media round trip",
        );
        window.fetch = async () => new Response('Missing', { status: 404 });
        await reject(() => files.file('/projects/assets/clip.mp4'), /Could not read media \(404\)/);
      } finally {
        bridge.call = originalCall;
        window.fetch = originalFetch;
        URL.revokeObjectURL(mediaUrl);
      }
      let changes = 0;
      const transferCalls = [];
      try {
        let offset = 0;
        bridge.call = async (method, args) => {
          check(method === 'fs.binaryTransfer', 'chunked file writes use transfer bridge');
          const request = args[0];
          transferCalls.push(request.action);
          if (request.action === 'begin') { offset = 0; return { ok: true, id: 'transfer' }; }
          if (request.action === 'append') {
            const bytes = atob(request.base64);
            check(bytes.length <= 4 * 1024 * 1024, 'bounded write message');
            check(request.offset === offset, 'sequential chunk offsets');
            offset += bytes.length;
            return { ok: true, offset };
          }
          return { ok: true };
        };
        await files.binary('/large.bin', new Blob([new Uint8Array(5 * 1024 * 1024)]));
        check(offset === 5 * 1024 * 1024, 'all blob bytes transferred');
        check(transferCalls.join(',') === 'begin,append,append,commit', 'commit follows all chunks');
        transferCalls.length = 0;
        bridge.call = async (_method, args) => {
          const request = args[0];
          transferCalls.push(request.action);
          if (request.action === 'begin') return { ok: true, id: 'failed' };
          if (request.action === 'append') throw Error('injected transfer failure');
          return { ok: true };
        };
        await reject(() => files.binary('/failed.bin', new Blob(['bytes'])), /injected transfer failure/);
        check(transferCalls.join(',') === 'begin,append,abort', 'failed write aborts instead of committing');
        transferCalls.length = 0;
        await files.binary('/empty.bin', new Blob([]));
        check(transferCalls.join(',') === 'begin,commit', 'write queue recovers after failure and supports empty files');
      } finally {
        bridge.call = originalCall;
      }
      const history = await import('/apps/web/src/lib/export-history.ts');
      let historyValue = [], historyVersion = 0, conflict = true;
      const entry = { id: 'first', projectId: 'one', path: '/projects/one/renders/a.mp4',
        createdAt: '2026-01-01T00:00:00Z', sourceHash: 'abc', config: { format: 'mp4' } };
      check(history.exportDetails({ ...entry, config: { format: 'webm', video: { resolution: 720, fps: 24, codec: 'vp9' } } }) === 'WEBM · 720p · 24 fps · VP9', 'video export settings summary');
      check(history.exportDetails({ ...entry, config: { format: 'ogg' } }) === 'OGG · Audio only', 'audio-only export settings summary');
      check(history.exportDetails({ ...entry, config: null }) === 'Settings unavailable', 'legacy export settings fallback');
      check(history.exportDetails({ ...entry, config: { video: { resolution: NaN, fps: -1, codec: {} } } }) === 'Settings unavailable', 'invalid export settings are not displayed');
      check(history.exportPath({ ...entry, relativePath: 'renders/a.mp4' }, '/projects/renamed') === '/projects/renamed/renders/a.mp4', 'export survives project rename');
      await reject(async () => history.exportPath({ ...entry, relativePath: '../private.mp4' }, '/projects/one'), /Invalid export/);
      for (const relativePath of ['renders/..', 'renders/.', 'renders/a/b.mp4', 'renders/a\\b.mp4', 'renders/a\0.mp4', 42]) {
        await reject(async () => history.exportPath({ ...entry, relativePath }, '/projects/one'), /Invalid export/);
      }
      check(history.exportPath(entry, '/projects/renamed') === entry.path, 'legacy absolute export location preserved');
      try {
        bridge.call = async (method, args) => {
          const input = args[0];
          if (method === 'storage.readJson') return { value: structuredClone(historyValue), version: String(historyVersion) };
          check(method === 'storage.writeJson', 'history must not delete video files');
          if (conflict) {
            conflict = false;
            historyValue = [{ ...entry, id: 'concurrent', projectId: 'two' }];
            historyVersion++;
            return { ok: false, conflict: true };
          }
          check(input.ifMatch === String(historyVersion), 'conditional history update');
          historyValue = structuredClone(input.value); historyVersion++;
          return { ok: true };
        };
        await history.rememberExport(entry);
        check(historyValue.length === 2, 'concurrent exports preserved');
        check((await history.listExports('one')).length === 1, 'history project filtering');
        await history.rememberExport(entry);
        check(historyValue.length === 2, 'history idempotent registration');
        await history.relocateExport('first', 'one', '/projects/one/renders/moved.mp4', '/projects/one');
        const moved = (await history.listExports('one'))[0];
        check(moved.relativePath === 'renders/moved.mp4' && moved.sourceHash === entry.sourceHash && moved.createdAt === entry.createdAt, 'relink preserves export provenance');
        await history.relocateExport('first', 'one', '/archive/moved.mp4', '/projects/one');
        const archived = (await history.listExports('one'))[0];
        check(!archived.relativePath && archived.path === '/archive/moved.mp4', 'external relink uses chosen absolute path');
        await reject(() => history.relocateExport('first', 'two', '/archive/moved.mp4', '/projects/two'), /removed from history/);
        await history.forgetExport('first', 'two');
        check(historyValue.length === 2, 'cannot forget another project export');
        await history.forgetExport('first', 'one');
        check(historyValue.length === 1 && historyValue[0].id === 'concurrent', 'forget preserves unrelated records');
        await reject(() => history.relocateExport('first', 'one', '/archive/moved.mp4', '/projects/one'), /removed from history/);
        const config = { format: 'webm', video: { fps: 30 } };
        await history.recordSuccessfulExport({ projectId: 'one', projectDir: '/projects/one',
          path: '/projects/one/renders/assistant.webm', sourceHash: 'compiled-revision', config });
        config.video.fps = 60;
        const saved = (await history.listExports('one'))[0];
        check(saved.sourceHash === 'compiled-revision' && saved.relativePath === 'renders/assistant.webm' && saved.config.video.fps === 30,
          'shared export registration retains immutable settings and compiled revision');
        await history.recordSuccessfulExport({ projectId: 'one', projectDir: '/projects/one',
          path: '/archive/external.webm', config });
        const external = (await history.listExports('one')).find(item => item.path === '/archive/external.webm');
        check(!external.relativePath && external.sourceHash === null, 'external export paths and unavailable revisions stay explicit');
      } finally { bridge.call = originalCall; }
      const s = new ProjectService(fs, () => changes++);
      await s.init();
      const p = await s.call("projects:create", {
        displayName: "Boundary test",
      });
      check(p.dir.endsWith(".cut"), "package suffix");
      const initialCompile = await s.call("projects:compile", { dir: p.dir });
      check(initialCompile.ok, "compile starter");
      let source = await s.readSource(p.dir);
      check(initialCompile.sourceHash === source.hash, 'compile returns fingerprint of its stamped source');
      check(source.source.includes("id="), "stable identifiers");
      const readBeforeRace = fs.read;
      const entryPath = join(p.dir, 'index.tsx');
      let raced = false;
      try {
        fs.read = async path => {
          const value = await readBeforeRace(path);
          if (path === entryPath && !raced) {
            raced = true;
            store.set(path, value.replace('Welcome to PureCut', 'Concurrent source change'));
          }
          return value;
        };
        const snapshot = await s.call('projects:compile', { dir: p.dir });
        check(raced && snapshot.ok && snapshot.sourceHash === source.hash,
          'concurrent file change cannot relabel a compiled snapshot');
        check(snapshot.code.includes('Welcome to PureCut') && !snapshot.code.includes('Concurrent source change'),
          'compiled code and revision come from the same source read');
      } finally {
        fs.read = readBeforeRace;
        store.set(entryPath, source.source);
      }
      // The starter's title, from purecut/lib/starter.ts: the edit has to
      // actually change the source for the stale-revision check below.
      const next = source.source.replace("Welcome to PureCut", "Drawer edit");
      check(next !== source.source, "starter title matches the test");
      const beforePreparation = new Map(store);
      const changesBeforePreparation = changes;
      const prepared = await s.call('purecut:prepare', {
        dir: p.dir, source: next, baseHash: source.hash,
      });
      check(prepared.before === source.source && prepared.baseHash === source.hash &&
        prepared.source === next && prepared.hash !== source.hash && prepared.dir === p.dir,
        'prepared edit identifies the exact before/after source and project');
      check(store.size === beforePreparation.size &&
        [...beforePreparation].every(([path, value]) => store.get(path) === value) &&
        changes === changesBeforePreparation, 'preparation neither writes files nor remounts the editor');
      await reject(() => s.call('purecut:prepare', {
        dir: p.dir, source: next, baseHash: 'outdated',
      }), /changed/);
      await reject(() => s.call('purecut:prepare', {
        dir: p.dir, source: "import fs from 'node:fs'; export default fs", baseHash: source.hash,
      }), /Only solid/);
      check((await s.readSource(p.dir)).hash === source.hash && changes === changesBeforePreparation,
        'invalid proposals leave the current project unchanged');
      let preparationRaced = false;
      try {
        fs.read = async path => {
          const value = await readBeforeRace(path);
          if (path === entryPath && !preparationRaced) {
            preparationRaced = true;
            store.set(path, value.replace('Welcome to PureCut', 'Concurrent review change'));
          }
          return value;
        };
        await reject(() => s.call('purecut:prepare', {
          dir: p.dir, source: next, baseHash: source.hash,
        }), /changed while preparing/);
        check(store.get(entryPath).includes('Concurrent review change'),
          'preparation preserves a concurrent external change');
      } finally {
        fs.read = readBeforeRace;
        store.set(entryPath, source.source);
      }
      await s.call("purecut:replace", {
        dir: p.dir,
        source: prepared.source,
        baseHash: prepared.baseHash,
      });
      check((await s.readSource(p.dir)).hash === prepared.hash,
        'applying a prepared edit saves exactly the reviewed source');
      await reject(
        () =>
          s.call("purecut:replace", {
            dir: p.dir,
            source: next,
            baseHash: source.hash,
          }),
        /changed/,
      );
      source = await s.readSource(p.dir);
      await reject(
        () =>
          s.call("purecut:replace", {
            dir: p.dir,
            source: "import fs from 'node:fs'; export default fs",
            baseHash: source.hash,
          }),
        /Only solid/,
      );
      check(
        (await s.readSource(p.dir)).source === source.source,
        "failed compile preserves source",
      );
      const id = source.source.match(/id="([^"]+)"[^>]*>Drawer edit/)[1];
      await s.call("projects:write", {
        dir: p.dir,
        edits: [
          {
            kind: "set",
            source: `index.tsx:${id}`,
            props: { x: 144 },
            text: "Manual edit",
          },
        ],
      });
      check(
        (await s.readSource(p.dir)).source.includes("Manual edit"),
        "manual edit preserves writeback",
      );
      await reject(
        () =>
          s.call("projects:write", {
            dir: p.dir,
            edits: [{ kind: "set", source: "../other.tsx:0", props: {} }],
          }),
        /entry/,
      );
      await reject(() => Promise.resolve(join(p.dir, "../escape")), /Invalid/);
      await reject(
        () => s.call("file:write-open", { path: p.dir + "/index.tsx" }),
        /target/,
      );
      const { id: stream } = await s.call("file:write-open", {
        path: p.dir + "/renders/test.mp4",
      });
      await s.call("file:write-chunk", {
        id: stream,
        position: 2,
        data: [3, 4],
      });
      await s.call("file:write-chunk", {
        id: stream,
        position: 0,
        data: [1, 2],
      });
      await s.call("file:write-close", { id: stream });
      check(
        blobs.get(p.dir + "/renders/test.mp4").join(",") === "1,2,3,4",
        "random-access export bridge",
      );
      const reopened = new ProjectService(fs);
      await reopened.init();
      check((await reopened.info(p.dir)).id === p.id, "reopen");
      check(changes === 1, "drawer reload event");
      return "PASS: browser compilation, source edits, stale revisions, failed writes, path limits, random-access export, reopen, export history conflicts/filtering/removal";
    },
    "/@fs" +
      realpathSync(
        fileURLToPath(
          import.meta.resolve("@purescience/platform-ui/bridge/client.mjs"),
        ),
      ),
  );
  console.log(result);
} finally {
  await browser?.close();
  server.kill("SIGTERM");
  await new Promise((r) => server.once("exit", r));
}
