/**
 * Cache-aware delivery (src/core/sessions/cold-hold.ts, wake-policy.ts waitsWhenCold; 2026-11-16, the
 * user: buffer what can wait for a session whose cache is cold). Pinned here:
 *  - one classifier, by what sent a message: only an FYI waits (a task's note that asks nothing, a
 *    notice with no clock in it); every clock in src/ (a fire, a wait clock, a re-check, a follow-up,
 *    a reminder, a timeout) and every watch of what a task waits on goes now, and a new producer of
 *    a message that waits fails until it is listed with why it has no clock;
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
import { COLD_HOLD_SOURCES, NOTICE_WAITS_COLD, NOTICE_WAKES, waitsWhenCold } from '../../../src/core/sessions/wake-policy.js';
import { buildScheduledMessage, buildTriggerMessage } from '../../../src/providers/trigger-envelope-core.js';
import { WAIT_WAKE_FROM } from '../../../src/core/task-wait-until.js';
import { _clearHeldNotices } from '../../../src/core/sessions/held-notices.js';

const ROOT = path.resolve(__dirname, '../../..');
const SID = 'cccccccc-1111-4222-8333-555555555555';
const kit = createEnvelopeKit();

const triggerFire = (name = 'CI watch', body = 'build 42 failed') =>
  buildWalnutMessage({ kind: 'trigger', attrs: { from: `Trigger: ${name}`, note: 'the check fired' }, body });
/** A notice with no clock in it (routines/trigger-health.ts): the session's trigger check failed. It can wait. */
const trouble = (body = 'build 42 failed') =>
  buildWalnutMessage({ kind: 'notification', attrs: { from: 'Trigger: CI watch', outcome: 'check_failed', note: 'your trigger check failed' }, body });
const TROUBLE = { source: 'walnut-notify' } as const;
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

/** Read a `NAME = '<value>'` constant from a source file. */
const constOf = (file: string, name: string) =>
  new RegExp(`${name} = '([^']+)'`).exec(fs.readFileSync(path.join(ROOT, file), 'utf8'))![1];

/**
 * Every notice that waits (NOTICE_WAITS_COLD), with the files that write it and why it has no clock
 * in it: it reports a state, nobody waits on it, and no time it names has come. A new outcome there,
 * or a new file writing one of them, fails until it is listed here: a clock's message never waits.
 */
const NO_CLOCK_NOTICES: Record<string, { files: string[]; why: string }> = {
  check_failed: { files: ['src/core/routines/trigger-health.ts'], why: 'a trigger check fails: news about its script' },
  check_failing: { files: ['src/core/routines/trigger-health.ts'], why: 'a trigger check keeps failing: news about its script' },
  check_repaired: { files: ['src/core/routines/trigger-health.ts'], why: 'the daemon repaired a check\'s output: news about its script' },
  trigger_disabled: { files: ['src/core/routines/trigger-health.ts'], why: 'a trigger was switched off: news about its script' },
  routine_trouble: { files: ['src/core/routines/trigger-health.ts'], why: 'a routine is in trouble: news about its setup' },
  'task-dir-size': { files: ['src/core/task-dir-size-notice.ts'], why: 'a task directory grown large on a host low on disk: news from the disk sweep' },
};
/** Every file that sends under the `peer` source, the one a task's FYI comes by, with why it is no clock. */
const PEER_SENDERS: Record<string, string> = {
  'src/core/sessions/session-send-core.ts': 'task_send and its replies: another task speaking now',
  'src/web/routes/messages-v1.ts': 'a calling session\'s Retry of its own message',
  'src/core/human-inbox/letter-ops.ts': 'an agent\'s answer to a letter, sent with a wake reason',
};

