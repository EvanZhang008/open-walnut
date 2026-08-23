import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchTimeSummary, type TimeSummary, type TaskDayTime } from '@/api/time';
import { useTasksContext } from '@/contexts/TasksContext';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { log } from '@/utils/log';
import '@/styles/time-page.css';

/**
 * Two clocks per task per day. HUMAN time is leased by real interaction in the
 * browser; AGENT time is derived from session turn results. Plain divs and one
 * inline SVG-free trend — no chart dependency.
 */

const TREND_DAYS = 7;

export function TimePage() {
  const [summary, setSummary] = useState<TimeSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { tasks } = useTasksContext();

  const load = useCallback(() => {
    setLoading(true);
    fetchTimeSummary(TREND_DAYS)
      .then((data) => { setSummary(data); setError(null); })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        log.warn('time-page', 'summary fetch failed', { error: message });
        setError(message);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const titleFor = useMemo(() => {
    const byId = new Map(tasks.map((t) => [t.id, t.title]));
    return (taskId: string): string => {
      if (!taskId) return 'No task (Inbox / chat)';
      return byId.get(taskId) ?? taskId;
    };
  }, [tasks]);

  if (loading && !summary) return <LoadingSpinner />;

  const today = summary?.days.find((d) => d.date === summary.today);
  const todayTasks = today?.tasks ?? [];
  const peak = Math.max(1, ...todayTasks.map((t) => t.humanMs + t.agentMs));

  return (
    <div className="time-page">
      <div className="page-header flex justify-between items-center">
        <div>
          <h1 className="page-title">Time</h1>
          <p className="page-subtitle">
            Your attention (leased by real interaction) next to agent turn time.
          </p>
        </div>
        <button className="btn" onClick={load} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {error && <div className="empty-state"><p>Error: {error}</p></div>}
      {summary?.degraded && (
        <div className="time-degraded">
          Showing a partial answer: the rollup was still warming up.
        </div>
      )}

      <div className="time-stat-row">
        <Stat label="Human today" value={formatDuration(today?.humanMs ?? 0)} tone="human" />
        <Stat label="Agent today" value={formatDuration(today?.agentMs ?? 0)} tone="agent" />
        <Stat label={`Human, ${TREND_DAYS}d`} value={formatDuration(summary?.totalHumanMs ?? 0)} />
        <Stat
          label="Focus share"
          value={`${Math.round((summary?.focusShare ?? 0) * 100)}%`}
          hint="human time on focus-tier tasks"
        />
      </div>

      <section className="time-section">
        <div className="time-section-head">
          <h2>Today by task</h2>
          <span className="time-section-hint">human vs agent</span>
        </div>
        {todayTasks.length === 0 ? (
          <p className="time-empty">
            Nothing recorded today yet. Time starts counting the moment you interact with a
            session, a task, or the chat.
          </p>
        ) : (
          <div className="time-bars">
            {todayTasks.map((task) => (
              <TaskBar key={task.taskId || '__none__'} task={task} peak={peak} title={titleFor(task.taskId)} />
            ))}
          </div>
        )}
      </section>

      <section className="time-section">
        <div className="time-section-head">
          <h2>Last {TREND_DAYS} days</h2>
          <span className="time-section-hint">stacked human + agent per day</span>
        </div>
        <Trend summary={summary} />
      </section>

      <div className="time-legend">
        <span className="time-legend-item"><i className="time-swatch time-swatch-human" /> Human</span>
        <span className="time-legend-item"><i className="time-swatch time-swatch-agent" /> Agent</span>
        <span className="time-legend-item"><i className="time-swatch time-swatch-focus" /> Focus tier</span>
      </div>
    </div>
  );
}

function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'human' | 'agent' }) {
  return (
    <div className={`time-stat${tone ? ` time-stat-${tone}` : ''}`}>
      <span className="time-stat-value">{value}</span>
      <span className="time-stat-label">{label}</span>
      {hint && <span className="time-stat-hint">{hint}</span>}
    </div>
  );
}

function TaskBar({ task, peak, title }: { task: TaskDayTime; peak: number; title: string }) {
  const humanPct = (task.humanMs / peak) * 100;
  const agentPct = (task.agentMs / peak) * 100;
  return (
    <div className="time-bar-row">
      <div className="time-bar-label" title={title}>
        {task.focus && <i className="time-swatch time-swatch-focus" aria-label="focus tier" />}
        <span className="time-bar-title">{title}</span>
      </div>
      <div className="time-bar-track">
        <div className="time-bar-seg time-bar-human" style={{ width: `${humanPct}%` }} />
        <div className="time-bar-seg time-bar-agent" style={{ width: `${agentPct}%` }} />
      </div>
      <div className="time-bar-values">
        <span className="time-bar-human-value">{formatDuration(task.humanMs)}</span>
        <span className="time-bar-agent-value">{formatDuration(task.agentMs)}</span>
      </div>
    </div>
  );
}

function Trend({ summary }: { summary: TimeSummary | null }) {
  const days = summary?.days ?? [];
  const peak = Math.max(1, ...days.map((d) => d.humanMs + d.agentMs));
  return (
    <div className="time-trend">
      {days.map((day) => {
        const humanH = (day.humanMs / peak) * 100;
        const agentH = (day.agentMs / peak) * 100;
        const isToday = day.date === summary?.today;
        return (
          <div className={`time-trend-day${isToday ? ' is-today' : ''}`} key={day.date}>
            <div
              className="time-trend-stack"
              title={`${day.date} — human ${formatDuration(day.humanMs)}, agent ${formatDuration(day.agentMs)}`}
            >
              <div className="time-trend-seg time-trend-agent" style={{ height: `${agentH}%` }} />
              <div className="time-trend-seg time-trend-human" style={{ height: `${humanH}%` }} />
            </div>
            <span className="time-trend-label">{day.date.slice(5)}</span>
          </div>
        );
      })}
    </div>
  );
}

/** 0 → "0m"; under an hour → "42m"; otherwise "2h 07m". */
export function formatDuration(ms: number): string {
  const totalMinutes = Math.round(ms / 60_000);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${h}h ${String(m).padStart(2, '0')}m`;
}
