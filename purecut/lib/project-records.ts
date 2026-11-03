import { parse, stringify } from "yaml";
import { join, type ProjectFiles } from "./platform-files";
import { mergeConfig, mergeManifest, type ManifestShape } from "./record-merge";

const packageOf = (text: string) => JSON.parse(text);
const FILES = ["index.tsx", "assets.yml", "package.json"] as const;

/**
 * A project's media library (assets.yml) and settings (package.json `diffusion`), which the editor holds in memory and saves
 * whole. Other live copies of the app save them too, so each save measures this copy's change against what it last read and
 * merges it into the file as it is now; the service holds the project lock (shared by every frame of the app) around each
 * call. `look` is how a copy hears of what another saved: the shell has no watcher, and the files are small.
 */
export class ProjectRecords {
  /** Each file as this copy last read or wrote it, by path. */
  private known = new Map<string, string>();
  /** The settings this copy last read: what a settings save is measured against. */
  private config = new Map<string, unknown>();
  constructor(
    private fs: ProjectFiles,
    private changed: (dir: string, file: string) => void = () => {},
  ) {}
  private async read(dir: string, file: (typeof FILES)[number]) {
    const text = await this.fs.read(join(dir, file));
    this.known.set(join(dir, file), text);
    return text;
  }
  private async write(dir: string, file: (typeof FILES)[number], text: string) {
    await this.fs.write(join(dir, file), text);
    this.known.set(join(dir, file), text);
  }
  async readManifest(dir: string) {
    return parse(await this.read(dir, "assets.yml"));
  }
  async writeManifest(dir: string, manifest: ManifestShape) {
    const before = this.known.get(join(dir, "assets.yml"));
    const now = await this.fs.read(join(dir, "assets.yml")).catch(() => null);
    if (before === undefined || now === null || now === before) {
      await this.write(dir, "assets.yml", stringify(manifest));
      return;
    }
    await this.write(dir, "assets.yml", stringify(mergeManifest(parse(before), manifest, parse(now))));
    // This copy's library lacks what the other added: it reads the merged file again.
    this.changed(dir, "assets.yml");
  }
  async readConfig(dir: string) {
    const value = packageOf(await this.read(dir, "package.json")).diffusion ?? null;
    this.config.set(dir, value);
    return value;
  }
  async writeConfig(dir: string, config: unknown) {
    const pkg = packageOf(await this.fs.read(join(dir, "package.json")));
    const known = this.config.has(dir);
    const merged = known ? mergeConfig(this.config.get(dir), config, pkg.diffusion ?? null) : config;
    pkg.diffusion = merged;
    await this.write(dir, "package.json", JSON.stringify(pkg));
    this.config.set(dir, merged);
    if (JSON.stringify(merged) !== JSON.stringify(config)) this.changed(dir, "package.json");
  }
  async rename(dir: string, displayName: string) {
    const pkg = packageOf(await this.fs.read(join(dir, "package.json")));
    pkg.displayName = displayName;
    await this.write(dir, "package.json", JSON.stringify(pkg));
  }
  /** The service wrote the source: this copy's own save is no news when it next looks. */
  ownSource(dir: string, text: string) {
    this.known.set(join(dir, "index.tsx"), text);
  }
  /** Compare the files with what this copy last knew. The first look only learns where things stand. */
  async look(dir: string) {
    for (const file of FILES) {
      const path = join(dir, file);
      const text = await this.fs.read(path).catch(() => null);
      if (text === null || text === this.known.get(path)) continue;
      const seen = this.known.has(path);
      this.known.set(path, text);
      if (seen) this.changed(dir, file);
    }
  }
}
