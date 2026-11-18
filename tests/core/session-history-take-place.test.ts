/**
 * A sent message sits in history where Claude Code TOOK it, over every send path.
 *
 * 2026-10-31 (the user: "my own input jumped above the answer"): a mid-turn send
 * was placed at its `enqueue`, so the words the model wrote between the send and
 * the take (written before it saw the message) read as its answer, and a line
 * still waiting in the queue sat above the reply streaming under it. Now:
 *
 *  - idle send / queued until the turn ends: the CLI's own user line, after the
 *    turn it waited behind (unchanged);
 *  - mid-turn take: at its `queued_command` attachment;
 *  - still waiting (a read before the take): at the end, `queued`, unsettled;
 *  - an orphan a dead process left (a later line was taken first): where it was
 *    sent, settled (it must never block the incremental parse, nor make every
 *    delta a rebuild);
 *  - an older CLI that never logged its takes: where it was sent.
 *
 * Line shapes are the CLI 2.1.280 transcript's, neutral text.
 */
import { describe, it, expect } from 'vitest';
import { parseSessionMessages, floatQueuedRows, type SessionHistoryMessage } from '../../src/core/session-history.js';
import { collectRequestedRevisions } from '../../src/core/history-delta.js';

const T = (s: number) => new Date(Date.UTC(2026, 9, 31, 4, 12, s)).toISOString();
const enqueue = (content: string, s: number) => ({ type: 'queue-operation', operation: 'enqueue', timestamp: T(s), sessionId: 's', content });
const remove = (content: string, s: number) => ({ type: 'queue-operation', operation: 'remove', timestamp: T(s), sessionId: 's', content });
const dequeue = (s: number) => ({ type: 'queue-operation', operation: 'dequeue', timestamp: T(s), sessionId: 's' });
const user = (uuid: string, parent: string | null, content: unknown, s: number) =>
  ({ type: 'user', uuid, parentUuid: parent, timestamp: T(s), message: { role: 'user', content } });
const assistant = (uuid: string, parent: string, id: string, content: unknown[], s: number) =>
  ({ type: 'assistant', uuid, parentUuid: parent, timestamp: T(s), message: { id, role: 'assistant', content } });
const said = (uuid: string, parent: string, text: string, s: number) => assistant(uuid, parent, `msg_${uuid}`, [{ type: 'text', text }], s);
const tool = (uuid: string, parent: string, id: string, s: number) =>
  assistant(uuid, parent, `msg_${uuid}`, [{ type: 'tool_use', id, name: 'Bash', input: { command: 'sleep 9' } }], s);
const result = (uuid: string, parent: string, id: string, s: number) =>
  user(uuid, parent, [{ type: 'tool_result', tool_use_id: id, content: 'ok' }], s);
const taken = (uuid: string, parent: string, prompt: string, s: number) => ({
  type: 'attachment', uuid, parentUuid: parent, timestamp: T(s),
  attachment: { type: 'queued_command', prompt, commandMode: 'prompt', source_uuid: `src-${uuid}` },
});

const parse = (lines: unknown[]) => parseSessionMessages(lines.map((l) => JSON.stringify(l)).join('\n'));
const order = (rows: SessionHistoryMessage[]) => rows.filter((m) => !m.injected && (m.role === 'user' ? !!m.text : !!m.text)).map((m) => `${m.role}:${m.text}`);

const Q = 'How does the cookie domain scoping work?';
const F = 'And what about subdomains?';
const A1 = 'Cookies are scoped to the host unless a Domain attribute widens them.';
const A2 = 'A subdomain sees a cookie only when Domain names its parent.';
const START = [enqueue(Q, 0), dequeue(0), user('uQ', null, Q, 0)];