describe('one classifier: only an FYI waits', () => {
  it('every notice that waits is listed with why it has no clock, and only its listed files write it', () => {
    expect([...NOTICE_WAITS_COLD].sort()).toEqual(Object.keys(NO_CLOCK_NOTICES).sort());
    for (const o of NOTICE_WAITS_COLD) expect(o in NOTICE_WAKES, o).toBe(true);
    const writers: Record<string, string[]> = {};
    for (const p of srcFiles(path.join(ROOT, 'src'))) {
      const rel = path.relative(ROOT, p);
      if (rel === 'src/core/sessions/wake-policy.ts') continue;
      const s = fs.readFileSync(p, 'utf8');
      for (const o of NOTICE_WAITS_COLD) if (new RegExp(`["']${o}["']`).test(s)) (writers[o] ??= []).push(rel);
    }
    for (const o of NOTICE_WAITS_COLD) {
      // A file naming the outcome without writing a notice (a host's own check status) is not a writer.
      const notices = (writers[o] ?? []).filter((rel) => /outcome|walnut-message/.test(fs.readFileSync(path.join(ROOT, rel), 'utf8')));
      expect(notices.sort(), o).toEqual([...NO_CLOCK_NOTICES[o].files].sort());
    }
  });

  it('only another task\'s note and Walnut\'s notices can wait, and every sender under `peer` is listed', () => {
    expect([...COLD_HOLD_SOURCES].sort()).toEqual(['peer', 'walnut-notify']);
    const peerSenders = new Set<string>();
    for (const p of srcFiles(path.join(ROOT, 'src'))) {
      const s = fs.readFileSync(p, 'utf8');
      if (/source: [^,\n]*'peer'|const source = [^\n]*'peer'/.test(s)) peerSenders.add(path.relative(ROOT, p));
    }
    expect([...peerSenders].sort()).toEqual(Object.keys(PEER_SENDERS).sort());
  });

  it('a task\'s FYI and a notice with no clock wait; an ask, a reply, an alert, words and any trigger do not', () => {
    expect(waitsWhenCold(trouble(), 'walnut-notify')).toBe(true);
    expect(waitsWhenCold(fyi(), 'peer')).toBe(true);
    expect(waitsWhenCold(`${trouble()}\n\n${fyi()}`, 'peer')).toBe(true);
    expect(waitsWhenCold(notice('task-dir-size'), 'walnut-notify')).toBe(true);
    // The same FYI under any other source goes now: only these two senders send an FYI.
    expect(waitsWhenCold(fyi(), undefined)).toBe(false);
    expect(waitsWhenCold(fyi(), 'wait-until')).toBe(false);
    expect(waitsWhenCold(ask(), 'peer')).toBe(false);
    expect(waitsWhenCold(reply(), 'peer')).toBe(false);
    expect(waitsWhenCold(scriptNote(), 'peer')).toBe(false);
    expect(waitsWhenCold(notice('completed'), 'walnut-notify')).toBe(false);
    expect(waitsWhenCold(notice('threads-overdue'), 'walnut-notify')).toBe(false);
    expect(waitsWhenCold(notice('threads-overdue'), 'thread-recheck')).toBe(false);
    expect(waitsWhenCold(buildWalnutMessage({ kind: 'notification', attrs: { from: 'Walnut' }, body: 'your command ended' }), 'walnut-notify')).toBe(false);
    expect(waitsWhenCold('please look at the build', 'peer')).toBe(false);
    expect(waitsWhenCold(`${fyi()}\n\nand words`, 'peer')).toBe(false);
    expect(waitsWhenCold(`${fyi()}\n\n${ask()}`, 'peer')).toBe(false);
    for (const from of ['Walnut: re-check', 'Walnut: follow-up', 'Walnut: status check', 'Walnut: pull request watch', 'Walnut: change watch', 'Walnut: unanswered']) {
      const t = buildWalnutMessage({ kind: 'trigger', attrs: { from }, body: 'x' });
      for (const src of COLD_HOLD_SOURCES) expect(waitsWhenCold(t, src), from).toBe(false);
    }
  });
});

