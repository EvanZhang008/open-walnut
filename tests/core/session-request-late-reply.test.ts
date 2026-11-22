/**
 * A late answer to a request settled WITHOUT an answer still settles it as replied, wherever the
 * answer is applied (2026-11-22: a reply after the turn end's "finished without replying" notice
 * was delivered, but the Mac kept the request `notified`; only `expired` was turned into replied).
 *
 * The class: every status REPLY_TO_STATUS calls `late` (src/core/session-request-status.ts), on
 * every path that applies an answer: the server's settle (settleLateReply), the drain's import of
 * a host's row (importOfflineRequest), the replica copy (forwardRequest), its away fold
 * (foldAwayRequests), and the host daemon's own rows (offline-host-core.ts settleHere, which
 * inlines the list). The guards below read the status union and that inlined list from the
 * source, so a new status, or a late status one path forgets, fails here.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-session-request-late-reply'));
vi.mock('../../src/core/session-tracker.js', () => ({ getSessionByClaudeId: async () => null }));

import {
  REPLY_TO_STATUS,
  REQUESTS_FILE,
  answersLate,
  createSessionRequest,
  getSessionRequest,
  importOfflineRequest,
  settleLateReply,
  settleNotified,
  settleReplied,
  withdrawRequest,
  type SessionRequest,
  type SessionRequestStatus,
} from '../../src/core/session-requests.js';
import { forwardRequest } from '../../src/core/replication/kinds/requests.js';
import { foldAwayRequests } from '../../src/replica/away-requests.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** The members of a string-literal union type, read from its source. */
function unionOf(rel: string, name: string): string[] {
  const src = read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const m = src.match(new RegExp(`export type ${name} =([\\s\\S]*?);`));
  if (!m) throw new Error(`no ${name} in ${rel}`);
  return [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort();
}

const LATE = (Object.keys(REPLY_TO_STATUS) as SessionRequestStatus[]).filter((s) => REPLY_TO_STATUS[s] === 'late').sort();

/** Put a fresh pending request into a late status, the way Walnut settles one without an answer. */
const INTO: Record<string, (id: string) => Promise<unknown>> = {
  notified: (id) => settleNotified(id, 'completed'),
  expired: (id) => settleNotified(id, 'timeout'),
  withdrawn: (id) => withdrawRequest(id),
};

const ask = (text = 'is the venue list checked?') => createSessionRequest({
  fromSessionId: 'sess-asker', fromTaskId: 'task-asker', toSessionId: 'sess-target', toTaskId: 'task-target', text,
});

beforeEach(() => {
  fs.rmSync(REQUESTS_FILE, { force: true });
});

describe('every request status says what a reply does to it', () => {
  it('REPLY_TO_STATUS names every SessionRequestStatus, and the host daemon knows the same statuses', () => {
    const statuses = unionOf('src/core/session-requests.ts', 'SessionRequestStatus');
    expect(Object.keys(REPLY_TO_STATUS).sort()).toEqual(statuses);
    expect(unionOf('src/providers/offline-host-core.ts', 'OfflineRequestStatus')).toEqual(statuses);
    expect(LATE).toEqual(['expired', 'notified', 'withdrawn']);
  });

  it('the host daemon settles its own row from pending and from every late status (settleHere inlines the list)', () => {
    const src = read('src/providers/offline-host-core.ts');
    const body = src.slice(src.indexOf('function settleHere('), src.indexOf('function settleHere(') + 1200);
    const cond = body.match(/if \((own\.status === '[a-z]+'(?: \|\| own\.status === '[a-z]+')*)\)/);
    expect(cond, 'settleHere checks own.status against a list').toBeTruthy();
    const listed = [...cond![1].matchAll(/'([a-z]+)'/g)].map((x) => x[1]).sort();
    expect(listed).toEqual(['pending', ...LATE].sort());
  });

  it('a way to reach each late status is known to these tests', () => {
    for (const s of LATE) expect(INTO[s], `no way to put a request into '${s}' here`).toBeTypeOf('function');
  });
});

describe('the server settles a late answer as replied', () => {
  it.each(LATE)('from %s, with lateFrom, exactly once', async (status) => {
    const rq = await ask();
    await INTO[status](rq.id);
    expect((await getSessionRequest(rq.id))?.status).toBe(status);
    expect(answersLate(status)).toBe(true);
    const settled = await settleLateReply(rq.id, { result: 'checked' });
    expect(settled).toMatchObject({ status: 'replied', lateFrom: status, reply: { result: 'checked' } });
    expect(await getSessionRequest(rq.id)).toMatchObject({ status: 'replied', lateFrom: status });
    // Exactly once: a second late answer does not settle it again.
    expect(await settleLateReply(rq.id, { result: 'again' })).toBeNull();
    expect((await getSessionRequest(rq.id))?.reply?.result).toBe('checked');
  });

  it('never from pending or replied', async () => {
    const rq = await ask();
    expect(await settleLateReply(rq.id)).toBeNull();
    await settleReplied(rq.id);
    expect(await settleLateReply(rq.id)).toBeNull();
    expect((await getSessionRequest(rq.id))?.lateFrom).toBeUndefined();
  });
});

describe('the drain imports a host\'s late answer', () => {
  const hostRow = (rq: SessionRequest, over: Partial<SessionRequest>): SessionRequest => ({
    id: rq.id, fromSessionId: rq.fromSessionId, toSessionId: rq.toSessionId, toTaskId: rq.toTaskId,
    preview: rq.preview, status: 'pending', createdAt: rq.createdAt, deadlineAt: rq.deadlineAt, ...over,
  });

  it('the host journaled the turn end\'s notice, then the reply: the Mac reads replied', async () => {
    const rq = await ask();
    const at = new Date().toISOString();
    expect(await importOfflineRequest(hostRow(rq, { status: 'notified', outcome: 'completed', settledAt: at }))).toBe(true);
    expect(await importOfflineRequest(hostRow(rq, { status: 'replied', outcome: 'completed', settledAt: at }))).toBe(true);
    expect(await getSessionRequest(rq.id)).toMatchObject({ status: 'replied', lateFrom: 'notified' });
  });

  it.each(LATE)('a row the Mac settled as %s takes the host\'s reply, keeping the Mac\'s own fields', async (status) => {
    const rq = await ask();
    await INTO[status](rq.id);
    const here = (await getSessionRequest(rq.id))!;
    const at = new Date(Date.now() + 1000).toISOString();
    expect(await importOfflineRequest(hostRow(rq, { status: 'replied', settledAt: at }))).toBe(true);
    const row = await getSessionRequest(rq.id);
    expect(row).toMatchObject({ status: 'replied', lateFrom: status, settledAt: at });
    expect(row?.outcome).toBe(here.outcome);
  });

  it('never moves a replied row back, nor a late row to another late status', async () => {
    const a = await ask('a');
    await settleReplied(a.id);
    expect(await importOfflineRequest(hostRow(a, { status: 'notified', outcome: 'completed' }))).toBe(false);
    expect((await getSessionRequest(a.id))?.status).toBe('replied');
    const b = await ask('b');
    await settleNotified(b.id, 'completed');
    expect(await importOfflineRequest(hostRow(b, { status: 'expired', outcome: 'timeout' }))).toBe(false);
    expect((await getSessionRequest(b.id))?.status).toBe('notified');
  });
});

describe('a host replica keeps the answer it holds', () => {
  const row = (status: SessionRequestStatus): SessionRequest => ({
    id: 'rq-0a0b0c0d0e0f', fromSessionId: 'sess-asker', toSessionId: 'sess-target', preview: 'q',
    status, createdAt: new Date(0).toISOString(), deadlineAt: 1,
  });

  it.each(LATE)('a copy\'s replied row stays replied when the leader still says %s', (status) => {
    expect(forwardRequest(row('replied'), row(status)).status).toBe('replied');
  });

  it('the leader\'s replied still wins over a copy\'s late status', () => {
    for (const s of LATE) expect(forwardRequest(row(s), row('replied')).status).toBe('replied');
  });

  it.each(LATE)('the away fold applies the host\'s settle over a copy row the Mac settled as %s', (status) => {
    const out = foldAwayRequests([row(status)], [{ kind: 'settle', seq: 1, at: 5, record: { requestId: 'rq-0a0b0c0d0e0f', status: 'replied' } }]);
    expect(out[0].status).toBe('replied');
  });
});
