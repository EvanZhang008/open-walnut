import { describe, expect, it } from 'vitest';
import { bindDecisionOwner, resolveDecisionOwner } from '../../src/core/decision-owner.js';
import type { Task } from '../../src/core/types.js';
import type { StatusReport } from '../../src/core/user-status.js';

const task = (id: string, over: Partial<Task> = {}): Task => ({ id, title: id, project: 'Juniper', parent_task_id: 'root',
  phase: 'NEED_ACTION', status: 'todo', user_status: { state: 'needs', source: 'session', ask: `Choose the release plan for ${id}?`, decision: { id: `ask-${id.repeat(4)}`, key: id } }, ...over } as Task);
const root = task('root', { parent_task_id: undefined });
const report = (same_as: string): StatusReport => ({ state: 'needs', ask: 'Confirm the already owned release decision?', same_as, at: '2026-11-15T00:00:00Z' });

describe('explicit decision roots', () => {
  it('binds the current decision, including normalized empty areas', () => {
    const a = task('a', { router_area_id: '' }); const b = task('b');
    expect(bindDecisionOwner(a, report('b'), [root, a, b])?.decision_owner).toMatchObject({ taskId: 'b', decisionId: 'ask-bbbb' });
  });
  it('rejects another team, another area, live prompts and missing pointer roots', () => {
    const a = task('a');
    for (const b of [task('b', { parent_task_id: undefined, project: 'Maple' }), task('b', { router_area_id: 'x' }),
      task('b', { user_status: { state: 'needs', source: 'prompt', ask: 'Allow Bash?' } }),
      task('b', { status_report: report('c') })]) expect(bindDecisionOwner(a, report('b'), [root, a, b])).toBeNull();
  });
  it('resolves a bound intermediate owner to its new root without reviving the dependent ask', () => {
    const a = task('a'); const b = task('b'); const c = task('c');
    const ref = { taskId: 'b', decisionId: 'ask-bbbb', askKey: 'old' };
    b.status_report = { ...report('c'), ask_id: 'ask-bbbb', decision_owner: { taskId: 'c', decisionId: 'ask-cccc', askKey: 'old' } };
    b.user_status = { state: 'waiting', sameAsk: { id: 'c', title: 'c', ask: c.user_status!.ask!, key: '', stamp: '', at: report('c').at } };
    expect(resolveDecisionOwner(a, 'b', [root, a, b, c], ref)?.id).toBe('c');
    expect(bindDecisionOwner(a, report('b'), [root, a, b, c])?.same_as).toBe('c');
    // A rapid write targeting a root that leads back to self is refused under the shared writer lock.
    expect(bindDecisionOwner(c, report('b'), [root, a, b, c])).toBeNull();
    b.status_report.ask_id = 'ask-new1';
    expect(resolveDecisionOwner(a, 'b', [root, a, b, c], ref)).toBeUndefined();
  });
  it('follows an ordinary fold and rejects a cycle or a changed binding', () => {
    const a = task('a'); const b = task('b'); const c = task('c');
    b.status_report = { ...report(''), same_as: undefined, ask_id: 'ask-bbbb' };
    b.user_status = { state: 'waiting', sameAsk: { id: 'c', title: 'c', ask: c.user_status!.ask!, key: '', stamp: '', at: report('c').at } };
    expect(resolveDecisionOwner(a, 'b', [root, a, b, c], { taskId: 'b', decisionId: 'ask-bbbb', askKey: '' })?.id).toBe('c');
    b.user_status.sameAsk!.answered = true;
    b.status_report.decision_owner = { taskId: 'c', decisionId: 'ask-cccc', askKey: '' };
    c.phase = 'COMPLETE'; c.status = 'done'; c.user_status = { state: 'done' };
    expect(resolveDecisionOwner(a, 'b', [root, a, b, c], { taskId: 'b', decisionId: 'ask-bbbb', askKey: '' })).toMatchObject({ id: 'c', answered: true });
    b.user_status.sameAsk!.answered = undefined;
    c.phase = 'NEED_ACTION'; c.status = 'todo'; c.status_report = report('b');
    expect(bindDecisionOwner(a, report('b'), [root, a, b, c])).toBeNull();
  });
});
