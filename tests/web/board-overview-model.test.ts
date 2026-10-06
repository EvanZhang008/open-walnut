/**
 * The Board's Overview (web/src/components/board/board-overview-model.ts) and
 * the team walk (cycles, the depth
 * cap), each task's group / reason / badge / "now" line, the attention order
 * inside a group (a child under its parent, the indent cap), the page's signals
 * and the rollup. The pane itself is proven in a real browser:
 * tests/e2e/browser/board-overview.spec.ts.
 */
import { describe, expect, it } from 'vitest';
import type { Task } from '@open-walnut/core';
import {
  INDENT_CAP, PROJECT_STATUS_LABELS, PROJECT_STATUS_TONES, REST_DONE_SECTION_ID, REST_SECTION_ID,
  boardSignals, buildSections, buildTeamOverview, compactAgo, describeTask, donePercent, orderGroup, orderProjects,
  projectStatusOf, rollupText, rowTooltip, signalsText, teamChildren, walkTeam,
  type BoardElements, type LiveStatus, type OverviewRow,
} from '../../web/src/components/board/board-overview-model';
import type { BoardProject } from '../../web/src/components/board/board-model';
import { subtasksOf } from '../../web/src/components/tasks/subtask-index';

const NOW = Date.parse('2026-10-02T12:00:00.000Z');
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

let seq = 0;
function task(id: string, extra: Partial<Task> = {}): Task {
  seq += 1;
  return {
    id,
    title: `Task ${id}`,
    status: 'todo',
    phase: 'TODO',
    priority: 'none',
    project: 'Orchard',
    source: 'local',
    description: '',
    summary: '',
    note: '',
    created_at: ago(1000 + seq),
    updated_at: ago(500 + seq),
    ...extra,
  } as Task;
}

const withSession = (id: string, extra: Partial<Task> = {}) => task(id, { session_id: `sid-${id}`, ...extra });
const live = (s: Partial<LiveStatus>): LiveStatus => ({ statusUpdatedAt: null, ...s });
const NO_ELEMENTS: BoardElements = { choices: [], threads: [] };

describe('walkTeam', () => {
  it('walks the subtree depth first, each task once, nothing outside it', () => {
    const tasks = [
      task('lead'), task('a', { parent_task_id: 'lead' }), task('a1', { parent_task_id: 'a' }),
      task('b', { parent_task_id: 'lead' }), task('other'), task('o1', { parent_task_id: 'other' }),
    ];
    const team = walkTeam('lead', (id) => subtasksOf(tasks, id));
    expect(team.map((m) => [m.task.id, m.depth, m.parentId])).toEqual([
      ['a', 1, 'lead'], ['a1', 2, 'a'], ['b', 1, 'lead'],
    ]);
  });

  it('ends on a cyclic chain and never revisits the owner', () => {
    // a → b → a, and b names the owner as a child too: a corrupt store must not loop.
    const children: Record<string, Task[]> = {
      lead: [task('a')], a: [task('b')], b: [task('a'), task('lead')],
    };
    const team = walkTeam('lead', (id) => children[id] ?? []);
    expect(team.map((m) => m.task.id)).toEqual(['a', 'b']);
  });

  it('stops at the depth cap', () => {
    const chain = Array.from({ length: 12 }, (_, i) => task(`t${i + 1}`, { parent_task_id: i === 0 ? 'lead' : `t${i}` }));
    const tasks = [task('lead'), ...chain];
    expect(walkTeam('lead', (id) => subtasksOf(tasks, id), 3).map((m) => m.task.id)).toEqual(['t1', 't2', 't3']);
    expect(walkTeam('lead', (id) => subtasksOf(tasks, id)).length).toBe(8);
  });

  it('follows a legacy prefix parent id', () => {
    const tasks = [task('lead-full-id-0001'), task('w', { parent_task_id: 'lead-full' })];
    expect(walkTeam('lead-full-id-0001', (id) => subtasksOf(tasks, id)).map((m) => m.task.id)).toEqual(['w']);
  });
});

