import { createSignal } from 'solid-js';
import { useWorld } from '@diffusionstudio/koota-solid';
import type { Entity } from 'koota';
import type { SubtitleFormat } from '@diffusionstudio/runtime';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Select, SelectContent, SelectItem, SelectPortal, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { exportSceneSubtitles } from '@/engine/subtitle-export';

export function SubtitleExport(props: { scene: Entity }) {
  const world = useWorld();
  const [format, setFormat] = createSignal<SubtitleFormat>('srt');
  const [busy, setBusy] = createSignal(false);
  const save = async () => {
    setBusy(true);
    try { await exportSceneSubtitles(world, props.scene, format()); }
    finally { setBusy(false); }
  };
  return <div class="mt-3 border-t border-border pt-3 min-w-0 space-y-2">
    <div class="text-xs font-medium">Subtitles (work area)</div>
    <div class="grid grid-cols-[minmax(0,1fr)_auto] gap-2 min-w-0">
      <Select<SubtitleFormat> value={format()} options={['srt', 'vtt']} onChange={value => value && setFormat(value)}
        itemComponent={item => <SelectItem item={item.item}>{item.item.rawValue === 'srt' ? 'SRT' : 'WebVTT'}</SelectItem>}>
        <SelectTrigger aria-label="Subtitle format"><SelectValue>{format() === 'srt' ? 'SRT' : 'WebVTT'}</SelectValue></SelectTrigger>
        <SelectPortal><SelectContent /></SelectPortal>
      </Select>
      <Tooltip>
        <TooltipTrigger as={Button} size="icon" variant="secondary" disabled={busy()} onClick={() => void save()} aria-label="Export subtitles">
          <Icon name="download" />
        </TooltipTrigger>
        <TooltipContent>{busy() ? 'Exporting subtitles...' : 'Export subtitles'}</TooltipContent>
      </Tooltip>
    </div>
  </div>;
}
