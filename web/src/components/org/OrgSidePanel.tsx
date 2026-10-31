/**
 * The Org page's side panel: a task clicked anywhere on the page (a Board chip or card, a
 * Team row, Answer on an alert, a task named in a chat) opens here, so the user stays on
 * the Org page. A task with a session shows that session (the same embedded SessionPanel
 * as the Ask Walnut slot, with its own close, popout and fullscreen), and a Home button
 * opens it on home instead. A task with no session shows what it is and how to start one.
 * On a wide window a panel carries a lock: a locked panel stays beside the page while the
 * next task opens next to it (org-side-columns.ts), and it is still there after a restart.
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Task } from '@open-walnut/core';
import { fetchTask } from '@/api/tasks';
import { SessionPanel } from '@/components/sessions/SessionPanel';
import { ICON_LOCK, ICON_UNLOCK } from '@/components/common/Icons';
import { locateTaskOnHome, openSessionOnHome } from '@/utils/open-session';
import { resolveTaskSessionId } from '@/utils/session-status';

/** What the panel shows: a task (its session, when it has one) or one session by id. */
export type OrgSideTarget = { kind: 'task'; id: string } | { kind: 'session'; id: string };

/** `?open=` on the Org page: `task:<id>` or `session:<id>`. */
export function parseSideTarget(raw: string | null): OrgSideTarget | null {
  if (!raw) return null;
  const at = raw.indexOf(':');
  const kind = raw.slice(0, at);
  const id = raw.slice(at + 1);
  if (!id || (kind !== 'task' && kind !== 'session')) return null;
  return { kind, id };
}

export function sideTargetParam(t: OrgSideTarget): string {
  return `${t.kind}:${t.id}`;
}

interface Props {
  target: OrgSideTarget;
  tasks: readonly Task[];
  onClose: () => void;
  onOpenTask: (taskId: string) => void;
  onOpenSession: (sessionId: string) => void;
  /** Start a chat with a task that has none: a composer bound to it on home. */
  onStartChat: (taskId: string) => void;
  /** Open the session on its Inbox tab (a letter's Answer), once per new value. */
  inboxRequest?: number;
  /** Whether the panel is pinned beside the page; with onToggleLock, its header shows the lock. */
  locked?: boolean;
  onToggleLock?: () => void;
}

const HOME_ICON = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V21h14V9.5" />
  </svg>
);

export function OrgSidePanel({ target, tasks, onClose, onOpenTask, onOpenSession, onStartChat, inboxRequest, locked, onToggleLock }: Props) {
  const navigate = useNavigate();
  const stored = target.kind === 'task' ? tasks.find((t) => t.id === target.id) : undefined;
  // A task the store does not hold (a completed one, say) is read once.
  const [fetched, setFetched] = useState<{ id: string; task: Task | null } | null>(null);
  useEffect(() => {
    if (target.kind !== 'task' || stored) return;
    let live = true;
    fetchTask(target.id)
      .then((t) => { if (live) setFetched({ id: target.id, task: t as Task }); })
      .catch(() => { if (live) setFetched({ id: target.id, task: null }); });
    return () => { live = false; };
  }, [target.kind, target.id, stored]);
  const task = stored ?? (fetched?.id === target.id ? fetched.task ?? undefined : undefined);
  const loading = target.kind === 'task' && !stored && fetched?.id !== target.id;
  const sessionId = target.kind === 'session' ? target.id : task ? resolveTaskSessionId(task) : null;

  if (sessionId) {
    return (
      <aside className={`org-side${locked ? ' is-locked' : ''}`} data-testid="org-side" data-session-id={sessionId} data-target={sideTargetParam(target)} aria-label="Opened task">
        <SessionPanel
          key={sessionId}
          sessionId={sessionId}
          embedded
          {...(inboxRequest ? { inboxRequest } : {})}
          {...(onToggleLock ? { locked: !!locked, onToggleLock: () => onToggleLock() } : {})}
          onClose={onClose}
          headerLeading={(
            <button
              type="button"
              className="org-side-home"
              data-testid="org-side-home"
              title="Open on Home"
              aria-label="Open on Home"
              onClick={() => openSessionOnHome(sessionId, navigate)}
            >
              {HOME_ICON}
            </button>
          )}
          onTaskClick={onOpenTask}
          onSessionClick={onOpenSession}
          onLocateTask={(id) => locateTaskOnHome(id, navigate, { sessionId })}
        />
      </aside>
    );
  }

  return (
    <aside className={`org-side org-side-card${locked ? ' is-locked' : ''}`} data-testid="org-side" data-target={sideTargetParam(target)} aria-label="Opened task">
      <header className="org-side-card-head">
        <h3 className="org-side-card-title" data-testid="org-side-title">
          {loading ? 'Loading…' : task ? task.title : 'That task is gone.'}
        </h3>
        {onToggleLock && (
          <button
            type="button"
            className={`org-side-close org-side-lock${locked ? ' is-locked' : ''}`}
            data-testid="org-side-lock"
            aria-pressed={!!locked}
            aria-label={locked ? 'Unlock panel' : 'Lock panel beside the page'}
            title={locked ? 'Unlock: the next task opened replaces this panel' : 'Lock: the next task opens next to this panel'}
            onClick={onToggleLock}
          >
            {locked ? ICON_LOCK : ICON_UNLOCK}
          </button>
        )}
        <button type="button" className="org-side-close" data-testid="org-side-close" aria-label="Close" title="Close" onClick={onClose}>×</button>
      </header>
      {task && (
        <div className="org-side-card-body">
          <p className="org-muted">{[task.project || 'Inbox', task.phase.replace(/_/g, ' ').toLowerCase()].join(' · ')}</p>
          {task.description && <p className="org-side-card-desc">{task.description}</p>}
          <p className="org-muted">No session yet.</p>
          <div className="org-side-card-actions">
            <button type="button" className="btn btn-sm btn-primary" data-testid="org-side-start" onClick={() => onStartChat(task.id)}>Start a chat</button>
            <button type="button" className="btn btn-sm" data-testid="org-side-find" onClick={() => locateTaskOnHome(task.id, navigate)}>Find on Home</button>
          </div>
        </div>
      )}
    </aside>
  );
}
