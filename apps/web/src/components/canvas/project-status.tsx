import { Show } from 'solid-js';
import { Button } from '../ui/button';

export function ProjectStatus(props: { loading?: boolean; error?: string; onRetry?: () => void }) {
  return <Show when={props.loading || props.error}>
    <div class="absolute top-3 left-3 right-3 z-50 rounded-md border border-border bg-background p-3 shadow-md"
      on:keydown={event => event.stopPropagation()}>
      <Show when={props.error} fallback={<p role="status">Opening project...</p>}>
        <div role="alert">
          <strong>Project could not be opened</strong>
          <p class="text-sm break-words">{props.error}</p>
        </div>
        <Button variant="outline" disabled={props.loading} onClick={() => props.onRetry?.()}>Retry opening project</Button>
      </Show>
    </div>
  </Show>;
}