describe('describeTask', () => {
  const fmt = { formatWaitUntil: (iso: string) => `[${iso.slice(0, 10)}]` };

  it('a pending permission prompt is Needs you first, Waiting in red, the tool named', () => {
    const t = withSession('p', { phase: 'IN_PROGRESS' });
    const s = describeTask(t, live({ process_status: 'running', pendingPermissionTool: 'Bash' }), []);
    expect(s).toMatchObject({ group: 'needs', reason: 'permission', badge: { label: 'Waiting', tone: 'red' }, now: 'Waiting for approval: Bash' });
    // The record can say idle while a question sits unanswered (deriveDisplayStatus).
    expect(describeTask(t, live({ process_status: 'idle', pendingPermissionTool: 'AskUserQuestion' }), []).now).toBe('Asked you a question');
    expect(describeTask(t, live({ process_status: 'running', pendingPermissionTool: 'ExitPlanMode' }), []).now).toBe('Plan waiting for your approval');
  });

  it('a stopped session cannot hold a prompt: no Waiting', () => {
    const s = describeTask(withSession('p'), live({ process_status: 'stopped', pendingPermissionTool: 'Bash' }), []);
    expect(s.reason).toBeNull();
    expect(s.badge.label).toBe('Stopped');
  });

  it('a session error, with its message', () => {
    const s = describeTask(withSession('e', { phase: 'NEED_ACTION' }), live({ process_status: 'error', errorMessage: 'API Error: Request timed out' }), []);
    expect(s).toMatchObject({ group: 'needs', reason: 'error', badge: { label: 'Error', tone: 'red' }, now: 'API Error: Request timed out' });
    expect(describeTask(withSession('e'), live({ process_status: 'error' }), []).now).toBe('The session stopped on an error');
  });

  it('NEED_ACTION and unread need you only while no turn runs', () => {
    const handed = withSession('n', { phase: 'NEED_ACTION', unread: true });
    expect(describeTask(handed, live({ process_status: 'idle' }), [])).toMatchObject({
      group: 'needs', reason: 'need-action', badge: { label: 'Idle', tone: 'amber' }, now: 'Handed back to you',
    });
    const unread = withSession('u', { phase: 'IN_PROGRESS', unread: true });
    expect(describeTask(unread, live({ process_status: 'stopped' }), [])).toMatchObject({ reason: 'unread', now: 'New output you have not read' });
    // A new turn already started: the phase lags, the session is the truth.
    expect(describeTask(handed, live({ process_status: 'running', activity: 'implementing' }), [])).toMatchObject({
      group: 'running', reason: null, badge: { label: 'Running', tone: 'green' }, now: 'Implementing',
    });
  });

  it('a task with no session shows its phase', () => {
    expect(describeTask(task('t'), null, [])).toMatchObject({ group: 'open', badge: { label: 'To Do', tone: 'grey' }, now: 'Not started' });
    expect(describeTask(task('n', { phase: 'NEED_ACTION' }), null, [])).toMatchObject({ group: 'needs', badge: { label: 'Need Action', tone: 'red' } });
    // A status the store still holds for a task with no session slot is not this task's.
    expect(describeTask(task('t'), live({ process_status: 'running' }), []).group).toBe('open');
  });

  it('WAITING is Open, violet, with its wait-until', () => {
    const w = withSession('w', { phase: 'WAITING', wait_until: '2026-10-05T09:00:00.000Z' });
    expect(describeTask(w, live({ process_status: 'idle' }), [], fmt)).toMatchObject({
      group: 'open', badge: { label: 'Waiting', tone: 'violet' }, now: 'Until [2026-10-05]',
    });
    expect(describeTask(task('w2', { phase: 'WAITING' }), null, [], fmt).now).toBe('Until something happens');
  });

  it('done is Done whatever the session says', () => {
    const d = withSession('d', { phase: 'COMPLETE', status: 'done', completed_at: ago(5) });
    expect(describeTask(d, live({ process_status: 'running' }), [])).toMatchObject({ group: 'done', badge: { label: 'Done' }, now: '', at: ago(5) });
  });

  it('a board signal puts any task in Needs you, after its own reasons', () => {
    const sig = [{ kind: 'choice' as const, id: 'c1', title: 'When to purge', taskId: 'r', count: 1 }];
    expect(describeTask(withSession('r'), live({ process_status: 'running', activity: 'planning' }), sig)).toMatchObject({
      group: 'needs', reason: 'board', badge: { label: 'Running' }, now: 'Choice on the page: When to purge · Planning',
    });
    expect(describeTask(withSession('r', { phase: 'NEED_ACTION' }), live({ process_status: 'idle' }), sig).now)
      .toBe('Handed back to you · Choice on the page: When to purge');
  });

  it('the latest status change is the newest of the session, the phase and the last session update', () => {
    const t = withSession('x', { phase_changed_at: ago(30), last_session_update: ago(10), updated_at: ago(1) });
    expect(describeTask(t, live({ process_status: 'idle', statusUpdatedAt: ago(20) }), []).at).toBe(ago(10));
    expect(describeTask(t, live({ process_status: 'idle', statusUpdatedAt: ago(2) }), []).at).toBe(ago(2));
    // An edit is not a status change: updated_at only when nothing else is known.
    expect(describeTask(task('y', { updated_at: ago(3) }), null, []).at).toBe(ago(3));
  });
});

