/**
 * Two Inbox Triage runs, end to end on the real server: the real config route,
 * the real bus, the real wake gate, the real batch action, the real cron engine
 * and the real claude-code executor, against a mock daemon and a mock CLI.
 *
 * What only this layer can prove:
 *  - the whole chain fires from nothing but two plugin events: collector → wake
 *    counter → threshold → batch action → a session;
 *  - decision D2 — every run is a NEW task AND a NEW session, both filed under
 *    'Ask Inbox Triage' and both kept OFF the pinned board;
 *  - the batch the session receives is one envelope whose counts match the events;
 *  - the buffer is cleared only once a run's task exists (at-least-once);
 *  - `session:result` closes a run out: COMPLETE, exactly one journal line, and
 *    the State.md check that warns the NEXT envelope.
 *
 * TWO THINGS THIS FILE HAS TO ARRANGE, both consequences of running the server
 * from source rather than from dist:
 *
 *  1. Builtin actions live in `dist/actions/` and the registry finds them by
 *     walking up from its own file, so a src-run server discovers NONE (its
 *     registry sits in src/actions/). The action is therefore installed as a USER
 *     action — a one-line .mjs re-export, written BEFORE the server boots because
 *     discovery is cached at boot. What runs is the real module.
 *  2. The CLI is tests/providers/mock-claude.mjs, so what is asserted is the
 *     LAUNCH REQUEST (a task, a session record, the message it carried) and never
 *     a model's answer.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Server as HttpServer } from 'node:http';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-triage-run'));

import { WALNUT_HOME } from '../../src/constants.js';
import { sessionRunner } from '../../src/providers/claude-code-session.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js';
import { bus, EventNames } from '../../src/core/event-bus.js';
import { getRoutineWakeHandleForTesting } from '../../src/core/routines/wake-events.js';
import { getTriageCollectHandleForTesting } from '../../src/core/triage/collect.js';
import { loadTriageState } from '../../src/core/triage/state.js';
import { triageRunsNotePath } from '../../src/core/triage/runs.js';
import { getTask } from '../../src/core/task-manager.js';
import { getSessionsForTask } from '../../src/core/session-tracker.js';

const MOCK_CLI = path.resolve(import.meta.dirname, '../providers/mock-claude.mjs');
const ACTION_SRC = path.resolve(import.meta.dirname, '../../src/actions/inbox-triage-batch.ts');
const TRIAGE_PROJECT = 'Ask Inbox Triage';

let server: HttpServer;
let port: number;
let daemon: MockDaemon;

function apiUrl(p: string): string {
  return `http://localhost:${port}${p}`;
}

async function get(p: string): Promise<{ status: number; json: any }> {
  const res = await fetch(apiUrl(p));
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function send(method: 'PUT' | 'POST', p: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(apiUrl(p), {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function triageRoutine(): Promise<any | undefined> {
  const { json } = await get('/api/routines?includeDisabled=true');
  return (json?.jobs ?? []).find((j: any) => j?.initProcessor?.actionId === 'inbox-triage-batch');
}

async function triageTasks(): Promise<any[]> {
  const { json } = await get('/api/tasks');
  const list = Array.isArray(json) ? json : json?.tasks ?? [];
  return list.filter((t: any) => t?.project === TRIAGE_PROJECT);
}

async function readJournal(): Promise<string> {
  const file = path.join(WALNUT_HOME, 'notes', triageRunsNotePath(Date.now()));
  return await fs.readFile(file, 'utf-8').catch(() => '');
}

/**
 * The wake subscriber re-arms on a DEBOUNCE after a routine mutation, so the
 * routine being visible over HTTP does not yet mean its events are being counted.
 * Emitting before that point drops them on the floor (measured: the interest set
 * is still empty the moment GET /api/routines first shows the routine).
 */
async function waitForWakeInterest(): Promise<void> {
  await vi.waitFor(() => {
    const interest = getRoutineWakeHandleForTesting()?.stats().interest ?? [];
    expect(interest).toContain('plugin:mail:messages-received');
    expect(interest).toContain('plugin:slack:messages-received');
  }, { timeout: 20_000, interval: 50 });
}

/** Announce a batch of arrivals the way the two plugins do, then flush. */
async function announce(mailCounts: Array<[string, number]>, slackItems: number): Promise<void> {
  await waitForWakeInterest();
  for (const [accountId, count] of mailCounts) {
    bus.emit('plugin:mail:messages-received', {
      accountId, count,
      headlines: [{ from: `list@${accountId}.test`, subject: `${accountId}: RFC v3 is out` }],
    }, ['web-ui']);
  }
  if (slackItems > 0) {
    bus.emit('plugin:slack:messages-received', {
      count: slackItems,
      items: Array.from({ length: slackItems }, (_, i) => ({
        conversation: '#platform', isDm: false, isMention: i === 0,
        alias: `person${i}`, ts: String(1_700_000_000 + i),
        permalink: `https://example.test/archives/C1/p${i}`, text: `line ${i}`,
      })),
      dropped: 0,
    }, ['web-ui']);
  }
  // The collector flushes on a 5s trailing timer; flushing NOW puts the items on
  // disk before the wake gate (its own 5s timer) dispatches the run, which is the
  // healthy ordering. The other order is safe too — the batch would simply carry
  // them next run — but it is not what this test is measuring.
  const collector = getTriageCollectHandleForTesting();
  expect(collector, 'the server must have armed the collector').not.toBeNull();
  await collector!.flush();
}

