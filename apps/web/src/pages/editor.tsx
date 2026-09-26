/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Show, createMemo, createSignal, onMount } from "solid-js";
import { Canvas } from "@/components/canvas";
import { speechOpen } from "../../../../purecut/speech/review";
import { SpeechPanel } from "../../../../purecut/speech/panel";
import { CommandBar } from "@/components/command-bar";
const rightSidebarWidth = () => 264;
const RightSidebar = (props: {editor: () => any}) => props.editor();
import { Timeline, Layers } from "@/components/timeline";
import { Soundboard, Inspector } from "@/components/sidebar-right";
import { FloatingProjectHeader, SidebarLeft } from "@/components/sidebar-left";
import { useLayout, MIN_TIMELINE_HEIGHT } from "@/context/layout";
import { useEditorApi } from "@/dapi";
import { RULER_HEIGHT } from "@/engine/timeline";
import { createEffect, onCleanup, untrack } from 'solid-js';
import { toast } from 'somoto';
import { useWorld } from '@diffusionstudio/koota-solid';
import { mount, getRuntimeDocument } from '@diffusionstudio/reconciler';
import { focusContent } from '@diffusionstudio/runtime';
import { getDocumentEditor } from '@/engine/editor';
import { getEditHistory } from '@/engine/history';
import { zoomToFit } from '@/engine/camera';
import { setInspectEntries } from '@/engine/inspect';
import { attachLibrary, isLibraryFile } from '@/engine/library';
import { attachAi } from '@/utils/gen-ai';
import { attachProjectConfig, isProjectConfigFile } from '@/engine/project-config';
import { loadProjectBundle, rememberProjectBundle } from '@/lib/db';
import { isCacheFile } from '@diffusionstudio/assets';
import { createEditWriter } from '@/projects/edits';
import { compileProject, refreshProject, watchProject } from '@/projects/host';
import { captureProjectCover } from '@/projects/cover';
import { useProject } from "@/context/project";
import { useEngineContext } from "@/engine";

import type { Mount } from '@diffusionstudio/reconciler';
import type { EditWriter } from '@/projects/edits';

const MIN_CANVAS_HEIGHT = 200;

