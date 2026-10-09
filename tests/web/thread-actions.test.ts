/**
 * Question actions: the pure planners (utils/thread-meta.ts) and the pure parts of
 * useThreadActions (guard, landing, toast copy). The planners decide WHAT one
 * PATCH writes and what its Undo writes back; the hook only sequences them.
 */
import { describe, it, expect } from 'vitest';
import { buildThreadTree, ROOT_THREAD_KEY, type ThreadTreeMessage } from '@/utils/thread-tree';
import {
  hiddenKeysOf, indexMeta, mergeMetaPatch, planDone, planDoneChain, planDoneWithFollowUps, planEditTakeaway,
  planRemove, planRename, planReopen, planRestore,
} from '@/utils/thread-meta';
import {
  DOUBLE_FIRE_MS, THREAD_ACTION_TEXT, doneToastText, isDoubleFire, isOnPath, olderDoneToastText, removeToastText,
  reopenToastText, visibleLandingOf,
} from '@/hooks/useThreadActions';
import type { SessionThreadMeta } from '@/types/session';
import { buildDenseSession, DENSE_PREAMBLE_QUESTION, DENSE_PREAMBLE_TAKEAWAY } from '../e2e/browser/threads-fixture';

function dense() {
  const s = buildDenseSession(Date.parse('2026-09-26T12:00:00Z'));
  const messages: ThreadTreeMessage[] = s.rows.map((r) => ({ role: r.role, msgId: r.uuid, text: r.text }));
  const tree = buildThreadTree(messages, s.threadAnchors);
  const list = s.threadMeta as SessionThreadMeta[];
  const index = indexMeta(list);
  const keyOf = (q: string) => tree.byRow.get(s.ids.head[q])!.key;
  const answerOf = (key: string) => {
    const node = tree.byKey.get(key)!;
    const last = node.turnIds[node.turnIds.length - 1];
    return s.rows[s.rows.findIndex((r) => r.uuid === last) + 1]?.text;
  };
  return { s, tree, list, index, keyOf, answerOf };
}

describe('planDone', () => {
  it('resolves with the fallback takeaway and asks for the AI one', () => {
    const { tree, index, keyOf, answerOf } = dense();
    const k = keyOf(DENSE_PREAMBLE_QUESTION);
    const p = planDone(tree, index, [k], { lastAnswerOf: answerOf });
    expect(p.patches).toEqual([{
      headId: tree.byKey.get(k)!.headId, status: 'resolved', takeaway: DENSE_PREAMBLE_TAKEAWAY,
      takeawaySource: 'fallback', takeawayState: 'pending',
    }]);
    expect(p.undo[0]).toEqual({ headId: tree.byKey.get(k)!.headId, status: 'open', takeaway: null, takeawaySource: null, takeawayState: null });
  });
  it('keeps a user or AI takeaway and sends no takeaway while the answer streams', () => {
    const { tree, index, keyOf, answerOf } = dense();
    const done = planDone(tree, index, [keyOf('Q2')], { lastAnswerOf: answerOf });
    expect(done.patches[0]).toEqual({ headId: tree.byKey.get(keyOf('Q2'))!.headId, status: 'resolved' });
    const k = keyOf('Q1');
    const streaming = planDone(tree, index, [k], { lastAnswerOf: answerOf, answering: new Set([k]) });
    expect(streaming.patches[0]).toEqual({ headId: tree.byKey.get(k)!.headId, status: 'resolved', takeawayState: 'pending' });
  });
  it('an older question (no meta) goes back to older on Undo; the batch skips the AI call', () => {
    const { tree, index, keyOf, answerOf } = dense();
    const p = planDone(tree, index, [keyOf('Q4'), keyOf('Q7')], { lastAnswerOf: answerOf, aiTakeaway: false });
    expect(p.keys).toHaveLength(2);
    expect(p.patches.every((x) => x.takeawayState === undefined && x.status === 'resolved')).toBe(true);
    expect(p.undo.every((x) => x.status === 'older')).toBe(true);
  });
  it('root is never planned', () => {
    const { tree, index, answerOf } = dense();
    expect(planDone(tree, index, [ROOT_THREAD_KEY], { lastAnswerOf: answerOf }).keys).toEqual([]);
  });
});

