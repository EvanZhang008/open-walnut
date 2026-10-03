/**
 * The column of a launch that waits for its isolated workspace.
 *
 * The draft's Start filed the task; the host is making the workspace (minutes,
 * for a monorepo tool). This column shows the provider's progress from the task
 * row (task:updated carries it), the error with Retry when it fails, and turns
 * into the real session column the moment the session starts in the workspace.
 * It never times out: a slow provider is not a failure, its own timeout is.
 *
 * Keyed by the TASK (`pending:ws-<taskId>`), so any number can wait at once.
 *
 * Only the session started for THIS launch promotes it: the one whose id the
 * launch pre-assigned, else one that started after the workspace was asked for
 * (an existing task's older sessions never count). A launch the server refused
 * outright (`launchError`) shows that error with Retry and Dismiss, even before
 * (or without) a workspace row.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Task } from '@open-walnut/core';
import { useStoreTask } from '@/contexts/TasksContext';
import { fetchTask } from '@/api/tasks';
import { fetchSessionsForTask } from '@/api/sessions';
import { retryTaskWorkspace } from '@/api/workspaces';
import { log } from '@/utils/log';
import { hostName, workspaceOf, workspaceStateLabel } from './workspace-text';
import '@/styles/workspaces.css';

const POLL_MS = 3_000;

export function WorkspacePreparingPanel({ taskId, initialTask, message, launchError, onClose, onSessionReady }: {
  taskId: string;
  initialTask?: Task | null;
  message?: string;
  /** The server refused the launch's workspace request (the quick-start answer's workspaceError). */
  launchError?: string;
  onClose: () => void;
  onSessionReady: (sessionId: string) => void;
}) {
  const storeTask = useStoreTask(taskId);
  const [ownTask, setOwnTask] = useState<Task | null>(initialTask ?? null);
  const task = storeTask ?? ownTask;
  const ws = workspaceOf(task);
  // The session the task already had (a bound draft), so only a NEW one counts.
  const baseline = useRef<string | undefined>((initialTask as { exec_session_id?: string } | null | undefined)?.exec_session_id);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(launchError ?? null);
  const done = useRef(false);
  // The session id this launch pre-assigned: the pending start carries it until the session starts.
  const expectedSid = useRef<string | undefined>(ws?.pending_start?.session_id);
  if (ws?.pending_start?.session_id) expectedSid.current = ws.pending_start.session_id;
  const askedAt = Date.parse(ws?.created_at ?? '') || 0;
  const isThisLaunch = useCallback((sid: string | undefined, startedAt?: string) => {
    if (!sid || sid === baseline.current) return false;
    if (expectedSid.current) return sid === expectedSid.current;
    // No pre-assigned id (an ACP engine): only a session that started after the workspace was asked for.
    const started = Date.parse(startedAt ?? '');
    return startedAt === undefined ? true : Number.isFinite(started) && started >= askedAt - 5_000;
  }, [askedAt]);

  const promote = useCallback((sessionId: string) => {
    if (done.current) return;
    done.current = true;
    log.info('workspace', 'preparing column promoted to its session', { taskId, sessionId });
    onSessionReady(sessionId);
  }, [onSessionReady, taskId]);

  const execId = (task as { exec_session_id?: string } | null)?.exec_session_id;
  useEffect(() => {
    if (execId && execId !== baseline.current && (!expectedSid.current || execId === expectedSid.current)) promote(execId);
  }, [execId, promote]);

  // A missed WS event must not strand the column: poll while the workspace is
  // being made (the row, when the store does not carry it) and while its session starts.
  const starting = ws?.state === 'ready' && !ws.launch_error;
  const needsRow = !storeTask;
  useEffect(() => {
    if (!starting && !needsRow) return;
    let alive = true;
    const tick = async () => {
      try {
        if (needsRow) {
          const fresh = await fetchTask(taskId);
          if (alive) setOwnTask(fresh as Task);
        }
        if (starting) {
          const sessions = await fetchSessionsForTask(taskId);
          const fresh = sessions.find((s) => !s.archived && isThisLaunch(s.claudeSessionId, s.startedAt));
          if (alive && fresh) promote(fresh.claudeSessionId);
        }
      } catch { /* next tick */ }
    };
    const timer = setInterval(() => { void tick(); }, POLL_MS);
    void tick();
    return () => { alive = false; clearInterval(timer); };
  }, [starting, needsRow, taskId, promote, isThisLaunch]);

  const retry = useCallback(async () => {
    setRetrying(true);
    setRetryError(null);
    try {
      const { task: next } = await retryTaskWorkspace(taskId);
      setOwnTask(next);
      setRefused(null);
    } catch (err) {
      setRetryError(err instanceof Error ? err.message : String(err));
    } finally {
      setRetrying(false);
    }
  }, [taskId]);

  const anchor = ws?.anchor ?? '';
  const dirName = anchor.replace(/\/+$/, '').split('/').pop() || 'workspace';
  const failed = !!refused || ws?.state === 'failed' || !!ws?.launch_error;
  const label = refused && ws?.state !== 'failed' ? 'The workspace could not be requested'
    : !ws ? 'Preparing workspace…'
      : ws.launch_error ? 'The workspace is ready, but the session could not start'
        : ws.state === 'ready' ? 'Workspace ready. Starting the session…'
          : workspaceStateLabel(ws);
  const errorText = ws?.launch_error ?? (ws?.state === 'failed' ? ws.error : undefined) ?? refused ?? ws?.error;

  return (
    <div className="session-panel pending-session-panel workspace-preparing-panel" data-testid="workspace-preparing-panel" data-task-id={taskId} data-state={ws?.state ?? 'unknown'}>
      <div className="session-panel-header">
        <div className="session-panel-header-top">
          <div className="session-panel-title-area">
            <span className="session-panel-title" title={anchor}>{dirName}</span>
            {ws && ws.host !== '__local__' && (
              <span className="session-panel-badge" style={{ color: 'var(--fg-muted)', fontSize: '10px' }}>{hostName(ws.host)}</span>
            )}
            <span className="session-panel-badge" style={{ color: failed ? 'var(--color-error, #ff3b30)' : 'var(--fg-muted)' }}>
              {failed ? 'Failed' : 'Preparing…'}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '2px', flexShrink: 0 }}>
            <button className="session-panel-close" onClick={onClose} title="Close panel">&times;</button>
          </div>
        </div>
      </div>
      {message?.trim() && (
        <div className="pending-session-prompt">
          <div className="session-msg session-msg-user">
            <div className="session-msg-content pending-session-prompt-text">{message}</div>
          </div>
        </div>
      )}
      <div className="pending-session-body">
        {failed
          ? <div className="pending-session-error-icon">!</div>
          : <div className="pending-session-spinner-wrap"><span className="spinner" style={{ width: 20, height: 20, borderWidth: 2, display: 'inline-block' }} /></div>}
        <div className="pending-session-info">
          <span className="pending-session-label" data-testid="workspace-preparing-label" style={failed ? { color: 'var(--color-error, #ff3b30)' } : undefined}>{label}</span>
          {ws && <span className="pending-session-path">{ws.provider_name ?? ws.provider} on {hostName(ws.host)}</span>}
          {!failed && ws?.progress && <span className="pending-session-path workspace-preparing-progress" data-testid="workspace-preparing-progress">{ws.progress}</span>}
          {failed && errorText && <span className="pending-session-path workspace-preparing-error" data-testid="workspace-preparing-error">{errorText}</span>}
          {retryError && <span className="pending-session-path workspace-preparing-error">{retryError}</span>}
          <span className="pending-session-path" title={ws?.root ?? anchor} style={{ marginTop: 8 }}>{ws?.root ?? anchor}</span>
        </div>
        {failed && (
          <div className="pending-session-actions">
            <button className="pending-session-retry-btn" onClick={() => { void retry(); }} disabled={retrying} data-testid="workspace-preparing-retry">
              {retrying ? 'Retrying…' : 'Retry'}
            </button>
            <button className="pending-session-dismiss-btn" onClick={onClose}>Dismiss</button>
          </div>
        )}
      </div>
    </div>
  );
}
