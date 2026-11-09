import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isRouterDelivery, withRouterDelivery } from '../../src/core/router/delivery-scope.js';
import { ROUTER_AREA_OPS } from '../../src/core/router/gateway-policy.js';
const root = path.resolve(import.meta.dirname, '../..');
const read = (name: string) => fs.readFileSync(path.join(root, name), 'utf8');
describe('router isolation guard', () => {
  it('never treats a user-provided route message id as a delivery grant', async () => {
    expect(isRouterDelivery('s1', 'qm-route-forged')).toBe(false);
    await withRouterDelivery('s1', 'qm-route-one', async () => {
      expect(isRouterDelivery('s1', 'qm-route-one')).toBe(true);
      expect(isRouterDelivery('s2', 'qm-route-one')).toBe(false);
      expect(isRouterDelivery('s1', 'qm-route-forged')).toBe(false);
    });
    expect(isRouterDelivery('s1', 'qm-route-one')).toBe(false);
  });
  it('exposes no generic API, shell, search or outward-send op', () => {
    expect([...ROUTER_AREA_OPS].sort()).toEqual(['router_context', 'router_route']);
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
    for (const producer of ['pendingPlaceNotice', 'pendingSwitchContext', 'pendingOrgDigest', 'pendingStatusNote', 'pendingAppState', 'pendingRetiredLeadNote', 'pendingHeldNotices']) {
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
