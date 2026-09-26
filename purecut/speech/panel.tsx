import './panel.css'
import { getEditHistory } from '@/engine/history'
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  untrack,
  Show,
} from 'solid-js'
import {
  Computed,
  FrameRate,
  setPlayhead,
  waveformAsset,
} from '@diffusionstudio/runtime'
import { toast } from 'somoto'
import { useEngineContext } from '@/engine'
import { Button } from '@/components/ui/button'
import { Icon } from '@/components/ui/icon'
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
  type SpeechScene,
} from './editor'
import { loadTranscript, saveTranscript, speechSourcePath } from './store'
import {
  fillerSuggestions,
  pauseCuts,
  frameRanges,
  selectedPassages,
  searchTranscript,
  subtract,
  timelineWords,
  type Range,
  type Transcript,
} from './model'
import {
  speechOpen,
  setSpeechOpen,
  speechReview,
  setSpeechReview,
  reviewSpeech,
  applySpeechReview,
} from './review'

export function SpeechPanel() {
  const engine = useEngineContext()
  const [snapshot, setSnapshot] = createSignal<SpeechScene | null>(null)
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
  const [previewing, setPreviewing] = createSignal(false),
    [stale, setStale] = createSignal(false)
  let controller: AbortController | undefined,
    stopPreview: (() => void) | undefined,
    generation = 0,
    anchor: string | undefined
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
    await applySpeechCuts(snapshot()!, chosenRanges())
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
    setStale(false)
    setAvailability(await speechAvailability())
    await flushPendingProjectEdits()
    const next = speechScene()
    const data = await loadTranscript(next)
    if (revision !== generation) return
    assertCurrent(next)
    setSnapshot(next)
    setTranscript(data)
  }
  createEffect(() => {
    if (speechOpen()) untrack(() => void run(refresh))
    else {
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
  const propose = (cuts: Range[], title: string, highlightName?: string) => {
    const state = snapshot()
    if (!state) throw Error('Load a speech scene first.')
    assertCurrent(state)
    const normalized = frameRanges(
      cuts,
      state.world.get(FrameRate)?.value ?? 30,
      state.end,
    )
    if (!normalized.length && highlightName === undefined)
      throw Error('No matching words or pauses found.')
    reviewSpeech({ snapshot: state, cuts: normalized, title, highlightName })
  }
  const chosenRanges = () => selectedPassages(words(), new Set(selected()))
  const makeHighlight = () => {
    const selectedRanges = selectedPassages(words(), new Set(selected()))
    if (!selectedRanges.length) throw Error('Select words for the highlight.')
    propose(
      subtract({ start: 0, end: snapshot()!.end }, selectedRanges),
      'Create a highlight',
      'Highlight',
    )
  }
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
        <Show when={error()}>
          <p role="alert" class="text-sm text-destructive mb-2">
            {error()}
          </p>
        </Show>
        <Show when={stale()}>
          <p role="status" class="text-sm mb-2">
            The timeline changed. Refresh the transcript before editing.
          </p>
        </Show>
        <Show when={!transcript()}>
          <div class="cut-transcription-start">
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
            <div class="flex flex-wrap gap-3 text-xs mb-2 items-center">
              <label>
                <input
                  type="checkbox"
                  checked={repeats()}
                  onChange={e => setRepeats(e.currentTarget.checked)}
                />{' '}
                Include possible repetitions
              </label>
              <Button
                variant="ghost"
                onClick={() =>
                  void run(async () => {
                    setSelected(suggestions().map(w => w.key))
                    propose(suggestions(), 'Review filler words')
                  })
                }
              >
                Review {suggestions().length} filler suggestions
              </Button>
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
                variant="ghost"
                onClick={() =>
                  void run(async () => {
                    const state = snapshot()!
                    setMessage('Analyzing the recording’s audio…')
                    const wave = await waveformAsset(state.asset)
                    assertCurrent(state)
                    propose(
                      pauseCuts(
                        wave.silences,
                        clips(state),
                        words(),
                        minimum(),
                        retain(),
                      ),
                      'Shorten pauses',
                    )
                  })
                }
              >
                Review pauses
              </Button>
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
              <span class="text-xs text-muted-foreground">{selected().length ? `${selected().length} words selected` : 'Click to seek · Drag to select'}</span>
              <Button disabled={!selected().length || !!speechReview()} onClick={cutSelection}>Cut selection</Button>
              <Button variant="ghost" disabled={!selected().length} onClick={() => void run(async () => makeHighlight())}>Create highlight</Button>
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
          {proposal => (
            <div
              class="border-t border-border pt-2 mt-2 flex flex-wrap items-center gap-2"
              role="group"
              aria-label="Review speech edit"
            >
              <span class="text-sm">
                <Show when={proposal().captions} fallback={<>
                {proposal().title}: {proposal().cuts.length} cuts ·{' '}
                {proposal()
                  .cuts.reduce((n, r) => n + r.end - r.start, 0)
                  .toFixed(1)}{' '}
                seconds removed
                </>}>
                  Generate captions from the saved transcript. Existing captions in this scene will be replaced; Undo restores them.
                </Show>
              </span>
              <Show when={!proposal().captions}>
              <details class="w-full text-xs">
                <summary>Adjust cut boundaries</summary>
                <div class="max-h-28 overflow-y-auto">
                  <For each={proposal().cuts}>
                    {(cut, index) => (
                      <div class="flex items-center gap-2 my-1">
                        <span>Cut {index() + 1}</span>
                        <For each={['start', 'end'] as const}>
                          {edge => (
                            <label>
                              {edge}{' '}
                              <input
                                aria-label={`Cut ${
                                  index() + 1
                                } ${edge} seconds`}
                                type="number"
                                min="0"
                                step="0.0333333333"
                                class="w-24 rounded border bg-background p-1"
                                value={cut[edge]}
                                onChange={e => {
                                  stopPreview?.()
                                  const next = proposal().cuts.map((r, i) =>
                                    i === index()
                                      ? {
                                          ...r,
                                          [edge]: e.currentTarget.valueAsNumber,
                                        }
                                      : r,
                                  )
                                  setSpeechReview({ ...proposal(), cuts: next })
                                }}
                              />
                            </label>
                          )}
                        </For>
                        <Button
                          variant="ghost"
                          onClick={() =>
                            setSpeechReview({
                              ...proposal(),
                              cuts: proposal().cuts.filter(
                                (_, i) => i !== index(),
                              ),
                            })
                          }
                        >
                          Keep this section
                        </Button>
                      </div>
                    )}
                  </For>
                </div>
              </details>
              <Button
                variant="outline"
                disabled={busy()}
                onClick={() =>
                  void run(async () => {
                    if (previewing()) {
                      stopPreview?.()
                      return
                    }
                    setPreviewing(true)
                    try {
                      stopPreview = previewCuts(
                        proposal().snapshot,
                        proposal().cuts,
                        () => setPreviewing(false),
                      )
                    } catch (e) {
                      setPreviewing(false)
                      throw e
                    }
                  })
                }
              >
                {previewing() ? 'Stop preview' : 'Preview result'}
              </Button>
              </Show>
              <Button
                disabled={busy()}
                onClick={() =>
                  void run(async () => {
                    stopPreview?.()
                    await applySpeechReview(proposal())
                    if (proposal().highlightName !== undefined)
                      toast('Highlight scene created', {
                        description:
                          'Select the new scene on the canvas to edit or export it.',
                      })
                    setSpeechReview(null)
                    await refresh()
                  })
                }
              >
                Apply edit
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  stopPreview?.()
                  setSpeechReview(null)
                }}
              >
                Discard
              </Button>
            </div>
          )}
        </Show>
      </section>
    </Show>
  )
}
