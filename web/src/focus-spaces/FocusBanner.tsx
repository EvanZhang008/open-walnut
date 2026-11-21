/**
 * One line at the top of Home's task list while the person is in a focus: its name, how many
 * open tasks wait outside, and Leave. The list under it shows only the focus (MainPage.tsx).
 */
import { useMemo, useState } from 'react'
import type { Task } from '@open-walnut/core'
import { useTaskListSelect } from '@/contexts/TasksContext'
import { leaveFocus } from './focus-store'
import { useFocusView } from './useFocusView'
import { outsideCounts, untilWords } from './focus-model'

const NO_TASKS: readonly Task[] = []

export function FocusBanner() {
  const view = useFocusView()
  const tasks = useTaskListSelect(({ tasks: list }) => list) ?? NO_TASKS
  const [busy, setBusy] = useState(false)
  const outside = useMemo(() => (view ? outsideCounts(tasks, view.inScope) : null), [view, tasks])
  if (!view || !outside) return null
  const leave = () => {
    if (busy) return
    setBusy(true)
    void leaveFocus().catch(() => { /* the rail's popover shows a failure on its own Leave */ }).finally(() => setBusy(false))
  }
  return (
    <div className="focus-banner" role="status" data-testid="focus-banner">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
        <circle cx="12" cy="12" r="8" />
        <circle cx="12" cy="12" r="3.5" />
      </svg>
      <span className="focus-banner-text">
        <span className="focus-banner-name">{view.active.name}</span>
        <span className="focus-banner-detail">
          {view.active.until ? ` · ${untilWords(view.active.until)}` : ''}
          {` · ${outside.open} outside`}
        </span>
      </span>
      <button type="button" className="btn btn-sm" disabled={busy} onClick={leave} data-testid="focus-banner-leave">Leave</button>
    </div>
  )
}
