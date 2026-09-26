import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { ProjectStatus } from '../apps/web/src/components/canvas/project-status';

export async function checkProjectStatus() {
  const host = document.createElement('div');
  document.body.append(host);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal('');
  let retries = 0;
  let timelineKeys = 0;
  host.addEventListener('keydown', () => timelineKeys++);
  const dispose = render(() => <ProjectStatus loading={loading()} error={error()} onRetry={() => retries++} />, host);
  const check = (value: unknown, message: string) => { if (!value) throw Error(message); };
  try {
    check(host.querySelector('[role="status"]')?.textContent === 'Opening project...', 'opening state is accessible');
    setLoading(false);
    setError('Source has a syntax error');
    check(host.querySelector('[role="alert"]')?.textContent?.includes('Source has a syntax error'), 'failed project exposes persistent detail');
    const retry = host.querySelector('button')!;
    retry.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    check(timelineKeys === 0, 'recovery controls cannot invoke timeline deletion');
    retry.click();
    check(retries === 1, 'retry invokes the current load action');
    setLoading(true);
    check(retry.disabled, 'retry is disabled during an active retry');
    setError('');
    setLoading(false);
    check(!host.textContent && !host.querySelector('button'), 'successful load removes the recovery overlay');
  } finally { dispose(); host.remove(); }
}
