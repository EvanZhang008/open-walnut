/**
 * "Move to <host>" in a task's kebab and the session panel's ⋮ menu: the task keeps its id
 * and conversation, and its own work goes with it (core/sessions/engine-switch.ts `move`,
 * POST /api/v1/tasks/:id/move). One collapsed row, like Team; opened, it reads each host's
 * load (GET /api/v1/hosts/load) and the task's current host, and lists the others with how
 * busy they are. A task with no session has nothing to move, so it has no row.
 */
import { useEffect, useState } from 'react';
import type { Task } from '@open-walnut/core';
import { CHEVRON_GLYPH } from '@/components/common/Icons';
import { apiGet, apiPost } from '@/api/client';
import { resolveTaskSessionId } from '@/utils/session-status';
import { log } from '@/utils/log';
import '@/styles/transfer.css';

export interface HostLoadRow {
  host: string;
  label: string;
  known: boolean;
  busy: boolean;
  reasons: string[];
  loadPerCpu?: number;
  cpus?: number;
  diskFreeBytes?: number | null;
  running: number;
  runningLimit: number;
}

/** One line under a host's name: room, or why it is busy (pure, for tests). */
export function hostLoadLine(h: HostLoadRow): string {
  if (!h.known) return 'load unknown';
  const free = h.diskFreeBytes != null ? ` · ${Math.round(h.diskFreeBytes / 1024 ** 3)} GB free` : '';
  if (h.busy) return `busy: ${h.reasons[0] ?? 'over a cap'}`;
  return `room · load ${h.loadPerCpu ?? '?'}/CPU · ${h.running} working${free}`;
}

const ICON_MOVE = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="4" width="8" height="6" rx="1" /><rect x="13" y="14" width="8" height="6" rx="1" /><path d="M7 10v4a3 3 0 0 0 3 3h3M16 14v-1" />
  </svg>
);

export function MoveHostMenuItems({ task, afterAction }: { task: Task; afterAction: () => void }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<HostLoadRow[] | null>(null);
  const [here, setHere] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sessionId = resolveTaskSessionId(task);
  useEffect(() => {
    if (!open) return;
    let live = true;
    setError(null);
    Promise.all([
      apiGet<{ hosts: HostLoadRow[] }>('/api/v1/hosts/load', undefined, { timeoutMs: 12_000 }),
      apiGet<{ sessions: Array<{ host: string | null; active: boolean }> }>(`/api/v1/tasks/${encodeURIComponent(task.id)}/sessions`, undefined, { timeoutMs: 12_000 }),
    ]).then(([load, sessions]) => {
      if (!live) return;
      setRows(load.hosts);
      const active = sessions.sessions.find((s) => s.active);
      setHere(!active?.host || active.host === 'local' ? '__local__' : active.host);
    }).catch((err: unknown) => { if (live) setError(err instanceof Error ? err.message : String(err)); });
    return () => { live = false; };
  }, [open, task.id]);
  if (!sessionId) return null;
  const move = (host: string) => {
    log.info('tasks', 'task move requested', { taskId: task.id, host });
    apiPost(`/api/v1/tasks/${encodeURIComponent(task.id)}/move`, { host, wait_ms: 0 }, { timeoutMs: 30_000 })
      .then((out) => log.info('tasks', 'task move answered', { taskId: task.id, host, result: out as Record<string, unknown> }))
      .catch((err) => log.warn('tasks', 'task move failed', { taskId: task.id, host, error: err instanceof Error ? err.message : String(err) }));
    afterAction();
  };
  const others = (rows ?? []).filter((h) => h.host !== here);
  return (
    <div className={`task-kebab-team${open ? ' open' : ''}`} data-testid="kebab-move-host">
      <button
        type="button"
        className="task-kebab-item task-kebab-team-toggle"
        data-testid="kebab-move-host-toggle"
        aria-expanded={open}
        title="Move this task to another host: same task and conversation, its own work goes with it"
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
      >
        <span className="task-kebab-icon">{ICON_MOVE}</span>
        <span className="task-kebab-team-label">Move to another host</span>
        <span className={`task-kebab-team-caret${open ? ' open' : ''}`} aria-hidden="true">{CHEVRON_GLYPH}</span>
      </button>
      {open && (
        <div className="task-kebab-team-rows">
          {error && <div className="task-kebab-item task-kebab-info" data-testid="kebab-move-host-error">Could not read the hosts: {error}</div>}
          {!error && !rows && <div className="task-kebab-item task-kebab-info">Reading each host&apos;s load…</div>}
          {!error && rows && others.length === 0 && <div className="task-kebab-item task-kebab-info">No other host is set up</div>}
          {others.map((h) => (
            <button
              key={h.host}
              type="button"
              className="task-kebab-item task-kebab-move-host"
              data-testid={`kebab-move-host-${h.host}`}
              title={h.reasons.length ? h.reasons.join('; ') : `Has room: load ${h.loadPerCpu ?? '?'} per CPU on ${h.cpus ?? '?'} CPUs, ${h.running} of ${h.runningLimit} sessions in a turn`}
              onClick={(e) => { e.stopPropagation(); move(h.host); }}
            >
              <span className="task-kebab-icon" aria-hidden="true">→</span>
              <span className="task-kebab-move-host-text">
                <span>Move to {h.label}</span>
                <span className={`task-kebab-move-host-load${h.busy ? ' busy' : ''}`}>{hostLoadLine(h)}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