describe('chain and follow-up plans', () => {
  it('Archive, back to start: this and every open ancestor through depth 1, in one plan', () => {
    const { tree, index, keyOf, answerOf } = dense();
    const p = planDoneChain(tree, index, keyOf('Q26'), { lastAnswerOf: answerOf });
    expect(p.keys).toEqual([keyOf('Q26'), keyOf('Q21'), keyOf('Q11'), keyOf('Q1')]);
    expect(p.above).toBe(3);
  });
  it('a resolved ancestor is skipped, not reopened', () => {
    const { tree, list, keyOf, answerOf, s } = dense();
    const index = indexMeta(mergeMetaPatch(list, [{ headId: s.ids.head.Q11, status: 'resolved' }], 'x'));
    const p = planDoneChain(tree, index, keyOf('Q21'), { lastAnswerOf: answerOf });
    expect(p.keys).toEqual([keyOf('Q21'), keyOf('Q1')]);
    expect(p.above).toBe(1);
  });
  it('Archive all: this plus visible open descendants', () => {
    const { tree, index, keyOf, answerOf } = dense();
    const p = planDoneWithFollowUps(tree, index, keyOf('Q6'), { lastAnswerOf: answerOf });
    expect(p.keys).toEqual([keyOf('Q6'), keyOf('Q17'), keyOf('Q24'), keyOf('Q28')]);
    expect(p.below).toBe(3);
  });
});

describe('remove / restore / rename / takeaway / reopen plans', () => {
  it('Remove hides the head only and counts the visible follow-ups it takes along', () => {
    const { tree, index, keyOf } = dense();
    const p = planRemove(tree, index, keyOf('Q5'));
    expect(p.patches).toEqual([{ headId: tree.byKey.get(keyOf('Q5'))!.headId, hidden: true }]);
    expect(p.descendants).toBe(2);
    expect(p.undo).toEqual([{ headId: tree.byKey.get(keyOf('Q5'))!.headId, hidden: null }]);
    const older = planRemove(tree, index, keyOf('Q4'));
    expect(older.patches[0]).toMatchObject({ hidden: true, status: 'older' });
  });
  it('one Undo field restores the whole subtree', () => {
    const { tree, list, keyOf } = dense();
    const index = indexMeta(list);
    const p = planRemove(tree, index, keyOf('Q5'));
    const after = indexMeta(mergeMetaPatch(list, p.patches, 'x'));
    expect(hiddenKeysOf(tree, after).has(keyOf('Q15'))).toBe(true);
    const undone = indexMeta(mergeMetaPatch([...after.values()], p.undo, 'y'));
    expect(hiddenKeysOf(tree, undone).has(keyOf('Q15'))).toBe(false);
  });
  it('Restore only touches a hidden head', () => {
    const { tree, index, keyOf } = dense();
    expect(planRestore(tree, index, keyOf('Q8')).patches).toEqual([{ headId: tree.byKey.get(keyOf('Q8'))!.headId, hidden: null }]);
    expect(planRestore(tree, index, keyOf('Q1')).keys).toEqual([]);
  });
  it('Rename caps at 120; an empty rename clears the user title', () => {
    const { tree, index, keyOf } = dense();
    const k = keyOf('Q3');
    const long = planRename(tree, index, k, `  ${'n'.repeat(130)}  `);
    expect(long.patches[0]).toMatchObject({ title: 'n'.repeat(120), titleSource: 'user', titleState: 'done' });
    expect(planRename(tree, index, k, '  ').patches[0]).toEqual({ headId: tree.byKey.get(k)!.headId, title: null, titleSource: null });
    expect(planRename(tree, index, k, '').undo[0]).toMatchObject({ title: 'My note on versions', titleSource: 'user' });
  });
  it('Takeaway edit caps at 280 and marks it the user\'s', () => {
    const { tree, index, keyOf } = dense();
    const p = planEditTakeaway(tree, index, keyOf('Q2'), 't'.repeat(300));
    expect(p.patches[0]).toMatchObject({ takeaway: 't'.repeat(280), takeawaySource: 'user', takeawayState: 'done' });
  });
  it('Unarchive keeps the takeaway; Not yet also dismisses the suggestion', () => {
    const { tree, index, keyOf } = dense();
    expect(planReopen(tree, index, keyOf('Q2')).patches[0]).toEqual({ headId: tree.byKey.get(keyOf('Q2'))!.headId, status: 'open' });
    expect(planReopen(tree, index, keyOf('Q6'), { notYet: true }).patches[0]).toMatchObject({ status: 'open', suggestDismissed: true });
  });
});

