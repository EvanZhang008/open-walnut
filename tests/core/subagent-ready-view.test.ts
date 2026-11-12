/**
 * A subagent's transcript is read on its own host, never moved across the daemon link whole
 * ('history-ready-subagent-v1': src/providers/history-ready-core.ts with `agentId`, and the
 * server's side, src/core/subagent-ready-view.ts).
 *
 * 2026-11-12: a 10 MB agent transcript on a dev box ("Old-side parity harness") read
 * "Failed to load transcript" in the Background tasks reader on every open: the server read the
 * whole file in 1 MB ranges over the link and parsed it, past the browser's 15 s request.
 *
 * Pinned here:
 *   - a transcript of over 8 MB answers a bounded view (rows, JSON bytes), its newest rows,
 *     says it is windowed, carries the effort the CLI recorded, and echoes the agent;
 *   - an agent id that could leave the folder is refused; a missing file answers not-found;
 *   - the server takes only an answer for this agent, of this row schema, and asks once more
 *     while the host builds; a host without the capability is never asked; a host that has the
 *     view and fails it answers failed, never the whole-file read;
 *   - getSubagentHistoryPayload never reads the whole file when the host answers.
 *
 * The host side runs the real module against a temp Claude home (mkdtemp; only that is removed).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { transcript } from '../helpers/transcript-fixtures.js';
import {
  createHistoryReady, decodeReadyRows, inThreadReadyExecutor, readyRequestFromWire, READY_MAX_JSON_BYTES,
  type HistoryReady,
} from '../../src/providers/history-ready-core.js';
import { encodeProjectPathCore } from '../../src/providers/session-changes-core.js';
import { fetchSubagentView, SUBAGENT_READY_CAPABILITY, SUBAGENT_VIEW_ROWS, type SubagentViewDeps } from '../../src/core/subagent-ready-view.js';
import type { ReadyViewConnection } from '../../src/core/history-ready-view.js';
import type { SessionHistoryMessage } from '../../src/core/history-parse.js';

const CWD = '/proj/subagent-view';
const SID = '50ff92ce-0000-4000-8000-000000000001';
const AGENT = 'a5d7e0c1f2b3';

let claudeHome: string;
beforeEach(async () => { claudeHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'subagent-view-')); });
afterEach(async () => { await fsp.rm(claudeHome, { recursive: true, force: true }); });

const projectDir = (): string => path.join(claudeHome, 'projects', encodeProjectPathCore(CWD));
async function writeSession(): Promise<void> {
  await fsp.mkdir(projectDir(), { recursive: true });
  await fsp.writeFile(path.join(projectDir(), `${SID}.jsonl`), transcript().user('u1', 'run the harness').assistant('a1', 'Started an agent.').text());
}
/** An agent transcript of about `mb` MB: many steps, each with a large tool output. */
async function writeAgent(mb: number): Promise<string> {
  const t = transcript();
  const big = 'x'.repeat(40_000);
  const steps = Math.ceil((mb * 1024 * 1024) / (big.length + 600));
  t.user('s-start', 'Run the old-side parity harness.');
  for (let i = 0; i < steps; i++) {
    t.assistant(`s-a${i}`, `step ${i}: ${big}`, { effort: 'xhigh' });
    t.user(`s-u${i}`, `ok ${i}`);
  }
  t.assistant('s-last', 'Harness finished: 3 differences.', { effort: 'xhigh' });
  const dir = path.join(projectDir(), SID, 'subagents');
  await fsp.mkdir(dir, { recursive: true });
  const p = path.join(dir, `agent-${AGENT}.jsonl`);
  await fsp.writeFile(p, t.text());
  return p;
}
const make = (): HistoryReady => createHistoryReady({ executor: inThreadReadyExecutor });
const ask = (r: HistoryReady, over: Record<string, unknown> = {}) =>
  r.readyView(readyRequestFromWire({ sid: SID, cwd: CWD, agentId: AGENT, turns: 1, rows: SUBAGENT_VIEW_ROWS, budgetMs: 30_000, interactive: true, ...over }, claudeHome));

