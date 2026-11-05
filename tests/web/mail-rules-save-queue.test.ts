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
  existingGroupLine,
  fieldOfError,
  fileErrorSentence,
  isMissingFileError,
  moveItem,
  provenanceLine,
  rowsOfWhen,
  heldPatternOf,
  PATTERN_SHOWN_CHARS,
  previewSentence,
  summaryParts,
  TEXT_FIELDS,
  whenOfRows,
} from '../../web/src/components/settings/sections/mail-rules-model';
import { movesPhrase } from '../../web/src/utils/mail-preview-moves';
import { HINT_NEEDS_MORE, HINT_SLASHES_FLAGS, PATTERN_BACKREFERENCE, PATTERN_TOO_BIG, heldPatternLine, patternTooLong } from '@open-walnut/mail-subject-pattern';

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

  it('says where a rule came from only when Walnut learned it, and its note whoever wrote it', () => {
    expect(provenanceLine({ source: 'learned', created: '2026-09-28', note: 'Club newsletters; I read them on Sundays' }))
      .toBe('Learned Sep 28 \u00b7 Club newsletters; I read them on Sundays');
    expect(provenanceLine({ source: 'learned', created: '2026-09-28' })).toBe('Learned Sep 28');
    // Every rule there is the user's unless it says otherwise: no line for one without a note.
    expect(provenanceLine({ source: 'user' })).toBe('');
    expect(provenanceLine({ source: 'user', note: 'CI noise' })).toBe('CI noise');
    expect(provenanceLine({ source: 'user', note: '  ' })).toBe('');
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
    expect(whenOfRows(rows)).toEqual({ when, problems: new Map(), off: new Map(), hints: new Map(), turnsOn: new Set() });
  });

  it('keeps text as typed where its spaces are part of what matches; trims only what the matcher ignores', () => {
    let key = 0;
    // As a hand-written file may hold them: every space where the matcher compares text as written.
    const when = { subject: { re: '^re: ' }, listId: ' list.example.invalid', message: '<id@example.invalid> ' };
    expect(whenOfRows(rowsOfWhen(when, () => ++key)).when).toEqual(when);
    expect(whenOfRows([{ key: 1, field: 'subject', value: ' re: ' }]).when).toEqual({ subject: ' re: ' });
    expect(whenOfRows([{ key: 1, field: 'subjectRe', value: '^re: ' }]).when).toEqual({ subject: { re: '^re: ' } });
    // A sender's entries and a group name: their matchers ignore edge spaces, so trimming changes nothing.
    expect(whenOfRows([{ key: 1, field: 'from', value: ' issues@*, Survey Desk ' }]).when).toEqual({ from: ['issues@*', 'Survey Desk'] });
    expect(whenOfRows([{ key: 1, field: 'group', value: ' Ticket updates ' }]).when).toEqual({ group: 'Ticket updates' });
    // Only spaces is still empty.
    expect(whenOfRows([{ key: 1, field: 'subjectRe', value: '   ' }]).problems.get(1)).toBe('Type a value.');
    // Switching between two text boxes keeps the text; a picker field starts from its own default.
    expect(TEXT_FIELDS.has('subject') && TEXT_FIELDS.has('subjectRe')).toBe(true);
    expect(TEXT_FIELDS.has('sender') || TEXT_FIELDS.has('account') || TEXT_FIELDS.has('addressedToMe')).toBe(false);
  });

  it('a pattern that runs but would not match as it seems meant to gets a warning hint, and stays savable', () => {
    const slashes = whenOfRows([{ key: 1, field: 'subjectRe', value: '/invoice/i' }]);
    expect(slashes.problems.size).toBe(0);
    expect(slashes.hints.get(1)).toEqual({ text: HINT_SLASHES_FLAGS, warn: true, fix: { label: 'Remove them', pattern: 'invoice' } });
    expect(whenOfRows([{ key: 2, field: 'subjectRe', value: 'a{1000}' }]).hints.get(2)).toEqual({ text: HINT_NEEDS_MORE, warn: true });
    expect(whenOfRows([{ key: 3, field: 'subjectRe', value: 'invoice #\\d+' }]).hints.size).toBe(0);
  });

  it('the preview says what a rule the user switched off would match, and a new group with a taken name joins it', () => {
    expect(previewSentence({ matches: 5, moves: 1 })).toBe('Matches 5 mails \u00b7 1 would move, 4 already there');
    expect(previewSentence({ matches: 1, moves: 1, partial: true })).toBe('Matches at least 1 mail');
    expect(previewSentence({ matches: 3, moves: 3 }, true)).toBe('This rule is switched off; saving keeps it off. Switched on, it would match 3 mails');
    expect(existingGroupLine('Build results')).toBe('A group named Build results already exists; this rule sends mail to it.');
  });

  it('shows a summary\'s subject pattern as code without slashes, and its target on one line', () => {
    const re = '(?=.{0,500}invoice)(?=.{0,500}paid)';
    expect(summaryParts({ summary: `Subject matches /${re}/ \u2192 Not important`, when: { subject: { re } } })).toEqual([
      { text: 'Subject matches ' }, { text: re, code: true }, { text: ' ' }, { text: '\u2192 Not important', nowrap: true },
    ]);
    // After a sender, and as an older server words every rule.
    expect(summaryParts({ summary: 'From issues@* with a subject matching /build \\d+/ \u2192 Builds', when: { from: 'issues@*', subject: { re: 'build \\d+' } } })).toEqual([
      { text: 'From issues@* with a subject matching ' }, { text: 'build \\d+', code: true }, { text: ' ' }, { text: '\u2192 Builds', nowrap: true },
    ]);
    expect(summaryParts({ summary: `Mail with a subject matching /${re}/ \u2192 Not important`, when: { subject: { re } } })[1]).toEqual({ text: re, code: true });
    // A pattern holding a slash or the word itself is still cut at its own place.
    expect(summaryParts({ summary: 'Subject matches /a\\/b matches c/ \u2192 Important', when: { subject: { re: 'a\\/b matches c' } } })[1]).toEqual({ text: 'a\\/b matches c', code: true });
    expect(summaryParts({ summary: 'From issues@*', when: { from: 'issues@*' } })).toEqual([{ text: 'From issues@*' }]);
    expect(summaryParts({ summary: 'From issues@* \u2192 Build results', when: { from: 'issues@*' } })).toEqual([
      { text: 'From issues@*' }, { text: ' ' }, { text: '\u2192 Build results', nowrap: true },
    ]);
  });

  it('shows the head of a pattern over 60 characters, the whole one in its tooltip', () => {
    const at60 = 'a'.repeat(PATTERN_SHOWN_CHARS);
    expect(summaryParts({ summary: `Subject matches /${at60}/ \u2192 Important`, when: { subject: { re: at60 } } })[1])
      .toEqual({ text: at60, code: true });
    const long = `(invoice|receipt|${'x'.repeat(80)})`;
    const parts = summaryParts({ summary: `Subject matches /${long}/ \u2192 Important`, when: { subject: { re: long } } });
    expect(parts).toEqual([
      { text: 'Subject matches ' },
      { text: `${long.slice(0, PATTERN_SHOWN_CHARS - 1)}\u2026`, code: true, full: long },
      { text: ' ' }, { text: '\u2192 Important', nowrap: true },
    ]);
    // A cut never splits a surrogate pair (test data: U+1F600 straddling the cut).
    const emoji = `${'a'.repeat(PATTERN_SHOWN_CHARS - 2)}\u{1F600}${'b'.repeat(10)}`;
    const shown = summaryParts({ summary: `Subject matches /${emoji}/`, when: { subject: { re: emoji } } })[1]!.text;
    expect(shown).toBe(`${'a'.repeat(PATTERN_SHOWN_CHARS - 2)}\u2026`);
  });

  it('says how many matched mails would move only when some are already there, the same in both previews', () => {
    expect(movesPhrase(8, 8)).toBeNull();
    expect(movesPhrase(20, 0)).toBe('all already there');
    expect(movesPhrase(1, 0)).toBe('already there');
    expect(movesPhrase(5, 1)).toBe('1 would move, 4 already there');
    expect(movesPhrase(1200, 30)).toBe('30 would move, 1,170 already there');
  });

  it('refuses an empty rule, an empty value, and a subject pattern the server would refuse, in its words', () => {
    expect(whenOfRows([]).problems.get(-1)).toMatch(/match every mail/);
    expect(whenOfRows([{ key: 1, field: 'from', value: ' ' }]).problems.get(1)).toBe('Type a value.');
    const refused: Array<[string, string]> = [
      ['(x+)\\1', PATTERN_BACKREFERENCE], ['(?<n>a)\\k<n>', PATTERN_BACKREFERENCE], ['a'.repeat(201), patternTooLong(201)],
      ['(?:a{0,100}){0,100}', PATTERN_TOO_BIG],
    ];
    for (const [value, sentence] of refused) {
      expect(whenOfRows([{ key: 2, field: 'subjectRe', value }]).problems.get(2), value).toBe(sentence);
    }
    expect(whenOfRows([{ key: 3, field: 'subjectRe', value: '(' }]).problems.get(3))
      .toBe('This pattern is not a valid regular expression: a ( has no matching ). Close it, or write \\( to match a bracket.');
    expect(patternTooLong(201)).toBe('This pattern is 201 characters; the limit is 200. Shorten it, or split it into two rules.');
    // Nested repeats run in the linear matcher: nothing to refuse.
    for (const value of ['^window \\d+', '(a+)+$', '(a|a)+', '\\[[A-Z]+-\\d+\\] .*(resolved|closed)']) {
      expect(whenOfRows([{ key: 4, field: 'subjectRe', value }])).toEqual({ when: { subject: { re: value } }, problems: new Map(), off: new Map(), hints: new Map(), turnsOn: new Set() });
    }
    expect(PATTERN_BACKREFERENCE).toBe('This pattern refers to a group by number or name (\\1, \\k<name>), which mail rules do not support. Write out the text it should match instead.');
    expect(PATTERN_TOO_BIG).toBe('This pattern repeats too many times to check quickly. Use smaller numbers in {n,m}.');
  });

  it("keeps a rule's own refused pattern, unchanged, as written; a changed one is judged as new", () => {
    const big = '(?:x{1,90}y{1,90}){40}';
    const rule = { id: 'r-big', when: { subject: { re: big } }, then: 'Important', source: 'user' as const };
    const held = heldPatternOf(rule);
    expect(held).toBe(big);
    expect(whenOfRows([{ key: 1, field: 'subjectRe', value: big }], held)).toEqual({
      when: { subject: { re: big } }, problems: new Map(), off: new Map([[1, heldPatternLine(big)]]), hints: new Map(), turnsOn: new Set(),
    });
    // Replaced by a pattern Walnut runs: saving turns the rule on.
    expect(whenOfRows([{ key: 1, field: 'subjectRe', value: 'x+y+ invoice' }], held).turnsOn).toEqual(new Set([1]));
    expect(whenOfRows([{ key: 1, field: 'subjectRe', value: 'x+y+ invoice' }]).turnsOn.size).toBe(0);
    // Said calmly, not as the error a typed pattern gets.
    expect(heldPatternLine(big)).toBe('This rule stays off until this pattern is made smaller. Use smaller numbers in {n,m}.');
    // Any pattern Walnut will not run is held the same way: invalid, too long, a back-reference.
    for (const re of ['(unclosed', 'a'.repeat(201), '(a)\\1']) {
      const judged = whenOfRows([{ key: 1, field: 'subjectRe', value: re }], heldPatternOf({ ...rule, when: { subject: { re } } }));
      expect(judged.problems.size, re).toBe(0);
      expect(judged.off.get(1), re).toBe(heldPatternLine(re));
      expect(judged.when, re).toEqual({ subject: { re } });
    }
    // Another pattern, too big too, typed in its place: refused like any new one.
    expect(whenOfRows([{ key: 1, field: 'subjectRe', value: '(?:x{1,90}y{1,90}){41}' }], held).problems.get(1)).toBe(PATTERN_TOO_BIG);
    // Without the rule's own pattern to keep, the same text is refused.
    expect(whenOfRows([{ key: 1, field: 'subjectRe', value: big }]).problems.get(1)).toBe(PATTERN_TOO_BIG);
    // A rule that is on holds nothing to keep.
    expect(heldPatternOf({ ...rule, when: { subject: { re: 'invoice \\d+' } } })).toBeUndefined();
    expect(heldPatternOf(null)).toBeUndefined();
  });

  it('maps server error fields onto rows', () => {
    expect(fieldOfError('when.from')).toBe('from');
    expect(fieldOfError('rules[0].when.subject.re')).toBe('subjectRe');
    expect(fieldOfError('then')).toBe('then');
    expect(fieldOfError('groups')).toBeNull();
  });
});
