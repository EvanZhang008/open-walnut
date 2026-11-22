/**
 * "Move to <host>" in a task's kebab and the session panel's ⋮ menu: the task keeps its id
 * and conversation, and its own work goes with it (core/sessions/engine-switch.ts `move`,
 * POST /api/v1/tasks/:id/move). One collapsed row, like Team; opened, it reads each host's
 * load (GET /api/v1/hosts/load) and the task's current host, and lists the others with how
 * busy they are. A task with no session has nothing to move, so it has no row.
 */
import { useEffect, useState } from 'react';
import type { Task } from '@open-walnut/core';
import { DisclosureChevron } from '@/components/controls';
import { EmptyState, LoadingState, UnavailableState } from '@/components/common/EmptyState';
import { apiGet, apiPost } from '@/api/client';
import { resolveTaskSessionId } from '@/utils/session-status';
import { log } from '@/utils/log';
import '@/styles/transfer.css';
import { ICON_ARROW_RIGHT } from '@/components/common/Icons';

export interface HostLoadRow {
  host: string;
  label: string;
  known: boolean;
  busy: boolean;
  reasons: string[];
  loadPerCpu?: number;
  /** Our own processes' share of it, when placement judged by that. */
  ownLoadPerCpu?: number;
  cpus?: number;
  diskFreeBytes?: number | null;
  running: number;
  runningLimit: number;
  /** What the host is, when the server says (the cloud box: small, costs money while it works). */
  note?: string;
  /** false: no automatic pick takes it; listed for a person or an agent who is asked to. */
  autoPick?: false;
}

/** One line under a host's name: room, or why it is busy (pure, for tests). */
export function hostLoadLine(h: HostLoadRow): string {
  if (!h.known) return 'load unknown';
  const free = h.diskFreeBytes != null ? ` · ${Math.round(h.diskFreeBytes / 1024 ** 3)} GB free` : '';
  if (h.busy) return `busy: ${h.reasons[0] ?? 'over a cap'}`;
  return `room · load ${h.ownLoadPerCpu ?? h.loadPerCpu ?? '?'}/CPU${h.ownLoadPerCpu != null ? ' ours' : ''} · ${h.running} working${free}`;
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
  const [asking, setAsking] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
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
  // The server answers once the move is checked and under way (wait_ms 0): a refusal shows
  // here; the session panel's engine-switch line follows the move itself.
  const move = (host: string) => {
    log.info('tasks', 'task move requested', { taskId: task.id, host });
    setAsking(host);
    setRefused(null);
    apiPost(`/api/v1/tasks/${encodeURIComponent(task.id)}/move`, { host, wait_ms: 0 }, { timeoutMs: 30_000 })
      .then((out) => {
        log.info('tasks', 'task move answered', { taskId: task.id, host, result: out as Record<string, unknown> });
        afterAction();
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        log.warn('tasks', 'task move refused', { taskId: task.id, host, error: message });
        setRefused(message);
      })
      .finally(() => setAsking(null));
  };
  const others = (rows ?? []).filter((h) => h.host !== here);
  return (
    <div className={`task-kebab-team${open ? ' open' : ''}`} data-testid="kebab-move-host">
      <button
        type="button"
        className="task-kebab-item task-kebab-team-head"
        data-testid="kebab-move-host-toggle"
        aria-expanded={open}
        title="Move this task to another host: same task and conversation, its own work goes with it"
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
      >
        <span className="task-kebab-icon">{ICON_MOVE}</span>
        <span className="task-kebab-team-label">Move to another host</span>
        {/* A menu row that is its own button: the shared chevron, turned by its aria-expanded. */}
        <DisclosureChevron />
      </button>
      {open && (
        <div className="task-kebab-team-rows">
          {error && <UnavailableState size="row" title="Could not read the hosts" detail={error} testId="kebab-move-host-error" />}
          {!error && !rows && <LoadingState size="row" title="Reading each host's load…" />}
          {!error && rows && others.length === 0 && <EmptyState size="row" title="No other host is set up" />}
          {refused && <div className="task-kebab-item task-kebab-info task-kebab-move-host-refused" role="alert" data-testid="kebab-move-host-refused">The move did not start: {refused}</div>}
          {others.map((h) => (
            <button
              key={h.host}
              type="button"
              className="task-kebab-item task-kebab-move-host"
              data-testid={`kebab-move-host-${h.host}`}
              disabled={asking !== null}
              title={`${h.note ? `${h.note} ` : ''}${h.reasons.length ? h.reasons.join('; ') : `Has room: load ${h.loadPerCpu ?? '?'} per CPU${h.ownLoadPerCpu != null ? ` (ours ${h.ownLoadPerCpu})` : ''} on ${h.cpus ?? '?'} CPUs, ${h.running} of ${h.runningLimit} sessions in a turn`}`}
              onClick={(e) => { e.stopPropagation(); move(h.host); }}
            >
              <span className="task-kebab-icon" aria-hidden="true">{ICON_ARROW_RIGHT}</span>
              <span className="task-kebab-move-host-text">
                <span>{asking === h.host ? `Moving to ${h.label}…` : `Move to ${h.label}`}</span>
                {h.note && <span className="task-kebab-move-host-note" data-testid={`kebab-move-host-note-${h.host}`}>{h.note}</span>}
                <span className={`task-kebab-move-host-load${h.busy ? ' busy' : ''}`}>{hostLoadLine(h)}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
