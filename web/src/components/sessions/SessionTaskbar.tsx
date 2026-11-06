/**
 * SessionTaskbar — Home's bar of open sessions that are not on the strip (2026-11-06,
 * the user: "like a taskbar in computer"; design A, a bar along the bottom of Home).
 *
 * A chip per minimized session, in the order it joined (drag to reorder). Its dot
 * says the session's state: red for Needs you or a prompt waiting on the user, a
 * pulse while a turn runs, a check when its task is done. A click opens it back
 * onto the strip; × closes it to the background (the session keeps running). Hover,
 * or the ^ button, opens the small card: its status line, its last reply and a
 * one-line composer, the way a watch shows a phone's conversation.
 *
 * The rules of what is a chip live in pages/sessionTaskbar.ts; this file only draws.
 */
import '@/styles/session-taskbar.css';
import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { createPortal } from 'react-dom';
import type { Task } from '@open-walnut/core';
import { needsLineText } from '@open-walnut/user-status';
import { stripMarkdown } from '@open-walnut/board-summary-text';
import { useSessionStatus } from '@/hooks/useSessionStatus';
import { useSessionSend } from '@/hooks/useSessionSend';
import { useMenuPlacement, menuPlacementStyle } from '@/hooks/useMenuPlacement';
import { fetchSessionHistory } from '@/api/sessions';
import { taskNeedsAction, taskOfSession, taskStatusLabel } from '@/utils/session-status';
import { ICON_CLOSE } from '@/components/common/Icons';
import { AnswerBox } from '@/components/common/AnswerBox';
import { log } from '@/utils/log';

export interface SessionTaskbarProps {
  chips: readonly string[];
  tasks: readonly Task[];
  onRestore: (sessionId: string) => void;
  onClose: (sessionId: string) => void;
  onMove: (sessionId: string, toIndex: number) => void;
}

type ChipState = 'needs' | 'running' | 'error' | 'done' | 'idle';

/** The hover delay before a card opens, and the grace before it closes when the pointer leaves. */
const PEEK_OPEN_MS = 350;
const PEEK_CLOSE_MS = 250;

export function SessionTaskbar({ chips, tasks, onRestore, onClose, onMove }: SessionTaskbarProps) {
  const [dragged, setDragged] = useState<string | null>(null);
  if (chips.length === 0) return null;
  const dropAt = (e: DragEvent, index: number) => {
    e.preventDefault();
    const id = dragged ?? e.dataTransfer.getData('text/x-walnut-chip');
    if (id) onMove(id, index);
    setDragged(null);
  };
  return (
    <nav className="session-taskbar" aria-label="Open sessions" data-testid="session-taskbar">
      {chips.map((sid, i) => (
        <TaskbarChip
          key={sid}
          sessionId={sid}
          task={taskOfSession(tasks, sid)}
          dragging={dragged === sid}
          onRestore={onRestore}
          onClose={onClose}
          onDragStart={(e) => { e.dataTransfer.setData('text/x-walnut-chip', sid); e.dataTransfer.effectAllowed = 'move'; setDragged(sid); }}
          onDragEnd={() => setDragged(null)}
          onDrop={(e) => dropAt(e, i)}
        />
      ))}
    </nav>
  );
}

interface ChipProps {
  sessionId: string;
  task: Task | undefined;
  dragging: boolean;
  onRestore: (sessionId: string) => void;
  onClose: (sessionId: string) => void;
  onDragStart: (e: DragEvent) => void;
  onDragEnd: () => void;
  onDrop: (e: DragEvent) => void;
}

function TaskbarChip({ sessionId, task, dragging, onRestore, onClose, onDragStart, onDragEnd, onDrop }: ChipProps) {
  const status = useSessionStatus(sessionId);
  const state: ChipState = status?.pendingPermissionTool || (task && taskNeedsAction(task)) ? 'needs'
    : status?.process_status === 'running' ? 'running'
      : status?.process_status === 'error' ? 'error'
        : task?.phase === 'COMPLETE' ? 'done' : 'idle';
  const title = task?.title || 'Session';
  const chipRef = useRef<HTMLDivElement>(null);
  // A card the pointer opened closes when the pointer leaves; one opened with ^ stays
  // until ^ again, Escape or a click outside.
  const [peek, setPeek] = useState<'none' | 'hover' | 'pinned'>('none');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTimer = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };
  const hoverOpen = () => { clearTimer(); timer.current = setTimeout(() => setPeek((p) => (p === 'none' ? 'hover' : p)), PEEK_OPEN_MS); };
  const hoverClose = () => { clearTimer(); timer.current = setTimeout(() => setPeek((p) => (p === 'hover' ? 'none' : p)), PEEK_CLOSE_MS); };
  useEffect(() => clearTimer, []);

  return (
    <div
      ref={chipRef}
      className={`session-taskbar-chip${dragging ? ' is-dragging' : ''}`}
      data-session-id={sessionId}
      data-state={state}
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
      onPointerEnter={(e) => { if (e.pointerType === 'mouse') hoverOpen(); }}
      onPointerLeave={(e) => { if (e.pointerType === 'mouse') hoverClose(); }}
    >
      <button
        type="button"
        className="session-taskbar-open"
        onClick={() => { clearTimer(); setPeek('none'); onRestore(sessionId); }}
        aria-label={`Open ${title} (${task ? taskStatusLabel(task) : state})`}
      >
        <span className="session-taskbar-dot" aria-hidden="true" />
        <span className="session-taskbar-title">{title}</span>
      </button>
      <button
        type="button"
        className="session-taskbar-peek"
        onClick={() => { clearTimer(); setPeek((p) => (p === 'pinned' ? 'none' : 'pinned')); }}
        aria-label={`Peek at ${title}`}
        aria-expanded={peek !== 'none'}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><polyline points="2,6.5 5,3.5 8,6.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
      </button>
      <button
        type="button"
        className="session-taskbar-close"
        onClick={() => { clearTimer(); setPeek('none'); onClose(sessionId); }}
        aria-label={`Close ${title} to the background`}
      >
        {ICON_CLOSE}
      </button>
      {peek !== 'none' && (
        <PeekCard
          sessionId={sessionId}
          task={task}
          title={title}
          state={state}
          anchorRef={chipRef}
          processStatus={status?.process_status ?? null}
          onOpen={() => { setPeek('none'); onRestore(sessionId); }}
          onDismiss={() => setPeek('none')}
          onPointerEnter={clearTimer}
          onPointerLeave={hoverClose}
        />
      )}
    </div>
  );
}

