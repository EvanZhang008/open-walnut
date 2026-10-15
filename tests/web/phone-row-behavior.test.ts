import { describe, expect, it } from 'vitest';
import { phoneOpenKeepsList, phonePhaseAttrs, phoneRowFocusOpts, phoneTitleTapOpens } from '../../web/src/components/tasks/phone-row-behavior';
import { pullDistance, PULL_TRIGGER_PX } from '../../web/src/components/tasks/PhonePullToRefresh';
import { groupSearchHits, isEmptyGroups } from '../../web/src/components/tasks/PhoneSearchLayer';
import { sessionIsAlive } from '../../web/src/components/tasks/PhonePhaseSheet';
import { noteTitleOf } from '../../web/src/components/notes/usePhoneNoteLayer';
import { bellAriaLabel } from '../../web/src/components/layout/PhoneNotificationBell';

describe('phone row behavior', () => {
  it('takes the phase circle out of the focus order and the a11y tree on a phone only', () => {
    expect(phonePhaseAttrs(true)).toEqual({ 'aria-hidden': true, tabIndex: -1 });
    expect(phonePhaseAttrs(false)).toEqual({});
  });

  it('a phone row tap keeps the list in place; Locate, a new task and a quick-add still move it (N2-01)', () => {
    expect(phoneOpenKeepsList(undefined, true)).toBe(true);
    expect(phoneOpenKeepsList('all', true)).toBe(true);
    expect(phoneOpenKeepsList('locate', true)).toBe(false);
    expect(phoneOpenKeepsList('created', true)).toBe(false);
    expect(phoneOpenKeepsList('pinned', true)).toBe(false);
    expect(phoneOpenKeepsList('all', false)).toBe(false);
    expect(phoneOpenKeepsList(undefined, false)).toBe(false);
  });

  it('opens task detail from a row only on a phone, and only without a session', () => {
    expect(phoneRowFocusOpts(null, true)).toEqual({ openDetail: true });
    expect(phoneRowFocusOpts('s-1', true)).toEqual({ openDetail: false });
    expect(phoneRowFocusOpts(null, false)).toEqual({ openDetail: false });
  });

  it('never turns a phone title tap into the inline editor', () => {
    expect(phoneTitleTapOpens(true, true)).toBe(true);
    expect(phoneTitleTapOpens(false, true)).toBe(true);
    // Desktop keeps its rule: a second click on a focused row edits.
    expect(phoneTitleTapOpens(true, false)).toBe(false);
    expect(phoneTitleTapOpens(false, false)).toBe(true);
  });
});

describe('pull to refresh distance', () => {
  it('counts only a downward pull that started at the top', () => {
    expect(pullDistance(100, 180, true)).toBe(80);
    expect(pullDistance(100, 80, true)).toBe(0);
    expect(pullDistance(100, 300, false)).toBe(0);
    expect(pullDistance(null, 300, true)).toBe(0);
    expect(pullDistance(0, PULL_TRIGGER_PX, true)).toBeGreaterThanOrEqual(PULL_TRIGGER_PX);
  });
});

describe('phone search groups', () => {
  it('groups tasks, sessions and notes, one row each, skipping auto-expanded rows', () => {
    const g = groupSearchHits([
      { type: 'task', title: 'Alpha', taskId: 't1' },
      { type: 'task', title: 'Alpha again', taskId: 't1' },
      { type: 'task', title: 'Child', taskId: 't2', isAutoExpanded: true },
      { type: 'session', title: 'Alpha run', taskId: 't1', sessionId: 's1' },
      { type: 'session', title: 'Alpha run', taskId: 't1', sessionId: 's1' },
      { type: 'memory', title: 'A memory' },
    ], [
      { path: 'Areas/plan.md', snippet: 'x' },
      { path: 'Areas/plan.md', snippet: 'y' },
      { path: 'Inbox/idea.md', name: 'Idea', snippet: 'z' },
    ]);
    expect(g.tasks.map((t) => t.taskId)).toEqual(['t1']);
    expect(g.sessions.map((s) => s.sessionId)).toEqual(['s1']);
    expect(g.notes.map((n) => n.title)).toEqual(['plan', 'Idea']);
    expect(isEmptyGroups(g)).toBe(false);
    expect(isEmptyGroups(groupSearchHits([], []))).toBe(true);
  });
});

describe('small phone words', () => {
  it('reads a live process as one that completing would stop', () => {
    expect(sessionIsAlive({ process_status: 'running' })).toBe(true);
    expect(sessionIsAlive({ process_status: 'idle' })).toBe(true);
    expect(sessionIsAlive({ process_status: 'stopped' })).toBe(false);
    expect(sessionIsAlive(null)).toBe(false);
  });

  it('names a note by its file name and the bell by its count', () => {
    expect(noteTitleOf('Areas/Garden/Seed list.md')).toBe('Seed list');
    expect(noteTitleOf(null)).toBe('Notes');
    expect(bellAriaLabel(3)).toBe('Notifications, 3 new');
  });
});
