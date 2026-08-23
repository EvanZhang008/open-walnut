import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchTimeSummary, type DayTime, type TimeSummary, type TimeHumanKind } from '@/api/time';
import { useTasksContext } from '@/contexts/TasksContext';
import { log } from '@/utils/log';
import { TimeTimeline } from './TimeTimeline';
import { formatDuration } from './time-timeline';
import '@/styles/time-page.css';

/**
 * Time Tracking — a Settings section with TWO SEPARATE VIEWS, never one mixed row.
 *
 * "My time" answers "where did my attention go?" and shows HUMAN time only.
 * "Agents" answers "what did my agents run?" and shows AGENT time only.
 * "Timeline" answers "how did my day actually go?" and plots ONE day as blocks
 * on an hour axis — human lane and agent lane in physically separate columns,
 * agents off by default (TimeTimeline.tsx).
 *
 * Why they are split (a real misread, 2026-08-23): the first cut put a small human
 * number and a big agent number in the same row and stacked both into one bar. The
 * user read "8h 57m" as their own working day and reported the data as wrong. A
 * mixed row answers neither question, so the lanes now never share a row, a bar, or
 * a headline stat — you pick the question first.
 *
 * Everything is derived from ONE 7-day fetch: the range / project / kind filters
 * are client-side folds over `days[].tasks[]`, which already carries `byKind` and
 * the server-joined focus-tier flag. Project comes from the task list the settings
 * page already holds, so no extra round trip and no API change.
 */

const TREND_DAYS = 7;

type RangeKey = 'today' | 'yesterday' | '7d';
type KindKey = 'all' | TimeHumanKind;
type TabKey = 'mine' | 'agents' | 'timeline';

const RANGES: Array<{ value: RangeKey; label: string }> = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: '7d', label: 'Last 7 days' },
];

const KINDS: Array<{ value: KindKey; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'session', label: 'Sessions' },
  { value: 'triage', label: 'Triage' },
  { value: 'chat', label: 'Chat' },
];

const NO_TASK_LABEL = 'No task (Inbox / chat)';
const NO_PROJECT = 'Inbox';

interface Row {
  taskId: string;
  title: string;
  ms: number;
  focus: boolean;
}