describe('a sent message sits where Claude Code took it', () => {
  it('mid-turn take: at its queued_command attachment, after the words written before it', () => {
    const rows = parse([
      ...START,
      tool('t1', 'uQ', 'tu1', 1),
      enqueue(F, 2),
      said('a1', 't1', A1, 3), // written before the model saw F
      result('r1', 'a1', 'tu1', 4),
      taken('q1', 'r1', F, 4),
      remove(F, 4),
      said('a2', 'q1', A2, 5),
    ]);
    expect(order(rows)).toEqual([`user:${Q}`, `assistant:${A1}`, `user:${F}`, `assistant:${A2}`]);
    const f = rows.find((m) => m.text === F)!;
    expect(f.sourceUuid).toBe('src-q1');
    expect(f.queued).toBeUndefined();
    expect(f.unsettled).toBeUndefined();
  });

  it('a long turn (background work) taking several lines: each at its own take', () => {
    const G = 'One more: does SameSite matter here?';
    const A3 = 'SameSite decides cross-site sends, not which host sees it.';
    const rows = parse([
      ...START,
      tool('t1', 'uQ', 'tu1', 1),
      enqueue(F, 2), enqueue(G, 3),
      said('a1', 't1', A1, 4),
      result('r1', 'a1', 'tu1', 5),
      taken('q1', 'r1', F, 5), remove(F, 5),
      tool('t2', 'q1', 'tu2', 6),
      said('a2', 't2', A2, 7),
      result('r2', 'a2', 'tu2', 8),
      taken('q2', 'r2', G, 8), remove(G, 8),
      said('a3', 'q2', A3, 9),
    ]);
    expect(order(rows)).toEqual([`user:${Q}`, `assistant:${A1}`, `user:${F}`, `assistant:${A2}`, `user:${G}`, `assistant:${A3}`]);
  });

  it('queued until the turn ends: the CLI\'s own line after the reply it waited behind', () => {
    const rows = parse([
      ...START,
      enqueue(F, 1),
      said('a1', 'uQ', A1, 2),
      dequeue(3),
      user('uF', 'a1', F, 3),
      said('a2', 'uF', A2, 4),
    ]);
    expect(order(rows)).toEqual([`user:${Q}`, `assistant:${A1}`, `user:${F}`, `assistant:${A2}`]);
    expect(rows.filter((m) => m.text === F)).toHaveLength(1);
  });

  it('still waiting (a read before the take, a reload mid-turn): at the end, queued and unsettled', () => {
    const rows = parse([
      ...START,
      tool('t1', 'uQ', 'tu1', 1),
      enqueue(F, 2),
      said('a1', 't1', A1, 3),
    ]);
    expect(order(rows)).toEqual([`user:${Q}`, `assistant:${A1}`, `user:${F}`]);
    const f = rows[rows.length - 1];
    expect(f).toMatchObject({ role: 'user', text: F, queued: true, unsettled: true });
    // Its place changes when the CLI takes it: a re-ask for it is a rebuild, never a
    // revision in place (history-delta.ts).
    expect(collectRequestedRevisions(rows, [f.msgId!]).ambiguous).toBe(true);
  });

  it('an orphan a dead process left stays where it was sent and is not queued', () => {
    const rows = parse([
      ...START,
      enqueue(F, 1), // never taken: the process died
      said('a1', 'uQ', A1, 2),
      enqueue('Next question', 3), dequeue(3),
      user('uN', 'a1', 'Next question', 3),
      said('a2', 'uN', 'Next answer.', 4),
    ]);
    expect(order(rows)).toEqual([`user:${Q}`, `user:${F}`, `assistant:${A1}`, 'user:Next question', 'assistant:Next answer.']);
    const f = rows.find((m) => m.text === F)!;
    expect(f.queued).toBeUndefined();
    // Settled: a re-ask for it would rebuild the history on every delta.
    expect(f.unsettled).toBeUndefined();
  });

  it('a CLI that logs dequeues but left an earlier send untaken: the last turn\'s waiting row stays where it was sent', () => {
    // The shape of a CLI that never logged its mid-turn takes: a send in an earlier
    // turn was never logged as taken (it ran), so a later one cannot be trusted either.
    const rows = parse([
      ...START,
      enqueue('ran mid-turn, never logged', 1),
      said('a1', 'uQ', A1, 2),
      enqueue('Next question', 3), dequeue(3),
      user('uN', 'a1', 'Next question', 3),
      enqueue(F, 4),
      said('a2', 'uN', A2, 5),
    ]);
    expect(order(rows).slice(-2)).toEqual([`user:${F}`, `assistant:${A2}`]);
    expect(rows.some((m) => m.queued)).toBe(false);
  });

  it('an older CLI that never logged its takes keeps every send where it was sent', () => {
    const rows = parse([
      user('uQ', null, Q, 0),
      said('a1', 'uQ', A1, 1),
      enqueue(F, 2),
      said('a2', 'a1', A2, 3),
    ]);
    expect(order(rows)).toEqual([`user:${Q}`, `assistant:${A1}`, `user:${F}`, `assistant:${A2}`]);
    expect(rows.find((m) => m.text === F)!.queued).toBeUndefined();
  });

  it('floatQueuedRows moves the last turn\'s waiting rows to the end, with their parent ids, in order', () => {
    const rows: SessionHistoryMessage[] = [
      { role: 'user', text: 'u', timestamp: T(0) },
      { role: 'user', text: 'w1', timestamp: T(1), queued: true },
      { role: 'assistant', text: 'x', timestamp: T(2) },
      { role: 'user', text: 'w2', timestamp: T(3), queued: true },
      { role: 'assistant', text: 'y', timestamp: T(4) },
    ];
    const parents = [undefined, 'p1', undefined, 'p2', 'py'];
    floatQueuedRows(rows, parents);
    expect(rows.map((r) => r.text)).toEqual(['u', 'x', 'y', 'w1', 'w2']);
    expect(parents).toEqual([undefined, undefined, 'py', 'p1', 'p2']);
  });
});

