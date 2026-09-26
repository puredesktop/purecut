import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { createProjectResolution } from '../apps/web/src/projects/resolution';
import { ProjectStatus } from '../apps/web/src/components/canvas/project-status';
import type { ProjectInfo } from '../apps/web/src/projects/host';

export async function checkProjectResolution() {
  const host = document.createElement('div');
  document.body.append(host);
  const [ref, setRef] = createSignal('first');
  const pending: { ref: string; resolve: (value: ProjectInfo | null) => void; reject: (error: Error) => void }[] = [];
  let resolution!: ReturnType<typeof createProjectResolution>;
  const dispose = render(() => {
    resolution = createProjectResolution(ref, value => new Promise((resolve, reject) => pending.push({ ref: value, resolve, reject })));
    return <ProjectStatus loading={resolution.loading()} error={resolution.error()} onRetry={resolution.retry} />;
  }, host);
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  const check = (value: unknown, message: string) => { if (!value) throw Error(message); };
  try {
    check(host.querySelector('[role="status"]'), 'Lookup must show loading before the editor mounts');
    pending[0]!.reject(Error('Folder is offline'));
    await tick();
    check(host.querySelector('[role="alert"]')?.textContent?.includes('Folder is offline'), 'Lookup failure must retain its reason');
    host.querySelector('button')!.click();
    resolution.retry();
    check(pending.length === 2, 'Retry starts only one lookup');
    check(host.querySelector('[role="status"]'), 'Retry must show progress');
    pending[1]!.resolve(null);
    await tick();
    check(host.textContent?.includes('could not be found'), 'Missing project must not silently redirect');
    host.querySelector('button')!.click();
    setRef('second');
    const second = { id: 'second', dir: '/second.cut' } as ProjectInfo;
    pending[3]!.resolve(second);
    await tick();
    pending[2]!.reject(Error('Superseded failure'));
    await tick();
    check(resolution.project() === second && !resolution.error(), 'Old lookup must not replace the new project');
    check(!host.textContent, 'Successful lookup removes status');
  } finally { dispose(); host.remove(); }
}
