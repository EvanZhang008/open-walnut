/**
 * The Board pane's writes for the user's items: a note (`<walnut-mark>`), a
 * project status picked on the page, a read tick, a choice, a reminder. Each
 * answers the frame's request (`wn-board:ack` with its reqId) and merges the
 * route's answer into the payload. Every write goes to the board's OWNER
 * (`ownerRef`), and an answer that lands after the pane moved to another board
 * is dropped.
 *
 * A note is typed inside the frame, and the frame's document is replaced each
 * time the board's html changes (a leader's board_edit), so the frame hands
 * every keystroke's text up (`keepNoteDraft`) and the pane keeps it until it is
 * saved: a new document gets it back (`noteDrafts`, in the data message) and
 * saves it, and leaving the board saves what is still unsaved.
 */
import { useCallback, useEffect, useRef, type MutableRefObject } from 'react';
import { ApiError, apiPut } from '@/api/client';
import { log } from '@/utils/log';
import type { BoardCheck, BoardChoice, BoardMark, BoardProject, BoardReminder } from './board-model';
import { changedCheckHash, checkFromRoute } from './board-items-model';
import { boardErrorMessage, boardPath, type TaskBoardData } from './useTaskBoard';

/** The words the frame shows for a check whose point changed under the click (409 check_changed). */
export const CHECK_CHANGED_TEXT = 'This point changed since you opened it. Read it again.';

type Delivery = { state: string; reason?: string; sessionId?: string };
type ToFrame = (msg: Record<string, unknown> & { t: string }) => void;

