import { render } from 'solid-js/web';
import { HashRouter, Route } from '@solidjs/router';
import { ColorModeProvider } from '@kobalte/core';
import { AuthProvider } from '../apps/web/src/context/auth';
import { ProjectProvider } from '../apps/web/src/context/project';
import { EngineProvider } from '../apps/web/src/engine';
import { EditorApiProvider } from '../apps/web/src/dapi';
import { TimelineProvider } from '../apps/web/src/context/timeline';
import { ExportProvider } from '../apps/web/src/context/export';
import { PromptInputProvider } from '../apps/web/src/context/prompt-input';
import { LayoutProvider } from '../apps/web/src/context/layout';
import { EditorPage } from '../apps/web/src/pages/editor';
import { mainBridge } from '../apps/web/src/lib/ipc';
import { DesktopTheme } from '../purecut/entry';
import { useWorld } from '@diffusionstudio/koota-solid';
import { getCameraMatrix, getActiveEntity, setPlayhead, Source, Selected } from '@diffusionstudio/runtime';
import '../apps/web/src/index.css';
import '../purecut/styles.css';
import { lightTheme } from '@purescience/platform-ui/theme/themes/light';
import { darkTheme } from '@purescience/platform-ui/theme/themes/dark';
import { themeToRootCssBlock } from '@purescience/platform-ui/theme/utils/cssVariables';
import { SourceEditReview, sourceReview } from '../purecut/edit-review';

export function showReviewFixture() {
  sourceReview.present({ dir: '/fixture/visual', baseHash: 'old', hash: 'new',
    before: '<scene name="Interview edit">\n  <text start={0} end={5}>A conversation about design</text>\n</scene>',
    source: '<scene name="Interview edit">\n  <text start={0} end={5}>Design in conversation</text>\n</scene>',
  }, async () => { throw Error('Fixture: project changed. Read the current source again.'); });
}

export const fixtureThemeCss = (mode: 'light' | 'dark') => themeToRootCssBlock(mode === 'dark' ? darkTheme : lightTheme);

const code = `const { Stage, Scene, Rect, Text } = require('@diffusionstudio/jsx');
module.exports.default = () => Stage({ __source: 'visual-stage', get children() {
  return Scene({ __source: 'visual-scene', active: true, name: 'Interview edit', width: 1280, height: 720, get children() {
    return [Rect({ __source: 'visual-background', name: 'Background', width: 1280, height: 720, end: 12, fill: '#163f41' }),
      Text({ __source: 'visual-title', name: 'Opening title', x: 100, y: 270, width: 1080, height: 150, end: 5, fontSize: 64, fontFamily: 'Arial', fill: '#ffffff', children: 'A conversation about design' }),
      Rect({ __source: 'visual-accent', name: 'Accent', x: 100, y: 445, width: 160, height: 8, start: 1, end: 12, fill: '#e2a64e' })];
  }});
}});`;

export let readFixtureCamera: () => number[];
export let prepareTrimFixture: (frame: number) => void;
function CameraProbe() {
  const world = useWorld();
  readFixtureCamera = () => [...getCameraMatrix(world)];
  prepareTrimFixture = frame => {
    for (const entity of world.query(Selected)) entity.remove(Selected);
    const title = world.query(Source).find(entity => entity.get(Source)?.value === 'visual-title');
    if (!title) throw Error('Missing fixture title');
    title.add(Selected);
    setPlayhead(world, getActiveEntity(world)!, frame);
  };
  return null;
}

export function mountEditorVisual(host: HTMLElement, mode: 'light' | 'dark' = 'light', camera?: number[]) {
  const bundle = camera ? code.replace("__source: 'visual-stage',", `__source: 'visual-stage', camera: ${JSON.stringify(camera)},`) : code;
  const project = { id: 'visual-fixture', name: 'visual-fixture', displayName: 'Interview edit', dir: '/fixture/visual', entry: 'index.tsx', createdAt: new Date().toISOString(), modifiedAt: new Date().toISOString() };
  const previousDesktop = window.desktop;
  window.desktop = { platform: 'puredesktop', on: () => () => {}, send() {}, getPathForFile: () => '' } as unknown as typeof window.desktop;
  const previousCall = mainBridge.call;
  mainBridge.call = (async (channel: string) => {
    switch (channel) {
      case 'projects:compile': return { ok: true, code: bundle };
      case 'projects:get': case 'projects:refresh': return project;
      case 'projects:manifest-read': case 'projects:config-read': return null;
      case 'window:is-fullscreen': return false;
      case 'auth:get-pending-callback': return null;
      case 'projects:fs-list': return [];
      case 'projects:watch': case 'projects:unwatch': case 'projects:cover': case 'projects:manifest-write': return undefined;
      default: throw new Error(`Visual fixture has no handler for ${channel}`);
    }
  }) as typeof mainBridge.call;
  document.documentElement.dataset.app = 'cut';
  document.documentElement.dataset.platformTheme = mode;
  const themeStyle = document.createElement('style');
  themeStyle.textContent = themeToRootCssBlock(mode === 'dark' ? darkTheme : lightTheme);
  document.head.append(themeStyle);
  host.id = 'cut-editor'; host.style.cssText = 'width:100vw;height:100vh;overflow:hidden';
  const dispose = render(() => <ColorModeProvider initialColorMode={mode}>
    <DesktopTheme />
    <SourceEditReview />
    <HashRouter><Route path="/" component={() => <AuthProvider><ProjectProvider project={project}>
      <EngineProvider projectId={project.id}><EditorApiProvider><TimelineProvider><ExportProvider><PromptInputProvider><LayoutProvider>
        <CameraProbe /><EditorPage />
      </LayoutProvider></PromptInputProvider></ExportProvider></TimelineProvider></EditorApiProvider></EngineProvider>
    </ProjectProvider></AuthProvider>} /></HashRouter>
  </ColorModeProvider>, host);
  return () => { dispose(); themeStyle.remove(); mainBridge.call = previousCall; window.desktop = previousDesktop; };
}
