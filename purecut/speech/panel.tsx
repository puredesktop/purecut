import './panel.css'
import { getEditHistory } from '@/engine/history'
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Index,
  Match,
  onCleanup,
  Switch,
  untrack,
  Show,
} from 'solid-js'
import {
  Computed,
  FrameRate,
  Name,
  setPlayhead,
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
  sceneNames,
  type SpeechScene,
} from './editor'
import { loadTranscript, saveTranscript, speechSourcePath } from './store'
import { findAssetSilences } from './silences'
import {
  cleanSceneName,
  cutContent,
  cutContexts,
  cutWarning,
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
  /** 'all' while the whole result plays, or the index of the cut being heard. */
  const [previewing, setPreviewing] = createSignal<'all' | number | null>(null),
    [stale, setStale] = createSignal(false),
    [boundaryError, setBoundaryError] = createSignal('')
  let controller: AbortController | undefined,
    stopPreview: (() => void) | undefined,
    generation = 0,
    anchor: string | undefined,
    focusName = false
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
                        const silences = await findAssetSilences(state.asset)
                        assertCurrent(state)
                        propose(
                          pauseCuts(silences, clips(state), words(), minimum(), retain()),
                          'Shorten pauses',
                          {
                            pause: {
                              minimum: minimum(),
                              retain: retain(),
                              silences: timelineSilences(silences, clips(state)),
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
                          <Show when={cutWarning(item(), contentOf(item()))}>
                            {warning => (
                              <p class={warning().tone === 'warning' ? 'cut-review-warning' : 'cut-review-caution'}>
                                {warning().text}
                              </p>
                            )}
                          </Show>
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
