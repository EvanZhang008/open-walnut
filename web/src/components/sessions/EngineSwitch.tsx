/**
 * Switching a task's engine from its session's composer (core/sessions/engine-switch.ts).
 *
 * The picker's engine rail is unlocked for a task session. Picking another
 * engine (and its model) and closing the picker switches at once (2026-11-05, the
 * user: "it shoud directly go, after user choose model and then exist the model
 * selection ... no bs just work"): a running turn is stopped, and the task's NEW
 * session starts on the engine with the conversation. A message sent while the
 * picker still holds a pick starts the new session with it. Picking the session's
 * own engine again undoes the pick. The new session runs on the same host
 * (2026-10-30, the user: "default it only switch to the same machine"), so an
 * engine that host cannot run is greyed out in the rail, with the host's reason.
 *
 * Every panel follows the task to its new session, whichever host draws it
 * (SessionPanel follows by itself when its host does not), and a panel that opens
 * on a session a switch replaced shows the task's current one, except one opened
 * on purpose from the task's earlier sessions (markOpenedOnPurpose).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Task } from '@open-walnut/core';
import type { SessionRecord } from '@/types/session';
import { cancelEngineSwitch, switchTaskEngine, SwitchSuperseded } from '@/api/engine-switch';
import { browserGaveUp } from '@/utils/request-failure';
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

/** Sessions the user opened on purpose from a task's earlier sessions: those stay as they are. */
const openedOnPurpose = new Set<string>();
export function markOpenedOnPurpose(sessionId: string): void { openedOnPurpose.add(sessionId); }

/** A fetch that never got an answer ("Load failed", "Failed to fetch", a deadline), after every retry. */
function noAnswer(err: unknown): boolean {
  return err instanceof TypeError || browserGaveUp(err);
}

function errorText(err: unknown): string {
  const body = (err as { body?: { error?: unknown } } | null)?.body;
  if (body && typeof body.error === 'string') return body.error;
  if (noAnswer(err)) {
    return 'Walnut did not answer for 90 seconds (it may be restarting). If the engine shown here did not change, pick it again once Walnut is back';
  }
  return err instanceof Error ? err.message : String(err);
}

