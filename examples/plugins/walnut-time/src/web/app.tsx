import { useCallback, useEffect, useMemo, useState } from 'react'
import type { PluginLogger } from '@open-walnut/plugin-api/web'
import type { TaskRef, TimeApi, TimeSummary } from './api'
import {
  AgentsReport, MyTimeReport, NO_PROJECT, NO_TASK_LABEL, RANGES, ReportFilters, TREND_DAYS,
  daysInRange, foldRows, type KindKey, type RangeKey,
} from './reports'
import { TimeTimeline } from './timeline'

/**
 * The app shell: one page, three tabs, one data load.
 *
 * The tab lives in the URL (`/apps/walnut-time~main/timeline`), so a view is
 * linkable and the browser's back button works, and the shell stays mounted across
 * tab switches so the filters survive one.
 *
 * The shell owns exactly two fetches: the 7-day time summary the two report tabs
 * fold, and the task list that gives a task id a title and a project. The timeline
 * tab fetches its own day, because a day is its own question and switching days must
 * not re-read the week.
 */

const TABS = [
  { id: 'my-time', label: 'My time' },
  { id: 'agents', label: 'Agents' },
  { id: 'timeline', label: 'Timeline' },
] as const

type TabId = typeof TABS[number]['id']

export interface TimeAppProps {
  api: TimeApi
  log: PluginLogger
  basePath: string
  subpath: string
  navigate(path: string, options?: { replace?: boolean }): void
}

export function TimeApp({ api, log, basePath, subpath, navigate }: TimeAppProps) {
  const [tab, setTab] = useState<TabId>(() => tabFromSubpath(subpath))
  const [summary, setSummary] = useState<TimeSummary | null>(null)
  const [tasks, setTasks] = useState<TaskRef[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [range, setRange] = useState<RangeKey>('today')
  const [kind, setKind] = useState<KindKey>('all')
  const [project, setProject] = useState('')

  useEffect(() => { setTab(tabFromSubpath(subpath)) }, [subpath])

  const load = useCallback(() => {
    setLoading(true)
    // The task list is a NICE-TO-HAVE: it only supplies titles and the project
    // filter, and /api/time/blocks joins its own titles server-side. So a failure
    // there must not blank the page, only cost the reports their names.
    Promise.all([
      api.summary(TREND_DAYS),
      api.tasks().catch((err: unknown) => {
        log.warn('task list fetch failed, falling back to ids', { error: describe(err) })
        return [] as TaskRef[]
      }),
    ])
      .then(([nextSummary, nextTasks]) => {
        setSummary(nextSummary)
        setTasks(nextTasks)
        setError(null)
      })
      .catch((err: unknown) => {
        const message = describe(err)
        log.warn('summary fetch failed', { error: message })
        setError(message)
      })
      .finally(() => setLoading(false))
  }, [api, log])

  useEffect(() => { load() }, [load])

  const meta = useMemo(() => {
    const titles = new Map(tasks.map((t) => [t.id, t.title]))
    const projects = new Map(tasks.map((t) => [t.id, t.project || NO_PROJECT]))
    return {
      titleFor: (taskId: string): string => (taskId ? titles.get(taskId) ?? taskId : NO_TASK_LABEL),
      projectFor: (taskId: string): string => (taskId ? projects.get(taskId) ?? NO_PROJECT : NO_PROJECT),
    }
  }, [tasks])

  const days = useMemo(() => daysInRange(summary, range), [summary, range])

  // Only projects that actually appear in the window, so the list can never be a
  // wall of empty options.
  const projectOptions = useMemo(() => {
    const seen = new Set<string>()
    for (const day of summary?.days ?? []) {
      for (const t of day.tasks) {
        if (t.humanMs > 0 || t.agentMs > 0) seen.add(meta.projectFor(t.taskId))
      }
    }
    return [...seen].sort((a, b) => a.localeCompare(b))
  }, [summary, meta])

  const keep = useCallback(
    (taskId: string): boolean => project === '' || meta.projectFor(taskId) === project,
    [project, meta],
  )

  const humanRows = useMemo(
    () => foldRows(days, keep, meta.titleFor, (t) => (kind === 'all' ? t.humanMs : t.byKind[kind])),
    [days, keep, meta, kind],
  )
  const agentRows = useMemo(
    () => foldRows(days, keep, meta.titleFor, (t) => t.agentMs),
    [days, keep, meta],
  )

  const rangeLabel = RANGES.find((r) => r.value === range)?.label ?? ''

  const openTab = (next: TabId) => {
    setTab(next)
    navigate(`${basePath.replace(/\/+$/, '')}/${next}`)
  }

  return (
    <div className="wt-root" data-testid="time-app" data-tab={tab}>
      <header className="wt-header">
        <div>
          <span className="wt-kicker">Time tracking</span>
          <h1>Your day</h1>
          <p>
            Where your attention went, and what your agents ran. Two questions, never mixed
            into one number.
          </p>
        </div>
        <button className="wt-refresh" data-testid="time-app-refresh" onClick={load} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </header>

      <nav className="wt-tabs" role="tablist" aria-label="Time views">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={t.id === tab}
            className={`wt-tab${t.id === tab ? ' is-active' : ''}`}
            data-testid={`time-app-tab-${t.id}`}
            onClick={() => openTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {/* The timeline owns its own day nav; the range/kind pills would fight it. */}
      {tab !== 'timeline' && (
        <ReportFilters
          range={range}
          onRange={setRange}
          project={project}
          onProject={setProject}
          projectOptions={projectOptions}
          kind={kind}
          onKind={setKind}
          showKind={tab === 'my-time'}
        />
      )}

      {error && <div className="wt-degraded" data-testid="time-app-error">Error: {error}</div>}
      {summary?.degraded && (
        <div className="wt-degraded">Showing a partial answer: the rollup was still warming up.</div>
      )}

      <main className="wt-main" data-testid={`time-app-panel-${tab}`}>
        {tab === 'my-time' && (
          <MyTimeReport
            rows={humanRows}
            rangeLabel={rangeLabel}
            loading={loading && !summary}
            trendDays={summary?.days ?? []}
            today={summary?.today ?? ''}
            keep={keep}
            kind={kind}
          />
        )}
        {tab === 'agents' && (
          <AgentsReport rows={agentRows} rangeLabel={rangeLabel} loading={loading && !summary} />
        )}
        {tab === 'timeline' && (
          // Mounted only once the window is known: the day nav is bounded by the days
          // the summary fetched, so rendering it against an empty list would disable
          // both arrows for a frame.
          summary
            ? (
              <TimeTimeline
                api={api}
                log={log}
                dates={summary.days.map((d) => d.date)}
                today={summary.today}
                titleFor={meta.titleFor}
              />
            )
            : <p className="wt-empty">Loading…</p>
        )}
      </main>
    </div>
  )
}

/** The tab a deep link asks for. Anything unknown lands on the first tab. */
export function tabFromSubpath(subpath: string): TabId {
  const first = subpath.replace(/^\/+/, '').split('/')[0]?.toLowerCase() ?? ''
  return TABS.find((t) => t.id === first)?.id ?? 'my-time'
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