describe('a message a time brought never waits', () => {
  // 2026-11-18: a task's 20:00 timer fired at 04:02:48Z and reached its session at 05:03:08Z; a
  // re-check of an ask to the user (task 80f73e9b) was queued at 10:37:58Z and reached it at 11:38,
  // another (task e400170b) 09:21:46Z to 10:22. The Walnut VP: every message a time brings is the
  // moment itself and goes now.
  const clocks = (): Array<[string, string, string]> => [
    ['a trigger\'s fire', buildTriggerMessage({ name: 'Nightly journal' }, { atMs: Date.now(), items: [{ id: 'day-1' }] }, 'Write the journal.'), 'routine-trigger'],
    ['a scheduled routine', buildScheduledMessage('Morning digest', 'Send the digest.'), 'routine'],
    ['the wait clock', buildWalnutMessage({ kind: 'trigger', attrs: { from: WAIT_WAKE_FROM, note: 'the time this task was waiting for has passed' }, body: 'The wait ran until 8:15 PM.' }), constOf('src/core/task-wait-until.ts', 'WAIT_UNTIL_SEND_SOURCE')],
    ['a re-check of an ask to the user', buildWalnutMessage({ kind: 'trigger', attrs: { from: 'Walnut: re-check', note: 'is what you asked the user still needed' }, body: 'Your status asks the user' }), constOf('src/core/task-wait-until.ts', 'WAIT_UNTIL_SEND_SOURCE')],
    ['a re-check of letters', buildWalnutMessage({ kind: 'trigger', attrs: { from: 'Walnut: re-check', note: 'do your letters to the user still need an answer' }, body: 'letters' }), constOf('src/core/task-wait-until.ts', 'WAIT_UNTIL_SEND_SOURCE')],
    ['a re-check of a Board choice', buildWalnutMessage({ kind: 'trigger', attrs: { from: 'Walnut: re-check', note: 'is the choice on your Board still needed' }, body: 'choice' }), 'choice-recheck'],
    ['a follow-up Walnut set', buildWalnutMessage({ kind: 'trigger', attrs: { from: 'Walnut: follow-up', note: 'the follow-up Walnut set' }, body: 'you said you would' }), 'promise-alarm'],
    ['a status check', buildWalnutMessage({ kind: 'trigger', attrs: { from: 'Walnut: status check', note: 'your park waits on nothing outside' }, body: 'x' }), constOf('src/core/task-wait-until.ts', 'WAIT_UNTIL_SEND_SOURCE')],
    ['threads past their time', notice('threads-overdue'), constOf('src/core/org/thread-recheck.ts', 'THREAD_RECHECK_SOURCE')],
    ['a pull request watch', buildWalnutMessage({ kind: 'trigger', attrs: { from: 'Walnut: pull request watch' }, body: 'checks failed' }), 'pr-watch'],
    ['a change watch', buildWalnutMessage({ kind: 'trigger', attrs: { from: 'Walnut: change watch' }, body: 'build 42 failed' }), 'change-watch'],
  ];

  it('every clock and watch goes now, alone or with notes that could wait', () => {
    for (const [what, text, source] of clocks()) {
      expect(waitsWhenCold(text, source), what).toBe(false);
      expect(waitsWhenCold(`${fyi()}\n\n${text}`, source), what).toBe(false);
      // Under a source an FYI may come by too: the envelope alone keeps it from waiting.
      for (const src of COLD_HOLD_SOURCES) expect(waitsWhenCold(text, src), `${what} under ${src}`).toBe(false);
    }
  });

  it('every trigger envelope written in src/ goes now, whatever its sender', () => {
    let n = 0;
    for (const p of srcFiles(path.join(ROOT, 'src'))) {
      const s = fs.readFileSync(p, 'utf8');
      for (const m of s.matchAll(/kind: 'trigger',\s*attrs: \{ from: ('([^']*)'|`([^`]*)`|([A-Z_]+))/g)) {
        n++;
        const from = m[2] ?? (m[3] ? m[3].replace(/\$\{[^}]*\}/g, 'x') : m[4]);
        const t = buildWalnutMessage({ kind: 'trigger', attrs: { from }, body: 'x' });
        for (const src of COLD_HOLD_SOURCES) expect(waitsWhenCold(t, src), `${path.relative(ROOT, p)}: ${from}`).toBe(false);
      }
    }
    expect(n).toBeGreaterThanOrEqual(8);
  });

  it('the 11-18 re-check, with a notice riding in front of it, reaches a cold session at once', async () => {
    // What reached task e400170b at 10:22 instead of 09:21: a routing notice riding, then the re-check.
    await sendMessageToSession(SID, notice('task-routing-policy'), { source: 'walnut-notify' });
    expect(sends).toEqual([]);
    const recheck = buildWalnutMessage({ kind: 'trigger', attrs: { from: 'Walnut: re-check', note: 'is what you asked the user still needed' }, body: 'Your status asks the user: "..."' });
    const row = await sendMessageToSession(SID, recheck, { source: constOf('src/core/task-wait-until.ts', 'WAIT_UNTIL_SEND_SOURCE') });
    expect(isColdHold(row)).toBe(false);
    expect(sends).toHaveLength(1);
    expect(row.message).toContain('outcome="task-routing-policy"');
    expect(row.message).toContain('from="Walnut: re-check"');
  });

  it('goes in ONE line behind what was held before it', async () => {
    const news = await sendMessageToSession(SID, trouble(), TROUBLE);
    const note = await sendMessageToSession(SID, fyi(), { source: 'peer' });
    expect([news, note].every(isColdHold)).toBe(true);
    expect(sends).toEqual([]);
    const fire = await sendMessageToSession(SID, triggerFire('Nightly journal', 'write the journal'), { source: 'routine-trigger' });
    expect(isColdHold(fire)).toBe(false);
    expect(sends).toEqual([{ sessionId: SID, source: 'routine-trigger' }]);
    const batch = await markProcessing(SID);
    expect(batch.map((m) => m.message.includes('build 42 failed') ? 'news' : m.message.includes('FYI') ? 'fyi' : m.message.includes('write the journal') ? 'fire' : 'other'))
      .toEqual(['news', 'fyi', 'fire']);
    expect(new Set(batch.map((m) => m.lineUuid)).size).toBe(1);
  });

  it('a fire held by an older build goes by the next sweep, not by its max hold', async () => {
    const row = await sendMessageToSession(SID, trouble(), TROUBLE);
    // What an older build stored: the task's own fire, held.
    const { mutateStore } = await import('../../../src/core/session-queue-store.js');
    await mutateStore((st) => { st.queues[SID][0].message = triggerFire(); });
    resetCache();
    await startColdHold();
    expect(sends).toEqual([{ sessionId: SID, source: 'walnut-notify' }]);
    expect((await getQueue(SID)).find((m) => m.id === row.id)?.status).toBe('pending');
  });
});

