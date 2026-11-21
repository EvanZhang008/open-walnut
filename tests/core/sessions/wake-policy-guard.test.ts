/**
 * Which messages may start a turn (src/core/sessions/wake-policy.ts, 2026-11-15, the user on the weekly
 * LLM cost letter: "first check if it is right to wake up"). Pinned here:
 *  - every notice kind a producer in src/ writes is classified: it rides, or it wakes with a reason.
 *    A new outcome, or a new notice written with no outcome (which wakes), fails this test until it
 *    is listed, so no notice starts turns by being forgotten;
 *  - a message of notices that ask nothing never goes to the CLI on its own, idle or mid-turn: it
 *    is held (no row, no SESSION_SEND) and rides in front of the next message;
 *  - a wake reason, a person's words, an unknown outcome or a notice with a `request` always wake.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/constants.js')>();
  return { ...actual, ...createMockConstants('walnut-wake-policy') };
});

import { WALNUT_HOME } from '../../../src/constants.js';
import { NOTICE_RIDES, NOTICE_WAKES, classifiedOutcomes, noticeWakes, rowRides } from '../../../src/core/sessions/wake-policy.js';
import { buildWalnutMessage } from '../../../src/core/peers/walnut-message-tag.js';
import {
  getQueue, resetCache, sendMessageToSession,
} from '../../../src/core/session-message-queue.js';
import { createSessionRecord, updateSessionRecord, _resetSessionTrackerForTesting } from '../../../src/core/session-tracker.js';
import { bus, EventNames } from '../../../src/core/event-bus.js';
import { _clearHeldNotices, FOLD_PARTS_MAX, heldNoticeKeys } from '../../../src/core/sessions/held-notices.js';

const ROOT = path.resolve(__dirname, '../../..');

function srcFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...srcFiles(p));
    else if (/\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/**
 * Every Walnut notice a producer builds (`kind: 'notification'` inside a buildWalnutMessage call,
 * read up to its `body`), with the outcome expression it sets, or null for none.
 */
