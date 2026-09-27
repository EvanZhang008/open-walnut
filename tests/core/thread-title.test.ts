/**
 * Server AI naming for conversation questions (src/core/sessions/thread-title.ts).
 *
 * Covers C23 (gate closed -> unavailable), C42 (dedupe, cap 2, error skips),
 * C54 (name at send, 30s sweep, refine once), C53 server half (verdict stored
 * as suggested, at most two calls per question) and C16 (a rename that lands
 * while the model runs wins). Real session store, fake model.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-thread-title'));

import { closeDb } from '../../src/core/session-db.js';
import {
  _resetSessionTrackerForTesting, createSessionRecord, getSessionByClaudeId, updateSessionRecord,
} from '../../src/core/session-tracker.js';
import { bus, EventNames } from '../../src/core/event-bus.js';
import { patchSession } from '../../src/core/sessions/session-lifecycle.js';
import { __resetThreadMetaForTesting } from '../../src/core/sessions/thread-meta.js';
import {
  __resetThreadAiCallsForTesting, __setThreadAiModelForTesting, threadAiCallCounts, type ThreadAiRequest,
} from '../../src/core/sessions/thread-ai-stub.js';
import {
  __resetThreadTitlerForTesting, __threadTitlesIdleForTesting, parseRefineAnswer, startThreadTitler,
  THREAD_REFINE_REQUIREMENT, THREAD_TITLE_REQUIREMENT,
} from '../../src/core/sessions/thread-title.js';
import { noteTurnUserUuid } from '../../src/providers/batch-uuid.js';
import { WALNUT_HOME } from '../../src/constants.js';
import type { SessionThreadMeta } from '../../src/core/types.js';

const SID = 'unit-ai-title-0001';
const OFF_SID = 'plain-title-0002';
const PASSAGE = 'the cache warms on boot';

let calls: ThreadAiRequest[] = [];
let answer: (req: ThreadAiRequest) => Promise<string | null>;
let titler: { stop: () => void };

const anchor = (msgId: string) => ({ msgId, parent: 'reply-1', quote: { exact: PASSAGE }, source: 'selection', at: '2026-09-26T10:00:00.000Z' });
const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) { await tick(); await __threadTitlesIdleForTesting(); }
}
async function metaOf(sid: string, headId: string): Promise<SessionThreadMeta | undefined> {
  return (await getSessionByClaudeId(sid))?.threadMeta?.find((e) => e.headId === headId);
}
function emitResult(data: Record<string, unknown>): void {
  bus.emit(EventNames.SESSION_RESULT, { sessionId: SID, result: 'The cache warms on boot because the loader primes it.', ...data }, ['*']);
}
/** A question that already has its name-at-send title (so only the refine runs). */
async function seedNamed(headId: string, over: Partial<SessionThreadMeta> = {}): Promise<void> {
  const rec = await getSessionByClaudeId(SID);
  await updateSessionRecord(SID, {
    threadAnchors: [...(rec?.threadAnchors ?? []), anchor(headId)] as never,
    threadMeta: [...(rec?.threadMeta ?? []), {
      headId, status: 'open', title: 'Cache warmup', titleSource: 'ai', titleState: 'done',
      question: 'why is it warm stub-answered', updatedAt: new Date().toISOString(), ...over,
    }],
  });
}

beforeEach(async () => {
  process.env.WALNUT_THREAD_AI_STUB = 'unit-ai-';
  closeDb();
  _resetSessionTrackerForTesting();
  __resetThreadMetaForTesting();
  __resetThreadTitlerForTesting();
  __resetThreadAiCallsForTesting();
  bus.clear();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
  await createSessionRecord(SID, 'task-title', 'proj', '/tmp');
  await createSessionRecord(OFF_SID, 'task-title-2', 'proj', '/tmp');
  calls = [];
  answer = async (req) => (req.kind === 'refine' ? 'Title: Cache warmup on boot\nAnswered: yes' : 'Cache warmup');
  __setThreadAiModelForTesting(async (req) => { calls.push(req); return answer(req); });
  titler = startThreadTitler();
});

afterEach(async () => {
  titler.stop();
  await settle();
  __setThreadAiModelForTesting(null);
  noteTurnUserUuid(SID, undefined);
  delete process.env.WALNUT_THREAD_AI_STUB;
  closeDb();
  _resetSessionTrackerForTesting();
});

