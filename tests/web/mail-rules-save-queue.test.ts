/**
 * Settings > Mail rules: the save queue that keeps the panel from 409-ing itself (C63), and the
 * panel's pure sentences and editor rows (`mail-rules-model.ts`).
 *
 * The queue promises three things, each graded here with a fake clock and a fake PUT:
 * - ONE write in flight; the next one carries the `fileRev` the previous one returned as `baseRev`;
 * - moves within 600 ms become ONE write of the newest order;
 * - an immediate save after a waiting move sends the newest doc once, not twice.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COALESCE_MS, createRulesSaveQueue, RulesQueueCancelled, type RulesDoc } from '../../web/src/components/settings/sections/mail-rules-save-queue';
import {
  COPY,
  fieldOfError,
  fileErrorSentence,
  isMissingFileError,
  moveItem,
  provenanceLine,
  riskyPattern,
  RISKY_PATTERN,
  rowsOfWhen,
  whenOfRows,
} from '../../web/src/components/settings/sections/mail-rules-model';

const doc = (tag: string): RulesDoc => ({ groups: [tag], rules: [] });

function fakePut() {
  const calls: Array<{ baseRev: string; tag: string }> = [];
  const pending: Array<() => void> = [];
  let n = 0;
  const put = vi.fn((body: RulesDoc & { baseRev: string }) => {
    calls.push({ baseRev: body.baseRev, tag: body.groups[0]! });
    n += 1;
    const rev = `rev${n}`;
    return new Promise<{ rulesRev: string; fileRev: string }>((resolve) => {
      pending.push(() => resolve({ rulesRev: 'same', fileRev: rev }));
    });
  });
  const settle = async () => { const next = pending.shift(); next?.(); await Promise.resolve(); await Promise.resolve(); };
  return { put, calls, pending, settle };
}

describe('mail rules save queue', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('chains writes: one in flight, the next on the previous fileRev', async () => {
    const fake = fakePut();
    const queue = createRulesSaveQueue({ put: fake.put });
    queue.setBase('rev0');
    const first = queue.save(doc('a'));
    const second = queue.save(doc('b'));
    await Promise.resolve();
    expect(fake.calls).toEqual([{ baseRev: 'rev0', tag: 'a' }]);
    await fake.settle();
    await first;
    await vi.waitFor(() => expect(fake.calls).toHaveLength(2));
    expect(fake.calls[1]).toEqual({ baseRev: 'rev1', tag: 'b' });
    await fake.settle();
    await expect(second).resolves.toEqual({ rulesRev: 'same', fileRev: 'rev2' });
    expect(queue.base()).toBe('rev2');
    expect(queue.busy()).toBe(false);
  });

  it('folds moves within 600 ms into ONE write of the newest order', async () => {
    const fake = fakePut();
    const queue = createRulesSaveQueue({ put: fake.put });
    queue.setBase('rev0');
    const one = queue.save(doc('move1'), { coalesce: true });
    vi.advanceTimersByTime(300);
    const two = queue.save(doc('move2'), { coalesce: true });
    vi.advanceTimersByTime(COALESCE_MS - 1);
    expect(fake.calls).toHaveLength(0);
    vi.advanceTimersByTime(1);
    await Promise.resolve();
    expect(fake.calls).toEqual([{ baseRev: 'rev0', tag: 'move2' }]);
    await fake.settle();
    await expect(one).resolves.toEqual({ rulesRev: 'same', fileRev: 'rev1' });
    await expect(two).resolves.toEqual({ rulesRev: 'same', fileRev: 'rev1' });
    expect(fake.put).toHaveBeenCalledTimes(1);
  });

  it('a move while a write is in flight waits for it and chains on its answer', async () => {
    const fake = fakePut();
    const queue = createRulesSaveQueue({ put: fake.put });
    queue.setBase('rev0');
    void queue.save(doc('toggle'));
    await Promise.resolve();
    void queue.save(doc('move'), { coalesce: true });
    await fake.settle();
    vi.advanceTimersByTime(COALESCE_MS);
    await vi.waitFor(() => expect(fake.calls).toHaveLength(2));
    expect(fake.calls[1]).toEqual({ baseRev: 'rev1', tag: 'move' });
  });

  it('an immediate save replaces a waiting move (sent once, newest doc)', async () => {
    const fake = fakePut();
    const queue = createRulesSaveQueue({ put: fake.put });
    queue.setBase('rev0');
    const moved = queue.save(doc('move'), { coalesce: true });
    const edited = queue.save(doc('edit'));
    await Promise.resolve();
    expect(fake.calls).toEqual([{ baseRev: 'rev0', tag: 'edit' }]);
    await fake.settle();
    await expect(moved).resolves.toMatchObject({ fileRev: 'rev1' });
    await expect(edited).resolves.toMatchObject({ fileRev: 'rev1' });
  });

  it('a refused write rejects its callers and keeps the old base; cancel rejects a waiting doc', async () => {
    const onError = vi.fn();
    const put = vi.fn(async () => { throw Object.assign(new Error('changed'), { status: 409, body: { error: 'changed' } }); });
    const queue = createRulesSaveQueue({ put, onError });
    queue.setBase('rev0');
    await expect(queue.save(doc('a'))).rejects.toMatchObject({ status: 409 });
    expect(queue.base()).toBe('rev0');
    expect(onError).toHaveBeenCalledTimes(1);
    const waiting = queue.save(doc('b'), { coalesce: true });
    queue.cancel();
    await expect(waiting).rejects.toBeInstanceOf(RulesQueueCancelled);
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('refuses to write before the file was read (no baseRev to chain on)', async () => {
    const put = vi.fn();
    const queue = createRulesSaveQueue({ put });
    await expect(queue.save(doc('a'))).rejects.toThrow('The rules file has not been read yet.');
    expect(put).not.toHaveBeenCalled();
  });
});

describe('mail rules panel sentences', () => {
  const since = new Date(2026, 8, 28, 10, 42).getTime();

  it('places a file error on its line, or names the rule when no line is known', () => {
    expect(fileErrorSentence({ line: 7, message: 'then must name a group or Important', since }))
      .toBe('Line 7: then must name a group or Important. Walnut is still using the rules from 10:42.');
    expect(fileErrorSentence({ rule: { index: 2, id: 'r-7f3a2c' }, message: 'then must name a group or Important.', since }))
      .toBe('Rule 3 (r-7f3a2c): then must name a group or Important. Walnut is still using the rules from 10:42.');
    const missing = { message: 'The rules file is missing. Walnut is still using the rules from 10:42.', since };
    expect(fileErrorSentence(missing)).toBe(missing.message);
    expect(isMissingFileError(missing)).toBe(true);
    expect(isMissingFileError({ line: 3, message: 'x', since })).toBe(false);
  });

  it('says where a rule came from', () => {
    expect(provenanceLine({ source: 'learned', created: '2026-09-28', note: 'Pages and tickets; I read them in the pager' }))
      .toBe('Learned Sep 28 \u00b7 "Pages and tickets; I read them in the pager"');
    expect(provenanceLine({ source: 'learned', created: '2026-09-28' })).toBe('Learned Sep 28');
    expect(provenanceLine({ source: 'user' })).toBe(COPY.addedByYou);
    expect(COPY.empty).toBe('No rules yet. Use "Important\u2026" or "Not important\u2026" on a mail in Mail to teach Walnut, or add one here.');
  });

  it('moves an item within bounds only', () => {
    expect(moveItem(['a', 'b', 'c'], 2, -1)).toEqual(['a', 'c', 'b']);
    expect(moveItem(['a', 'b', 'c'], 0, -1)).toEqual(['a', 'b', 'c']);
    expect(moveItem(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'b', 'c']);
  });
});

describe('mail rule editor rows', () => {
  it('round-trips a when through rows', () => {
    let key = 0;
    const when = { from: ['issues@*', 'Survey Desk'], subject: 'Action Required', addressedToMe: false, cc: true as const, sender: 'automated' as const, account: 'ferry' };
    const rows = rowsOfWhen(when, () => ++key);
    expect(rows.map((one) => one.field)).toEqual(['from', 'subject', 'addressedToMe', 'cc', 'sender', 'account']);
    expect(whenOfRows(rows)).toEqual({ when, problems: new Map() });
  });

  it('refuses an empty rule, an empty value, a pattern that could hang, and one that does not compile', () => {
    expect(whenOfRows([]).problems.get(-1)).toMatch(/match every mail/);
    expect(whenOfRows([{ key: 1, field: 'from', value: ' ' }]).problems.get(1)).toBe('Type a value.');
    for (const risky of ['(a+)+$', '(a*)*', '(a|a)+', '(x+)\\1', '(?<n>a)\\k<n>', '(ab{2,})+']) {
      expect(riskyPattern(risky), risky).toBe(true);
      expect(whenOfRows([{ key: 2, field: 'subjectRe', value: risky }]).problems.get(2)).toBe(RISKY_PATTERN);
    }
    expect(riskyPattern('^\\[Action Required\\]')).toBe(false);
    expect(whenOfRows([{ key: 3, field: 'subjectRe', value: '(' }]).problems.get(3)).toMatch(/regular expression/);
    expect(whenOfRows([{ key: 4, field: 'subjectRe', value: '^window \\d+' }]).when).toEqual({ subject: { re: '^window \\d+' } });
    expect(RISKY_PATTERN).toBe('This pattern could take too long to run. Remove the repeated group.');
  });

  it('maps server error fields onto rows', () => {
    expect(fieldOfError('when.from')).toBe('from');
    expect(fieldOfError('rules[0].when.subject.re')).toBe('subjectRe');
    expect(fieldOfError('then')).toBe('then');
    expect(fieldOfError('groups')).toBeNull();
  });
});
