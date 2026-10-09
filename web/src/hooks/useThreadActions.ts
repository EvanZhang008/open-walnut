/**
 * Every question action (Done, Reopen, Remove, Rename, ...) in one place, so
 * the stack header, the menus and the drawer rows behave identically: the UI
 * changes in the same frame, the PATCH follows, a failure rolls back exactly the
 * touched entries and says so in the panel toast, and Undo lives in that toast.
 *
 * The WHAT is pure (planners in utils/thread-meta.ts); this hook owns the WHEN:
 * write ordering, navigation after Done/Remove, toasts, and the 400ms guard.
 */
import { useCallback, useMemo, useRef } from 'react';
import { updateSession } from '@/api/sessions';
import type { SessionThreadMetaPatch } from '@/types/session';
import type {
  ThreadActions, ThreadMetaStore, ThreadNavBridge, ThreadToastApi,
} from '@/components/sessions/thread-ui-contract';
import { ROOT_THREAD_KEY, type ThreadTree } from '@/utils/thread-tree';
import {
  ancestorsOf, descendantsOf, displayTitleOf, hiddenKeysOf, openBelow, planDone, planDoneChain,
  planDoneWithFollowUps, planEditTakeaway, planReopen, planRemove, planRename, planRestore,
  pluralFollowUps, pluralQuestions, statusOf, type MetaPlan,
} from '@/utils/thread-meta';
import { log } from '@/utils/log';

export type { ThreadActions } from '@/components/sessions/thread-ui-contract';

export interface UseThreadActionsArgs {
  sessionId: string;
  tree: ThreadTree;
  meta: ThreadMetaStore;
  toast: ThreadToastApi;
  nav: ThreadNavBridge;
  /** Markdown of a question's newest answer (the fallback takeaway's source). */
  lastAnswerOf: (key: string) => string | undefined;
  /** Keys whose answer is streaming right now. */
  answeringKeys: ReadonlySet<string>;
}

/** Verbatim failure and toast copy (spec 10). */
export const THREAD_ACTION_TEXT = {
  doneFailed: "Couldn't archive. Try again.",
  removeFailed: "Couldn't remove. Try again.",
  undoFailed: "Couldn't undo. Try again.",
  renameFailed: "Couldn't rename. Try again.",
  reopenFailed: "Couldn't reopen. Try again.",
  restoreFailed: "Couldn't restore. Try again.",
  takeawayFailed: "Couldn't save the takeaway. Try again.",
  retry: 'Retry',
  undo: 'Undo',
} as const;

export const TOAST_MS = { done: 6000, remove: 8000, info: 4000, failure: 6000 } as const;
/** A second click on the same action for the same question inside this window is ignored. */
export const DOUBLE_FIRE_MS = 400;

export const doneToastText = (title: string, above = 0): string =>
  (above > 0 ? `Archived: ${title} and ${above} above` : `Archived: ${title}`);
export const reopenToastText = (title: string): string => `Unarchived “${title}”`;
export const removeToastText = (title: string, descendants = 0): string =>
  (descendants > 0
    ? `Removed “${title}” and ${pluralFollowUps(descendants)}. The messages stay in the transcript.`
    : `Removed “${title}”. The messages stay in the transcript.`);
export const olderDoneToastText = (n: number): string => `Archived ${pluralQuestions(n).replace('question', 'older question')}`;

/** Pure guard shared by every action: true = this fire is a duplicate. */
export function isDoubleFire(last: Map<string, number>, id: string, nowMs: number, windowMs = DOUBLE_FIRE_MS): boolean {
  const prev = last.get(id);
  if (prev !== undefined && nowMs - prev < windowMs) return true;
  last.set(id, nowMs);
  return false;
}

/** Is `key` the page on screen or one of its ancestors? */
export function isOnPath(tree: ThreadTree, currentKey: string, key: string): boolean {
  if (key === ROOT_THREAD_KEY) return false;
  return currentKey === key || ancestorsOf(tree, currentKey).some((n) => n.key === key);
}

