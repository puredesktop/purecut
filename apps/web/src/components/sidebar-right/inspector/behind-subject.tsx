/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { For, Show, createMemo } from "solid-js";
import type { JSX } from "solid-js";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuGroupLabel,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { Kbd } from "@/components/ui/kbd";
import { PanelSection } from "@/components/ui/panel-section";
import { useWorld } from "@diffusionstudio/koota-solid";
import { AssetId, Tool, ToolType, isText } from "@diffusionstudio/runtime";
import { useDerived, useEditor } from "@/engine/hooks";
import { isEditLocked } from "@/engine/locking";
import {
  behindSubjectOf,
  clearBehindSubject,
  cutOutBy,
  sceneHasVideo,
  setBehindSubject,
  subjectChoices,
} from "@/engine/object-mask";
import { objectMaskName } from "./object-mask";

import type { Entity } from "koota";
import type { SubjectChoice } from "@/engine/object-mask";

type BehindSubjectSettingsProps = {
  selection: Entity[];
};

/** A subject's choices, by clip: what the menu lists under each clip's name. */
type ClipGroup = { clip: Entity; name: string; choices: SubjectChoice[] };

const choiceKey = (choice: SubjectChoice) => `${choice.clip.id()}:${choice.id}:${choice.source.asset.id}:${choice.source.name}`;
const sameChoices = (a: SubjectChoice[], b: SubjectChoice[]) =>
  a.length === b.length && a.every((choice, i) => choiceKey(choice) === choiceKey(b[i]!));

/**
 * Behind subject (PureCut): puts the selected text, or any layer, behind a
 * person or object tracked in a video clip of its scene, so the subject
 * stands in front of it for the whole shot. It is the layer's `opacity`
 * effect with an inverted mask that follows the clip (see `uses.tsx`), so
 * the effects list shows it too; here it is one choice and one way off.
 * With nothing tracked yet, the section says how to track the subject.
 * Hidden when the scene has no video to track one in.
 */
