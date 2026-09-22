/**
 * Inbox Triage's letters through the real server (S15).
 *
 * What only this layer can prove: the budget is enforced by the SERVER, on the
 * route the op actually calls. `human_inbox_send` is declared in src/ops and
 * executed by src/ops/executor.ts as `POST /api/v1/human-inbox` from the caller's
 * own process, so the refusal has to happen here or it does not happen at all.
 * Every request below carries `x-walnut-caller-sid`, which is exactly what the ops
 * executor sends.
 *
 * It also proves the round trip: answering a decision letter wakes THAT run's
 * session with a cold `--resume` (asserted on the mock daemon's own `start`
 * command, the only place the resume is real), and the whole effect of the answer
 * is one message queued into the run — no mail leaves the box, no letter is minted
 * on the user's behalf.
 *
 * The CLI is the mock (tests/providers/mock-claude.mjs) and the daemon is the mock
 * daemon, so no model is called and nothing reaches the network.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Server as HttpServer } from 'node:http';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('triage-letters-e2e'));

import { WALNUT_HOME } from '../../src/constants.js';
import { sessionRunner } from '../../src/providers/claude-code-session.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js';
import { addTask } from '../../src/core/task-manager.js';
import { createSessionRecord } from '../../src/core/session-tracker.js';
import { TRIAGE_PROJECT } from '../../src/core/triage/bootstrap.js';
import {
  TRIAGE_SUPERSEDED_NOTE,
  withdrawSupersededTriageLetters,
} from '../../src/core/human-inbox/triage-quota.js';

const MOCK_CLI = path.resolve(import.meta.dirname, '../providers/mock-claude.mjs');
const SESSION_CWD = '/tmp';

let server: HttpServer;
let port: number;
let daemon: MockDaemon;

/** run 1 is STOPPED (the idle reaper got it); run 2 is idle and live. */
const RUN_ONE_SID = 'triage-run-one-session';
const RUN_TWO_SID = 'triage-run-two-session';
const DEV_SID = 'ordinary-dev-session';
let runOneTaskId = '';
let runTwoTaskId = '';
let devTaskId = '';

function apiUrl(p: string): string {
  return `http://localhost:${port}${p}`;
}

async function post(p: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(apiUrl(p), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) as any };
}

async function get(p: string) {
  const res = await fetch(apiUrl(p));
  return { status: res.status, json: await res.json().catch(() => null) as any };
}

/** Send a letter exactly the way the ops executor does. */
async function sendLetterAs(sid: string, body: Record<string, unknown>) {
  return await post('/api/v1/human-inbox', body, { 'x-walnut-caller-sid': sid });
}

function summaryBody(subject = 'Triage · 14:10 · 16 items'): Record<string, unknown> {
  return {
    subject,
    type: 'review',
    markdown: 'Sixteen items. Four touch work you already have; the rest were noise.',
    task_refs: [] as string[],
  };
}

function decisionBody(subject: string): Record<string, unknown> {
  return {
    subject,
    type: 'action_required',
    markdown: 'One line on the item, one on why it needs you.',
    actions: [
      { id: 'make-task', label: 'Make a task' },
      { id: 'reply-for-me', label: 'Reply for me' },
      { id: 'ignore', label: 'Ignore' },
    ],
  };
}