interface PeekCardProps {
  sessionId: string;
  task: Task | undefined;
  title: string;
  state: ChipState;
  anchorRef: React.RefObject<HTMLDivElement | null>;
  processStatus: string | null;
  onOpen: () => void;
  onDismiss: () => void;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
}

/** The watch-size card: what the session needs or where it stands, its last reply, a composer. */
function PeekCard({ sessionId, task, title, state, anchorRef, processStatus, onOpen, onDismiss, onPointerEnter, onPointerLeave }: PeekCardProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const placement = useMenuPlacement(true, anchorRef, cardRef, { align: 'start', preferSide: 'up', minHeight: 160, onAnchorLost: onDismiss });
  const lastReply = useLastReply(sessionId, processStatus);
  const { send } = useSessionSend(sessionId);
  const [draft, setDraft] = useState('');
  const [sent, setSent] = useState<'idle' | 'sending' | 'sent' | 'failed'>('idle');
  const line = task?.user_status ? (needsLineText(task.user_status) || task.user_status.now || '') : '';

  useEffect(() => {
    // Capture phase: the page's own Escape handlers (panel router, beep guard) run in bubble
    // and may consume it first.
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.isComposing) { e.stopPropagation(); onDismiss(); } };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!cardRef.current?.contains(t) && !anchorRef.current?.contains(t)) onDismiss();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onDown, true);
    return () => { window.removeEventListener('keydown', onKey, true); window.removeEventListener('pointerdown', onDown, true); };
  }, [onDismiss, anchorRef]);

  const submit = useCallback(async (raw: string) => {
    const text = raw.trim();
    if (!text || sent === 'sending') return;
    setSent('sending');
    const ok = await send(sessionId, text);
    log.info('taskbar', 'card message sent', { sessionId, ok });
    if (ok) setDraft('');
    setSent(ok ? 'sent' : 'failed');
  }, [send, sent, sessionId]);

  return createPortal(
    <div
      ref={cardRef}
      className="session-taskbar-card"
      data-state={state}
      data-testid="session-taskbar-card"
      style={menuPlacementStyle(placement)}
      onPointerDown={(e) => e.stopPropagation()}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      <div className="session-taskbar-card-head">
        <span className="session-taskbar-dot" aria-hidden="true" />
        <span className="session-taskbar-card-title">{title}</span>
        <button type="button" className="session-taskbar-card-open" onClick={onOpen}>Open</button>
      </div>
      {line && <div className="session-taskbar-card-line" data-testid="session-taskbar-card-line">{line}</div>}
      <div className="session-taskbar-card-reply" data-testid="session-taskbar-card-reply">
        {lastReply === null ? <span className="session-taskbar-card-muted">Loading…</span>
          : lastReply ? lastReply : <span className="session-taskbar-card-muted">No reply yet.</span>}
      </div>
      <AnswerBox
        className="session-taskbar-card-composer"
        testId="session-taskbar-card-input"
        sendTestId="session-taskbar-card-send"
        draftKey={`taskbar-card:${sessionId}`}
        value={draft}
        placeholder="Reply…"
        maxRows={3}
        sendLabel="Send"
        sending={sent === 'sending'}
        ariaLabel={`Message ${title}`}
        onChange={(text) => { setDraft(text); if (sent !== 'sending') setSent('idle'); }}
        onSubmit={(text) => { void submit(text); }}
      />
      {sent === 'sent' && <div className="session-taskbar-card-muted" role="status">Sent.</div>}
      {sent === 'failed' && <div className="session-taskbar-card-error" role="status">Not sent. Open the session to retry.</div>}
    </div>,
    document.body,
  );
}

/** The newest assistant text of a session; null until the first read lands. Read again when its
 *  run state changes (a turn starts or ends), keeping the last text on screen meanwhile. */
function useLastReply(sessionId: string, processStatus: string | null): string | null {
  const [reply, setReply] = useState<string | null>(null);
  useEffect(() => {
    const ac = new AbortController();
    fetchSessionHistory(sessionId, { tail: 12, signal: ac.signal })
      .then((res) => {
        const last = [...res.messages].reverse().find((m) => m.role === 'assistant' && m.text.trim());
        // One plain line of text: a watch-size card has no room for Markdown's links and code.
        setReply(last ? stripMarkdown(last.text) : '');
      })
      .catch((err: unknown) => {
        if (ac.signal.aborted) return;
        log.warn('taskbar', 'last reply read failed', { sessionId, error: String(err) });
        setReply('');
      });
    return () => ac.abort();
  }, [sessionId, processStatus]);
  return reply;
}
