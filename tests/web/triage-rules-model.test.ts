import { describe, expect, it } from 'vitest';
import { pickTasks, provenanceLine, routedLine, senderNeedle, shadowingRule, taskLine } from '../../web/src/components/settings/sections/triage-rules-model';

const at = new Date(2026, 10, 5, 9).getTime();

describe('routing rule lines in Settings', () => {
  it('says who added or changed it', () => {
    expect(provenanceLine({ author: { by: 'human' }, createdAt: at, updatedAt: at })).toBe('Added by you · Nov 5');
    // An older rule with no createdBy: its author added it.
    // Changed by the one who added it, the same day: nothing new to say.
    expect(provenanceLine({ author: { by: 'task', name: 'Walnut VP' }, createdAt: at, updatedAt: at + 60_000 })).toBe('Added by Walnut VP · Nov 5');
    expect(provenanceLine({ author: { by: 'human' }, createdAt: at, updatedAt: at + 86_400_000 })).toBe('Added by you · Nov 5 · changed by you Nov 6');
    expect(provenanceLine({ author: { by: 'human' }, createdBy: { by: 'task', name: 'Walnut VP' }, createdAt: at, updatedAt: at + 60_000 }))
      .toBe('Added by Walnut VP · Nov 5 · changed by you Nov 5');
    // The user toggled a VP's rule: the VP still reads as who added it.
    expect(provenanceLine({ author: { by: 'human' }, createdBy: { by: 'task', name: 'Walnut VP' }, createdAt: at, updatedAt: at + 86_400_000 }))
      .toBe('Added by Walnut VP · Nov 5 · changed by you Nov 6');
    expect(provenanceLine({ author: { by: 'task' }, createdAt: at, updatedAt: at })).toBe('Added by a Walnut task · Nov 5');
  });

  it('says what it routed last', () => {
    expect(routedLine({})).toBe('Nothing routed yet');
    expect(routedLine({ routedCount: 1, recent: [{ at, item: 'Your offer' }] })).toBe('Routed 1 item, last "Your offer" · Nov 5');
    expect(routedLine({ routedCount: 3, recent: [{ at, item: 'Weekly' }] })).toBe('Routed 3 items, last "Weekly" · Nov 5');
  });

  it('warns when the task is gone or complete', () => {
    expect(taskLine({ task: null, taskTitle: 'Old', taskId: 't' })).toEqual({ text: 'Old', warn: expect.stringMatching(/gone/) });
    expect(taskLine({ task: { id: 't', title: 'Done', phase: 'COMPLETE' }, taskId: 't' }).warn).toMatch(/complete/);
    expect(taskLine({ task: { id: 't', title: 'Live', phase: 'IN_PROGRESS' }, taskId: 't' })).toEqual({ text: 'Live' });
  });
});

describe('the task picker', () => {
  const tasks = [
    { id: 't-1', title: 'Offer review', project: 'Acme', phase: 'IN_PROGRESS' },
    { id: 't-2', title: 'Review the offer letter draft', project: 'Acme', phase: 'TODO' },
    { id: 't-3', title: 'Offer archive', project: 'Acme', phase: 'COMPLETE' },
    { id: 't-4', title: 'Gym plan', project: 'Health', phase: 'TODO' },
  ];
  it('finds open tasks by every word, title starts first, never a completed one', () => {
    expect(pickTasks(tasks, 'offer').map((t) => t.id)).toEqual(['t-1', 't-2']);
    expect(pickTasks(tasks, 'acme letter').map((t) => t.id)).toEqual(['t-2']);
    // An empty query offers the open tasks (the picker's list on focus), never a completed one.
    expect(pickTasks(tasks, '  ').every((t) => t.phase !== 'COMPLETE')).toBe(true);
    expect(pickTasks(tasks, '  ').length).toBeGreaterThan(0);
    expect(pickTasks(tasks, 'health').map((t) => t.id)).toEqual(['t-4']);
  });
});

describe('a rule another rule hides', () => {
  const r = (id: string, match: { from?: string; subject?: string }, enabled = true) => ({ id, match, enabled, matchText: id });
  it('names the earlier rule that matches everything this one would', () => {
    const rules = [r('a', { from: 'acme' }), r('b', { from: 'hr@acme.example' }), r('c', { from: 'acme', subject: 'offer' }), r('d', { subject: 'tax' })];
    expect(shadowingRule(rules, 0)).toBeNull();
    expect(shadowingRule(rules, 1)?.id).toBe('a');
    expect(shadowingRule(rules, 2)?.id).toBe('a');
    expect(shadowingRule(rules, 3)).toBeNull();
  });
  it('a turned-off rule hides nothing and is hidden by nothing', () => {
    expect(shadowingRule([r('a', { from: 'acme' }, false), r('b', { from: 'acme' })], 1)).toBeNull();
    expect(shadowingRule([r('a', { from: 'acme' }), r('b', { from: 'acme' }, false)], 1)).toBeNull();
  });
  it('a rule to finished or gone work hides nothing (Triage skips it)', () => {
    const done = { ...r('a', { from: 'acme' }), task: { id: 't', title: 'Old', phase: 'COMPLETE' } };
    const gone = { ...r('b', { from: 'acme' }), task: null };
    expect(shadowingRule([done, r('c', { from: 'acme' })], 1)).toBeNull();
    expect(shadowingRule([gone, r('c', { from: 'acme' })], 1)).toBeNull();
  });
  it('a pasted "Name <address>" keeps the address', () => {
    expect(senderNeedle('Contractor Bob <bob@kitchenpros.example>')).toBe('bob@kitchenpros.example');
    expect(senderNeedle(' acme.example ')).toBe('acme.example');
  });
});
