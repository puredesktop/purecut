export function initializeTransport(): Promise<void>;
export function mountEditor(target: HTMLElement): Promise<() => void>;
export function registerDrawer(): Promise<void>;
export function openResource(path: string): Promise<{ id: string }>;

export interface VideoDocument {
  id: string;
  dir: string;
  displayName: string;
}
export function prepareDocuments(): Promise<void>;
export function createVideo(): Promise<VideoDocument>;
export function currentVideo(): Promise<VideoDocument | null>;
export function chooseVideo(): Promise<string | null>;
export function renameVideo(
  path: string,
  title: string,
): Promise<VideoDocument>;
