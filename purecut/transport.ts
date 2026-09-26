import { MAIN_WIRE } from "./editor-core/main-channels";
import { DAPI_WIRE } from "@diffusionstudio/dapi";
const listeners = new Map<string, Set<(data: any) => void>>();
const replies = new Map<
  string,
  { resolve: (v: any) => void; reject: (e: Error) => void }
>();
const emit = (channel: string, data: any) =>
  listeners.get(channel)?.forEach((fn) => fn(data));
let service: import("./lib/projects").ProjectService;
export async function initializeTransport() {
  const { ProjectService } = await import("./lib/projects");
  service = new ProjectService(undefined, (dir) =>
    emit(MAIN_WIRE.EVENT, {
      channel: "projects:changed",
      data: { dir, path: "index.tsx" },
    }),
  );
  await service.init();
}
export async function request(channel: string, data: any = {}) {
  if (!service) throw Error("PureCut is not ready");
  return service.call(channel, data);
}
export async function materializeFile(path: string) {
  return (await import("./lib/platform-files")).files.file(path);
}
export function runTool(tool: string, args: any = {}) {
  const id = crypto.randomUUID();
  return new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => {
      replies.delete(id);
      emit(DAPI_WIRE.CANCEL, { id });
      reject(Error("Editor operation timed out"));
    }, 120000);
    replies.set(id, {
      resolve: (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });
    emit(DAPI_WIRE.CALL, { id, tool, args });
  });
}
(window as any).desktop = {
  platform: "puredesktop",
  getPathForFile: () => "",
  on(channel: string, fn: (p: any) => void) {
    if (!listeners.has(channel)) listeners.set(channel, new Set());
    listeners.get(channel)!.add(fn);
    return () => listeners.get(channel)?.delete(fn);
  },
  send(channel: string, p: any) {
    if (channel === MAIN_WIRE.REQUEST)
      void request(p.channel, p.data).then(
        (data) => emit(MAIN_WIRE.RESPONSE, { id: p.id, ok: true, data }),
        (error) =>
          emit(MAIN_WIRE.RESPONSE, {
            id: p.id,
            ok: false,
            error: error.message,
          }),
      );
    if (channel === DAPI_WIRE.REPLY) {
      const pending = replies.get(p.id);
      replies.delete(p.id);
      if (p.ok) pending?.resolve(p.data);
      else pending?.reject(Error(p.error.message));
    }
  },
};