describe('a window that starts between a send and its take keeps the send', () => {
  // 2026-11-18 (the Mac app, a 125 MB session): the tail window began after the enqueue of the
  // user's mid-turn send and before its take, the window's parse had no row for it, and the
  // refresh dropped the message the reader saw. The CLI's attachment carries the enqueue's time.
  const takenAt = (uuid: string, parent: string, prompt: string, s: number, sentAt: number) => ({
    ...taken(uuid, parent, prompt, s),
    attachment: { type: 'queued_command', prompt, commandMode: 'prompt', source_uuid: `src-${uuid}`, timestamp: T(sentAt) },
  });
  const LINES = [
    ...START,
    tool('t1', 'uQ', 'tu1', 1),
    enqueue(F, 2),
    said('a1', 't1', A1, 3),
    result('r1', 'a1', 'tu1', 4),
    takenAt('q1', 'r1', F, 4, 2),
    remove(F, 4),
    said('a2', 'q1', A2, 5),
  ];
  const key = (m: SessionHistoryMessage) => `${m.msgId}|${m.timestamp}|${m.role}`;
  /** A window's parse: its text starts at the window's first line. */
  const parseWindow = (lines: unknown[]) => parseSessionMessages(lines.map((l) => JSON.stringify(l)).join('\n'), { startsMidFile: true });

  it('every cut between the enqueue and the take keeps the same row where it was taken', () => {
    const whole = parse(LINES);
    const sent = whole.find((m) => m.text === F)!;
    const enqueueAt = LINES.findIndex((l) => (l as { operation?: string }).operation === 'enqueue' && (l as { content?: string }).content === F);
    const takeAt = LINES.findIndex((l) => (l as { type?: string }).type === 'attachment');
    for (let cut = enqueueAt + 1; cut <= takeAt; cut++) {
      const rows = parseWindow(LINES.slice(cut));
      const got = rows.filter((m) => m.text === F);
      expect(got.map(key), `cut at line ${cut}`).toEqual([key(sent)]);
      expect(got[0].sourceUuid).toBe('src-q1');
      expect(order(rows).indexOf(`user:${F}`), `cut at line ${cut}`).toBe(order(rows).indexOf(`assistant:${A2}`) - 1);
    }
  });

  it('with the enqueue in the parse there is still one row', () => {
    expect(parse(LINES).filter((m) => m.text === F)).toHaveLength(1);
  });

  it('a take whose attachment names no send time makes no row (its id would not match)', () => {
    const lines = LINES.map((l) => ((l as { type?: string }).type === 'attachment' ? taken('q1', 'r1', F, 4) : l));
    const cut = lines.findIndex((l) => (l as { operation?: string }).operation === 'enqueue' && (l as { content?: string }).content === F) + 1;
    expect(parseWindow(lines.slice(cut)).filter((m) => m.text === F)).toHaveLength(0);
  });

  it('a resend of the same text later in the window does not hide the first send\'s take', () => {
    const cut = LINES.findIndex((l) => (l as { operation?: string }).operation === 'enqueue' && (l as { content?: string }).content === F) + 1;
    const rows = parseWindow([...LINES.slice(cut), enqueue(F, 9)]);
    expect(rows.filter((m) => m.text === F).length).toBeGreaterThanOrEqual(1);
    expect(rows.some((m) => m.text === F && m.sourceUuid === 'src-q1')).toBe(true);
  });

  it('a text that is not a window\'s (an incremental segment, whose prefix holds the enqueue) makes no row', () => {
    const cut = LINES.findIndex((l) => (l as { operation?: string }).operation === 'enqueue' && (l as { content?: string }).content === F) + 1;
    expect(parse(LINES.slice(cut)).filter((m) => m.text === F)).toHaveLength(0);
    expect(parseWindow(LINES).filter((m) => m.text === F)).toHaveLength(1);
  });

  it('a take stamped a few ms before its enqueue (the CLI does, about half the time) is the same send', async () => {
    const { isSameSend } = await import('../../src/core/history-same-send.js');
    const skewed = LINES.map((l) => ((l as { type?: string }).type === 'attachment'
      ? { ...(l as object), attachment: { ...(l as { attachment: object }).attachment, timestamp: new Date(Date.parse(T(2)) - 2).toISOString() } } : l));
    const whole = parse(skewed).find((m) => m.text === F)!;
    const cut = skewed.findIndex((l) => (l as { operation?: string }).operation === 'enqueue' && (l as { content?: string }).content === F) + 1;
    const windowRow = parseWindow(skewed.slice(cut)).find((m) => m.text === F)!;
    expect(key(windowRow)).not.toBe(key(whole));
    expect(isSameSend(windowRow, whole)).toBe(true);
    // The page before the window holds the enqueue alone: still one send.
    const pageRow = parse(skewed.slice(0, cut)).find((m) => m.text === F)!;
    expect(isSameSend(pageRow, windowRow)).toBe(true);
  });
});
