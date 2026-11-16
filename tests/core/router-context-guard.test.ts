import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertAreaDelivery } from '../../src/core/router/delivery-scope.js';
import { ROUTER_AREA_OPS, routerRequestAllowed } from '../../src/core/router/gateway-policy.js';
import { getOp } from '../../src/ops/index.js';
const root = path.resolve(import.meta.dirname, '../..');
const read = (name: string) => fs.readFileSync(path.join(root, name), 'utf8');
describe('router isolation guard', () => {
  it('a router session takes no other task\'s message, whatever message id it carries', () => {
    const router = { profile: { areaId: 'personal', areaRole: 'router' as const } };
    expect(() => assertAreaDelivery(router, 's1', 'peer', 'qm-route-forged')).toThrow();
    // A receiver profile an older build left on routed work is ordinary now: its messages land.
    expect(assertAreaDelivery({ profile: { areaId: 'personal', areaRole: 'work' as const } }, 's2', 'peer', 'qm-x')).toBe(false);
  });
  // Since 2026-11-16 a router finds an item's owner itself (the user: it can search, as his Slack
  // monitor does): Walnut's search and one task's details, both read-only.
  it('exposes no generic API, shell, write or outward-send op: its routing tools and read-only lookups only', () => {
    expect([...ROUTER_AREA_OPS].sort()).toEqual(['router_context', 'router_route', 'search', 'task_get']);
    for (const op of ['search', 'task_get']) expect(getOp(op)?.tags?.readonly, op).toBe(true);
    // The HTTP door holds a router session to the same ops: each allowed route is one of theirs.
    // Tasks only: memory and other sessions' transcripts (another router's) stay out of its reach.
    expect(routerRequestAllowed(ROUTER_AREA_OPS, 'GET', '/v1/search', { q: 'dock', types: 'task' })).toBe(true);
    for (const types of [undefined, 'task,session', 'memory', 'session']) {
      expect(routerRequestAllowed(ROUTER_AREA_OPS, 'GET', '/v1/search', { q: 'dock', ...(types ? { types } : {}) }), String(types)).toBe(false);
    }
    expect(routerRequestAllowed(ROUTER_AREA_OPS, 'GET', '/tasks/mvmp9g6y-27a2')).toBe(true);
    expect(routerRequestAllowed(ROUTER_AREA_OPS, 'GET', '/tasks/376e3979-5ed8-5153-a00c-16b084148d62')).toBe(true);
    // A sibling route under /tasks/ is no task id.
    for (const sibling of ['enriched', 'groups', 'bulk', 'board-counts', 'suggest-accuracy']) {
      expect(routerRequestAllowed(ROUTER_AREA_OPS, 'GET', `/tasks/${sibling}`), sibling).toBe(false);
    }
    for (const [method, path] of [['PATCH', '/tasks/abc1'], ['POST', '/v1/tasks'], ['GET', '/v1/tasks'], ['POST', '/v1/sessions/x/send'], ['GET', '/tasks/abc1/history']]) {
      expect(routerRequestAllowed(ROUTER_AREA_OPS, method!, path!), `${method} ${path}`).toBe(false);
    }
  });
  it('disables both automatic memory paths before launching an area CLI', () => {
    const source = read('src/providers/claude-code-session.ts');
    expect(source).toContain("CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1'");
    expect(source).toContain("CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1'");
    expect(source).toContain('const slimEnv = slim ? { ...readUserSettingsEnv() } : {}');
  });
  it('does not attach global instructions or Org hints to an area profile', () => {
    const hints = read('src/core/hints/hint-send.ts');
    expect(hints).toContain('record?.profile?.areaId');
    expect(hints).toContain('data.profile?.areaId');
    const queue = read('src/core/session-message-queue.ts');
    for (const producer of ['pendingPlaceNotice', 'pendingSwitchContext', 'pendingOrgDigest', 'pendingLiveStatusNote', 'pendingAppState', 'pendingRetiredLeadNote', 'pendingHeldNotices']) {
      expect(queue).toMatch(new RegExp(`scopedArea \\? null : (?:await )?${producer}\\(`));
    }
  });
  it('withholds a request notice\'s quote, tool calls, hand-off and title across an area', () => {
    const notify = read('src/core/sessions/session-request-notify.ts');
    const gate = notify.slice(notify.indexOf('async function gateRequest('), notify.indexOf('export async function notifyRequesterGroup('));
    expect(gate).toContain('const withheld = !await mayQuoteTarget(request);');
    const quote = notify.slice(notify.indexOf('async function mayQuoteTarget('), notify.indexOf('async function askerTaskIsComplete('));
    expect(quote).toContain('mayShareTaskContext(targetTaskId, asker?.taskId)');
    expect(quote).toMatch(/catch \{\s*return false;/);
    const deliver = notify.slice(notify.indexOf('async function deliverSettled('));
    expect(deliver).toContain('const handedOn = withheld ? undefined :');
    expect(deliver).toContain('const lastMessage = withheld ||');
    expect(deliver).toContain('if (request.toTaskId && !withheld) {');
    // Every notice path passes the gate's verdict on; none quotes without it.
    expect(notify.match(/await deliverSettled\(/g)).toHaveLength(1);
    expect(notify).toContain('outcome, context, withheld)) delivered = true;');
  });
  it('rides a watch\'s status line only to a watcher the area allows, before asking', () => {
    const watch = read('src/core/sessions/task-watch.ts');
    const guard = watch.indexOf('mayShareTaskContext(task.id, watcher.id)');
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(watch.indexOf('await askStatus('));
    expect(guard).toBeLessThan(watch.indexOf('rideLine(rec.claudeSessionId'));
    expect(watch.match(/rideLine\(/g)).toHaveLength(1);
  });
  it('never promotes a side thread of area work into an ordinary task', () => {
    const promote = read('src/core/sessions/side-thread-promote.ts');
    const body = promote.slice(promote.indexOf('export async function promoteSideThread('));
    const guard = body.indexOf('await sideThreadInArea(parentRecord?.profile?.areaId, threadRecord.profile?.areaId, siblingOfTaskId)');
    expect(guard).toBeGreaterThan(0);
    for (const write of ['createForkSiblingTask(siblingOfTaskId', 'await addTask(', 'markThreadPromoted(', 'updateSessionRecord(']) {
      expect(guard).toBeLessThan(body.indexOf(write));
    }
    const helper = promote.slice(promote.indexOf('async function sideThreadInArea('), promote.indexOf('export async function promoteSideThread('));
    expect(helper).toContain('return !await mayShareTaskContext(parentTaskId, undefined);');
    expect(helper).toMatch(/catch \{\s*return true;/);
  });
});
