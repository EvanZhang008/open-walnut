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
import { cancelWorkspaceStart, fetchScripts, rerunTaskSetup, retryTaskWorkspace, startTaskAnyway } from '@/api/workspaces';
import { log } from '@/utils/log';
import { hostName, setupWaitsForYou, workspaceOf, workspaceStateLabel } from './workspace-text';
import { ScriptRunCard } from './ScriptRunCard';
import { Breakable } from './Breakable';
import { ProjectScriptsDialog } from './ProjectScriptsDialog';
import '@/styles/workspaces.css';

const POLL_MS = 3_000;
/** While its session starts: the column turns into it soon after its record is there. */
const START_POLL_MS = 1_000;
/** How long a ready workspace with no start waiting may go without this launch's session. */
const NO_START_GRACE_MS = 15_000;

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
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
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
  // The launch pre-assigns the session id and the task names it at once, so while its
  // start still waits (setup running, or failed and waiting for the person) the id names
  // no session yet: a column restored by a reload must not turn into it (it would load forever).
  const waiting = !!ws?.pending_start;
  // Turn into the session once its record is there, so the column never shows a session
  // that is still loading ("Untitled session"); until then it keeps saying it starts.
  const promoteWhenListed = useCallback(async (sid: string) => {
    try {
      const sessions = await fetchSessionsForTask(taskId);
      if (sessions.some((s) => s.claudeSessionId === sid && !s.archived)) promote(sid);
    } catch { /* the poll tries again */ }
  }, [taskId, promote]);
  useEffect(() => {
    if (waiting) return;
    if (execId && execId !== baseline.current && (!expectedSid.current || execId === expectedSid.current)) void promoteWhenListed(execId);
  }, [execId, promoteWhenListed, waiting]);

  // The start can be used up without this launch's session: the task had a live one
  // already, or it completed. Once the workspace is ready with no start waiting and none
  // of this launch came, show the task's session, or say there is none to wait for.
  const [noStart, setNoStart] = useState(false);
  const settled = !!ws && !waiting && (ws.state === 'ready' || ws.state === 'kept') && !ws.launch_error;
  useEffect(() => {
    if (!settled) { setNoStart(false); return; }
    const t = setTimeout(() => {
      if (done.current) return;
      if (execId) promote(execId);
      else setNoStart(true);
    }, NO_START_GRACE_MS);
    return () => clearTimeout(t);
  }, [settled, execId, promote]);

  // A missed WS event must not strand the column: poll while the workspace is
  // being made (the row, when the store does not carry it) and while its session starts.
  // Not while the start waits for the person (a failed setup, a file to allow): nothing starts then.
  const starting = ws?.state === 'ready' && !ws.launch_error && !setupWaitsForYou(ws);
  const needsRow = !storeTask;
  useEffect(() => {
    if (!starting && !needsRow) return;
    let alive = true;
    const tick = async () => {
      try {
        if (needsRow) {
          const fresh = await fetchTask(taskId).catch((err: unknown) => {
            // A column kept across a reload whose task is gone since: nothing left to wait for.
            if ((err as { status?: number }).status === 404) { if (alive) closeRef.current(); return null; }
            throw err;
          });
          if (alive && fresh) setOwnTask(fresh as Task);
        }
        if (starting) {
          const sessions = await fetchSessionsForTask(taskId);
          const fresh = sessions.find((s) => !s.archived && isThisLaunch(s.claudeSessionId, s.startedAt));
          if (alive && fresh) promote(fresh.claudeSessionId);
        }
      } catch { /* next tick */ }
    };
    const timer = setInterval(() => { void tick(); }, starting ? START_POLL_MS : POLL_MS);
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

  // A failed setup holds the session: the person fixes it, runs it again or starts anyway.
  const [setupBusy, setSetupBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const setupChoice = useCallback(async (which: 'rerun' | 'allow' | 'start', expectHash?: string) => {
    setSetupBusy(which === 'start' ? 'Starting the session…' : 'Starting setup…');
    setRetryError(null);
    try {
      const { task: next } = which === 'rerun' ? await rerunTaskSetup(taskId)
        : which === 'allow' ? await rerunTaskSetup(taskId, { allow: true, ...(expectHash ? { expectHash } : {}) })
          : await startTaskAnyway(taskId);
      setOwnTask(next);
      log.info('workspace', 'failed setup choice', { taskId, which });
    } catch (err) {
      setRetryError(err instanceof Error ? err.message : String(err));
    } finally {
      setSetupBusy(null);
    }
  }, [taskId]);

  // Dismiss after a failure gives the start up, so the task no longer asks about it.
  const dismissStart = useCallback(async () => {
    if (ws?.pending_start) {
      try { await cancelWorkspaceStart(taskId); } catch (err) { log.warn('workspace', 'dismissing the waiting start failed', { taskId, error: String(err) }); }
    }
    onClose();
  }, [ws?.pending_start, taskId, onClose]);

  // After a reload the launch's own copy is gone; the waiting start still carries the words.
  const shownMessage = message ?? ws?.pending_start?.message;
  const anchor = ws?.anchor ?? '';
  const dirName = anchor.replace(/\/+$/, '').split('/').pop() || 'workspace';
  const setupHeld = setupWaitsForYou(ws ?? undefined);
  // Held because its setup comes from a repository file nobody allowed yet: a question, not a failure.
  const asksOk = setupHeld && ws?.setup?.state === 'skipped';
  const failed = !!refused || ws?.state === 'failed' || !!ws?.launch_error || (setupHeld && !asksOk);
  // A failed setup fixed in the editor: the card shows what ran, this says what a run again runs.
  const setupFailed = setupHeld && !asksOk && ws?.setup?.state === 'failed';
  const [nowSetup, setNowSetup] = useState<{ name: string; command: string } | null>(null);
  useEffect(() => {
    if (!setupFailed || editing) return;
    let alive = true;
    fetchScripts({ task: taskId }).then((v) => {
      const s = v.setup ? v.scripts.find((x) => x.id === v.setup) : undefined;
      if (alive) setNowSetup(s ? { name: s.name, command: s.command } : null);
    }, () => { /* the card still shows what ran */ });
    return () => { alive = false; };
  }, [setupFailed, editing, taskId]);
  const setupChanged = setupFailed && nowSetup && ws?.setup && (nowSetup.name !== ws.setup.name || nowSetup.command.trim() !== ws.setup.command.trim()) ? nowSetup : null;
  const idle = noStart && !failed;
  const label = refused && ws?.state !== 'failed' ? 'The workspace could not be requested'
    : !ws ? 'Preparing workspace…'
      : ws.launch_error ? 'The workspace is ready, but the session could not start'
        : asksOk ? `Its setup comes from ${ws.setup?.source ?? 'walnut.json'}, which you have not allowed yet`
        : setupHeld ? 'Its setup script failed, so the session has not started'
        : ws.state === 'ready' && ws.setup?.state === 'running' && ws.setup.wait !== false ? 'Workspace ready. Running its setup script…'
          : idle ? 'The workspace is ready, and no session waits for it'
          // Ready with no setup on record yet: the server is still reading the project's and the repository's scripts.
          : ws.state === 'ready' && !ws.setup ? 'Workspace ready. Looking for its setup script…'
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
              {failed ? 'Failed' : asksOk ? 'Waiting for you' : 'Preparing…'}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '2px', flexShrink: 0 }}>
            <button className="session-panel-close" onClick={onClose} title="Close panel">&times;</button>
          </div>
        </div>
      </div>
      {shownMessage?.trim() && (
        <div className="pending-session-prompt">
          <div className="session-msg session-msg-user">
            <div className="session-msg-content pending-session-prompt-text">{shownMessage}</div>
          </div>
        </div>
      )}
      <div className="pending-session-body">
        {failed
          ? <div className="pending-session-error-icon">!</div>
          : idle || asksOk ? null
          : <div className="pending-session-spinner-wrap"><span className="spinner" style={{ width: 20, height: 20, borderWidth: 2, display: 'inline-block' }} /></div>}
        <div className="pending-session-info">
          <span className="pending-session-label" data-testid="workspace-preparing-label" style={failed ? { color: 'var(--color-error, #ff3b30)' } : undefined}>{label}</span>
          {ws && <span className="pending-session-path">{ws.provider_name ?? ws.provider} on {hostName(ws.host)}</span>}
          {!failed && ws?.progress && <span className="pending-session-path workspace-preparing-progress" data-testid="workspace-preparing-progress">{ws.progress}</span>}
          {failed && errorText && <span className="pending-session-path workspace-preparing-error" data-testid="workspace-preparing-error">{errorText}</span>}
          {retryError && <span className="pending-session-path workspace-preparing-error">{retryError}</span>}
          <span className="pending-session-path workspace-preparing-root" title={ws?.root ?? anchor} style={{ marginTop: 8 }}><Breakable text={ws?.root ?? anchor} /></span>
          {ws?.setup && <ScriptRunCard role="setup" run={ws.setup} openOutput={ws.setup.state === 'failed'} />}
        </div>
        {asksOk && ws?.setup && (
          <div className="pending-session-actions">
            <button className="pending-session-retry-btn" onClick={() => { void setupChoice('allow', ws.setup?.file_hash); }} disabled={!!setupBusy} data-testid="workspace-preparing-allow-setup"
              title={`Run it now, and let this ${ws.setup.source} run by itself in new workspaces until it changes`}>
              {setupBusy === 'Starting setup…' ? setupBusy : 'Allow and run setup'}
            </button>
            <button className="pending-session-dismiss-btn" onClick={() => { void setupChoice('start'); }} disabled={!!setupBusy} data-testid="workspace-preparing-start-anyway"
              title="Start the session in the workspace without running its setup">
              {setupBusy === 'Starting the session…' ? setupBusy : 'Start without it'}
            </button>
          </div>
        )}
        {setupChanged && (
          <div className="workspace-preparing-changed" data-testid="workspace-preparing-setup-changed">
            The setup changed since this run: it is now <strong>{setupChanged.name}</strong>, <code>{setupChanged.command}</code>. Run setup again runs it.
          </div>
        )}
        {setupHeld && !asksOk && (
          <div className="pending-session-actions">
            <button className="pending-session-retry-btn" onClick={() => { void setupChoice('rerun'); }} disabled={!!setupBusy} data-testid="workspace-preparing-rerun-setup">
              {setupBusy === 'Starting setup…' ? setupBusy : 'Run setup again'}
            </button>
            <button className="pending-session-dismiss-btn" onClick={() => { void setupChoice('start'); }} disabled={!!setupBusy} data-testid="workspace-preparing-start-anyway"
              title="Start the session in the workspace as it is now">
              {setupBusy === 'Starting the session…' ? setupBusy : 'Start anyway'}
            </button>
          </div>
        )}
        {setupHeld && !asksOk && ws?.setup && (
          <div className="workspace-preparing-fix" data-testid="workspace-preparing-fix">
            {ws.setup.source === 'project' && task?.project
              ? <button className="project-scripts-link" onClick={() => setEditing(true)} data-testid="workspace-preparing-edit-scripts">Edit the project's scripts…</button>
              : <span>It comes from {ws.setup.source} in the workspace: fix it there, then run setup again.</span>}
          </div>
        )}
        {editing && task?.project && (
          <ProjectScriptsDialog project={task.project} cwd={ws?.root} host={ws?.host} onClose={() => setEditing(false)} />
        )}
        {idle && (
          <div className="pending-session-actions">
            <button className="pending-session-dismiss-btn" onClick={onClose} data-testid="workspace-preparing-dismiss">Dismiss</button>
          </div>
        )}
        {failed && !setupHeld && (
          <div className="pending-session-actions">
            <button className="pending-session-retry-btn" onClick={() => { void retry(); }} disabled={retrying} data-testid="workspace-preparing-retry">
              {retrying ? 'Retrying…' : 'Retry'}
            </button>
            <button className="pending-session-dismiss-btn" onClick={() => { void dismissStart(); }} data-testid="workspace-preparing-dismiss-start"
              title="Give up this start: the task keeps its workspace, and no session starts">Dismiss</button>
          </div>
        )}
      </div>
    </div>
  );
}
