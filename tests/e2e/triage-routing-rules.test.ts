/**
 * Inbox Triage routing rules against a real server (2026-11-05: a routing the user asked for in one
 * triage run's chat was gone by the next run, since every run is a new task that completes).
 *
 * Pins: who may write a rule (a person, Main, a VP; never another task or a test run), that the
 * ops reach the routes end to end, that a rule rides the next batch, and that `triage_route` hands
 * an item to the rule's task with the rule named on the message and records it on the rule.
 * The session message queue is the only mock (its real path would spawn a CLI).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import type { Server } from 'node:http';
import { createMockConstants } from '../helpers/mock-constants.js';
vi.mock('../../src/constants.js', () => createMockConstants('triage-routing-rules-e2e', { IS_EPHEMERAL: true }));

const { deliveries, starts } = vi.hoisted(() => ({
  deliveries: [] as Array<{ sessionId: string; message: string }>,
  starts: [] as Array<Record<string, unknown>>,
}));
// A task that never ran is started with the routed item as its first message (no real CLI here).
vi.mock('../../src/core/sessions/task-start.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/sessions/task-start.js')>();
  return {
    ...actual,
    startSessionForTask: async (params: Record<string, unknown>) => {
      starts.push(params);
      return { taskId: String(params.taskIdPrefix), title: 'started' };
    },
  };
});
vi.mock('../../src/core/session-message-queue.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/session-message-queue.js')>();
  return {
    ...actual,
    sendMessageToSession: async (sessionId: string, message: string) => {
      deliveries.push({ sessionId, message });
      return { id: `qm-test-${deliveries.length}` };
    },
  };
});

import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { addTask, updateTaskRaw } from '../../src/core/task-manager.js';
import { createSessionRecord } from '../../src/core/session-tracker.js';
import { executeOp } from '../../src/ops/index.js';
import { buildTriageBatch } from '../../src/core/triage/batch.js';
import type { TriagePendingSlack } from '../../src/core/triage/state.js';

/** One Slack message as the collector buffers it (the batch carries Slack only since 2026-11-14). */
function slackItem(alias: string, text: string, ts: string): TriagePendingSlack {
  return { conversation: '#offers', isDm: false, isMention: false, alias, ts, permalink: '', text, atMs: 1 };
}
import { readRoutingRules, routingRulesPath } from '../../src/core/triage/routing-rules.js';

let server: Server;
let root: string;
const VP_SID = 'rr-vp-session';
const MAIN_SID = 'rr-main-session';
const WORKER_SID = 'rr-worker-session';
const RUN_SID = 'rr-triage-run-session';
const OWNER_SID = 'rr-owner-session';
let ownerId = '';
let doneId = '';

const op = async (name: string, args: Record<string, unknown>, sid?: string) =>
  executeOp(name, args, { apiBase: root, origin: '__local__', callerMode: sid ? 'session' : 'human', ...(sid ? { callerSid: sid } : {}) });
