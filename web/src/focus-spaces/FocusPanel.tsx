/**
 * What the focus popover shows (FocusRail.tsx): the focus the person is in, the saved spaces to
 * enter, a space being made or changed, and, right after leaving, what waited outside.
 *
 * Its controls are the card family's (standard.md): option rows (`.org-answer-options .btn` with
 * its line of why in data-detail), ticks (`.org-answer-check`), and the 34 px buttons of
 * `.ask-card-answer`, one of them blue.
 */
import { useMemo, useState } from 'react'
import type { Task } from '@open-walnut/core'
import { taskInScope } from '@open-walnut/focus-scope'
import { useTaskListSelect } from '@/contexts/TasksContext'
import { useOpenTask } from '@/hooks/useOpenTask'
import { enterFocus, leaveFocus, useFocusSnapshot, type ActiveFocus, type FocusSpace } from './focus-store'
import { FOCUS_LENGTHS, durationWords, outsideCounts, outsideWords, scopeLine, summarize, untilWords, type FocusSummary } from './focus-model'
import { SpaceForm } from './SpaceForm'
import { Radio } from '@/components/controls'
import '@/components/actions/ask-card.css'
import '@/styles/inline-answer.css'

const NO_TASKS: readonly Task[] = []

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** `ended`: the focus the person just left in this window (the summary shows first). */
export function FocusPanel({ ended, onClose }: { ended: ActiveFocus | null; onClose(): void }) {
  const { active, spaces } = useFocusSnapshot()
  const tasks = useTaskListSelect(({ tasks: list }) => list) ?? NO_TASKS
  const byId = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks])
  const titleOf = (id: string) => byId.get(id)?.title
  const [mode, setMode] = useState<{ kind: 'main' } | { kind: 'form'; space?: FocusSpace }>({ kind: 'main' })
  const [length, setLength] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Outside a focus, a space row can open its form instead of entering it.
  const [editing, setEditing] = useState(false)

  const run = async (fn: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try { await fn() } catch (err) { setError(errorText(err)) } finally { setBusy(false) }
  }

  const enter = (spaceId: string) => run(async () => {
    await enterFocus({ spaceId, ...(length ? { until: Date.now() + length * 60_000 } : {}) })
    onClose()
  })

  // The rail hears the leave (FOCUS_ENDED_EVENT) and hands the ended focus back as `ended`.
  const leave = () => run(async () => { await leaveFocus() })
  const summary = useMemo<FocusSummary | null>(() => {
    if (!ended) return null
    const lookup = (id: string) => byId.get(id) ?? null
    return summarize(ended, tasks, (id) => taskInScope(ended.scope, id, lookup))
    // Taken once when the focus ends: later changes are the board's to show.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ended])

  if (mode.kind === 'form') {
    return (
      <SpaceForm
        space={mode.space}
        length={length}
        onDone={(entered) => { if (entered) onClose(); else setMode({ kind: 'main' }) }}
      />
    )
  }
  if (summary && !active) return <SummaryView summary={summary} onClose={onClose} />

  const others = spaces.filter((s) => s.id !== active?.spaceId)
  const activeSpace = active?.spaceId ? spaces.find((s) => s.id === active.spaceId) : undefined
  return (
    <div className="focus-panel" data-testid="focus-panel">
      {active
        ? <ActiveHead active={active} tasks={tasks} byId={byId} titleOf={titleOf} />
        : (
          <div className="focus-panel-head">
            <div className="focus-panel-title">Focus</div>
            <div className="focus-panel-detail">Show only the projects or tasks you pick. Everything else waits, quietly, until you leave.</div>
          </div>
        )}
      {/* The length first: a space row enters at once, so it is picked before one. */}
      {!active && !editing && others.length > 0 && (
        <>
          <div className="focus-panel-caption">Stay for</div>
          {/* The card family's option rows, each with the shared Radio; the radios' one name makes them a group. */}
          <div className="ask-card"><div className="ask-card-answer focus-length" role="group" aria-label="Stay for">
            {FOCUS_LENGTHS.map((l) => (
              <label key={l.label} className={`org-answer-check${length === l.minutes ? ' is-on' : ''}`}>
                <Radio name="focus-length" checked={length === l.minutes} onChange={() => setLength(l.minutes)} />{l.label}
              </label>
            ))}
          </div></div>
        </>
      )}
      {others.length > 0 && (
        <>
          <div className="focus-panel-caption">{active ? 'Switch to' : editing ? 'Pick a space to change' : 'Your spaces'}</div>
          <div className="ask-card-answer focus-options">
            <div className="org-answer-options" role="list">
              {others.map((s) => (
                <button key={s.id} type="button" role="listitem" className="btn btn-sm" disabled={busy}
                  data-detail={scopeLine(s, titleOf)} title={scopeLine(s, titleOf)}
                  onClick={() => (editing ? setMode({ kind: 'form', space: s }) : enter(s.id))} data-testid={`focus-space-${s.id}`}>{s.name}</button>
              ))}
            </div>
          </div>
        </>
      )}
      {!active && spaces.length === 0 && <div className="focus-panel-empty">No spaces yet. Make one with the projects or tasks you want in front of you.</div>}
      {error && <div className="focus-panel-error" role="alert">{error}</div>}
      <div className="ask-card-answer focus-actions">
        {active && <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={leave} data-testid="focus-leave">Leave focus</button>}
        {activeSpace && <button type="button" className="btn btn-sm" onClick={() => setMode({ kind: 'form', space: activeSpace })}>Edit space</button>}
        {/* In a focus: leave it or change it; a new space is made from outside one. */}
        {!active && <button type="button" className={`btn btn-sm${spaces.length === 0 ? ' btn-primary' : ''}`} onClick={() => setMode({ kind: 'form' })} data-testid="focus-new-space">New space</button>}
        {!active && others.length > 0 && (
          <span className="ask-card-tools">
            <button type="button" className="btn btn-sm" aria-pressed={editing} onClick={() => setEditing((e) => !e)} data-testid="focus-edit-spaces">
              {editing ? 'Stop editing' : 'Edit a space'}
            </button>
          </span>
        )}
      </div>
    </div>
  )
}

function ActiveHead({ active, tasks, byId, titleOf }: {
  active: ActiveFocus
  tasks: readonly Task[]
  byId: ReadonlyMap<string, Task>
  titleOf(id: string): string | undefined
}) {
  const lookup = (id: string) => byId.get(id) ?? null
  const outside = outsideCounts(tasks, (id) => taskInScope(active.scope, id, lookup))
  return (
    <div className="focus-panel-head" data-testid="focus-active">
      <div className="focus-panel-title">{active.name}</div>
      <div className="focus-panel-detail">
        {scopeLine(active.scope, titleOf)}
        {active.until ? ` · ${untilWords(active.until)}` : ''}
        {active.by === 'block' ? ' · from your focus block' : ''}
      </div>
      <div className="focus-panel-outside" data-testid="focus-outside">
        {outside.open === 0 ? 'Nothing open outside.' : `${outsideWords(outside.open)}. You see them when you leave.`}
      </div>
    </div>
  )
}

function SummaryView({ summary, onClose }: { summary: FocusSummary; onClose(): void }) {
  const openTask = useOpenTask()
  return (
    <div className="focus-panel" data-testid="focus-summary">
      <div className="focus-panel-head">
        <div className="focus-panel-title">Back from {summary.name}</div>
        <div className="focus-panel-detail">
          {`You focused for ${durationWords(summary.minutes)}. `}
          {summary.changed === 0 ? 'Nothing changed outside meanwhile.' : `${summary.changed} ${summary.changed === 1 ? 'task' : 'tasks'} outside changed meanwhile.`}
        </div>
      </div>
      {summary.needs.length > 0 && (
        <>
          <div className="focus-panel-caption">Need you now</div>
          <div className="ask-card-answer focus-options">
            <div className="org-answer-options" role="list">
              {summary.needs.slice(0, 6).map((t) => (
                <button key={t.id} type="button" role="listitem" className="btn btn-sm" data-peek-row="" onClick={() => { onClose(); openTask(t.id) }}>{t.title}</button>
              ))}
            </div>
          </div>
          {summary.needs.length > 6 && <div className="focus-panel-empty">{`and ${summary.needs.length - 6} more on Home.`}</div>}
        </>
      )}
      <div className="ask-card-answer focus-actions">
        <button type="button" className="btn btn-sm btn-primary" onClick={onClose}>Done</button>
      </div>
    </div>
  )
}