function row(id: string, extra: Partial<OverviewRow> = {}): OverviewRow {
  return {
    id, task: task(id), depth: 1, parentId: 'lead', signals: [], openSubtasks: 0, place: '', circle: 'task-circle-todo',
    group: 'open', reason: null, badge: { label: 'To Do', tone: 'grey' }, now: '', at: '', running: false,
    ...extra,
  };
}

describe('orderGroup', () => {
  const titles: Record<string, string> = { lead: 'Lead', a: 'Area A', a1: 'Probe' };
  const titleOf = (id: string) => titles[id] ?? '';

  it('Needs you: permission, error, NEED_ACTION, unread, board; then newest first', () => {
    const out = orderGroup([
      row('board', { reason: 'board', at: ago(1) }),
      row('unread', { reason: 'unread', at: ago(2) }),
      row('need-old', { reason: 'need-action', at: ago(50) }),
      row('need-new', { reason: 'need-action', at: ago(5) }),
      row('err', { reason: 'error', at: ago(40) }),
      row('perm', { reason: 'permission', at: ago(90) }),
    ], titleOf);
    expect(out.map((r) => r.id)).toEqual(['perm', 'err', 'need-new', 'need-old', 'unread', 'board']);
  });

  it('newest first, an unknown time last, equal keys in input order', () => {
    const out = orderGroup([row('none'), row('old', { at: ago(60) }), row('new', { at: ago(1) }), row('none2')], titleOf);
    expect(out.map((r) => r.id)).toEqual(['new', 'old', 'none', 'none2']);
  });

  it('a child follows its parent in the same group, indented; the indent stops at the cap', () => {
    const out = orderGroup([
      row('b', { at: ago(1) }),
      row('a', { at: ago(30) }),
      row('a1', { depth: 2, parentId: 'a', at: ago(2) }),
      row('a1x', { depth: 3, parentId: 'a1', at: ago(3) }),
      row('a1xy', { depth: 4, parentId: 'a1x', at: ago(4) }),
    ], titleOf);
    expect(out.map((r) => [r.id, r.indent, r.under])).toEqual([
      ['b', 0, ''], ['a', 0, ''], ['a1', 1, ''], ['a1x', 2, ''], ['a1xy', INDENT_CAP, ''],
    ]);
  });

  it('a nested row whose parent is in another group says whom it is under', () => {
    const out = orderGroup([row('a1', { depth: 2, parentId: 'a' })], titleOf);
    expect(out[0]).toMatchObject({ indent: 0, under: 'Area A' });
  });
});

