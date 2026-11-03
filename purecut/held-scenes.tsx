import { For, Show, createMemo } from "solid-js";
import { useWorld } from "@diffusionstudio/koota-solid";
import { Name, Scene, setActive, stopPlayback } from "@diffusionstudio/runtime";
import { useActiveScene, useDerived } from "@/engine";
import { zoomToFit } from "@/engine/camera";
import { sceneChoices } from "./lib/held-rules";

/** The scenes of a held video, highlights among them. Choosing one changes what this copy shows and writes nothing. */
export function HeldScenes() {
  const world = useWorld();
  const active = useActiveScene();
  const scenes = useDerived(() => world.query(Scene).map(scene => scene), (a, b) => a.length === b.length && a.every((scene, index) => scene === b[index]));
  const choices = createMemo(() => sceneChoices(scenes().map(scene => scene.get(Name)?.value)));
  const choose = (index: number) => {
    const scene = scenes()[index];
    if (!scene) return;
    const current = active();
    if (current) stopPlayback(world, current);
    setActive(world, scene);
    requestAnimationFrame(() => zoomToFit(world));
  };
  return (
    <Show when={choices().length}>
      <div class="cut-held-scenes" role="toolbar" aria-label="Scenes">
        <For each={choices()}>
          {choice => (
            <button type="button" aria-pressed={scenes()[choice.index] === active()} title={choice.label} onClick={() => choose(choice.index)}>
              {choice.label}
            </button>
          )}
        </For>
      </div>
    </Show>
  );
}
