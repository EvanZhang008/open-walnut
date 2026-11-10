/**
 * Not started is its own category, out of Waiting / snoozed (2026-11-09, the user: "there shudl be
 * a new category not started, to put the not stared one not mix in to wait and snooze they are
 * completeli differnet , auto collpes also, icon change also").
 *
 * The rule, the same on Home's Flat sections and on the Board / Org Status view: a task whose one
 * user status is Waiting because nobody started it (kind `not-started`: never run, marked in
 * progress with no session, a start that failed) and that is not snoozed. Guards for the class:
 * every kind of not-started status lands in Not started, no wait or snooze does, Flat draws every
 * section it has, Not started auto-folds, and its rows never wear the hourglass.
 */
import { describe, expect, it } from 'vitest';
import type { Task } from '../../src/core/types';
import type { UserStatus } from '../../src/core/user-status';
import {
  STATUS_SECTION_LABELS,
  STATUS_SECTION_ORDER,
  buildStatusSections,
  drawnSectionOf,
  isNotStarted,
  notStartedReason,
  stateSectionNoNeeds,
} from '../../web/src/components/tasks/status-sections';
import { bottomStatusSections } from '../../web/src/components/tasks/panel-design';
import { STATUS_SECTION_FOLD } from '../../web/src/components/tasks/section-fold-rule';
import { ICON_NOT_STARTED, ICON_PHASE_WAITING, ICON_SNOOZE, sectionRowIcon } from '../../web/src/components/common/Icons';
import {
  STATUS_CHIPS, buildStatusBoard, chipCount, chipLabel, filteredRows, isNotStartedStatus, isStatusFilter, statusBrief, briefCountsLine,
} from '../../web/src/components/board/board-status-model';
import { ORG_RAIL_TABS, ORG_TASK_TAB_LABELS, taskTabNote } from '../../web/src/components/org/org-task-tabs';
import { locatePlaceSig } from '../../web/src/components/tasks/locate-hold';

let n = 0;
const task = (patch: Partial<Task> & { us?: UserStatus } = {}): Task => {
  const { us, ...rest } = patch;
  return {
    id: `t${++n}`, title: `Task ${n}`, status: 'todo', phase: 'TODO', priority: 'none', project: 'Garden',
    created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z',
    ...(us ? { user_status: us } : {}), ...rest,
  } as Task;
};

// Every way the server says nobody started a task (src/core/user-status.ts).
const NOT_STARTED: UserStatus[] = [
  { state: 'waiting', kind: 'not-started', waitingOn: 'Not started yet' },
  { state: 'waiting', kind: 'not-started', waitingOn: 'Marked in progress; no session runs it' },
  { state: 'waiting', kind: 'not-started', waitingOn: 'Did not start: the host is offline' },
];
// Every other wait, and a not-started task the user snoozed.
const WAITS: UserStatus[] = [
  { state: 'waiting', kind: 'time', until: '2026-12-01T00:00:00Z', snoozed: { until: '2026-12-01' } } as UserStatus,
  { state: 'waiting', kind: 'not-started', waitingOn: 'Not started yet', snoozed: { until: '2026-12-01' } } as UserStatus,
  ...(['task', 'time', 'machine', 'outside', 'own', 'you', 'lead', 'stuck', 'other'] as const).map((kind): UserStatus => ({ state: 'waiting', kind, waitingOn: 'something' })),
];

