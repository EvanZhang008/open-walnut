/**
 * The Board pane's writes for the user's items: a note (`<walnut-mark>`), a
 * project status picked on the page, a read tick, a choice, a reminder. Each
 * answers the frame's request (`wn-board:ack` with its reqId) and merges the
 * route's answer into the payload. The Overview's cards make the same status
 * and choice writes through promise twins (`setProjectStatus`, `pickChoice`). Every write goes to the board's OWNER
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

/** A card's choice write: saved (and whether the leader's session got it now), or why not. */
export type ChoiceSave = { ok: true; delivered: boolean } | { ok: false; error: string };

/** The frame's rule: queued or deferred reached the session; stored alone waits on the board. */
function deliveredNow(d: Delivery | undefined): boolean {
  return d?.state === 'queued' || d?.state === 'deferred';
}
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
  const putProject = useCallback(async (projectId: string, status: string, from: string) => {
    const boardTask = ownerRef.current;
    log.info('board', 'project status saving', { taskId: boardTask, projectId, status, from });
    const res = await apiPut<{ project: BoardProject | null; delivery?: Delivery }>(
      `${boardPath(boardTask)}/projects/${encodeURIComponent(projectId)}`, { status },
    );
    log.info('board', 'project status saved', {
      taskId: boardTask, projectId, status: res.project?.status ?? '', from,
      delivery: res.delivery?.state ?? '', deliveryReason: res.delivery?.reason ?? '', deliverySessionId: res.delivery?.sessionId ?? '',
    });
    const current = ownerRef.current === boardTask;
    if (current) mergeProject(projectId, res.project ?? null);
    return { res, current };
  }, [ownerRef, mergeProject]);

  /** The page's status pick: the frame hears how it went. */
  const saveProject = useCallback((reqId: string, projectId: string, status: string) => {
    const boardTask = ownerRef.current;
    putProject(projectId, status, 'page').then(({ res, current }) => {
      if (current) toFrame({ t: 'wn-board:ack', reqId, ok: true, project: res.project ?? null, delivery: res.delivery ?? null });
    }).catch((err: unknown) => fail(boardTask, reqId, 'project status save', { projectId }, err));
  }, [ownerRef, putProject, toFrame, fail]);

  /** The Overview card's status pick: null when saved, else the reason. */
  const setProjectStatus = useCallback(async (projectId: string, status: string): Promise<string | null> => {
    try {
      await putProject(projectId, status, 'overview');
      return null;
    } catch (err) {
      const message = boardErrorMessage(err);
      log.error('board', 'project status save failed', { taskId: ownerRef.current, projectId, from: 'overview', error: message });
      return message;
    }
  }, [ownerRef, putProject]);

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
  const putChoice = useCallback(async (choiceId: string, option: string, from: string) => {
    const boardTask = ownerRef.current;
    log.info('board', 'choice saving', { taskId: boardTask, choiceId, option, from });
    const res = await apiPut<{ choice: BoardChoice | null; delivery?: Delivery }>(
      `${boardPath(boardTask)}/choices/${encodeURIComponent(choiceId)}`, { option },
    );
    log.info('board', 'choice saved', {
      taskId: boardTask, choiceId, option: res.choice?.option ?? '', from,
      delivery: res.delivery?.state ?? '', deliveryReason: res.delivery?.reason ?? '', deliverySessionId: res.delivery?.sessionId ?? '',
    });
    const current = ownerRef.current === boardTask;
    if (current) mergeChoice(choiceId, res.choice ?? null);
    return { res, current };
  }, [ownerRef, mergeChoice]);

  /** The page's pick: the frame hears how it went. */
  const saveChoice = useCallback((reqId: string, choiceId: string, option: string) => {
    const boardTask = ownerRef.current;
    putChoice(choiceId, option, 'page').then(({ res, current }) => {
      if (current) toFrame({ t: 'wn-board:ack', reqId, ok: true, choice: res.choice ?? null, delivery: res.delivery ?? null });
    }).catch((err: unknown) => fail(boardTask, reqId, 'choice save', { choiceId }, err));
  }, [ownerRef, putChoice, toFrame, fail]);

  /** An Overview card's pick: saved, and whether the leader was told now. */
  const pickChoice = useCallback(async (choiceId: string, option: string): Promise<ChoiceSave> => {
    try {
      const { res } = await putChoice(choiceId, option, 'overview');
      return { ok: true, delivered: deliveredNow(res.delivery) };
    } catch (err) {
      const message = boardErrorMessage(err);
      log.error('board', 'choice save failed', { taskId: ownerRef.current, choiceId, from: 'overview', error: message });
      return { ok: false, error: message };
    }
  }, [ownerRef, putChoice]);

  /** The user's own words on a choice: saved beside the pick, delivered with it in one message. */
  const putChoiceWords = useCallback(async (choiceId: string, text: string, from: string) => {
    const boardTask = ownerRef.current;
    log.info('board', 'choice words saving', { taskId: boardTask, choiceId, chars: text.length, from });
    const res = await apiPut<{ choice: BoardChoice | null; delivery?: Delivery }>(
      `${boardPath(boardTask)}/choices/${encodeURIComponent(choiceId)}`, { text },
    );
    log.info('board', 'choice words saved', {
      taskId: boardTask, choiceId, option: res.choice?.option ?? '', chars: res.choice?.text?.length ?? 0, from,
      delivery: res.delivery?.state ?? '', deliveryReason: res.delivery?.reason ?? '', deliverySessionId: res.delivery?.sessionId ?? '',
    });
    if (ownerRef.current === boardTask) {
      mergeChoice(choiceId, res.choice ?? null);
      toFrame({ t: 'wn-board:choice-words', id: choiceId, delivery: res.delivery ?? null });
    }
    return res;
  }, [ownerRef, toFrame, mergeChoice]);

  /**
   * The docked composer's Send on a choice. Resolves to null when saved, else the
   * reason (the composer keeps the text). The frame hears how far it went.
   */
  const saveChoiceText = useCallback(async (choiceId: string, text: string): Promise<string | null> => {
    try {
      await putChoiceWords(choiceId, text, 'page');
      return null;
    } catch (err) {
      const message = boardErrorMessage(err);
      log.error('board', 'choice words save failed', { taskId: ownerRef.current, choiceId, error: message });
      return message;
    }
  }, [ownerRef, putChoiceWords]);

  /** An Overview card's words on a choice: saved, and whether the leader was told now. */
  const answerChoiceWords = useCallback(async (choiceId: string, text: string): Promise<ChoiceSave> => {
    try {
      const res = await putChoiceWords(choiceId, text, 'overview');
      return { ok: true, delivered: deliveredNow(res.delivery) };
    } catch (err) {
      const message = boardErrorMessage(err);
      log.error('board', 'choice words save failed', { taskId: ownerRef.current, choiceId, from: 'overview', error: message });
      return { ok: false, error: message };
    }
  }, [ownerRef, putChoiceWords]);

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

  return {
    saveMark, saveProject, setProjectStatus, saveCheck, saveChoice, pickChoice, saveChoiceText, answerChoiceWords, saveReminder,
    keepNoteDraft, noteDrafts,
  };
}