export function BehindSubjectSettings(props: BehindSubjectSettingsProps) {
  const world = useWorld();
  const editor = useEditor();
  const node = () => props.selection[0]!;
  const noun = () => (isText(node()) ? "text" : "layer");

  const choices = useDerived(() => subjectChoices(world, node()), sameChoices);
  const hasVideo = useDerived(() => sceneHasVideo(world, node()));
  const locked = useDerived(() => isEditLocked(node()));

  // The current subject: which mask, which clip, and whether that clip is still there.
  const current = useDerived(
    () => {
      const behind = behindSubjectOf(world, node());
      if (!behind) return null;
      const assetId = behind.mask.get(AssetId)?.value ?? "";
      return {
        mask: behind.mask,
        name: objectMaskName(world, behind.mask),
        clip: behind.clip,
        clipName: choices().find((choice) => choice.clip === behind.clip)?.clipName ?? null,
        // The clip cut out to the same subject leaves nothing behind the layer.
        cutOut: behind.clip ? cutOutBy(behind.clip, { asset: { id: assetId } }) : null,
      };
    },
    (a, b) => a === b || (!!a && !!b && a.mask === b.mask && a.name === b.name && a.clip === b.clip && a.clipName === b.clipName && a.cutOut === b.cutOut),
  );

  const groups = createMemo<ClipGroup[]>(() => {
    const byClip = new Map<Entity, ClipGroup>();
    for (const choice of choices()) {
      let group = byClip.get(choice.clip);
      if (!group) byClip.set(choice.clip, (group = { clip: choice.clip, name: choice.clipName, choices: [] }));
      group.choices.push(choice);
    }
    return [...byClip.values()];
  });

  const pick = (choice: SubjectChoice) => {
    const mask = setBehindSubject(world, node(), choice);
    if (mask) editor.select(node());
  };

  const turnOff = () => clearBehindSubject(world, node());

  /** The Object mask tool, aimed at the scene's clips: the way to track a subject. */
  const openTool = () => world.set(Tool, { value: ToolType.OBJECT_MASK });

  const SubjectMenu = (menuProps: { trigger: (triggerProps: object) => JSX.Element }) => (
    <DropdownMenu placement="bottom-start">
      <DropdownMenuTrigger as={menuProps.trigger} />
      <DropdownMenuPortal>
        <DropdownMenuContent class="max-h-[min(var(--kb-popper-content-available-height),275px)] min-w-52">
          <For each={groups()}>
            {(group, index) => (
              <>
                <Show when={index() > 0}>
                  <DropdownMenuSeparator />
                </Show>
                <DropdownMenuGroup>
                  <DropdownMenuGroupLabel class="truncate">{group.name}</DropdownMenuGroupLabel>
                  <For each={group.choices}>
                    {(choice) => (
                      <DropdownMenuItem onSelect={() => pick(choice)}>{choice.source.name}</DropdownMenuItem>
                    )}
                  </For>
                </DropdownMenuGroup>
              </>
            )}
          </For>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={openTool}>
            <span class="flex-1">Track another subject</span>
            <Kbd>M</Kbd>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenuPortal>
    </DropdownMenu>
  );

  return (
    <Show when={hasVideo() || current()}>
      <PanelSection title="Behind subject">
        <Show
          when={current()}
          fallback={
            <Show
              when={choices().length > 0}
              fallback={
                <div class="cut-inspector-note" data-behind-subject-empty>
                  <p>
                    Put this {noun()} behind a person or object in the video, so they stand in front of it for the whole shot.
                  </p>
                  <p class="text-muted-foreground">
                    First track them: pick the Object mask tool <Kbd>M</Kbd>, click them in the video, then Confirm.
                  </p>
                  <div>
                    <Button variant="secondary" class="gap-1 pl-1" disabled={locked()} onClick={openTool}>
                      <Icon name="object-mask" />
                      Object mask tool
                    </Button>
                  </div>
                </div>
              }
            >
              <SubjectMenu
                trigger={(triggerProps) => (
                  <button
                    {...triggerProps}
                    type="button"
                    disabled={locked()}
                    class="flex h-7 w-full min-w-0 cursor-default items-center gap-2 overflow-clip rounded-md bg-input p-1 pr-2 text-xs text-muted-foreground transition-colors hover:bg-input/80 disabled:opacity-50 disabled:hover:bg-input"
                  >
                    <div class="flex size-5 shrink-0 items-center justify-center overflow-clip rounded-sm bg-secondary text-foreground">
                      <Icon name="plus-add" />
                    </div>
                    <span class="min-w-0 flex-1 truncate text-left">Put behind a subject</span>
                  </button>
                )}
              />
            </Show>
          }
        >
          {(subject) => (
            <>
              <SubjectMenu
                trigger={(triggerProps) => (
                  <div
                    {...triggerProps}
                    role="button"
                    tabIndex={0}
                    aria-label={`Behind ${subject().name}, change subject`}
                    class="flex h-7 w-full min-w-0 cursor-default items-center gap-2 overflow-clip rounded-md bg-input p-1 pr-0 text-xs transition-colors hover:bg-input/80"
                  >
                    <div class="flex size-5 shrink-0 items-center justify-center overflow-clip rounded-sm bg-primary text-foreground">
                      <Icon name="object-mask" />
                    </div>
                    <span class="min-w-0 flex-1 truncate text-foreground">
                      {subject().name}
                      <Show when={subject().clipName}>
                        <span class="text-muted-foreground"> in {subject().clipName}</span>
                      </Show>
                    </span>
                    <Tooltip>
                      <TooltipTrigger
                        as={Button}
                        size="icon"
                        variant="ghost"
                        class="text-muted-foreground"
                        disabled={locked()}
                        onPointerDown={(event: PointerEvent) => event.stopPropagation()}
                        onClick={(event: MouseEvent) => {
                          event.stopPropagation();
                          turnOff();
                        }}
                      >
                        <Icon name="close-remove-small" />
                      </TooltipTrigger>
                      <TooltipContent>Bring the {noun()} to the front</TooltipContent>
                    </Tooltip>
                  </div>
                )}
              />
              <Show when={!subject().clip}>
                <p class="cut-inspector-note text-destructive" role="status">
                  The clip this subject was tracked in is gone, so the {noun()} is in front again.
                </p>
              </Show>
              <Show when={subject().cutOut}>
                {(cutOut) => (
                  <div class="cut-inspector-note" role="status">
                    <p class="text-muted-foreground">
                      The clip is cut out to this subject, so nothing of its background is left behind the {noun()}.
                    </p>
                    <div>
                      <Button variant="secondary" onClick={() => editor.remove(cutOut())}>
                        Show the background
                      </Button>
                    </div>
                  </div>
                )}
              </Show>
            </>
          )}
        </Show>
      </PanelSection>
    </Show>
  );
}
