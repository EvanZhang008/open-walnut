/**
 * Cache-aware delivery (src/core/sessions/cold-hold.ts, wake-policy.ts waitsWhenCold; 2026-11-16, the
 * user: buffer what can wait for a session whose cache is cold). Pinned here:
 *  - one classifier: every trigger sender a producer in src/ writes is listed (waits or goes now), and
 *    every notice that waits is one that wakes; a new sender fails until it is classified;
 *  - a message that someone waits on is never held, cold session or not;
 *  - held messages go in ONE line, in front of the message that releases them, or by their max hold;
 *  - a warm session gets everything at once; one that warms up gets its held rows;
 *  - nothing is lost across a restart; a Stop sets held rows aside like any other.
 *
 * Real queue file and real bus; only the runner's "is a turn running" answer is scripted.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/constants.js')>();
  return { ...actual, ...createMockConstants('walnut-cold-hold') };
});

import { WALNUT_HOME } from '../../../src/constants.js';
import { sessionRunner } from '../../../src/providers/claude-code-session.js';
import { bus, EventNames } from '../../../src/core/event-bus.js';
import { buildWalnutMessage } from '../../../src/core/peers/walnut-message-tag.js';
import { createEnvelopeKit } from '../../../src/core/peers/envelope-kit.js';
import {
  getQueue, loadQueue, markProcessing, resetCache, sendMessageToSession,
} from '../../../src/core/session-message-queue.js';
import { createSessionRecord, updateSessionRecord, _resetSessionTrackerForTesting } from '../../../src/core/session-tracker.js';
import { getSessionQueuePayload } from '../../../src/core/sessions/session-extras.js';
import { migrateSessionQueue, setAsideHeld } from '../../../src/core/session-queue-park.js';
import { STOP_PARKED_REASON } from '../../../src/core/relay-fates.js';
import { sendQueuedNow } from '../../../src/core/sessions/send-now.js';
import {
  COLD_HOLD_MAX_MS, COLD_HOLD_REASON, isColdHold, startColdHold, stopColdHold, sweepColdHolds,
} from '../../../src/core/sessions/cold-hold.js';
import { NOTICE_WAITS_COLD, NOTICE_WAKES, TRIGGER_FROM_WAITS, waitsWhenCold } from '../../../src/core/sessions/wake-policy.js';
import { _clearHeldNotices } from '../../../src/core/sessions/held-notices.js';

const ROOT = path.resolve(__dirname, '../../..');
const SID = 'cccccccc-1111-4222-8333-555555555555';
const kit = createEnvelopeKit();

const triggerFire = (name = 'CI watch', body = 'build 42 failed') =>
  buildWalnutMessage({ kind: 'trigger', attrs: { from: `Trigger: ${name}`, note: 'the check fired' }, body });
const fyi = (body = 'FYI: the deploy is done') => kit.buildPeerWrapper(body,
  { title: 'Walnut VP', shortId: '3ccf06d9', host: 'local', sessionId: '3ccf06d9-dbdd-49a1-ab98-1537944f64d4', taskId: 'mvm0n3bu-6910' });
const ask = () => kit.buildPeerWrapper('please check the build',
  { title: 'Walnut VP', shortId: '3ccf06d9', host: 'local', sessionId: '3ccf06d9-dbdd-49a1-ab98-1537944f64d4', taskId: 'mvm0n3bu-6910', requestId: 'rq-1' });
const scriptNote = () => kit.buildPeerWrapper('Deep test fails on your land: fix it within an hour',
  { title: '', shortId: '', host: 'local', anonymous: true, automation: 'script' });
const reply = () => buildWalnutMessage({ kind: 'reply', attrs: { from: 'Walnut VP [3ccf06d9]', request: 'rq-2', asked: 'is it done' }, body: 'yes' });
const notice = (outcome: string) => buildWalnutMessage({ kind: 'notification', attrs: { from: 'Walnut', outcome }, body: `a ${outcome} notice` });

let sends: Array<{ sessionId: string; source: string; endsWait?: boolean }> = [];
const running = new Set<string>();

async function setCache(expiresInMs: number): Promise<void> {
  const now = Date.now();
  await updateSessionRecord(SID, {
    promptCache: {
      tokens: 400_000, ttlMs: 3_600_000, requestAt: new Date(now + expiresInMs - 3_600_000).toISOString(),
      expiresAt: new Date(now + expiresInMs).toISOString(),
    },
  });
}

beforeEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
  resetCache();
  _clearHeldNotices();
  _resetSessionTrackerForTesting();
  running.clear();
  sends = [];
  vi.spyOn(sessionRunner, 'isTurnRunning').mockImplementation((sid: string) => running.has(sid));
  await createSessionRecord(SID, 't-cold', 'Acme', '/tmp', { initialProcessStatus: 'idle' });
  await setCache(-2 * 3_600_000); // went cold two hours ago
  bus.subscribe('cold-hold-test', (e) => {
    if (e.name !== EventNames.SESSION_SEND) return;
    const d = e.data as { sessionId: string; endsWait?: boolean };
    sends.push({ sessionId: d.sessionId, source: e.source, ...(d.endsWait ? { endsWait: true } : {}) });
  }, { global: true, interest: [EventNames.SESSION_SEND] });
});

afterEach(async () => {
  stopColdHold();
  bus.unsubscribe('cold-hold-test');
  vi.restoreAllMocks();
  resetCache();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {});
});

function srcFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...srcFiles(p));
    else if (/\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/** Trigger senders written as a constant: its value (each is read from its source below). */
