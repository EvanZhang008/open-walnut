import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AppProps, DrawingActivity, DrawingViewProps, SessionAppProps, WalnutWebApi } from '@open-walnut/plugin-api/web'
import { NARRATION_CSS, NarrationControl, useRecorderState } from './narration/NarrationControl'
import { NarrationRecorder, openBrowserMic } from './narration/recorder'
import type { TakeData } from './narration/take'

export function activate(walnut: WalnutWebApi): void {
  const DrawingView = walnut.ui.views.DrawingView
  const sharing = new Map<string, symbol>()
  // Recording a walkthrough (the drawing_narration experiment): off, the editor is as it was.
  const useExperimental = walnut.ui.useExperimental ?? (() => false)
  let narrationCss = false

  async function saveTake(path: string, take: TakeData): Promise<void> {
    const res = await walnut.http.fetch('/api/drawings/narration', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path, take }), timeoutMs: 30_000,
    })
    if (res.ok) return
    let message = `HTTP ${res.status}`
    try { message = (await res.json<{ error?: string }>()).error ?? message } catch { /* not JSON */ }
    throw new Error(message)
  }

  function newRecorder(): NarrationRecorder {
    return new NarrationRecorder({
      transcribe: async (wav, signal) => {
        if (!walnut.stt) throw new Error('This Walnut version has no speech to text for plugins')
        return walnut.stt.transcribe(wav, { format: 'wav', signal })
      },
      save: saveTake,
      openMic: openBrowserMic,
      now: () => Date.now(),
      warn: (message, data) => walnut.log.warn(message, data),
    })
  }

  function DrawingIcon({ size = 18 }: { size?: number }) {
    return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m4 17 2-6L17 2l5 5-12 11-6 1zM6 11l4 7M15 4l5 5M3 22h18" /></svg>
  }

  function Editor(props: DrawingViewProps) {
    const narrationOn = useExperimental('drawing_narration') && !!walnut.stt
    const recorder = useMemo(newRecorder, [])
    // The drawing file shown (from the editor's state): a take is kept beside it.
    const [shownPath, setShownPath] = useState<string | null>(null)
    useEffect(() => () => recorder.dispose(), [recorder])
    // Another drawing, or the switch turned off: a take in progress stops and is saved where it began.
    useEffect(() => { if (!narrationOn) void recorder.stop() }, [narrationOn, recorder])
    // The file shown changed, told at once: the same drawing renamed or moved keeps its take
    // (the take follows it); another drawing, or none, ends the take where it began.
    const latestPathChange = useRef(props.onDocumentPathChange)
    latestPathChange.current = props.onDocumentPathChange
    const lastPath = useRef<string | null>(null)
    const onDocumentPathChange = useCallback((path: string | null, change?: { renamedFrom?: string }) => {
      latestPathChange.current?.(path, change)
      const before = lastPath.current
      lastPath.current = path
      if (path && change?.renamedFrom) recorder.retarget(path)
      else if (path !== before && recorder.recording) void recorder.stop()
      setShownPath(path)
    }, [recorder])
    // The canvas reports steps only while a take runs (it does no work otherwise).
    const recording = useRecorderState(recorder).phase === 'recording'
    useEffect(() => {
      if (!narrationOn || narrationCss) return
      narrationCss = true
      walnut.ui.injectCss(NARRATION_CSS)
    }, [narrationOn])
    const onActivity = useCallback((a: DrawingActivity) => recorder.activity(a), [recorder])
    const sharingToken = useRef(Symbol('drawing-view'))
    const latestTask = useRef(props.taskId)
    latestTask.current = props.taskId
    const latestState = useRef(props.onState)
    latestState.current = props.onState
    const onState = useCallback((state: Parameters<NonNullable<DrawingViewProps['onState']>>[0]) => {
      latestState.current?.(state)
      setShownPath(state.path)
      const taskId = latestTask.current
      if (!taskId) return
      sharing.set(taskId, sharingToken.current)
      void walnut.appState.publish(taskId, { ...state, text: state.text.slice(0, 12_000) }, {
        label: 'Drawing',
        note: 'The editable drawing open beside this task. This is a summary: look at it with walnut_drawing_render, read ids and revision with walnut_drawing_read, change it with walnut_drawing_update. Unsaved means the person is still editing.',
      }).catch((error: unknown) => walnut.log.warn('The drawing summary could not be shared', { error: String(error), taskId }))
    }, [])
    useEffect(() => {
      const taskId = props.taskId
      return () => {
        if (taskId && sharing.get(taskId) === sharingToken.current) {
          sharing.delete(taskId)
          void walnut.appState.clear(taskId).catch((error: unknown) => walnut.log.warn('The drawing summary could not be cleared', { error: String(error), taskId }))
        }
      }
    }, [props.taskId])
    if (!DrawingView) return <div role="status">This Walnut version has no Drawing editor. Update Walnut to open this app.</div>
    const narration = narrationOn
      ? { onDocumentPathChange, barExtra: <NarrationControl recorder={recorder} path={shownPath} />, ...(recording ? { onActivity } : {}) }
      : {}
    return <DrawingView {...props} onState={onState} {...narration} />
  }

  function App(props: AppProps) {
    const params = new URLSearchParams(props.search)
    const latestRoute = useRef(props)
    latestRoute.current = props
    const onDocumentPathChange = useCallback((path: string | null) => {
      const route = latestRoute.current
      const next = new URLSearchParams(route.search)
      if ((next.get('path') ?? null) === path) return
      if (path) next.set('path', path)
      else next.delete('path')
      const query = next.toString()
      route.navigate(`${route.basePath}${query ? `?${query}` : ''}`, { replace: true })
    }, [])
    return <Editor documentPath={params.get('path') ?? undefined} taskId={params.get('taskId') ?? undefined} sessionId={params.get('sessionId') ?? undefined} onDocumentPathChange={onDocumentPathChange} />
  }

  function SessionPane(props: SessionAppProps) {
    return <Editor sessionId={props.sessionId} taskId={props.taskId} documentPath={props.documentPath} onClose={props.onClose} onDocumentPathChange={props.onDocumentPathChange} />
  }

  walnut.ui.app({ id: 'main', title: 'Drawing', icon: DrawingIcon, component: App, sessionPane: SessionPane, fullBleed: true })
}
