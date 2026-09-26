/** @jsxImportSource react */
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { SpeechSettings } from "./speech-settings";
import { AppFrame } from "@purescience/platform-bridge/components/AppFrame";
import { usePlatformBridge } from "@purescience/platform-ui/bridge/react/usePlatformBridge";
import { usePlatformViewportResource } from "@purescience/platform-ui/bridge/react/usePlatformViewportResource";
import {
  initializeTransport,
  mountEditor,
  registerDrawer,
  openResource,
  prepareDocuments,
  createVideo,
  currentVideo,
  chooseVideo,
  renameVideo,
} from "./integration-runtime.js";
import { DocumentSwitcher } from "@purescience/platform-ui/components/common/documents/DocumentSwitcher";
import { DocumentHeaderActions } from "@purescience/platform-ui/components/common/documents/DocumentHeaderActions";
import {
  registerPlatformAppObject,
  touchPlatformRecentDocument,
} from "@purescience/platform-ui/bridge/documents.mjs";
import { readPlatformTextFile } from "@purescience/platform-ui/bridge/fs.mjs";
const suffixes = [".cut"];
async function loadPreview(item: { path: string }) {
  const pkg = JSON.parse(
    await readPlatformTextFile(item.path + "/package.json"),
  );
  return {
    kind: "text" as const,
    title: pkg.displayName,
    excerpt: "Video timeline",
  };
}
function App() {
  const [boot, setBoot] = useState(false),
    [failure, setFailure] = useState("");
  const [switcher, setSwitcher] = useState(false);
  const [video, setVideo] = useState<{
    id: string;
    dir: string;
    displayName: string;
  } | null>(null);
  const [home, setHome] = useState(!location.hash.startsWith("#/projects/"));
  const busy = useRef(false);
  async function openVideo(path?: string) {
    if (busy.current) return;
    busy.current = true;
    try {
      const p = path ? await openResource(path) : await createVideo();
      location.hash = "/projects/" + p.id;
      setSwitcher(false);
      setFailure("");
    } finally {
      busy.current = false;
    }
  }
  function run(action: Promise<unknown>) {
    void action.catch((e) => setFailure(e.message));
  }
  useEffect(() => {
    if (!boot) return;
    let generation = 0;
    const sync = async () => {
      const attempt = ++generation;
      setHome(!location.hash.startsWith("#/projects/"));
      const p = await currentVideo();
      if (attempt !== generation) return;
      setVideo(p);
      if (p) {
        await registerPlatformAppObject({ appSlug: "cut", path: p.dir });
        await touchPlatformRecentDocument({
          appSlug: "cut",
          path: p.dir,
          title: p.displayName,
        });
      }
    };
    const changed = () => run(sync());
    changed();
    window.addEventListener("hashchange", changed);
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "o") {
        e.preventDefault();
        setSwitcher(true);
      }
    };
    window.addEventListener("keydown", key);
    return () => {
      generation++;
      window.removeEventListener("hashchange", changed);
      window.removeEventListener("keydown", key);
    };
  }, [boot]);
  const { ready, meta, error } = usePlatformBridge();
  const { resource, clearResource } = usePlatformViewportResource(ready, meta);
  const slot = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ready) return;
    let disposed = false;
    let unmount: (() => void) | undefined;
    (async () => {
      await initializeTransport();
      if (disposed) return;
      unmount = await mountEditor(slot.current!);
      if (disposed) {
        unmount();
        return;
      }
      await registerDrawer();
      if (disposed) return;
      setBoot(true);
      // Library reconciliation must not delay opening the requested workspace.
      void prepareDocuments().catch((e) => {
        if (!disposed) console.warn('[PureCut] Could not reconcile the video library', e);
      });
    })().catch((e) => setFailure(e.message));
    return () => {
      disposed = true;
      unmount?.();
    };
  }, [ready]);
  useEffect(() => {
    if (!boot || !resource) return;
    let cancelled = false;
    (async () => {
      const p = await openResource(resource.path);
      if (cancelled) return;
      location.hash = "/projects/" + p.id;
      clearResource();
      setFailure("");
    })().catch((e) => {
      if (!cancelled) setFailure(e.message);
    });
    return () => {
      cancelled = true;
    };
  }, [boot, resource]);
  return (
    <AppFrame
      style={{
        background: "transparent",
        color: "var(--platform-colors-text)",
      }}
      identityAppSlug="cut"
      settingsSections={[{
        id: "speech",
        label: "Speech editing",
        description: "Optional transcription and speaker labels.",
        content: <SpeechSettings />,
      }]}
      headerDocumentName={video?.displayName}
      headerActions={
        <DocumentHeaderActions onOpenSwitcher={() => setSwitcher(true)} />
      }
    >
      {(failure || error) && (
        <div role="alert" style={{ padding: 20 }}>
          {failure || error?.message}
        </div>
      )}
      {!boot && !failure && !error && (
        <div role="status" style={{ padding: 20 }}>
          {window.parent === window
            ? "Open PureCut inside PureDesktop to access your projects."
            : "Opening your video workspace…"}
        </div>
      )}
      {boot && (home || switcher) && (
        <DocumentSwitcher
          appSlug="cut"
          suffixes={suffixes}
          variant={home ? "landing" : "modal"}
          onClose={() => setSwitcher(false)}
          onOpenDocument={openVideo}
          onCreateNew={() => run(openVideo())}
          newLabel="New video"
          itemNoun="video"
          loadPreview={loadPreview}
          openError={failure}
          onChooseFromSystem={() =>
            run(
              chooseVideo().then((path) =>
                path ? openVideo(path) : undefined,
              ),
            )
          }
          performAction={async (request) => {
            if (request.action !== "rename")
              throw new Error(
                "Use Files to manage video folders. Close the video before moving or deleting it; copying a folder does not create a new video identity.",
              );
            const p = await renameVideo(request.item.path, request.title!);
            if (p.id === video?.id) setVideo(p);
          }}
        />
      )}
      <div
        id="cut-editor"
        ref={slot}
        style={{
          flex: 1,
          minHeight: 0,
          display: boot && !home ? "block" : "none",
        }}
      />
    </AppFrame>
  );
}
createRoot(document.getElementById("purecut-host")!).render(<App />);
