import { createResource, type Accessor } from 'solid-js';
import { resolveProject, type ProjectInfo } from './host';

export function createProjectResolution(
  ref: Accessor<string>,
  resolve: (ref: string) => Promise<ProjectInfo | null> = resolveProject,
) {
  const [result, { refetch }] = createResource(ref, async value => {
    try {
      const project = await resolve(value);
      return { project, error: project ? '' : 'This project could not be found. Check that its folder is available, then retry.' };
    } catch (error) {
      return { project: null, error: error instanceof Error ? error.message : String(error) };
    }
  });
  return {
    project: () => result()?.project,
    loading: () => result.loading,
    error: () => result.loading ? '' : result()?.error,
    retry: () => { if (!result.loading) void refetch(); },
  };
}