describe('a cold session', () => {
  it('holds what can wait, shows it held, and sends it all in ONE line in front of the message that cannot', async () => {
    const a = await sendMessageToSession(SID, trouble(), TROUBLE);
    const b = await sendMessageToSession(SID, fyi(), { source: 'peer' });
    expect([a, b].every(isColdHold)).toBe(true);
    expect(sends).toEqual([]);
    const shown = (await getSessionQueuePayload(SID)).messages as Array<{ status: string; heldReason?: string; heldRetryAt?: string }>;
    expect(shown.map((m) => m.status)).toEqual(['pending', 'pending']);
    expect(shown[0].heldReason).toMatch(/^Held: the session is idle and its prompt cache has expired/);
    expect(Date.parse(shown[1].heldRetryAt!)).toBe(Date.parse(a.parkedAt!) + COLD_HOLD_MAX_MS);

    await sendMessageToSession(SID, 'what broke?', { source: 'ui' });
    expect(sends).toEqual([{ sessionId: SID, source: 'ui' }]);
    const batch = await markProcessing(SID);
    expect(batch.map((m) => m.message.includes('build 42 failed') ? 'news' : m.message.includes('FYI') ? 'fyi' : 'words')).toEqual(['news', 'fyi', 'words']);
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

  it('sends what it held by the max hold, under the held send\'s own source', async () => {
    const a = await sendMessageToSession(SID, trouble(), TROUBLE);
    startColdHold();
    await sweepColdHolds(Date.parse(a.parkedAt!) + COLD_HOLD_MAX_MS - 1000);
    expect(sends).toEqual([]);
    await sweepColdHolds(Date.parse(a.parkedAt!) + COLD_HOLD_MAX_MS);
    expect(sends).toEqual([{ sessionId: SID, source: 'walnut-notify' }]);
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
    const row = await sendMessageToSession(SID, trouble(), TROUBLE);
    expect(row.status).toBe('pending');
    expect(sends).toHaveLength(1);
  });

  it('loses nothing across a restart: the row stays held on disk and goes by its max hold', async () => {
    const a = await sendMessageToSession(SID, trouble(), TROUBLE);
    stopColdHold();
    resetCache();
    await loadQueue();
    const after = await getQueue(SID);
    expect(after).toHaveLength(1);
    expect(isColdHold(after[0])).toBe(true);
    expect(after[0].coldSend).toEqual({ source: 'walnut-notify' });
    await startColdHold();
    await sweepColdHolds(Date.parse(a.parkedAt!) + COLD_HOLD_MAX_MS + 1);
    expect(sends).toEqual([{ sessionId: SID, source: 'walnut-notify' }]);
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
    const a = await sendMessageToSession(SID, trouble(), TROUBLE);
    const NEW = 'dddddddd-1111-4222-8333-555555555555';
    expect((await migrateSessionQueue(SID, NEW)).movedIds).toEqual([a.id]);
    await sweepColdHolds(Date.parse(a.parkedAt!) + COLD_HOLD_MAX_MS);
    expect(sends).toEqual([{ sessionId: NEW, source: 'walnut-notify' }]);
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