export function TimeSection() {
  const [summary, setSummary] = useState<TimeSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>('mine');
  const [range, setRange] = useState<RangeKey>('today');
  const [kind, setKind] = useState<KindKey>('all');
  const [project, setProject] = useState('');
  const { tasks } = useTasksContext();

  const load = useCallback(() => {
    setLoading(true);
    fetchTimeSummary(TREND_DAYS)
      .then((data) => { setSummary(data); setError(null); })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        log.warn('time-section', 'summary fetch failed', { error: message });
        setError(message);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const meta = useMemo(() => {
    const titles = new Map(tasks.map((t) => [t.id, t.title]));
    const projects = new Map(tasks.map((t) => [t.id, t.project || NO_PROJECT]));
    return {
      titleFor: (taskId: string): string => (taskId ? titles.get(taskId) ?? taskId : NO_TASK_LABEL),
      projectFor: (taskId: string): string => (taskId ? projects.get(taskId) ?? NO_PROJECT : NO_PROJECT),
    };
  }, [tasks]);

  const days = useMemo(() => daysInRange(summary, range), [summary, range]);

  // Projects offered by the filter: only those that actually appear in the window,
  // so the list can never be a wall of empty options.
  const projectOptions = useMemo(() => {
    const seen = new Set<string>();
    for (const day of summary?.days ?? []) {
      for (const t of day.tasks) {
        if (t.humanMs > 0 || t.agentMs > 0) seen.add(meta.projectFor(t.taskId));
      }
    }
    return [...seen].sort((a, b) => a.localeCompare(b));
  }, [summary, meta]);

  const keep = useCallback(
    (taskId: string): boolean => project === '' || meta.projectFor(taskId) === project,
    [project, meta],
  );

  const humanRows = useMemo(
    () => foldRows(days, keep, meta.titleFor, (t) => (kind === 'all' ? t.humanMs : t.byKind[kind])),
    [days, keep, meta, kind],
  );
  const agentRows = useMemo(
    () => foldRows(days, keep, meta.titleFor, (t) => t.agentMs),
    [days, keep, meta],
  );

  const rangeLabel = RANGES.find((r) => r.value === range)?.label ?? '';

  return (
    <div id="time" className="card settings-section settings-section-wide time-page">
      <div className="time-header">
        <div>
          <h3 className="settings-section-title">Time Tracking</h3>
          <p className="time-subtitle">
            Your attention and your agents' runtime, kept in separate views on purpose.
          </p>
        </div>
        <button className="usage-refresh-btn" onClick={load} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      <div className="usage-period-tabs time-tabs" role="tablist">
        <button
          role="tab"
          aria-selected={tab === 'mine'}
          data-testid="time-tab-mine"
          className={`usage-period-tab${tab === 'mine' ? ' active' : ''}`}
          onClick={() => setTab('mine')}
        >
          My time
        </button>
        <button
          role="tab"
          aria-selected={tab === 'agents'}
          data-testid="time-tab-agents"
          className={`usage-period-tab${tab === 'agents' ? ' active' : ''}`}
          onClick={() => setTab('agents')}
        >
          Agents
        </button>
        <button
          role="tab"
          aria-selected={tab === 'timeline'}
          data-testid="time-tab-timeline"
          className={`usage-period-tab${tab === 'timeline' ? ' active' : ''}`}
          onClick={() => setTab('timeline')}
        >
          Timeline
        </button>
      </div>

      {/* The timeline owns its own day nav; the range/kind pills would fight it. */}
      {tab !== 'timeline' && (
        <div className="time-filters">
          <div className="usage-period-tabs" role="group" aria-label="Date range">
            {RANGES.map((r) => (
              <button
                key={r.value}
                data-testid={`time-range-${r.value}`}
                className={`usage-period-tab${range === r.value ? ' active' : ''}`}
                onClick={() => setRange(r.value)}
              >
                {r.label}
              </button>
            ))}
          </div>

          <label className="time-filter-field">
            <span className="time-filter-label">Project</span>
            <select
              data-testid="time-project-filter"
              value={project}
              onChange={(e) => setProject(e.target.value)}
            >
              <option value="">All projects</option>
              {projectOptions.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </label>

          {tab === 'mine' && (
            <div className="usage-period-tabs" role="group" aria-label="Activity kind">
              {KINDS.map((k) => (
                <button
                  key={k.value}
                  data-testid={`time-kind-${k.value}`}
                  className={`usage-period-tab${kind === k.value ? ' active' : ''}`}
                  onClick={() => setKind(k.value)}
                >
                  {k.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {error && <div className="time-degraded">Error: {error}</div>}
      {summary?.degraded && (
        <div className="time-degraded">
          Showing a partial answer: the rollup was still warming up.
        </div>
      )}

      {tab === 'mine' && (
        <MyTimeView
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
        <AgentsView rows={agentRows} rangeLabel={rangeLabel} loading={loading && !summary} />
      )}
      {tab === 'timeline' && (
        // Mounted only once the window is known: the day nav is bounded by the
        // days the summary fetched, so rendering it against an empty list would
        // disable both arrows for a frame.
        summary
          ? (
            <TimeTimeline
              dates={summary.days.map((d) => d.date)}
              today={summary.today}
              titleFor={meta.titleFor}
            />
          )
          : <p className="time-empty">Loading…</p>
      )}
    </div>
  );
}

// ── Tab 1: my attention ──

function MyTimeView({ rows, rangeLabel, loading, trendDays, today, keep, kind }: {
  rows: Row[];
  rangeLabel: string;
  loading: boolean;
  trendDays: DayTime[];
  today: string;
  keep: (taskId: string) => boolean;
  kind: KindKey;
}) {
  const total = rows.reduce((sum, r) => sum + r.ms, 0);
  const focusMs = rows.filter((r) => r.focus).reduce((sum, r) => sum + r.ms, 0);
  const focusRows = rows.filter((r) => r.focus);
  const otherRows = rows.filter((r) => !r.focus);
  const peak = Math.max(1, ...rows.map((r) => r.ms));

  return (
    <div data-testid="time-view-mine">
      <div className="time-stat-row">
        <Stat label={`Your time, ${rangeLabel.toLowerCase()}`} value={formatDuration(total)} tone="human" />
        <Stat
          label="Focus share"
          value={total > 0 ? `${Math.round((focusMs / total) * 100)}%` : '—'}
          hint="your time on focus-tier tasks"
        />
        <Stat
          label="Biggest destination"
          value={rows[0]?.title ?? '—'}
          hint={rows[0] ? formatDuration(rows[0].ms) : undefined}
          text
        />
      </div>

      {rows.length === 0
        ? (
          <p className="time-empty">
            {loading
              ? 'Loading…'
              : 'Nothing recorded for this range yet. Your time starts counting the moment you interact with a session, a task, or the chat.'}
          </p>
        )
        : (
          <>
            <Group title="Focus tasks" testId="time-group-focus" rows={focusRows} peak={peak} tone="human" />
            <Group title="Other" testId="time-group-other" rows={otherRows} peak={peak} tone="human" />
          </>
        )}

      <section className="time-section">
        <div className="time-section-head">
          <h2>Last {TREND_DAYS} days</h2>
          <span className="time-section-hint">your time per day, focus vs other</span>
        </div>
        <FocusTrend days={trendDays} today={today} keep={keep} kind={kind} />
        <div className="time-legend">
          <span className="time-legend-item"><i className="time-swatch time-swatch-focus" /> Focus tasks</span>
          <span className="time-legend-item"><i className="time-swatch time-swatch-human" /> Other tasks</span>
        </div>
      </section>
    </div>
  );
}

/** One bar per day, stacked focus vs non-focus — both halves are YOUR time. */
function FocusTrend({ days, today, keep, kind }: {
  days: DayTime[];
  today: string;
  keep: (taskId: string) => boolean;
  kind: KindKey;
}) {
  const bars = days.map((day) => {
    let focus = 0;
    let other = 0;
    for (const t of day.tasks) {
      if (!keep(t.taskId)) continue;
      const ms = kind === 'all' ? t.humanMs : t.byKind[kind];
      if (ms <= 0) continue;
      if (t.focus) focus += ms; else other += ms;
    }
    return { date: day.date, focus, other };
  });
  const peak = Math.max(1, ...bars.map((b) => b.focus + b.other));

  return (
    <div className="time-trend">
      {bars.map((bar) => (
        <div className={`time-trend-day${bar.date === today ? ' is-today' : ''}`} key={bar.date}>
          <div
            className="time-trend-stack"
            title={`${bar.date}: focus ${formatDuration(bar.focus)}, other ${formatDuration(bar.other)}`}
          >
            <div className="time-trend-seg time-trend-other" style={{ height: `${(bar.other / peak) * 100}%` }} />
            <div className="time-trend-seg time-trend-focus" style={{ height: `${(bar.focus / peak) * 100}%` }} />
          </div>
          <span className="time-trend-label">{bar.date.slice(5)}</span>
        </div>
      ))}
    </div>
  );
}

// ── Tab 2: the agent fleet ──

function AgentsView({ rows, rangeLabel, loading }: { rows: Row[]; rangeLabel: string; loading: boolean }) {
  const total = rows.reduce((sum, r) => sum + r.ms, 0);
  const peak = Math.max(1, ...rows.map((r) => r.ms));

  return (
    <div data-testid="time-view-agents">
      <div className="time-stat-row">
        <Stat label={`Agent runtime, ${rangeLabel.toLowerCase()}`} value={formatDuration(total)} tone="agent" />
        <Stat label="Tasks with agent time" value={String(rows.length)} />
      </div>

      <p className="time-agent-note" data-testid="time-agent-caption">
        Agent turn time, not yours: agents can run in parallel, so totals can exceed the clock.
      </p>

      {rows.length === 0
        ? <p className="time-empty">{loading ? 'Loading…' : 'No agent runs recorded for this range.'}</p>
        : <Group title="By task" testId="time-group-agents" rows={rows} peak={peak} tone="agent" />}
    </div>
  );
}

// ── Shared pieces ──

function Group({ title, testId, rows, peak, tone }: {
  title: string;
  testId: string;
  rows: Row[];
  peak: number;
  tone: 'human' | 'agent';
}) {
  return (
    <section className="time-section" data-testid={testId}>
      <div className="time-section-head">
        <h2>{title}</h2>
        <span className="time-section-hint">
          {rows.length === 0 ? 'nothing here' : `${rows.length} ${rows.length === 1 ? 'task' : 'tasks'}`}
        </span>
      </div>
      {rows.length > 0 && (
        <div className="time-bars">
          {rows.map((row) => <Bar key={row.taskId || '__none__'} row={row} peak={peak} tone={tone} />)}
        </div>
      )}
    </section>
  );
}

function Bar({ row, peak, tone }: { row: Row; peak: number; tone: 'human' | 'agent' }) {
  return (
    // NOT `data-task-id`: the time tracker attributes any signal inside a
    // `div[data-task-id]` to that task, so a report row carrying it would bill the
    // task you merely LOOKED at in the report. Test hooks use a distinct name.
    <div className="time-bar-row" data-time-task-id={row.taskId}>
      <div className="time-bar-label" title={row.title}>
        {row.focus && <i className="time-swatch time-swatch-focus" aria-label="focus tier" />}
        <span className="time-bar-title">{row.title}</span>
      </div>
      <div className="time-bar-track">
        <div className={`time-bar-fill time-bar-fill-${tone}`} style={{ width: `${(row.ms / peak) * 100}%` }} />
      </div>
      <span className={`time-bar-value time-bar-value-${tone}`}>{formatDuration(row.ms)}</span>
    </div>
  );
}

function Stat({ label, value, hint, tone, text }: {
  label: string; value: string; hint?: string; tone?: 'human' | 'agent'; text?: boolean;
}) {
  return (
    <div className={`time-stat${tone ? ` time-stat-${tone}` : ''}`}>
      <span className={`time-stat-value${text ? ' time-stat-text' : ''}`} title={text ? value : undefined}>
        {value}
      </span>
      <span className="time-stat-label">{label}</span>
      {hint && <span className="time-stat-hint">{hint}</span>}
    </div>
  );
}

// ── Folds (pure) ──

/** The days the selected range covers. `days` is ascending and ends at today. */
function daysInRange(summary: TimeSummary | null, range: RangeKey): DayTime[] {
  const all = summary?.days ?? [];
  if (all.length === 0) return [];
  if (range === '7d') return all;
  const todayIdx = all.findIndex((d) => d.date === summary!.today);
  const idx = range === 'today' ? todayIdx : todayIdx - 1;
  const day = idx >= 0 ? all[idx] : undefined;
  return day ? [day] : [];
}

/** Sum one lane per task across the given days, biggest first. */
function foldRows(
  days: DayTime[],
  keep: (taskId: string) => boolean,
  titleFor: (taskId: string) => string,
  msOf: (task: DayTime['tasks'][number]) => number,
): Row[] {
  const byTask = new Map<string, Row>();
  for (const day of days) {
    for (const task of day.tasks) {
      if (!keep(task.taskId)) continue;
      const ms = msOf(task);
      if (ms <= 0) continue;
      const row = byTask.get(task.taskId);
      if (row) {
        row.ms += ms;
        row.focus = row.focus || task.focus;
      } else {
        byTask.set(task.taskId, { taskId: task.taskId, title: titleFor(task.taskId), ms, focus: task.focus });
      }
    }
  }
  return [...byTask.values()].sort((a, b) => b.ms - a.ms || a.title.localeCompare(b.title));
}
