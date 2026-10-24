import './panel.css'
import { getEditHistory } from '@/engine/history'
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  onCleanup,
  Switch,
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
  canRetryToday,
  checkingAvailability,
  outcomeStillApplies,
  speechAvailability,
  transcribeSource,
  TranscriptionError,
  utcDay,
  type Availability,
  type PastOutcome,
  type TranscriptionFailure,
  type TranscriptionPhase,
} from './client'
import {
  SpeechSceneError,
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
  const [overrideCandidate, setOverrideCandidate] = createSignal<SpeechScene | null>(null)
  let approvedScene: SpeechScene['scene'] | undefined
  const [transcript, setTranscript] = createSignal<Transcript | null>(null)
  const [availability, setAvailability] = createSignal<Availability>(checkingAvailability())
  const [sceneProblem, setSceneProblem] = createSignal<{
    reason: SpeechSceneError['reason'] | 'transcript' | 'other'
    message: string
  } | null>(null)
  const [phase, setPhase] = createSignal<TranscriptionPhase | null>(null),
    [cancelling, setCancelling] = createSignal(false)
  // The last transcription that ended without a transcript, for this recording.
  const [outcome, setOutcome] = createSignal<{
    assetId: string
    providerId: string
    message: string
  } & PastOutcome | null>(null)
  const [busy, setBusy] = createSignal(false),
    [message, setMessage] = createSignal(''),
    [error, setError] = createSignal(''),
    [transcribing, setTranscribing] = createSignal(false)
  // Upload consent is given to one service; choosing another asks again.
  const [consentedTo, setConsentedTo] = createSignal<string | null>(null),
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
  const cloud = () =>
    !!availability().provider && consentedTo() === availability().provider!.id
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
  const openScene = (): SpeechScene => {
    try {
      return speechScene()
    } catch (originalError) {
      let candidate: SpeechScene
      try { candidate = speechScene({ keepOtherLayers: true }) }
      catch (layered) {
        // Only titles and shapes, no recording: say what is missing.
        throw layered instanceof SpeechSceneError && layered.reason === 'no-recording' ? layered : originalError
      }
      if (!candidate.keptLayers.length) throw originalError
      if (approvedScene !== candidate.scene) {
        approvedScene = undefined
        setOverrideCandidate(candidate)
        throw originalError
      }
      return candidate
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
    setSceneProblem(null)
    setAvailability(await speechAvailability())
    const problem = (reason: SpeechSceneError['reason'] | 'transcript' | 'other', e: unknown) => {
      if (revision === generation)
        setSceneProblem({ reason, message: e instanceof Error ? e.message : String(e) })
    }
    let next: SpeechScene
    try {
      await flushPendingProjectEdits()
      next = openScene()
    } catch (e) {
      return problem(e instanceof SpeechSceneError ? e.reason : 'other', e)
    }
    let data: Transcript | null
    try {
      data = await loadTranscript(next)
    } catch (e) {
      // An unreadable or damaged saved transcript: say so, never fall through
      // to a screen that looks like it is still loading.
      return problem('transcript', e)
    }
    if (revision !== generation) return
    try {
      assertCurrent(next)
    } catch (e) {
      return problem('other', e)
    }
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
    setOutcome(null)
    const available = await speechAvailability()
    setAvailability(available)
    // The service went away since the panel last looked: show why, send nothing.
    if (!available.provider) return
    // Throws before anything is sent (a recording not imported yet): the
    // panel's ordinary error line shows it.
    const path = speechSourcePath(state)
    const signal = (controller = new AbortController()).signal
    setTranscribing(true)
    setCancelling(false)
    let data: Transcript
    try {
      data = await transcribeSource(
        path,
        state.asset.id,
        available,
        cloud(),
        signal,
        setPhase,
      )
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      setOutcome({
        assetId: state.asset.id,
        providerId: available.provider.id,
        day: utcDay(new Date()),
        dailyCap: available.dailyCap,
        // Any other error came before a job started, or stopped one that the
        // client then cancelled; neither counts against today, so it may be retried.
        reason: e instanceof TranscriptionError ? e.reason : signal.aborted ? 'cancelled' : 'unavailable',
        message: e instanceof TranscriptionError || !signal.aborted
          ? message
          : 'Transcription cancelled. No transcript was saved.',
      })
      return
    } finally {
      setTranscribing(false)
      setCancelling(false)
      setPhase(null)
      controller = undefined
    }
    // Keep what was paid for: the transcript belongs to the recording, so it
    // is saved even if the scene changed meanwhile, and never asked for twice.
    try {
      await saveTranscript(state, data)
    } catch (e) {
      // Still show it, so the work is not lost; saving is tried again with
      // the next speaker-name change.
      try { assertCurrent(state); setTranscript(data) } catch {}
      throw Error(`The transcript arrived but couldn’t be saved to this project: ${e instanceof Error ? e.message : String(e)}`)
    }
    try {
      assertCurrent(state)
      setTranscript(data)
    } catch {
      await refresh()
    }
  }
  const cancelTranscription = () => {
    setCancelling(true)
    controller?.abort()
  }
  // Shown for the recording and service it happened with: choosing another
  // service in settings and checking again clears it.
  // A new day or a raised daily limit clears it too; Check again re-reads both.
  const lastOutcome = () => {
    const o = outcome(), a = availability()
    if (!o || snapshot()?.asset.id !== o.assetId) return null
    if (a.state === 'checking') return o
    return a.provider?.id === o.providerId && outcomeStillApplies(o, new Date(), a) ? o : null
  }
  const canRetry = () => {
    const reason = lastOutcome()?.reason
    return !reason || canRetryToday(reason)
  }
  const checkAgain = () => void run(refresh)
  const serviceName = () =>
    availability().provider?.label ?? availability().providerLabel ?? 'the speech service'
  const unavailableNext = () => ({
    checking: '',
    ready: '',
    disabled: 'Turn on speech editing in PureCut settings, then choose Check again.',
    'no-provider': 'Connect a transcription service in PureDesktop Settings → Speech, then choose Check again.',
    'missing-key': `${serviceName()} needs an API key. Add it in PureDesktop Settings → Speech, then choose Check again.`,
    'runtime-unreachable': `${serviceName()} isn’t responding on this computer. Start it, or choose another service in Settings → Speech, then choose Check again.`,
    'no-service': 'Speech services aren’t available here. Check again later.',
  })[availability().state]
  const unavailableShort = () => ({
    checking: '',
    ready: '',
    disabled: 'it is turned off in settings',
    'no-provider': 'no service is set up',
    'missing-key': `${serviceName()} needs an API key`,
    'runtime-unreachable': `${serviceName()} isn’t responding`,
    'no-service': 'speech services aren’t available here',
  })[availability().state]
  const phaseTitle = (current: TranscriptionPhase) => ({
    starting: 'Starting',
    waiting: 'Waiting to start',
    uploading: 'Uploading the recording',
    processing: 'Transcribing',
  })[current.phase]
  const phaseDetail = (current: TranscriptionPhase) => {
    const name = serviceName()
    if (current.phase === 'starting') return `Handing the recording to ${name}.`
    if (current.phase === 'waiting')
      return `${name} has other recordings ahead of this one. It will start on its own.`
    if (current.phase === 'uploading')
      return `Sending the audio to ${name}. Keep PureCut open until this finishes.`
    return current.progress === undefined
      ? `${name} is turning the speech into text.`
      : `${name} is turning the speech into text · ${Math.round(current.progress * 100)}% done.`
  }
  // The daily-limit and already-sent messages carry their own next step.
  const retryLater = (reason: TranscriptionFailure) =>
    reason === 'daily-cap' || reason === 'already-attempted'
      ? ''
      : `${serviceName()} can take this recording again tomorrow. To try sooner, choose another service in PureDesktop Settings → Speech, then choose Check again.`
  const recordingName = (state: SpeechScene) =>
    state.asset.source.split(/[\\/]/).pop() || 'Recording'
  const duration = (seconds: number) =>
    `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`
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
        <Show when={transcript() && availability().state !== 'ready' && availability().state !== 'checking'}>
          <p role="note" class="cut-transcription-quiet">
            New transcription is unavailable: {unavailableShort()}. This transcript, cleanup, captions and search keep working.
          </p>
        </Show>
        <Show when={!transcript()}>
          <div class="cut-transcription-start">
          <ol class="cut-transcription-steps" aria-label="Transcription steps">
            <li classList={{ 'is-current': sceneProblem()?.reason === 'no-recording' }}>1 · Add recording</li>
            <li classList={{ 'is-current': !!snapshot() }}>2 · Transcribe</li>
            <li>3 · Edit text</li>
          </ol>
          <Switch fallback={<p class="cut-transcription-quiet">Looking at this scene…</p>}>
            <Match when={sceneProblem()?.reason === 'no-recording'}>
              <h2>Start with a recording</h2>
              <p>Import a video or audio recording and add it to this scene. Its spoken words will appear here once it is transcribed.</p>
              <Button variant="outline" disabled={busy()} onClick={checkAgain}>Check scene again</Button>
            </Match>
            <Match when={sceneProblem()}>
              {problem => <>
                <h2>{problem().reason === 'unsupported' ? 'This scene can’t be transcribed as it is'
                  : problem().reason === 'transcript' ? 'The saved transcript couldn’t be opened' : 'The transcript couldn’t be opened'}</h2>
                <p role="alert">{problem().reason === 'transcript'
                  ? `The transcript saved with this recording couldn’t be read (${problem().message}). It has not been changed or replaced.`
                  : problem().message}</p>
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
                <p>{problem().reason === 'transcript'
                  ? 'Nothing has been uploaded. If it is being saved or synced right now, check again in a moment.'
                  : 'Nothing has been uploaded or changed. Once the scene is ready, check it again.'}</p>
                <Button variant={overrideCandidate() ? 'ghost' : 'outline'} disabled={busy()} onClick={checkAgain}>Check scene again</Button>
              </>}
            </Match>
            <Match when={snapshot()}>
              {state => <>
                <h2>{phase() ? 'Creating your transcript' : ['ready', 'checking'].includes(availability().state) ? 'Ready to transcribe' : 'Transcribe this recording'}</h2>
                <div class="cut-recording-card">
                  <span class="cut-recording-label">Recording in this scene</span>
                  <strong>{recordingName(state())}</strong>
                  <span>{duration(state().asset.duration)} · {availability().provider?.label ?? availability().providerLabel ?? 'No speech service'}</span>
                </div>
                <Show when={phase()} fallback={
                  <Switch>
                    <Match when={availability().state === 'checking'}>
                      <p class="cut-transcription-quiet">Checking the speech service…</p>
                    </Match>
                    <Match when={availability().state !== 'ready'}>
                      <div class="cut-transcription-problem" data-state={availability().state}>
                        <strong>{availability().state === 'disabled' ? 'Transcription is turned off' : 'Transcription isn’t available yet'}</strong>
                        <p>{unavailableNext()}</p>
                        <Button variant="outline" disabled={busy()} onClick={checkAgain}>Check again</Button>
                      </div>
                      <p class="cut-transcription-quiet">Transcription is optional. Editing and export work without it.</p>
                    </Match>
                    <Match when={availability().provider}>
                      {provider => <>
                        <Show when={lastOutcome()}>
                          {last => (
                            <Show when={last().reason !== 'cancelled'} fallback={
                              <p role="status" class="cut-transcription-quiet" data-outcome="cancelled">{last().message}</p>
                            }>
                              <div role="alert" class="cut-transcription-problem" data-outcome={last().reason}>
                                <strong>Transcription didn’t finish</strong>
                                <p>{last().message}</p>
                                <Show when={!canRetry()}>
                                  <Show when={retryLater(last().reason)}>{next => <p>{next()}</p>}</Show>
                                  <Button variant="outline" disabled={busy()} onClick={checkAgain}>Check again</Button>
                                </Show>
                              </div>
                            </Show>
                          )}
                        </Show>
                        <Show when={canRetry()}>
                          <Show when={!lastOutcome()}>
                            <p>
                              We’ll turn the speech into a transcript. Then select words to remove that part of the video, with undo available. Your original recording stays intact.
                            </p>
                          </Show>
                          <Show when={provider().kind === 'cloud'}>
                            <label class="cut-transcription-consent">
                              <input
                                type="checkbox"
                                checked={cloud()}
                                onChange={e => setConsentedTo(e.currentTarget.checked ? provider().id : null)}
                              />{' '}
                              Allow this recording to be uploaded to{' '}
                              {provider().label} for transcription.
                            </label>
                          </Show>
                          <Button
                            disabled={busy() || (provider().kind === 'cloud' && !cloud())}
                            onClick={() => void run(transcribe)}
                          >
                            {lastOutcome() && lastOutcome()!.reason !== 'cancelled' ? 'Try again' : 'Transcribe recording'}
                          </Button>
                        </Show>
                      </>}
                    </Match>
                  </Switch>
                }>
                  {current => (
                    <div class="cut-transcription-job" role="status" aria-live="polite" data-phase={current().phase}>
                      <strong>{cancelling() ? 'Cancelling…' : phaseTitle(current())}</strong>
                      <p>{phaseDetail(current())}</p>
                      <Show
                        when={current().phase === 'processing' ? (current() as { progress?: number }).progress : undefined}
                        fallback={<div class="cut-transcription-progress is-indeterminate" aria-hidden="true"><span /></div>}
                      >
                        {progress => (
                          <div class="cut-transcription-progress" role="progressbar" aria-label="Transcription progress"
                            aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress() * 100)}>
                            <span style={{ width: `${Math.round(progress() * 100)}%` }} />
                          </div>
                        )}
                      </Show>
                      <Button variant="outline" disabled={cancelling()} onClick={cancelTranscription}>
                        Cancel transcription
                      </Button>
                    </div>
                  )}
                </Show>
              </>}
            </Match>
          </Switch>
          </div>
        </Show>
        <Show when={busy() && !transcribing()}>
          <div role="status" class="text-sm">
            {message() || 'Loading transcript…'}
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
              <Button variant="ghost" disabled={!selected().length || !!snapshot()?.keptLayers.length} title={snapshot()?.keptLayers.length ? "Highlights need a scene with only the recording and captions" : undefined} onClick={() => void run(async () => makeHighlight())}>Create highlight</Button>
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