describe('boardSignals', () => {
  const team = new Set(['work-0001', 'work-0002']);
  const elements: BoardElements = {
    choices: [
      { id: 'purge', title: 'When to purge', task: 'work-0001' },
      { id: 'scope', title: 'Scope', task: '' },
      { id: 'done-choice', title: 'Answered', task: 'work-0002' },
    ],
    threads: [
      { id: 'area-a', title: 'Area A', task: 'work-00' }, // ambiguous prefix: two members
      { id: 'area-b', title: 'Area B', task: 'work-0002'.slice(0, 8) + '2' },
      { id: 'quiet', title: 'Quiet', task: '' },
    ],
  };
  const msg = (author: string, min: number) => ({ id: `m${min}`, author: author as 'user', text: 'x', ts: ago(min) });

  it('unanswered choices, due reminders (in place of the choice), unread threads, in that order', () => {
    const out = boardSignals(elements, {
      choices: { 'done-choice': { option: 'a', at: ago(5) } },
      reminders: { scope: { at: ago(1), set_at: ago(60), set_by: 'human' }, quiet: { at: ago(-30), set_at: ago(60), set_by: 'human' } },
      threads: {
        'area-a': [msg('task:work-0002', 10), msg('user', 5), msg('task:lead-0001', 3)],
        'area-b': [msg('user', 2)],
        'not-on-page': [msg('task:work-0001', 1)],
      },
    }, { 'area-a': ago(9) }, 'lead-0001', team, NOW);
    expect(out.map((s) => [s.kind, s.id, s.taskId, s.count])).toEqual([
      ['reminder', 'scope', 'lead-0001', 1],
      ['choice', 'purge', 'work-0001', 1],
      // Read up to 9 minutes ago: one new message, the leader's (the user's own never counts).
      ['thread', 'area-a', 'lead-0001', 1],
    ]);
  });

  it('a thread with no task goes to the member who wrote the newest unread message', () => {
    const out = boardSignals({ choices: [], threads: [{ id: 't', title: 'T', task: '' }] }, {
      choices: {}, reminders: {}, threads: { t: [msg('task:work-0002', 4), msg('task:stranger', 6)] },
    }, {}, 'lead-0001', team, NOW);
    expect(out).toEqual([{ kind: 'thread', id: 't', title: 'T', taskId: 'work-0002', count: 2 }]);
  });

  it('a prefix task attribute that names exactly one member is that member', () => {
    const out = boardSignals({ choices: [{ id: 'c', title: 'C', task: 'work-0001'.slice(0, 7) + '1' }], threads: [] },
      { choices: {}, reminders: {}, threads: {} }, {}, 'lead-0001', new Set(['work-0001', 'zzz-0002']), NOW);
    expect(out[0].taskId).toBe('lead-0001'); // 'work-001' is a prefix of nothing: the owner keeps it
    const hit = boardSignals({ choices: [{ id: 'c', title: 'C', task: 'work-00' }], threads: [] },
      { choices: {}, reminders: {}, threads: {} }, {}, 'lead-0001', new Set(['work-0001', 'zzz-0002']), NOW);
    expect(hit[0].taskId).toBe('work-0001');
  });

  it('no payload, no signals', () => {
    expect(boardSignals(elements, null, {}, 'lead', team, NOW)).toEqual([]);
  });

  it('the row text names the first and counts the rest', () => {
    const s = (kind: 'choice' | 'thread' | 'reminder', count = 1) => ({ kind, id: kind, title: kind.toUpperCase(), taskId: 'x', count });
    expect(signalsText([s('reminder'), s('thread', 3)])).toBe('Reminder due: REMINDER (+1 more)');
    expect(signalsText([s('thread', 3)])).toBe('3 new messages in THREAD');
    expect(signalsText([s('thread', 1)])).toBe('1 new message in THREAD');
    expect(signalsText([])).toBe('');
  });
});

