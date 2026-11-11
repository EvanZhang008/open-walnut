/**
 * Find in a whole session (src/core/sessions/session-find.ts): which rows of the
 * transcript hold the query, the rows the web chat has not loaded included.
 */
import { describe, vi, it, expect, beforeEach } from 'vitest';
import {
  findInHistoryRows, findableText, readFindableHistory, _resetSessionFindCacheForTests, type FindHistoryDeps,
} from '../../../src/core/sessions/session-find.js';
import type { SessionHistoryMessage } from '../../../src/core/session-history.js';
import type { SessionRecord } from '../../../src/core/types.js';
import { envelopeCardText, type SessionEnvelope } from '../../../src/lib/history-session-envelope.js';
import { createEnvelopeKit } from '../../../src/core/peers/envelope-kit.js';

const row = (i: number, role: 'user' | 'assistant', text: string, extra: Partial<SessionHistoryMessage> = {}): SessionHistoryMessage => ({
  role, text, timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(), msgId: `m${i}`, ...extra,
});

describe('findInHistoryRows', () => {
  it('lists every row holding the query, oldest first, with its count', () => {
    const rows = [
      row(0, 'user', 'Where is the otter?'),
      row(1, 'assistant', 'The otter swims. Another otter follows.'),
      row(2, 'user', 'thanks'),
    ];
    const r = findInHistoryRows(rows, 'otter');
    expect(r.matches.map((m) => [m.id, m.count])).toEqual([['m0', 1], ['m1', 2]]);
    expect(r.total).toBe(3);
    expect(r.capped).toBe(false);
  });

  it('never counts what the screen hides: the acknowledgement marker of an assistant reply', () => {
    // Its markup reads "agent-ack"; a search for "agent" matched every acknowledged
    // turn, rows that render nothing at all (2026-11-04, a lead's 4 MB transcript).
    const rows = [
      row(0, 'assistant', '<walnut-turn status="agent-ack"/>'),
      row(1, 'assistant', 'The agent finished.\n\n<walnut-turn status="agent-ack"/>'),
    ];
    const r = findInHistoryRows(rows, 'agent');
    expect(r.matches.map((m) => [m.id, m.count])).toEqual([['m1', 1]]);
  });

  it('folds case unless asked not to', () => {
    const rows = [row(0, 'assistant', 'Otter OTTER otter')];
    expect(findInHistoryRows(rows, 'otter').total).toBe(3);
    expect(findInHistoryRows(rows, 'otter', { caseSensitive: true }).total).toBe(1);
  });

  it('reads a line break as a space and drops markdown marks, as the page renders them', () => {
    const rows = [row(0, 'assistant', 'one\ntwo, **bold** word, `code span`, [a link](https://example.com/otter)')];
    expect(findInHistoryRows(rows, 'one two').total).toBe(1);
    expect(findInHistoryRows(rows, 'bold word').total).toBe(1);
    expect(findInHistoryRows(rows, 'code span').total).toBe(1);
    expect(findInHistoryRows(rows, 'a link').total).toBe(1);
    // The link target does not render.
    expect(findInHistoryRows(rows, 'otter').total).toBe(0);
  });

  it('skips rows a reader never sees as prose: injected, skill dumps, system (a tool call shows its header)', () => {
    const rows = [
      // Shown as "Bash echo otter" on its card's header line: counted.
      row(0, 'assistant', '', { tools: [{ name: 'Bash', input: { command: 'echo otter' } } as never] }),
      row(1, 'user', 'otter context', { injected: true }),
      row(2, 'user', 'Base directory for this skill: otter'),
      row(3, 'system', 'otter compaction'),
      row(4, 'user', 'a real otter question'),
    ];
    expect(findInHistoryRows(rows, 'otter').matches.map((m) => m.id)).toEqual(['m0', 'm4']);
  });

  it('keys a row by msgId, else walnutMessageId, and skips rows with neither or seen twice', () => {
    const rows = [
      row(0, 'user', 'otter', { msgId: undefined, walnutMessageId: 'w0' }),
      row(1, 'user', 'otter', { msgId: undefined }),
      row(2, 'assistant', 'otter'),
      row(3, 'assistant', 'otter', { msgId: 'm2' }),
    ];
    expect(findInHistoryRows(rows, 'otter').matches.map((m) => m.id)).toEqual(['w0', 'm2']);
  });

  it('stops at the cap and says so', () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(i, 'assistant', 'otter otter'));
    const r = findInHistoryRows(rows, 'otter', { cap: 5 });
    expect(r.total).toBe(5);
    expect(r.capped).toBe(true);
    expect(r.matches.reduce((n, m) => n + m.count, 0)).toBe(5);
  });

  it('matches non-ASCII text', () => {
    // CJK test data: "test arrow test", searched for "test".
    const rows = [row(0, 'user', '\u6d4b\u8bd5 \u4e0a\u7bad\u5934 \u6d4b\u8bd5')];
    expect(findInHistoryRows(rows, '\u6d4b\u8bd5').total).toBe(2);
  });

  it('counts the cards of Walnut notes riding in front of the typed words, never their markup', () => {
    expect(findableText(row(0, 'user', 'hello otter'))).toBe('hello otter');
    // The chat shows a rider as a card (the fold above the bubble): its words count.
    const rider = createEnvelopeKit().buildWalnutMessage({
      kind: 'notification',
      attrs: { from: 'Walnut', outcome: 'task-routing-policy', note: 'current product rules, not a work request' },
      body: 'The otter rule replaces older ones.',
    });
    const text = findableText(row(0, 'user', `${rider}\n\nhello otter`));
    expect(text).toContain('The otter rule replaces older ones.');
    expect(text).toContain('hello otter');
    expect(text).not.toContain('walnut-message');
  });

  it('reads a delivery by its card text, never its envelope markup', () => {
    const text = [
      '<walnut-message kind="peer-note" from="Lead task [abcd1234]" from-session="abcd1234-0000-4000-8000-000000000001" from-task="t1" host="local" request="rq-1">',
      'Please look at the otter report.',
      '</walnut-message>',
      'Reply when done: walnut tools call task_send \'{"in_reply_to":"rq-1"}\'',
    ].join('\n');
    const r = findInHistoryRows([row(0, 'user', text)], 'otter');
    expect(r.total).toBe(1);
    expect(findInHistoryRows([row(0, 'user', text)], 'from-session').total).toBe(0);
    expect(findInHistoryRows([row(0, 'user', text)], 'walnut-message').total).toBe(0);
  });

  it('counts an open card\'s words once each, as the card prints them', () => {
    const card = (over: Partial<SessionEnvelope>): SessionEnvelope => ({ kind: 'notification', peer: {}, raw: '', ...over } as SessionEnvelope);
    // A subtask notice prints its outcome without the child's name (the sender line names it).
    expect(envelopeCardText(card({ statusLine: 'Your subtask "Fix the otter" (t-9) finished: all green.' })))
      .toBe('Finished: all green.');
    // What was asked and the quoted words show on the open card: they count.
    expect(envelopeCardText(card({ askedPreview: 'Is the otter fed?', quote: [{ kind: 'message', label: 'its last message', text: 'Fed at noon.' }] as SessionEnvelope['quote'] })))
      .toBe('Is the otter fed? Fed at noon.');
    // A plain scheduled run says so in its label, not in words.
    expect(envelopeCardText(card({ kind: 'trigger', statusLine: 'scheduled', body: 'Run the report.' }))).toBe('Run the report.');
  });
});