export function useBoardItemSaves(
  ownerId: string,
  ownerRef: MutableRefObject<string>,
  toFrame: ToFrame,
  merges: Pick<TaskBoardData, 'mergeMark' | 'mergeProject' | 'mergeCheck' | 'mergeChoice' | 'mergeReminder'>,
) {
  const { mergeMark, mergeProject, mergeCheck, mergeChoice, mergeReminder } = merges;

  // Unsaved note text per mark id, for the board the pane shows.
  const drafts = useRef(new Map<string, string>());
  const keepNoteDraft = useCallback((markId: string, note: string) => { drafts.current.set(markId, note); }, []);
  const noteDrafts = useCallback(() => Object.fromEntries(drafts.current), []);
  // Leaving a board (another one, or the pane closes) saves what the frame had not saved yet.
  useEffect(() => () => {
    const left = [...drafts.current];
    drafts.current = new Map();
    for (const [markId, note] of left) {
      log.info('board', 'unsaved note saved on leave', { taskId: ownerId, markId, chars: note.length });
      apiPut(`${boardPath(ownerId)}/marks/${encodeURIComponent(markId)}`, { note }).catch((err: unknown) => {
        log.error('board', 'unsaved note save failed', { taskId: ownerId, markId, error: boardErrorMessage(err) });
      });
    }
  }, [ownerId]);

  /** Ack the frame on a failure, while the pane still shows that board. */
  const fail = useCallback((boardTask: string, reqId: string, what: string, ctx: Record<string, unknown>, err: unknown) => {
    const message = boardErrorMessage(err);
    log.error('board', `${what} failed`, { taskId: boardTask, reqId, ...ctx, error: message });
    if (ownerRef.current === boardTask) toFrame({ t: 'wn-board:ack', reqId, ok: false, error: message });
  }, [ownerRef, toFrame]);

  /** The user's note on a mark. */
  const saveMark = useCallback((reqId: string, markId: string, note: string) => {
    const boardTask = ownerRef.current;
    log.info('board', 'note saving', { taskId: boardTask, markId, reqId, chars: note.length });
    apiPut<{ mark: BoardMark | null }>(`${boardPath(boardTask)}/marks/${encodeURIComponent(markId)}`, { note })
      .then((res) => {
        log.info('board', 'note saved', { taskId: boardTask, markId, reqId, empty: !res.mark });
        if (ownerRef.current !== boardTask) return;
        if (drafts.current.get(markId) === note) drafts.current.delete(markId);
        toFrame({ t: 'wn-board:ack', reqId, ok: true, mark: res.mark ?? null });
        mergeMark(markId, res.mark ?? null);
      }).catch((err: unknown) => fail(boardTask, reqId, 'note save', { markId }, err));
  }, [ownerRef, toFrame, mergeMark, fail]);

  /** The user's status for a project: stored as theirs, and delivered to the board's session. */
  const saveProject = useCallback((reqId: string, projectId: string, status: string) => {
    const boardTask = ownerRef.current;
    log.info('board', 'project status saving', { taskId: boardTask, projectId, reqId, status });
    apiPut<{ project: BoardProject | null; delivery?: Delivery }>(
      `${boardPath(boardTask)}/projects/${encodeURIComponent(projectId)}`, { status },
    ).then((res) => {
      log.info('board', 'project status saved', {
        taskId: boardTask, projectId, reqId, status: res.project?.status ?? '',
        delivery: res.delivery?.state ?? '', deliveryReason: res.delivery?.reason ?? '', deliverySessionId: res.delivery?.sessionId ?? '',
      });
      if (ownerRef.current !== boardTask) return;
      toFrame({ t: 'wn-board:ack', reqId, ok: true, project: res.project ?? null, delivery: res.delivery ?? null });
      mergeProject(projectId, res.project ?? null);
    }).catch((err: unknown) => fail(boardTask, reqId, 'project status save', { projectId }, err));
  }, [ownerRef, toFrame, mergeProject, fail]);

  /** The user's read tick; a point that changed under the click answers 409 with its new hash. */
  const saveCheck = useCallback((reqId: string, checkId: string, read: boolean, hash: string) => {
    const boardTask = ownerRef.current;
    log.info('board', 'check saving', { taskId: boardTask, checkId, reqId, read });
    apiPut<{ check: { hash?: string; read_at?: string } | null; hash?: string }>(
      `${boardPath(boardTask)}/checks/${encodeURIComponent(checkId)}`, read ? { read, hash } : { read },
    ).then((res) => {
      const check = checkFromRoute(res, read, hash);
      log.info('board', 'check saved', { taskId: boardTask, checkId, reqId, read: check.read });
      if (ownerRef.current !== boardTask) return;
      toFrame({ t: 'wn-board:ack', reqId, ok: true, check });
      mergeCheck(checkId, check);
    }).catch((err: unknown) => {
      const current = err instanceof ApiError && err.status === 409 ? changedCheckHash(err.body) : null;
      if (!current) { fail(boardTask, reqId, 'check save', { checkId }, err); return; }
      log.error('board', 'check save failed', { taskId: boardTask, checkId, reqId, error: CHECK_CHANGED_TEXT, changed: true });
      if (ownerRef.current !== boardTask) return;
      const check: BoardCheck = { hash: current, read: false, changed: true };
      toFrame({ t: 'wn-board:ack', reqId, ok: false, error: CHECK_CHANGED_TEXT, check });
      mergeCheck(checkId, check);
    });
  }, [ownerRef, toFrame, mergeCheck, fail]);

  /** The user's answer to a choice: stored, and delivered to the board's session like a thread message. */
  const saveChoice = useCallback((reqId: string, choiceId: string, option: string) => {
    const boardTask = ownerRef.current;
    log.info('board', 'choice saving', { taskId: boardTask, choiceId, reqId, option });
    apiPut<{ choice: BoardChoice | null; delivery?: Delivery }>(
      `${boardPath(boardTask)}/choices/${encodeURIComponent(choiceId)}`, { option },
    ).then((res) => {
      log.info('board', 'choice saved', {
        taskId: boardTask, choiceId, reqId, option: res.choice?.option ?? '',
        delivery: res.delivery?.state ?? '', deliveryReason: res.delivery?.reason ?? '', deliverySessionId: res.delivery?.sessionId ?? '',
      });
      if (ownerRef.current !== boardTask) return;
      toFrame({ t: 'wn-board:ack', reqId, ok: true, choice: res.choice ?? null, delivery: res.delivery ?? null });
      mergeChoice(choiceId, res.choice ?? null);
    }).catch((err: unknown) => fail(boardTask, reqId, 'choice save', { choiceId }, err));
  }, [ownerRef, toFrame, mergeChoice, fail]);

  /**
   * The user's own words on a choice (the docked composer's Send): saved beside the
   * pick, delivered with it in one message. Resolves to null when saved, else the
   * reason (the composer keeps the text). The frame hears how far it went.
   */
  const saveChoiceText = useCallback(async (choiceId: string, text: string): Promise<string | null> => {
    const boardTask = ownerRef.current;
    log.info('board', 'choice words saving', { taskId: boardTask, choiceId, chars: text.length });
    try {
      const res = await apiPut<{ choice: BoardChoice | null; delivery?: Delivery }>(
        `${boardPath(boardTask)}/choices/${encodeURIComponent(choiceId)}`, { text },
      );
      log.info('board', 'choice words saved', {
        taskId: boardTask, choiceId, option: res.choice?.option ?? '', chars: res.choice?.text?.length ?? 0,
        delivery: res.delivery?.state ?? '', deliveryReason: res.delivery?.reason ?? '', deliverySessionId: res.delivery?.sessionId ?? '',
      });
      if (ownerRef.current === boardTask) {
        mergeChoice(choiceId, res.choice ?? null);
        toFrame({ t: 'wn-board:choice-words', id: choiceId, delivery: res.delivery ?? null });
      }
      return null;
    } catch (err) {
      const message = boardErrorMessage(err);
      log.error('board', 'choice words save failed', { taskId: boardTask, choiceId, error: message });
      return message;
    }
  }, [ownerRef, toFrame, mergeChoice]);

  /** A reminder on a choice or a thread (`at` null clears it). */
  const saveReminder = useCallback((reqId: string, target: string, at: string | null) => {
    const boardTask = ownerRef.current;
    log.info('board', 'reminder saving', { taskId: boardTask, target, reqId, at: at ?? '' });
    apiPut<{ reminder: BoardReminder | null }>(`${boardPath(boardTask)}/reminders/${encodeURIComponent(target)}`, { at })
      .then((res) => {
        log.info('board', 'reminder saved', { taskId: boardTask, target, reqId, at: res.reminder?.at ?? '' });
        if (ownerRef.current !== boardTask) return;
        toFrame({ t: 'wn-board:ack', reqId, ok: true, reminder: res.reminder ?? null });
        mergeReminder(target, res.reminder ?? null);
      }).catch((err: unknown) => fail(boardTask, reqId, 'reminder save', { target }, err));
  }, [ownerRef, toFrame, mergeReminder, fail]);

  return { saveMark, saveProject, saveCheck, saveChoice, saveChoiceText, saveReminder, keepNoteDraft, noteDrafts };
}
