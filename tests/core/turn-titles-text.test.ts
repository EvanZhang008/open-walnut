/**
 * The outline sections' pure rules (src/core/sessions/turn-titles-text.ts):
 * which rows are sections, the newest-first batch, the numbered model input,
 * the parse of the numbered answer, and the write-once merge.
 */
import { describe, it, expect } from 'vitest';
import {
  buildTurnTitlesMessage, cleanTurnTitle, MAX_TURN_TITLES, mergeTurnTitles, parseTurnTitlesAnswer, plainMessageLine,
  sectionCandidates, TURN_TITLE_BATCH, TURN_TITLE_EXCERPT_CHARS, untitledBatch, type TurnRowLike,
} from '../../src/core/sessions/turn-titles-text.js';

const user = (msgId: string, text: string, over: Partial<TurnRowLike> = {}): TurnRowLike => ({ role: 'user', msgId, text, ...over });
const reply = (msgId: string): TurnRowLike => ({ role: 'assistant', msgId, text: 'an answer' });

describe('sectionCandidates', () => {
  it('keeps main-conversation user rows in order and skips the rest', () => {
    const rows: TurnRowLike[] = [
      user('u1', 'Set up the cache layer'), reply('a1'),
      user('u2', 'skill dump', { injected: true }),
      user('u3', 'What does point 2 mean?'), reply('a3'),
      user('queue-1', 'Follow-up on point 2', { sourceUuid: 'q-src' }),
      user('u4', 'still waiting', { queued: true }),
      user('u5', '   '),
      user('u1', 'duplicate id'),
      user('u6', '<system-reminder>Walnut (hint): reply in English</system-reminder>Now write the tests'),
    ];
    const anchors = [{ msgId: 'u3' }, { msgId: 'q-src' }];
    expect(sectionCandidates(rows, anchors)).toEqual([
      { msgId: 'u1', excerpt: 'Set up the cache layer' },
      { msgId: 'u6', excerpt: 'Now write the tests' },
    ]);
  });

  it('cuts each excerpt to one line of at most the excerpt cap', () => {
    const long = `first line\n\nsecond ${'word '.repeat(200)}`;
    const [c] = sectionCandidates([user('u1', long)], undefined);
    expect(c.excerpt.includes('\n')).toBe(false);
    expect(c.excerpt.length).toBe(TURN_TITLE_EXCERPT_CHARS);
    expect(c.excerpt.startsWith('first line second word')).toBe(true);
  });

  it('keeps non-Latin text whole (test data: CJK words for "cache, what to do")', () => {
    expect(plainMessageLine('<b>\u7f13\u5b58</b>  \u600e\u4e48\u529e')).toBe('\u7f13\u5b58 \u600e\u4e48\u529e');
  });
});

describe('untitledBatch', () => {
  const candidates = Array.from({ length: 30 }, (_, i) => ({ msgId: `u${i}`, excerpt: `message ${i}` }));

  it('takes the newest untitled ones, in transcript order, capped', () => {
    const titles = [{ msgId: 'u29', title: 'Done already', at: 'x' }, { msgId: 'u28', title: '  ', at: 'x' }];
    const batch = untitledBatch(candidates, titles);
    expect(batch).toHaveLength(TURN_TITLE_BATCH);
    expect(batch[0].msgId).toBe('u9');
    // u28's empty title counts as untitled; u29 is skipped.
    expect(batch.at(-1)!.msgId).toBe('u28');
  });

  it('leaves out ids that failed too often', () => {
    const batch = untitledBatch(candidates.slice(0, 3), [], new Set(['u1']));
    expect(batch.map((c) => c.msgId)).toEqual(['u0', 'u2']);
  });
});

describe('the model input and its answer', () => {
  it('numbers one line per message', () => {
    expect(buildTurnTitlesMessage([{ msgId: 'a', excerpt: 'fix login' }, { msgId: 'b', excerpt: 'add tests' }]))
      .toBe('1. fix login\n2. add tests');
  });

  it('reads numbered lines in the common shapes, ignoring noise, repeats and numbers out of range', () => {
    const raw = [
      'Here are the titles:',
      '1. Login redirect fix',
      '2) "Unit tests for parser"',
      '- 3: **Cache eviction policy**.',
      '3. A repeat that loses',
      '9. Out of range',
      '4.',
    ].join('\n');
    const parsed = parseTurnTitlesAnswer(raw, 4);
    expect([...parsed.entries()]).toEqual([
      [0, 'Login redirect fix'], [1, 'Unit tests for parser'], [2, 'Cache eviction policy'],
    ]);
  });

  it('null or empty answers parse to nothing', () => {
    expect(parseTurnTitlesAnswer(null, 3).size).toBe(0);
    expect(parseTurnTitlesAnswer('', 3).size).toBe(0);
  });

  it('cleans a title and cuts a long one at a word', () => {
    expect(cleanTurnTitle('Title: "Retry budget"')).toBe('Retry budget');
    expect(cleanTurnTitle('x')).toBeNull();
    const long = cleanTurnTitle(`${'section '.repeat(20)}end`)!;
    expect(long.length).toBeLessThanOrEqual(80);
    expect(long.endsWith('section')).toBe(true);
  });
});

describe('mergeTurnTitles', () => {
  it('writes once: an existing title stays, an empty one is filled, new ones append', () => {
    const existing = [{ msgId: 'a', title: 'Old title', at: 't0' }, { msgId: 'b', title: '', at: 't0' }];
    const { list, changed } = mergeTurnTitles(existing, [
      { msgId: 'a', title: 'New title' }, { msgId: 'b', title: 'Filled' }, { msgId: 'c', title: 'Third' },
    ], 't1');
    expect(changed).toBe(true);
    expect(list).toEqual([
      { msgId: 'a', title: 'Old title', at: 't0' },
      { msgId: 'b', title: 'Filled', at: 't1' },
      { msgId: 'c', title: 'Third', at: 't1' },
    ]);
  });

  it('reports no change when everything already had a title', () => {
    expect(mergeTurnTitles([{ msgId: 'a', title: 'T', at: 't0' }], [{ msgId: 'a', title: 'U' }], 't1').changed).toBe(false);
    expect(mergeTurnTitles(undefined, [], 't1')).toEqual({ list: [], changed: false });
  });

  it('caps the list, dropping the oldest writes', () => {
    const existing = Array.from({ length: MAX_TURN_TITLES }, (_, i) => ({ msgId: `m${i}`, title: `T${i}`, at: 't0' }));
    const { list } = mergeTurnTitles(existing, [{ msgId: 'new', title: 'Newest' }], 't1');
    expect(list).toHaveLength(MAX_TURN_TITLES);
    expect(list[0].msgId).toBe('m1');
    expect(list.at(-1)!.msgId).toBe('new');
  });
});
