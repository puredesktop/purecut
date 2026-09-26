/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createContext, createSignal, onMount, onCleanup, useContext, type Accessor, type JSX } from 'solid-js';
import { assert } from '@/utils';
import { createStoredSignal } from '@/lib/store';
import { store } from '@/init';

type LayoutContextValue = {
  uiVisible: Accessor<boolean>;
  timelineMinimized: Accessor<boolean>;
  timelineHeight: Accessor<number>;
  inspectorVisible: Accessor<boolean>;
  mediaVisible: Accessor<boolean>;
  toggleMedia(): void;
  toggleInspector(): void;
  setTimelineHeight(height: number): void;
  toggleUI(): void;
  toggleTimeline(): void;
};

const LayoutContext = createContext<LayoutContextValue>();

export const MIN_TIMELINE_HEIGHT = 120;
export const DEFAULT_TIMELINE_HEIGHT = 234;

export function LayoutProvider(props: { children: JSX.Element }) {
  const [width, setWidth] = createSignal(window.innerWidth);
  const [compactPanel, setCompactPanel] = createSignal<'media' | 'inspector' | null>(null);
  const compact = () => !!import.meta.env.VITE_PURECUT && width() < 1000;
  onMount(() => {
    const resized = () => setWidth(window.innerWidth);
    window.addEventListener('resize', resized);
    onCleanup(() => window.removeEventListener('resize', resized));
  });
  const [uiVisible, setUiVisible] = createStoredSignal(
    store.define<boolean>('layout.uiVisible', true),
  );

  const [timelineHeight, setTimelineHeight] = createStoredSignal(
    store.define<number>('layout.timelineHeight', DEFAULT_TIMELINE_HEIGHT),
  );
  const [timelineMinimized, setTimelineMinimized] = createStoredSignal(
    store.define<boolean>('layout.timelineMinimized', false),
  );

  const toggleUI = () => setUiVisible(!uiVisible());
  const [inspectorPreferred, setInspectorVisible] = createStoredSignal(
    store.define<boolean>('layout.inspectorVisible', true),
  );
  const inspectorVisible = () => compact() ? compactPanel() === 'inspector' : inspectorPreferred();
  const toggleInspector = () => compact()
    ? setCompactPanel(compactPanel() === 'inspector' ? null : 'inspector')
    : setInspectorVisible(!inspectorPreferred());
  const [mediaPreferred, setMediaVisible] = createStoredSignal(
    store.define<boolean>('layout.mediaVisible', true),
  );
  const mediaVisible = () => compact() ? compactPanel() === 'media' : mediaPreferred();
  const toggleMedia = () => compact()
    ? setCompactPanel(compactPanel() === 'media' ? null : 'media')
    : setMediaVisible(!mediaPreferred());
  const toggleTimeline = () => setTimelineMinimized(!timelineMinimized());

  return (
    <LayoutContext.Provider
      value={{
        uiVisible,
        inspectorVisible,
        mediaVisible,
        toggleMedia,
        toggleInspector,
        timelineMinimized,
        timelineHeight,
        setTimelineHeight,
        toggleUI,
        toggleTimeline,
      }}>
      {props.children}
    </LayoutContext.Provider>
  );
}

export function useLayout() {
  const ctx = useContext(LayoutContext);
  assert(ctx, 'useLayout must be used within LayoutProvider');
  return ctx;
}
