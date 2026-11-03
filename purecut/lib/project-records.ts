import { parse, stringify } from "yaml";
import { join, type ProjectFiles } from "./platform-files";

const packageOf = async (fs: ProjectFiles, dir: string) =>
  JSON.parse(await fs.read(join(dir, "package.json")));

/** A project's media library (assets.yml) and settings (package.json `diffusion`). The service holds the project lock around each call. */
export class ProjectRecords {
  constructor(
    private fs: ProjectFiles,
    private changed: (dir: string, file: string) => void = () => {},
  ) {}
  async readManifest(dir: string) {
    return parse(await this.fs.read(join(dir, "assets.yml")));
  }
  async writeManifest(dir: string, manifest: unknown) {
    await this.fs.write(join(dir, "assets.yml"), stringify(manifest));
  }
  async readConfig(dir: string) {
    return (await packageOf(this.fs, dir)).diffusion ?? null;
  }
  async writeConfig(dir: string, config: unknown) {
    const pkg = await packageOf(this.fs, dir);
    pkg.diffusion = config;
    await this.fs.write(join(dir, "package.json"), JSON.stringify(pkg));
  }
  async rename(dir: string, displayName: string) {
    const pkg = await packageOf(this.fs, dir);
    pkg.displayName = displayName;
    await this.fs.write(join(dir, "package.json"), JSON.stringify(pkg));
  }
}
