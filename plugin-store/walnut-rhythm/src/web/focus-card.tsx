/**
 * The focus block card: a task picker and two Start buttons while idle, a live
 * countdown while a block or break runs, and the three choices once a block ends.
 */
import { useEffect, useState } from 'react'
import type { WalnutWebApi } from '@open-walnut/plugin-api/web'
import { countdownText, focusPhaseText } from './format'
import type { RhythmPublicState, RhythmStore } from './store'

interface TaskOption {
  id: string
  title: string
  project?: string
}

/** How many open tasks the picker offers: enough to find today's, few enough to scan. */
const PICKER_LIMIT = 15

export function useServerNow(store: RhythmStore, live: boolean): number {
  const [now, setNow] = useState(() => store.serverNow())
  useEffect(() => {
    setNow(store.serverNow())
    if (!live) return
    const timer = window.setInterval(() => setNow(store.serverNow()), 1000)
    return () => window.clearInterval(timer)
  }, [store, live])
  return now
}

function useOpenTasks(walnut: WalnutWebApi, wanted: boolean) {
  const [tasks, setTasks] = useState<TaskOption[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!wanted) return
    let live = true
    setError(null)
    const query = `completion=todo,in_progress&sort=updated_desc&limit=${PICKER_LIMIT}&fields=list`
    walnut.http.fetch(`/api/tasks?${query}`, { timeoutMs: 10_000 })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Tasks did not load (HTTP ${response.status})`)
        const body = await response.json<{ tasks?: Array<{ id?: unknown; title?: unknown; project?: unknown }> }>()
        const list = (body.tasks ?? [])
          .filter((task) => typeof task.id === 'string' && typeof task.title === 'string')
          .slice(0, PICKER_LIMIT)
          .map((task) => ({ id: task.id as string, title: task.title as string, ...(typeof task.project === 'string' && task.project ? { project: task.project } : {}) }))
        if (live) setTasks(list)
      })
      .catch((failure: unknown) => { if (live) setError(failure instanceof Error ? failure.message : String(failure)) })
    return () => { live = false }
  }, [walnut, wanted, attempt])
  return { tasks, error, retry: () => setAttempt((n) => n + 1) }
}

export interface FocusCardProps {
  walnut: WalnutWebApi
  store: RhythmStore
  state: RhythmPublicState
  run(localOp: string, args?: Record<string, unknown>): void
  busy: boolean
}

export function FocusCard({ walnut, store, state, run, busy }: FocusCardProps) {
  const { focus, config } = state
  const running = focus.phase === 'focus' || focus.phase === 'break'
  const now = useServerNow(store, running)
  const [taskId, setTaskId] = useState<string | null>(null)
  const picker = useOpenTasks(walnut, focus.phase === 'idle')
  const remaining = focus.endsAt ? Math.max(0, focus.endsAt - now) : 0
  const short = config.focusMinutes
  const long = Math.min(180, config.focusMinutes * 2)
  const start = (minutes: number) => run('focus_start', { minutes, ...(taskId ? { taskId } : {}) })
  const blockNumber = focus.phase === 'focus' ? focus.completedInCycle + 1 : focus.completedInCycle

  return (
    <section className="rhythm-card rhythm-focus" data-testid="rhythm-focus-card" data-phase={focus.phase}>
      <header className="rhythm-card-head">
        <h2>Focus block</h2>
        <span className="rhythm-pill" data-testid="rhythm-focus-phase">{focusPhaseText(focus.phase, focus.breakKind)}</span>
      </header>

      {focus.phase === 'idle' && (
        <>
          <p className="rhythm-muted">Pick what the block is for, then start. Walnut stays quiet until it ends.</p>
          <div className="rhythm-picker" role="radiogroup" aria-label="Task for this focus block" data-testid="rhythm-task-picker">
            <button
              type="button"
              role="radio"
              aria-checked={taskId === null}
              className={`rhythm-option${taskId === null ? ' rhythm-option-on' : ''}`}
              data-testid="rhythm-task-option-none"
              onClick={() => setTaskId(null)}
            >
              <span className="rhythm-option-title">No task</span>
            </button>
            {picker.tasks?.map((task) => (
              <button
                key={task.id}
                type="button"
                role="radio"
                aria-checked={taskId === task.id}
                className={`rhythm-option${taskId === task.id ? ' rhythm-option-on' : ''}`}
                data-testid={`rhythm-task-option-${task.id}`}
                title={task.title}
                onClick={() => setTaskId(task.id)}
              >
                <span className="rhythm-option-title">{task.title}</span>
                {task.project && <span className="rhythm-option-meta">{task.project}</span>}
              </button>
            ))}
            {picker.tasks === null && !picker.error && <p className="rhythm-muted rhythm-pad">Loading tasks…</p>}
            {picker.tasks?.length === 0 && <p className="rhythm-muted rhythm-pad">No open tasks.</p>}
            {picker.error && (
              <p className="rhythm-error rhythm-pad">
                {picker.error}{' '}
                <button type="button" className="rhythm-link-button" onClick={picker.retry}>Try again</button>
              </p>
            )}
          </div>
          <div className="rhythm-actions">
            <button type="button" className="rhythm-button rhythm-primary" disabled={busy} data-testid="rhythm-focus-start-short" onClick={() => start(short)}>
              Start ({short})
            </button>
            {long !== short && (
              <button type="button" className="rhythm-button" disabled={busy} data-testid="rhythm-focus-start-long" onClick={() => start(long)}>
                Start ({long})
              </button>
            )}
          </div>
        </>
      )}

      {running && (
        <div className="rhythm-running">
          <div className="rhythm-countdown" data-testid="rhythm-focus-countdown" aria-live="off">{countdownText(remaining)}</div>
          <p className="rhythm-focus-title" data-testid="rhythm-focus-title">
            {focus.phase === 'focus' ? (focus.title ?? 'No task') : 'Stand up and move.'}
          </p>
          {focus.phase === 'focus' && (
            <p className="rhythm-muted">Block {blockNumber} of {focus.longBreakEvery} before the long break.</p>
          )}
          <div className="rhythm-actions">
            {focus.phase === 'break' && (
              <button type="button" className="rhythm-button" disabled={busy} data-testid="rhythm-break-skip" onClick={() => run('break_skip')}>End break</button>
            )}
            <button type="button" className="rhythm-button" disabled={busy} data-testid="rhythm-focus-stop" onClick={() => run('focus_stop')}>Stop</button>
          </div>
        </div>
      )}

      {focus.phase === 'break_due' && (
        <div className="rhythm-running">
          <p className="rhythm-focus-title">{focus.title ? `Done: ${focus.title}` : 'Block done.'} Time to stand up.</p>
          <div className="rhythm-actions">
            <button type="button" className="rhythm-button rhythm-primary" disabled={busy} data-testid="rhythm-break-start" onClick={() => run('break_start')}>
              Start {focus.breakKind === 'long' ? `long break (${config.longBreakMinutes})` : `break (${config.breakMinutes})`}
            </button>
            <button type="button" className="rhythm-button" disabled={busy} data-testid="rhythm-break-skip" onClick={() => run('break_skip')}>Skip break</button>
            <button
              type="button"
              className="rhythm-button"
              disabled={busy}
              data-testid="rhythm-focus-again"
              onClick={() => run('focus_start', { ...(focus.taskId ? { taskId: focus.taskId } : {}), ...(focus.minutes ? { minutes: focus.minutes } : {}) })}
            >
              Another block
            </button>
          </div>
        </div>
      )}
    </section>
  )
}