describe('Not started: Home (Flat)', () => {
  it('every not-started status lands in Not started; every wait and snooze stays in Waiting / snoozed', () => {
    for (const us of NOT_STARTED) expect(drawnSectionOf(task({ us })), us.waitingOn).toBe('notstarted');
    for (const us of WAITS) expect(drawnSectionOf(task({ us, phase: 'WAITING' })), `${us.kind} ${us.snoozed ? 'snoozed' : ''}`).toBe('waiting');
  });

  it('only Flat splits it out: By project keeps those tasks in its list', () => {
    const rows = [...NOT_STARTED.map((us) => task({ us })), ...WAITS.map((us) => task({ us, phase: 'WAITING' }))];
    const flat = buildStatusSections({ scope: rows, all: rows, passes: () => true, splitNotStarted: true });
    expect(flat.notstarted).toHaveLength(NOT_STARTED.length);
    expect(flat.waiting).toHaveLength(WAITS.length);
    const plain = buildStatusSections({ scope: rows, all: rows, passes: () => true });
    expect(plain.notstarted).toHaveLength(0);
    expect(plain.waiting).toHaveLength(rows.length);
    for (const us of NOT_STARTED) expect(stateSectionNoNeeds(task({ us }))).toBe('working');
  });

  it('a task the server has not derived yet: a TODO with no session and no start date to come', () => {
    expect(isNotStarted(task())).toBe(true);
    expect(isNotStarted(task(), () => true)).toBe(false);
    expect(isNotStarted(task({ session_id: 's1' }))).toBe(false);
    expect(drawnSectionOf(task({ phase: 'WAITING' }))).toBe('waiting');
  });

  it('its row line says only what the heading does not', () => {
    expect(notStartedReason(task({ us: NOT_STARTED[0] }))).toBe('');
    expect(notStartedReason(task({ us: NOT_STARTED[2] }))).toBe('Did not start: the host is offline');
  });

  it('Flat draws every section it has, Not started between Waiting and Completed, and it folds by itself', () => {
    const top = ['watching', 'needs', 'working'];
    for (const view of ['all', 'focus', 'tasks', 'satellite']) {
      expect([...top, ...bottomStatusSections('status', view)], view).toEqual([...STATUS_SECTION_ORDER]);
    }
    expect(STATUS_SECTION_FOLD.notstarted).toBe('auto');
    expect(STATUS_SECTION_LABELS.notstarted).toBe('Not started');
  });

  it('its rows wear the dashed ring, never the hourglass or the moon', () => {
    const icon = sectionRowIcon('notstarted', false, 'TODO', false, 'waiting');
    expect(icon).toBe(ICON_NOT_STARTED);
    expect(icon).not.toBe(ICON_PHASE_WAITING);
    expect(icon).not.toBe(ICON_SNOOZE);
  });
});

describe('Not started: the Board and Org Status view', () => {
  const owner = task({ id: 'lead', phase: 'IN_PROGRESS', us: { state: 'working' } });
  const kids = [
    ...NOT_STARTED.map((us, i) => task({ id: `ns${i}`, parent_task_id: 'lead', us })),
    ...WAITS.map((us, i) => task({ id: `w${i}`, parent_task_id: 'lead', phase: 'WAITING', us })),
  ];
  const board = buildStatusBoard({ ownerId: 'lead', tasks: [owner, ...kids], now: Date.parse('2026-11-09T00:00:00Z'), doneWindowDays: 7 });

  it('the same rule as Home: a snoozed not-started task is a snooze', () => {
    for (const us of NOT_STARTED) expect(isNotStartedStatus(us)).toBe(true);
    for (const us of WAITS) expect(isNotStartedStatus(us)).toBe(false);
    for (const us of [...NOT_STARTED, ...WAITS]) expect(isNotStartedStatus(us)).toBe(isNotStarted(task({ us })));
  });

  it('a Not started chip after Waiting, the counts split, the rows split', () => {
    expect(STATUS_CHIPS).toEqual(['needs', 'working', 'waiting', 'notstarted', 'done']);
    expect(chipLabel('notstarted')).toBe('Not started');
    expect(chipCount(board, 'notstarted')).toBe(NOT_STARTED.length);
    expect(chipCount(board, 'waiting')).toBe(WAITS.length);
    expect(filteredRows(board, 'notstarted').map((r) => r.task.id)).toEqual(expect.arrayContaining(['ns0', 'ns1', 'ns2']));
    expect(filteredRows(board, 'waiting').some((r) => r.task.id.startsWith('ns'))).toBe(false);
    expect(filteredRows(board, 'open')).toHaveLength(1 + kids.length);
    expect(isStatusFilter('notstarted')).toBe(true);
    expect(briefCountsLine(statusBrief(board))).toBe(`1 Working, ${WAITS.length} Waiting / snoozed (1 with nothing to wake it), ${NOT_STARTED.length} Not started, 0 Completed in the last 7 days.`);
  });
});

describe('Not started: the Org node Task view', () => {
  it('a tab of its own after Waiting / snoozed, saying only a failed start', () => {
    expect(ORG_RAIL_TABS).toEqual(['watching', 'needs', 'working', 'waiting', 'notstarted', 'done']);
    expect(ORG_TASK_TAB_LABELS.notstarted).toBe('Not started');
    expect(taskTabNote(task({ us: NOT_STARTED[0] }), 'notstarted')).toBe('');
    expect(taskTabNote(task({ us: NOT_STARTED[2] }), 'notstarted')).toBe('Did not start: the host is offline');
  });
});

describe('a held locate runs again when a task moves between Waiting and Not started', () => {
  it('the place signature reads the status kind', () => {
    const facts = { tier: null, passes: true, held: false };
    const a = task({ id: 'x', us: { state: 'waiting', kind: 'stuck' } });
    const b = { ...a, user_status: { state: 'waiting', kind: 'not-started' } } as Task;
    expect(locatePlaceSig(a, facts)).not.toBe(locatePlaceSig(b, facts));
  });
});
