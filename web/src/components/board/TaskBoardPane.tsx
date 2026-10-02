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
 *
 * A worker and its leader share ONE board: the payload names its owner
 * (`board_task_id`), and the owner, never the session's own task, is where every
 * write goes, whose events reload, and whose seen record and drafts are kept.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, apiDelete, apiPost, apiPut } from '@/api/client';
import { ICON_REFRESH } from '@/components/common/Icons';
import { useTasksContextSafe } from '@/contexts/TasksContext';
import { log } from '@/utils/log';
import { locateTaskOnHome } from '@/utils/open-session';
import { resolveTaskSessionId } from '@/utils/session-status';
import { timeAgo } from '@/utils/time';
import runtimeCore from './board-runtime.frame.js?raw';
import runtimeMarkdown from './board-markdown.frame.js?raw';
import runtimeElements from './board-elements.frame.js?raw';
import runtimeItems from './board-items.frame.js?raw';
import runtimeSections from './board-sections.frame.js?raw';
import { BOARD_RUNTIME_CSS } from './board-runtime.css.ts';
import {
  BOARD_SEEN_PREFIX, advanceSeen, boardWriterLabel, buildFrameRefs, frameRefsEqual, newBoardNonce, parseSeen,
  safeExternalHref, threadAuthorIds, wrapBoardHtml,
  type BoardMessage, type BoardSectionSeen,
  type BoardSeen, type FrameTask, type StoreTaskLike,
} from './board-model';
import {
  boardBarTitle, boardOwnerId, projectTaskIds, taskLineage,
} from './board-items-model';
import { BoardReplyDock, type BoardReplyTarget } from './BoardReplyDock';
import { useBoardItemSaves } from './useBoardItemSaves';
import { boardErrorMessage, boardPath, useTaskBoard } from './useTaskBoard';
import '@/styles/task-board.css';

export interface TaskBoardPaneProps {
  taskId: string;
  sessionId?: string;
  /** Chat segment of the full-width bar — see SessionFileExplorer.barRightSlot. */
  barRightSlot?: ReactNode;
  /** A task chip opens its task beside the board (the session panel's peek); first choice. */
  onOpenTask?: (taskId: string) => void;
  onLocateTask?: (taskId: string) => void;
  onSendToSession?: (text: string) => Promise<unknown> | void;
}

export const ASK_FOR_BOARD_TEXT = 'Please start a Board for this task: read the walnut-board skill '
  + '(walnut tools call skill_read \'{"dirName":"walnut-board"}\'), write it with board_set, and keep it current.';

const ASKED_MS = 3000;
/** The frame runtime: the core first (it defines the kit), the message renderer, the elements, the items, then the sections (it hides the kit). */
const RUNTIME_SRC = `${runtimeCore}\n${runtimeMarkdown}\n${runtimeElements}\n${runtimeItems}\n${runtimeSections}`;

function readSeen(taskId: string): BoardSeen {
  try { return parseSeen(window.localStorage.getItem(BOARD_SEEN_PREFIX + taskId)); } catch { return {}; }
}

function writeSeen(taskId: string, seen: BoardSeen): void {
  try { window.localStorage.setItem(BOARD_SEEN_PREFIX + taskId, JSON.stringify(seen)); } catch { /* storage unavailable */ }
}

type FrameMsg = Record<string, unknown> & { t: string };

