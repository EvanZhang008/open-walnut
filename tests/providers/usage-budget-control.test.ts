import { describe, expect, it } from 'vitest';
import { createBudgetControl } from '../../src/providers/usage-budget-control.js';

describe('budget control confirmation', () => {
  it('waits for the right session and request to acknowledge a background stop', async () => {
    let sent: Record<string, unknown> | undefined;
    const control = createBudgetControl({ writeRaw: async (_sid, line) => { sent = JSON.parse(line); return true; } });
    const answer = control.ask('example-session', { subtype: 'stop_task', task_id: 'registered-command' });
    await Promise.resolve();
    const id = sent!.request_id;
    control.noteResponse('another-session', { type: 'control_response', response: { subtype: 'success', request_id: id } });
    expect(sent!.request).toEqual({ subtype: 'stop_task', task_id: 'registered-command' });
    control.noteResponse('example-session', { type: 'control_response', response: { subtype: 'success', request_id: id } });
    expect(await answer).toBe(true);
    control.close();
  });
  it('never reports an unanswered or rejected control as stopped', async () => {
    const failed = createBudgetControl({ writeRaw: async () => false });
    expect(await failed.ask('example-session', { subtype: 'interrupt' })).toBe(false);
    const timeout = createBudgetControl({ writeRaw: async () => true, timeoutMs: 5 });
    expect(await timeout.ask('example-session', { subtype: 'stop_task', task_id: 'registered-command' })).toBe(false);
    timeout.close();
    failed.close();
  });
});