/** Wait for a NEW task under the triage project, and answer with it. */
async function waitForNewRunTask(knownIds: Set<string>): Promise<any> {
  return await vi.waitFor(async () => {
    const fresh = (await triageTasks()).find((t: any) => !knownIds.has(t.id));
    expect(fresh, 'a triage run task must appear').toBeDefined();
    return fresh;
  }, { timeout: 40_000, interval: 250 });
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  // Written BEFORE the server boots: the registry caches its discovery at boot.
  await fs.mkdir(path.join(WALNUT_HOME, 'actions'), { recursive: true });
  await fs.writeFile(
    path.join(WALNUT_HOME, 'actions', 'inbox-triage-batch.mjs'),
    `export { describe, run } from ${JSON.stringify(ACTION_SRC)}\n`,
    'utf-8',
  );

  daemon = await createMockDaemon();
  sessionRunner.setCliCommand(MOCK_CLI);
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`);
  server = await startServer({ port: 0, dev: true });
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;

  // An always-open window: the action declines outside active hours, and a test
  // whose result depends on the wall clock is not a test.
  const saved = await send('PUT', '/api/config', {
    triage: {
      enabled: true, every: '30m', every_messages: 20,
      sources: ['mail', 'slack'], mode: 'ask', active_hours: '',
    },
  });
  expect(saved.status, JSON.stringify(saved.json)).toBe(200);
  await vi.waitFor(async () => { expect(await triageRoutine()).toBeDefined(); }, { timeout: 20_000, interval: 100 });
}, 90_000);

afterAll(async () => {
  sessionRunner.setTestDaemonUrl(undefined);
  await stopServer();
  await daemon.stop();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {});
});

describe('Inbox Triage runs, end to end', () => {
  const seenTasks = new Set<string>();
  let firstTaskId: string;

  it('the action is the real one, installed where a src-run server can find it', async () => {
    const { getAction } = await import('../../src/actions/index.js');
    const action = await getAction('inbox-triage-batch');
    expect(action, 'without this the run would start a batch-less session').toBeDefined();
    expect(action!.name).toBe('Inbox Triage batch');
  });

  it('22 arrivals cross the threshold and start ONE run: a new task, a new session, unpinned', async () => {
    await announce([['work', 14], ['personal', 2]], 6);

    const buffered = await loadTriageState();
    expect(buffered.pending.mail.map((r) => r.accountId)).toEqual(['work', 'personal']);
    expect(buffered.pending.slack).toHaveLength(6);

    const task = await waitForNewRunTask(seenTasks);
    seenTasks.add(task.id);
    firstTaskId = task.id;

    expect(task.project).toBe(TRIAGE_PROJECT);
    expect(task.agent_id).toBe('triage');
    expect(task.walnut_agent).toBe(true);
    expect(task.cwd).toBe(WALNUT_HOME);
    // pinTier: null — background automation never adds a card to the pinned board.
    expect(task.pinned).toBeFalsy();
    // The title template with the clock and the batch size filled in: 16 mail
    // messages + 6 Slack items is exactly what the action's count hint carried.
    expect(task.title).toMatch(/^Triage · \d{2}:\d{2} · 22 items$/);

    const sessions = await vi.waitFor(async () => {
      const list = await getSessionsForTask(task.id);
      expect(list.length).toBeGreaterThan(0);
      return list;
    }, { timeout: 30_000, interval: 200 });
    expect(sessions[0].cwd).toBe(WALNUT_HOME);
  }, 120_000);

  it('the run was handed ONE envelope whose counts match the events', async () => {
    const job = await vi.waitFor(async () => {
      const found = await triageRoutine();
      expect(found?.state?.fireLog?.length ?? 0).toBeGreaterThan(0);
      return found;
    }, { timeout: 30_000, interval: 200 });

    const fire = job.state.fireLog[0];
    expect(fire.outcome).toBe('fired');
    expect(fire.items).toBe(22);
    const injected: string = fire.injected?.preview ?? '';
    // The preview is what the run DISPATCHED, which still carries the count hint
    // line (the executor strips it on the way into the session). Honest either way
    // — what matters is that the audit shows one envelope and its counts.
    expect(injected).toContain('WALNUT_TRIAGE_COUNT: 22');
    expect(injected).toContain('<walnut-message kind="trigger" from="Inbox Triage"');
    expect(injected).toContain('16 new mails in 2 accounts · 6 Slack items');
    expect(injected).toContain('Mail — 16 new messages across 2 accounts');
  }, 60_000);

  it('the buffer is cleared only once the run has a task (at-least-once)', async () => {
    const state = await vi.waitFor(async () => {
      const s = await loadTriageState();
      expect(s.runs).toBe(1);
      return s;
    }, { timeout: 30_000, interval: 200 });
    expect(state.claim).toBeUndefined();
    expect(state.pending.mail).toEqual([]);
    expect(state.pending.slack).toEqual([]);
    expect(state.lastRunAtMs).toBeGreaterThan(0);
  }, 60_000);

  it('a second batch makes a SECOND task and a SECOND session (never reuses the first)', async () => {
    await announce([['work', 20]], 4);

    const second = await waitForNewRunTask(seenTasks);
    seenTasks.add(second.id);
    expect(second.id).not.toBe(firstTaskId);
    expect(second.project).toBe(TRIAGE_PROJECT);
    expect(second.pinned).toBeFalsy();
    expect(second.title).toMatch(/^Triage · \d{2}:\d{2} · 24 items$/);

    // Each run has its OWN session; the second never landed in the first's.
    const seenSessions = new Set<string>();
    for (const id of seenTasks) {
      const list = await vi.waitFor(async () => {
        const records = await getSessionsForTask(id);
        expect(records.length).toBeGreaterThan(0);
        return records;
      }, { timeout: 30_000, interval: 200 });
      for (const record of list) {
        expect(record.taskId).toBe(id);
        expect(seenSessions.has(record.claudeSessionId)).toBe(false);
        seenSessions.add(record.claudeSessionId);
      }
    }
    expect(seenSessions.size).toBeGreaterThanOrEqual(2);
  }, 120_000);

  it('session:result marks that run\'s task COMPLETE and appends ONE journal line', async () => {
    bus.emit(EventNames.SESSION_RESULT, {
      sessionId: 'sess-triage-e2e-1',
      taskId: firstTaskId,
      result: 'Wrote one summary letter and updated two tracking notes.',
    }, ['web-ui']);

    await vi.waitFor(async () => {
      expect((await getTask(firstTaskId)).phase).toBe('COMPLETE');
    }, { timeout: 30_000, interval: 200 });

    const journal = await vi.waitFor(async () => {
      const text = await readJournal();
      expect(text).toContain(firstTaskId.slice(0, 8));
      return text;
    }, { timeout: 30_000, interval: 200 });

    expect(journal).toContain('kind: triage-runs');
    expect(journal).toContain('# Inbox Triage runs');
    const lines = journal.split('\n').filter((l) => l.includes(firstTaskId.slice(0, 8)));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^- \d{4}-\d{2}-\d{2} \d{2}:\d{2} run · /);
    expect(lines[0]).toContain('ended ok');

    // Carried forward, so the NEXT envelope can show what the last run did.
    await vi.waitFor(async () => {
      expect((await loadTriageState()).lastJournalLine).toBe(lines[0]);
    }, { timeout: 20_000, interval: 200 });

    // The verdict MERGED into the fire row that names this run's task — one row
    // per run, not one for the dispatch and another for the outcome. Two runs
    // fired inside a minute of each other here, which is exactly the case a
    // "newest row" heuristic would get wrong.
    const job = await vi.waitFor(async () => {
      const found = await triageRoutine();
      const row = (found?.state?.fireLog ?? [])
        .find((e: any) => (e.delivery?.summary ?? '').includes(firstTaskId));
      expect(row?.delivery?.summary, JSON.stringify(found?.state?.fireLog)).toContain('ended ok');
      return found;
    }, { timeout: 30_000, interval: 200 });
    const mine = job.state.fireLog.filter((e: any) => (e.delivery?.summary ?? '').includes(firstTaskId));
    expect(mine).toHaveLength(1);
    // The dispatch's own preview survived the merge.
    expect(mine[0].items).toBe(22);
    expect(mine[0].injected?.preview).toContain('<walnut-message kind="trigger"');
  }, 120_000);

  it('a later turn in the same run appends nothing (one line per run, not per turn)', async () => {
    // Counted per RUN, not over the whole note: the second run settles on its own
    // (the mock CLI really does answer), so the file legitimately grows.
    const linesFor = async () => (await readJournal()).split('\n')
      .filter((l) => l.includes(firstTaskId.slice(0, 8))).length;
    const before = await linesFor();
    expect(before).toBe(1);

    bus.emit(EventNames.SESSION_RESULT, {
      sessionId: 'sess-triage-e2e-1', taskId: firstTaskId,
      result: 'a later turn, after a letter was answered',
    }, ['web-ui']);
    // Nothing to wait FOR, so give the handler a window to have done nothing.
    await new Promise((r) => setTimeout(r, 2_000));
    expect(await linesFor()).toBe(before);
  }, 60_000);

  it('the run never rewrote State.md, so the check warns the NEXT envelope', async () => {
    // SOFT: a warn and a line in the next batch, never an automatic retry — the
    // run already sent its letters and edited its notes.
    await vi.waitFor(async () => {
      expect((await loadTriageState()).stateStale).toBe(true);
    }, { timeout: 30_000, interval: 200 });
  }, 60_000);
});