/** Nearest ancestor of `key` that stays visible once `key` is hidden. */
export function visibleLandingOf(tree: ThreadTree, key: string, hiddenBefore: ReadonlySet<string>): string {
  for (const n of ancestorsOf(tree, key)) if (!hiddenBefore.has(n.key)) return n.key;
  return ROOT_THREAD_KEY;
}

export function useThreadActions(args: UseThreadActionsArgs): ThreadActions {
  // Actions run from toasts seconds later: always read the newest args.
  const ref = useRef(args);
  ref.current = args;
  const lastFire = useRef(new Map<string, number>());
  // Every meta write from these actions is sent in order (an Undo never
  // overtakes the Done it undoes on the wire), while the UI changes at once.
  const chain = useRef<Promise<unknown>>(Promise.resolve());

  const send = useCallback((entries: SessionThreadMetaPatch[], what: string): Promise<boolean> => {
    const { sessionId, meta } = ref.current;
    if (entries.length === 0) return Promise.resolve(true);
    const staged = meta.stage(entries);
    const run = chain.current.catch(() => undefined).then(async () => {
      try {
        const record = await updateSession(sessionId, staged.body);
        staged.confirm(record);
        log.info('threads', `${what} saved`, { sessionId, headIds: entries.map((e) => e.headId) });
        return true;
      } catch (err) {
        staged.rollback();
        log.warn('threads', `${what} failed`, { sessionId, headIds: entries.map((e) => e.headId), error: String(err) });
        return false;
      }
    });
    chain.current = run;
    return run;
  }, []);

  const guard = useCallback((action: string, key: string) =>
    isDoubleFire(lastFire.current, `${action}\u0000${key}`, Date.now()), []);

  const titleOf = useCallback((key: string) => {
    const { tree, meta } = ref.current;
    return displayTitleOf(tree.byKey.get(key), meta.index).title;
  }, []);

  const doneInput = useCallback(() => ({
    lastAnswerOf: ref.current.lastAnswerOf,
    answering: ref.current.answeringKeys,
  }), []);

  /** Undo a Done-like plan: restore in this frame, re-push the page only if the
   *  user is still where Done left them; a failed Undo goes back to done. */
  const undoDone = useCallback((p: MetaPlan, repushKey: string | null, landedOn: string) => {
    const { nav, toast } = ref.current;
    const repush = repushKey !== null && nav.currentKey === landedOn;
    const write = send(p.undo, 'undo done');
    if (repush) nav.pushTo(repushKey, 'undo');
    toast.dismiss();
    void write.then((ok) => {
      if (ok) return;
      const r = ref.current;
      if (repush && r.nav.currentKey === repushKey) r.nav.popTo(landedOn, 'undo');
      r.toast.show({ text: THREAD_ACTION_TEXT.undoFailed, ms: TOAST_MS.failure });
    });
  }, [send]);

  /** Shared body of done / doneChain / doneWithFollowUps. */
  const runDone = useCallback(async (key: string, p: MetaPlan, text: string, landing: string | null, retry: () => void): Promise<boolean> => {
    const { nav, toast, sessionId, tree } = ref.current;
    if (p.keys.length === 0) return false;
    const repushKey = landing !== null ? nav.currentKey : null;
    const write = send(p.patches, 'done');
    if (landing !== null) nav.popTo(landing, 'done');
    log.info('threads', 'question done', { sessionId, headId: tree.byKey.get(key)?.headId, count: p.keys.length });
    toast.show({ text, ms: TOAST_MS.done, action: { label: THREAD_ACTION_TEXT.undo, run: () => undoDone(p, repushKey, landing ?? nav.currentKey) } });
    const ok = await write;
    if (!ok) {
      ref.current.toast.show({ text: THREAD_ACTION_TEXT.doneFailed, ms: TOAST_MS.failure, action: { label: THREAD_ACTION_TEXT.retry, run: retry } });
    }
    return ok;
  }, [send, undoDone]);

  const done = useCallback<ThreadActions['done']>(async (key) => {
    if (guard('done', key)) return false;
    const { tree, meta, nav } = ref.current;
    const p = planDone(tree, meta.index, [key], doneInput());
    const landing = nav.currentKey === key ? tree.byKey.get(key)?.parentKey ?? ROOT_THREAD_KEY : null;
    return runDone(key, p, doneToastText(titleOf(key)), landing, () => { void done(key); });
  }, [guard, doneInput, runDone, titleOf]);

  const doneChain = useCallback<ThreadActions['doneChain']>(async (key) => {
    if (guard('doneChain', key)) return false;
    const { tree, meta, nav } = ref.current;
    const p = planDoneChain(tree, meta.index, key, doneInput());
    const landing = isOnPath(tree, nav.currentKey, key) ? ROOT_THREAD_KEY : null;
    return runDone(key, p, doneToastText(titleOf(key), p.above), landing, () => { void doneChain(key); });
  }, [guard, doneInput, runDone, titleOf]);

  const doneWithFollowUps = useCallback<ThreadActions['doneWithFollowUps']>(async (key) => {
    if (guard('doneWithFollowUps', key)) return false;
    const { tree, meta, nav } = ref.current;
    const p = planDoneWithFollowUps(tree, meta.index, key, doneInput());
    const landing = isOnPath(tree, nav.currentKey, key) ? tree.byKey.get(key)?.parentKey ?? ROOT_THREAD_KEY : null;
    return runDone(key, p, doneToastText(titleOf(key)), landing, () => { void doneWithFollowUps(key); });
  }, [guard, doneInput, runDone, titleOf]);

  const markOlderDone = useCallback<ThreadActions['markOlderDone']>(async (keys) => {
    if (keys.length === 0 || guard('markOlderDone', keys.join('\u0000'))) return false;
    const { tree, meta, toast } = ref.current;
    const p = planDone(tree, meta.index, keys, { ...doneInput(), aiTakeaway: false });
    if (p.keys.length === 0) return false;
    const write = send(p.patches, 'older done');
    toast.show({
      text: olderDoneToastText(p.keys.length), ms: TOAST_MS.done,
      action: { label: THREAD_ACTION_TEXT.undo, run: () => undoDone(p, null, ROOT_THREAD_KEY) },
    });
    const ok = await write;
    if (!ok) ref.current.toast.show({ text: THREAD_ACTION_TEXT.doneFailed, ms: TOAST_MS.failure, action: { label: THREAD_ACTION_TEXT.retry, run: () => { void markOlderDone(keys); } } });
    return ok;
  }, [guard, doneInput, send, undoDone]);

  /** A one-shot write with a failure toast and no Undo. */
  const simple = useCallback(async (p: MetaPlan, what: string, failText: string, okText?: string): Promise<boolean> => {
    if (p.keys.length === 0) return false;
    const write = send(p.patches, what);
    if (okText) ref.current.toast.show({ text: okText, ms: TOAST_MS.info });
    const ok = await write;
    if (!ok) ref.current.toast.show({ text: failText, ms: TOAST_MS.failure });
    return ok;
  }, [send]);

  const reopen = useCallback<ThreadActions['reopen']>(async (key) => {
    if (guard('reopen', key)) return false;
    const { tree, meta } = ref.current;
    return simple(planReopen(tree, meta.index, key), 'reopen', THREAD_ACTION_TEXT.reopenFailed, reopenToastText(titleOf(key)));
  }, [guard, simple, titleOf]);

  const notYet = useCallback<ThreadActions['notYet']>(async (key) => {
    if (guard('notYet', key)) return false;
    const { tree, meta } = ref.current;
    return simple(planReopen(tree, meta.index, key, { notYet: true }), 'not yet', THREAD_ACTION_TEXT.reopenFailed);
  }, [guard, simple]);

  const restore = useCallback<ThreadActions['restore']>(async (key) => {
    if (guard('restore', key)) return false;
    const { tree, meta } = ref.current;
    return simple(planRestore(tree, meta.index, key), 'restore', THREAD_ACTION_TEXT.restoreFailed);
  }, [guard, simple]);

  const rename = useCallback<ThreadActions['rename']>(async (key, text) => {
    const { tree, meta } = ref.current;
    return simple(planRename(tree, meta.index, key, text), 'rename', THREAD_ACTION_TEXT.renameFailed);
  }, [simple]);

  const editTakeaway = useCallback<ThreadActions['editTakeaway']>(async (key, text) => {
    const { tree, meta } = ref.current;
    return simple(planEditTakeaway(tree, meta.index, key, text), 'takeaway edit', THREAD_ACTION_TEXT.takeawayFailed);
  }, [simple]);

  const remove = useCallback<ThreadActions['remove']>(async (key) => {
    if (guard('remove', key)) return false;
    const { tree, meta, nav, toast, sessionId } = ref.current;
    const hiddenBefore = hiddenKeysOf(tree, meta.index);
    const p = planRemove(tree, meta.index, key);
    if (p.keys.length === 0) return false;
    const title = titleOf(key);
    const onPath = isOnPath(tree, nav.currentKey, key);
    const pageBefore = nav.currentKey;
    const landing = visibleLandingOf(tree, key, hiddenBefore);
    const write = send(p.patches, 'remove');
    if (onPath) nav.popToVisibleAncestor(key);
    log.info('threads', 'question removed', { sessionId, headId: tree.byKey.get(key)?.headId, descendants: p.descendants });
    const undo = () => {
      const r = ref.current;
      const repush = onPath && r.nav.currentKey === landing;
      const back = send(p.undo, 'undo remove');
      if (repush) r.nav.pushTo(pageBefore, 'undo');
      r.toast.dismiss();
      void back.then((ok) => {
        if (ok) return;
        if (repush && ref.current.nav.currentKey === pageBefore) ref.current.nav.popToVisibleAncestor(key);
        ref.current.toast.show({ text: THREAD_ACTION_TEXT.undoFailed, ms: TOAST_MS.failure });
      });
    };
    toast.show({ text: removeToastText(title, p.descendants), ms: TOAST_MS.remove, action: { label: THREAD_ACTION_TEXT.undo, run: undo } });
    const ok = await write;
    if (!ok) ref.current.toast.show({ text: THREAD_ACTION_TEXT.removeFailed, ms: TOAST_MS.failure });
    return ok;
  }, [guard, send, titleOf]);

  const openBelowCount = useCallback<ThreadActions['openBelowCount']>((key) => {
    const { tree, meta } = ref.current;
    return openBelow(tree, key, meta.index);
  }, []);

  const visibleDescendantCount = useCallback<ThreadActions['visibleDescendantCount']>((key) => {
    const { tree, meta } = ref.current;
    return descendantsOf(tree, key, { visibleOnly: true, index: meta.index }).length;
  }, []);

  const olderKeys = useCallback<ThreadActions['olderKeys']>(() => {
    const { tree, meta } = ref.current;
    const hidden = hiddenKeysOf(tree, meta.index);
    return tree.threads
      .filter((n) => n.key !== ROOT_THREAD_KEY && !hidden.has(n.key) && statusOf(n, meta.index) === 'older')
      .map((n) => n.key);
  }, []);

  return useMemo<ThreadActions>(() => ({
    done, doneChain, doneWithFollowUps, reopen, notYet, remove, restore, rename, editTakeaway,
    markOlderDone, openBelowCount, visibleDescendantCount, olderKeys,
  }), [done, doneChain, doneWithFollowUps, reopen, notYet, remove, restore, rename, editTakeaway,
    markOlderDone, openBelowCount, visibleDescendantCount, olderKeys]);
}