function noticeSites(): Array<{ file: string; outcome: string | null }> {
  const sites: Array<{ file: string; outcome: string | null }> = [];
  for (const p of srcFiles(path.join(ROOT, 'src'))) {
    const s = fs.readFileSync(p, 'utf8');
    for (const m of s.matchAll(/kind: 'notification'/g)) {
      const before = s.slice(Math.max(0, m.index! - 400), m.index);
      if (!/(?:buildWalnutMessage|buildMessage)\(\{\s*$/.test(before)) continue;
      const head = s.slice(m.index, m.index! + 800).split(/\bbody\b/)[0];
      const outcome = /\boutcome: ([^,}\n]+)/.exec(head)?.[1].trim() ?? (/\battrs: ([A-Z_]+)\b/.exec(head) ? `attrs: ${/\battrs: ([A-Z_]+)\b/.exec(head)![1]}` : null);
      sites.push({ file: path.relative(ROOT, p), outcome });
    }
  }
  return sites;
}

/**
 * Notices built with an outcome that is not a literal: each expression, and every value it can take
 * (each must be classified). A new dynamic outcome fails until it is listed here.
 */
const DYNAMIC_OUTCOMES: Record<string, string[]> = {
  // session-requests.ts: a request past its deadline, still queued or not.
  "stillQueued ? 'timeout' : 'error'": ['timeout', 'error'],
  QUIET_NOTES_OUTCOME: ['quiet-notes'],
  // held-notices.ts renderTell: a sender's tell, by its kind (checked against TELL_OUTCOME below).
  'TELL_OUTCOME[kind]': ['note-dropped', 'note-held'],
  // topics/topic-text.ts: a topic's lines that did not wake the member.
  TOPIC_NEWS_OUTCOME: ['topic-news'],
  // adopt-notice.ts AdoptNoticeKind.
  'n.kind': ['adopted', 'released'],
  "sw.move ? 'move-expired' : 'switch-expired'": ['move-expired', 'switch-expired'],
  // trigger-health.ts: the stage's outcome, and the routine notice's.
  'outcomes[stage]': ['check_failed', 'check_failing', 'trigger_disabled'],
  'input.outcome': ['routine_trouble', 'check_failed', 'check_failing', 'trigger_disabled', 'check_repaired'],
  // envelope-kit.ts subtask notices: SubtaskNoticeKind (checked from the type below).
  kind: ['completed', 'error', 'stopped', 'blocked', 'waiting'],
  // org/retired-lead.ts.
  HANDED_OVER: ['handed-over'],
  // instruction-notice.ts: its attrs are one constant (OUTCOME, read below).
  'attrs: NOTICE_ATTRS': ['task-routing-policy'],
  // approvals/tell-asker.ts askerNoticeFor.
  'notice.outcome': ['approved', 'denied', 'expired'],
};

/**
 * Notices with no outcome: each wakes its reader (noticeWakes(undefined)), so each must say why.
 * A new one fails until it is listed with its reason.
 */
const NO_OUTCOME_WAKES: Record<string, string> = {
  'src/core/usage-watch/runtime.ts': 'a real-use alarm on a change the task shipped or leads, or its watch\'s verdict: the task fixes it there',
  'src/core/offline-handover.ts': 'changes the session made while the server was away were not applied: it must redo them',
  'src/core/session-requests.ts': 'a fork is handed the requests its parent still owes: the new session answers them',
  'src/core/hosts/host-exec-stale-reads.ts': 'the session\'s own loop keeps reading a host job that ended or is gone: it stops the loop and goes on',
  'src/core/sessions/missing-walnut-tool.ts': 'a tool the session just called is not offered: it is told what to use and goes on',
  'src/core/sessions/ask-answer.ts': 'the session\'s ask of the user was answered in a teammate: it carries on with that answer',
  'src/core/sessions/background-work-wake.ts': 'a command the session left running ended: it reads the result and goes on',
  'src/core/health-monitor/fix-task.ts': 'a health alarm about the problem this task works on',
  'src/core/peers/envelope-kit.ts': 'a request of the session to another task passed its deadline (carries `request`, so it wakes)',
};

describe('every notice kind is classified', () => {
  it('rides and wakes never overlap, and each wake says why', () => {
    const rides = new Set(NOTICE_RIDES);
    for (const [outcome, reason] of Object.entries(NOTICE_WAKES)) {
      expect(rides.has(outcome), outcome).toBe(false);
      expect(reason.length, outcome).toBeGreaterThan(20);
    }
    expect(new Set(classifiedOutcomes()).size).toBe(classifiedOutcomes().length);
  });

  it('every outcome a producer in src/ writes is classified; a dynamic or missing outcome is listed', () => {
    const known = new Set(classifiedOutcomes());
    const sites = noticeSites();
    expect(sites.length).toBeGreaterThan(30);
    const unlisted: string[] = [];
    for (const site of sites) {
      if (site.outcome === null) {
        if (!(site.file in NO_OUTCOME_WAKES)) unlisted.push(`${site.file}: a notice with no outcome (it wakes): list it in NO_OUTCOME_WAKES with why`);
        continue;
      }
      const literal = /^'([^']+)'$/.exec(site.outcome)?.[1];
      const values = literal ? [literal] : DYNAMIC_OUTCOMES[site.outcome];
      if (!values) { unlisted.push(`${site.file}: outcome ${site.outcome}: list its values in DYNAMIC_OUTCOMES`); continue; }
      for (const v of values) if (!known.has(v)) unlisted.push(`${site.file}: outcome '${v}': classify it in src/core/sessions/wake-policy.ts`);
    }
    expect(unlisted).toEqual([]);
  });

  it('a notice written as a literal envelope (no builder) is classified too', () => {
    // 2026-11-16: task-dir-size-notice.ts writes its tag by hand; the scan above never saw it, and
    // production logged it as an outcome this file does not classify.
    const known = new Set(classifiedOutcomes());
    const literal: string[] = [];
    for (const p of srcFiles(path.join(ROOT, 'src'))) {
      const s = fs.readFileSync(p, 'utf8');
      for (const m of s.matchAll(/walnut-message kind=\\?"notification"[^>`]*?outcome=\\?"([a-z_-]+)/g)) literal.push(`${path.relative(ROOT, p)}:${m[1]}`);
      for (const m of s.matchAll(/NOTICE_OUTCOME_ATTR = 'outcome="([a-z_-]+)"'/g)) literal.push(`${path.relative(ROOT, p)}:${m[1]}`);
    }
    expect(literal.length).toBeGreaterThanOrEqual(3);
    expect(literal.filter((x) => !known.has(x.split(':').pop()!))).toEqual([]);
  });

  it('the outcomes held in constants are classified too', () => {
    const known = new Set(classifiedOutcomes());
    const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8');
    const kinds = /export type SubtaskNoticeKind = ([^;]+);/.exec(read('src/core/peers/envelope-kit.ts'))![1].match(/'([^']+)'/g)!.map((k) => k.slice(1, -1));
    expect(kinds.sort()).toEqual([...DYNAMIC_OUTCOMES.kind].sort());
    const adopt = /export type AdoptNoticeKind = ([^;]+);/.exec(read('src/core/sessions/adopt-notice.ts'))![1].match(/'([^']+)'/g)!.map((k) => k.slice(1, -1));
    expect(adopt.sort()).toEqual([...DYNAMIC_OUTCOMES['n.kind']].sort());
    const routing = /const OUTCOME = '([^']+)'/.exec(read('src/core/sessions/instruction-notice.ts'))?.[1];
    expect(routing && known.has(routing)).toBe(true);
    expect(known.has(/HANDED_OVER = '([^']+)'/.exec(read('src/core/org/retired-lead.ts'))?.[1] ?? '')).toBe(true);
    const tells = /export const TELL_OUTCOME[^=]*= \{([^}]+)\}/.exec(read('src/core/sessions/held-notices.ts'))![1].match(/'([^']+)'/g)!.map((k) => k.slice(1, -1));
    expect(tells.sort()).toEqual([...DYNAMIC_OUTCOMES['TELL_OUTCOME[kind]']].sort());
    for (const v of Object.values(DYNAMIC_OUTCOMES).flat()) expect(known.has(v), v).toBe(true);
  });

  it('a subtask\'s completion and error wake an idle lead; its stop, park and block ride', () => {
    expect(['completed', 'error'].every(noticeWakes)).toBe(true);
    expect(['stopped', 'waiting', 'blocked'].some(noticeWakes)).toBe(false);
  });
});

const note = (outcome: string, extra: Record<string, string> = {}) =>
  buildWalnutMessage({ kind: 'notification', attrs: { from: 'Walnut', outcome, note: 'not a work request', ...extra }, body: `a ${outcome} notice` });

describe('which rows ride', () => {
  it('only rows of nothing but notices that ask nothing', () => {
    expect(rowRides(note('status'))).toBe(true);
    expect(rowRides(`${note('status')}\n\n${note('org-update')}`)).toBe(true);
    expect(rowRides(`${note('status')}\n\nhello`)).toBe(false);
    expect(rowRides(note('completed'))).toBe(false);
    expect(rowRides(note('timeout', { request: 'rq-1' }))).toBe(false);
    expect(rowRides(note('a-new-outcome'))).toBe(false);
    expect(rowRides(buildWalnutMessage({ kind: 'notification', attrs: { from: 'Walnut' }, body: 'your command ended' }))).toBe(false);
    expect(rowRides(buildWalnutMessage({ kind: 'peer-note', attrs: { from: 'Main' }, body: 'FYI' }))).toBe(false);
    expect(rowRides('')).toBe(false);
    // Walnut's hint blocks ride with any message and ask nothing themselves.
    expect(rowRides(`${note('status')}\n\n<system-reminder>\nWalnut (rich-output): rich output mode is on.\n</system-reminder>`)).toBe(true);
  });
});

const SID = 'bbbbbbbb-1111-4222-8333-555555555555';

describe('a message that rides starts no turn', () => {
  let kicks: string[] = [];
  beforeEach(async () => {
    await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
    await fsp.mkdir(WALNUT_HOME, { recursive: true });
    resetCache();
    _clearHeldNotices();
    _resetSessionTrackerForTesting();
    await createSessionRecord(SID, 't-lead', 'Acme', '/tmp', { initialProcessStatus: 'idle' });
    kicks = [];
    bus.subscribe('wake-policy-test', (e) => {
      if (e.name === EventNames.SESSION_SEND) kicks.push(String((e.data as { sessionId?: string }).sessionId));
    }, { global: true, interest: [EventNames.SESSION_SEND] });
  });
  afterEach(async () => {
    bus.unsubscribe('wake-policy-test');
    resetCache();
    _clearHeldNotices();
    await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {});
  });

  it('an idle session: held, no row, no kick; the next message that wakes carries each once', async () => {
    const a = await sendMessageToSession(SID, note('status'), { source: 'walnut-notify' });
    const b = await sendMessageToSession(SID, note('org-update'), { source: 'walnut-notify' });
    expect([a.id, b.id].every((id) => id.startsWith('rides-'))).toBe(true);
    expect(kicks).toEqual([]);
    expect(await getQueue(SID)).toEqual([]);
    expect(heldNoticeKeys(SID)).toEqual(['riding-notices']);

    const row = await sendMessageToSession(SID, 'please look at the build', { source: 'walnut-notify' });
    expect(kicks).toEqual([SID]);
    expect(row.message.match(/outcome="status"/g)).toHaveLength(1);
    expect(row.message.match(/outcome="org-update"/g)).toHaveLength(1);
    expect(row.message.indexOf('outcome="status"')).toBeLessThan(row.message.indexOf('please look at the build'));
    expect(heldNoticeKeys(SID)).toEqual([]);
  });

  it('a long run of them keeps the newest, says how many it dropped, and never nests', async () => {
    for (let i = 0; i < FOLD_PARTS_MAX + 2; i++) {
      await sendMessageToSession(SID, buildWalnutMessage({ kind: 'notification', attrs: { from: 'Walnut', outcome: 'status' }, body: `line ${i}` }), { source: 'walnut-notify' });
    }
    expect(kicks).toEqual([]);
    const row = await sendMessageToSession(SID, 'go', { source: 'walnut-notify' });
    // The newest FOLD_PARTS_MAX notices, plus Walnut's own note saying how many it dropped, which is
    // an envelope too: a bare line there read as the user's words (rider-framing-guard.test.ts).
    expect(row.message.match(/outcome="status"/g)).toHaveLength(FOLD_PARTS_MAX + 1);
    expect(row.message.match(/\nline \d+\n/g)).toHaveLength(FOLD_PARTS_MAX);
    expect(row.message).not.toContain('line 0\n');
    expect(row.message).toContain(`line ${FOLD_PARTS_MAX + 1}`);
    expect(row.message).toContain('2 older notices that asked nothing dropped');
    // Read as every transcript reader reads a row: hint blocks off first, then who typed what.
    const { personTextOf, transcriptSentBy } = await import('../../../src/core/sessions/transcript-sent-by.js');
    const { parseHinted } = await import('../../../src/core/hints/hint-format.js');
    const stored = parseHinted(row.message).text;
    expect(transcriptSentBy({ role: 'user', text: stored })).toBe('agent');
    expect(personTextOf(stored)).toBeUndefined();
  });

  it('a running turn does not get it either: held, no row, no kick', async () => {
    // 2026-11-16: notices written into the Walnut VP 1 to 5 s after its last words (its Stop hooks
    // still running) each started an agent-ack turn.
    await updateSessionRecord(SID, { process_status: 'running' });
    const row = await sendMessageToSession(SID, note('waiting'), { source: 'walnut-notify', messageId: 'qm-subtask-1' });
    expect(row.id).toBe('qm-subtask-1');
    expect(kicks).toEqual([]);
    expect(await getQueue(SID)).toEqual([]);
    expect(heldNoticeKeys(SID)).toEqual(['riding-notices']);
  });

  it('a notice that rides carries none of the other notes waiting: they wait for a message that wakes', async () => {
    const { holdNotice } = await import('../../../src/core/sessions/held-notices.js');
    holdNotice(SID, 'overdue:rq-1', note('timeout'));
    await sendMessageToSession(SID, note('status'), { source: 'walnut-notify' });
    const row = await sendMessageToSession(SID, 'go on', { source: 'walnut-notify' });
    expect(row.message.match(/outcome="timeout"/g)).toHaveLength(1);
    expect(row.message.match(/outcome="status"/g)).toHaveLength(1);
  });

  it('a wake reason, a person\'s words and a notice that wakes all start a turn', async () => {
    await sendMessageToSession(SID, note('org-update'), { source: 'walnut-notify', wakeReason: 'a task of its team waits on the lead' });
    await sendMessageToSession(SID, note('status').replace('a status notice', 'a status notice pasted by the person'), { source: 'ui' });
    await sendMessageToSession(SID, note('completed'), { source: 'walnut-notify' });
    expect(kicks).toEqual([SID, SID, SID]);
    expect((await getQueue(SID))).toHaveLength(3);
  });
});
