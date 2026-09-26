import { render } from "solid-js/web";
import { onMount, onCleanup } from "solid-js";
import { HashRouter, Route } from "@solidjs/router";
import { ColorModeProvider, useColorMode } from "@kobalte/core";
import { AuthProvider } from "@/context/auth";
import { ProjectPage } from "@/pages/project";
import { EditorApi } from "@/dapi";
import { Toaster } from "@/components/ui/sonner";
import { COLORS } from "@/engine/timeline/constants";
import { SourceEditReview } from "./edit-review";

import "@/index.css";
import "./styles.css";
// AppFrame applies the shell theme to the document. Keep Kobalte components
// and portals in the same mode without a competing localStorage preference.
const desktopMode = (): "light" | "dark" =>
  document.documentElement.dataset.platformTheme === "dark" ? "dark" : "light";
const desktopThemeStorage = {
  type: "localStorage" as const,
  get: desktopMode,
  set: () => {},
};
export function DesktopTheme() {
  const { setColorMode } = useColorMode();
  onMount(() => {
    const sync = () => {
      const dark = desktopMode() === "dark";
      setColorMode(dark ? "dark" : "light");
      Object.assign(COLORS.background, {
        default: dark ? "#202938" : "#edf2f5",
        muted: dark ? "#303c4e" : "#dce5eb",
        accent: dark ? "#354458" : "#dbe8f0",
      });
      Object.assign(COLORS.border, {
        darker: dark ? "#283344" : "#d0dce4",
        input: dark ? "#526278" : "#a4b6c4",
      });
      Object.assign(COLORS.ruler, {
        tick: dark ? "#627389" : "#a4b6c4",
        text: dark ? "#c3cedd" : "#42566b",
      });
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-platform-theme"],
    });
    onCleanup(() => observer.disconnect());
  });
  return null;
}
// Document navigation is owned by the shared React document overlay.
function Home() {
  return null;
}
export function mountEditor(target: HTMLElement) {
  document.documentElement.dataset.app = "cut";
  return render(
    () => (
      <ColorModeProvider
        initialColorMode={desktopMode()}
        storageManager={desktopThemeStorage}
      >
        <DesktopTheme />
        <HashRouter
          root={(p) => (
            <AuthProvider>
              {p.children}
              <EditorApi />
              <Toaster />
              <SourceEditReview />
            </AuthProvider>
          )}
        >
          <Route path="/" component={Home} />
          <Route path="/projects/*ref" component={ProjectPage} />
        </HashRouter>
      </ColorModeProvider>
    ),
    target,
  );
}