describe('a tool call counts the words its card shows', () => {
  const tool = (name: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ name, input, ...extra });
  const count = (tools: ReturnType<typeof tool>[], q: string) => findInHistoryRows([row(0, 'assistant', 'Working.', { tools } as Partial<SessionHistoryMessage>)], q).total;

  it('a header line: the name and its summary, before the reader opens anything', () => {
    // Bash shows its description when it has one, else the command's first line.
    expect(count([tool('Bash', { command: 'npm test -- --grep checkout-69\necho otter' })], 'checkout-69')).toBe(1);
    expect(count([tool('Bash', { command: 'npm test -- --grep checkout-69\necho otter' })], 'otter')).toBe(0);
    expect(count([tool('Bash', { command: 'ls', description: 'Count the otters' })], 'otter')).toBe(1);
    // Any other tool: its short name and what it touched (the row's words, design 1,
    // 2026-11-11), its first line cut to 160 characters.
    expect(count([tool('Read', { file_path: '/repo/otter.md' })], 'Read /repo/otter')).toBe(1);
    expect(count([tool('Read', { file_path: '/repo/otter.md' })], 'file_path')).toBe(0);
    expect(count([tool('Read', { file_path: `/repo/${'a'.repeat(170)}otter.md` })], 'otter')).toBe(0);
    expect(count([tool('mcp__walnut__task_get', { id: 'otter-1' })], 'task_get')).toBe(1);
    expect(count([tool('mcp__walnut__task_get', { id: 'otter-1' })], 'mcp__walnut')).toBe(0);
    // A call with no one target reads its input as `key: value` pairs, each cut to 60 characters.
    expect(count([tool('TodoWrite', { mode: 'otter' })], 'mode: otter')).toBe(1);
  });

  it('an Edit shows its file name and its short diff', () => {
    expect(count([tool('Edit', { file_path: '/repo/src/otter.ts', old_string: 'const a = 1', new_string: 'const otter = 2' })], 'otter')).toBe(2);
    // A long diff is behind a "Show diff" button: only the file name shows.
    const long = Array.from({ length: 60 }, (_, i) => `otter ${i}`).join('\n');
    expect(count([tool('Edit', { file_path: '/repo/src/otter.ts', old_string: long, new_string: long + '\nmore' })], 'otter')).toBe(1);
  });

  it('a plan card shows its plan, a plan file its name', () => {
    expect(count([tool('ExitPlanMode', { plan: 'Plan: feed the **otter**' })], 'feed the otter')).toBe(1);
    expect(count([tool('Write', { file_path: '/home/u/.claude/plans/otter.md', content: 'otter otter' })], 'otter')).toBe(1);
  });

  it('a call drawn as something else counts none: a subagent\'s chip, a send to another session', () => {
    expect(count([tool('Agent', { description: 'otter survey', prompt: 'otter' })], 'otter')).toBe(0);
    expect(count([tool('mcp__walnut__task_send', { to: 'x', text: 'otter news' })], 'otter')).toBe(0);
    expect(count([tool('Bash', { command: 'walnut tools call task_send \'{"to":"x","text":"otter"}\'' })], 'otter')).toBe(0);
  });

  it('a tool-only row is found by its calls alone', () => {
    const rows = [row(0, 'assistant', '', { tools: [tool('Bash', { command: 'grep otter' })] } as Partial<SessionHistoryMessage>)];
    expect(findInHistoryRows(rows, 'otter').matches.map((m) => m.id)).toEqual(['m0']);
    expect(findableText(rows[0]!)).toBe('Bash grep otter');
  });
});

