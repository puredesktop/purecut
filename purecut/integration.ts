export { initializeTransport } from "./transport";
export async function mountEditor(target: HTMLElement) {
  return (await import("./entry")).mountEditor(target);
}
export async function registerDrawer() {
  await import("./drawer");
}
export async function openResource(path: string) {
  await (await import("@/projects/edits")).flushPendingProjectEdits();
  return (await import("@/projects/host")).openProjectFolder(path);
}

export async function prepareDocuments() {
  const host = await import("@/projects/host");
  await host.ensureProjectsRoot();
  const { registerPlatformAppObject } =
    await import("@purescience/platform-ui/bridge/documents.mjs");
  const projects = await host.listProjects();
  // Bound filesystem/bridge traffic while avoiding one round trip at a time.
  for (let start = 0; start < projects.length; start += 4) {
    await Promise.all(projects.slice(start, start + 4).map(async project => {
      if (await host.getProject(project.dir).catch(() => null))
        await registerPlatformAppObject({ appSlug: "cut", path: project.dir });
    }));
  }
}
export async function createVideo() {
  await (await import("@/projects/edits")).flushPendingProjectEdits();
  const host = await import("@/projects/host");
  await host.ensureProjectsRoot();
  return host.createProject("Untitled video");
}
export async function currentVideo() {
  const ref = location.hash.match(/^#\/projects\/(.+)$/)?.[1];
  return ref
    ? (await import("@/projects/host")).resolveProject(decodeURIComponent(ref))
    : null;
}
export async function chooseVideo() {
  return (
    await import("@purescience/platform-ui/bridge/dialog.mjs")
  ).openPlatformFolderDialog();
}
export async function renameVideo(path: string, title: string) {
  await (await import("@/projects/edits")).flushPendingProjectEdits();
  return (await import("@/projects/host")).renameProject(path, title);
}
