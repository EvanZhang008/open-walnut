/**
 * The batch unsubscribe checklist as data (spec 10): what can be ticked (never a mailto the account
 * cannot send, never a list already left or in flight; nothing is ticked by default, the dialog does
 * that); the words for each method; checked items appended below; the run summary.
 */
import { describe, expect, it } from 'vitest';
import {
  PICK_SENTENCE, alreadyLine, appendChecked, batchStripText, headerUnknownSentence,
  listedItems, mailtoAddress, methodText, nothingToDo, planItemKind, runStatusText, runSummary, submitLabel,
  withoutOptionSentence, checkingSentence, partialSentence, dialogTitle, type PlanItem,
} from '../../web/src/apps/mail/mail-unsub-plan-model';

function item(listKey: string, method: PlanItem['method'], extra: Partial<PlanItem> = {}): PlanItem {
  return {
    listKey, keyedBy: 'list-id', label: listKey, accountId: 'marina', messageId: `m-${listKey}`,
    method, mails: 3, canSend: true, ...extra,
  };
}

describe('what can be ticked', () => {
  it('a one-click, a web page and a sendable mailto can; a mailto the account cannot send cannot', () => {
    expect(planItemKind(item('a', 'one-click'))).toBe('checkable');
    expect(planItemKind(item('b', 'mailto'))).toBe('checkable');
    expect(planItemKind(item('c', 'link'))).toBe('checkable');
    expect(planItemKind(item('d', 'mailto', { canSend: false }))).toBe('cannot-send');
  });

  it('a list already left or still in flight is not a choice', () => {
    expect(planItemKind(item('a', 'one-click', { done: { at: 1, method: 'one-click' } }))).toBe('done');
    expect(planItemKind(item('a', 'one-click', { attempt: { status: 'in-flight', at: 1 } }))).toBe('in-flight');
  });

  it('says that the person picks and that nothing is sent before the button', () => {
    expect(PICK_SENTENCE).toBe('Tick the lists you want to leave. Nothing is sent until you press Unsubscribe.');
  });
});

describe('planItemKind and methodText (C20)', () => {
  it('names each method the way the row prints it', () => {
    expect(methodText(item('a', 'one-click'))).toBe('one-click');
    expect(methodText(item('b', 'mailto'))).toBe('email');
    expect(methodText(item('c', 'link'))).toBe('web page \u00b7 Walnut visits the page');
    expect(methodText(item('d', 'mailto', { canSend: false }))).toBe("email \u00b7 can't send from this account");
  });

  it('marks a mailto the account cannot send as a dead end, not a tickable row', () => {
    expect(planItemKind(item('d', 'mailto', { canSend: false }))).toBe('cannot-send');
    expect(planItemKind(item('a', 'one-click'))).toBe('checkable');
    expect(planItemKind(item('e', 'link', { done: { at: 1, method: 'link' } }))).toBe('done');
  });

  it('strips the scheme and the query off a mailto address', () => {
    expect(mailtoAddress('mailto:leave@lists.example.invalid?subject=unsubscribe')).toBe('leave@lists.example.invalid');
    expect(mailtoAddress(undefined)).toBeNull();
  });
});

describe('appendChecked', () => {
  it('adds new lists below and keeps listed ones where they are', () => {
    const current = [item('a', 'one-click'), item('b', 'mailto')];
    const checked = [item('c', 'one-click'), item('a', 'one-click', { mails: 9 })];
    const next = appendChecked(current, checked);
    expect(next.map((one) => one.listKey)).toEqual(['a', 'b', 'c']);
    expect(next[0]!.mails).toBe(9);
  });
});

describe('sentences', () => {
  it('lists what was already left, with dates', () => {
    const line = alreadyLine([item('Tide Tables', 'one-click', { done: { at: Date.parse('2026-09-12T12:00:00Z'), method: 'one-click' } })]);
    expect(line).toBe('Already unsubscribed: Tide Tables (Sep 12)');
    expect(alreadyLine([item('a', 'one-click')])).toBeNull();
    expect(listedItems([item('a', 'one-click', { done: { at: 1, method: 'x' } }), item('b', 'link')]).map((one) => one.listKey)).toEqual(['b']);
  });

  it('says the counts only when they are above zero', () => {
    expect(withoutOptionSentence(12)).toBe('12 senders here have no unsubscribe option Walnut knows of.');
    expect(withoutOptionSentence(0)).toBeNull();
    expect(headerUnknownSentence(40)).toBe("Walnut can't read list headers for 40 mails in this account, so some lists may be missing.");
    expect(headerUnknownSentence(0)).toBeNull();
    expect(checkingSentence(38)).toBe('Checking 38 senders for unsubscribe options\u2026');
    expect(partialSentence(30, 38)).toBe('Checked 30 of 38 senders. Open the group again to check the rest.');
    expect(dialogTitle('Newsletters & promotions')).toBe('Unsubscribe from lists in Newsletters & promotions');
  });

  it('labels the main button by how many are ticked', () => {
    expect(submitLabel(2)).toBe('Unsubscribe from 2');
    expect(submitLabel(0)).toBe('Unsubscribe');
  });

  it('has nothing to do when every list is done', () => {
    expect(nothingToDo({ items: [] })).toBe(true);
    expect(nothingToDo({ items: [item('a', 'mailto', { canSend: false })] })).toBe(false);
  });
});

describe('a running batch', () => {
  it('words each row state', () => {
    expect(runStatusText('queued')).toBe('Waiting');
    expect(runStatusText('running')).toBe('Unsubscribing\u2026');
    expect(runStatusText('done')).toBe('Done');
    expect(runStatusText('already')).toBe('Already done');
    expect(runStatusText('needs-human')).toBe('Finish on the page');
    expect(runStatusText('skipped')).toBe('Waiting');
  });

  it('sums the outcome', () => {
    expect(runSummary(['done', 'done', 'needs-human', 'failed', 'done', 'already', 'done'])).toBe('Done 5 \u00b7 Needs you 1 \u00b7 Failed 1');
    expect(runSummary(['done'])).toBe('Done 1');
  });

  it('says the strip line while running and when over', () => {
    expect(batchStripText(['done', 'running', 'queued', 'queued'], true)).toBe('Unsubscribing from 3 more lists\u2026');
    expect(batchStripText(['done', 'done', 'done', 'done', 'done', 'needs-human'], false)).toBe('Unsubscribed from 5 lists. 1 needs you.');
  });
});