describe('trigger 1: name at send', () => {
  it('a pending entry is named from passage + question, before any answer (C54)', async () => {
    await patchSession(SID, {
      thread_anchors: [anchor('head-a')],
      thread_meta: [{ headId: 'head-a', status: 'open', titleState: 'pending', question: 'why is it warm?' }],
    });
    await settle();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ kind: 'title', requirement: THREAD_TITLE_REQUIREMENT });
    expect(calls[0].message).toBe(`Passage: ${PASSAGE}\nQuestion: why is it warm?`);
    expect(await metaOf(SID, 'head-a')).toMatchObject({ title: 'Cache warmup', titleSource: 'ai', titleState: 'done' });
  });

  it('gate closed: stored as unavailable and the model is never called (C23)', async () => {
    const rec = await patchSession(OFF_SID, { thread_meta: [{ headId: 'head-off', status: 'open', titleState: 'pending', question: 'q' }] });
    await settle();
    expect(rec.threadMeta?.[0].titleState).toBe('unavailable');
    expect(calls).toHaveLength(0);
  });

  it('a null answer stores failed and never retries', async () => {
    answer = async () => null;
    await patchSession(SID, { thread_anchors: [anchor('head-f')], thread_meta: [{ headId: 'head-f', status: 'open', titleState: 'pending' }] });
    await settle();
    emitResult({});
    await settle();
    expect(calls).toHaveLength(1);
    expect((await metaOf(SID, 'head-f'))?.titleState).toBe('failed');
  });

  it('a rename that lands while the model runs wins over the AI title (C16)', async () => {
    let release!: (v: string) => void;
    answer = () => new Promise((r) => { release = r; });
    await patchSession(SID, { thread_anchors: [anchor('head-r')], thread_meta: [{ headId: 'head-r', status: 'open', titleState: 'pending' }] });
    await tick(60);
    expect(calls).toHaveLength(1);
    await patchSession(SID, { thread_meta: [{ headId: 'head-r', title: 'My own name', titleSource: 'user', titleState: 'done' }] });
    release('AI name');
    await settle();
    expect(await metaOf(SID, 'head-r')).toMatchObject({ title: 'My own name', titleSource: 'user' });
  });

  it('runs at most 2 calls at once across questions (C42)', async () => {
    let live = 0; let peak = 0;
    answer = async () => { live += 1; peak = Math.max(peak, live); await tick(40); live -= 1; return 'Some name'; };
    const ids = ['c1', 'c2', 'c3', 'c4', 'c5'];
    await patchSession(SID, {
      thread_anchors: ids.map(anchor),
      thread_meta: ids.map((headId) => ({ headId, status: 'open' as const, titleState: 'pending' as const })),
    });
    await settle();
    await tick(300);
    await settle();
    expect(calls).toHaveLength(5);
    expect(peak).toBe(2);
  });
});