export function EditorPage() {
  const { uiVisible, mediaVisible, inspectorVisible, timelineMinimized, timelineHeight, setTimelineHeight } = useLayout();
  const { isDesktop, isFullscreen } = useEditorApi();
  const [resizing, setResizing] = createSignal(false);
  const [workspaceHeight, setWorkspaceHeight] = createSignal(0);
  let workspace: HTMLDivElement | undefined;
  onMount(() => {
    if (!workspace) return;
    let fitFrame: number | undefined;
    const observer = new ResizeObserver(([entry]) => {
      setWorkspaceHeight(entry.contentRect.height);
      if (import.meta.env.VITE_PURECUT && speechOpen()) {
        if (fitFrame !== undefined) cancelAnimationFrame(fitFrame);
        fitFrame = requestAnimationFrame(() => zoomToFit(world));
      }
    });
    observer.observe(workspace);
    onCleanup(() => {
      observer.disconnect();
      if (fitFrame !== undefined) cancelAnimationFrame(fitFrame);
    });
  });
  const maxTimelineHeight = () => Math.max(MIN_TIMELINE_HEIGHT, workspaceHeight() - MIN_CANVAS_HEIGHT - 1);
  // Preserve the preferred height when a smaller window temporarily constrains it.
  const displayedTimelineHeight = () => Math.min(timelineHeight(), maxTimelineHeight());
  const project = useProject();
  const world = useWorld();
  const engine = useEngineContext();
  const [projectLoading, setProjectLoading] = createSignal(true);
  const [projectError, setProjectError] = createSignal('');
  let retryProject = () => {};

  // Keyed on the folder, not the project: a rename moves it, and everything
  // below holds a path — the watcher, the library, the writer — so all of it
  // is torn down and re-attached where the project now is.
  createEffect(() => {
    const dir = project.dir();
    if (!dir) {
      setProjectLoading(false);
      setProjectError('No project folder is available. Reopen the video from the library.');
      return;
    }

    let mounted: Mount | undefined;
    let mountedCode: string | undefined;
    let writer: EditWriter | undefined;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    let generation = 0;
    let initialFrame: number | undefined;

    // The library first: a mounted project's `src` values name its assets.
    const library = attachLibrary(world, dir);
    // The generation service over it: what `generate.*` sources resolve through.
    if (!import.meta.env.VITE_PURECUT) attachAi(world, library, dir);
    // The project's own settings (package.json `diffusion`), next to the scene.
    const config = attachProjectConfig(world, dir);

    const unmount = (): void => {
      if (initialFrame !== undefined) cancelAnimationFrame(initialFrame);
      initialFrame = undefined;
      // Before the entities go: what the editor changed is still owed to the
      // file, whatever happens to the scene that showed it.
      unlisten?.();
      unlisten = undefined;
      writer?.dispose();
      writer = undefined;
      mounted?.dispose();
      mounted = undefined;
      mountedCode = undefined;
      // The entries hold the dead mount's signals; the inspector must not.
      setInspectEntries(world, []);
    };

    /** Puts `code` on the stage, unless it is what is there already. */
    const applyBundle = (code: string): void => {
      if (code === mountedCode) return;
      // The old render goes first: there is only one stage per world.
      unmount();
      mounted = mount(code, world);
      mountedCode = code;
      if (import.meta.env.VITE_PURECUT && !getRuntimeDocument(world).hasAuthoredCamera) {
        // Wait for canvas sizing and the first bounds pass, not an authored edit.
        initialFrame = requestAnimationFrame(() => {
          initialFrame = requestAnimationFrame(() => {
            initialFrame = undefined;
            focusContent(world);
          });
        });
      }
      // The `@inspect` variables this mount declared, for the inspector.
      setInspectEntries(world, mounted.inspect);
      // The rendered scene knows which element every entity came from, so
      // from here on an edit in the editor can find its way back.
      writer = createEditWriter(dir, world);
      const editor = getDocumentEditor(world);
      unlisten = editor.onEdit((edit) => writer?.push(edit));
      // A mount comes from the file: edits recorded against the document it
      // replaced cannot be replayed against this one.
      getEditHistory(world).reset();
    };

    const loadProject = async (current: number): Promise<void> => {
      const compiling = compileProject(dir);
      const loading = library.load();

      // First open only: the bundle the last session mounted, straight from
      // the app's database, goes on the stage while the compile chews
      // through the sources — unless the compile wins the race outright. A
      // bundle the sources have outgrown can fail against today's assets;
      // the compile that is already running replaces it either way.
      if (current === 1) {
        // Neither arm may reject: the loser would be an unhandled rejection,
        // and the compile's real failure is dealt with below.
        const cached = await Promise.race([
          Promise.all([loadProjectBundle(untrack(project.id)), loading])
            .then(([code]) => code, () => null),
          compiling.then(() => null, () => null),
        ]);
        if (disposed || current !== generation) return;
        if (cached && mountedCode === undefined) {
          try {
            applyBundle(cached);
          } catch {
            // The compile lands next, with a toast of its own if it must.
          }
        }
      }

      const [result] = await Promise.all([compiling, loading]);
      if (disposed || current !== generation) return;

      // A broken edit keeps the last good render on the canvas.
      if (!result.ok) {
        console.error('[projects] compile failed:', result.error);
        setProjectError(result.error);
        toast.error('Project failed to compile', { description: result.error });
        return;
      }

      try {
        applyBundle(result.code);
        // What an export renders a second time, and the next open's head
        // start (see `rememberProjectBundle`) — recorded only once it has
        // actually mounted, so the record never runs ahead of the canvas.
        rememberProjectBundle(untrack(project.id), result.code).catch((error) =>
          console.error('[projects] could not save the bundle', error));
      } catch (error) {
        console.error('[projects] render failed:', error);
        setProjectError(error instanceof Error ? error.message : String(error));
        toast.error('Project failed to render', { description: (error as Error).message });
      }
    };

    const load = (): void => {
      const current = ++generation;
      setProjectLoading(true);
      setProjectError('');
      loadProject(current).catch((error) => {
        if (disposed || current !== generation) return;
        console.error('[projects] load failed:', error);
        setProjectError(error instanceof Error ? error.message : String(error));
        toast.error('Project failed to load', { description: (error as Error).message });
      }).finally(() => {
        if (!disposed && current === generation) setProjectLoading(false);
      });
    };

    retryProject = load;
    load();
  
    // A burst arrives as the whole set of files it touched, so a checkout that
    // rewrites the library and the sources at once reloads both — reading only
    // the last path of a burst would answer for one of them and drop the rest.
    const unwatch = watchProject(dir, (paths) => {
      const changed = paths.filter((path) => !isCacheFile(path));
      if (changed.some(isLibraryFile)) library.load();

      const source = changed.filter((path) => !isLibraryFile(path));
      if (!source.length) return;
      // package.json is the config and the record (`main`, `displayName`)
      // in one, so a hand edit to it reloads both; the app's own config
      // writes never reach here (main keeps them from the watcher).
      if (source.some(isProjectConfigFile)) {
        config.load();
        project.refresh();
      }
      load();
    });

    onCleanup(() => {
      disposed = true;
      retryProject = () => {};
      captureProjectCover(dir, engine.snapshot());
      refreshProject(dir);
      unwatch();
      unmount();
      config.dispose();
      library.dispose();
    });
  });

  // The right column follows the sidebar's tab (264 px on Editor, 320 px on
  // Chat) and animates between the two — except on load, where the stored
  // tab is read before first paint and the transition only comes on after
  // the first frame. Toggling `uiVisible` changes the track count, which
  // Chromium does not interpolate, so that still snaps as before.
  const [animateColumns, setAnimateColumns] = createSignal(false);
  onMount(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    requestAnimationFrame(() => requestAnimationFrame(() => setAnimateColumns(true)));
  });

  const timelineStyles = createMemo(() => {
    if (!uiVisible()) return;

    const height = timelineMinimized() ? RULER_HEIGHT : displayedTimelineHeight();

    return {
      'grid-template-columns': import.meta.env.VITE_PURECUT
        ? `${mediaVisible() && !speechOpen() ? 'minmax(180px, 220px) 1px' : '0px 0px'} minmax(0, 1fr) ${inspectorVisible() && !speechOpen() ? '1px minmax(220px, 248px)' : '0px 0px'}`
        : `264px 1px 1fr 1px ${rightSidebarWidth()}px`,
      'grid-template-rows': `1fr 1px ${height}px`,
      ...(animateColumns() ? { transition: 'grid-template-columns 200ms ease-out' } : {}),
    };
  });

  const resizeTimeline = (height: number) => {
    setTimelineHeight(Math.max(MIN_TIMELINE_HEIGHT, Math.min(maxTimelineHeight(), height)));
  };
  let finishResize: (() => void) | undefined;
  onCleanup(() => finishResize?.());

  const handleResizeStart = (e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    finishResize?.();
    const startY = e.clientY;
    const startHeight = displayedTimelineHeight();
    setResizing(true);

    const handleMove = (ev: PointerEvent) => {
      const deltaY = startY - ev.clientY;
      resizeTimeline(startHeight + deltaY);
    };

    const handleEnd = () => {
      setResizing(false);
      document.removeEventListener('pointermove', handleMove);
      document.removeEventListener('pointerup', handleEnd);
      document.removeEventListener('pointercancel', handleEnd);
      window.removeEventListener('blur', handleEnd);
      finishResize = undefined;
    };

    document.addEventListener('pointermove', handleMove);
    document.addEventListener('pointerup', handleEnd);
    document.addEventListener('pointercancel', handleEnd);
    window.addEventListener('blur', handleEnd);
    finishResize = handleEnd;
  };

  return (
    <div class="h-full w-full flex flex-col overflow-hidden">
    <Show when={!!import.meta.env.VITE_PURECUT && uiVisible()}>
      <CommandBar />
    </Show>
    <div class="cut-editor-content">
    <Show when={!!import.meta.env.VITE_PURECUT && uiVisible()}><SpeechPanel /></Show>
    <div
      ref={workspace}
      class="bg-sidebar flex-1 min-h-0 min-w-0 overflow-hidden grid"
      classList={{
        'grid-cols-[1fr]': !uiVisible(),
        'grid-rows-[1fr]': !uiVisible(),
      }}
      style={timelineStyles()}
    >
      <Show when={isDesktop && !isFullscreen()}>
        <div class="fixed top-0 left-0 right-0 h-10 z-20" style="-webkit-app-region: drag;" />
      </Show>
      <Show when={uiVisible()}>
        <div class="min-w-0 overflow-hidden" style={{ visibility: mediaVisible() && !speechOpen() ? 'visible' : 'hidden' }}><SidebarLeft /></div>
        <div class="bg-border-strong" />
      </Show>
      <Canvas loading={projectLoading()} error={projectError()} onRetry={() => retryProject()} />
      <Show when={uiVisible()}>
        <div class="bg-border-strong" />
        <div class="min-w-0 overflow-hidden" style={{ visibility: inspectorVisible() && !speechOpen() ? 'visible' : 'hidden' }}>
          <RightSidebar editor={() => <Inspector />} />
        </div>
      </Show>
      <Show when={uiVisible()}>
        <div class="col-span-full bg-border-strong relative">
          <Show when={!timelineMinimized()}>
            <div
              role="separator"
              aria-label="Timeline height"
              aria-orientation="horizontal"
              aria-valuemin={MIN_TIMELINE_HEIGHT}
              aria-valuemax={maxTimelineHeight()}
              aria-valuenow={displayedTimelineHeight()}
              tabIndex={0}
              class="absolute left-0 right-0 -top-px h-0.75 z-10 cursor-ns-resize group focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
              onPointerDown={handleResizeStart}
              onKeyDown={event => {
                if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
                event.preventDefault();
                event.stopPropagation();
                const step = event.shiftKey ? 50 : 10;
                resizeTimeline(event.key === 'Home' ? MIN_TIMELINE_HEIGHT
                  : event.key === 'End' ? maxTimelineHeight()
                  : displayedTimelineHeight() + (event.key === 'ArrowUp' ? step : -step));
              }}
            >
              <div
                class="absolute left-0 right-0 top-px h-px transition-colors group-hover:bg-primary"
                classList={{ 'bg-primary': resizing() }}
              />
            </div>
          </Show>
        </div>
      </Show>
      <Show when={uiVisible()}>
        <div class="min-w-0 overflow-hidden" style={{ visibility: mediaVisible() && !speechOpen() ? 'visible' : 'hidden' }}><Layers /></div>
        <div class="bg-border-strong" />
      </Show>
      <Show when={uiVisible()}>
        <Timeline />
      </Show>
      <Show when={uiVisible()}>
        <div class="bg-border-strong" />
        <Show when={!timelineMinimized()}>
          <div class="min-w-0 overflow-hidden" style={{ visibility: inspectorVisible() && !speechOpen() ? 'visible' : 'hidden' }}><Soundboard /></div>
        </Show>
      </Show>
      <Show when={!uiVisible() && !import.meta.env.VITE_PURECUT}>
        <FloatingProjectHeader />
      </Show>
    </div>
    </div>
    </div>
  );
}
