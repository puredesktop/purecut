import { render } from 'solid-js/web';
import { LayoutProvider, useLayout } from '../apps/web/src/context/layout';

export async function checkResponsiveLayout() {
  const host = document.createElement('div');
  document.body.append(host);
  const descriptor = Object.getOwnPropertyDescriptor(window, 'innerWidth');
  const width = (value: number) => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value });
    window.dispatchEvent(new Event('resize'));
  };
  let layout!: ReturnType<typeof useLayout>;
  const ReadLayout = () => { layout = useLayout(); return null; };
  width(1280);
  const dispose = render(() => <LayoutProvider><ReadLayout /></LayoutProvider>, host);
  const check = (value: unknown, message: string) => { if (!value) throw Error(message); };
  try {
    await Promise.resolve();
    const originalMedia = layout.mediaVisible();
    const originalInspector = layout.inspectorVisible();
    width(640);
    check(!layout.mediaVisible() && !layout.inspectorVisible(), 'narrow workspace initially reserves room for preview');
    layout.toggleMedia();
    check(layout.mediaVisible() && !layout.inspectorVisible(), 'media remains reachable in narrow mode');
    layout.toggleInspector();
    check(!layout.mediaVisible() && layout.inspectorVisible(), 'inspector replaces media instead of squeezing preview between both');
    layout.toggleInspector();
    check(!layout.inspectorVisible(), 'active compact panel can be closed');
    width(1280);
    check(layout.mediaVisible() === originalMedia && layout.inspectorVisible() === originalInspector,
      'wide workspace preferences survive compact panel use');
    width(375);
    layout.toggleMedia();
    check(layout.mediaVisible() && !layout.inspectorVisible(), 'only one panel opens at the smallest width');
  } finally {
    dispose(); host.remove();
    if (descriptor) Object.defineProperty(window, 'innerWidth', descriptor);
    else delete (window as unknown as Record<string, unknown>).innerWidth;
    window.dispatchEvent(new Event('resize'));
  }
}