const FROM_CONSTANTS: Record<string, string> = {
  WAIT_WAKE_FROM: /WAIT_WAKE_FROM = '([^']+)'/.exec(fs.readFileSync(path.join(ROOT, 'src/core/task-wait-until.ts'), 'utf8'))![1],
  TRIAGE_AGENT_NAME: /TRIAGE_AGENT_NAME = '([^']+)'/.exec(fs.readFileSync(path.join(ROOT, 'src/core/triage/types.ts'), 'utf8'))![1],
};

describe('one classifier for what can wait', () => {
  it('every trigger sender written in src/ is classified; a notice that waits is one that wakes', () => {
    const unlisted: string[] = [];
    for (const p of srcFiles(path.join(ROOT, 'src'))) {
      const s = fs.readFileSync(p, 'utf8');
      for (const m of s.matchAll(/kind: 'trigger',/g)) {
        const head = s.slice(m.index, m.index! + 400);
        const from = /\bfrom: ('([^']*)'|`([^`]*)`|([A-Z_]+))/.exec(head);
        if (!from) continue; // a journal actor, not an envelope
        const value = from[2] ?? from[3] ?? from[4];
        if (value.startsWith('Trigger: ')) continue;
        const resolved = FROM_CONSTANTS[value] ?? value;
        if (!(resolved in TRIGGER_FROM_WAITS)) unlisted.push(`${path.relative(ROOT, p)}: from ${value}`);
      }
    }
    expect(unlisted).toEqual([]);
    for (const o of NOTICE_WAITS_COLD) expect(o in NOTICE_WAKES, o).toBe(true);
  });

  it('a fire, a task\'s FYI, a re-check and a trigger in trouble wait; an ask, a reply, an alert and words do not', () => {
    expect(waitsWhenCold(triggerFire())).toBe(true);
    expect(waitsWhenCold(fyi())).toBe(true);
    expect(waitsWhenCold(`${triggerFire()}\n\n${fyi()}`)).toBe(true);
    expect(waitsWhenCold(buildWalnutMessage({ kind: 'trigger', attrs: { from: 'Walnut: wait until' }, body: 'the time passed' }))).toBe(true);
    expect(waitsWhenCold(notice('check_failed'))).toBe(true);
    expect(waitsWhenCold(ask())).toBe(false);
    expect(waitsWhenCold(reply())).toBe(false);
    expect(waitsWhenCold(scriptNote())).toBe(false);
    expect(waitsWhenCold(notice('completed'))).toBe(false);
    expect(waitsWhenCold(buildWalnutMessage({ kind: 'notification', attrs: { from: 'Walnut' }, body: 'your command ended' }))).toBe(false);
    expect(waitsWhenCold(buildWalnutMessage({ kind: 'trigger', attrs: { from: 'Walnut: unanswered' }, body: 'the user waits' }))).toBe(false);
    expect(waitsWhenCold(buildWalnutMessage({ kind: 'trigger', attrs: { from: 'Walnut: Brief refresh' }, body: 'look' }))).toBe(false);
    expect(waitsWhenCold('please look at the build')).toBe(false);
    expect(waitsWhenCold(`${triggerFire()}\n\nand words`)).toBe(false);
    expect(waitsWhenCold(`${triggerFire()}\n\n${ask()}`)).toBe(false);
  });
});