/** A triage run: a task stamped with the agent, filed under the agent's project. */
async function createRunTask(title: string): Promise<string> {
  const { task } = await addTask({
    title, project: TRIAGE_PROJECT, walnut_agent: true, agent_id: 'triage', source: 'local',
  });
  return task.id;
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {});
  daemon = await createMockDaemon();
  sessionRunner.setCliCommand(MOCK_CLI);
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`);
  server = await startServer({ port: 0, dev: true });
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;

  runOneTaskId = await createRunTask('Triage · 14:10 · 16 items');
  runTwoTaskId = await createRunTask('Triage · 14:40 · 7 items');
  const dev = await addTask({ title: 'Refactor the importer', project: 'Dev work', source: 'local' });
  devTaskId = dev.task.id;

  await createSessionRecord(RUN_ONE_SID, runOneTaskId, TRIAGE_PROJECT, SESSION_CWD, {
    host: '__local__',
    title: 'Triage · 14:10',
    initialProcessStatus: 'stopped',
    initialStatusReason: 'expected_teardown',
  });
  await createSessionRecord(RUN_TWO_SID, runTwoTaskId, TRIAGE_PROJECT, SESSION_CWD, {
    host: '__local__', title: 'Triage · 14:40', initialProcessStatus: 'idle',
  });
  await createSessionRecord(DEV_SID, devTaskId, 'Dev work', SESSION_CWD, {
    host: '__local__', title: 'Refactor', initialProcessStatus: 'idle',
  });
}, 60_000);

afterAll(async () => {
  sessionRunner.setTestDaemonUrl(undefined);
  await stopServer();
  await daemon.stop();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {});
});

/** Letter ids run one sent, so the answer/withdraw cases can reach them. */
const runOneDecisions: string[] = [];

/**
 * Every letter-answer text that reached a daemon, by either route. A cold
 * `--resume` can carry the message on the spawn (`start.message`) or defer it to a
 * `send` once the CLI is up; scanning only one of the two makes the assertion a
 * coin flip (the same trap tests/e2e/trigger-routines.test.ts documents).
 */
function letterReplyTexts(): string[] {
  return [...daemon.getCommandHistoryFor('send'), ...daemon.getCommandHistoryFor('start')]
    .filter((c) => c.payload.deferMessage !== true)
    .map((c) => String(c.payload.text ?? c.payload.message ?? ''))
    .filter((t) => t.includes('[Letter reply]'));
}

async function waitForLetterReplyText(timeoutMs = 20_000): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  let found = letterReplyTexts();
  while (found.length === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    found = letterReplyTexts();
  }
  return found;
}

describe('one run: one summary and three decisions', () => {
  it('accepts the summary and three decisions, then refuses the fourth', async () => {
    const summary = await sendLetterAs(RUN_ONE_SID, summaryBody());
    expect(summary.status).toBe(201);
    expect(summary.json.id).toMatch(/^lt-/);

    for (const subject of [
      'Who owns the migration window?',
      'Unsubscribe from the weekly digest?',
      'File the RFC thread under the platform project?',
    ]) {
      const one = await sendLetterAs(RUN_ONE_SID, decisionBody(subject));
      expect(one.status, subject).toBe(201);
      runOneDecisions.push(one.json.id);
    }
    expect(runOneDecisions).toHaveLength(3);

    // The 4th of 7 decision-worthy items: refused by the SERVER, with the move.
    const fourth = await sendLetterAs(RUN_ONE_SID, decisionBody('And four more like it'));
    expect(fourth.status).toBe(400);
    const message = String(fourth.json?.error?.message ?? '');
    expect(message).toContain('at most 3 decision letters');
    expect(message).toContain('fold the rest into the summary letter');
    expect(message).toContain(summary.json.id);
    expect(fourth.json?.error?.code).toBe('bad_request');

    // A second summary is refused too, pointing at the one that exists.
    const second = await sendLetterAs(RUN_ONE_SID, summaryBody('Triage · 14:10 · more'));
    expect(second.status).toBe(400);
    expect(String(second.json?.error?.message)).toContain('ONE summary letter per run');

    // The inbox holds exactly the four that were accepted.
    const inbox = await get('/api/v1/human-inbox');
    const mine = inbox.json.letters.filter((l: any) => l.sender?.sessionId === RUN_ONE_SID);
    expect(mine).toHaveLength(4);
    expect(mine.filter((l: any) => l.type === 'action_required')).toHaveLength(3);
  });

  it('refuses an action_required letter with no buttons, naming what to use', async () => {
    const r = await sendLetterAs(RUN_TWO_SID, {
      subject: 'Something needs you', type: 'action_required', markdown: 'But no buttons.',
    });
    expect(r.status).toBe(400);
    const message = String(r.json?.error?.message ?? '');
    expect(message).toContain('needs at least one button in `actions`');
    expect(message).toContain('Make a task');
    // And it did not consume run two's decision budget.
    for (const subject of ['a', 'b', 'c']) {
      expect((await sendLetterAs(RUN_TWO_SID, decisionBody(`Run two: ${subject}`))).status).toBe(201);
    }
  });

  it('the next run has its own budget', async () => {
    // Run one is walled; run two just spent three decisions and can still summarise.
    expect((await sendLetterAs(RUN_ONE_SID, decisionBody('still walled'))).status).toBe(400);
    expect((await sendLetterAs(RUN_TWO_SID, summaryBody('Triage · 14:40 · 7 items'))).status).toBe(201);
    expect((await sendLetterAs(RUN_TWO_SID, decisionBody('run two, fourth'))).status).toBe(400);
  });

  it('no other agent is budgeted: an ordinary session sends as many as it likes', async () => {
    for (let i = 0; i < 6; i++) {
      const r = await sendLetterAs(DEV_SID, decisionBody(`Dev decision ${i}`));
      expect(r.status, `dev letter ${i}`).toBe(201);
    }
    // A caller with no session at all (curl, a hand-started agent) is unaffected.
    const anonymous = await post('/api/v1/human-inbox', decisionBody('From nowhere in particular'));
    expect(anonymous.status).toBe(201);
  });
});

describe('the human answers a decision', () => {
  it('cold-resumes THAT run and queues the choice, sending nothing outward', async () => {
    daemon.clearCommandHistory();
    const before = (await get('/api/v1/human-inbox')).json.letters.length;
    const letterId = runOneDecisions[0];

    const answered = await post(`/api/v1/human-inbox/${letterId}/answer`, { actionId: 'reply-for-me' });
    expect(answered.status).toBe(200);
    expect(answered.json.delivery).toMatchObject({ status: 'queued', sessionId: RUN_ONE_SID });
    expect(answered.json.letter.answered).toMatchObject({
      actionId: 'reply-for-me', label: 'Reply for me',
    });

    // The run's session was STOPPED; the answer must resume it, not replace it.
    const deadline = Date.now() + 20_000;
    let resumed: Record<string, unknown> | undefined;
    while (!resumed && Date.now() < deadline) {
      resumed = daemon.getCommandHistoryFor('start')
        .map((c) => c.payload)
        .find((p) => p.sid === RUN_ONE_SID && p.resume === true);
      if (!resumed) await new Promise((r) => setTimeout(r, 50));
    }
    expect(resumed, 'the stopped triage run must be resumed, not replaced').toBeTruthy();

    // The text the run reads is a REPORT of the human's choice, not an action.
    // Polled, because a cold resume may carry the message on the spawn itself or
    // defer it to a `send` once the CLI is up — which one is timing, not intent.
    const carriers = await waitForLetterReplyText();
    expect(carriers.length).toBeGreaterThan(0);
    expect(carriers[0]).toContain(`letter: ${letterId}`);
    expect(carriers[0]).toContain('choice: Reply for me');
    expect(carriers[0]).toContain('human_inbox_reply');

    // Nothing was sent on the user's behalf: no new letter, no approval minted,
    // and the run still has to go through mail_request_send / slack_request_post.
    await new Promise((r) => setTimeout(r, 300));
    const after = (await get('/api/v1/human-inbox')).json.letters;
    expect(after.length).toBe(before);
    const sends = after.filter((l: any) => /approve|send this/i.test(String(l.subject)));
    expect(sends).toEqual([]);

    // The session is STILL the only one on that task — no new session was minted.
    const { getSessionsForTask } = await import('../../src/core/session-tracker.js');
    const sessions = await getSessionsForTask(runOneTaskId);
    expect(sessions.map((s) => s.claudeSessionId)).toEqual([RUN_ONE_SID]);
  });
});

describe('a decision a later run took over is withdrawn', () => {
  it('retires run one\'s remaining decisions and keeps run two\'s', async () => {
    const result = await withdrawSupersededTriageLetters({ keepSessionId: RUN_TWO_SID });

    // Run one's two UNANSWERED decisions go; the one the human answered stays.
    expect(result.withdrawn.sort()).toEqual(runOneDecisions.slice(1).sort());
    expect(result.failed).toBe(0);
    expect(result.kept).toBeGreaterThanOrEqual(3);

    const letters = (await get('/api/v1/human-inbox')).json.letters as any[];
    const byId = new Map(letters.map((l) => [l.id, l]));
    for (const id of result.withdrawn) {
      expect(byId.get(id)?.answered?.actionId).toBe('withdrawn');
      expect(byId.get(id)?.answered?.freeText).toBe(TRIAGE_SUPERSEDED_NOTE);
    }
    // Run two's decisions are untouched, and so is the ordinary session's.
    for (const letter of letters) {
      if (letter.sender?.sessionId === RUN_TWO_SID || letter.sender?.sessionId === DEV_SID) {
        expect(letter.answered, letter.subject).toBeUndefined();
      }
    }
    // The human's own answer was not overwritten by the sweep.
    expect(byId.get(runOneDecisions[0])?.answered?.actionId).toBe('reply-for-me');
  });
});
