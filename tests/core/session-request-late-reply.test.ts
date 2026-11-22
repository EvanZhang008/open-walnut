/**
 * A late answer to a request settled WITHOUT an answer still settles it as replied, wherever the
 * answer is applied (2026-11-22: a reply after the turn end's "finished without replying" notice
 * was delivered, but the Mac kept the request `notified`; only `expired` was turned into replied).
 *
 * The class: every status REPLY_TO_STATUS calls `late` (src/core/session-request-status.ts), on
 * every path that applies an answer: the server's one answer settle (settleReplied), the drain's import of
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
  noteAnswerDelivered,
  REQUESTS_FILE,
  answersLate,
  createSessionRequest,
  getSessionRequest,
  importOfflineRequest,
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

describe('one settle applies every answer', () => {
  /** Every src file, read once. */
  const srcFiles = (): { rel: string; text: string }[] => {
    const out: { rel: string; text: string }[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(e.name)) out.push({ rel: path.relative(ROOT, p), text: fs.readFileSync(p, 'utf8') });
      }
    };
    walk(path.join(ROOT, 'src'));
    return out;
  };

  it('no caller decides by a status it read before calling settleReplied (the store decides in its own write)', () => {
    const gated: string[] = [];
    for (const { rel, text } of srcFiles()) {
      const lines = text.split('\n');
      lines.forEach((line, i) => {
        if (!/\bsettleReplied\(/.test(line) || /function settleReplied\(/.test(line)) return;
        const near = lines.slice(Math.max(0, i - 2), i + 1).join('\n');
        if (/status\s*(?:===|!==)\s*'pending'/.test(near) || /answersLate\(/.test(near)) gated.push(`${rel}:${i + 1}`);
      });
    }
    expect(gated).toEqual([]);
  });

  it('only the request store turns a server request row replied (and the host daemon its own rows)', () => {
    const writers = srcFiles()
      .filter(({ rel, text }) => /status: 'replied'|status = 'replied'/.test(text) && /SessionRequest|OfflineRequestRow/.test(text))
      .map(({ rel }) => rel).sort();
    expect(writers).toEqual(['src/core/session-requests.ts', 'src/providers/offline-host-core.ts']);
  });
});

describe('the server settles a late answer as replied', () => {
  it.each(LATE)('from %s, with lateFrom, exactly once', async (status) => {
    const rq = await ask();
    await INTO[status](rq.id);
    expect((await getSessionRequest(rq.id))?.status).toBe(status);
    expect(answersLate(status)).toBe(true);
    const settled = await settleReplied(rq.id, { result: 'checked' });
    expect(settled).toMatchObject({ status: 'replied', lateFrom: status, reply: { result: 'checked' } });
    expect(await getSessionRequest(rq.id)).toMatchObject({ status: 'replied', lateFrom: status });
    // Exactly once: a second late answer does not settle it again.
    expect(await settleReplied(rq.id, { result: 'again' })).toBeNull();
    expect((await getSessionRequest(rq.id))?.reply?.result).toBe('checked');
  });

  it('from pending with no lateFrom, and never again once replied', async () => {
    const rq = await ask();
    expect((await settleReplied(rq.id))?.lateFrom).toBeUndefined();
    expect(await settleReplied(rq.id)).toBeNull();
    expect((await getSessionRequest(rq.id))?.lateFrom).toBeUndefined();
  });

  it.each(LATE)('a late answer from %s owes its delivery in the same write (reply-outbox.ts)', async (status) => {
    const rq = await ask();
    await INTO[status](rq.id);
    const owed = { to: 'sess-asker', from: 'sess-target', messageId: 'qm-late-1', busText: 'b', enqueueText: 'e', source: 'peer' as const, at: new Date().toISOString() };
    const settled = await settleReplied(rq.id, null, undefined, undefined, () => owed);
    expect(settled).toMatchObject({ status: 'replied', lateFrom: status, outbox: { messageId: 'qm-late-1' } });
    expect((await getSessionRequest(rq.id))?.outbox?.messageId).toBe('qm-late-1');
  });

  it('a row settled without an answer between the caller\'s read and its settle still turns replied', async () => {
    // The caller read pending; a turn end settles it first (the race performReply used to lose).
    const rq = await ask();
    const seen = (await getSessionRequest(rq.id))!.status;
    expect(seen).toBe('pending');
    await settleNotified(rq.id, 'completed');
    expect(await settleReplied(rq.id, { result: 'raced' })).toMatchObject({ status: 'replied', lateFrom: 'notified' });
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

describe('a row whose answer went out reads replied', () => {
  const stamp = { digest: 'd1', deliveredTo: 'sess-asker' };

  it.each(LATE)('an answer delivered to a row left %s settles it in the same write', async (status) => {
    const rq = await ask();
    await INTO[status](rq.id);
    await noteAnswerDelivered(rq.id, stamp);
    expect(await getSessionRequest(rq.id)).toMatchObject({ status: 'replied', lateFrom: status, answerDigest: 'd1' });
  });

  it('a row a racing restore put back to pending reads replied once its answer went out', async () => {
    const rq = await ask();
    await noteAnswerDelivered(rq.id, stamp);
    expect(await getSessionRequest(rq.id)).toMatchObject({ status: 'replied', answerDigest: 'd1' });
    expect((await getSessionRequest(rq.id))?.lateFrom).toBeUndefined();
  });

  it('rows an older Walnut left notified with a delivered answer are mended by the next write', async () => {
    // The shape found on the Mac on 2026-11-22: 7 of 16 notified rows had a delivered answer.
    const now = Date.now();
    const old: SessionRequest = {
      id: 'rq-e7c7e121179b', fromSessionId: 'sess-asker', toSessionId: 'sess-target', preview: 'q', status: 'notified', outcome: 'completed',
      createdAt: new Date(now - 3_600_000).toISOString(), deadlineAt: now, settledAt: new Date(now - 3_000_000).toISOString(),
      answerDigest: 'd0', deliveredTo: 'sess-asker', answeredAt: new Date(now - 60_000).toISOString(),
    };
    const untouched: SessionRequest = { ...old, id: 'rq-0000000000ab', answerDigest: undefined, answeredAt: undefined };
    fs.mkdirSync(path.dirname(REQUESTS_FILE), { recursive: true });
    fs.writeFileSync(REQUESTS_FILE, JSON.stringify({ requests: [old, untouched] }));
    await ask('any write');
    expect(await getSessionRequest(old.id)).toMatchObject({ status: 'replied', lateFrom: 'notified', settledAt: old.answeredAt, outcome: 'completed' });
    expect((await getSessionRequest(untouched.id))?.status).toBe('notified');
  });
});
