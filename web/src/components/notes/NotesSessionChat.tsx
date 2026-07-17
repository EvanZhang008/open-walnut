import { useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import { SessionChatHistory } from '@/components/sessions/SessionChatHistory';
import { ChatInput } from '@/components/chat/ChatInput';
import { useSessionSend } from '@/hooks/useSessionSend';
import { useSlashCommands } from '@/hooks/useSlashCommands';
import { useEvent } from '@/hooks/useWebSocket';
import { fetchSession, fetchSessionsForTask } from '@/api/sessions';
import type { ImageAttachment } from '@/api/chat';
import type { SessionRecord } from '@/types/session';
import { log } from '@/utils/log';

/**
 * NotesSessionChat — a REAL Claude Code session hosted in the /notes chat
 * column. Unlike NotesChat (the embedded note-agent with note tools only),
 * this is the full CLI session pipeline: quick-start task → SESSION_START →
 * `claude -p` spawn with the user's whole config (MCP servers, skills,
 * ~/.claude, permissions). Rendering reuses the same building blocks as
 * SessionPanel / FocusDock cards: SessionChatHistory + ChatInput +
 * useSessionSend — so streaming, optimistic bubbles, tool cards and slash
 * commands all behave identically to a home-page session column.
 *
 * PERCEIVED-INSTANT START: the CLI takes seconds to spawn, so the pane never
 * shows a bare spinner. From the first paint it renders the full chat shell —
 * a live "Starting…" badge and an ENABLED input. The session is spawned with
 * an EMPTY message (init only — no auto first turn); anything typed before it
 * links is queued locally and flushed the moment the sessionId resolves
 * (task:updated event, with a fast poll as fallback).
 */

const RESOLVE_POLL_MS = 400;
const RESOLVE_TIMEOUT_MS = 60_000;

interface QueuedLocal {
  id: number;
  text: string;
  images?: ImageAttachment[];
}

interface NotesSessionChatProps {
  /** Pending mode: quick-start task whose session hasn't linked yet.
   *  May arrive AFTER mount (the pane renders before the HTTP round-trip). */
  taskId?: string;
  /** Active mode: known session (restored from a previous visit). */
  sessionId?: string;
  /** Called once the pending task resolves to a real sessionId (persist it). */
  onResolved?: (sessionId: string) => void;
  /** Called when the session turns out to be gone (restore failed) or the user ends it. */
  onGone?: () => void;
  /** The pane's mode tabs (Assistant / Claude Code), rendered in the header. */
  headerLeft?: ReactNode;
}

export function NotesSessionChat({ taskId, sessionId: knownSessionId, onResolved, onGone, headerLeft }: NotesSessionChatProps) {
  const [sessionId, setSessionId] = useState<string | null>(knownSessionId ?? null);
  const [session, setSession] = useState<SessionRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  // Messages typed before the session linked — flushed on adoption.
  const [localQueue, setLocalQueue] = useState<QueuedLocal[]>([]);
  const localIdRef = useRef(0);

  const { optimisticMsgs, send, handleMessagesDelivered, handleBatchCompleted, handleBatchFailed, retryFailed, dismissFailed, handleEditQueued, handleDeleteQueued } = useSessionSend(sessionId);
  const { items: slashCommands, search: searchSlashCommands } = useSlashCommands(session?.cwd, session?.host);

  const onResolvedRef = useRef(onResolved);
  onResolvedRef.current = onResolved;
  const onGoneRef = useRef(onGone);
  onGoneRef.current = onGone;

  const adoptSessionId = useCallback((sid: string) => {
    setSessionId((cur) => {
      if (cur) return cur;
      onResolvedRef.current?.(sid);
      return sid;
    });
  }, []);

  // ── Pending resolution: WS event (primary) + fast poll (fallback) + timeout ──
  useEvent('task:updated', (data: unknown) => {
    if (!taskId || sessionId) return;
    const d = data as { task?: { id?: string; exec_session_id?: string; plan_session_id?: string } };
    if (d.task?.id !== taskId) return;
    const sid = d.task.exec_session_id ?? d.task.plan_session_id;
    if (sid) adoptSessionId(sid);
  });

  useEffect(() => {
    if (!taskId || sessionId) return;
    let cancelled = false;
    const startedAt = Date.now();
    const timer = setInterval(async () => {
      if (Date.now() - startedAt > RESOLVE_TIMEOUT_MS) {
        clearInterval(timer);
        if (!cancelled) setError('Session timed out — Claude CLI may not be available.');
        return;
      }
      try {
        const sessions = await fetchSessionsForTask(taskId);
        const active = sessions.find(s => s.claudeSessionId && !s.archived);
        if (active && !cancelled) {
          clearInterval(timer);
          adoptSessionId(active.claudeSessionId);
        }
      } catch { /* retry on next tick */ }
    }, RESOLVE_POLL_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [taskId, sessionId, adoptSessionId]);

  // Surface spawn failures for the pending task instead of spinning forever.
  useEvent('session:error', (data: unknown) => {
    if (!taskId || sessionId) return;
    const d = data as { taskId?: string; error?: string };
    if (d.taskId === taskId) setError(d.error || 'Session failed to start');
  });

  // Flush locally-queued messages once the session links. send() enqueues to
  // the server-side disk queue, so ordering + delivery guards apply from here.
  useEffect(() => {
    if (!sessionId || localQueue.length === 0) return;
    for (const m of localQueue) send(sessionId, m.text, m.images);
    setLocalQueue([]);
  }, [sessionId, localQueue, send]);

  // ── Session metadata (cwd for image-path resolution + restore validation) ──
  useEffect(() => {
    if (!sessionId) { setSession(null); return; }
    let cancelled = false;
    fetchSession(sessionId).then((s) => {
      if (cancelled) return;
      if (!s || s.archived) {
        // Restored a stale id — the session is gone; fall back to the assistant.
        log.info('notes', 'NotesSessionChat: restored session is gone', { sessionId });
        onGoneRef.current?.();
        return;
      }
      setSession(s);
    }).catch(() => { /* transient; history fetch has its own retry */ });
    return () => { cancelled = true; };
  }, [sessionId]);

  const handleSend = useCallback((text: string, images?: ImageAttachment[]) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (sessionId) {
      send(sessionId, trimmed, images);
    } else {
      // Session still linking — queue locally, flushed on adoption.
      setLocalQueue((q) => [...q, { id: ++localIdRef.current, text: trimmed, images }]);
    }
  }, [sessionId, send]);

  // Adapt the hook's (sessionId, …) signatures to the history's per-session callbacks.
  const handleEdit = useCallback((queueId: string, newText: string) => {
    if (sessionId) handleEditQueued(sessionId, queueId, newText);
  }, [sessionId, handleEditQueued]);
  const handleDelete = useCallback((queueId: string) => {
    if (sessionId) handleDeleteQueued(sessionId, queueId);
  }, [sessionId, handleDeleteQueued]);
  const handleRetry = useCallback((queueId: string) => {
    if (sessionId) retryFailed(queueId, sessionId);
  }, [sessionId, retryFailed]);

  const pending = !sessionId && !error;
  const badge = error ? 'Error'
    : pending ? 'Starting…'
    : isStreaming ? 'Running'
    : (session?.process_status === 'error' ? 'Error' : 'Live');

  return (
    <div className="notes-chat notes-session-chat">
      <div className="notes-chat-header">
        {headerLeft}
        <span className={`notes-session-chat-badge${pending ? ' pending' : ''}`} title={session?.cwd}>
          {pending && <span className="spinner" style={{ width: 10, height: 10, borderWidth: 1.5, display: 'inline-block', marginRight: 5, verticalAlign: '-1px' }} />}
          {badge}
        </span>
      </div>

      <div className="notes-session-chat-body">
        {error ? (
          <div className="notes-chat-empty">
            <p style={{ color: 'var(--color-error, #ff3b30)' }}>{error}</p>
            <p>Verify that the Claude CLI is installed, then start a new session from the notes tree.</p>
          </div>
        ) : pending ? (
          /* Optimistic shell — full chat look from the first paint. No kickoff
             turn is sent: the CLI spawns + inits (MCP/skills) and idles. */
          <div className="session-history notes-session-chat-pending">
            {localQueue.map((m) => (
              <div key={m.id} className="session-msg session-msg-user">
                <div className="session-msg-header">
                  <span className="session-msg-role">You</span>
                  <span className="session-msg-queued-badge">Queued</span>
                </div>
                <div className="session-msg-content">
                  <div className="markdown-body">{m.text}</div>
                </div>
              </div>
            ))}
            <div className="notes-session-chat-starting-row">
              <span className="spinner" style={{ width: 13, height: 13, borderWidth: 2, display: 'inline-block' }} />
              <span>Claude Code is starting — messages you send now are queued.</span>
            </div>
          </div>
        ) : (
          <SessionChatHistory
            key={sessionId}
            sessionId={sessionId!}
            sessionCwd={session?.cwd}
            sessionHost={session?.host}
            optimisticMessages={optimisticMsgs}
            onMessagesDelivered={handleMessagesDelivered}
            onBatchCompleted={handleBatchCompleted}
            onBatchFailed={handleBatchFailed}
            onEditQueued={handleEdit}
            onDeleteQueued={handleDelete}
            onRetryFailed={handleRetry}
            onDismissFailed={dismissFailed}
            onStreamingChange={setIsStreaming}
          />
        )}
      </div>

      {!error && (
        <div className="notes-chat-input">
          <ChatInput
            onSend={handleSend}
            isStreaming={isStreaming}
            showCommands={false}
            sessionCommands={slashCommands}
            searchSessionCommands={searchSlashCommands}
            placeholder={pending ? 'Type now — sent when the session is ready…' : 'Message Claude Code… (/ for commands)'}
            draftKey={`draft:notes-cc${sessionId ? `:${sessionId}` : ''}`}
            mentionCwd={session?.cwd}
            mentionHost={session?.host}
          />
        </div>
      )}
    </div>
  );
}
