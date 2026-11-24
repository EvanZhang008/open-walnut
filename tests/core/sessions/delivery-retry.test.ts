/**
 * A message a delivery failure parked goes back in line by itself, for as long as it fails
 * (src/core/sessions/delivery-retry.ts; 2026-11-23, the user: "我们任何时候不应该造成这个 message
 * loss，而且有有 error 的话一直会 retry"). Pinned here:
 *  - a park a retry can fix is tried again on a clock that grows (1, 2, 5, 10, 30 min, then every
 *    hour) with no limit on tries, and the runner is asked to send it;
 *  - never a park a person or a hold decided (a Stop, a cold hold, a move, a running turn, start
 *    recovery), nor a row a Stop came after, nor one Claude Code read and left unanswered, nor one
 *    only a person can fix (a deleted folder, too large), nor an archived session's;
 *  - pending rows nothing sends are asked for again;
 *  - every park reason in src/ is classified: a new one is tried again unless it is listed.
 *
 * Real queue file and real bus; the runner's "is a turn running" answer is scripted.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/constants.js')>();
  return { ...actual, ...createMockConstants('walnut-delivery-retry') };
});

import { WALNUT_HOME } from '../../../src/constants.js';
import { sessionRunner } from '../../../src/providers/claude-code-session.js';
import { bus, EventNames } from '../../../src/core/event-bus.js';
import { enqueueMessage, getQueue, resetCache } from '../../../src/core/session-message-queue.js';
import { parkMessages } from '../../../src/core/session-queue-park.js';
import { mutateStore } from '../../../src/core/session-queue-store.js';
import { createSessionRecord, updateSessionRecord, _resetSessionTrackerForTesting } from '../../../src/core/session-tracker.js';
import {
  AFTER_TURN_REASON, CANCELLED_UNRUN_REASON, COLD_HOLD_REASON, MOVE_HELD_REASON, START_RECOVERY_HELD_REASON, STOP_PARKED_REASON,
} from '../../../src/core/relay-fates.js';
import { LINE_ENDED_UNANSWERED_REASON, LINE_NOT_ANSWERED_REASON } from '../../../src/providers/claude-code-session.js';
import {
  NEEDS_A_PERSON_CODES, NOT_LOST_REASON_PREFIXES, RETRY_BACKOFF_MS, RETRY_EVERY_MS, STUCK_PENDING_MS,
  nextRetryAt, retryDelayMs, startDeliveryRetry, stopDeliveryRetry, sweepDeliveryRetries,
} from '../../../src/core/sessions/delivery-retry.js';
import { _resetJudgeOfForTesting, noteHostJudged } from '../../../src/core/sessions/judge-of.js';

const ROOT = path.resolve(__dirname, '../../..');
const SID = 'dddddddd-1111-4222-8333-555555555555';
let sends: string[] = [];
const running = new Set<string>();

beforeEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
  resetCache();
  _resetSessionTrackerForTesting();
  stopDeliveryRetry();
  running.clear();
  sends = [];
  vi.spyOn(sessionRunner, 'isTurnRunning').mockImplementation((sid: string) => running.has(sid));
  await createSessionRecord(SID, 't-retry', 'Acme', '/tmp', { initialProcessStatus: 'idle' });
  bus.subscribe('delivery-retry-test', (e) => {
    if (e.name === EventNames.SESSION_SEND && e.source === 'delivery-retry') sends.push((e.data as { sessionId: string }).sessionId);
  }, { global: true, interest: [EventNames.SESSION_SEND] });
});

afterEach(async () => {
  stopDeliveryRetry();
  bus.unsubscribe('delivery-retry-test');
  vi.restoreAllMocks();
  resetCache();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {});
});

async function parked(text: string, cause: Parameters<typeof parkMessages>[1]) {
  const row = await enqueueMessage(SID, text);
  await parkMessages([row], cause);
  return (await getQueue(SID)).find((m) => m.id === row.id)!;
}

describe('a park a retry can fix goes back in line by itself, for good', () => {
  it('on a clock that grows to once an hour, with no limit on tries', async () => {
    expect(RETRY_BACKOFF_MS.map((ms) => ms / 60_000)).toEqual([1, 2, 5, 10, 30]);
    expect(retryDelayMs(99)).toBe(RETRY_EVERY_MS);
    const row = await parked('the user\'s words', 'Not delivered: Claude Code exited before it read this message. Retry it.');
    const parkedAt = Date.parse(row.parkedAt!);
    expect(await sweepDeliveryRetries(parkedAt + RETRY_BACKOFF_MS[0] - 1000)).toEqual([]);
    expect(await sweepDeliveryRetries(parkedAt + RETRY_BACKOFF_MS[0])).toEqual([row.id]);
    expect(sends).toEqual([SID]);
    let now = (await getQueue(SID))[0];
    expect(now).toMatchObject({ status: 'pending', autoRetries: 1, message: 'the user\'s words' });
    expect(now.parkedReason).toBeUndefined();
    // It fails again, ten more times: each try waits longer, and none is the last.
    for (let i = 1; i <= 10; i++) {
      await parkMessages([now], 'Not delivered: Claude Code exited before it read this message. Retry it.');
      now = (await getQueue(SID))[0];
      const due = nextRetryAt(now);
      expect(due - Date.parse(now.parkedAt!)).toBe(retryDelayMs(i));
      expect(await sweepDeliveryRetries(due - 1)).toEqual([]);
      expect(await sweepDeliveryRetries(due)).toEqual([now.id]);
      now = (await getQueue(SID))[0];
      expect(now.autoRetries).toBe(i + 1);
    }
  });

  it('a session held elsewhere, a paused budget, unread history, a loop-park and a cancel or teardown that was no Stop are tried again', async () => {
    const causes: Array<Parameters<typeof parkMessages>[1]> = [
      { reason: 'held by another process', code: 'session_live' },
      { reason: 'Not sent: the session budget is paused. Raise or remove the limit, then retry.', code: 'budget_paused' },
      { reason: 'history could not be read', code: 'history_unavailable' },
      'Walnut stopped sending this message: it tried 8 times in 30 seconds and every try ended at once. Retry sends it again.',
      CANCELLED_UNRUN_REASON,
      'The session ended before Claude Code ran this message',
    ];
    const ids: string[] = [];
    for (const c of causes) ids.push((await parked(`m-${ids.length}`, c)).id);
    expect((await sweepDeliveryRetries(Date.now() + RETRY_BACKOFF_MS[0])).sort()).toEqual([...ids].sort());
  });
});

describe('never a park a person or a hold decided, nor one only a person can fix', () => {
  it('a Stop, a hold, a move, an unanswered line, a deleted folder: left for the person', async () => {
    const kept = [
      STOP_PARKED_REASON, COLD_HOLD_REASON, AFTER_TURN_REASON, START_RECOVERY_HELD_REASON, MOVE_HELD_REASON,
      LINE_NOT_ANSWERED_REASON, LINE_ENDED_UNANSWERED_REASON,
    ];
    for (const r of kept) await parked(r.slice(0, 20), r);
    for (const code of NEEDS_A_PERSON_CODES) await parked(code, { reason: `failed: ${code}`, code });
    // Parked before the code was kept: the reason's own words say the folder is gone.
    await parked('old row', 'Not sent: the working directory no longer exists (/gone)');
    expect(await sweepDeliveryRetries(Date.now() + 10 * RETRY_EVERY_MS)).toEqual([]);
    expect(sends).toEqual([]);
  });

  it('a row a Stop came after stays for the person; an archived session is left alone', async () => {
    await parked('before the stop', 'Not delivered: Claude Code exited before it read this message. Retry it.');
    await mutateStore((s) => { s.queues[SID][0].stopFence = 'an-older-stop'; });
    expect(await sweepDeliveryRetries(Date.now() + RETRY_EVERY_MS)).toEqual([]);
    await mutateStore((s) => { delete s.queues[SID][0].stopFence; });
    await updateSessionRecord(SID, { archived: true } as never);
    expect(await sweepDeliveryRetries(Date.now() + RETRY_EVERY_MS)).toEqual([]);
  });
});

describe('a host that runs its own sessions runs the same clock for their queues', () => {
  afterEach(() => { _resetJudgeOfForTesting(); });

  it('ownOnly: a queue of a session this server does not judge is left to its judge; its own are tried again', async () => {
    const OTHER = 'eeeeeeee-1111-4222-8333-555555555555';
    await createSessionRecord(OTHER, 't-retry-other', 'Acme', '/tmp', { initialProcessStatus: 'idle' });
    const mine = await parked('mine', 'Not delivered: Claude Code exited before it read this message. Retry it.');
    const theirs = await enqueueMessage(OTHER, 'theirs');
    await parkMessages([theirs], 'Not delivered: Claude Code exited before it read this message. Retry it.');
    // Another server judges OTHER (here: a host's session, as the leader sees it).
    noteHostJudged(OTHER, 'devbox');
    // The clock's own first lap runs at its start; the kept trigger fires are not this side's.
    startDeliveryRetry({ ownOnly: true, keptFires: false });
    // Joins that first lap (nothing is due yet).
    expect(await sweepDeliveryRetries()).toEqual([]);
    const due = nextRetryAt(mine);
    expect(await sweepDeliveryRetries(due + 60_000)).toEqual([mine.id]);
    expect(sends).toEqual([SID]);
    expect((await getQueue(OTHER))[0]).toMatchObject({ status: 'parked' });
  });
});

describe('pending rows nothing sends are asked for again', () => {
  it('after STUCK_PENDING_MS with no turn running, on the same growing clock', async () => {
    const row = await enqueueMessage(SID, 'stuck');
    const at = Date.parse(row.enqueuedAt);
    await sweepDeliveryRetries(at + STUCK_PENDING_MS - 1000);
    expect(sends).toEqual([]);
    running.add(SID);
    await sweepDeliveryRetries(at + STUCK_PENDING_MS);
    expect(sends).toEqual([]);
    running.delete(SID);
    await sweepDeliveryRetries(at + STUCK_PENDING_MS);
    expect(sends).toEqual([SID]);
    await sweepDeliveryRetries(at + STUCK_PENDING_MS + RETRY_BACKOFF_MS[0] - 1000);
    expect(sends).toEqual([SID]);
    await sweepDeliveryRetries(at + STUCK_PENDING_MS + RETRY_BACKOFF_MS[0]);
    expect(sends).toEqual([SID, SID]);
  });
});

describe('every park reason in src/ is classified', () => {
  /**
   * Park reasons passed as a constant to a park call in src/ that the clock leaves for a person or a hold. Any
   * other park is tried again by itself: a new reason that must wait for a person fails here until
   * it is listed (HELD in delivery-retry.ts, NOT_LOST_REASON_PREFIXES, or a NEEDS_A_PERSON code).
   */
  const LEFT_FOR_A_PERSON = new Set([
    'STOP_PARKED_REASON', 'COLD_HOLD_REASON', 'AFTER_TURN_REASON', 'START_RECOVERY_HELD_REASON', 'MOVE_HELD_REASON',
    'LINE_NOT_ANSWERED_REASON', 'LINE_ENDED_UNANSWERED_REASON',
  ]);
  /** Every other park reason constant, with why the clock may try it again. */
  const TRIED_AGAIN: Record<string, string> = {
    REDELIVERY_LOOP_REASON: 'a loop of instant failures: the growing clock tries it at most once an hour',
    LINE_NOT_ACKNOWLEDGED_REASON: 'Claude Code never acknowledged the line: it may not have read it',
    LINE_UNACKNOWLEDGED_KEPT_REASON: 'Claude Code read past the line and Walnut could not write it again',
    HOST_REFUSED_REASON: 'the host refused the run: it may let the next one through',
    HOST_START_LOST_REASON: 'the session did not start on its host (host-handover.ts): the next try may start it',
    CANCELLED_UNRUN_REASON: 'a cancel that was no Stop (an engine switch, a lane drain): a person\'s Stop moved the fence, which leaves its rows alone',
  };

  it('each park reason constant is left for a person or tried again, with why', () => {
    const found = new Set<string>();
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith('.ts')) {
          const s = fs.readFileSync(p, 'utf8');
          for (const m of s.matchAll(/\b(?:parkRow|parkMessages|parkIfQueued|parkLineRows)\([^;\n]*?\b([A-Z][A-Z_]+_REASON)\b/g)) found.add(m[1]);
        }
      }
    };
    walk(path.join(ROOT, 'src'));
    expect(found.has('STOP_PARKED_REASON') && found.has('REDELIVERY_LOOP_REASON')).toBe(true);
    const unclassified = [...found].filter((n) => !LEFT_FOR_A_PERSON.has(n) && !(n in TRIED_AGAIN));
    expect(unclassified).toEqual([]);
    for (const p of NOT_LOST_REASON_PREFIXES) expect(LINE_NOT_ANSWERED_REASON.startsWith(p) || LINE_ENDED_UNANSWERED_REASON.startsWith(p), p).toBe(true);
  });
});
