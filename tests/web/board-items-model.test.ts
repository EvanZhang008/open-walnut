/**
 * Pure helpers for the Board's items and its team owner
 * (web/src/components/board/board-items-model.ts): who keeps the board the pane
 * shows, the bar's words, the lineage that reloads, the local merges of the
 * user's ticks and reminders, and the reminder "due" rule. The frame itself is
 * proven in a real browser: tests/e2e/browser/task-board-items.spec.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  boardBarTitle, boardOwnerId, changedCheckHash, checkFromRoute, dropDueReminder, projectTaskIds, recordOf,
  reminderDue, setEntry, taskLineage,
} from '../../web/src/components/board/board-items-model';
import type { BoardReminder, StoreTaskLike } from '../../web/src/components/board/board-model';

const NOW = Date.parse('2026-10-01T12:00:00.000Z');
const reminder = (at: string, extra: Partial<BoardReminder> = {}): BoardReminder => ({
  at, set_at: '2026-10-01T10:00:00.000Z', set_by: 'human', ...extra,
});

describe('boardOwnerId', () => {
  it('is the payload owner, else the task asked for (a server without ?team=1)', () => {
    expect(boardOwnerId({ board_task_id: 'lead01' }, 'work01')).toBe('lead01');
    expect(boardOwnerId({}, 'work01')).toBe('work01');
    expect(boardOwnerId({ board_task_id: '' }, 'work01')).toBe('work01');
    expect(boardOwnerId(null, 'work01')).toBe('work01');
  });
});

describe('boardBarTitle', () => {
  it('reads "Board" on the task\'s own board, with no tooltip', () => {
    expect(boardBarTitle('lead01', 'lead01', 'Lead')).toEqual({ text: 'Board', shared: false });
  });

  it('names the keeper of a shared board, falling back to its id', () => {
    expect(boardBarTitle('lead01', 'work01', 'Ship the probe')).toEqual({
      text: 'Board · Ship the probe',
      tooltip: 'Shared with your team: Ship the probe keeps this board',
      shared: true,
    });
    expect(boardBarTitle('lead01', 'work01', '  ').text).toBe('Board · lead01');
  });

  it('keeps non-ASCII titles as they are', () => {
    expect(boardBarTitle('lead01', 'work01', '发布 \u{1F680}').text).toBe('Board · 发布 \u{1F680}');
  });
});

describe('taskLineage', () => {
  const byId = new Map<string, StoreTaskLike>([
    ['c', { id: 'c', title: 'C', parent_task_id: 'b' }],
    ['b', { id: 'b', title: 'B', parent_task_id: 'a' }],
    ['a', { id: 'a', title: 'A' }],
  ]);

  it('walks to the root, nearest first', () => {
    expect(taskLineage('c', byId)).toEqual(['c', 'b', 'a']);
    expect(taskLineage('a', byId)).toEqual(['a']);
  });

  it('stops on a task the store does not know, on a cycle, and at the cap', () => {
    expect(taskLineage('x', byId)).toEqual(['x']);
    expect(taskLineage('c', null)).toEqual(['c']);
    const loop = new Map<string, StoreTaskLike>([
      ['p', { id: 'p', title: 'P', parent_task_id: 'q' }],
      ['q', { id: 'q', title: 'Q', parent_task_id: 'p' }],
    ]);
    expect(taskLineage('p', loop)).toEqual(['p', 'q']);
    expect(taskLineage('c', byId, 2)).toEqual(['c', 'b']);
  });
});

describe('setEntry and recordOf', () => {
  it('sets, replaces and removes; an absent removal keeps the same object', () => {
    const m = { a: 1 };
    expect(setEntry(m, 'b', 2)).toEqual({ a: 1, b: 2 });
    expect(setEntry(m, 'a', 3)).toEqual({ a: 3 });
    expect(setEntry(m, 'a', null)).toEqual({});
    expect(setEntry(m, 'zz', null)).toBe(m);
    expect(m).toEqual({ a: 1 });
  });

  it('turns anything but a plain object into {}', () => {
    expect(recordOf(undefined)).toEqual({});
    expect(recordOf([1])).toEqual({});
    expect(recordOf('x')).toEqual({});
    expect(recordOf({ a: 1 })).toEqual({ a: 1 });
  });
});

describe('checks', () => {
  it('maps the route answer to the GET shape', () => {
    expect(checkFromRoute({ check: { hash: 'h1', read_at: 't' }, hash: 'h1' }, true, 'old'))
      .toEqual({ hash: 'h1', read: true, read_at: 't' });
    expect(checkFromRoute({ check: null, hash: 'h1' }, false, 'old')).toEqual({ hash: 'h1', read: false });
    expect(checkFromRoute(null, true, 'old')).toEqual({ hash: 'old', read: false });
  });

  it('reads the current hash only from a 409 check_changed', () => {
    expect(changedCheckHash({ error: { code: 'check_changed', message: 'x' }, check: 'p1', hash: 'h2' })).toBe('h2');
    expect(changedCheckHash({ error: { code: 'check_changed', hash: 'h3' } })).toBe('h3');
    expect(changedCheckHash({ error: { code: 'conflict' }, hash: 'h2' })).toBeNull();
    expect(changedCheckHash({ error: { code: 'check_changed' } })).toBeNull();
    expect(changedCheckHash(undefined)).toBeNull();
  });
});

describe('reminders', () => {
  it('is due once fired or once its time has come', () => {
    expect(reminderDue(reminder('2026-10-01T13:00:00.000Z'), NOW)).toBe(false);
    expect(reminderDue(reminder('2026-10-01T12:00:00.000Z'), NOW)).toBe(true);
    expect(reminderDue(reminder('2026-10-01T13:00:00.000Z', { fired_at: '2026-10-01T11:00:00.000Z' }), NOW)).toBe(true);
    expect(reminderDue(reminder('not a time'), NOW)).toBe(false);
    expect(reminderDue(null, NOW)).toBe(false);
  });

  it('drops only a DUE reminder for the answered target', () => {
    const map = {
      due: reminder('2026-10-01T11:00:00.000Z'),
      later: reminder('2026-10-02T09:00:00.000Z'),
    };
    expect(Object.keys(dropDueReminder(map, 'due', NOW))).toEqual(['later']);
    expect(dropDueReminder(map, 'later', NOW)).toBe(map);
    expect(dropDueReminder(map, 'none', NOW)).toBe(map);
  });
});

describe('projectTaskIds', () => {
  it('lists every task the projects name, once', () => {
    expect(projectTaskIds({
      a: { tasks: ['t1', 't2'], updated_at: 'x', updated_by: 'human' },
      b: { tasks: ['t2', 't3', ''], updated_at: 'x', updated_by: 'human' },
      c: { updated_at: 'x', updated_by: 'human' },
    })).toEqual(['t1', 't2', 't3']);
  });
});
