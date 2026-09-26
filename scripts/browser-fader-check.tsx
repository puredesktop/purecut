import { createSignal } from 'solid-js';
import { render } from 'solid-js/web';
import { VolumeControl } from '../apps/web/src/components/sidebar-right/soundboard/volume-meter';

export async function checkFaders() {
  const host = document.createElement('div');
  document.body.append(host);
  const [volume, setVolume] = createSignal(0);
  const [disabled, setDisabled] = createSignal(false);
  const dispose = render(() => <VolumeControl volume={volume()} disabled={disabled()} label="Fixture volume" onVolumeChange={setVolume} />, host);
  const slider = host.querySelector<HTMLElement>('[role="slider"]')!;
  const key = (key: string, shiftKey = false) => slider.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }));
  const check = (value: unknown, message: string) => { if (!value) throw Error(message); };
  slider.setPointerCapture = () => {};
  slider.getBoundingClientRect = () => ({ top: 0, height: 200 } as DOMRect);
  const down = (pointerId = 1, button = 0) => slider.dispatchEvent(new PointerEvent('pointerdown', { pointerId, button, clientY: 100, bubbles: true }));
  const move = (clientY: number, pointerId = 1) => window.dispatchEvent(new PointerEvent('pointermove', { pointerId, clientY }));
  try {
    key('ArrowUp'); check(volume() === 1, 'arrow key adjusts volume one decibel');
    key('ArrowDown', true); check(volume() === -9, 'shift key provides coarse adjustment');
    key('PageUp'); check(volume() === -3, 'page key adjusts by six decibels');
    key('End'); key('ArrowUp'); check(volume() === 60, 'fader clamps at upper bound');
    key('Home'); key('ArrowDown'); check(volume() === -60, 'fader clamps at lower bound');
    slider.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    check(volume() === 0 && slider.getAttribute('aria-valuetext') === '0 dB', 'double click resets unity gain with accessible value');
    down(); move(0, 2); check(volume() === 0, 'unrelated pointers cannot alter active drag');
    move(50); check(volume() === 30, 'pointer position maps to gain');
    window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1 }));
    move(0); check(volume() === 30, 'pointer cancellation stops volume updates');
    down(); setDisabled(true); setDisabled(false); move(0);
    check(volume() === 0, 'disabling mid-drag detaches the gesture');
    setDisabled(true); key('ArrowUp'); down();
    check(volume() === 0 && slider.tabIndex === -1, 'disabled fader rejects keyboard and pointer changes');
    setDisabled(false); down();
    window.dispatchEvent(new Event('blur')); move(0);
    check(volume() === 0, 'window blur ends the drag');
    down(1, 2); move(0); check(volume() === 0, 'secondary button does not begin a drag');
    down(); dispose(); move(0); check(volume() === 0, 'unmount removes drag listeners');
  } finally { dispose(); host.remove(); }
}
