/**
 * Walking a task's history back with task_history, page by page, over the real builder.
 *
 * 1. Walking back to a time costs one transcript read per page.
 *
 * 2026-11-24 15:15Z: an audit script read every task's last 24 hours with
 * `task_history {limit: 200, since, compact, before}`, following `older.before` until it
 * was gone. The route's page stops at 600 rows, so a busy session took many pages, and on
 * every page task_history read the page before it once more to learn whether `since` was
 * reached: 251 of the 1,472 transcript reads in that hour were that second read, each a
 * windows read over the tunnel for a large session on another host. The page now says it
 * itself (`sinceReached`, session-projection.ts sinceReachedBy).
 *
 * This drives the real op over the real builder and a real JSONL, the way the route
 * serves it, and pins: one read per page, every row after `since` read exactly once, and
 * no page after the first parsing the file again.
 *
 * 2. A row stamped out of time order does not break the walk. Real transcripts hold such
 * rows (2026-11-24: 632 of 9,753 rows in 30 recent sessions were stamped more than 30 s
 * before a row above them: a resumed session's copied lines, compaction lines). The older
 * page was named by a time only, and a time cannot name a place next to such a row: the
 * walk asked for the same page again and again and never reached the start. It is named
 * by the first kept row's time and id now (older.before_id, the route's beforeId).
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';
import { mockLocalDaemonReader } from '../helpers/mock-local-daemon-reader.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-since-walk'));
vi.mock('../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader());

const CWD = '/tmp/marina/since-walk';

vi.mock('../../src/core/session-tracker.js', () => ({
  getSessionByClaudeId: async (id: string) => ({
    claudeSessionId: id,
    cwd: CWD,
    process_status: 'idle',
    startedAt: '2026-01-01T00:00:00Z',
    lastActiveAt: '2026-01-01T00:00:00Z',
  }),
}));

/** Characters of JSONL the history parser took, over the whole walk. */
const parsed = vi.hoisted(() => ({ chars: 0 }));
vi.mock('../../src/core/history-parse.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/core/history-parse.js')>();
  return {
    ...real,
    parseSessionMessages: (content: string, opts?: Parameters<typeof real.parseSessionMessages>[1]) => {
      parsed.chars += content.length;
      return real.parseSessionMessages(content, opts);
    },
    parseSessionMessagesYielding: (content: string, opts?: Parameters<typeof real.parseSessionMessages>[1]) => {
      parsed.chars += content.length;
      return real.parseSessionMessagesYielding(content, opts);
    },
  };
});

import { CLAUDE_HOME } from '../../src/constants.js';
import { encodeProjectPath, readSessionHistory } from '../../src/core/session-history.js';
import { buildSessionTranscript, sinceReachedBy, TRANSCRIPT_VISIBLE_MAX } from '../../src/core/session-projection.js';
import { getOp } from '../../src/ops/index.js';
import { agentAnswer } from '../../src/ops/answer.js';

const T0 = Date.UTC(2026, 0, 1);
let seq = 0;
const at = (): string => new Date(T0 + (seq++) * 1000).toISOString();