describe('a cold session', () => {
  it('holds what can wait, shows it held, and sends it all in ONE line in front of the message that cannot', async () => {
    const a = await sendMessageToSession(SID, triggerFire(), { source: 'routine-watcher' });
    const b = await sendMessageToSession(SID, fyi(), { source: 'peer' });
    expect([a, b].every(isColdHold)).toBe(true);
    expect(sends).toEqual([]);
    const shown = (await getSessionQueuePayload(SID)).messages as Array<{ status: string; heldReason?: string; heldRetryAt?: string }>;
    expect(shown.map((m) => m.status)).toEqual(['pending', 'pending']);
    expect(shown[0].heldReason).toMatch(/^Held: the session is idle and its prompt cache has expired/);
    expect(Date.parse(shown[1].heldRetryAt!)).toBe(Date.parse(a.parkedAt!) + COLD_HOLD_MAX_MS);

    await sendMessageToSession(SID, 'what broke?', { source: 'ui' });
    // One kick, and it ends the wait: a trigger's fire rode in it.
    expect(sends).toEqual([{ sessionId: SID, source: 'ui', endsWait: true }]);
    const batch = await markProcessing(SID);
    expect(batch.map((m) => m.message.includes('build 42 failed') ? 'fire' : m.message.includes('FYI') ? 'fyi' : 'words')).toEqual(['fire', 'fyi', 'words']);
    expect(new Set(batch.map((m) => m.lineUuid)).size).toBe(1);
  });

  it('never holds a message someone waits on', async () => {
    const urgent: Array<[string, string, Parameters<typeof sendMessageToSession>[2]]> = [
      ['an ask', ask(), { source: 'peer' }],
      ['a reply', reply(), { source: 'peer', endsWait: true }],
      ['a script\'s alert', scriptNote(), { source: 'peer' }],
      ['a completed subtask', notice('completed'), { source: 'walnut-notify' }],
      ['a wake reason', fyi(), { source: 'peer', wakeReason: 'a task of its team waits on the lead' }],
      ['the user\'s words', 'hello', { source: 'ui' }],
      ['a browser under automation\'s words', fyi(), { source: 'browser-automation' }],
      ['an unanswered re-check', buildWalnutMessage({ kind: 'trigger', attrs: { from: 'Walnut: unanswered' }, body: 'the user waits' }), { source: 'needs-recheck' }],
    ];
    for (const [what, text, opts] of urgent) {
      sends = [];
      const row = await sendMessageToSession(SID, text, opts);
      expect(row.status, what).toBe('pending');
      expect(sends.length, what).toBe(1);
    }
  });

  it('sends what it held by the max hold, under the fire\'s own source', async () => {
    const a = await sendMessageToSession(SID, triggerFire(), { source: 'routine-watcher' });
    startColdHold();
    await sweepColdHolds(Date.parse(a.parkedAt!) + COLD_HOLD_MAX_MS - 1000);
    expect(sends).toEqual([]);
    await sweepColdHolds(Date.parse(a.parkedAt!) + COLD_HOLD_MAX_MS);
    expect(sends).toEqual([{ sessionId: SID, source: 'routine-watcher', endsWait: true }]);
    expect((await getQueue(SID)).map((m) => m.status)).toEqual(['pending']);
  });

  it('sends what it held once the session runs or warms up, and a warm session gets everything at once', async () => {
    await sendMessageToSession(SID, fyi(), { source: 'peer' });
    startColdHold();
    running.add(SID);
    await sweepColdHolds();
    expect(sends.map((s) => s.source)).toEqual(['peer']);
    expect(sends[0].endsWait).toBeUndefined();
    running.delete(SID);

    sends = [];
    await setCache(30 * 60_000);
    const row = await sendMessageToSession(SID, triggerFire(), { source: 'routine-watcher' });
    expect(row.status).toBe('pending');
    expect(sends).toHaveLength(1);
  });

  it('loses nothing across a restart: the row stays held on disk and goes by its max hold', async () => {
    const a = await sendMessageToSession(SID, triggerFire(), { source: 'routine-watcher' });
    stopColdHold();
    resetCache();
    await loadQueue();
    const after = await getQueue(SID);
    expect(after).toHaveLength(1);
    expect(isColdHold(after[0])).toBe(true);
    expect(after[0].coldSend).toEqual({ source: 'routine-watcher' });
    await startColdHold();
    await sweepColdHolds(Date.parse(a.parkedAt!) + COLD_HOLD_MAX_MS + 1);
    expect(sends).toEqual([{ sessionId: SID, source: 'routine-watcher', endsWait: true }]);
    expect((await getQueue(SID))[0].coldSend).toBeUndefined();
  });

  it('Send now on one held row sends every held row', async () => {
    await sendMessageToSession(SID, fyi('one'), { source: 'peer' });
    await sendMessageToSession(SID, fyi('two'), { source: 'peer' });
    const [first] = await getQueue(SID);
    expect(await sendQueuedNow({ messageId: first.id, sessionId: SID, source: 'api-agent' })).toEqual({ sent: true, sessionId: SID });
    expect((await getQueue(SID)).map((m) => m.status)).toEqual(['pending', 'pending']);
    expect(sends).toHaveLength(1);
  });

  it('a queue moved to a new session id (an engine switch, a move) is still sent by its max hold', async () => {
    const a = await sendMessageToSession(SID, triggerFire(), { source: 'routine-watcher' });
    const NEW = 'dddddddd-1111-4222-8333-555555555555';
    expect((await migrateSessionQueue(SID, NEW)).movedIds).toEqual([a.id]);
    await sweepColdHolds(Date.parse(a.parkedAt!) + COLD_HOLD_MAX_MS);
    expect(sends).toEqual([{ sessionId: NEW, source: 'routine-watcher', endsWait: true }]);
  });

  it('a slash command does not take the held rows in front of it', async () => {
    await sendMessageToSession(SID, fyi(), { source: 'peer' });
    await sendMessageToSession(SID, '/compact', { source: 'ui' });
    expect((await getQueue(SID)).map((m) => isColdHold(m))).toEqual([true, false]);
  });

  it('a Stop sets held rows aside like every row it stops', async () => {
    await sendMessageToSession(SID, fyi('three'), { source: 'peer' });
    expect(await setAsideHeld(SID)).toBe(1);
    expect((await getQueue(SID))[0]).toMatchObject({ status: 'parked', parkedReason: STOP_PARKED_REASON });
    expect(COLD_HOLD_REASON).not.toBe(STOP_PARKED_REASON);
  });
});