describe('useThreadActions pure parts', () => {
  it('a second fire of the same action on the same question inside 400ms is ignored', () => {
    const last = new Map<string, number>();
    expect(isDoubleFire(last, 'done\u0000k', 1000)).toBe(false);
    expect(isDoubleFire(last, 'done\u0000k', 1000 + DOUBLE_FIRE_MS - 1)).toBe(true);
    expect(isDoubleFire(last, 'remove\u0000k', 1100)).toBe(false);
    expect(isDoubleFire(last, 'done\u0000k', 1000 + DOUBLE_FIRE_MS + 1)).toBe(false);
  });
  it('isOnPath and the landing after a Remove', () => {
    const { tree, index, keyOf } = dense();
    expect(isOnPath(tree, keyOf('Q26'), keyOf('Q11'))).toBe(true);
    expect(isOnPath(tree, keyOf('Q26'), keyOf('Q2'))).toBe(false);
    expect(isOnPath(tree, keyOf('Q26'), ROOT_THREAD_KEY)).toBe(false);
    const hidden = hiddenKeysOf(tree, index);
    expect(visibleLandingOf(tree, keyOf('Q21'), hidden)).toBe(keyOf('Q11'));
    expect(visibleLandingOf(tree, keyOf('Q1'), hidden)).toBe(ROOT_THREAD_KEY);
  });
  it('toast and failure copy is verbatim (spec 10)', () => {
    expect(doneToastText('Buffer flush order')).toBe('Archived: Buffer flush order');
    expect(doneToastText('Buffer flush order', 2)).toBe('Archived: Buffer flush order and 2 above');
    expect(reopenToastText('Late flush risk')).toBe('Unarchived “Late flush risk”');
    expect(removeToastText('X')).toBe('Removed “X”. The messages stay in the transcript.');
    expect(removeToastText('X', 1)).toBe('Removed “X” and 1 follow-up. The messages stay in the transcript.');
    expect(removeToastText('X', 3)).toBe('Removed “X” and 3 follow-ups. The messages stay in the transcript.');
    expect(olderDoneToastText(5)).toBe('Archived 5 older questions');
    expect(olderDoneToastText(1)).toBe('Archived 1 older question');
    expect(THREAD_ACTION_TEXT.doneFailed).toBe("Couldn't archive. Try again.");
    expect(THREAD_ACTION_TEXT.removeFailed).toBe("Couldn't remove. Try again.");
    expect(THREAD_ACTION_TEXT.undoFailed).toBe("Couldn't undo. Try again.");
    expect(THREAD_ACTION_TEXT.renameFailed).toBe("Couldn't rename. Try again.");
  });
});

describe('useSessionThreadMeta rollback (restoreEntries)', () => {
  it('a failed write rolls back only its own entries and keeps later changes', async () => {
    const { restoreEntries } = await import('@/hooks/useSessionThreadMeta');
    const before: SessionThreadMeta[] = [
      { headId: 'a', status: 'open', updatedAt: 't0' },
      { headId: 'b', status: 'open', updatedAt: 't0' },
    ];
    // Write 1 resolved `a` and created `c`; write 2 (still fine) renamed `b`.
    const current: SessionThreadMeta[] = [
      { headId: 'a', status: 'resolved', updatedAt: 't1' },
      { headId: 'b', status: 'open', title: 'Kept', updatedAt: 't2' },
      { headId: 'c', status: 'open', updatedAt: 't1' },
    ];
    const out = restoreEntries(current, before, new Set(['a', 'c']));
    expect(out).toEqual([before[0], current[1]]);
  });
});