describe('readFindableHistory', () => {
  beforeEach(() => _resetSessionFindCacheForTests());
  const record = (over: Partial<SessionRecord> = {}): SessionRecord => ({
    claudeSessionId: 's1', taskId: 't1', project: 'p', process_status: 'idle', mode: 'default',
    startedAt: '2026-01-01T00:00:00.000Z', lastActiveAt: '2026-01-01T00:00:00.000Z', messageCount: 0,
    cwd: '/work', ...over,
  } as SessionRecord);

  it('pages the older part of a windowed transcript back to its start, and keeps it for the next query', async () => {
    const tail = [row(100, 'user', 'tail otter')];
    let pagesRead = 0;
    const deps: FindHistoryDeps = {
      readHistory: async () => ({ messages: tail, windowed: true }),
      readBefore: async (_id, _cwd, _host, before) => {
        pagesRead++;
        if (before === tail[0]!.timestamp) return { messages: [row(50, 'assistant', 'middle otter')], reachedStart: false };
        return { messages: [row(1, 'user', 'first otter')], reachedStart: true };
      },
      getSession: async () => null,
    };
    const first = await readFindableHistory('s1', record(), deps);
    expect(first.rows.map((r) => r.msgId)).toEqual(['m1', 'm50', 'm100']);
    expect(first.partial).toBe(false);
    expect(pagesRead).toBe(2);
    await readFindableHistory('s1', record(), deps);
    expect(pagesRead).toBe(2);
  });

  it('two queries at once share one read of the older part', async () => {
    let pagesRead = 0;
    let tailsRead = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const deps: FindHistoryDeps = {
      readHistory: async () => { tailsRead++; return { messages: [row(100, 'user', 'tail')], windowed: true }; },
      readBefore: async () => { pagesRead++; await gate; return { messages: [row(1, 'user', 'old otter')], reachedStart: true }; },
      getSession: async () => null,
    };
    const a = readFindableHistory('s1', record(), deps);
    const b = readFindableHistory('s1', record(), deps);
    // Both queries are in, and the older part is being read while they wait.
    await vi.waitFor(() => { expect(tailsRead).toBe(2); expect(pagesRead).toBe(1); });
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(pagesRead).toBe(1);
    expect(ra.rows.map((m) => m.msgId)).toEqual(['m1', 'm100']);
    expect(rb.rows.map((m) => m.msgId)).toEqual(['m1', 'm100']);
  });

  it('a live session whose tail moved on reads only the stretch between the two heads', async () => {
    let head = row(100, 'user', 'tail');
    const asked: string[] = [];
    const deps: FindHistoryDeps = {
      readHistory: async () => ({ messages: [head], windowed: true }),
      readBefore: async (_id, _cwd, _host, before) => {
        asked.push(before);
        if (before === row(100, '').timestamp) return { messages: [row(1, 'user', 'first'), row(50, 'user', 'mid')], reachedStart: true };
        // From the new head: the rows that slid out of the tail, then the page goes on past the old head.
        return { messages: [row(90, 'user', 'slid'), row(100, 'user', 'tail'), row(110, 'user', 'slid too')], reachedStart: false };
      },
      getSession: async () => null,
    };
    await readFindableHistory('s1', record(), deps);
    head = row(120, 'user', 'new tail');
    const second = await readFindableHistory('s1', record(), deps);
    expect(asked).toEqual([row(100, '').timestamp, row(120, '').timestamp]);
    expect(second.rows.map((m) => m.msgId)).toEqual(['m1', 'm50', 'm100', 'm110', 'm120']);
    expect(second.partial).toBe(false);
  });

  it('a window that fails to read leaves what was read, marked partial', async () => {
    const deps: FindHistoryDeps = {
      readHistory: async () => ({ messages: [row(100, 'user', 'tail otter')], windowed: true }),
      readBefore: async () => { throw new Error('read timed out'); },
      getSession: async () => null,
    };
    const r = await readFindableHistory('s1', record(), deps);
    expect(r.partial).toBe(true);
    expect(r.rows.map((m) => m.msgId)).toEqual(['m100']);
  });

  it('keeps only the fields a find reads from older pages', async () => {
    const deps: FindHistoryDeps = {
      readHistory: async () => ({ messages: [row(100, 'user', 'tail')], windowed: true }),
      readBefore: async () => ({ messages: [row(1, 'assistant', 'old', { tools: [{ name: 'Bash', output: 'x'.repeat(1000) } as never], thinking: 'long' })], reachedStart: true }),
      getSession: async () => null,
    };
    const r = await readFindableHistory('s1', record(), deps);
    // The call's output and the reasoning are dropped; its header's words are kept.
    expect(r.rows[0]).toEqual({ role: 'assistant', text: 'old', timestamp: row(1, '').timestamp, msgId: 'm1', toolText: 'Bash' });
  });

  it('says partial when the paging stops before the start', async () => {
    const deps: FindHistoryDeps = {
      readHistory: async () => ({ messages: [row(100, 'user', 'x')], windowed: true }),
      readBefore: async () => null,
      getSession: async () => null,
    };
    expect((await readFindableHistory('s1', record(), deps)).partial).toBe(true);
  });

  it('puts a fork\'s ancestors first, cut at its rewind point', async () => {
    const parent = record({ claudeSessionId: 'p1' });
    const deps: FindHistoryDeps = {
      readHistory: async (id) => id === 'p1'
        ? { messages: [row(1, 'user', 'kept otter'), row(2, 'user', 'rewound otter')], windowed: false }
        : { messages: [row(10, 'user', 'own otter')], windowed: false },
      readBefore: async () => null,
      getSession: async (id) => (id === 'p1' ? parent : null),
    };
    const r = await readFindableHistory('s1', record({ forkedFromSessionId: 'p1', rewoundAtMessageUuid: 'm1' }), deps);
    expect(r.rows.map((m) => m.msgId)).toEqual(['m1', 'm10']);
    expect(findInHistoryRows(r.rows, 'otter').matches.map((m) => m.id)).toEqual(['m1', 'm10']);
  });
});
