/**
 * The session panel's Board TAB: the task's Board (one HTML page its leader
 * keeps, src/core/boards/board-store.ts) in the split column beside the chat.
 *
 * Peer of Changed / Files / Inbox: same `.session-panel-diff-col` host, same
 * `barRightSlot` contract for the panel's chat toggle.
 *
 * The html runs in a sandboxed `srcDoc` frame (allow-scripts, NEVER
 * allow-same-origin, its own CSP), with board-runtime.frame.js injected at the
 * top of its head. Everything the frame shows that Walnut owns (task chips,
 * threads, marks) comes from this component over postMessage, and every write
 * the frame asks for goes through this component to the board routes: the
 * frame itself can reach nothing. A message is accepted only from the frame's
 * own window (`event.source`).
 *
 * Task state is live: chips read the browser's task store first (the one truth
 * for a task row), the payload's refs only as the fallback.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiPost, apiPut } from '@/api/client';
import { ICON_REFRESH } from '@/components/common/Icons';
import { useTasksContextSafe } from '@/contexts/TasksContext';
import { log } from '@/utils/log';
import { locateTaskOnHome } from '@/utils/open-session';
import { resolveTaskSessionId } from '@/utils/session-status';
import { timeAgo } from '@/utils/time';
import runtimeCore from './board-runtime.frame.js?raw';
import runtimeElements from './board-elements.frame.js?raw';
import { BOARD_RUNTIME_CSS } from './board-runtime.css.ts';
import {
  BOARD_SEEN_PREFIX, advanceSeen, boardWriterLabel, buildFrameRefs, frameRefsEqual, newBoardNonce, parseSeen,
  safeExternalHref, threadAuthorIds, wrapBoardHtml,
  type BoardMark, type BoardMessage, type BoardSeen, type FrameTask, type StoreTaskLike,
} from './board-model';
import { boardErrorMessage, boardPath, useTaskBoard } from './useTaskBoard';
import '@/styles/task-board.css';

export interface TaskBoardPaneProps {
  taskId: string;
  sessionId?: string;
  /** Chat segment of the full-width bar — see SessionFileExplorer.barRightSlot. */
  barRightSlot?: ReactNode;
  onLocateTask?: (taskId: string) => void;
  onSendToSession?: (text: string) => Promise<unknown> | void;
}

export const ASK_FOR_BOARD_TEXT = 'Please start a Board for this task: read the walnut-board skill '
  + '(walnut tools call skill_read \'{"dirName":"walnut-board"}\'), write it with board_set, and keep it current.';

const ASKED_MS = 3000;
/** The frame runtime: the core first (it defines the kit the elements build on). */
const RUNTIME_SRC = `${runtimeCore}\n${runtimeElements}`;

function readSeen(taskId: string): BoardSeen {
  try { return parseSeen(window.localStorage.getItem(BOARD_SEEN_PREFIX + taskId)); } catch { return {}; }
}

function writeSeen(taskId: string, seen: BoardSeen): void {
  try { window.localStorage.setItem(BOARD_SEEN_PREFIX + taskId, JSON.stringify(seen)); } catch { /* storage unavailable */ }
}

type FrameMsg = Record<string, unknown> & { t: string };

