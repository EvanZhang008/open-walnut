/**
 * The focus block card: a task picker and the Start form (lengths, music) while Rhythm is off, and a
 * live countdown with the run's start and end while a block or its break runs. Start is
 * the only way in; the break follows the block by itself and Rhythm is off after it.
 */
import { useEffect, useState } from 'react'
import type { WalnutWebApi } from '@open-walnut/plugin-api/web'
import { countdownText, focusPhaseText, runText } from './format'
import { NowPlaying } from './now-playing'
import type { MusicPlayer } from './music'
import { StartForm } from './start-form'
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
  run(localOp: string, args?: Record<string, unknown>): Promise<boolean>
  busy: boolean
  music: MusicPlayer
}

export function FocusCard({ walnut, store, state, run, busy, music }: FocusCardProps) {
  const { focus, config } = state
  const running = focus.phase === 'focus' || focus.phase === 'break'
  const now = useServerNow(store, running)
  const [taskId, setTaskId] = useState<string | null>(null)
  // A started block whose Spotify did not play says why while it runs (the form is gone by then).
  const [spotifyError, setSpotifyError] = useState<string | null>(null)
  useEffect(() => { if (focus.phase === 'idle') setSpotifyError(null) }, [focus.phase])
  const picker = useOpenTasks(walnut, focus.phase === 'idle')
  const remaining = focus.endsAt ? Math.max(0, focus.endsAt - now) : 0
  const blockNumber = focus.phase === 'focus' ? focus.completedInCycle + 1 : focus.completedInCycle

  return (
    <section className="rhythm-block rhythm-focus" data-testid="rhythm-focus-card" data-phase={focus.phase}>
      <div className="rhythm-block-head">
        <h2>Focus block</h2>
        <span className="rhythm-pill" data-testid="rhythm-focus-phase">{focusPhaseText(focus.phase, focus.breakKind)}</span>
      </div>
      <div className="rhythm-group"><div className="rhythm-body">

      {focus.phase === 'idle' && (
        <>
          <p className="rhythm-muted" data-testid="rhythm-focus-off">
            Off. {focus.lastRun ? `${runText(focus)}. ` : ''}Pick what the block is for, how long it runs and what plays, then start.{config.focusQuietsWalnut ? ' Walnut stays quiet until it ends.' : ''}
          </p>
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
          <StartForm store={store} music={music} state={state} taskId={taskId} onStarted={(result) => setSpotifyError(result.spotifyError ?? null)} />
        </>
      )}

      {running && (
        <div className="rhythm-running">
          <div className="rhythm-countdown" data-testid="rhythm-focus-countdown" aria-live="off">{countdownText(remaining)}</div>
          <p className="rhythm-focus-title" data-testid="rhythm-focus-title">
            {focus.phase === 'focus' ? (focus.title ?? 'No task') : 'Stand up and move.'}
          </p>
          {focus.phase === 'focus' && spotifyError && <p className="rhythm-error" role="status" data-testid="rhythm-focus-spotify-error">{spotifyError}</p>}
          <p className="rhythm-muted" data-testid="rhythm-focus-run">{runText(focus)}.{focus.phase === 'break' ? ' Then Rhythm asks before the next block.' : ''}</p>
          {focus.phase === 'focus' && (
            <p className="rhythm-muted">Block {blockNumber} of {focus.longBreakEvery} before the long break.</p>
          )}
          {focus.phase === 'focus' && <NowPlaying store={store} music={music} state={state} />}
          <div className="rhythm-actions">
            {focus.phase === 'break'
              ? <button type="button" className="rhythm-button" disabled={busy} data-testid="rhythm-break-skip" onClick={() => { void run('break_skip') }}>End break</button>
              : <button type="button" className="rhythm-button" disabled={busy} data-testid="rhythm-focus-stop" onClick={() => { void run('focus_stop') }}>Stop</button>}
          </div>
        </div>
      )}

      </div></div>
    </section>
  )
}
