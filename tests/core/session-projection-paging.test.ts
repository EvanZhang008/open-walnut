/**
 * Transcript paging: `before` and `visible` on buildSessionTranscript.
 *
 * The 2026-10-04 phone report: the session page folds a turn's tool calls into one
 * line, so a 100-message tail of a busy turn is a few lines, and scrolling up ended
 * at a folded run with the user's own messages nowhere above it. Nothing could
 * reach them: the tail was the only read. These cases pin the two additive options
 * the phone now pages with, through the REAL builder over a REAL JSONL.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';
import { mockLocalDaemonReader } from '../helpers/mock-local-daemon-reader.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-projection-paging'));
vi.mock('../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader());

const CWD = '/tmp/marina/paging';

vi.mock('../../src/core/session-tracker.js', () => ({
  getSessionByClaudeId: async (id: string) => ({
    claudeSessionId: id,
    cwd: CWD,
    process_status: 'idle',
    startedAt: '2026-01-01T00:00:00Z',
    lastActiveAt: '2026-01-01T00:00:00Z',
  }),
}));

import { CLAUDE_HOME } from '../../src/constants.js';
import { encodeProjectPath, type SessionHistoryMessage } from '../../src/core/session-history.js';
import {
  buildSessionTranscript,
  transcriptSliceBounds,
  type ProjectedTranscriptMessage,
} from '../../src/core/session-projection.js';

const tmpBase = path.dirname(CLAUDE_HOME);

beforeEach(async () => {
  seq = 0;
  await fsp.rm(tmpBase, { recursive: true, force: true });
  await fsp.mkdir(tmpBase, { recursive: true });
});

afterEach(async () => {
  await fsp.rm(tmpBase, { recursive: true, force: true }).catch(() => {});
});

async function writeJsonl(sessionId: string, lines: unknown[]): Promise<void> {
  const dir = path.join(CLAUDE_HOME, 'projects', encodeProjectPath(CWD));
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n'));
}

let seq = 0;
function at(): string {
  return new Date(Date.UTC(2026, 0, 1) + (seq++) * 1000).toISOString();
}

function userLine(text: string): unknown {
  return { type: 'user', timestamp: at(), message: { role: 'user', content: [{ type: 'text', text }] } };
}

function proseLine(id: string, text: string): unknown {
  return { type: 'assistant', timestamp: at(), message: { id, role: 'assistant', content: [{ type: 'text', text }] } };
}

/** One tool call and its result: ONE history message (the result rides the call). */
function toolCall(id: string, command: string, result = 'ok'): unknown[] {
  return [
    {
      type: 'assistant', timestamp: at(),
      message: { id, role: 'assistant', content: [{ type: 'tool_use', id: `tu-${id}`, name: 'Bash', input: { command } }] },
    },
    {
      type: 'user', timestamp: at(),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu-${id}`, content: result }] },
    },
  ];
}

/**
 * A busy session: the user's ask, then turns of `callsPerTurn` tool calls each
 * closed by one line of prose, the shape of the reported session.
 */
function busySession(turns: number, callsPerTurn: number, result = 'ok'): unknown[] {
  const lines: unknown[] = [userLine('Clean up the orphaned records and report back.')];
  for (let t = 0; t < turns; t++) {
    for (let c = 0; c < callsPerTurn; c++) lines.push(...toolCall(`m-${t}-${c}`, `step ${t}.${c}`, result));
    lines.push(proseLine(`p-${t}`, `Turn ${t} done.`));
  }
  return lines;
}

function texts(rows: ProjectedTranscriptMessage[]): string[] {
  return rows.filter((m) => !m.kind).map((m) => m.text);
}

/** Every page, newest first, the way the phone walks back with `before`. */
async function walkBack(sessionId: string, visible: number): Promise<ProjectedTranscriptMessage[][]> {
  const pages: ProjectedTranscriptMessage[][] = [];
  let page = await buildSessionTranscript(sessionId, { rich: true, visible });
  pages.push(page.messages);
  while (page.truncated) {
    const oldest = page.messages[0]?.timestamp;
    expect(oldest).toBeTruthy();
    page = await buildSessionTranscript(sessionId, { rich: true, before: oldest, visible });
    pages.push(page.messages);
    expect(pages.length).toBeLessThan(50);
  }
  return pages;
}

describe('the default tail is untouched', () => {
  it('no option keeps the last 100 history messages and says truncated', async () => {
    await writeJsonl('s-default', busySession(3, 60));
    const t = await buildSessionTranscript('s-default');
    expect(t.truncated).toBe(true);
    // 100 history messages of a busy turn: almost all tool rows, one or two prose.
    expect(t.messages.length).toBe(100);
    expect(texts(t.messages).length).toBeLessThanOrEqual(2);
  });
});

describe('visible: the slice reaches back to text a reader can see', () => {
  it('extends past 100 messages until it holds that many text messages', async () => {
    await writeJsonl('s-visible', busySession(6, 40));
    // The last 100 messages hold three turn ends; asking for five reaches back two
    // more turns of 40 calls each.
    const t = await buildSessionTranscript('s-visible', { visible: 5 });
    expect(texts(t.messages)).toEqual(['Turn 1 done.', 'Turn 2 done.', 'Turn 3 done.', 'Turn 4 done.', 'Turn 5 done.']);
    // It starts AT the fifth text message from the end, not a tool call before it.
    expect(t.messages[0].text).toBe('Turn 1 done.');
    expect(t.messages.length).toBeGreaterThan(100);
    expect(t.truncated).toBe(true);
  });

  it('never returns fewer than the default tail', async () => {
    const lines: unknown[] = [];
    for (let i = 0; i < 150; i++) lines.push(i % 2 ? proseLine(`p${i}`, `line ${i}`) : userLine(`ask ${i}`));
    await writeJsonl('s-chatty', lines);
    const t = await buildSessionTranscript('s-chatty', { visible: 5 });
    expect(t.messages.length).toBe(100);
  });

  it('stops at 600 history messages however few of them are text', async () => {
    await writeJsonl('s-cap', busySession(1, 700));
    const t = await buildSessionTranscript('s-cap', { visible: 50 });
    expect(t.messages.length).toBe(600);
    expect(t.truncated).toBe(true);
  });

  it('reaches the conversation start and says so', async () => {
    await writeJsonl('s-start', busySession(2, 70));
    const t = await buildSessionTranscript('s-start', { visible: 20 });
    expect(t.truncated).toBe(false);
    expect(t.messages[0]).toMatchObject({ role: 'user', text: 'Clean up the orphaned records and report back.' });
  });
});

describe('before: older pages', () => {
  it('answers only messages strictly older than the cursor, never the cursor message', async () => {
    await writeJsonl('s-before', busySession(4, 50));
    const tail = await buildSessionTranscript('s-before', { visible: 1 });
    const cursor = tail.messages[0].timestamp;
    const older = await buildSessionTranscript('s-before', { before: cursor, visible: 1 });
    expect(older.messages.length).toBeGreaterThan(0);
    for (const m of older.messages) expect(m.timestamp < cursor).toBe(true);
    // The page ends right where the tail begins: nothing skipped between them.
    const firstTailRow = tail.messages[0];
    const lastOlder = older.messages[older.messages.length - 1];
    expect(lastOlder.timestamp < firstTailRow.timestamp).toBe(true);
  });

  it('walking back page by page yields the whole conversation once, in order', async () => {
    await writeJsonl('s-walk', busySession(5, 90));
    const pages = await walkBack('s-walk', 4);
    expect(pages.length).toBeGreaterThan(1);
    const stitched = pages.slice().reverse().flat();
    const whole = await buildSessionTranscript('s-walk', { full: true });
    expect(stitched.map((m) => `${m.timestamp}|${m.kind ?? ''}|${m.text}`))
      .toEqual(whole.messages.map((m) => `${m.timestamp}|${m.kind ?? ''}|${m.text}`));
    expect(stitched[0].text).toBe('Clean up the orphaned records and report back.');
  });

  it('a cursor before the first message answers an empty, untruncated page', async () => {
    await writeJsonl('s-empty', busySession(1, 5));
    const t = await buildSessionTranscript('s-empty', { before: '2025-12-31T00:00:00.000Z' });
    expect(t.messages).toEqual([]);
    expect(t.truncated).toBe(false);
  });

  it('a whale pages past its bounded read window into the full read', async () => {
    // Each result is ~6 KB, so ~1300 calls make a JSONL past the 4 MB tail window:
    // the opening ask is only in the full read.
    const result = 'x'.repeat(6000);
    await writeJsonl('s-whale', busySession(13, 100, result));
    const file = path.join(CLAUDE_HOME, 'projects', encodeProjectPath(CWD), 's-whale.jsonl');
    expect((await fsp.stat(file)).size).toBeGreaterThan(4 * 1024 * 1024);
    const tail = await buildSessionTranscript('s-whale', { rich: true, visible: 2 });
    expect(tail.truncated).toBe(true);
    const pages = await walkBack('s-whale', 2);
    const oldestPage = pages[pages.length - 1];
    expect(oldestPage[0]).toMatchObject({ role: 'user', text: 'Clean up the orphaned records and report back.' });
    const stitched = pages.slice().reverse().flat();
    const turnEnds = texts(stitched).filter((t) => t.startsWith('Turn '));
    expect(turnEnds).toEqual(Array.from({ length: 13 }, (_, i) => `Turn ${i} done.`));
  }, 60_000);

  it('a file past the full read ceiling pages in bounded windows, every row once', async () => {
    // The full read refuses a file past DaemonFileReader's ceiling and serves the
    // 4 MB tail again, so before this the page past that tail came back empty
    // (measured live: a 61 MB session, 95 messages in its tail, nothing older).
    // A 6 MB ceiling over a ~15 MB file stands in for 32 MB over a 61 MB one.
    const result = 'z'.repeat(6000);
    await writeJsonl('s-ceiling', busySession(25, 100, result));
    const file = path.join(CLAUDE_HOME, 'projects', encodeProjectPath(CWD), 's-ceiling.jsonl');
    expect((await fsp.stat(file)).size).toBeGreaterThan(12 * 1024 * 1024);
    process.env.WALNUT_MAX_FILE_READ_BYTES = String(6 * 1024 * 1024);
    let pages: ProjectedTranscriptMessage[][];
    try {
      pages = await walkBack('s-ceiling', 3);
    } finally {
      delete process.env.WALNUT_MAX_FILE_READ_BYTES;
    }
    expect(pages.length).toBeGreaterThan(3);
    const stitched = pages.slice().reverse().flat();
    expect(stitched[0]).toMatchObject({ role: 'user', text: 'Clean up the orphaned records and report back.' });
    // Window seams lose nothing and repeat nothing: every call and every turn
    // end of the fixture, once, in order.
    const expected = ['Clean up the orphaned records and report back.'];
    for (let t = 0; t < 25; t++) {
      for (let c = 0; c < 100; c++) expected.push(`Bash|step ${t}.${c}`);
      expected.push(`Turn ${t} done.`);
    }
    expect(stitched.map((m) => (m.kind === 'tool' ? `${m.text}|${m.detail}` : m.text))).toEqual(expected);
    // And the seams kept each call's result with it.
    expect(stitched.filter((m) => m.kind === 'tool' && !m.resultPreview)).toEqual([]);
  }, 120_000);

  it('a whale window shorter than the tail still says truncated on the default read', async () => {
    // ~60 KB per call: the 4 MB window holds fewer than 100 history messages, and
    // the conversation goes on before it. A client that trusted truncated=false
    // here would throw away the older pages it holds.
    const result = 'y'.repeat(60_000);
    await writeJsonl('s-whale-short', busySession(1, 90, result));
    const t = await buildSessionTranscript('s-whale-short');
    expect(t.messages.length).toBeLessThan(100);
    expect(t.truncated).toBe(true);
  }, 60_000);
});

describe('since: a refetch that overlaps what the client holds', () => {
  it('a turn longer than the tail comes back whole from the newest held row', async () => {
    // The client last read when Turn 0 had just ended. Turn 1 then ran 150 calls,
    // so a plain tail starts inside Turn 1 and its head would be a hole.
    await writeJsonl('s-since', busySession(2, 150));
    const all = (await buildSessionTranscript('s-since', { full: true })).messages;
    const heldNewest = all.find((m) => m.text === 'Turn 0 done.')!.timestamp;
    const plain = await buildSessionTranscript('s-since');
    expect(plain.messages[0].timestamp > heldNewest).toBe(true);
    const t = await buildSessionTranscript('s-since', { since: heldNewest });
    expect(t.messages[0]).toMatchObject({ text: 'Turn 0 done.', timestamp: heldNewest });
    expect(texts(t.messages)).toEqual(['Turn 0 done.', 'Turn 1 done.']);
    expect(t.truncated).toBe(true);
  });

  it('never returns less than the default tail, and stops at 600 messages', async () => {
    await writeJsonl('s-since-cap', busySession(1, 700));
    const recent = await buildSessionTranscript('s-since-cap', { since: '2099-01-01T00:00:00.000Z' });
    expect(recent.messages.length).toBe(100);
    const old = await buildSessionTranscript('s-since-cap', { since: '2000-01-01T00:00:00.000Z' });
    expect(old.messages.length).toBe(600);
  });
});

describe('readSessionHistoryRange: windows tile the file', () => {
  it('a line belongs to the window it starts in, at any boundary', async () => {
    const lines = Array.from({ length: 12 }, (_, i) => proseLine(`r${i}`, `row ${i}`));
    await writeJsonl('s-range', lines);
    const file = path.join(CLAUDE_HOME, 'projects', encodeProjectPath(CWD), 's-range.jsonl');
    const bytes = await fsp.readFile(file);
    const lineStarts = [0];
    for (let i = 0; i < bytes.length; i++) if (bytes[i] === 0x0a) lineStarts.push(i + 1);
    const { readSessionHistoryRange } = await import('../../src/core/session-history.js');
    const textsIn = async (a: number, b: number) =>
      (await readSessionHistoryRange('s-range', CWD, undefined, a, b))!.messages.map((m) => m.text);
    // Exactly on line starts: lines 3, 4, 5.
    expect(await textsIn(lineStarts[3], lineStarts[6])).toEqual(['row 3', 'row 4', 'row 5']);
    // One byte into line 3 and one byte into line 6: line 3 belongs to the
    // window before, line 6 starts inside this one and is read to its end.
    expect(await textsIn(lineStarts[3] + 1, lineStarts[6] + 1)).toEqual(['row 4', 'row 5', 'row 6']);
    // Every cut point, laid end to end, reads each line once.
    for (const step of [7, 100, 333]) {
      const seen: string[] = [];
      for (let a = 0; a < bytes.length; a += step) seen.push(...await textsIn(a, a + step));
      expect(seen, `step ${step}`).toEqual(lines.map((_, i) => `row ${i}`));
    }
  });
});

describe('readSessionHistoryRange: a call keeps its result at a seam', () => {
  it('cut anywhere, two windows hold every call once and each with its result', async () => {
    const lines = [userLine('go'), ...toolCall('a', 'one', 'out-a'), ...toolCall('b', 'two', 'out-b'),
      proseLine('p', 'done')];
    await writeJsonl('s-seam', lines);
    const file = path.join(CLAUDE_HOME, 'projects', encodeProjectPath(CWD), 's-seam.jsonl');
    const size = (await fsp.stat(file)).size;
    const { readSessionHistoryRange } = await import('../../src/core/session-history.js');
    for (let cut = 1; cut < size; cut += 17) {
      const head = (await readSessionHistoryRange('s-seam', CWD, undefined, 0, cut))!.messages;
      const rest = (await readSessionHistoryRange('s-seam', CWD, undefined, cut, size))!.messages;
      const both = [...head, ...rest];
      const tools = both.flatMap((m) => m.tools ?? []);
      expect(tools.map((t) => t.name + ':' + String(t.result)), `cut ${cut}`).toEqual(['Bash:out-a', 'Bash:out-b']);
      expect(both.map((m) => m.text).filter(Boolean), `cut ${cut}`).toEqual(['go', 'done']);
    }
  });
});

describe('transcriptSliceBounds', () => {
  const msg = (timestamp: string, text = '', role: SessionHistoryMessage['role'] = 'assistant'): SessionHistoryMessage =>
    ({ role, text, timestamp }) as SessionHistoryMessage;

  it('an out-of-order timestamp far from the boundary does not move it', () => {
    const history = [
      msg('2026-01-01T00:00:05Z'), // a clock skew early in the file
      msg('2026-01-01T00:00:01Z'),
      msg('2026-01-01T00:00:02Z'),
      msg('2026-01-01T00:00:03Z'),
    ];
    expect(transcriptSliceBounds(history, { before: '2026-01-01T00:00:03Z' })).toEqual({ start: 0, end: 3 });
  });

  it('counts only text a reader sees: injected user lines and tool-only messages do not', () => {
    const history = [
      msg('t0', 'the real ask', 'user'),
      { ...msg('t1', 'skill dump', 'user'), injected: true } as SessionHistoryMessage,
      msg('t2', ''),
      msg('t3', 'answer'),
    ];
    expect(transcriptSliceBounds(history, { visible: 2 })).toEqual({ start: 0, end: 4 });
  });

  it('a page never starts inside a run of messages that share a timestamp', () => {
    // 103 messages; the default start (index 3) sits inside a run of three equal
    // timestamps. The next page's `before` would exclude that whole run, so the
    // page must take all of it.
    const history = Array.from({ length: 103 }, (_, i) =>
      msg(`2026-01-01T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}Z`))
    for (const i of [2, 3, 4]) history[i] = msg('2026-01-01T00:00:02Z')
    expect(transcriptSliceBounds(history, {})).toEqual({ start: 2, end: 103 })
  });

  it('a clock that stood still moves the start back at most 50 messages', () => {
    const history = Array.from({ length: 300 }, () => msg('2026-01-01T00:00:00Z'))
    expect(transcriptSliceBounds(history, {})).toEqual({ start: 150, end: 300 })
  });

  it('an empty history is an empty slice', () => {
    expect(transcriptSliceBounds([], { before: 't', visible: 10 })).toEqual({ start: 0, end: 0 });
  });
});