/** Busy turns: the ask, CALLS tool calls with their results, one reply. */
const TURNS = 90;
const CALLS = 30;
function busyLines(): unknown[] {
  const lines: unknown[] = [];
  for (let t = 0; t < TURNS; t++) {
    lines.push({ type: 'user', timestamp: at(), message: { role: 'user', content: [{ type: 'text', text: `Do part ${t}.` }] } });
    for (let c = 0; c < CALLS; c++) {
      lines.push({ type: 'assistant', timestamp: at(), message: { id: `m${t}-${c}`, role: 'assistant', content: [{ type: 'tool_use', id: `tu${t}-${c}`, name: 'Bash', input: { command: `step ${t}.${c}` } }] } });
      lines.push({ type: 'user', timestamp: at(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu${t}-${c}`, content: `out ${t}.${c} `.repeat(40) }] } });
    }
    lines.push({ type: 'assistant', timestamp: at(), message: { id: `p${t}`, role: 'assistant', content: [{ type: 'text', text: `Part ${t} done.` }] } });
  }
  return lines;
}

let fileChars = 0;
/** About a ninth of the way in: most of the conversation is after it. */
let SINCE = '';

beforeAll(async () => {
  const dir = path.join(CLAUDE_HOME, 'projects', encodeProjectPath(CWD));
  await fsp.rm(path.dirname(CLAUDE_HOME), { recursive: true, force: true });
  await fsp.mkdir(dir, { recursive: true });
  const text = busyLines().map((l) => JSON.stringify(l)).join('\n') + '\n';
  fileChars = text.length;
  SINCE = new Date(T0 + Math.floor(seq / 9) * 1000 + 500).toISOString();
  await fsp.writeFile(path.join(dir, 's-walk.jsonl'), text);
  await fsp.writeFile(path.join(dir, 's-ooo.jsonl'), outOfOrderLines().map((l) => JSON.stringify(l)).join('\n') + '\n');
});

/** Sixty asks and replies a second apart; reply 40 was written with its clock far behind. */
function outOfOrderLines(): unknown[] {
  const iso = (s: number) => new Date(T0 + s * 1000).toISOString();
  const lines: unknown[] = [];
  let s = 1000;
  for (let t = 0; t < 60; t++) {
    lines.push({ type: 'user', uuid: `u${t}`, timestamp: iso(s++), message: { role: 'user', content: [{ type: 'text', text: `ask ${t}` }] } });
    lines.push({ type: 'assistant', uuid: `a${t}`, timestamp: iso(t === 40 ? 5 : s++), message: { id: `p${t}`, role: 'assistant', content: [{ type: 'text', text: `reply ${t}` }] } });
  }
  return lines;
}

type Call = (method: string, p: string) => Promise<unknown>;

/** The op's calls, the transcript one built the way GET /api/v1/sessions/:id/transcript builds it. */
function routeCall(reads: string[], sid = 's-walk'): Call {
  return async (_method, p) => {
    if (p.startsWith('/tasks/t-1/sessions')) return { sessions: [{ session_id: sid, engine: 'claude', active: true }] };
    if (p.startsWith('/tasks/')) return { task: { id: 't-1', session_id: sid } };
    reads.push(p);
    const q = new URLSearchParams(p.split('?')[1] ?? '');
    const visible = q.get('visible') ? Math.min(Number(q.get('visible')), TRANSCRIPT_VISIBLE_MAX) : undefined;
    return buildSessionTranscript(sid, {
      rich: false,
      live: true,
      ...(q.get('ids') === '1' ? { ids: true } : {}),
      ...(q.get('before') ? { before: q.get('before')! } : {}),
      ...(q.get('beforeId') ? { beforeId: q.get('beforeId')! } : {}),
      ...(visible ? { visible } : {}),
      ...(q.get('since') ? { since: q.get('since')! } : {}),
    });
  };
}

const run = (input: Record<string, unknown>, call: Call) =>
  (getOp('task_history')!.handler as (i: Record<string, unknown>, c: Call) => Promise<Record<string, unknown>>)(input, call);

describe('a task_history walk back to since', () => {
  it('reads each page once, reads every row after since exactly once, and parses the file on the first page only', async () => {
    const reads: string[] = [];
    const call = routeCall(reads);
    const rows: Array<Record<string, unknown>> = [];
    let before: string | undefined;
    let calls = 0;
    let afterFirst = 0;
    let leaked = 0;
    parsed.chars = 0;
    for (;;) {
      const out = await run({ id: 't-1', limit: 200, since: SINCE, compact: true, ...(before ? { before } : {}) }, call);
      calls++;
      if (calls === 1) afterFirst = parsed.chars;
      if ('sinceReached' in out) leaked++;
      rows.push(...(out.messages as Array<Record<string, unknown>>));
      const older = out.older as { before: string } | undefined;
      if (!older) break;
      before = older.before;
      expect(calls).toBeLessThan(40);
    }
    // The route's page holds at most 600 rows; the conversation after since is several of them.
    expect(calls).toBeGreaterThan(3);
    // One read per page: before, every page also read the page before it.
    expect(reads).toHaveLength(calls);
    expect(reads.every((p) => p.includes('since='))).toBe(true);
    // The route's word to the op is not part of the op's answer.
    expect(leaked).toBe(0);

    // The same rows a single whole read holds after since, each once, none missing.
    const walked = parsed.chars;
    const whole = await buildSessionTranscript('s-walk', { full: true });
    const key = (r: Record<string, unknown>) => `${r.timestamp}|${r.role}|${r.kind ?? ''}`;
    const want = whole.messages.filter((r) => Date.parse(r.timestamp) > Date.parse(SINCE)).map((r) => key(r)).sort();
    expect(rows.map(key).sort()).toEqual(want);

    // The parse is kept between pages: the first page parsed the file (its incremental seed
    // checks itself with more parses of it), and no later page parsed a line of it again.
    expect(afterFirst).toBeGreaterThanOrEqual(fileChars);
    expect(walked).toBe(afterFirst);
  }, 60_000);

  it('a page that reached since and one its bound stopped say so', async () => {
    const reached = await buildSessionTranscript('s-walk', { live: true, visible: 200, since: new Date(Date.parse(SINCE) + seq * 1000 * 0.8).toISOString() });
    expect(reached.sinceReached).toBe(true);
    const capped = await buildSessionTranscript('s-walk', { live: true, visible: 200, since: SINCE });
    expect(capped.truncated).toBe(true);
    expect(capped.sinceReached).toBe(false);
    // Without since the page says nothing about it: the answer every other reader gets is unchanged.
    expect(await buildSessionTranscript('s-walk', { live: true, visible: 5 })).not.toHaveProperty('sinceReached');
  });
});

/** Walk back from the newest page following older (its cursor fields, without `how`); pages oldest first. */
async function walk(input: Record<string, unknown>, call: Call, agent: boolean): Promise<Array<Record<string, unknown>>> {
  const pages: Array<Array<Record<string, unknown>>> = [];
  let cursor: Record<string, unknown> = {};
  for (let n = 0; n < 60; n++) {
    const args = { id: 't-1', ...input, ...cursor };
    const raw = await run(args, call);
    const out = (agent ? agentAnswer(getOp('task_history')!, { ...args }, raw, false, 'cli') : raw) as Record<string, unknown>;
    pages.unshift(out.messages as Array<Record<string, unknown>>);
    const older = out.older as Record<string, unknown> | undefined;
    if (!older) return pages.flat();
    const { how: _how, ...next } = older;
    cursor = next;
  }
  throw new Error('the walk never reached the start: it asked for the same page again');
}

describe('a task_history walk past a row stamped out of time order', () => {
  const whole = async () => (await buildSessionTranscript('s-ooo', { full: true })).messages.map((r) => `${r.role}|${r.timestamp}|${r.text}`);
  const line = (r: Record<string, unknown>) => `${r.role}|${r.timestamp}|${r.text}`;
  it.each([3, 5, 20, 150])('limit %i: the pages put together are the whole read, row for row', async (limit) => {
    const rows = await walk({ limit }, routeCall([], 's-ooo'), false);
    expect(rows.map(line)).toEqual(await whole());
  });
  it('an agent\'s default read (the newest messages, compact, fitted) walks back the same', async () => {
    const rows = await walk({}, routeCall([], 's-ooo'), true);
    expect(rows.map(line)).toEqual(await whole());
    // The ids the cuts paged by are not in the agent's answer.
    expect(rows.some((r) => 'msgId' in r)).toBe(false);
  });
});

describe('sinceReachedBy', () => {
  const row = (ts: string) => ({ role: 'assistant', text: 'x', timestamp: ts }) as never;
  const h = [row('2026-01-01T00:00:01Z'), row('2026-01-01T00:00:02Z'), row('2026-01-01T00:00:03Z'), row('2026-01-01T00:00:04Z')];
  it('looks at the rows before the page, as the page before would', () => {
    expect(sinceReachedBy(h, 2, '2026-01-01T00:00:02Z', false)).toBe(true);
    expect(sinceReachedBy(h, 2, '2026-01-01T00:00:01Z', false)).toBe(false);
    // A row out of time order before the page still counts.
    const odd = [row('2026-01-01T00:00:09Z'), ...h];
    expect(sinceReachedBy(odd, 3, '2026-01-01T00:00:05Z', false)).toBe(false);
  });
  it('counts only messages a page draws: a system line or an injected one after since is not unread', () => {
    const sys = { role: 'system', text: 'Context compacted', timestamp: '2026-01-01T00:00:09Z' } as never;
    const injected = { role: 'user', injected: true, text: 'Base directory for this skill: /x', timestamp: '2026-01-01T00:00:09Z' } as never;
    const cliError = { role: 'system', cliError: true, text: 'Prompt is too long', timestamp: '2026-01-01T00:00:09Z' } as never;
    expect(sinceReachedBy([...h, sys, injected, ...h], 6, '2026-01-01T00:00:05Z', false)).toBe(true);
    // Claude Code's error reply is drawn (as the turn's last words): it is unread.
    expect(sinceReachedBy([...h, cliError, ...h], 5, '2026-01-01T00:00:05Z', false)).toBe(false);
  });
  it('the start of the file reached since; the start of a window cannot tell', () => {
    expect(sinceReachedBy(h, 0, '2026-01-01T00:00:00Z', false)).toBe(true);
    expect(sinceReachedBy(h, 0, '2026-01-01T00:00:00Z', true)).toBeUndefined();
    expect(sinceReachedBy(h, 1, '2026-01-01T00:00:00Z', true)).toBe(false);
  });
});

describe('a page named by its row, in a file read in windows', () => {
  // About 10 MB, three 4 MB windows, past an 8 MB ceiling. Row R sits in window 1 but was stamped
  // before every other row: the search by stamp lands in window 0, before R's window.
  const SID = 's-win';
  let R = { ts: '', id: 'p-r' };
  beforeAll(async () => {
    const iso = (s: number) => new Date(T0 + s * 1000).toISOString();
    const lines: string[] = [];
    let bytes = 0;
    let s = 10_000;
    for (let t = 0; bytes < 10 * 1024 * 1024; t++) {
      const odd = bytes > 6 * 1024 * 1024 && R.ts === '';
      const reply = odd
        ? { type: 'assistant', uuid: 'a-r', timestamp: (R.ts = iso(5)), message: { id: R.id, role: 'assistant', content: [{ type: 'text', text: 'the odd reply' }] } }
        : { type: 'assistant', uuid: `a${t}`, timestamp: iso(s++), message: { id: `p${t}`, role: 'assistant', content: [{ type: 'text', text: `reply ${t}` }] } };
      for (const l of [
        { type: 'user', uuid: `u${t}`, timestamp: iso(s++), message: { role: 'user', content: [{ type: 'text', text: `ask ${t} ${'.'.repeat(3000)}` }] } },
        reply,
      ]) { const j = JSON.stringify(l); lines.push(j); bytes += j.length + 1; }
    }
    await fsp.writeFile(path.join(CLAUDE_HOME, 'projects', encodeProjectPath(CWD), `${SID}.jsonl`), lines.join('\n') + '\n');
  });

  it('ends just before that row, with the rows before it however they are stamped', async () => {
    const line = (r: { role: string; timestamp: string; text: string }) => `${r.role}|${r.timestamp}|${r.text}`;
    // The whole file in its order (the full read: 10 MB is under the default ceiling).
    const whole = await readSessionHistory(SID, CWD, undefined, undefined, { skipSubagents: true });
    const at = whole.findIndex((r) => r.text === 'the odd reply');
    expect(at).toBeGreaterThan(1000);
    const was = process.env.WALNUT_MAX_FILE_READ_BYTES;
    // Past this the file is read only in windows (each 4 MB, under it), and R is not in its 4 MB tail.
    process.env.WALNUT_MAX_FILE_READ_BYTES = String(8 * 1024 * 1024);
    try {
      const page = (await buildSessionTranscript(SID, { live: true, before: R.ts, beforeId: R.id, visible: 20 })).messages;
      expect(page.length).toBeGreaterThan(0);
      // Before: the windows were searched by stamp, R's window never read, and the page was cut
      // by time in window 0 (nothing in it is older than R's stamp): an empty page.
      expect(page.map(line)).toEqual(whole.slice(at - page.length, at).map(line));
    } finally {
      if (was === undefined) delete process.env.WALNUT_MAX_FILE_READ_BYTES; else process.env.WALNUT_MAX_FILE_READ_BYTES = was;
    }
  });
});
