/**
 * The Done takeaway (src/core/sessions/thread-takeaway.ts), C57 server half:
 * the fallback skips preamble ("Good question."), the AI sentence replaces the
 * fallback, a user edit is final, and Done during a streaming answer waits for
 * that turn's result. Plus the preamble-table parity with the client.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-thread-takeaway'));

import { closeDb } from '../../src/core/session-db.js';
import {
  _resetSessionTrackerForTesting, createSessionRecord, getSessionByClaudeId, updateSessionRecord,
} from '../../src/core/session-tracker.js';
import { bus, EventNames } from '../../src/core/event-bus.js';
import { patchSession } from '../../src/core/sessions/session-lifecycle.js';
import { __resetThreadMetaForTesting } from '../../src/core/sessions/thread-meta.js';
import { __setThreadAiModelForTesting, type ThreadAiRequest } from '../../src/core/sessions/thread-ai-stub.js';
import {
  __resetThreadTakeawaysForTesting, __threadTakeawaysIdleForTesting, fallbackTakeaway, startThreadTakeaways,
  TAKEAWAY_PREAMBLE_PATTERNS, THREAD_TAKEAWAY_REQUIREMENT,
} from '../../src/core/sessions/thread-takeaway.js';
import {
  fallbackTakeaway as clientFallbackTakeaway, TAKEAWAY_PREAMBLE_PATTERNS as CLIENT_PATTERNS,
} from '../../web/src/utils/thread-meta.js';
import { noteTurnUserUuid } from '../../src/providers/batch-uuid.js';
import { WALNUT_HOME } from '../../src/constants.js';
import type { SessionThreadMeta } from '../../src/core/types.js';

const SID = 'unit-ai-takeaway-0001';
const OFF_SID = 'plain-takeaway-0002';
const ANSWER = 'Good question.\n\nThe cache warms on boot because the loader primes every shard first.';
const FALLBACK = 'The cache warms on boot because the loader primes every shard first.';

let calls: ThreadAiRequest[] = [];
let answer: (req: ThreadAiRequest) => Promise<string | null>;
let handle: { stop: () => void };

const anchor = (msgId: string) => ({ msgId, parent: 'reply-1', quote: { exact: 'the cache' }, source: 'selection' as const, at: '2026-09-26T10:00:00.000Z' });
const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) { await tick(); await __threadTakeawaysIdleForTesting(); }
}
async function metaOf(sid: string, headId: string): Promise<SessionThreadMeta | undefined> {
  return (await getSessionByClaudeId(sid))?.threadMeta?.find((e) => e.headId === headId);
}
async function seed(sid: string, headId: string): Promise<void> {
  await updateSessionRecord(sid, {
    threadAnchors: [anchor(headId)],
    threadMeta: [{ headId, status: 'open', question: 'why is it warm?', updatedAt: new Date().toISOString() }],
  });
}
function emitResult(sid: string, result = ANSWER): void {
  bus.emit(EventNames.SESSION_RESULT, { sessionId: sid, result, isError: false }, ['*']);
}
const done = (headId: string, over: Record<string, unknown> = {}) => ({
  thread_meta: [{ headId, status: 'resolved', takeawayState: 'pending', ...over }],
});

beforeEach(async () => {
  process.env.WALNUT_THREAD_AI_STUB = 'unit-ai-';
  closeDb();
  _resetSessionTrackerForTesting();
  __resetThreadMetaForTesting();
  __resetThreadTakeawaysForTesting();
  bus.clear();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
  await createSessionRecord(SID, 'task-takeaway', 'proj', '/tmp');
  await createSessionRecord(OFF_SID, 'task-takeaway-2', 'proj', '/tmp');
  calls = [];
  answer = async () => 'The loader primes every shard at boot.';
  __setThreadAiModelForTesting(async (req) => { calls.push(req); return answer(req); });
  handle = startThreadTakeaways();
});

afterEach(async () => {
  handle.stop();
  await settle();
  __setThreadAiModelForTesting(null);
  noteTurnUserUuid(SID, undefined);
  noteTurnUserUuid(OFF_SID, undefined);
  delete process.env.WALNUT_THREAD_AI_STUB;
  closeDb();
  _resetSessionTrackerForTesting();
});

describe('fallbackTakeaway', () => {
  it('skips a "Good question." preamble and short sentences', () => {
    expect(fallbackTakeaway(ANSWER)).toBe(FALLBACK);
    expect(fallbackTakeaway('Sure, here it is. Let me explain how the loader primes every shard.')).toBe('Sure, here it is.');
    expect(fallbackTakeaway('Intro.\n\nOK, so. The loader primes every shard before the first request.')).toBe('The loader primes every shard before the first request.');
  });

  it('matches the client table and the client function (parity)', () => {
    expect(TAKEAWAY_PREAMBLE_PATTERNS.map(String)).toEqual(CLIENT_PATTERNS.map(String));
    const samples = [
      ANSWER,
      '# Heading\n\nGreat question! **Short answer**: yes. It works because the pool is warmed before traffic.',
      '```\ncode block\n```\n\n| a | b |\n|---|---|\n\nI\'ll check. The loader primes every shard of the cache first.',
      'One. Two. Three.',
      `${'word '.repeat(60)}end.`,
      // CJK sample ("the cache warms at startup because the loader fills it first"), as escapes.
      '\u7f13\u5b58\u5728\u542f\u52a8\u65f6\u9884\u70ed\u56e0\u4e3a\u52a0\u8f7d\u5668\u4f1a\u5148\u586b\u5145\u3002',
      '',
    ];
    for (const s of samples) expect(fallbackTakeaway(s)).toBe(clientFallbackTakeaway(s));
  });
});

describe('Done takeaway (C57)', () => {
  it('the AI sentence replaces the fallback, source ai, state done', async () => {
    await seed(SID, 'head-t');
    noteTurnUserUuid(SID, 'head-t');
    emitResult(SID);
    await settle();
    await patchSession(SID, done('head-t', { takeaway: FALLBACK, takeawaySource: 'fallback' }));
    await settle();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ kind: 'takeaway', requirement: THREAD_TAKEAWAY_REQUIREMENT });
    expect(calls[0].message).toBe(`Question: why is it warm?\nAnswer: ${ANSWER}`);
    expect(await metaOf(SID, 'head-t')).toMatchObject({
      status: 'resolved', takeaway: 'The loader primes every shard at boot.', takeawaySource: 'ai', takeawayState: 'done',
    });
  });

  it('a user edit made while the model runs is final', async () => {
    let release!: (v: string) => void;
    answer = () => new Promise((r) => { release = r; });
    await seed(SID, 'head-u');
    noteTurnUserUuid(SID, 'head-u');
    emitResult(SID);
    await settle();
    await patchSession(SID, done('head-u', { takeaway: FALLBACK, takeawaySource: 'fallback' }));
    await tick(80);
    await patchSession(SID, { thread_meta: [{ headId: 'head-u', takeaway: 'My words', takeawaySource: 'user', takeawayState: null }] });
    release('AI words');
    await settle();
    expect(await metaOf(SID, 'head-u')).toMatchObject({ takeaway: 'My words', takeawaySource: 'user' });
  });

  it('Done while the answer streams waits for its result, then fills fallback and AI', async () => {
    await seed(SID, 'head-s');
    noteTurnUserUuid(SID, 'head-s'); // delivered, no result yet
    await patchSession(SID, done('head-s'));
    await settle();
    expect(calls).toHaveLength(0);
    expect((await metaOf(SID, 'head-s'))?.takeaway).toBeUndefined();
    let captured: SessionThreadMeta | undefined;
    answer = async () => { captured = await metaOf(SID, 'head-s'); return 'The loader primes every shard at boot.'; };
    emitResult(SID);
    await settle();
    expect(captured).toMatchObject({ takeaway: FALLBACK, takeawaySource: 'fallback', takeawayState: 'pending' });
    expect(await metaOf(SID, 'head-s')).toMatchObject({ takeawaySource: 'ai', takeawayState: 'done' });
  });

  it('gate closed: the streaming Done gets the server fallback and no model call', async () => {
    await seed(OFF_SID, 'head-g');
    noteTurnUserUuid(OFF_SID, 'head-g');
    await patchSession(OFF_SID, done('head-g'));
    emitResult(OFF_SID);
    await settle();
    expect(calls).toHaveLength(0);
    const e = await metaOf(OFF_SID, 'head-g');
    expect(e).toMatchObject({ takeaway: FALLBACK, takeawaySource: 'fallback' });
    expect(e?.takeawayState).toBeUndefined();
  });

  it('no answer text in memory (a restart): failed, the client fallback stays', async () => {
    await seed(SID, 'head-x');
    await patchSession(SID, done('head-x', { takeaway: FALLBACK, takeawaySource: 'fallback' }));
    await settle();
    expect(calls).toHaveLength(0);
    expect(await metaOf(SID, 'head-x')).toMatchObject({ takeaway: FALLBACK, takeawayState: 'failed' });
  });
});