describe('the host builds a subagent view next to its file', () => {
  it('a transcript of over 8 MB answers a bounded, windowed view of its newest rows, with the recorded effort', async () => {
    await writeSession();
    const p = await writeAgent(10);
    expect((await fsp.stat(p)).size).toBeGreaterThan(8 * 1024 * 1024);
    const answer = await ask(make());
    expect(answer.status, JSON.stringify(answer).slice(0, 300)).toBe('ready');
    if (answer.status !== 'ready') return;
    expect(answer.agentId).toBe(AGENT);
    expect(answer.windowed).toBe(true);
    expect(answer.reachedStart).toBe(false);
    expect(answer.jsonBytes).toBeLessThanOrEqual(READY_MAX_JSON_BYTES);
    const rows = decodeReadyRows(answer);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThanOrEqual(SUBAGENT_VIEW_ROWS);
    expect(rows.at(-1)?.text).toBe('Harness finished: 3 differences.');
    expect(rows.some((m) => m.text === 'Run the old-side parity harness.')).toBe(false);
    expect(rows.filter((m) => m.role === 'assistant').every((m) => m.effort === 'xhigh')).toBe(true);
  }, 60_000);

  it('a small transcript reads whole, not windowed; the session view is not the agent view', async () => {
    await writeSession();
    const dir = path.join(projectDir(), SID, 'subagents');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, `agent-${AGENT}.jsonl`), transcript().user('s1', 'check it').assistant('s2', 'Checked.').text());
    const r = make();
    const agent = await ask(r);
    expect(agent).toMatchObject({ status: 'ready', agentId: AGENT, windowed: false });
    if (agent.status === 'ready') expect(decodeReadyRows(agent).map((m) => m.text)).toEqual(['check it', 'Checked.']);
    const session = await ask(r, { agentId: undefined });
    expect(session.status).toBe('ready');
    if (session.status === 'ready') {
      expect(session.agentId).toBeUndefined();
      expect(decodeReadyRows(session).map((m) => m.text)).toEqual(['run the harness', 'Started an agent.']);
    }
  });

  it('refuses an agent id that could leave the folder; a missing agent file is not-found', async () => {
    await writeSession();
    const r = make();
    for (const bad of ['../x', 'a/b', 'a\\b', '', 'x'.repeat(200)]) {
      expect(await ask(r, { agentId: bad }), bad).toMatchObject({ status: 'none', reason: 'invalid' });
    }
    expect(await ask(r, { agentId: 'nosuchagent' })).toMatchObject({ status: 'none', reason: 'not-found' });
    // Every id the server takes (session-extras.ts SUBAGENT_ID_RE), a team member's included.
    const dir = path.join(projectDir(), SID, 'subagents');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'agent-reviewer@team.x.jsonl'), transcript().user('t1', 'review').assistant('t2', 'Done.').text());
    expect(await ask(r, { agentId: 'reviewer@team.x' })).toMatchObject({ status: 'ready', agentId: 'reviewer@team.x' });
  });

  it('a small agent a later message continued reads whole: its first prompt included, not windowed', async () => {
    await writeSession();
    const t = transcript().user('c-start', 'First part of the job.');
    for (let i = 0; i < 450; i++) t.assistant(`c-a${i}`, `step ${i}`).user(`c-u${i}`, `ok ${i}`);
    t.user('c-more', 'Carry on with the next part.').assistant('c-end', 'Next part done.');
    const dir = path.join(projectDir(), SID, 'subagents');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, `agent-${AGENT}.jsonl`), t.text());
    const answer = await ask(make());
    expect(answer).toMatchObject({ status: 'ready', windowed: false });
    if (answer.status === 'ready') {
      const rows = decodeReadyRows(answer);
      expect(rows[0]?.text).toBe('First part of the job.');
      expect(rows.at(-1)?.text).toBe('Next part done.');
    }
  });
});

