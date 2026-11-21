/**
 * What the focus popover shows (FocusRail.tsx): the focus the person is in, the saved spaces to
 * enter, a space being made or changed, and, right after leaving, what waited outside.
 */
import { useMemo, useState } from 'react'
import type { Task } from '@open-walnut/core'
import { taskInScope } from '@open-walnut/focus-scope'
import { useTaskListSelect } from '@/contexts/TasksContext'
import { useOpenTask } from '@/hooks/useOpenTask'
import {
  enterFocus, leaveFocus, useFocusSnapshot, type ActiveFocus, type FocusSpace,
} from './focus-store'
import { FOCUS_LENGTHS, durationWords, outsideCounts, scopeLine, summarize, untilWords, type FocusSummary } from './focus-model'
import { SpaceForm } from './SpaceForm'

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

  return (
    <div className="focus-panel" data-testid="focus-panel">
      {active
        ? <ActiveView active={active} tasks={tasks} byId={byId} titleOf={titleOf} busy={busy} onLeave={leave}
            onEdit={active.spaceId ? () => setMode({ kind: 'form', space: spaces.find((s) => s.id === active.spaceId) }) : undefined} />
        : (
          <div className="focus-panel-head">
            <div className="focus-panel-title">Focus</div>
            <div className="focus-panel-detail">Show only the projects or tasks you pick. Everything else waits, quietly, until you leave.</div>
          </div>
        )}
      {(!active || spaces.some((s) => s.id !== active.spaceId)) && (
        <>
          <div className="focus-panel-caption">{active ? 'Switch to' : 'Your spaces'}</div>
          {spaces.length === 0 && <div className="focus-panel-empty">No spaces yet. Make one with the projects or tasks you want in front of you.</div>}
          <div className="focus-space-list" role="list">
            {spaces.filter((s) => s.id !== active?.spaceId).map((s) => (
              <div key={s.id} className="focus-space-row" role="listitem">
                <button type="button" className="focus-space-enter" disabled={busy} onClick={() => enter(s.id)} data-testid={`focus-space-${s.id}`}>
                  <span className="focus-space-name">{s.name}</span>
                  <span className="focus-space-scope">{scopeLine(s, titleOf)}</span>
                </button>
                <button type="button" className="btn btn-sm" onClick={() => setMode({ kind: 'form', space: s })} aria-label={`Edit ${s.name}`}>Edit</button>
              </div>
            ))}
          </div>
          {!active && spaces.length > 0 && (
            <div className="focus-length" role="radiogroup" aria-label="How long">
              <span className="focus-panel-caption">For</span>
              {FOCUS_LENGTHS.map((l) => (
                <button key={l.label} type="button" role="radio" aria-checked={length === l.minutes}
                  className={`btn btn-sm${length === l.minutes ? ' btn-primary' : ''}`} onClick={() => setLength(l.minutes)}>{l.label}</button>
              ))}
            </div>
          )}
        </>
      )}
      {error && <div className="focus-panel-error" role="alert">{error}</div>}
      <div className="focus-panel-actions">
        <button type="button" className="btn btn-sm" onClick={() => setMode({ kind: 'form' })} data-testid="focus-new-space">New space</button>
      </div>
    </div>
  )
}

function ActiveView({ active, tasks, byId, titleOf, busy, onLeave, onEdit }: {
  active: ActiveFocus
  tasks: readonly Task[]
  byId: ReadonlyMap<string, Task>
  titleOf(id: string): string | undefined
  busy: boolean
  onLeave(): void
  onEdit?: () => void
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
        {outside.open === 0 ? 'Nothing open outside.' : `${outside.open} open ${outside.open === 1 ? 'task waits' : 'tasks wait'} outside. You see them when you leave.`}
      </div>
      <div className="focus-panel-actions">
        <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={onLeave} data-testid="focus-leave">Leave focus</button>
        {onEdit && <button type="button" className="btn btn-sm" onClick={onEdit}>Edit space</button>}
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
          <div className="focus-space-list" role="list">
            {summary.needs.slice(0, 6).map((t) => (
              <div key={t.id} className="focus-space-row" role="listitem">
                <button type="button" className="focus-space-enter" onClick={() => { onClose(); openTask(t.id) }}>
                  <span className="focus-space-name">{t.title}</span>
                </button>
              </div>
            ))}
          </div>
          {summary.needs.length > 6 && <div className="focus-panel-empty">{`and ${summary.needs.length - 6} more on Home.`}</div>}
        </>
      )}
      <div className="focus-panel-actions">
        <button type="button" className="btn btn-sm btn-primary" onClick={onClose}>Done</button>
      </div>
    </div>
  )
}
