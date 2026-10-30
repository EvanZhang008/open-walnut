/**
 * Switching a task's engine from its session's composer (core/sessions/engine-switch.ts).
 *
 * The picker's engine rail is unlocked for a task session. Picking another
 * engine changes nothing yet: the composer says the next message switches, and
 * that message starts the task's NEW session on the engine (a running turn
 * finishes first). Picking the session's own engine again undoes the pick. The
 * new session runs on the same host (2026-10-30, the user: "default it only
 * switch to the same machine"), so an engine that host cannot run is greyed out
 * in the rail, with the host's reason.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Task } from '@open-walnut/core';
import type { SessionRecord } from '@/types/session';
import { cancelEngineSwitch } from '@/api/engine-switch';
import { engineEntry, hostEngineLockReason, resolveEngine } from '@/utils/engines';
import type { EngineCatalogEntry } from '@/utils/engines';
import { useHostEngineAvailability } from '@/hooks/useHostEngineAvailability';
import type { SessionSendOptions } from '@/hooks/useSessionSend';
import { log } from '@/utils/log';
import '@/styles/engine-switch.css';

export interface EngineSwitchPick {
  engine: string;
  model?: string;
  effort?: string;
}

type ServerSwitch = NonNullable<Task['engine_switch']>;

export function useEngineSwitchPick(opts: {
  sessionId: string;
  session: SessionRecord | null | undefined;
  task: Task | null | undefined;
  catalog: readonly EngineCatalogEntry[];
  onSessionReplaced?: (oldSessionId: string, newSessionId: string) => void;
}) {
  const { sessionId, session, task, catalog, onSessionReplaced } = opts;
  const [pick, setPick] = useState<EngineSwitchPick | null>(null);
  useEffect(() => { setPick(null); }, [sessionId]);
  const current = resolveEngine(session?.engine);
  // A task's own session switches; a chat lane (Ask Walnut) and a replaced session do not.
  const enabled = !!session?.taskId && !session.lane && !session.archive_reason?.startsWith('engine_switched:');
  const onProviderSwitch = useCallback((provider: string) => {
    setPick(resolveEngine(provider) === current ? null : { engine: resolveEngine(provider) });
  }, [current]);
  // Greyed out: an engine the session's host cannot run (this Mac: its own probe).
  const hostEngines = useHostEngineAvailability(session?.host);
  const providerLockReason = useCallback((provider: string) => (
    hostEngineLockReason(engineEntry(catalog as never, provider), session?.host, hostEngines)
  ), [catalog, session?.host, hostEngines]);
  const armed = !!pick;
  const sendOptions: SessionSendOptions | undefined = pick ? {
    switchEngine: {
      engine: pick.engine, ...(pick.model ? { model: pick.model } : {}), ...(pick.effort ? { effort: pick.effort } : {}),
    },
  } : undefined;

  // The server's side of it: a switch from THIS session that waits, runs or failed.
  const server: ServerSwitch | undefined = task?.engine_switch?.from_session_id === sessionId ? task.engine_switch : undefined;

  // Done: the panel becomes the task's new session, when this panel watched the
  // switch happen. An earlier session opened later from its block stays open.
  const watched = useRef<string | null>(null);
  useEffect(() => { watched.current = null; }, [sessionId]);
  if (server && (server.state === 'pending' || server.state === 'switching')) watched.current = server.id;
  const markSent = useCallback(() => { watched.current = 'sent'; }, []);
  const newSid = task?.session_id;
  useEffect(() => {
    if (!onSessionReplaced || !newSid || newSid === sessionId) return;
    if (server?.state !== 'done' || server.session_id !== newSid) return;
    if (watched.current !== 'sent' && watched.current !== server.id) return;
    log.info('engine-switch', 'panel follows the task to its new session', { sessionId, newSessionId: newSid, taskId: task?.id });
    onSessionReplaced(sessionId, newSid);
  }, [onSessionReplaced, newSid, sessionId, server?.state, server?.session_id, task?.id]);

  return {
    enabled, pick, setPick, onProviderSwitch, providerLockReason, armed, sendOptions, server, markSent,
    clear: useCallback(() => setPick(null), []),
  };
}

function engineName(catalog: readonly EngineCatalogEntry[], engine: string | undefined): string {
  return engineEntry(catalog as never, engine).displayName;
}

/** The composer's line about a switch: picked, waiting for the turn, starting, or failed. */
export function EngineSwitchLine({ pick, server, catalog, taskId, onUndo }: {
  pick: EngineSwitchPick | null;
  server: ServerSwitch | undefined;
  catalog: readonly EngineCatalogEntry[];
  taskId?: string;
  onUndo: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [dismissedFail, setDismissedFail] = useState<string | null>(null);
  const cancel = useCallback(async (deliver: boolean) => {
    if (!taskId) return;
    setBusy(true);
    try { await cancelEngineSwitch(taskId, deliver); } catch (err) {
      log.warn('engine-switch', 'cancel failed', { taskId, error: err instanceof Error ? err.message : String(err) });
    } finally { setBusy(false); }
  }, [taskId]);
  const toName = useMemo(() => engineName(catalog, server?.to.engine ?? pick?.engine), [catalog, server?.to.engine, pick?.engine]);
  const held = server?.display_text ?? server?.message;

  if (server?.state === 'pending') {
    return (
      <div className="engine-switch-line" role="status" data-testid="engine-switch-line" data-state="pending">        <span className="engine-switch-text">
          Switches to <strong>{toName}</strong> when this turn ends{held ? <>, then sends: <em className="engine-switch-held">{held}</em></> : null}
        </span>
        <button type="button" className="engine-switch-btn" disabled={busy} onClick={() => void cancel(true)}>Send here instead</button>
        <button type="button" className="engine-switch-btn" disabled={busy} onClick={() => void cancel(false)}>Cancel</button>
      </div>
    );
  }
  if (server?.state === 'switching') {
    return (
      <div className="engine-switch-line" role="status" data-testid="engine-switch-line" data-state="switching">
        <span className="engine-switch-spinner" aria-hidden="true" />
        <span className="engine-switch-text">Starting {toName} with this task&apos;s conversation…</span>
      </div>
    );
  }
  if (server?.state === 'failed' && server.error !== 'cancelled' && dismissedFail !== server.id) {
    // The message the switch would have started with is still held: send it here, or let it go.
    return (
      <div className="engine-switch-line engine-switch-line-error" role="alert" data-testid="engine-switch-line" data-state="failed">
        <span className="engine-switch-text">
          The switch to {toName} did not start: {server.error}. The task stays on this session.
          {held ? <> Your message was not sent: <em className="engine-switch-held">{held}</em></> : null}
        </span>
        {held && <button type="button" className="engine-switch-btn" disabled={busy} onClick={() => void cancel(true)}>Send here</button>}
        <button type="button" className="engine-switch-btn" disabled={busy} onClick={() => { setDismissedFail(server.id); if (held) void cancel(false); }}>Dismiss</button>
      </div>
    );
  }
  if (!pick) return null;
  return (
    <div className="engine-switch-line" role="status" data-testid="engine-switch-line" data-state="picked">
      <span className="engine-switch-text">
        Your next message switches this task to <strong>{toName}</strong>, with this conversation.
      </span>
      <button type="button" className="engine-switch-btn" onClick={onUndo}>Undo</button>
    </div>
  );
}