/** A connection whose daemon is the real host module over the temp home. */
function hostConnection(r: HistoryReady, caps: string[] = [SUBAGENT_READY_CAPABILITY], tamper?: (a: Record<string, unknown>) => Record<string, unknown>) {
  const sent: Array<Record<string, unknown>> = [];
  const conn: ReadyViewConnection = {
    hasCapability: (c: string) => caps.includes(c),
    send: async (cmd: string, payload: Record<string, unknown>) => {
      sent.push({ cmd, ...payload });
      const answer = await r.readyView(readyRequestFromWire(payload, claudeHome)) as unknown as Record<string, unknown>;
      return { ok: true, ...(tamper ? tamper(answer) : answer) };
    },
  } as unknown as ReadyViewConnection;
  return { conn, sent };
}
const deps = (conn: ReadyViewConnection | null): SubagentViewDeps => ({
  connectionFor: () => conn,
  rewriteImages: async (rows: SessionHistoryMessage[]) => rows,
});
const RECORD = { claudeSessionId: SID, cwd: CWD, host: 'clouddev' };

describe('the server takes only this agent\'s view', () => {
  it('asks the host for the agent with a bounded row count, and gets rows that say they are windowed', async () => {
    await writeSession();
    await writeAgent(9);
    const { conn, sent } = hostConnection(make());
    const out = await fetchSubagentView(RECORD, AGENT, deps(conn));
    expect(out.kind).toBe('rows');
    if (out.kind !== 'rows') return;
    expect(out.view.windowed).toBe(true);
    expect(out.view.messages.length).toBeLessThanOrEqual(SUBAGENT_VIEW_ROWS);
    expect(out.view.messages.at(-1)?.effort).toBe('xhigh');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ cmd: 'history.readyView', sid: SID, agentId: AGENT, rows: SUBAGENT_VIEW_ROWS, interactive: true });
  }, 60_000);

  it('a host without the capability is never asked', async () => {
    const { conn, sent } = hostConnection(make(), ['history-ready-v1']);
    expect(await fetchSubagentView(RECORD, AGENT, deps(conn))).toEqual({ kind: 'unavailable', reason: 'no-capability' });
    expect(await fetchSubagentView(RECORD, AGENT, deps(null))).toEqual({ kind: 'unavailable', reason: 'no-capability' });
    expect(sent).toHaveLength(0);
  });

  it('an answer that is not this agent\'s is refused; another schema reads the old way; another parser build is shown', async () => {
    await writeSession();
    await writeAgent(0.01);
    const noEcho = hostConnection(make(), undefined, (a) => { const { agentId: _a, ...rest } = a; return rest; });
    expect(await fetchSubagentView(RECORD, AGENT, deps(noEcho.conn))).toEqual({ kind: 'failed', reason: 'not-this-agent' });
    const schema = hostConnection(make(), undefined, (a) => ({ ...a, schema: 1 }));
    expect(await fetchSubagentView(RECORD, AGENT, deps(schema.conn))).toEqual({ kind: 'unavailable', reason: 'schema' });
    const other = hostConnection(make(), undefined, (a) => ({ ...a, parser: 'someotherbuild' }));
    expect((await fetchSubagentView(RECORD, AGENT, deps(other.conn))).kind).toBe('rows');
  });

  it('a host that has the view and fails it is failed, never the whole-file read; no file there is the old read', async () => {
    const answering = (answer: Record<string, unknown> | Error) => ({
      hasCapability: () => true,
      send: async () => { if (answer instanceof Error) throw answer; return { ok: true, ...answer }; },
    } as unknown as ReadyViewConnection);
    for (const [answer, reason] of [
      [{ status: 'pending', reason: 'too-large' }, 'pending:too-large'],
      [{ status: 'pending', reason: 'not-readable' }, 'pending:not-readable'],
      [{ status: 'none', reason: 'read-failed' }, 'none:read-failed'],
      [{ status: 'none', reason: 'no-worker' }, 'none:no-worker'],
      [new Error('connection closed before clouddev answered'), 'connection closed before clouddev answered'],
    ] as const) {
      expect(await fetchSubagentView(RECORD, AGENT, deps(answering(answer as never)))).toEqual({ kind: 'failed', reason });
    }
    expect(await fetchSubagentView(RECORD, AGENT, deps(answering({ status: 'none', reason: 'not-found' })))).toEqual({ kind: 'unavailable', reason: 'not-found' });
  });

  it('a build still running is asked once more, then answered pending (the reader asks again)', async () => {
    const sent: unknown[] = [];
    const conn = {
      hasCapability: () => true,
      send: async (_cmd: string, payload: unknown) => { sent.push(payload); return { ok: true, status: 'pending', reason: 'building' }; },
    } as unknown as ReadyViewConnection;
    expect(await fetchSubagentView(RECORD, AGENT, deps(conn))).toEqual({ kind: 'pending' });
    expect(sent).toHaveLength(2);
  });
});

