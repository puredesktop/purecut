/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { toast } from 'somoto';
import { Show, createEffect, createMemo } from 'solid-js';
import { useNavigate } from '@solidjs/router';
import { EditorPage } from './editor';
import { LayoutProvider } from "@/context/layout";
import { PromptInputProvider } from "@/context/prompt-input";
import { EditorApiProvider } from '@/dapi';
import { ExportProvider } from '@/context/export';
import { ProjectProvider } from '@/context/project';
import { projectRoute, useProjectRef } from '@/hooks/use-project-route';
import { createProjectResolution } from '@/projects/resolution';
import { ProjectStatus } from '@/components/canvas/project-status';
import { updateCurrentWorkspaceTab } from '@purescience/platform-ui/bridge/workspace.mjs';
import { TimelineProvider } from '@/context/timeline';
import { EngineProvider } from '@/engine';

/** `/projects/*ref` — the editor, with the project `ref` names loaded. */
export function ProjectPage() {
  const ref = useProjectRef();
  const navigate = useNavigate();

  // The ref the project was found for. Rewriting the URL to the id below
  // changes the ref without changing the project, so the lookup is held on
  // what it already answered rather than run again — refetching would tear
  // the editor down and build it back for the project already in it.
  let resolvedId = '';
  const target = createMemo<string>((previous) => {
    const next = ref();
    return previous && next === resolvedId ? previous : next;
  }, '');

  // Which folder that is, is main's to answer: the URL carries the project's
  // id, and the folder it names can be renamed out from under the link.
  const resolution = createProjectResolution(target);
  const project = resolution.project;

  // The id is the project's address. A URL that named the folder (a link from
  // before ids, a bookmark from before a rename) is swapped for the canonical
  // one, so the next rename leaves it alone.
  createEffect(() => {
    const id = project()?.id;
    if (!id) return;
    resolvedId = id;
    if (import.meta.env.VITE_PURECUT) void updateCurrentWorkspaceTab({ resource: {path: project()!.dir, name: project()!.displayName, kind: 'folder'} }).then(result => { if (!result.updated) throw Error('Could not bind the video to this tab'); }).catch(error => toast.error('Could not remember this video in the workspace', { description: error.message }));
    if (id !== ref()) navigate(projectRoute(id), { replace: true });
  });

  return (
    /**
     * keyed so the engine provider is remounted when the project changes —
     * on the project, not on its folder: renaming one must not tear down the
     * world the user is working in.
     */
    <>
    <ProjectStatus loading={resolution.loading()} error={resolution.error()} onRetry={resolution.retry} />
    <Show when={!resolution.loading()}>
      <Show when={project()} keyed>
        {(found) => (
          <ProjectProvider project={found}>
            <EngineProvider projectId={found.id}>
              <EditorApiProvider>
                <TimelineProvider>
                  <ExportProvider>
                    <PromptInputProvider>
                      <LayoutProvider>
                        <EditorPage />
                      </LayoutProvider>
                    </PromptInputProvider>
                  </ExportProvider>
                </TimelineProvider>
              </EditorApiProvider>
            </EngineProvider>
          </ProjectProvider>
        )}
      </Show>
    </Show>
    </>
  )
}
