/**
 * A thread that sat too long with nothing from the node wakes the node, on a real server
 * (2026-11-07, the user: "one that has had no reply for this long, something must be wrong: the AI
 * should go and answer it, and if not, our system reminds"; src/core/org/thread-recheck.ts).
 * Each case has its own lead with a session; a pass is run by hand at a chosen time (the timer
 * only calls the same function). Covered: one note into the lead's session naming the overdue
 * threads, recorded on each thread before the send; no second note for the same stretch; the
 * thread shows to him through the real route once it stays overdue, and a pending one never does;
 * the lead's own answer on the thread starts a new stretch and takes it off the list; a summary
 * stamps `replyAt` and replaces the older answer on the card; nothing for a team or a session the
 * user stopped, nor while the org is off.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import type { Server } from 'node:http';
import { vi } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';
vi.mock('../../src/constants.js', () => createMockConstants('thread-recheck-e2e', { IS_EPHEMERAL: true }));
import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { addTask, updateTaskRaw } from '../../src/core/task-manager.js';
import { createSessionRecord, updateSessionRecord } from '../../src/core/session-tracker.js';
import { executeOp } from '../../src/ops/index.js';
import { fileThreadMessage, readThreads, setThreadAnswers } from '../../src/core/org/threads-store.js';
import { getQueue } from '../../src/core/session-message-queue.js';
import { _resetOrgEnabledForTesting } from '../../src/core/org/org-enabled.js';
import { runThreadRecheck, THREAD_RECHECK_SOURCE } from '../../src/core/org/thread-recheck.js';
import { cardView } from '../../src/core/org/thread-view.js';

let server: Server;
let root: string;
interface Lead { id: string; sid: string }
let n = 0;
async function newLead(): Promise<Lead> {
  const lead = (await addTask({ title: `VP ${++n}`, project: `RcProj${n}`, source: 'local', org_role: 'lead' } as never)).task;
  const sid = `trc-lead-${n}`;
  await createSessionRecord(sid, lead.id, `RcProj${n}`);
  return { id: lead.id, sid };
}
const run = async (lead: Lead, name: string, args: Record<string, unknown>) => {
  const out = await executeOp(name, args, { apiBase: root, origin: '__local__', callerMode: 'session', callerSid: lead.sid });
  if (!out.ok) throw new Error(out.message);
  return out.result as Record<string, any>;
};
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
async function shownOnRoute(lead: Lead): Promise<Record<string, boolean>> {
  const res = await fetch(`${root}/api/v1/tasks/${lead.id}/threads?open=1`);
  const body = await res.json() as { threads: Array<{ id: string; shown: boolean }> };
  return Object.fromEntries(body.threads.map((t) => [t.id, t.shown]));
}
const notes = async (lead: Lead) => (await getQueue(lead.sid)).filter((m) => m.source === THREAD_RECHECK_SOURCE || m.message.includes('Walnut: threads'));

beforeAll(async () => {
  _resetOrgEnabledForTesting(true);
  server = await startServer({ port: 0, dev: true });
  root = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { _resetOrgEnabledForTesting(); await stopServer(); await fs.rm(WALNUT_HOME, { recursive: true, force: true }); });

describe('a thread with no reply for too long', () => {
  it('wakes its lead once with the thread named, then shows to him; a pending one never', async () => {
    const lead = await newLead();
    const late = (await fileThreadMessage(lead.id, { text: 'why is it still queued?', via: 'chat', at: ago(90) })).thread.id;
    const fresh = (await fileThreadMessage(lead.id, { text: 'and the extension?', via: 'chat', at: ago(5) })).thread.id;
    const handed = (await fileThreadMessage(lead.id, { text: 'build the phone button', via: 'chat', at: ago(120) })).thread.id;
    await run(lead, 'thread_update', { id: handed, state: 'pending', title: 'Phone button' });

    expect(await shownOnRoute(lead)).toMatchObject({ [late]: true, [fresh]: false, [handed]: false });
    expect(await runThreadRecheck()).toContain(lead.id);
    const sent = await notes(lead);
    expect(sent).toHaveLength(1);
    expect(sent[0].message).toContain(late);
    expect(sent[0].message).toContain('has no reply on this thread');
    expect(sent[0].message).not.toContain(fresh);
    expect(sent[0].message).not.toContain(handed);
    const marked = (await readThreads(lead.id)).threads.find((t) => t.id === late)!;
    expect(marked.recheck).toMatchObject({ since: marked.messages[0].at, why: 'reply' });
    // It went in: no longer marked as on its way.
    expect(marked.recheck?.pending).toBeUndefined();
    expect(sent[0].message).toContain('kind="notification"');

    // The same stretch is not asked about again.
    expect(await runThreadRecheck()).not.toContain(lead.id);
    expect(await notes(lead)).toHaveLength(1);

    // The lead answers on the thread: a new stretch, no longer overdue, and the summary is the card.
    await setThreadAnswers(lead.id, new Map([[marked.messages[0].id, { text: 'It waits for a start slot.', at: new Date().toISOString() }]]));
    const res = await run(lead, 'thread_update', { id: late, reply: 'Waiting for a start slot; the cap is lifted in the next deploy.' });
    const after = (await readThreads(lead.id)).threads.find((t) => t.id === late)!;
    expect(after).toMatchObject({ state: 'answered', replyAt: expect.any(String) });
    expect(res).toBeTruthy();
    expect(cardView(after).unread).toEqual([]);
    expect(await runThreadRecheck()).not.toContain(lead.id);
  });

  it('a handoff answer on a working thread stays out of his view until the lead gives it a state', async () => {
    const lead = await newLead();
    const id = (await fileThreadMessage(lead.id, { text: 'can it skip opening the app?', via: 'chat', at: ago(1) })).thread.id;
    await run(lead, 'thread_update', { id, state: 'working', title: 'Skip opening the app' });
    const msgId = (await readThreads(lead.id)).threads.find((t) => t.id === id)!.messages[0].id;
    await setThreadAnswers(lead.id, new Map([[msgId, { text: 'Both went to the action button team.', at: new Date().toISOString() }]]));
    expect((await shownOnRoute(lead))[id]).toBe(false);
    await run(lead, 'thread_update', { id, reply: 'iOS allows it; a new build ships it.' });
    expect((await shownOnRoute(lead))[id]).toBe(true);
  });

  it('nothing for a team the user stopped (even with no member to bring back) or a session he stopped', async () => {
    const stoppedTeam = await newLead();
    await fileThreadMessage(stoppedTeam.id, { text: 'is the build green?', via: 'chat', at: ago(120) });
    // Review 2026-11-07: a stop records only members with something to resume, so a lead with none has members: [].
    await updateTaskRaw(stoppedTeam.id, { team_stop: { at: new Date().toISOString(), by: 'human', when: 'now', members: [] } } as never);
    const stoppedSession = await newLead();
    await fileThreadMessage(stoppedSession.id, { text: 'is the deploy out?', via: 'chat', at: ago(120) });
    await updateSessionRecord(stoppedSession.sid, { process_status: 'stopped', status_reason: 'user_stopped' } as never);
    const woken = await runThreadRecheck();
    expect(woken).not.toContain(stoppedTeam.id);
    expect(woken).not.toContain(stoppedSession.id);
    expect(await notes(stoppedTeam)).toHaveLength(0);
    expect(await notes(stoppedSession)).toHaveLength(0);
    // His view still says it waits too long.
    expect((await shownOnRoute(stoppedSession))[(await readThreads(stoppedSession.id)).threads[0].id]).toBe(true);
  });

  it('nothing while the org is off', async () => {
    const lead = await newLead();
    await fileThreadMessage(lead.id, { text: 'is the deploy done?', via: 'chat', at: ago(120) });
    _resetOrgEnabledForTesting(false);
    try {
      expect(await runThreadRecheck()).toEqual([]);
      expect(await notes(lead)).toHaveLength(0);
    } finally {
      _resetOrgEnabledForTesting(true);
    }
  });
});