describe('getSubagentHistoryPayload', () => {
  afterEach(() => { vi.doUnmock('../../src/core/subagent-ready-view.js'); vi.doUnmock('../../src/core/session-tracker.js'); vi.doUnmock('../../src/core/session-history.js'); vi.resetModules(); });

  async function load(outcome: unknown) {
    vi.resetModules();
    const readWhole = vi.fn(async () => [{ role: 'assistant', text: 'whole file', timestamp: '' }]);
    vi.doMock('../../src/core/session-tracker.js', async (orig) => ({ ...(await orig<object>()), getSessionByClaudeId: async () => RECORD }));
    vi.doMock('../../src/core/subagent-ready-view.js', async (orig) => ({ ...(await orig<object>()), fetchSubagentView: async () => outcome }));
    vi.doMock('../../src/core/session-history.js', async (orig) => ({ ...(await orig<object>()), readSingleSubagentHistory: readWhole, rewriteHistoryRemoteImages: async (m: unknown) => m }));
    const { getSubagentHistoryPayload } = await import('../../src/core/sessions/session-extras.js');
    return { getSubagentHistoryPayload, readWhole };
  }

  it('answers the host\'s view and never reads the whole file', async () => {
    const rows = [{ role: 'assistant', text: 'newest', timestamp: '', effort: 'xhigh' }];
    const { getSubagentHistoryPayload, readWhole } = await load({ kind: 'rows', view: { messages: rows, total: 900, windowed: true } });
    expect(await getSubagentHistoryPayload(SID, AGENT, false)).toEqual({ messages: rows, windowed: true, total: 900 });
    expect(readWhole).not.toHaveBeenCalled();
  });

  it('a view still building answers pending, never a whole-file read', async () => {
    const { getSubagentHistoryPayload, readWhole } = await load({ kind: 'pending' });
    expect(await getSubagentHistoryPayload(SID, AGENT, false)).toEqual({ messages: [], pending: true });
    expect(readWhole).not.toHaveBeenCalled();
  });

  it('a host that failed the view answers an error, never the whole-file read', async () => {
    const { getSubagentHistoryPayload, readWhole } = await load({ kind: 'failed', reason: 'pending:too-large' });
    await expect(getSubagentHistoryPayload(SID, AGENT, false)).rejects.toMatchObject({ statusCode: 502 });
    expect(readWhole).not.toHaveBeenCalled();
  });

  it('a host without the view keeps the old read', async () => {
    const { getSubagentHistoryPayload, readWhole } = await load({ kind: 'unavailable', reason: 'no-capability' });
    expect((await getSubagentHistoryPayload(SID, AGENT, false)).messages).toHaveLength(1);
    expect(readWhole).toHaveBeenCalledTimes(1);
  });
});