export function TaskBoardPane({ taskId, sessionId, barRightSlot, onLocateTask, onSendToSession }: TaskBoardPaneProps) {
  const navigate = useNavigate();
  const store = useTasksContextSafe();
  const { payload, loading, error, reload, mergeMessage, mergeMark } = useTaskBoard(taskId);
  const board = payload?.board ?? null;

  const [seen, setSeen] = useState<BoardSeen>(() => readSeen(taskId));
  const drafts = useRef<Record<string, string>>({});
  const scrollY = useRef<number | null>(null);
  useEffect(() => {
    setSeen(readSeen(taskId));
    drafts.current = {};
    scrollY.current = null;
  }, [taskId]);
  const taskIdRef = useRef(taskId);
  taskIdRef.current = taskId;

  // ── Live refs: the store's row wins, the payload's copy is the fallback ──
  const storeById = useMemo(() => {
    if (!store) return null;
    const m = new Map<string, StoreTaskLike>();
    for (const t of store.tasks) m.set(t.id, t);
    return m;
  }, [store?.tasks]); // eslint-disable-line react-hooks/exhaustive-deps -- the array is the store's identity
  const refsNow = useMemo(
    () => (payload ? buildFrameRefs(payload.refs, storeById, [taskId, ...threadAuthorIds(payload.threads)]) : {}),
    [payload, storeById, taskId],
  );
  // Same content, same object: a store change elsewhere does not re-post the frame.
  const refsKept = useRef<Record<string, FrameTask>>(refsNow);
  if (refsKept.current !== refsNow && !frameRefsEqual(refsKept.current, refsNow)) refsKept.current = refsNow;
  const refs = refsKept.current;

  // ── The frame ──
  const frameRef = useRef<HTMLIFrameElement>(null);
  const frameReady = useRef(false);
  const html = board?.html ?? null;
  // One nonce per document: the frame must echo it (board-model.ts newBoardNonce).
  const nonce = useMemo(() => (html === null ? '' : newBoardNonce()), [html]);
  const srcDoc = useMemo(() => (html === null ? null : wrapBoardHtml(html, RUNTIME_SRC, BOARD_RUNTIME_CSS, nonce)), [html, nonce]);
  // A new document is not ready until it says so (its listener does not exist yet).
  useLayoutEffect(() => { frameReady.current = false; }, [srcDoc]);

  const toFrame = useCallback((msg: FrameMsg) => {
    frameRef.current?.contentWindow?.postMessage(msg, '*');
  }, []);
  const latest = useRef({ refs, threads: payload?.threads ?? {}, marks: payload?.marks ?? {}, seen });
  latest.current = { refs, threads: payload?.threads ?? {}, marks: payload?.marks ?? {}, seen };
  const postData = useCallback(() => {
    if (!frameReady.current) return;
    const l = latest.current;
    toFrame({
      t: 'wn-board:data', boardTaskId: taskIdRef.current,
      refs: l.refs, threads: l.threads, marks: l.marks, seen: l.seen, drafts: { ...drafts.current },
    });
  }, [toFrame]);
  useEffect(() => { postData(); }, [refs, payload?.threads, payload?.marks, seen, postData]);

  const openTask = useCallback((rawId: string) => {
    const ref = refs[rawId];
    const full = ref?.id ?? store?.tasks.find((t) => t.id.startsWith(rawId))?.id ?? rawId;
    log.info('board', 'task chip opened', { taskId, targetTaskId: full });
    if (onLocateTask) { onLocateTask(full); return; }
    const target = store?.tasks.find((t) => t.id === full);
    const sid = target ? resolveTaskSessionId(target) : null;
    locateTaskOnHome(full, navigate, sid ? { sessionId: sid } : (sessionId ? { sessionId } : undefined));
  }, [refs, store, taskId, onLocateTask, navigate, sessionId]);

  const postThread = useCallback((reqId: string, thread: string, text: string) => {
    const boardTask = taskIdRef.current;
    log.info('board', 'thread message sending', { taskId: boardTask, thread, reqId, chars: text.length });
    apiPost<{ message: BoardMessage; delivery?: { state: string; reason?: string; sessionId?: string } }>(
      `${boardPath(boardTask)}/threads/${encodeURIComponent(thread)}`, { text },
    ).then((res) => {
      log.info('board', 'thread message stored', {
        taskId: boardTask, thread, reqId, messageId: res.message.id,
        delivery: res.delivery?.state ?? '', deliveryReason: res.delivery?.reason ?? '', deliverySessionId: res.delivery?.sessionId ?? '',
      });
      if (taskIdRef.current !== boardTask) return;
      toFrame({ t: 'wn-board:ack', reqId, ok: true, message: res.message, delivery: res.delivery ?? null });
      mergeMessage(thread, res.message);
    }).catch((err: unknown) => {
      const message = boardErrorMessage(err);
      log.error('board', 'thread message failed', { taskId: boardTask, thread, reqId, error: message });
      if (taskIdRef.current === boardTask) toFrame({ t: 'wn-board:ack', reqId, ok: false, error: message });
    });
  }, [toFrame, mergeMessage]);

  const saveMark = useCallback((reqId: string, markId: string, state: string, note: string) => {
    const boardTask = taskIdRef.current;
    log.info('board', 'mark saving', { taskId: boardTask, markId, reqId, state });
    apiPut<{ mark: BoardMark | null }>(`${boardPath(boardTask)}/marks/${encodeURIComponent(markId)}`, { state, note })
      .then((res) => {
        log.info('board', 'mark saved', { taskId: boardTask, markId, reqId, state: res.mark?.state ?? '' });
        if (taskIdRef.current !== boardTask) return;
        toFrame({ t: 'wn-board:ack', reqId, ok: true, mark: res.mark ?? null });
        mergeMark(markId, res.mark ?? null);
      }).catch((err: unknown) => {
        const message = boardErrorMessage(err);
        log.error('board', 'mark save failed', { taskId: boardTask, markId, reqId, error: message });
        if (taskIdRef.current === boardTask) toFrame({ t: 'wn-board:ack', reqId, ok: false, error: message });
      });
  }, [toFrame, mergeMark]);

  // The latest handler, read by ONE window listener (no re-subscribe per render).
  const onFrameMessage = useRef<(d: FrameMsg) => void>(() => undefined);
  onFrameMessage.current = (d: FrameMsg) => {
    const str = (k: string) => (typeof d[k] === 'string' ? d[k] as string : '');
    switch (d.t) {
      case 'wn-board:ready':
        frameReady.current = true;
        postData();
        if (scrollY.current !== null) toFrame({ t: 'wn-board:scroll', y: scrollY.current });
        return;
      case 'wn-board:open-task':
        if (str('id')) openTask(str('id'));
        return;
      case 'wn-board:post':
        if (str('reqId') && str('thread') && str('text').trim()) postThread(str('reqId'), str('thread'), str('text'));
        return;
      case 'wn-board:mark':
        if (str('reqId') && str('id')) saveMark(str('reqId'), str('id'), str('state'), str('note'));
        return;
      case 'wn-board:seen': {
        const next = advanceSeen(seen, str('thread'), str('ts'));
        if (next) { writeSeen(taskId, next); setSeen(next); }
        return;
      }
      case 'wn-board:open-link': {
        const href = safeExternalHref(d.href);
        if (href) window.open(href, '_blank', 'noopener,noreferrer');
        return;
      }
      case 'wn-board:scroll':
        if (typeof d.y === 'number' && Number.isFinite(d.y)) scrollY.current = d.y;
        return;
      case 'wn-board:draft':
        if (!str('thread')) return;
        if (str('text')) drafts.current[str('thread')] = str('text'); else delete drafts.current[str('thread')];
        return;
      default:
    }
  };
  const nonceRef = useRef(nonce);
  nonceRef.current = nonce;
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const frame = frameRef.current;
      if (!frame || e.source !== frame.contentWindow) return;
      const d = e.data as (FrameMsg & { nonce?: unknown }) | null;
      if (!d || typeof d !== 'object' || typeof d.t !== 'string' || !d.t.startsWith('wn-board:')) return;
      if (d.nonce !== nonceRef.current) {
        log.warn('board', 'frame message without the document nonce dropped', { taskId, type: d.t });
        return;
      }
      onFrameMessage.current(d);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // ── "updated 3 min ago" stays true while the pane is open ──
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="task-board-pane" data-testid="task-board-pane">
      <div className="task-board-bar">
        <span className="task-board-bar-title">Board</span>
        {board && (
          <span className="task-board-bar-sub" title={new Date(board.updated_at).toLocaleString()} data-testid="board-meta">
            v{board.version} · updated {timeAgo(board.updated_at, { long: true })} by {boardWriterLabel(board.updated_by, taskId)}
          </span>
        )}
        <div className="task-board-bar-right">
          <button
            type="button"
            className="session-diff-refresh task-board-refresh"
            onClick={reload}
            title="Reload the board"
            aria-label="Reload the board"
            data-testid="board-refresh"
          >{ICON_REFRESH}</button>
          {barRightSlot}
        </div>
      </div>
      {error && (payload || !loading) && (
        <div className="task-board-error" role="alert" data-testid="board-error">
          <span>Couldn't load the board: {error}</span>
          <button type="button" className="btn btn-sm" onClick={reload}>Retry</button>
        </div>
      )}
      <div className="task-board-body">
        {srcDoc !== null ? (
          <iframe
            ref={frameRef}
            className="task-board-frame"
            title="Board"
            sandbox="allow-scripts"
            srcDoc={srcDoc}
          />
        ) : payload && !board ? (
          <BoardEmptyState taskId={taskId} onSendToSession={onSendToSession} />
        ) : loading ? (
          <div className="task-board-loading">Loading the board…</div>
        ) : null}
      </div>
    </div>
  );
}