describe('buildTeamOverview', () => {
  function team() {
    const lead = withSession('lead', { title: 'Ship the probe', phase: 'IN_PROGRESS' });
    const tasks = [
      lead,
      withSession('perm', { parent_task_id: 'lead', phase: 'IN_PROGRESS' }),
      withSession('run', { parent_task_id: 'lead', phase: 'IN_PROGRESS', project: 'Lighthouse' }),
      task('todo', { parent_task_id: 'lead' }),
      task('sub', { parent_task_id: 'todo' }),
      task('done', { parent_task_id: 'lead', phase: 'COMPLETE', status: 'done', completed_at: ago(3) }),
      task('outsider'),
    ];
    const statuses: Record<string, LiveStatus> = {
      'sid-lead': live({ process_status: 'idle' }),
      'sid-perm': live({ process_status: 'running', pendingPermissionTool: 'Bash' }),
      'sid-run': live({ process_status: 'running', activity: 'implementing' }),
    };
    return { lead, tasks, statuses };
  }

  it('groups, counts and the attention total', () => {
    const { lead, tasks, statuses } = team();
    const o = buildTeamOverview({
      ownerId: 'lead', owner: lead, childrenOf: (id) => subtasksOf(tasks, id),
      statusOf: (t) => (t.session_id ? statuses[t.session_id] ?? null : null),
      elements: NO_ELEMENTS, board: null, seen: {}, now: NOW,
    });
    expect(o.groups.map((g) => [g.id, g.rows.map((r) => r.id)])).toEqual([
      ['needs', ['perm']], ['running', ['run']], ['open', ['todo', 'sub']], ['done', ['done']],
    ]);
    expect(o).toMatchObject({ members: 5, open: 4, done: 1, attention: 1 });
    expect(o.leader).toMatchObject({ id: 'lead', group: 'open', badge: { label: 'Idle' } });
    // The open sub-leader carries its count; the child sits under it.
    const open = o.groups[2].rows;
    expect(open[0]).toMatchObject({ id: 'todo', openSubtasks: 1, indent: 0 });
    expect(open[1]).toMatchObject({ id: 'sub', indent: 1, depth: 2 });
    // The team spans two projects: only the row in the other one names it.
    expect(o.groups[1].rows[0].place).toBe('Lighthouse');
    expect(open[0].place).toBe('');
    expect(rollupText(o)).toBe('4 open · 1 done');
    expect(donePercent(o)).toBe(20);
  });

  it('the leader counts in attention, and a page signal with no task is the leader\'s', () => {
    const { lead, tasks, statuses } = team();
    const o = buildTeamOverview({
      ownerId: 'lead', owner: lead, childrenOf: (id) => subtasksOf(tasks, id),
      statusOf: (t) => (t.session_id ? statuses[t.session_id] ?? null : null),
      elements: { choices: [{ id: 'c', title: 'Scope', task: '' }, { id: 'c2', title: 'Probe target', task: 'todo' }], threads: [] },
      board: { choices: {}, reminders: {}, threads: {} }, seen: {}, now: NOW,
    });
    expect(o.leader).toMatchObject({ group: 'needs', reason: 'board', now: 'Choice on the page: Scope' });
    expect(o.groups[0].rows.map((r) => [r.id, r.reason])).toEqual([['perm', 'permission'], ['todo', 'board']]);
    // The sub-leader moved to Needs you: its child, still Open, says whom it is under.
    expect(o.groups.find((g) => g.id === 'open')!.rows[0]).toMatchObject({ id: 'sub', under: 'Task todo' });
    expect(o.attention).toBe(3);
    expect(o.signals.length).toBe(2);
  });

  it('an owner the store does not have still lists its team; an empty team reads "No workers yet"', () => {
    // The store's prefix index only knows parents in the list; teamChildren matches the missing owner directly.
    const tasks = [task('w', { parent_task_id: 'gone' }), task('w2', { parent_task_id: 'w' }), task('x', { parent_task_id: 'other' })];
    expect(subtasksOf(tasks, 'gone1234')).toEqual([]);
    const o = buildTeamOverview({
      ownerId: 'gone1234', owner: null, childrenOf: teamChildren(tasks, 'gone1234'), statusOf: () => null,
      elements: NO_ELEMENTS, board: null, seen: {},
    });
    expect(o.leader).toBeNull();
    expect(o.members).toBe(2);
    expect(o.groups[0].rows.map((r) => [r.id, r.indent])).toEqual([['w', 0], ['w2', 1]]);
    // With the owner in the list, the index answers as before.
    const withOwner = [task('own'), task('c', { parent_task_id: 'own' })];
    expect(teamChildren(withOwner, 'own')('own').map((t) => t.id)).toEqual(['c']);
    const empty = buildTeamOverview({
      ownerId: 'solo', owner: task('solo'), childrenOf: () => [], statusOf: () => null, elements: NO_ELEMENTS, board: null, seen: {},
    });
    expect(empty.groups).toEqual([]);
    expect(rollupText(empty)).toBe('No workers yet');
    expect(donePercent(empty)).toBe(0);
  });
});

