import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { ExportRecap } from '../apps/web/src/components/sidebar-right/inspector/export';

export function checkExportRecap() {
  const host = document.createElement('div');
  document.body.append(host);
  const [settings, setSettings] = createSignal<{ width: number; height: number; fps?: number; format: 'webm' | 'mov' | 'ogg'; videoEnabled?: boolean; scope: string }>({ width: 1920, height: 1080, fps: 24, format: 'webm', scope: 'Opening shot' });
  const dispose = render(() => <ExportRecap {...settings()} />, host);
  const check = (value: unknown, message: string) => { if (!value) throw Error(message); };
  try {
    const summary = () => host.querySelector('[aria-label="Export summary"]')!;
    check(summary().textContent?.includes('1920×1080'), 'recap must include output dimensions');
    check(summary().textContent?.includes('24 FPS'), 'recap must include frame rate');
    check(summary().textContent?.includes('WEBM'), 'recap must include format');
    check(summary().textContent?.includes('Scene: Opening shot'), 'recap must include the selected scene scope');
    setSettings({ width: 1080, height: 1920, fps: 60, format: 'mov', scope: 'Closing shot' });
    check(summary().textContent?.includes('1080×1920 · 60 FPS · MOV · Scene: Closing shot'), 'recap must follow current inspector settings');
    setSettings({ width: 1920, height: 1080, fps: 24, format: 'ogg', scope: 'Opening shot' });
    check(summary().textContent === 'OGG · Scene: Opening shot', 'audio-only recap must omit dimensions and frame rate');
    setSettings({ width: 1920, height: 1080, fps: 24, format: 'webm', videoEnabled: false, scope: 'Opening shot' });
    check(summary().textContent === 'WEBM · Scene: Opening shot', 'recap must omit dimensions and frame rate when video is disabled');
  } finally {
    dispose();
    host.remove();
  }
}
