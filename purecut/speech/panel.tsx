import './panel.css'
import { getEditHistory } from '@/engine/history'
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Index,
  Match,
  Switch,
  onCleanup,
  untrack,
  Show,
} from 'solid-js'
import {
  Computed,
  FrameRate,
  Name,
  setPlayhead,
  waveformAsset,
} from '@diffusionstudio/runtime'
import type { Entity } from 'koota'
import { toast } from 'somoto'
import { useEngineContext } from '@/engine'
import { Button } from '@/components/ui/button'
import { Icon } from '@/components/ui/icon'
import {
  TextField,
  TextFieldDescription,
  TextFieldInput,
  TextFieldLabel,
} from '@/components/ui/text-field'
import { zoomToEntities } from '@/engine/camera'
import { getDocumentEditor } from '@/engine/editor'
import { flushPendingProjectEdits } from '@/projects/edits'
import {
  speechAvailability,
  transcribeSource,
  type Availability,
} from './client'
import {
  speechScene,
  clips,
  assertCurrent,
  applySpeechCuts,
  addSpeechCaptions,
  previewCuts,
  sceneNames,
  type SpeechScene,
} from './editor'
import { loadTranscript, saveTranscript, speechSourcePath } from './store'
import {
  cleanSceneName,
  cutContent,
  cutContexts,
  fillerSuggestions,
  formatSeconds,
  formatTimestamp,
  highlightExcerpt,
  highlightSceneName,
  pauseCuts,
  pauseRule,
  removedSeconds,
  SCENE_NAME_LIMIT,
  selectedPassages,
  searchTranscript,
  subtract,
  timelineSilences,
  timelineWords,
  type CutContext,
  type Range,
  type Transcript,
} from './model'
import {
  speechOpen,
  setSpeechOpen,
  speechReview,
  setSpeechReview,
  reviewSpeech,
  reviewedCuts,
  applySpeechReview,
  type SpeechReview,
} from './review'

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`
/** Long removals (highlights, agent cuts) show their first and last words. */
const excerpt = (words: { text: string }[], edge = 6) =>
  words.length > edge * 2 + 1
    ? `${words.slice(0, edge).map(w => w.text).join(' ')} … ${words.slice(-edge).map(w => w.text).join(' ')}`
    : words.map(w => w.text).join(' ')
const reviewKind = (proposal: SpeechReview) =>
  proposal.highlightName !== undefined
    ? 'highlight'
    : proposal.pause
      ? 'pauses'
      : proposal.reasons
        ? 'fillers'
        : 'cuts'

/** What the name field says under itself: the name the scene will really get. */
function HighlightNameNote(props: { proposal: SpeechReview }) {
  const source = () =>
    props.proposal.snapshot.scene.get(Name)?.value || 'the original scene'
  const typed = () => cleanSceneName(props.proposal.highlightName)
  const final = () =>
    highlightSceneName(
      props.proposal.highlightName,
      props.proposal.highlightDefault,
      sceneNames(props.proposal.snapshot.world),
    )
  return (
    <Show
      when={typed()}
      fallback={<>With no name, it will be called <strong>{final()}</strong>.</>}
    >
      <Show
        when={final() === typed()}
        fallback={<>Another scene is already called <strong>{typed()}</strong>, so this one will be <strong>{final()}</strong>.</>}
      >
        A new scene beside <strong>{source()}</strong>, which stays as it is.
      </Show>
    </Show>
  )
}

export function SpeechPanel() {
  const engine = useEngineContext()
  const [snapshot, setSnapshot] = createSignal<SpeechScene | null>(null)
  const [overrideCandidate, setOverrideCandidate] = createSignal<SpeechScene | null>(null)
  let approvedScene: SpeechScene['scene'] | undefined
  const [transcript, setTranscript] = createSignal<Transcript | null>(null)
  const [availability, setAvailability] = createSignal<Availability>({
    provider: null,
    dailyCap: 20,
    reason: 'Checking speech settings…',
  })
  const [busy, setBusy] = createSignal(false),
    [message, setMessage] = createSignal(''),
    [error, setError] = createSignal(''),
    [transcribing, setTranscribing] = createSignal(false)
  const [cloud, setCloud] = createSignal(false),
    [selected, setSelected] = createSignal<string[]>([]),
    [query, setQuery] = createSignal('')
  const [minimum, setMinimum] = createSignal(1.5),
    [retain, setRetain] = createSignal(0.3),
    [repeats, setRepeats] = createSignal(false)
  const [page, setPage] = createSignal(0)
  /** 'all' while the whole result plays, or the index of the cut being heard. */
  const [previewing, setPreviewing] = createSignal<'all' | number | null>(null),
    [stale, setStale] = createSignal(false),
    [boundaryError, setBoundaryError] = createSignal('')
  let controller: AbortController | undefined,
    stopPreview: (() => void) | undefined,
    generation = 0,
    anchor: string | undefined,
    focusName = false
  const words = createMemo(() =>
    snapshot() && transcript()
      ? timelineWords(transcript()!, clips(snapshot()!))
      : [],
  )
  const cues = createMemo(() => {
    const groups: { words: ReturnType<typeof words> }[] = []
    for (const word of words()) {
      const last = groups.at(-1), previous = last?.words.at(-1)
      if (!last || !previous || last.words.length >= 65 || previous?.speaker !== word.speaker || word.start - previous.end > 1.2)
        groups.push({ words: [word] })
      else last.words.push(word)
    }
    return groups
  })
  let documentElement: HTMLDivElement | undefined
  const captureSelection = () => {
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed || !selection.rangeCount || !documentElement) return
    const range = selection.getRangeAt(0)
    if (!documentElement.contains(range.startContainer) || !documentElement.contains(range.endContainer)) return
    setSelected(Array.from(documentElement.querySelectorAll<HTMLElement>('[data-speech-key]'))
      .filter(element => range.intersectsNode(element))
      .map(element => element.dataset.speechKey!))
    documentElement.focus({ preventScroll: true })
  }
  const cutSelection = () => void run(async () => {
    if (!selected().length || stale() || speechReview()) return
    await applySpeechCuts(snapshot()!, selectionCuts())
    window.getSelection()?.removeAllRanges()
    await refresh()
    documentElement?.focus()
  })
  const handleKey = (event: KeyboardEvent) => {
    event.stopPropagation()
    if ((event.target as HTMLElement).closest('input, textarea')) return
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault()
      void run(async () => {
        setSpeechReview(null)
        const history = getEditHistory(engine.world)
        event.shiftKey ? history.redo() : history.undo()
        await refresh()
      })
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault()
      cutSelection()
    } else if (event.key === 'Escape') {
      setSelected([])
      window.getSelection()?.removeAllRanges()
    }
  }
  const matches = createMemo(() => searchTranscript(words(), query()))
  const suggestions = createMemo(() => fillerSuggestions(words(), repeats()))
  const currentTime = () => {
    engine.frame()
    return (
      (snapshot()?.scene.isAlive()
        ? snapshot()!.scene.get(Computed)?.localTime ?? 0
        : 0) / (engine.world.get(FrameRate)?.value ?? 30)
    )
  }
  const run = async (fn: () => Promise<void>) => {
    if (busy()) return
    setBusy(true)
    setError('')
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
      setMessage('')
    }
  }
  const refresh = async () => {
    const revision = ++generation
    stopPreview?.()
    controller?.abort()
    setSelected([])
    setPage(0)
    anchor = undefined
    setTranscript(null)
    setSnapshot(null)
    setOverrideCandidate(null)
    setStale(false)
    setAvailability(await speechAvailability())
    await flushPendingProjectEdits()
    let next: SpeechScene
    try {
      next = speechScene()
    } catch (originalError) {
      let candidate: SpeechScene
      try { candidate = speechScene({ keepOtherLayers: true }) }
      catch { throw originalError }
      if (!candidate.keptLayers.length) throw originalError
      if (approvedScene !== candidate.scene) {
        approvedScene = undefined
        setOverrideCandidate(candidate)
        throw originalError
      }
      next = candidate
    }
    const data = await loadTranscript(next)
    if (revision !== generation) return
    assertCurrent(next)
    setSnapshot(next)
    setTranscript(data)
  }
  createEffect(() => {
    if (speechOpen()) untrack(() => void run(refresh))
    else {
      approvedScene = undefined
      controller?.abort()
      stopPreview?.()
      setSpeechReview(null)
    }
  })
  const timer = setInterval(() => {
    if (snapshot()) {
      try {
        assertCurrent(snapshot()!)
      } catch {
        setStale(true)
        if (speechOpen() && !busy() && !speechReview()) void run(refresh)
      }
    }
  }, 500)
  onCleanup(() => {
    generation++
    clearInterval(timer)
    controller?.abort()
    stopPreview?.()
    setSpeechReview(null)
  })
  const choose = (key: string, shift: boolean) => {
    const list = words(),
      index = list.findIndex(w => w.key === key),
      first = list.findIndex(w => w.key === anchor)
    if (shift && first >= 0)
      setSelected(
        list
          .slice(Math.min(first, index), Math.max(first, index) + 1)
          .map(w => w.key),
      )
    else {
      setSelected([key])
      anchor = key
    }
    const word = list[index]
    if (word && snapshot())
      setPlayhead(
        engine.world,
        snapshot()!.scene,
        word.start * (engine.world.get(FrameRate)?.value ?? 30),
      )
  }
  const propose = (
    cuts: Range[],
    title: string,
    detail: Pick<SpeechReview, 'highlightName' | 'highlightDefault' | 'reasons' | 'pause'> = {},
  ) => {
    const state = snapshot()
    if (!state) throw Error('Load a speech scene first.')
    assertCurrent(state)
    const normalized = reviewedCuts(state, cuts)
    if (!normalized.length && detail.highlightName === undefined)
      throw Error('No matching words or pauses found.')
    setBoundaryError('')
    reviewSpeech({ snapshot: state, cuts: normalized, title, ...detail })
  }
  const chosenRanges = () => selectedPassages(words(), new Set(selected()))
  /** Exactly what Delete or Cut selection removes. */
  const selectionCuts = () =>
    snapshot() ? reviewedCuts(snapshot()!, chosenRanges()) : []
  const selectionSummary = createMemo(() => {
    const cuts = selectionCuts()
    if (!cuts.length) return ''
    return [
      plural(selected().length, 'word'),
      `${formatTimestamp(cuts[0].start)} – ${formatTimestamp(cuts.at(-1)!.end)}`,
      formatSeconds(removedSeconds(cuts)),
      ...(cuts.length > 1 ? [`in ${cuts.length} places`] : []),
    ].join(' · ')
  })
  const pauseExplanation = createMemo(() => pauseRule(minimum(), retain()))
  const fps = () => engine.world.get(FrameRate)?.value ?? 30
  const seek = (proposal: SpeechReview, time: number) =>
    setPlayhead(engine.world, proposal.snapshot.scene, time * fps())
  const preview = (proposal: SpeechReview, target: 'all' | number) =>
    void run(async () => {
      const playing = previewing()
      stopPreview?.()
      if (playing === target) return
      const cut = typeof target === 'number' ? proposal.cuts[target] : undefined
      setPreviewing(target)
      try {
        // A single cut plays two seconds either side, with every cut in
        // that stretch skipped, as it will sound once applied.
        stopPreview = previewCuts(
          proposal.snapshot,
          proposal.cuts,
          () => setPreviewing(null),
          cut ? { start: cut.start - 2, end: cut.end + 2 } : undefined,
        )
      } catch (e) {
        setPreviewing(null)
        throw e
      }
    })
  const editBoundary = (
    proposal: SpeechReview,
    index: number,
    edge: 'start' | 'end',
    input: HTMLInputElement,
  ) => {
    stopPreview?.()
    const next = proposal.cuts.map((r, i) =>
      i === index ? { ...r, [edge]: input.valueAsNumber } : r,
    )
    try {
      // Merged and frame-aligned as Apply would, so the list never shows a
      // cut that Apply would change.
      setSpeechReview({ ...proposal, cuts: reviewedCuts(proposal.snapshot, next) })
      setBoundaryError('')
    } catch {
      input.value = String(+proposal.cuts[index][edge].toFixed(3))
      setBoundaryError(`Cut ${index + 1} must end after it starts. Its ${edge} was not changed.`)
    }
  }
  const keepSection = (proposal: SpeechReview, index: number) => {
    stopPreview?.()
    setSpeechReview({ ...proposal, cuts: proposal.cuts.filter((_, i) => i !== index) })
  }
  const makeHighlight = () => {
    const chosen = new Set(selected())
    const selectedRanges = selectedPassages(words(), chosen)
    if (!selectedRanges.length) throw Error('Select words for the highlight.')
    const name = highlightExcerpt(words().filter(w => chosen.has(w.key)))
    // Only a highlight the person asked for here takes the focus.
    focusName = true
    try {
      propose(
        subtract({ start: 0, end: snapshot()!.end }, selectedRanges),
        'Create a highlight',
        { highlightName: name, highlightDefault: name },
      )
    } finally {
      queueMicrotask(() => { focusName = false })
    }
  }
  /**
   * A new highlight sits beside its source on the canvas. Select it and frame
   * both, so the person sees where it went; the source stays active and
   * unchanged until they choose to open the highlight.
   */
  const showHighlight = (source: SpeechScene, created: { scene: Entity; name: string }) => {
    const editor = getDocumentEditor(source.world)
    editor.select(created.scene)
    requestAnimationFrame(() => requestAnimationFrame(() =>
      zoomToEntities(source.world, [source.scene, created.scene].filter(e => e.isAlive()))))
    toast('Highlight created', {
      description: `${created.name} is selected beside ${
        source.scene.get(Name)?.value || 'the original scene'
      }, which is unchanged. Undo removes it.`,
      action: {
        label: 'Open',
        onClick: () => {
          if (!created.scene.isAlive()) return
          editor.activate(created.scene)
          editor.select(created.scene)
        },
      },
    })
  }
  const applyReview = () =>
    void run(async () => {
      const proposal = speechReview()
      if (!proposal) return
      stopPreview?.()
      const created = await applySpeechReview(proposal)
      setSpeechReview(null)
      if (created) showHighlight(proposal.snapshot, created)
      await refresh()
    })
  const transcribe = async () => {
    const state = snapshot()
    if (!state) return
    const available = await speechAvailability()
    setAvailability(available)
    controller = new AbortController()
    setTranscribing(true)
    try {
      const data = await transcribeSource(
        speechSourcePath(state),
        state.asset.id,
        available,
        cloud(),
        controller.signal,
        setMessage,
      )
      controller.signal.throwIfAborted()
      assertCurrent(state)
      await saveTranscript(state, data)
      setTranscript(data)
    } finally {
      setTranscribing(false)
      controller = undefined
    }
  }
  return (
    <Show when={speechOpen()}>
      <section
        aria-label="Speech editing"
        class="cut-speech-panel bg-sidebar"
        data-keyboard-scope="transcript"
        on:keydown={handleKey}
      >
        <div class="cut-transcript-header flex items-center gap-2">
          <strong class="text-sm">Transcript</strong>
          <span class="flex-1" />
          <Button
            variant="ghost"
            disabled={busy()}
            onClick={() => void run(refresh)}
          >
            Refresh
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Close transcript"
            onClick={() => setSpeechOpen(false)}
          >
            <Icon name="close-remove-small" class="size-4" />
          </Button>
        </div>
        <p class="cut-transcript-help">{transcript() ? 'Select text and press Delete to cut the video. ⌘/Ctrl Z to undo.' : 'Turn speech into text you can edit.'}</p>
        <Show when={error() && (snapshot() || transcript())}>
          <p role="alert" class="text-sm text-destructive mb-2">
            {error()}
          </p>
        </Show>
        <Show when={snapshot()?.keptLayers.length}>
          <p role="status" class="text-sm mb-2"><strong>Editing recording only.</strong> Text and graphics stay at their current times. After cutting speech, check their timing and adjust them if needed. You can undo cuts.</p>
        </Show>
        <Show when={stale()}>
          <p role="status" class="text-sm mb-2">
            The timeline changed. Refresh the transcript before editing.
          </p>
        </Show>
        <Show when={!transcript()}>
          <div class="cut-transcription-start">
          <Show when={!snapshot() && error()} fallback={<>
          <ol class="cut-transcription-steps" aria-label="Transcription steps">
            <li classList={{ 'is-current': !snapshot() }}>1 · Add recording</li>
            <li classList={{ 'is-current': !!snapshot() }}>2 · Transcribe</li>
            <li>3 · Edit text</li>
          </ol>
          <h2>{transcribing() ? 'Creating your transcript' : snapshot() ? 'Ready to transcribe' : 'Start with a recording'}</h2>
          <Show when={snapshot()} fallback={<p>Import a video or audio recording and add it to a scene. Its spoken words will appear here after transcription.</p>}>
            <div class="cut-recording-card">
              <span class="text-xs text-muted-foreground">RECORDING IN THIS SCENE</span>
              <strong>{speechSourcePath(snapshot()!).split('/').pop()}</strong>
              <span>{Math.floor(snapshot()!.asset.duration / 60)}:{String(Math.floor(snapshot()!.asset.duration % 60)).padStart(2, '0')} · {availability().provider?.label || 'Speech service needed'}</span>
            </div>
          </Show>
          <Show
            when={availability().provider}
            fallback={
              <p class="text-sm text-muted-foreground">
                {availability().reason} Open Settings → Speech to connect a service, then Refresh here. Transcription is optional; the timeline and export still work.
              </p>
            }
          >
            <p class="text-sm">
              We’ll turn the speech into a transcript. Then select words to remove that part of the video, with undo available. Your original recording stays intact.
            </p>
            <Show when={availability().provider?.kind === 'cloud'}>
              <label class="block text-sm my-2">
                <input
                  type="checkbox"
                  checked={cloud()}
                  onChange={e => setCloud(e.currentTarget.checked)}
                />{' '}
                Allow this recording to be uploaded to{' '}
                {availability().provider?.label} for transcription.
              </label>
            </Show>
            <Show when={!transcribing()}><Button
              disabled={
                !snapshot() ||
                busy() ||
                (availability().provider?.kind === 'cloud' && !cloud())
              }
              onClick={() => void run(transcribe)}
            >
              Transcribe recording
            </Button></Show>
          </Show>
          </>}>
            <h2>This scene isn’t ready for transcription</h2>
            <p role="alert">{error()}</p>
            <Show when={overrideCandidate()}>
              <p>You can edit just the recording and captions. Text and graphics will stay at their current times, so you may need to move them after cutting speech.</p>
              <Button disabled={busy()} onClick={() => void run(async () => {
                const candidate = overrideCandidate()
                if (!candidate) return
                assertCurrent(candidate)
                approvedScene = candidate.scene
                await refresh()
              })}>Edit recording only</Button>
            </Show>
            <p>Once the scene is ready, choose Refresh scene. Nothing has been uploaded or changed.</p>
            <Button disabled={busy()} onClick={() => void run(refresh)}>Refresh scene</Button>
          </Show>
          </div>
        </Show>
        <Show when={busy()}>
          <div role="status" class="text-sm">
            {message() || (transcribing() ? 'Preparing the recording…' : 'Loading transcript…')}{' '}
            <Show when={transcribing()}>
              <Button variant="ghost" onClick={() => controller?.abort()}>
                Cancel transcription
              </Button>
            </Show>
          </div>
        </Show>
        <Show when={transcript()}>
          <fieldset disabled={busy() || stale()} class="cut-transcript-body">
            <div class="cut-transcript-tools">
              <input aria-label="Find words or a topic" class="rounded border border-border bg-background p-1 text-sm"
                placeholder="Search transcript" value={query()} onInput={e => setQuery(e.currentTarget.value)} />
              <Button variant="ghost" onClick={() => void run(async () => {
                await addSpeechCaptions(snapshot()!, transcript()!)
                await refresh()
              })}>Generate captions</Button>
            </div>
            <details class="cut-cleanup">
              <summary>Clean up speech</summary>
              <div class="cut-cleanup-group">
                <div class="cut-cleanup-row">
                  <label>
                    <input
                      type="checkbox"
                      checked={repeats()}
                      onChange={e => setRepeats(e.currentTarget.checked)}
                    />{' '}
                    Include possible repetitions
                  </label>
                  <Button
                    variant="outline"
                    disabled={!suggestions().length}
                    onClick={() =>
                      void run(async () => {
                        setSelected(suggestions().map(w => w.key))
                        propose(suggestions(), 'Review filler words', {
                          reasons: Object.fromEntries(suggestions().map(w => [w.key, w.reason])),
                        })
                      })
                    }
                  >
                    {suggestions().length ? `Review ${suggestions().length} filler suggestions` : 'No filler words found'}
                  </Button>
                </div>
                <p class="cut-cleanup-rule">Each suggestion is listed with the words around it, so you can keep any that matter.</p>
              </div>
              <div class="cut-cleanup-group">
                <div class="cut-cleanup-row">
                  <label>
                    Pauses longer than{' '}
                    <input
                      aria-label="Minimum pause seconds"
                      type="number"
                      min="0.2"
                      step="0.1"
                      class="w-14 bg-background border rounded p-1"
                      value={minimum()}
                      onChange={e => setMinimum(e.currentTarget.valueAsNumber)}
                    />{' '}
                    s
                  </label>
                  <label>
                    Keep{' '}
                    <input
                      aria-label="Retained pause seconds"
                      type="number"
                      min="0"
                      step="0.1"
                      class="w-14 bg-background border rounded p-1"
                      value={retain()}
                      onChange={e => setRetain(e.currentTarget.valueAsNumber)}
                    />{' '}
                    s
                  </label>
                  <Button
                    variant="outline"
                    disabled={!pauseExplanation().valid}
                    onClick={() =>
                      void run(async () => {
                        const state = snapshot()!
                        setMessage('Listening for pauses in the recording…')
                        const wave = await waveformAsset(state.asset)
                        assertCurrent(state)
                        propose(
                          pauseCuts(wave.silences, clips(state), words(), minimum(), retain()),
                          'Shorten pauses',
                          {
                            pause: {
                              minimum: minimum(),
                              retain: retain(),
                              silences: timelineSilences(wave.silences, clips(state)),
                            },
                          },
                        )
                      })
                    }
                  >
                    Review pauses
                  </Button>
                </div>
                <p class="cut-cleanup-rule" classList={{ 'is-invalid': !pauseExplanation().valid }} role={pauseExplanation().valid ? undefined : 'alert'}>
                  {pauseExplanation().text}
                </p>
              </div>
            </details>
            <Show when={query()}>
              <div class="text-xs mb-2">
                <For each={matches().slice(0, 20)}>
                  {match => (
                    <Button
                      variant="ghost"
                      onClick={() => setSelected(match.map(w => w.key))}
                    >
                      {match.map(w => w.text).join(' ')}
                    </Button>
                  )}
                </For>
                <Show when={!matches().length}>
                  No matching passages. The drawer agent can search the full
                  transcript for broader topics.
                </Show>
              </div>
            </Show>
            <div
              ref={documentElement}
              class="cut-transcript-words"
              role="document"
              tabIndex={0}
              aria-label="Transcript words"
              onMouseUp={captureSelection}
              onKeyUp={captureSelection}
            >
              <For each={cues().slice(page() * 30, (page() + 1) * 30)}>
                {cue => (
                  <p class="cut-transcript-paragraph">
                    <span class="cut-speaker">
                      {Math.floor(cue.words[0].start / 60)}:{String(Math.floor(cue.words[0].start % 60)).padStart(2, '0')} · {' '}
                      {cue.words[0].speaker
                        ? transcript()!.speakers[cue.words[0].speaker!] ||
                          `Speaker ${[...new Set(words().map(w => w.speaker))].indexOf(cue.words[0].speaker) + 1}`
                        : 'Speaker'}
                    </span>
                    <For each={cue.words}>
                      {raw => {
                        const word = raw as ReturnType<typeof words>[number]
                        return (
                          <>
                          <span
                            data-speech-key={word.key}
                            class="cut-transcript-word"
                            classList={{ 'is-selected': selected().includes(word.key),
                              'is-playing': currentTime() >= word.start && currentTime() < word.end }}
                            onClick={e => {
                              if (window.getSelection()?.isCollapsed !== false) choose(word.key, e.shiftKey)
                              documentElement?.focus({ preventScroll: true })
                            }}
                          >{word.text}</span>{' '}
                          </>
                        )
                      }}
                    </For>
                  </p>
                )}
              </For>
            </div>
            <Show when={cues().length > 30}>
              <div class="flex gap-2 text-xs items-center">
                <Button
                  variant="ghost"
                  disabled={page() === 0}
                  onClick={() => setPage(p => p - 1)}
                >
                  Previous words
                </Button>
                <span>
                  Page {page() + 1} of {Math.ceil(cues().length / 30)}
                </span>
                <Button
                  variant="ghost"
                  disabled={(page() + 1) * 30 >= cues().length}
                  onClick={() => setPage(p => p + 1)}
                >
                  Next words
                </Button>
              </div>
            </Show>
            <div class="cut-selection-toolbar" aria-label="Transcript selection">
              <span class="cut-selection-summary text-xs" classList={{ 'text-muted-foreground': !selectionSummary() }}>{selectionSummary() || 'Click to seek · Drag to select'}</span>
              <Button disabled={!selected().length || !!speechReview()} onClick={cutSelection}>Cut selection</Button>
              <Button variant="ghost" disabled={!selected().length || !!speechReview() || !!snapshot()?.keptLayers.length} title={snapshot()?.keptLayers.length ? "Highlights need a scene with only the recording and captions" : undefined} onClick={() => void run(async () => makeHighlight())}>Create highlight</Button>
            </div>
            <details class="text-xs mt-2">
              <summary>Speaker names</summary>
              <div class="flex gap-3 flex-wrap mt-2">
                <For
                  each={[
                    ...new Set(
                      transcript()!
                        .words.map(w => w.speaker)
                        .filter((s): s is string => !!s),
                    ),
                  ]}
                >
                  {speaker => (
                    <label>
                      {speaker}{' '}
                      <input
                        class="rounded border bg-background p-1"
                        aria-label={`Name for ${speaker}`}
                        value={transcript()!.speakers[speaker] ?? ''}
                        maxLength={100}
                        placeholder="Name"
                        onBlur={event => {
                          const name = event.currentTarget.value.trim()
                          void run(async () => {
                            const state = snapshot()!
                            assertCurrent(state)
                            const next = {
                              ...transcript()!,
                              speakers: {
                                ...transcript()!.speakers,
                                [speaker]: name,
                              },
                            }
                            await saveTranscript(state, next)
                            setTranscript(next)
                          })
                        }}
                      />
                    </label>
                  )}
                </For>
              </div>
            </details>
          </fieldset>
        </Show>
        <Show when={speechReview()}>
          {proposal => {
            const kind = () => reviewKind(proposal())
            const items = createMemo<CutContext[]>(() =>
              transcript()
                ? cutContexts(proposal().cuts, timelineWords(transcript()!, clips(proposal().snapshot)))
                : proposal().cuts.map(c => ({ ...c, duration: c.end - c.start, before: [], removed: [], trimmed: [], after: [] })),
            )
            const total = () => removedSeconds(proposal().cuts)
            const count = () => proposal().cuts.length
            const contentOf = (item: CutContext) =>
              transcript() ? cutContent(item, proposal().pause?.silences) : 'unknown'
            const reasonOf = (item: CutContext) => {
              const reasons = proposal().reasons
              if (!reasons) return contentOf(item) === 'silence' ? 'Pause' : ''
              return [...new Set(item.removed.map(w => reasons[w.key]).filter(Boolean))]
                .map(r => (r === 'Filler' ? 'Filler' : 'Possible repetition'))
                .join(' · ')
            }
            return (
              <div class="cut-review" role="group" aria-label="Review speech edit">
                <Show when={!proposal().captions} fallback={
                  <p class="cut-review-note">Generate captions from the saved transcript. Existing captions in this scene will be replaced; Undo restores them.</p>
                }>
                  <div class="cut-review-head">
                    <strong>{proposal().title}</strong>
                    <span class="cut-review-total" data-review-total>
                      {kind() === 'highlight'
                        ? `Keeps ${formatSeconds(proposal().snapshot.end - total())}`
                        : kind() === 'pauses'
                          ? `${plural(count(), 'gap')} · ${formatSeconds(total())} saved`
                          : `${plural(count(), 'cut')} · ${formatSeconds(total())} removed`}
                    </span>
                  </div>
                  <p class="cut-review-note">
                    {kind() === 'pauses'
                      ? pauseRule(proposal().pause!.minimum, proposal().pause!.retain).text
                      : kind() === 'highlight'
                        ? 'Each section below is left out of the new scene.'
                        : 'Read each cut in context. Keep any that change the meaning.'}{' '}
                    Nothing changes until you apply.
                  </p>
                  <Show when={proposal().highlightName !== undefined}>
                    <TextField
                      class="cut-highlight-name"
                      value={proposal().highlightName}
                      onChange={value => {
                        const current = speechReview()
                        if (current) setSpeechReview({ ...current, highlightName: value })
                      }}
                    >
                      <TextFieldLabel uiSize="compact">Scene name</TextFieldLabel>
                      <TextFieldInput
                        uiSize="compact"
                        maxLength={SCENE_NAME_LIMIT}
                        placeholder={proposal().highlightDefault}
                        ref={(input: HTMLInputElement) => {
                          if (!focusName) return
                          focusName = false
                          queueMicrotask(() => {
                            input.focus()
                            input.select()
                          })
                        }}
                        onKeyDown={(event: KeyboardEvent) => {
                          if (event.key !== 'Enter' || event.isComposing) return
                          event.preventDefault()
                          applyReview()
                        }}
                      />
                      <TextFieldDescription>
                        <HighlightNameNote proposal={proposal()} />
                      </TextFieldDescription>
                    </TextField>
                  </Show>
                  <Show when={boundaryError()}>
                    <p role="alert" class="cut-review-error">{boundaryError()}</p>
                  </Show>
                  <ol class="cut-review-list" aria-label="Proposed cuts">
                    <Index each={items()} fallback={<li class="cut-review-empty">No cuts left. Apply would change nothing.</li>}>
                      {(item, index) => (
                        <li class="cut-review-item" data-cut-index={index}>
                          <div class="cut-review-meta">
                            <button
                              type="button"
                              class="cut-review-time"
                              aria-label={`Go to ${formatTimestamp(item().start)}`}
                              onClick={() => seek(proposal(), item().start)}
                            >
                              {formatTimestamp(item().start)}
                            </button>
                            <Show when={reasonOf(item())}>
                              <span class="cut-review-reason">{reasonOf(item())}</span>
                            </Show>
                            <span class="flex-1" />
                            <span class="cut-review-range" data-cut-range>
                              {formatTimestamp(item().start)} – {formatTimestamp(item().end)} · {formatSeconds(item().duration)}
                            </span>
                          </div>
                          <p class="cut-review-context">
                            <Show when={item().before.length}>
                              <span class="cut-review-kept">…{item().before.map(w => w.text).join(' ')} </span>
                            </Show>
                            <Switch>
                              <Match when={contentOf(item()) === 'words'}>
                                <del class="cut-review-removed">{excerpt(item().removed)}</del>
                              </Match>
                              <Match when={contentOf(item()) === 'partial'}>
                                <del class="cut-review-removed">part of “{item().trimmed.map(w => w.text).join(' ')}”</del>
                              </Match>
                              <Match when={contentOf(item()) === 'silence'}>
                                <span class="cut-review-gap">{formatSeconds(item().duration)} of silence</span>
                              </Match>
                              <Match when={contentOf(item()) === 'untranscribed'}>
                                <span class="cut-review-gap">{formatSeconds(item().duration)} · no transcribed words</span>
                              </Match>
                              <Match when={contentOf(item()) === 'unknown'}>
                                <span class="cut-review-gap">{formatSeconds(item().duration)} · transcript not loaded</span>
                              </Match>
                            </Switch>
                            <Show when={item().after.length}>
                              <span class="cut-review-kept"> {item().after.map(w => w.text).join(' ')}…</span>
                            </Show>
                          </p>
                          <Switch>
                            <Match when={contentOf(item()) === 'partial'}>
                              <p class="cut-review-warning">
                                This cuts into a spoken word rather than between words. Adjust the boundary or keep this section.
                              </p>
                            </Match>
                            <Match when={contentOf(item()) === 'words' && item().trimmed.length}>
                              <p class="cut-review-warning">
                                Also clips the edge of “{item().trimmed.map(w => w.text).join(' ')}”. Adjust the boundary if it sounds cut off.
                              </p>
                            </Match>
                            <Match when={contentOf(item()) === 'untranscribed' || contentOf(item()) === 'unknown'}>
                              <p class="cut-review-caution">
                                Not checked against the audio. Listen before applying.
                              </p>
                            </Match>
                          </Switch>
                          <div class="cut-review-actions">
                            <Button variant="ghost" size="small" disabled={busy() && previewing() !== index} onClick={() => preview(proposal(), index)}>
                              {previewing() === index ? 'Stop' : 'Listen'}
                            </Button>
                            <Button variant="ghost" size="small" onClick={() => keepSection(proposal(), index)}>
                              Keep this section
                            </Button>
                            <details class="cut-review-adjust">
                              <summary>Adjust</summary>
                              <div class="cut-review-bounds">
                                <For each={['start', 'end'] as const}>
                                  {edge => (
                                    <label>
                                      {edge === 'start' ? 'Start' : 'End'}{' '}
                                      <input
                                        aria-label={`Cut ${index + 1} ${edge} seconds`}
                                        type="number"
                                        min="0"
                                        step={1 / fps()}
                                        class="w-24 rounded border bg-background p-1"
                                        value={+item()[edge].toFixed(3)}
                                        onChange={e => editBoundary(proposal(), index, edge, e.currentTarget)}
                                      />{' '}
                                      s
                                    </label>
                                  )}
                                </For>
                              </div>
                            </details>
                          </div>
                        </li>
                      )}
                    </Index>
                  </ol>
                </Show>
                <div class="cut-review-footer">
                  <Show when={!proposal().captions}>
                    <Button
                      variant="outline"
                      disabled={busy() && previewing() !== 'all'}
                      onClick={() => preview(proposal(), 'all')}
                    >
                      {previewing() === 'all' ? 'Stop preview' : 'Preview result'}
                    </Button>
                  </Show>
                  <span class="flex-1" />
                  <Button
                    variant="ghost"
                    onClick={() => {
                      stopPreview?.()
                      setBoundaryError('')
                      setSpeechReview(null)
                    }}
                  >
                    Discard
                  </Button>
                  <Button
                    disabled={busy() || (!proposal().captions && kind() !== 'highlight' && !count())}
                    onClick={applyReview}
                  >
                    {kind() === 'highlight' ? 'Create scene' : 'Apply edit'}
                  </Button>
                </div>
              </div>
            )
          }}
        </Show>
      </section>
    </Show>
  )
}