export function TaskBoardPane({ taskId, sessionId, barRightSlot, onOpenTask, onLocateTask, onSendToSession }: TaskBoardPaneProps) {
  const navigate = useNavigate();
  const store = useTasksContextSafe();
  const storeById = useMemo(() => {
    if (!store) return null;
    const m = new Map<string, StoreTaskLike>();
    for (const t of store.tasks) m.set(t.id, t);
    return m;
  }, [store?.tasks]); // eslint-disable-line react-hooks/exhaustive-deps -- the array is the store's identity
  // Any of these may own the board the team shares, so any of their board events may change what shows.
  const lineageKey = taskLineage(taskId, storeById).join('\n');
  const lineage = useMemo(() => lineageKey.split('\n'), [lineageKey]);
  const {
    payload, loading, error, reload, mergeMessage, dropMessage, mergeMark, mergeProject, mergeCheck, mergeChoice,
    mergeReminder, mergeSectionSeen,
  } = useTaskBoard(taskId, lineage);
  const board = payload?.board ?? null;
  // The board's owner: every write, the seen record, the reply drafts and the frame's "Leader" are its.
  const ownerId = boardOwnerId(payload, taskId);
  const ownerRef = useRef(ownerId);
  ownerRef.current = ownerId;
  const ownerTitle = payload?.board_task_title || storeById?.get(ownerId)?.title || '';
  const barTitle = boardBarTitle(ownerId, taskId, ownerTitle);

  const [seen, setSeen] = useState<BoardSeen>(() => readSeen(ownerId));
  const scrollY = useRef<number | null>(null);
  // Section hashes the frame reported seen, until the server has them (else a reload would say "never seen").
  const pendingSeen = useRef<Record<string, BoardSectionSeen>>({});
  // The docked composer: which thread it replies in (the frame's "Reply…" asks for it).
  const [reply, setReply] = useState<{ target: BoardReplyTarget; nonce: number } | null>(null);
  useEffect(() => {
    setSeen(readSeen(ownerId));
    scrollY.current = null;
    pendingSeen.current = {};
    setReply(null);
  }, [ownerId]);

  // ── Live refs: the store's row wins, the payload's copy is the fallback ──
  const refsNow = useMemo(
    () => (payload
      ? buildFrameRefs(payload.refs, storeById, [
        ownerId, taskId, ...threadAuthorIds(payload.threads), ...projectTaskIds(payload.projects),
      ])
      : {}),
    [payload, storeById, ownerId, taskId],
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
  const { saveMark, saveProject, saveCheck, saveChoice, saveChoiceText, saveReminder, keepNoteDraft, noteDrafts } = useBoardItemSaves(
    ownerId, ownerRef, toFrame, { mergeMark, mergeProject, mergeCheck, mergeChoice, mergeReminder },
  );
  const frameData = () => ({
    refs, seen,
    threads: payload?.threads ?? {}, marks: payload?.marks ?? {}, projects: payload?.projects ?? {},
    checks: payload?.checks ?? {}, choices: payload?.choices ?? {}, reminders: payload?.reminders ?? {},
    section_seen: { ...(payload?.section_seen ?? {}), ...pendingSeen.current },
    composing: reply?.target.thread ?? '',
    composing_choice: reply?.target.choice ?? '',
  });
  const latest = useRef(frameData());
  latest.current = frameData();
  const postData = useCallback(() => {
    if (!frameReady.current) return;
    toFrame({ t: 'wn-board:data', boardTaskId: ownerRef.current, ...latest.current, note_drafts: noteDrafts() });
  }, [toFrame, noteDrafts]);
  useEffect(() => { postData(); }, [
    refs, payload?.threads, payload?.marks, payload?.projects, payload?.checks, payload?.choices, payload?.reminders,
    payload?.section_seen, seen, ownerId, reply?.target.thread, reply?.target.choice, postData,
  ]);

  const openTask = useCallback((rawId: string) => {
    const ref = refs[rawId];
    const full = ref?.id ?? store?.tasks.find((t) => t.id.startsWith(rawId))?.id ?? rawId;
    log.info('board', 'task chip opened', { taskId, targetTaskId: full });
    if (onOpenTask) { onOpenTask(full); return; }
    if (onLocateTask) { onLocateTask(full); return; }
    const target = store?.tasks.find((t) => t.id === full);
    const sid = target ? resolveTaskSessionId(target) : null;
    locateTaskOnHome(full, navigate, sid ? { sessionId: sid } : (sessionId ? { sessionId } : undefined));
  }, [refs, store, taskId, onOpenTask, onLocateTask, navigate, sessionId]);

  /**
   * The docked composer's Send: the user's thread message, stored and delivered to
   * the board's session by the route. The frame shows it pending, then stored or
   * failed. Resolves to null when stored, else the reason (the composer keeps the text).
   */
  const sendFromDock = useCallback(async (thread: string, text: string): Promise<string | null> => {
    const boardTask = ownerRef.current;
    const key = `dock-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    log.info('board', 'thread message sending', { taskId: boardTask, thread, key, chars: text.length });
    toFrame({ t: 'wn-board:sending', thread, key, text });
    try {
      const res = await apiPost<{ message: BoardMessage; delivery?: { state: string; reason?: string; sessionId?: string } }>(
        `${boardPath(boardTask)}/threads/${encodeURIComponent(thread)}`, { text },
      );
      log.info('board', 'thread message stored', {
        taskId: boardTask, thread, key, messageId: res.message.id,
        delivery: res.delivery?.state ?? '', deliveryReason: res.delivery?.reason ?? '', deliverySessionId: res.delivery?.sessionId ?? '',
      });
      if (ownerRef.current === boardTask) {
        mergeMessage(thread, res.message);
        toFrame({ t: 'wn-board:sent', thread, key, message: res.message });
      }
      return null;
    } catch (err) {
      const message = boardErrorMessage(err);
      log.error('board', 'thread message failed', { taskId: boardTask, thread, key, error: message });
      if (ownerRef.current === boardTask) toFrame({ t: 'wn-board:send-failed', thread, key, error: message });
      return message;
    }
  }, [toFrame, mergeMessage]);

  /**
   * A thread's "Reply…" in the frame, or a choice's "Answer in your own words…":
   * dock the composer for it (again: focus it). A choice's box starts from the words it has.
   */
  const openReply = useCallback((thread: string, title: string, task: string, choice = '') => {
    const about = task ? refs[task]?.title || storeById?.get(task)?.title || '' : '';
    log.info('board', 'reply box opened', { taskId: ownerRef.current, thread, choiceId: choice });
    const target: BoardReplyTarget = choice
      ? { thread: '', choice, text: latest.current.choices[choice]?.text, title, aboutTitle: about || undefined }
      : { thread, title, aboutTitle: about || undefined };
    setReply((cur) => ({ target, nonce: (cur?.nonce ?? 0) + 1 }));
  }, [refs, storeById]);

  const deleteThreadMessage = useCallback((reqId: string, thread: string, messageId: string) => {
    const boardTask = ownerRef.current;
    log.info('board', 'thread message deleting', { taskId: boardTask, thread, reqId, messageId });
    const done = (how: string) => {
      log.info('board', 'thread message deleted', { taskId: boardTask, thread, reqId, messageId, how });
      if (ownerRef.current !== boardTask) return;
      toFrame({ t: 'wn-board:ack', reqId, ok: true });
      dropMessage(thread, messageId);
    };
    apiDelete<{ message: BoardMessage }>(
      `${boardPath(boardTask)}/threads/${encodeURIComponent(thread)}/messages/${encodeURIComponent(messageId)}`,
    ).then(() => done('deleted')).catch((err: unknown) => {
      // Someone else deleted it first: what the user asked for is already true.
      const code = err instanceof ApiError ? (err.body as { error?: { code?: unknown } } | undefined)?.error?.code : undefined;
      if (err instanceof ApiError && err.status === 404 && code === 'message_not_found') { done('already-gone'); return; }
      const message = boardErrorMessage(err);
      log.error('board', 'thread message delete failed', { taskId: boardTask, thread, reqId, messageId, error: message });
      if (ownerRef.current === boardTask) toFrame({ t: 'wn-board:ack', reqId, ok: false, error: message });
    });
  }, [toFrame, dropMessage]);


  /**
   * What the user last saw of a section (the frame hashes it). A first open
   * records every section at once, so the writes go one at a time.
   */
  const seenQueue = useRef<Promise<unknown>>(Promise.resolve());
  const saveSectionSeen = useCallback((sectionId: string, hash: string) => {
    const boardTask = ownerRef.current;
    const entry: BoardSectionSeen = { hash, at: new Date().toISOString() };
    pendingSeen.current[sectionId] = entry;
    seenQueue.current = seenQueue.current.then(() => apiPut<{ seen?: BoardSectionSeen | null }>(
      `${boardPath(boardTask)}/seen/${encodeURIComponent(sectionId)}`, { hash },
    )).then((res) => {
      if (ownerRef.current !== boardTask) return;
      if (pendingSeen.current[sectionId] === entry) delete pendingSeen.current[sectionId];
      mergeSectionSeen(sectionId, res?.seen?.hash ? res.seen : entry);
    }).catch((err: unknown) => {
      // Kept in the overlay: the frame does not ask again for this pane (a replica answers 501 to every write).
      log.warn('board', 'section seen not saved', { taskId: boardTask, sectionId, error: boardErrorMessage(err) });
    });
  }, [mergeSectionSeen]);

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
      case 'wn-board:delete':
        if (str('reqId') && str('thread') && str('id')) deleteThreadMessage(str('reqId'), str('thread'), str('id'));
        return;
      case 'wn-board:mark':
        if (str('reqId') && str('id')) saveMark(str('reqId'), str('id'), str('note'));
        return;
      case 'wn-board:note-draft':
        if (str('id')) keepNoteDraft(str('id'), str('note'));
        return;
      case 'wn-board:project':
        if (str('reqId') && str('id') && str('status')) saveProject(str('reqId'), str('id'), str('status'));
        return;
      case 'wn-board:check':
        if (str('reqId') && str('id') && typeof d.read === 'boolean' && (!d.read || str('hash'))) {
          saveCheck(str('reqId'), str('id'), d.read, str('hash'));
        }
        return;
      case 'wn-board:choice':
        if (str('reqId') && str('id') && str('option')) saveChoice(str('reqId'), str('id'), str('option'));
        return;
      case 'wn-board:remind':
        if (str('reqId') && str('target') && (d.at === null || str('at'))) {
          saveReminder(str('reqId'), str('target'), d.at === null ? null : str('at'));
        }
        return;
      case 'wn-board:seen-section':
        if (str('id') && str('hash')) saveSectionSeen(str('id'), str('hash'));
        return;
      case 'wn-board:seen': {
        const next = advanceSeen(seen, str('thread'), str('ts'));
        if (next) { writeSeen(ownerId, next); setSeen(next); }
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
      case 'wn-board:compose':
        if (str('thread')) openReply(str('thread'), str('title'), str('task'));
        else if (str('choice')) openReply('', str('title'), str('task'), str('choice'));
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
        <span
          className={`task-board-bar-title${barTitle.shared ? ' task-board-bar-title-shared' : ''}`}
          title={barTitle.tooltip}
          data-testid="board-title"
          data-board-task-id={ownerId}
        >{barTitle.text}</span>
        {board && (
          <span className="task-board-bar-sub" title={new Date(board.updated_at).toLocaleString()} data-testid="board-meta">
            v{board.version} · updated {timeAgo(board.updated_at, { long: true })} by {boardWriterLabel(board.updated_by, ownerId)}
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
          // No board anywhere in the tree: ask its owner (this session's composer only when that is this task).
          <BoardEmptyState taskId={ownerId} onSendToSession={ownerId === taskId ? onSendToSession : undefined} />
        ) : loading ? (
          <div className="task-board-loading">Loading the board…</div>
        ) : null}
      </div>
      {reply && board && (
        <BoardReplyDock
          boardTaskId={ownerId}
          target={reply.target}
          focusNonce={reply.nonce}
          onSend={sendFromDock}
          onAnswer={saveChoiceText}
          onClose={() => setReply(null)}
        />
      )}
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