describe('trigger 2: refine once at the first answer', () => {
  it('3 results within 10ms make 1 call, with the answer excerpt (C42)', async () => {
    await seedNamed('head-b');
    noteTurnUserUuid(SID, 'head-b');
    emitResult({}); emitResult({}); emitResult({});
    await settle();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ kind: 'refine', requirement: THREAD_REFINE_REQUIREMENT });
    expect(calls[0].message).toContain('Answer excerpt: The cache warms on boot because the loader primes it.');
    const e = await metaOf(SID, 'head-b');
    expect(e).toMatchObject({ title: 'Cache warmup on boot', status: 'suggested' });
    expect(e?.refinedAt).toBeTruthy();
    // A later answer for the same question never refines again.
    emitResult({});
    await settle();
    expect(calls).toHaveLength(1);
  });

  it('isError and interrupted results never refine (C42)', async () => {
    await seedNamed('head-e');
    noteTurnUserUuid(SID, 'head-e');
    emitResult({ isError: true });
    emitResult({ interrupted: true });
    await settle();
    expect(calls).toHaveLength(0);
  });

  it('no refine when the result is not provably this question (no uuid, other uuid)', async () => {
    await seedNamed('head-p');
    emitResult({});
    noteTurnUserUuid(SID, 'someone-else');
    emitResult({});
    await settle();
    expect(calls).toHaveLength(0);
  });

  it('answered yes is only ever suggested; Not yet (suggestDismissed) blocks it (C47)', async () => {
    await seedNamed('head-d', { suggestDismissed: true });
    noteTurnUserUuid(SID, 'head-d');
    emitResult({});
    await settle();
    expect(calls).toHaveLength(1);
    expect((await metaOf(SID, 'head-d'))?.status).toBe('open');
  });

  it('name at send + refine = 2 calls per question, never more (C53)', async () => {
    await patchSession(SID, {
      thread_anchors: [anchor('head-n')],
      thread_meta: [{ headId: 'head-n', status: 'open', titleState: 'pending', question: 'is it stub-answered' }],
    });
    await settle();
    noteTurnUserUuid(SID, 'head-n');
    emitResult({}); emitResult({});
    await settle();
    emitResult({});
    await settle();
    expect(calls.map((c) => c.kind)).toEqual(['title', 'refine']);
    expect(threadAiCallCounts(SID)).toEqual({ 'head-n': 2 });
    expect((await metaOf(SID, 'head-n'))?.status).toBe('suggested');
  });

  it('a refine requested while the name call runs waits for it instead of being lost', async () => {
    let release!: (v: string) => void;
    answer = (req) => (req.kind === 'title' ? new Promise((r) => { release = r; }) : Promise.resolve('Better name | Answered: no'));
    await patchSession(SID, { thread_anchors: [anchor('head-w')], thread_meta: [{ headId: 'head-w', status: 'open', titleState: 'pending' }] });
    await tick(60);
    noteTurnUserUuid(SID, 'head-w');
    emitResult({});
    await tick(60);
    release('First name');
    await settle();
    expect(calls.map((c) => c.kind)).toEqual(['title', 'refine']);
    expect(await metaOf(SID, 'head-w')).toMatchObject({ title: 'Better name', status: 'open' });
  });
});

describe('30s sweep on every result (C54)', () => {
  it('requeues the 2 newest stale pending entries, skips fresh and user-titled ones', async () => {
    const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString();
    await updateSessionRecord(SID, {
      threadAnchors: ['s1', 's2', 's3', 's4', 's5'].map(anchor) as never,
      threadMeta: [
        { headId: 's1', status: 'open', titleState: 'pending', updatedAt: ago(90) },
        { headId: 's2', status: 'open', titleState: 'pending', updatedAt: ago(60) },
        { headId: 's3', status: 'open', titleState: 'pending', updatedAt: ago(40) },
        { headId: 's4', status: 'open', titleState: 'pending', updatedAt: ago(5) },
        { headId: 's5', status: 'open', titleState: 'pending', titleSource: 'user', title: 'Mine', updatedAt: ago(120) },
      ],
    });
    emitResult({});
    await settle();
    expect(calls.map((c) => c.headId).sort()).toEqual(['s2', 's3']);
  });
});

describe('parseRefineAnswer', () => {
  it.each([
    ['Title: Cache warmup | Answered: yes', 'Cache warmup', true],
    ['Title: Cache warmup\nAnswered: no', 'Cache warmup', false],
    ['Cache warmup Answered: YES', 'Cache warmup', true],
    ['Just a title', 'Just a title', false],
    ['', null, false],
  ])('%j', (raw, title, answered) => {
    expect(parseRefineAnswer(raw)).toEqual({ title, answered });
  });
});

describe('stub hook for the sweep (C54 browser half)', () => {
  it('stub-drop-name loses the name-at-send call; the sweep names it after 30s', async () => {
    await patchSession(SID, {
      thread_anchors: [anchor('head-drop')],
      thread_meta: [{ headId: 'head-drop', status: 'open', titleState: 'pending', question: 'stub-drop-name why' }],
    });
    await settle();
    expect(calls).toHaveLength(0);
    const rec = await getSessionByClaudeId(SID);
    await updateSessionRecord(SID, { threadMeta: rec!.threadMeta!.map((e) => ({ ...e, updatedAt: new Date(Date.now() - 31_000).toISOString() })) });
    emitResult({});
    await settle();
    expect(calls.map((c) => c.kind)).toEqual(['title']);
    expect((await metaOf(SID, 'head-drop'))?.titleState).toBe('done');
  });
});
