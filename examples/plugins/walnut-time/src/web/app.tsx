import { useCallback, useEffect, useMemo, useState } from 'react'
import type { PluginLogger } from '@open-walnut/plugin-api/web'
import type { TaskRef, TimeApi, TimeSummary } from './api'
import { TimeApps } from './apps'
import { OverviewReport } from './overview'
import {
  AgentsReport, NO_PROJECT, NO_TASK_LABEL, ReportFilters, foldRows, type KindKey,
} from './reports'
import {
  TREND_DAYS, WINDOW_DAYS, daysInScope, scopeHint, type Scope, type ScopeMode,
} from './time-scope'
import { TimeTimeline } from './timeline'

/**
 * The app shell: one page, four tabs, one data load.
 *
 * The tab lives in the URL (`/apps/walnut-time~main/timeline`), so a view is
 * linkable and the browser's back button works, and the shell stays mounted across
 * tab switches so the scope and the filters survive one.
 *
 * The shell owns exactly two fetches: the WINDOW_DAYS time summary the two report tabs
 * fold, and the task list that gives a task id a title and a project. The window is
 * deeper than the 7 days the trend draws so the day nav has history to walk without a
 * second request. The Timeline and Apps tabs fetch their own day, because a day is its
 * own question and switching days must not re-read the window.
 */

const TABS = [
  { id: 'my-time', label: 'Overview' },
  { id: 'agents', label: 'Agents' },
  { id: 'apps', label: 'Apps' },
  { id: 'timeline', label: 'Timeline' },
] as const

type TabId = typeof TABS[number]['id']

/** Tabs that ask their own DAY question. They mount their own nav, so the shared
 *  scope bar is hidden on them: two day switchers on one screen fight each other. */
const OWN_DAY_TABS: readonly TabId[] = ['apps', 'timeline']

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
  const [scopeMode, setScopeMode] = useState<ScopeMode>('day')
  /**
   * '' means "whatever today is", not "unknown": today's date only arrives with the
   * summary, and storing it here would leave the scope pointing at yesterday for
   * anyone who leaves the tab open across midnight.
   */
  const [pickedDate, setPickedDate] = useState('')
  const [kind, setKind] = useState<KindKey>('all')
  const [project, setProject] = useState('')

  useEffect(() => { setTab(tabFromSubpath(subpath)) }, [subpath])

  const load = useCallback(() => {
    setLoading(true)
    // The task list is a NICE-TO-HAVE: it only supplies titles and the project
    // filter, and /api/time/blocks joins its own titles server-side. So a failure
    // there must not blank the page, only cost the reports their names.
    Promise.all([
      api.summary(WINDOW_DAYS),
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

  const today = summary?.today ?? ''
  const windowDates = summary?.days ?? []
  const oldest = windowDates[0]?.date ?? today
  const newest = windowDates[windowDates.length - 1]?.date ?? today
  const scope = useMemo<Scope>(
    () => ({ mode: scopeMode, date: pickedDate || today }),
    [scopeMode, pickedDate, today],
  )

  // A refresh across midnight (or a shorter window) can strand the picked day outside
  // the fetched days, where the nav arrows can't reach it and every panel reads empty
  // with nothing to explain why. Fall back to today instead.
  useEffect(() => {
    if (!summary || !pickedDate) return
    if (!summary.days.some((d) => d.date === pickedDate)) setPickedDate('')
  }, [summary, pickedDate])

  const days = useMemo(() => daysInScope(summary, scope), [summary, scope])
  /** The trend is always the trailing week, whatever the scope is looking at. */
  const trendDays = useMemo(() => (summary?.days ?? []).slice(-TREND_DAYS), [summary])

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

  const scopeText = scopeHint(scope, today)

  const openTab = (next: TabId) => {
    setTab(next)
    navigate(`${basePath.replace(/\/+$/, '')}/${next}`)
  }

  /** Clicking a bar on the trend reads THAT day, which is a day scope by definition. */
  const pickDay = (date: string) => {
    setScopeMode('day')
    setPickedDate(date === today ? '' : date)
  }

  const applyScope = (next: Scope) => {
    setScopeMode(next.mode)
    setPickedDate(next.date === today ? '' : next.date)
  }

  return (
    <div className="wt-root" data-testid="time-app" data-tab={tab}>
      <header className="wt-header">
        <div>
          {/* "Time", matching the App's title and its Settings row. This App is the only
              Time UI: the console's own "Time Tracking" section was deleted, so there is
              no second surface left to disambiguate from. */}
          <span className="wt-kicker">Time</span>
          <h1>Your day</h1>
          <p>
            Where your attention went, what your agents ran, and where the rest of your screen
            time went. Never mixed into one number.
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

      {/* Mounted only once the window is known, for the same reason the timeline is:
          an unbounded nav renders with both arrows dead. */}
      {!OWN_DAY_TABS.includes(tab) && summary && (
        <ReportFilters
          scope={scope}
          onScope={applyScope}
          today={today}
          oldest={oldest}
          newest={newest}
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
          <OverviewReport
            humanRows={humanRows}
            agentRows={agentRows}
            trendDays={trendDays}
            scope={scope}
            today={today}
            loading={loading && !summary}
            keep={keep}
            kind={kind}
            onPickDay={pickDay}
            onOpenAgents={() => openTab('agents')}
          />
        )}
        {tab === 'agents' && (
          <AgentsReport rows={agentRows} scopeText={scopeText} loading={loading && !summary} />
        )}
        {tab === 'apps' && (
          summary
            ? <TimeApps api={api} log={log} dates={summary.days.map((d) => d.date)} today={summary.today} />
            : <p className="wt-empty">Loading…</p>
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
