/**
 * One line at the top of Home's task list while the person is in a focus: its name, how many
 * open tasks wait outside, and Leave. The list under it shows only the focus (MainPage.tsx).
 * Right after a Leave here it shows what waited outside (what needs the person now) until Done.
 * Entering and changing spaces is in Settings > Focus (FocusSpacesSection.tsx).
 * Its × (NoticeClose) hides the line while in this focus: the list still shows only the focus, and
 * the line comes back with the next focus entered (or this one entered again).
 */
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Task } from '@open-walnut/core'
import { taskInScope } from '@open-walnut/focus-scope'
import { useTaskListSelect } from '@/contexts/TasksContext'
import { NoticeClose } from '@/components/common/NoticeClose'
import { useNoticeDismiss } from '@/utils/notice-dismiss'
import { leaveFocus, useFocusSnapshot, type ActiveFocus } from './focus-store'
import { useFocusOn, useFocusView } from './useFocusView'
import { outsideCounts, outsideWords, summarize, untilWords, type FocusSummary } from './focus-model'
import { SummaryView } from './FocusPanel'
import '@/components/actions/ask-card.css'
import '@/styles/focus-spaces.css'

const NO_TASKS: readonly Task[] = []

/** One stay in a focus: the space (or its name) and when it was entered; null once out of every focus. */
export function focusStaySignature(loaded: boolean, active: ActiveFocus | null, on: boolean): string | null | undefined {
  if (!on) return null
  if (!loaded) return undefined
  return active ? `${active.spaceId ?? active.name}@${active.since}` : null
}

export function FocusBanner() {
  const view = useFocusView()
  const tasks = useTaskListSelect(({ tasks: list }) => list) ?? NO_TASKS
  const on = useFocusOn()
  const navigate = useNavigate()
  const snap = useFocusSnapshot()
  const { hidden, dismiss } = useNoticeDismiss('focus-banner', focusStaySignature(snap.loaded, snap.active, on))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ended, setEnded] = useState<FocusSummary | null>(null)
  const outside = useMemo(() => (view ? outsideCounts(tasks, view.inScope) : null), [view, tasks])
  // A focus entered since (here or elsewhere) makes the last one's summary old news.
  const inFocus = !!view
  useEffect(() => { if (inFocus) setEnded(null) }, [inFocus])
  if (on && !view && ended) {
    return (
      <div className="focus-banner focus-banner-summary" role="status" data-testid="focus-banner-summary">
        <SummaryView summary={ended} onClose={() => setEnded(null)} />
      </div>
    )
  }
  if (!view || !outside || hidden) return null
  const leave = () => {
    if (busy) return
    setBusy(true)
    setError(null)
    // The summary is ready before the store drops the focus, so the banner never blinks out.
    const was = view.active
    const byId = new Map(tasks.map((t) => [t.id, t]))
    setEnded(summarize(was, tasks, (id) => taskInScope(was.scope, id, (x) => byId.get(x) ?? null)))
    void leaveFocus()
      .then((left: ActiveFocus | null) => { if (!left) setEnded(null) })
      .catch((err: unknown) => { setEnded(null); setError(err instanceof Error ? err.message : String(err)) })
      .finally(() => setBusy(false))
  }
  return (
    <div className="focus-banner" role="status" data-testid="focus-banner">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
        <circle cx="12" cy="12" r="8" />
        <circle cx="12" cy="12" r="3.5" fill="currentColor" />
      </svg>
      <span className="focus-banner-text">
        <span className="focus-banner-name">{view.active.name}</span>
        <span className="focus-banner-detail">
          {view.active.until ? ` · ${untilWords(view.active.until)}` : ''}
          {` · ${outsideWords(outside.open)}`}
        </span>
        {error && <span className="focus-banner-error" role="alert">{` · ${error}`}</span>}
      </span>
      <div className="ask-card-answer focus-banner-actions">
        <button type="button" className="btn btn-sm" onClick={() => navigate('/settings#focus-spaces')} title="Switch to another space or edit this one, in Settings > Focus" data-testid="focus-banner-change">Change</button>
        <button type="button" className="btn btn-sm" disabled={busy} onClick={leave} data-testid="focus-banner-leave">Leave</button>
      </div>
      <NoticeClose onClose={dismiss} label="Hide this line while in this focus" testId="focus-banner-close" className="focus-banner-close" />
    </div>
  )
}