/** No board yet: say what one is, and let the user ask the leader for one. */
function BoardEmptyState({ taskId, onSendToSession }: Pick<TaskBoardPaneProps, 'taskId' | 'onSendToSession'>) {
  const [state, setState] = useState<'idle' | 'sending' | 'asked'>('idle');
  const [askError, setAskError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const ask = async () => {
    setState('sending');
    setAskError(null);
    try {
      let ok = true;
      if (onSendToSession) ok = (await onSendToSession(ASK_FOR_BOARD_TEXT)) !== false;
      else await apiPost('/api/v1/messages', { to: taskId, text: ASK_FOR_BOARD_TEXT });
      if (!ok) throw new Error('The message was not sent');
      log.info('board', 'asked the leader for a board', { taskId });
      setState('asked');
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setState('idle'), ASKED_MS);
    } catch (err) {
      const message = boardErrorMessage(err);
      log.error('board', 'ask for a board failed', { taskId, error: message });
      setAskError(message);
      setState('idle');
    }
  };

  return (
    <div className="task-board-empty" data-testid="board-empty">
      <div className="task-board-empty-card">
        <div className="task-board-empty-title">No board yet.</div>
        <p className="task-board-empty-text">
          The leader of this task writes one with the walnut-board skill; the user reads it here instead of the chat.
        </p>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          data-testid="board-ask-button"
          disabled={state === 'sending'}
          onClick={() => void ask()}
        >{state === 'asked' ? 'Asked.' : 'Ask for a board'}</button>
        {askError && <div className="task-board-empty-error" role="alert">Couldn't ask: {askError}</div>}
      </div>
    </div>
  );
}