export function useEngineSwitchPick(opts: {
  sessionId: string;
  session: SessionRecord | null | undefined;
  task: Task | null | undefined;
  catalog: readonly EngineCatalogEntry[];
  onSessionReplaced?: (oldSessionId: string, newSessionId: string) => void;
}) {
  const { sessionId, session, task, catalog, onSessionReplaced } = opts;
  const [pick, setPick] = useState<EngineSwitchPick | null>(null);
  const pickRef = useRef<EngineSwitchPick | null>(null);
  pickRef.current = pick;
  // A switch the server refused before it began (an engine the host cannot run, say).
  const [refused, setRefused] = useState<{ engine: string; error: string; unconfirmed?: boolean } | null>(null);
  // Asked for and not yet seen on the server: the line says it starts at once.
  const [sending, setSending] = useState<string | null>(null);
  useEffect(() => { setPick(null); setRefused(null); setSending(null); }, [sessionId]);
  // An on-purpose open belongs to the panel that showed the session next (review round 3: a shared
  // mark held a second panel on it, and closing that one cleared the first's): it takes the mark,
  // and holds while it shows that session; once it moves on, the session follows again.
  const purposeRef = useRef<{ sid: string; on: boolean } | null>(null);
  if (purposeRef.current?.sid !== sessionId) purposeRef.current = { sid: sessionId, on: openedOnPurpose.delete(sessionId) };
  const onPurpose = purposeRef.current.on;
  const current = resolveEngine(session?.engine);
  // A task's own session switches; a chat lane (Ask Walnut) and a replaced session do not.
  const enabled = !!session?.taskId && !session.lane && !session.archive_reason?.startsWith('engine_switched:');
  const onProviderSwitch = useCallback((provider: string) => {
    setRefused(null);
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
  // The server's switch shown when the picker closed (an earlier one), so only a newer one ends `sending`.
  const serverIdRef = useRef<string | undefined>(undefined);
  serverIdRef.current = server?.id;
  const sentOver = useRef<string | undefined>(undefined);
  const shownSidRef = useRef(sessionId);
  shownSidRef.current = sessionId;
  useEffect(() => { watched.current = null; }, [sessionId]);
  if (server && (server.state === 'pending' || server.state === 'switching')) watched.current = server.id;
  const markSent = useCallback(() => { watched.current = 'sent'; }, []);
  // The picker closed: a pick of another engine switches now.
  const taskId = task?.id;
  const commitNow = useCallback(() => {
    const p = pickRef.current;
    if (!p || !taskId) return;
    // Taken now, so a second close in the same tick (Escape, then the anchor) posts nothing.
    pickRef.current = null;
    setPick(null);
    setSending(p.engine);
    sentOver.current = serverIdRef.current;
    watched.current = 'sent';
    log.info('engine-switch', 'picker closed on another engine: switching now', { sessionId, taskId, engine: p.engine, model: p.model });
    switchTaskEngine(taskId, p).catch((err: unknown) => {
      log.warn('engine-switch', 'switch refused', { sessionId, taskId, engine: p.engine, error: errorText(err) });
      // The panel moved on meanwhile (the switch took, and it followed), or a newer pick replaced
      // this one: this answer is not the panel's to show.
      if (shownSidRef.current !== sessionId || err instanceof SwitchSuperseded) return;
      watched.current = null;
      setSending(null);
      setRefused({ engine: p.engine, error: errorText(err), ...(noAnswer(err) ? { unconfirmed: true } : {}) });
    });
  }, [sessionId, taskId]);
  const commitRef = useRef(commitNow);
  commitRef.current = commitNow;
  // Run after React applied the close's own pick (a model row sets the model, then closes).
  const commit = useCallback(() => { setTimeout(() => commitRef.current(), 0); }, []);
  // The server took it over (switching, done or failed): its own state speaks from here.
  useEffect(() => {
    if (server && server.id !== sentOver.current && server.state !== 'pending') setSending(null);
  }, [server?.id, server?.state]);
  const newSid = task?.session_id;
  useEffect(() => {
    if (!onSessionReplaced || !newSid || newSid === sessionId) return;
    if (server?.state !== 'done' || server.session_id !== newSid) return;
    if (watched.current !== 'sent' && watched.current !== server.id) return;
    log.info('engine-switch', 'panel follows the task to its new session', { sessionId, newSessionId: newSid, taskId: task?.id });
    onSessionReplaced(sessionId, newSid);
  }, [onSessionReplaced, newSid, sessionId, server?.state, server?.session_id, task?.id]);
  // Opened on a session a switch replaced (a plugin page keeps its own session id, a link, a
  // reload): the task's current session is the one to show.
  const replacedBy = session?.archive_reason?.startsWith('engine_switched:') && session.taskId === task?.id ? newSid : undefined;
  useEffect(() => {
    if (!onSessionReplaced || !replacedBy || replacedBy === sessionId || onPurpose) return;
    log.info('engine-switch', 'panel opened on a replaced session follows the task to its current one', { sessionId, newSessionId: replacedBy, taskId: task?.id });
    onSessionReplaced(sessionId, replacedBy);
  }, [onSessionReplaced, replacedBy, sessionId, task?.id, onPurpose]);

  return {
    enabled, pick, setPick, onProviderSwitch, providerLockReason, armed, sendOptions, server, markSent, commit, refused, sending,
    clear: useCallback(() => { pickRef.current = null; setPick(null); setRefused(null); }, []),
  };
}

function engineName(catalog: readonly EngineCatalogEntry[], engine: string | undefined): string {
  return engineEntry(catalog as never, engine).displayName;
}

/** The composer's line about a switch: picked, waiting for the turn, starting, or failed. */
export function EngineSwitchLine({ pick, server, refused, sending, catalog, taskId, onUndo }: {
  pick: EngineSwitchPick | null;
  server: ServerSwitch | undefined;
  refused?: { engine: string; error: string; unconfirmed?: boolean } | null;
  /** The engine a closed picker just asked for, before the server's state arrives. */
  sending?: string | null;
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
  // The engine of the row shown (review round 4: after a switch to Pi, picking Claude Code read
  // "Pi"): the server's only for its own pending, switching or failed row.
  const serverLive = server?.state === 'pending' || server?.state === 'switching' || server?.state === 'failed';
  const toName = useMemo(() => engineName(catalog, pick?.engine ?? sending ?? (serverLive ? server?.to.engine : undefined) ?? undefined),
    [catalog, server?.to.engine, serverLive, pick?.engine, sending]);
  const held = server?.display_text ?? server?.message;
  // A move to another host (task_move) is the same switch with another host: it reads as a move.
  const moveTo = server?.move ? (!server.to.host || server.to.host === '__local__' ? 'this Mac' : server.to.host) : null;

  if (server?.state === 'pending') {
    return (
      <div className="engine-switch-line" role="status" data-testid="engine-switch-line" data-state="pending">        <span className="engine-switch-text">
          {moveTo ? <>Moves to <strong>{moveTo}</strong> when this turn ends</> : <>Switches to <strong>{toName}</strong> when this turn ends</>}{held && !moveTo ? <>, then sends: <em className="engine-switch-held">{held}</em></> : null}
        </span>
        <button type="button" className="engine-switch-btn" disabled={busy} onClick={() => void cancel(true)}>Send here instead</button>
        <button type="button" className="engine-switch-btn" disabled={busy} onClick={() => void cancel(false)}>Cancel</button>
      </div>
    );
  }
  if (server?.state === 'switching' || (sending && !pick)) {
    return (
      <div className="engine-switch-line" role="status" data-testid="engine-switch-line" data-state="switching">
        <span className="engine-switch-spinner" aria-hidden="true" />
        <span className="engine-switch-text">{moveTo
          ? <>Moving this task&apos;s work and conversation to <strong>{moveTo}</strong>…</>
          : <>Starting {toName} with this task&apos;s conversation…</>}</span>
      </div>
    );
  }
  if (server?.state === 'failed' && server.error !== 'cancelled' && dismissedFail !== server.id) {
    // The message the switch would have started with is still held: send it here, or let it go.
    return (
      <div className="engine-switch-line engine-switch-line-error" role="alert" data-testid="engine-switch-line" data-state="failed">
        <span className="engine-switch-text">
          {moveTo ? <>The move to {moveTo} did not happen: {server.error}</> : <>The switch to {toName} did not start: {server.error}. The task stays on this session.</>}
          {held && !moveTo ? <> Your message was not sent: <em className="engine-switch-held">{held}</em></> : null}
        </span>
        {held && !moveTo && <button type="button" className="engine-switch-btn" disabled={busy} onClick={() => void cancel(true)}>Send here</button>}
        <button type="button" className="engine-switch-btn" disabled={busy} onClick={() => { setDismissedFail(server.id); if (held) void cancel(false); }}>Dismiss</button>
      </div>
    );
  }
  if (refused && !pick) {
    return (
      <div className="engine-switch-line engine-switch-line-error" role="alert" data-testid="engine-switch-line" data-state="refused">
        <span className="engine-switch-text">{refused.unconfirmed
          ? <>The switch to {engineName(catalog, refused.engine)} is not confirmed: {refused.error}</>
          : <>The switch to {engineName(catalog, refused.engine)} did not start: {refused.error}</>}</span>
        <button type="button" className="engine-switch-btn" onClick={onUndo}>Dismiss</button>
      </div>
    );
  }
  if (!pick) return null;
  return (
    <div className="engine-switch-line" role="status" data-testid="engine-switch-line" data-state="picked">
      <span className="engine-switch-text">
        Switches this task to <strong>{toName}</strong> with this conversation when you close the picker.
      </span>
      <button type="button" className="engine-switch-btn" onClick={onUndo}>Undo</button>
    </div>
  );
}
