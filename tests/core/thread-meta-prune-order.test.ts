/**
 * patchSession ordering for thread writes (spec 7.2, C55 server half):
 * anchors first, then the meta upsert + follow-up reopen, then prune, in ONE
 * record write. Real session store against a temp WALNUT_HOME.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-thread-meta-prune'));

import { closeDb } from '../../src/core/session-db.js';
import {
  _resetSessionTrackerForTesting, createSessionRecord, getSessionByClaudeId, updateSessionRecord,
} from '../../src/core/session-tracker.js';
import { patchSession } from '../../src/core/sessions/session-lifecycle.js';
import {
  __resetThreadMetaForTesting, followUpReopen, pruneThreadMeta, THREAD_META_ORPHAN_TTL_MS,
} from '../../src/core/sessions/thread-meta.js';
import { WALNUT_HOME } from '../../src/constants.js';
import type { SessionThreadAnchor, SessionThreadMeta } from '../../src/core/types.js';

const SID = 'unit-ai-prune-0001';
const OFF_SID = 'plain-prune-0002';
const anchor = (msgId: string, over: Partial<SessionThreadAnchor> = {}): SessionThreadAnchor => ({
  msgId, parent: 'reply-1', quote: { exact: 'the cache warms on boot' }, source: 'selection',
  at: '2026-09-26T10:00:00.000Z', ...over,
});

beforeEach(async () => {
  process.env.WALNUT_THREAD_AI_STUB = 'unit-ai-';
  closeDb();
  _resetSessionTrackerForTesting();
  __resetThreadMetaForTesting();
  // A late record write from the previous case can land mid-delete (ENOTEMPTY under load).
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3 });
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
  await createSessionRecord(SID, 'task-prune', 'proj', '/tmp');
  await createSessionRecord(OFF_SID, 'task-prune-2', 'proj', '/tmp');
});

afterEach(() => {
  delete process.env.WALNUT_THREAD_AI_STUB;
  closeDb();
  _resetSessionTrackerForTesting();
});

describe('thread writes through patchSession', () => {
  it('meta-only PATCH first, anchor PATCH later: the entry survives, still pending', async () => {
    await patchSession(SID, { thread_meta: [{ headId: 'head-a', status: 'open', titleState: 'pending', question: 'why?' }] });
    let rec = await getSessionByClaudeId(SID);
    expect(rec?.threadMeta?.[0]).toMatchObject({ headId: 'head-a', titleState: 'pending' });
    expect(rec?.threadAnchors).toBeUndefined();

    await patchSession(SID, { thread_anchors: [anchor('head-a')] });
    rec = await getSessionByClaudeId(SID);
    expect(rec?.threadAnchors?.map((a) => a.msgId)).toEqual(['head-a']);
    expect(rec?.threadMeta).toHaveLength(1);
    expect(rec?.threadMeta?.[0]).toMatchObject({ headId: 'head-a', status: 'open', titleState: 'pending' });
  });

  it('one body with both applies anchors and meta together', async () => {
    const rec = await patchSession(SID, {
      thread_anchors: [anchor('head-b')],
      thread_meta: [{ headId: 'head-b', status: 'open', titleState: 'pending' }],
    });
    expect(rec.threadAnchors?.[0].msgId).toBe('head-b');
    expect(rec.threadMeta?.[0]).toMatchObject({ headId: 'head-b', status: 'open', titleState: 'pending' });
    expect(Date.parse(rec.threadMeta![0].updatedAt)).toBeGreaterThan(Date.now() - 60_000);
  });

  it('prunes an entry without an anchor once it is older than 10 minutes', async () => {
    const old = new Date(Date.now() - THREAD_META_ORPHAN_TTL_MS - 1000).toISOString();
    const fresh = new Date().toISOString();
    await updateSessionRecord(SID, { threadMeta: [
      { headId: 'orphan-old', status: 'open', updatedAt: old },
      { headId: 'orphan-young', status: 'open', updatedAt: fresh },
      { headId: 'anchored-old', status: 'resolved', updatedAt: old },
    ] });
    await patchSession(SID, { thread_anchors: [anchor('anchored-old')] });
    const rec = await getSessionByClaudeId(SID);
    expect(rec?.threadMeta?.map((e) => e.headId)).toEqual(['orphan-young', 'anchored-old']);
  });

  it('gate closed for the session: pending is stored as unavailable', async () => {
    const rec = await patchSession(OFF_SID, { thread_meta: [{ headId: 'h', status: 'open', titleState: 'pending' }] });
    expect(rec.threadMeta?.[0].titleState).toBe('unavailable');
  });

  it('a follow-up on the same passage takes a suggested question back to open', async () => {
    await patchSession(SID, {
      thread_anchors: [anchor('head-c')],
      thread_meta: [{ headId: 'head-c', status: 'open' }],
    });
    await updateSessionRecord(SID, { threadMeta: [{ headId: 'head-c', status: 'suggested', updatedAt: new Date().toISOString() }] });
    const rec = await patchSession(SID, {
      thread_anchors: [anchor('head-c'), anchor('follow-1', { source: 'sticky', quote: { exact: 'the  cache warms on boot ' } })],
    });
    expect(rec.threadMeta?.[0].status).toBe('open');
  });

  it('a 400 from thread_meta leaves the record untouched', async () => {
    await expect(patchSession(SID, { thread_anchors: [anchor('x')], thread_meta: [{ headId: 'x', status: 'nope' }] }))
      .rejects.toMatchObject({ statusCode: 400 });
    const rec = await getSessionByClaudeId(SID);
    expect(rec?.threadAnchors).toBeUndefined();
  });
});

describe('pure helpers', () => {
  const now = Date.parse('2026-09-26T12:00:00.000Z');
  const e = (headId: string, ageMs: number, over: Partial<SessionThreadMeta> = {}): SessionThreadMeta => ({
    headId, status: 'open', updatedAt: new Date(now - ageMs).toISOString(), ...over,
  });

  it('pruneThreadMeta keeps anchored or young entries only', () => {
    const meta = [e('a', 11 * 60_000), e('b', 9 * 60_000), e('c', 60 * 60_000)];
    expect(pruneThreadMeta(meta, [anchor('c')], now).map((m) => m.headId)).toEqual(['b', 'c']);
  });

  it('followUpReopen: suggested and older reopen, resolved stays, other passages ignored', () => {
    const meta = [e('h1', 0, { status: 'suggested' }), e('h2', 0, { status: 'older' }), e('h3', 0, { status: 'resolved' })];
    const prev = [
      anchor('h1'),
      anchor('h2', { quote: { exact: 'second passage' } }),
      anchor('h3', { quote: { exact: 'third passage' } }),
    ];
    const next = [
      ...prev,
      anchor('f1', { source: 'sticky' }),
      anchor('f2', { source: 'sticky', quote: { exact: 'second passage' } }),
      anchor('f3', { source: 'sticky', quote: { exact: 'third passage' } }),
      anchor('f4', { source: 'sticky', quote: { exact: 'unrelated passage' } }),
    ];
    const out = followUpReopen(meta, prev, next, '2026-09-26T12:00:01.000Z');
    expect(out.meta.map((m) => m.status)).toEqual(['open', 'open', 'resolved']);
    expect(out.touched.sort()).toEqual(['h1', 'h2']);
  });
});