describe('sections: the board\'s projects', () => {
  const project = (extra: Partial<BoardProject> = {}): BoardProject => ({ updated_at: ago(10), updated_by: 'task:lead-0001', ...extra });
  const titles: Record<string, string> = { 'lead-0001': 'Lead', 'area-a-0001': 'Area A' };
  const titleOf = (id: string) => titles[id] ?? '';

  it('page order first, then the recorded projects the page does not show; unknown ids and repeats dropped', () => {
    const projects = { 'sec-a': project(), 'sec-b': project(), 'sec-c': project() };
    expect(orderProjects(projects, ['sec-c', 'sec-a', 'sec-c', 'sec-zz', ''])).toEqual(['sec-c', 'sec-a', 'sec-b']);
    expect(orderProjects(projects)).toEqual(['sec-a', 'sec-b', 'sec-c']);
    expect(orderProjects({})).toEqual([]);
  });

  it('a status the page knows, in its words and colors; anything else is none', () => {
    expect(projectStatusOf(project({ status: 'decide' }))).toBe('decide');
    expect(projectStatusOf(project({ status: 'later' as 'wip' }))).toBeNull();
    expect(projectStatusOf(project())).toBeNull();
    expect(projectStatusOf(null)).toBeNull();
    expect(PROJECT_STATUS_LABELS).toEqual({ decide: 'Needs you', wip: 'In progress', wait: 'Waiting on others', done: 'Done' });
    expect(PROJECT_STATUS_TONES).toEqual({ decide: 'red', wip: 'blue', wait: 'amber', done: 'green' });
  });

  it('no projects, no sections: the state groups stay', () => {
    const rows = [row('w-0001')];
    expect(buildSections(rows, null, [], 'lead-0001', titleOf)).toBeNull();
    expect(buildSections(rows, undefined, [], 'lead-0001', titleOf)).toBeNull();
    expect(buildSections(rows, {}, ['sec-a'], 'lead-0001', titleOf)).toBeNull();
  });

  it('each project holds the members it names, open rows in attention order, done ones after; the rest close the list', () => {
    const rows = [
      row('a-open-0001', { at: ago(30) }),
      row('a-need-0001', { group: 'needs', reason: 'need-action', at: ago(60) }),
      row('a-done-0001', { group: 'done', at: ago(1) }),
      row('b-run-0001', { group: 'running', at: ago(2) }),
      row('loose-0001', { at: ago(5) }),
      row('loose-done-0001', { group: 'done', at: ago(5) }),
      row('loose-done-0002', { group: 'done', at: ago(6) }),
    ];
    const projects = {
      'sec-b': project({ title: 'B leader handover', status: 'wip', tasks: ['b-run-0001'] }),
      'sec-a': project({ title: 'A bus race', status: 'decide', tasks: ['a-open-0001', 'a-need-0001', 'a-done-0001'] }),
      'sec-c': project({ title: 'C image CVE', status: 'wait' }),
    };
    // The page shows A then B; C is recorded but not on the page.
    const out = buildSections(rows, projects, ['sec-a', 'sec-b'], 'lead-0001', titleOf)!;
    expect(out.map((s) => [s.kind, s.id, s.title, s.status, s.rows.map((r) => r.id), s.attention, s.done])).toEqual([
      ['project', 'sec-a', 'A bus race', 'decide', ['a-need-0001', 'a-open-0001', 'a-done-0001'], 1, 1],
      ['project', 'sec-b', 'B leader handover', 'wip', ['b-run-0001'], 0, 0],
      ['project', 'sec-c', 'C image CVE', 'wait', [], 0, 0],
      ['rest', REST_SECTION_ID, 'Other tasks', null, ['loose-0001'], 0, 0],
      ['rest-done', REST_DONE_SECTION_ID, 'Other tasks, done', null, ['loose-done-0001', 'loose-done-0002'], 0, 2],
    ]);
  });

  it('a prefix names the one member it fits; the owner, an outsider, an ambiguous prefix and a second naming are not rows', () => {
    const rows = [row('work-0001'), row('work-0002'), row('other-0001')];
    const projects = {
      // 'work-00' fits two members: a guess, not a ref.
      'sec-a': project({ tasks: ['work-0001', 'lead-0001', 'stranger-0001', 'work-00'] }),
      // work-0001 is A's already; 'other-00' fits exactly one member.
      'sec-b': project({ tasks: ['work-0001', 'other-00'] }),
    };
    const out = buildSections(rows, projects, [], 'lead-0001', titleOf)!;
    expect(out.map((s) => [s.id, s.rows.map((r) => r.id)])).toEqual([
      ['sec-a', ['work-0001']],
      ['sec-b', ['other-0001']],
      [REST_SECTION_ID, ['work-0002']],
    ]);
  });

  it('a task named from outside the team is a row of its section when the store has it, never of the team or the rest', () => {
    const tasks = [
      task('lead-0001'), task('w-0001', { parent_task_id: 'lead-0001' }), task('w-0002', { parent_task_id: 'lead-0001' }),
      task('ext-0001', { project: 'Elsewhere', phase: 'NEED_ACTION' }), task('ext-0002', { project: 'Elsewhere', phase: 'COMPLETE', status: 'done' }),
    ];
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const projects = {
      'sec-a': project({ tasks: ['w-0001', 'ext-0001', 'ext-0002', 'gone-0001', 'lead-0001'] }),
      'sec-b': project({ tasks: ['ext-0001'] }), // named twice: the first section keeps it
    };
    const overview = buildTeamOverview({
      ownerId: 'lead-0001', owner: tasks[0], childrenOf: (id) => subtasksOf(tasks, id), statusOf: () => null,
      elements: NO_ELEMENTS, board: null, projects, seen: {}, now: NOW, taskById: (id) => byId.get(id) ?? null,
    });
    expect(overview.sections!.map((s) => [s.id, s.rows.map((r) => r.id), s.attention, s.done])).toEqual([
      ['sec-a', ['ext-0001', 'w-0001', 'ext-0002'], 1, 1],
      ['sec-b', [], 0, 0],
      [REST_SECTION_ID, ['w-0002'], 0, 0],
    ]);
    // The team is still the owner's subtree.
    expect([overview.members, overview.open, overview.done, overview.attention]).toEqual([2, 2, 0, 0]);
    // Without the store's lookup an outsider is not a row (the earlier rule).
    const plain = buildTeamOverview({
      ownerId: 'lead-0001', owner: tasks[0], childrenOf: (id) => subtasksOf(tasks, id), statusOf: () => null,
      elements: NO_ELEMENTS, board: null, projects, seen: {}, now: NOW,
    });
    expect(plain.sections![0].rows.map((r) => r.id)).toEqual(['w-0001']);
  });

  it('a project with no title reads by its id; no rest section when every member has a section', () => {
    const rows = [row('w-0001')];
    const out = buildSections(rows, { 'sec-x': project({ title: '  ', tasks: ['w-0001'] }) }, [], 'lead-0001', titleOf)!;
    expect(out.map((s) => [s.id, s.title, s.kind])).toEqual([['sec-x', 'sec-x', 'project']]);
  });

  it('a nested row in a section follows its parent there, or says whom it is under', () => {
    const rows = [
      row('p-0001', { at: ago(10) }),
      row('c-0001', { depth: 2, parentId: 'p-0001', at: ago(1) }),
      row('c-0002', { depth: 2, parentId: 'area-a-0001', at: ago(2) }),
    ];
    const out = buildSections(rows, { 'sec-a': project({ tasks: ['p-0001', 'c-0001', 'c-0002'] }) }, [], 'lead-0001', titleOf)!;
    expect(out[0].rows.map((r) => [r.id, r.indent, r.under])).toEqual([
      ['c-0002', 0, 'Area A'], ['p-0001', 0, ''], ['c-0001', 1, ''],
    ]);
  });

  it('a worker\'s own subtasks follow it into its section, however deep; one named elsewhere goes there', () => {
    const rows = [
      row('w-0001', { at: ago(10) }),
      row('w1-0001', { depth: 2, parentId: 'w-0001', at: ago(3) }),
      row('w1x-0001', { depth: 3, parentId: 'w1-0001', at: ago(2), group: 'done' }),
      row('w2-0001', { depth: 2, parentId: 'w-0001', at: ago(1) }),
      row('loose-0001'),
    ];
    const out = buildSections(rows, {
      'sec-a': project({ tasks: ['w-0001'] }),
      'sec-b': project({ tasks: ['w2-0001'] }),
    }, [], 'lead-0001', titleOf)!;
    expect(out.map((s) => [s.id, s.rows.map((r) => r.id)])).toEqual([
      ['sec-a', ['w-0001', 'w1-0001', 'w1x-0001']],
      ['sec-b', ['w2-0001']],
      [REST_SECTION_ID, ['loose-0001']],
    ]);
    expect(out[0].done).toBe(1);
  });

  it('the rest ids can never be a board project id, and a project of that name is its own section', () => {
    // A board project id starts with a letter or a digit (BOARD_ITEM_ID_RE).
    expect(REST_SECTION_ID).toMatch(/^_/);
    expect(REST_DONE_SECTION_ID).toMatch(/^_/);
    const rows = [row('a-0001'), row('b-0001')];
    const out = buildSections(rows, { rest: project({ title: 'Rest', tasks: ['a-0001'] }) }, [], 'lead-0001', titleOf)!;
    expect(out.map((s) => [s.kind, s.id, s.rows.map((r) => r.id)])).toEqual([
      ['project', 'rest', ['a-0001']], ['rest', REST_SECTION_ID, ['b-0001']],
    ]);
    expect(new Set(out.map((s) => s.id)).size).toBe(out.length);
  });

  it('a hand-edited projects file does not take the Overview down', () => {
    const rows = [row('a-0001')];
    const projects = {
      'sec-null': null, 'sec-str': 'wip', 'sec-arr': [],
      'sec-odd': { title: 42, status: 7, tasks: [null, 3, 'a-0001'], updated_at: '', updated_by: '' },
    } as unknown as Record<string, BoardProject>;
    const out = buildSections(rows, projects, ['sec-null', 'sec-odd'], 'lead-0001', titleOf)!;
    expect(out.map((s) => [s.id, s.title, s.status, s.rows.map((r) => r.id)])).toEqual([['sec-odd', 'sec-odd', null, ['a-0001']]]);
    expect(orderProjects(projects, ['sec-str'])).toEqual(['sec-odd']);
    expect(buildSections(rows, { 'sec-null': null } as unknown as Record<string, BoardProject>, [], 'lead-0001', titleOf)).toBeNull();
  });

  it('buildTeamOverview carries the sections from the payload\'s projects and the page\'s order', () => {
    const lead = withSession('lead', { title: 'Ship the probe', phase: 'IN_PROGRESS' });
    const tasks = [
      lead,
      task('w1', { parent_task_id: 'lead', phase: 'NEED_ACTION' }),
      task('w2', { parent_task_id: 'lead' }),
      task('w3', { parent_task_id: 'lead', phase: 'COMPLETE', status: 'done', completed_at: ago(3) }),
    ];
    const base = {
      ownerId: 'lead', owner: lead, childrenOf: (id: string) => subtasksOf(tasks, id), statusOf: () => null,
      board: null, seen: {}, now: NOW,
    };
    const o = buildTeamOverview({
      ...base,
      elements: { choices: [], threads: [], projects: ['sec-b', 'sec-a'] },
      projects: { 'sec-a': project({ title: 'A', status: 'decide', tasks: ['w1'] }), 'sec-b': project({ title: 'B', status: 'done', tasks: ['w2'] }) },
    });
    expect(o.sections!.map((s) => [s.id, s.rows.map((r) => r.id)])).toEqual([['sec-b', ['w2']], ['sec-a', ['w1']], [REST_DONE_SECTION_ID, ['w3']]]);
    // The state groups and the counts are the same picture, read the other way.
    expect(o.groups.map((g) => g.id)).toEqual(['needs', 'open', 'done']);
    expect(o).toMatchObject({ members: 3, open: 2, done: 1, attention: 1 });
    expect(buildTeamOverview({ ...base, elements: NO_ELEMENTS }).sections).toBeNull();
    expect(buildTeamOverview({ ...base, elements: NO_ELEMENTS, projects: {} }).sections).toBeNull();
  });
});

describe('row words', () => {
  it('compactAgo drops "ago"', () => {
    expect(compactAgo('3m ago')).toBe('3m');
    expect(compactAgo('just now')).toBe('now');
    expect(compactAgo('')).toBe('');
  });

  it('the tooltip tells the whole story', () => {
    const r = { ...row('a1', { depth: 2, parentId: 'a', now: 'Waiting for approval: Bash', badge: { label: 'Waiting', tone: 'red' as const }, openSubtasks: 2, place: 'Lighthouse' }), indent: 0, under: 'Area A' };
    expect(rowTooltip(r, { when: 'Oct 2, 11:58' })).toBe([
      'Task a1', 'Waiting · Waiting for approval: Bash', 'Under Area A', 'In project Lighthouse', 'Leads 2 open subtasks', 'Last change Oct 2, 11:58',
    ].join('\n'));
  });
});