const ok = async (name: string, args: Record<string, unknown>, sid?: string) => {
  const out = await op(name, args, sid);
  if (!out.ok) throw new Error(out.message);
  return out.result as Record<string, any>;
};
const http = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(`${root}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });

beforeAll(async () => {
  // Decided at boot (middleware/test-run.ts): this server reads a test-run label as a real one would.
  process.env.WALNUT_TEST_RUN_MARK = '1';
  server = await startServer({ port: 0, dev: true });
  root = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const vp = (await addTask({ title: 'Acme VP', project: 'Acme', source: 'local', org_role: 'lead' } as never)).task;
  await createSessionRecord(VP_SID, vp.id, 'Acme');
  const main = (await addTask({ title: 'Main', project: '', source: 'local', org_role: 'main' } as never)).task;
  await createSessionRecord(MAIN_SID, main.id, '');
  const worker = (await addTask({ title: 'A worker', project: 'Acme', source: 'local', parent_task_id: vp.id } as never)).task;
  await createSessionRecord(WORKER_SID, worker.id, 'Acme');
  const run = (await addTask({ title: 'Triage · 09:00 · 2 items', project: 'Ask Inbox Triage', source: 'local', agent_id: 'triage' } as never)).task;
  await createSessionRecord(RUN_SID, run.id, 'Ask Inbox Triage');
  const owner = (await addTask({ title: 'Offer review', project: 'Acme', source: 'local' } as never)).task;
  ownerId = owner.id;
  await createSessionRecord(OWNER_SID, owner.id, 'Acme');
  doneId = (await addTask({ title: 'Old work', project: 'Acme', source: 'local' } as never)).task.id;
  await updateTaskRaw(doneId, { phase: 'COMPLETE' } as never);
});
afterAll(async () => { delete process.env.WALNUT_TEST_RUN_MARK; await stopServer(); await fs.rm(WALNUT_HOME, { recursive: true, force: true }); });

describe('who writes routing rules', () => {
  it('a person adds one through the route, and it lists with its task and author', async () => {
    const res = await http('POST', '/triage/routing-rules', { from: 'acme.example', task_id: ownerId, note: 'Offer mail' });
    expect(res.status, await res.clone().text()).toBe(201);
    const { rule } = await res.json() as { rule: Record<string, any> };
    expect(rule).toMatchObject({ match: { from: 'acme.example' }, taskId: ownerId, taskTitle: 'Offer review', enabled: true, author: { by: 'human' } });
    const list = await ok('triage_rule_list', {});
    expect(list.rules.map((r: { id: string }) => r.id)).toContain(rule.id);
    expect(list.rules.find((r: { id: string }) => r.id === rule.id).task).toMatchObject({ id: ownerId, title: 'Offer review' });
  });

  it('a VP and Main write rules through the op, recorded as theirs', async () => {
    const byVp = await ok('triage_rule_set', { subject: 'offer letter', task_id: ownerId }, VP_SID);
    expect(byVp.rule.author).toMatchObject({ by: 'task', name: 'Acme VP' });
    expect(byVp.outcome).toMatch(/Added routing rule rr-/);
    const changed = await ok('triage_rule_set', { rule_id: byVp.rule.id, from: 'hr@acme.example' }, MAIN_SID);
    expect(changed.rule).toMatchObject({ id: byVp.rule.id, match: { from: 'hr@acme.example', subject: 'offer letter' }, author: { by: 'task', name: 'Main' }, createdBy: { by: 'task', name: 'Acme VP' } });
    const gone = await ok('triage_rule_delete', { rule_id: byVp.rule.id }, MAIN_SID);
    expect(gone.deleted).toBe(true);
  });

  it('any other task, a triage run included, is refused and told who can', async () => {
    for (const sid of [WORKER_SID, RUN_SID]) {
      const out = await op('triage_rule_set', { from: 'x@y.example', task_id: ownerId }, sid);
      expect(out.ok).toBe(false);
      expect(out.message).toMatch(/user, Main or a VP/);
      // A triage run hears the user's ask there: it is told to pass the words to Main.
      if (sid === RUN_SID) expect(out.message).toMatch(/org_send/);
    }
  });

  it('the same match to the same task twice is refused, naming the rule that has it', async () => {
    const res = await http('POST', '/triage/routing-rules', { from: 'ACME.example', task_id: ownerId });
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/duplicate_rule[\s\S]*already sends these items/);
  });

  it('a rule needs something to match and a real task', async () => {
    expect((await http('POST', '/triage/routing-rules', { task_id: ownerId })).status).toBe(400);
    const unknown = await http('POST', '/triage/routing-rules', { from: 'a', task_id: 'no-such-task' });
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as { error?: { code?: string } }).error?.code ?? '').toMatch(/unknown_task/);
  });

  it('a test run writes no rule', async () => {
    const res = await http('POST', '/triage/routing-rules', { from: 'a', task_id: ownerId }, { 'x-walnut-test-run': 'pw-1' });
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/test run writes no routing rules/);
    expect((await readRoutingRules(WALNUT_HOME)).some((r) => r.match.from === 'a')).toBe(false);
    const rule = (await readRoutingRules(WALNUT_HOME))[0]!;
    const route = await http('POST', `/triage/routing-rules/${rule.id}/route`, { item: 'x', text: 'y' }, { 'x-walnut-test-run': 'pw-1' });
    expect(route.status).toBe(409);
  });
});

describe('every batch reads the rules, and an item goes to its task named by its rule', () => {
  it('the batch lists the rule and the items it already matches', async () => {
    const rules = await readRoutingRules(WALNUT_HOME);
    const batch = buildTriageBatch({
      slack: [slackItem('hr@acme.example', 'Your offer', '1'), slackItem('news@other.example', 'Weekly', '2')],
      droppedSlack: 0, sinceMs: 0, nowMs: 1, rules,
    });
    const rule = rules.find((r) => r.match.from === 'acme.example')!;
    expect(batch.body).toContain(`${rule.id}: sender contains "acme.example" → task ${ownerId} ("Offer review")`);
    expect(batch.body).toMatch(new RegExp(`from "hr@acme.example" → ${rule.id}`));
    expect(batch.body).not.toMatch(/other\.example" →/);
    expect(batch.body).toContain('triage_route');
  });

  it('triage_route sends the item to the rule\'s task with the rule named, and records it', async () => {
    const rule = (await readRoutingRules(WALNUT_HOME)).find((r) => r.match.from === 'acme.example')!;
    deliveries.length = 0;
    const out = await ok('triage_route', { rule_id: rule.id, item: 'Your offer', text: 'HR sent the offer letter (#offers, 1); it asks for a signature by Friday.', source: 'slack' }, RUN_SID);
    expect(out.delivered).toBeTruthy();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.sessionId).toBe(OWNER_SID);
    expect(deliveries[0]!.message).toContain(`routing rule ${rule.id} (sender contains "acme.example")`);
    expect(deliveries[0]!.message).toContain('Item: Your offer');
    const after = (await readRoutingRules(WALNUT_HOME)).find((r) => r.id === rule.id)!;
    expect(after.routedCount).toBe(1);
    expect(after.recent?.[0]).toMatchObject({ item: 'Your offer', source: 'slack' });
  });

  it('a rule\'s task that never ran is started with the item as its first message, on its own place', async () => {
    const fresh = (await addTask({ title: 'Placeholder for kitchen mail', project: 'Home', source: 'local' } as never)).task;
    const rule = await ok('triage_rule_set', { from: 'kitchenpros.example', task_id: fresh.id });
    starts.length = 0;
    const out = await ok('triage_route', { rule_id: rule.rule.id, item: 'Quote ready', text: 'Bob sent the quote (#kitchen, 9).', source: 'slack' }, RUN_SID);
    expect(out.started).toBeTruthy();
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({ taskIdPrefix: fresh.id, source: 'api-agent' });
    expect(starts[0]!.callerSid).toBeUndefined();
    expect(String(starts[0]!.message)).toContain(`routing rule ${rule.rule.id}`);
    expect(out.rule.routedCount).toBe(1);
  });

  it('only a triage run, the user, Main or a VP may route: a worker cannot forge the routed line', async () => {
    const rule = (await readRoutingRules(WALNUT_HOME)).find((r) => r.match.from === 'acme.example')!;
    deliveries.length = 0;
    const out = await op('triage_route', { rule_id: rule.id, item: 'x', text: 'y' }, WORKER_SID);
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/task_send/);
    expect(deliveries).toHaveLength(0);
  });

  it('a turned-off rule routes nothing; a rule to a completed task says so', async () => {
    const off = await ok('triage_rule_set', { from: 'paused.example', task_id: ownerId, enabled: false });
    const refused = await op('triage_route', { rule_id: off.rule.id, item: 'x', text: 'y' }, RUN_SID);
    expect(refused.ok).toBe(false);
    expect(refused.message).toMatch(/turned off/);
    // A new rule to completed work is refused; a rule whose task completes later refuses the route.
    const toDone = await op('triage_rule_set', { from: 'old.example', task_id: doneId });
    expect(toDone.message).toMatch(/is complete/);
    expect(toDone.ok).toBe(false);
    const later = (await addTask({ title: 'Finishes soon', project: 'Acme', source: 'local' } as never)).task;
    const rule = await ok('triage_rule_set', { from: 'soon.example', task_id: later.id });
    await updateTaskRaw(later.id, { phase: 'COMPLETE' } as never);
    const res = await op('triage_route', { rule_id: rule.rule.id, item: 'x', text: 'y' }, RUN_SID);
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/complete/);
    // Its note stays editable, even when the writer resends the same task_id.
    const noted = await ok('triage_rule_set', { rule_id: rule.rule.id, note: 'kept for the record', task_id: later.id }, MAIN_SID);
    expect(noted.rule.note).toBe('kept for the record');
  });

  it('a rule whose task completed sits out of the batch, so a later rule to open work wins', async () => {
    const { liveRules } = await import('../../src/actions/inbox-triage-batch.js');
    const soon = (await addTask({ title: 'Closes soon', project: 'Acme', source: 'local' } as never)).task;
    const first = await ok('triage_rule_set', { from: 'dead-first.example', task_id: soon.id, position: 0 });
    const second = await ok('triage_rule_set', { from: 'dead-first.example', task_id: ownerId });
    await updateTaskRaw(soon.id, { phase: 'COMPLETE' } as never);
    const live = await liveRules(await readRoutingRules(WALNUT_HOME));
    expect(live.some((r) => r.id === first.rule.id)).toBe(false);
    const batch = buildTriageBatch({
      slack: [slackItem('x@dead-first.example', 'Hello', '3')],
      droppedSlack: 0, sinceMs: 0, nowMs: 1, rules: live,
    });
    expect(batch.body).toMatch(new RegExp(`from "x@dead-first.example" → ${second.rule.id}`));
  });

  it('a rule moves to a place in the list (the first matching rule wins)', async () => {
    const a = await ok('triage_rule_set', { from: 'order-a.example', task_id: ownerId });
    const b = await ok('triage_rule_set', { from: 'order-b.example', task_id: ownerId, position: 0 });
    expect((await readRoutingRules(WALNUT_HOME))[0]!.id).toBe(b.rule.id);
    await ok('triage_rule_set', { rule_id: a.rule.id, position: 0 });
    const ids = (await readRoutingRules(WALNUT_HOME)).map((r) => r.id);
    expect(ids.indexOf(a.rule.id)).toBe(0);
    expect(ids.indexOf(b.rule.id)).toBe(1);
    // `before` is resolved on the server against the list as it is now.
    await ok('triage_rule_set', { rule_id: b.rule.id, before: a.rule.id });
    const again = (await readRoutingRules(WALNUT_HOME)).map((r) => r.id);
    expect(again.indexOf(b.rule.id)).toBe(again.indexOf(a.rule.id) - 1);
    // A string `enabled` is refused, not ignored; an unknown rule is 404 before any task check.
    expect((await http('POST', '/triage/routing-rules', { from: 'x.example', task_id: ownerId, enabled: 'false' })).status).toBe(400);
    expect((await http('PATCH', '/triage/routing-rules/rr-none', { task_id: doneId })).status).toBe(404);
  });
});

describe('a rules file that cannot be read', () => {
  it('the routes and ops answer 503 rules_unreadable, never an empty list, and a write changes nothing', async () => {
    const file = routingRulesPath(WALNUT_HOME);
    const before = await fs.readFile(file, 'utf-8');
    await fs.writeFile(file, JSON.stringify({ version: 1, rules: 'not a list' }), 'utf-8');
    try {
      const list = await http('GET', '/triage/routing-rules');
      expect(list.status).toBe(503);
      expect(JSON.stringify(await list.json())).toContain('rules_unreadable');
      expect((await http('POST', '/triage/routing-rules', { from: 'more.example', task_id: ownerId })).status).toBe(503);
      expect((await op('triage_rule_list', {})).ok).toBe(false);
      expect(await fs.readFile(file, 'utf-8')).toBe(JSON.stringify({ version: 1, rules: 'not a list' }));
    } finally {
      await fs.writeFile(file, before, 'utf-8');
    }
    expect((await http('GET', '/triage/routing-rules')).status).toBe(200);
  });
});
