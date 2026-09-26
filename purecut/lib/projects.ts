import { parse, stringify } from "yaml";
import {
  files,
  join,
  projectPath,
  parent,
  basename,
  type ProjectFiles,
} from "./platform-files";
import { starter } from "./starter";
import { validateScopedEdits } from "./scoped-edits";
import { readCompiledSource, rememberCompiledSource } from './compile-cache';
const hash = async (s: string) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)),
    ),
    (n) => n.toString(16).padStart(2, "0"),
  ).join("");
export class ProjectService {
  root = "";
  streams = new Map<
    string,
    {
      target: string;
      handle: FileSystemFileHandle;
      writer: FileSystemWritableFileStream;
    }
  >();
  constructor(
    private fs: ProjectFiles = files,
    private changed: (dir: string) => void = () => {},
  ) {}
  async init() {
    this.root = await this.fs.root();
  }
  async project(dir: string) {
    if (typeof dir !== "string" || !/^(\/|[a-z]:[/\\])/i.test(dir))
      throw Error("Expected an absolute project path");
    const pkg = JSON.parse(await this.fs.read(join(dir, "package.json")));
    if (pkg.main !== "index.tsx" || typeof pkg.projectId !== "string")
      throw Error("Not a PureCut project");
    return { dir, pkg };
  }
  async info(dir: string) {
    const { pkg } = await this.project(dir);
    return {
      id: pkg.projectId,
      name: basename(dir),
      displayName: pkg.displayName,
      dir,
      entry: "index.tsx",
      modifiedAt: pkg.modifiedAt || new Date().toISOString(),
      createdAt: pkg.createdAt || new Date().toISOString(),
    };
  }
  async readSource(dir: string) {
    await this.project(dir);
    const source = await this.fs.read(join(dir, "index.tsx"));
    return { source, hash: await hash(source) };
  }
  context(dir: string, source: { value: string }) {
    return {
      dir,
      io: {
        files: async () => ["index.tsx"],
        read: async (p: string) => {
          if (p !== "index.tsx") throw Error("Only index.tsx is supported");
          return source.value;
        },
        write: async (p: string, text: string) => {
          if (p !== "index.tsx") throw Error("Only index.tsx is supported");
          source.value = text;
        },
      },
    };
  }
  async call(channel: string, d: any = {}) {
    return navigator.locks
      .request("purecut-project-io", () => this.dispatch(channel, d ?? {}))
      .catch((e) => {
        throw Error(channel + ": " + e.message);
      });
  }
  async dispatch(channel: string, d: any): Promise<any> {
    if (channel === "window:is-fullscreen") return true;
    if (
      channel === "auth:get-pending-callback" ||
      channel === "checkout:get-pending-callback"
    )
      return null;
    if (channel === "projects:default-root") return this.root;
    if (channel === "projects:scan") {
      const out = [];
      for (const e of await this.fs.list(this.root))
        if (e.isDirectory) {
          try {
            out.push(await this.info(e.path));
          } catch {}
        }
      return out;
    }
    if (channel === "projects:create") {
      const id = crypto.randomUUID(),
        dir = join(this.root, id + ".cut");
      await this.fs.write(
        join(dir, "package.json"),
        JSON.stringify({
          projectId: id,
          displayName: String(d.displayName || "Untitled video").slice(0, 120),
          main: "index.tsx",
          createdAt: new Date().toISOString(),
        }),
      );
      await this.fs.write(join(dir, "index.tsx"), starter);
      await this.fs.write(
        join(dir, "assets.yml"),
        stringify({ version: 1, folders: [], assets: [] }),
      );
      return this.info(dir);
    }
    if (channel.startsWith("file:write-")) {
      if (channel === "file:write-open") {
        const match =
          /^(.*)[/\\](assets|cache|renders|exports|\.diffusion)[/\\](.+)$/.exec(
            d.path,
          );
        if (!match) throw Error("Invalid media target");
        await this.project(match[1]);
        join(match[1], match[2] + "/" + match[3]);
        const root = await navigator.storage.getDirectory(),
          id = crypto.randomUUID();
        const handle = await root.getFileHandle("cut-" + id, { create: true });
        const writer = await handle.createWritable();
        this.streams.set(id, { target: d.path, handle, writer });
        return { id };
      }
      const s = this.streams.get(d.id);
      if (!s) throw Error("Unknown write stream");
      if (channel === "file:write-chunk") {
        const data = new Uint8Array(d.data);
        if (
          !Number.isSafeInteger(d.position) ||
          d.position < 0 ||
          d.position + data.length > 128 * 1024 * 1024
        )
          throw Error("Media write exceeds 128 MB limit");
        await s.writer.write({ type: "write", position: d.position, data });
        return;
      }
      try {
        if (channel === "file:write-close") {
          await s.writer.close();
          await this.fs.binary(s.target, await s.handle.getFile());
        } else await s.writer.abort();
      } finally {
        this.streams.delete(d.id);
        await (
          await navigator.storage.getDirectory()
        ).removeEntry("cut-" + d.id);
      }
      return;
    }
    const { dir, pkg } = await this.project(d.dir);
    if (["projects:get", "projects:resolve", "projects:init"].includes(channel))
      return this.info(dir);
    if (["projects:watch", "projects:unwatch"].includes(channel)) return;
    if (channel === "purecut:source") return this.readSource(dir);
    if (
      ["projects:compile", "projects:write", "purecut:replace", "purecut:prepare", "purecut:prepare-edits"].includes(
        channel,
      )
    ) {
      const old = await this.readSource(dir),
        source = { value: old.source };
      if (channel === 'projects:compile') {
        const cached = await readCompiledSource(this.fs, dir, old.hash);
        if (cached) {
          return { ok: true, code: cached, sourceHash: old.hash };
        }
      }
      const { compile, stampProject, applyEdits } = await import('../compiler-runtime.js');
      let result: any;
      if (channel === "purecut:prepare-edits") {
        if (old.hash !== d.baseHash) throw Error("Project changed. Read the current source before editing again.");
        const edits = validateScopedEdits(d.edits).map(edit => ({ ...edit, kind: "set" as const }));
        result = await applyEdits(this.context(dir, source), edits);
        if (result.error) throw Error(result.error);
      }
      if (channel === "purecut:replace" || channel === "purecut:prepare") {
        if (old.hash !== d.baseHash)
          throw Error(
            "Project changed. Read the current source before editing again.",
          );
        if (typeof d.source !== "string" || d.source.length > 1024 * 1024)
          throw Error("Invalid source");
        source.value = d.source;
      }
      if (channel === "projects:write") {
        const { parseSource } = await import('@diffusionstudio/jsx');
        if (!Array.isArray(d.edits) || d.edits.length > 1000)
          throw Error("Invalid edits");
        for (const e of d.edits)
          for (const k of ["source", "parent", "before"])
            if (e[k]) {
              const p = parseSource(e[k]);
              if (p && p.file !== "index.tsx")
                throw Error("Edit leaves project entry");
            }
        result = await applyEdits(this.context(dir, source), d.edits);
      }
      await stampProject(this.context(dir, source));
      const compiled = compile(source.value);
      if (!compiled.ok) {
        if (channel === "projects:compile") return compiled;
        throw Error(compiled.error);
      }
      if (channel === "purecut:prepare" || channel === "purecut:prepare-edits") {
        if ((await this.readSource(dir)).hash !== old.hash)
          throw Error("Project changed while preparing the edit. Read the current source again.");
        // Review exactly the stamped source that will be submitted on approval.
        return {
          dir,
          before: old.source,
          baseHash: old.hash,
          source: source.value,
          hash: await hash(source.value),
        };
      }
      if (source.value !== old.source) {
        if ((await this.readSource(dir)).hash !== old.hash)
          throw Error(
            "Source changed outside the editor; reload before saving",
          );
        await this.fs.write(join(dir, "index.tsx"), source.value);
        if (channel === "purecut:replace") this.changed(dir);
      }
      const sourceHash = await hash(source.value);
      await rememberCompiledSource(this.fs, dir, sourceHash, compiled.code);
      return channel === "projects:compile"
        ? { ...compiled, sourceHash }
        : channel === "purecut:replace"
          ? this.readSource(dir)
          : result;
    }
    if (channel === "projects:rename") {
      pkg.displayName = String(d.displayName).slice(0, 120);
      await this.fs.write(join(dir, "package.json"), JSON.stringify(pkg));
      return this.info(dir);
    }
    if (channel === "projects:manifest-read")
      return parse(await this.fs.read(join(dir, "assets.yml")));
    if (channel === "projects:manifest-write") {
      await this.fs.write(join(dir, "assets.yml"), stringify(d.manifest));
      return;
    }
    if (channel === "projects:config-read") return pkg.diffusion ?? null;
    if (channel === "projects:config-write") {
      pkg.diffusion = d.config;
      await this.fs.write(join(dir, "package.json"), JSON.stringify(pkg));
      return;
    }
    if (channel.startsWith("projects:fs-")) {
      const p = projectPath(dir, d.source ?? d.path);
      if (channel === "projects:fs-real-path") return p;
      if (channel === "projects:fs-list")
        return (await this.fs.list(p)).map((e) => ({
          name: e.name,
          kind: e.isDirectory ? "directory" : "file",
        }));
      if (channel === "projects:fs-stat") {
        const e = (await this.fs.list(parent(p))).find(
          (e) => e.path.replaceAll("\\", "/") === p.replaceAll("\\", "/"),
        );
        return e
          ? { size: e.byteLength, mtime: Date.parse(e.modifiedAt) }
          : null;
      }
      if (channel === "projects:fs-remove") {
        if (!String(d.path).startsWith("assets/"))
          throw Error("Only assets can be removed");
        await this.fs.remove(p);
        return;
      }
    }
    throw Error("Unsupported PureCut operation: " + channel);
  }
}
