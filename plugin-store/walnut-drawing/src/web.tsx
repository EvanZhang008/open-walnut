import { useCallback, useEffect, useRef } from 'react'
import type { AppProps, DrawingViewProps, SessionAppProps, WalnutWebApi } from '@open-walnut/plugin-api/web'

export function activate(walnut: WalnutWebApi): void {
  const DrawingView = walnut.ui.views.DrawingView
  const sharing = new Map<string, symbol>()

  function DrawingIcon({ size = 18 }: { size?: number }) {
    return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m4 17 2-6L17 2l5 5-12 11-6 1zM6 11l4 7M15 4l5 5M3 22h18" /></svg>
  }

  function Editor(props: DrawingViewProps) {
    const sharingToken = useRef(Symbol('drawing-view'))
    const latestTask = useRef(props.taskId)
    latestTask.current = props.taskId
    const latestState = useRef(props.onState)
    latestState.current = props.onState
    const onState = useCallback((state: Parameters<NonNullable<DrawingViewProps['onState']>>[0]) => {
      latestState.current?.(state)
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
    return <DrawingView {...props} onState={onState} />
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
