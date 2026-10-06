/**
 * The kanban view models (web/src/components/board/kanban/kanban-card-model.ts,
 * kanban-model.ts, kanban-time.ts): the 6 item 3 status table (C15, C57), the
 * attention count (C14, C71), lane order (C67, C80), rollup and workers (C31,
 * C93), the summary choice (C70), plain text (C94), stale (C29, C87) and the
 * one time format (C83).
 */
import { describe, expect, it } from 'vitest';
import type { Task } from '@open-walnut/core';
import { templateLanes, type BoardCard } from '../../src/core/boards/board-lanes';
import { buildCardVM, type KanbanCardInput, type KanbanLive } from '../../web/src/components/board/kanban/kanban-card-model';
import { buildBoardVM, orderLane, teamAttention } from '../../web/src/components/board/kanban/kanban-model';
import { KANBAN_TIME_RE, absoluteText, agoText, clockText, durationText, waitText } from '../../web/src/components/board/kanban/kanban-time';

const NOW = Date.parse('2026-10-03T15:30:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
const LANES = templateLanes('triage');

let seq = 0;
function mkTask(p: Partial<Task> = {}): Task {
  seq++;
  return {
    id: p.id ?? `t${String(seq).padStart(4, '0')}-0000-4000-8000-000000000000`,
    title: `Ticket ${seq}`, status: 'in_progress', priority: 'none', category: '', session_ids: [], description: '',
    summary: '', note: '', phase: 'IN_PROGRESS', source: 'local', created_at: ago(5 * DAY), updated_at: ago(HOUR),
    phase_changed_at: ago(HOUR), ...p,
  } as Task;
}

const withSession = (p: Partial<Task> = {}) => mkTask({ session_id: `s-${seq + 1}-full-session-id`, session_ids: [`s-${seq + 1}-full-session-id`], ...p });

function vm(task: Task | null, live: KanbanLive | null = null, extra: Partial<KanbanCardInput> = {}) {
  return buildCardVM({
    taskId: task?.id ?? 'missing-task-id', task, lanes: LANES, live, ownerId: 'owner-task-id',
    titleOf: (id) => (id === 'owner-task-id' ? 'Payments resolver group triage' : `Task ${id.slice(0, 4)}`),
    hasBaseline: false, now: NOW, formatWaitUntil: () => 'Fri 9:00', ...extra,
  });
}

describe('status line (C15, C57)', () => {
  it('prompts: question, plan, a tool with its command in the tooltip', () => {
    const t = withSession();
    const q = vm(t, { process_status: 'running', pendingPermissionTool: 'AskUserQuestion' });
    expect([q.status.text, q.status.tone, q.needsYou]).toEqual(['Needs you: question', 'red', true]);
    // N24: the tooltip says what it is and how to answer; with the question's text, the text.
    expect(q.status.tooltip).toBe('Needs you: a worker asked a question. Click to read it and answer.');
    const qd = vm(t, { process_status: 'running', pendingPermissionTool: 'AskUserQuestion', pendingPermissionDetail: 'Roll back the gateway config?' });
    expect(qd.status.tooltip).toBe('Question: Roll back the gateway config?');
    expect(vm(t, { process_status: 'idle', pendingPermissionTool: 'ExitPlanMode' }).status.text).toBe('Needs you: approve plan');
    const b = vm(t, { process_status: 'running', pendingPermissionTool: 'Bash', pendingPermissionDetail: 'kubectl get pods -n checkout',
      pendingPermissionRequestId: 'req-1', sessionId: 's-live' });
    expect(b.status.text).toBe('Needs you: approve Bash');
    expect(b.status.tooltip).toBe('Bash: kubectl get pods -n checkout');
    expect(b.status.prompt).toEqual({ sessionId: 's-live', requestId: 'req-1', toolName: 'Bash', detail: 'kubectl get pods -n checkout' });
  });

  it('error: the first line, or the fallback', () => {
    const t = withSession();
    expect(vm(t, { process_status: 'error', errorMessage: '\nAPI overloaded\nretry later' }).status).toMatchObject({ text: 'Error: API overloaded', tone: 'red' });
    expect(vm(t, { process_status: 'error' }).status.text).toBe('Error: the session stopped');
  });

  it('a hand back is red, a plain turn end is amber and not counted', () => {
    const handed = withSession({ phase: 'NEED_ACTION', last_session_update: ago(2 * HOUR) });
    const card: BoardCard = { handed_back_at: ago(HOUR) };
    const h = vm(handed, { process_status: 'idle', statusUpdatedAt: ago(50 * MIN) }, { card });
    expect([h.status.text, h.status.tone, h.needsYou]).toEqual(['Needs you: handed back', 'red', true]);
    // A message after the hand back: the next turn end is a plain one again.
    const again = vm({ ...handed, last_session_update: ago(30 * MIN) }, { process_status: 'idle' }, { card });
    expect(again.status.kind).toBe('turn-ended');
    const ended = vm(withSession({ phase: 'NEED_ACTION', phase_changed_at: ago(12 * MIN) }), { process_status: 'idle' });
    expect([ended.status.text, ended.status.tone, ended.needsYou]).toEqual(['Turn ended 12m ago', 'amber', false]);
  });

  it('board signal, worker below, task still open', () => {
    const t = withSession();
    const s = vm(t, { process_status: 'idle' }, { signals: [{ kind: 'choice', id: 'c1', title: 'Roll back?', taskId: t.id, count: 1 }] });
    expect(s.status).toMatchObject({ text: 'Needs you: 1 unanswered choice', tone: 'red', signalTarget: { kind: 'choice', id: 'c1' } });
    const n = vm(t, { process_status: 'idle' }, { nested: { taskId: 'nested-id', title: 'Nested probe', text: 'Needs you: approve Bash',
      prompt: { sessionId: 's-n', toolName: 'Bash' } } });
    expect(n.status).toMatchObject({ text: 'Needs you: worker below', prompt: { sessionId: 's-n', fromTaskId: 'nested-id', fromTitle: 'Nested probe' } });
    const open = vm(t, { process_status: 'idle' }, { card: { lane: 'resolved', lane_at: ago(MIN), lane_by: 'human' } });
    expect([open.status.text, open.status.tone, open.lane]).toEqual(['Task still open', 'amber', 'resolved']);
  });

  it('running, waiting, done, idle, stopped, no session', () => {
    expect(vm(withSession(), { process_status: 'running', activity: 'reading logs' }).status).toMatchObject({ text: 'Running: Reading logs', tone: 'green' });
    expect(vm(withSession(), { process_status: 'running' }).status.text).toBe('Running');
    expect(vm(mkTask({ phase: 'WAITING', wait_until: new Date(NOW + DAY).toISOString() })).status).toMatchObject({ text: 'Waiting until Fri 9:00', tone: 'violet' });
    expect(vm(mkTask({ phase: 'WAITING' })).status.text).toBe('Waiting');
    expect(vm(mkTask({ phase: 'COMPLETE', completed_at: ago(2 * DAY) })).status).toMatchObject({ text: 'Done 2d ago', tone: 'green' });
    expect(vm(mkTask({ phase: 'COMPLETE', completed_at: ago(5_000) })).status.text).toBe('Done just now');
    expect(vm(withSession(), { process_status: 'idle', statusUpdatedAt: ago(2 * HOUR) }).status).toMatchObject({ text: 'Idle 2h ago', tone: 'amber' });
    expect(vm(withSession(), { process_status: 'stopped' }).status).toMatchObject({ text: 'Stopped', tone: 'grey' });
    expect(vm(mkTask({ phase: 'TODO' })).status).toMatchObject({ text: 'No session', tone: 'grey', kind: 'no-session' });
  });

  it('a task the store has not delivered is a loading card that keeps its lane', () => {
    const l = vm(null, null, { entry: { id: 'missing-task-id', phase: 'COMPLETE', completed_at: ago(9 * DAY) } });
    expect([l.loading, l.lane, l.status.kind]).toEqual([true, 'resolved', 'loading']);
  });
});

describe('lane order (C67, C80) and attention (C14, C71)', () => {
  it('unranked first: needs you, sev ascending (none last), created old to new; then ranked by rank', () => {
    const c = (taskId: string, p: { rank?: number; needsYou?: boolean; sev?: string; createdAt: string }) =>
      ({ taskId, doneAt: '', needsYou: false, ...p });
    const order = orderLane([
      c('ranked-2', { rank: 2, createdAt: ago(9 * DAY) }),
      c('sev2-old', { sev: '2', createdAt: ago(4 * DAY) }),
      c('nosev', { createdAt: ago(9 * DAY) }),
      c('sev1', { sev: '1', createdAt: ago(1 * DAY) }),
      c('needs', { needsYou: true, sev: '2', createdAt: ago(1 * DAY) }),
      c('ranked-0', { rank: 0, createdAt: ago(1 * DAY) }),
      c('sev2-new', { sev: '2', createdAt: ago(2 * DAY) }),
    ], { kind: 'active' });
    expect(order).toEqual(['needs', 'sev1', 'sev2-old', 'sev2-new', 'nosev', 'ranked-0', 'ranked-2']);
  });

  it('a done lane is newest first by max(completed_at, lane_at), ranks ignored', () => {
    const order = orderLane([
      { taskId: 'a', rank: 0, needsYou: false, createdAt: ago(9 * DAY), doneAt: ago(3 * DAY) },
      { taskId: 'b', needsYou: false, createdAt: ago(9 * DAY), doneAt: ago(1 * DAY) },
      { taskId: 'c', needsYou: false, createdAt: ago(9 * DAY), doneAt: ago(2 * DAY) },
    ], { kind: 'done' });
    expect(order).toEqual(['b', 'c', 'a']);
  });

  it('a rank counts only in the lane it was given in', () => {
    const t = withSession();
    expect(vm(t, null, { card: { lane: 'mitigating', rank: 3, rank_lane: 'mitigating' } }).rank).toBe(3);
    expect(vm(t, null, { card: { lane: 'mitigating', rank: 3, rank_lane: 'investigating' } }).rank).toBeUndefined();
  });

  it('attention = red cards + the leader; unread alone never counts', () => {
    expect(teamAttention([{ needsYou: true, loading: false }, { needsYou: false, loading: false }, { needsYou: true, loading: true }], { needsYou: true })).toBe(2);
    const unread = vm(withSession({ unread: true }), { process_status: 'idle' });
    expect(unread.needsYou).toBe(false);
    expect(unread.foot.unread).toBe(true);
  });
});

describe('summary, plain text, waiting on (C70, C94, C35, C77)', () => {
  it('the newer summary wins and the tooltip says whose', () => {
    const t = withSession({ summary: 'Worker: **root cause** is the `retry` storm' });
    const card: BoardCard = { summary: 'Leader: mitigated', summary_at: '2026-10-03T09:00:00Z', summary_by: 'task:owner-task-id',
      worker_summary_at: '2026-10-03T14:00:00Z' };
    const w = vm(t, null, { card });
    expect(w.summary?.text).toBe('Worker: root cause is the retry storm');
    expect(w.summary?.tooltip).toMatch(/\n\nFrom the worker, \d{2}:\d{2}$/);
    const l = vm(t, null, { card: { ...card, summary_at: '2026-10-03T15:00:00Z' } });
    expect(l.summary?.text).toBe('Leader: mitigated');
    expect(l.summary?.tooltip).toMatch(/From the leader, \d{2}:\d{2}$/);
    expect(vm(mkTask()).summary).toBeUndefined();
  });

  it('waiting on shows only in a wait lane; parked when the task parked itself', () => {
    const t = mkTask({ phase: 'WAITING', wait_until: new Date(NOW + DAY).toISOString() });
    expect(vm(t).waiting).toEqual({ kind: 'parked', until: 'Fri 9:00' });
    const placed = vm(withSession(), null, { card: { lane: 'waiting-cr', lane_at: ago(MIN), lane_by: 'human' } });
    expect(placed.waiting).toEqual({ kind: 'add-who' });
    const text = vm(withSession(), null, { card: { lane: 'waiting-cr', lane_at: ago(MIN), lane_by: 'human', waiting_on: 'CR-48213' } });
    expect(text.waiting).toEqual({ kind: 'text', text: 'CR-48213' });
    const moved = vm(withSession(), null, { card: { lane: 'mitigating', lane_at: ago(MIN), lane_by: 'human', waiting_on: 'CR-48213' } });
    expect(moved.waiting).toBeUndefined();
  });
});

describe('stale (C29, C87)', () => {
  it('3 days without progress is Stale 3d; Waiting 3d in a wait lane', () => {
    const old = withSession({ phase: 'NEED_ACTION', phase_changed_at: ago(3 * DAY) });
    const s = vm(old, { process_status: 'idle', statusUpdatedAt: ago(3 * DAY) });
    expect(s.foot.stale).toBe('Stale 3d');
    const w = vm(old, { process_status: 'idle', statusUpdatedAt: ago(3 * DAY) }, { card: { lane: 'waiting-cr', lane_at: ago(HOUR), lane_by: 'human' } });
    expect(w.foot.stale).toBe('Waiting 3d');
  });

  it('a leader summary rewrite does not freshen a card; a worker summary does', () => {
    const old = withSession({ phase: 'NEED_ACTION', phase_changed_at: ago(3 * DAY) });
    const live: KanbanLive = { process_status: 'idle', statusUpdatedAt: ago(3 * DAY) };
    expect(vm(old, live, { card: { summary: 'x', summary_at: ago(MIN), summary_by: 'task:owner-task-id' } }).foot.stale).toBe('Stale 3d');
    expect(vm(old, live, { card: { worker_summary_at: ago(MIN) } }).foot.stale).toBeUndefined();
  });

  it('done, running and a WAITING task parked into the future are never stale', () => {
    expect(vm(mkTask({ phase: 'COMPLETE', completed_at: ago(9 * DAY), phase_changed_at: ago(9 * DAY) })).foot.stale).toBeUndefined();
    expect(vm(withSession({ phase_changed_at: ago(4 * DAY) }), { process_status: 'running', statusUpdatedAt: ago(4 * DAY) }).foot.stale).toBeUndefined();
    const parked = mkTask({ phase: 'WAITING', phase_changed_at: ago(4 * DAY), wait_until: new Date(NOW + DAY).toISOString() });
    expect(vm(parked).foot.stale).toBeUndefined();
    const overdue = mkTask({ phase: 'WAITING', phase_changed_at: ago(4 * DAY), wait_until: ago(DAY) });
    expect(vm(overdue).foot.stale).toBe('Waiting 4d');
  });
});

describe('the board view model: rollup, workers, chips (C31, C66, C93, C14)', () => {
  const OWNER = 'own00000-0000-4000-8000-000000000000';
  function team() {
    const owner = withSession({ id: OWNER, title: 'Payments resolver group triage' });
    const kid = (p: Partial<Task>) => mkTask({ parent_task_id: OWNER, tags: ['ticket:V1000000101', 'sev:2'], ...p });
    const kidS = (p: Partial<Task>) => withSession({ parent_task_id: OWNER, tags: ['sev:2'], ...p });
    const running = [0, 1, 2].map(() => kidS({}));
    const idle = [0, 1].map(() => kidS({ phase: 'NEED_ACTION' }));
    const perm = kidS({ tags: ['sev:1'] });
    const parkedNoSession = kid({ phase: 'WAITING', wait_until: new Date(NOW + DAY).toISOString() });
    const done = [0, 1, 2].map(() => kid({ phase: 'COMPLETE', completed_at: ago(DAY) }));
    const nestedParent = idle[0];
    const nested = withSession({ parent_task_id: nestedParent.id, title: 'Nested probe' });
    const all = [owner, ...running, ...idle, perm, parkedNoSession, ...done, nested];
    const oldDoneId = 'old00000-0000-4000-8000-000000000000'; // 9 days done: only the server's team list has it
    const live = new Map<string, KanbanLive>();
    for (const t of running) live.set(t.id, { process_status: 'running', activity: 'reading logs' });
    for (const t of idle) live.set(t.id, { process_status: 'idle', statusUpdatedAt: ago(HOUR) });
    live.set(perm.id, { process_status: 'running', pendingPermissionTool: 'Bash' });
    live.set(nested.id, { process_status: 'idle', pendingPermissionTool: 'Bash', sessionId: 's-nested' });
    const kids = all.filter((t) => t.parent_task_id === OWNER);
    const payload = {
      lanes_effective: templateLanes('triage'), cards: {}, kanban_seen: null,
      team: [...kids.map((t) => ({ id: t.id, phase: t.phase, ...(t.completed_at ? { completed_at: t.completed_at } : {}) })),
        { id: oldDoneId, phase: 'COMPLETE', completed_at: ago(9 * DAY) }],
    };
    const byId = new Map(all.map((t) => [t.id, t]));
    return buildBoardVM({
      ownerId: OWNER, owner, taskOf: (id) => byId.get(id), team: all, payload, liveOf: (t) => live.get(t.id) ?? null,
      now: NOW, titleOf: (id) => byId.get(id)?.title ?? '', formatWaitUntil: () => 'Fri 9:00',
    });
  }

  it('counts by lane kind, includes done tasks the store does not hold, rolls nested needs in once', () => {
    const b = team();
    expect(b.rollup.text).toBe('7 open · 4 done');
    expect(b.rollup.percent).toBe(36);
    expect(b.lanes.find((l) => l.lane.id === 'resolved')?.total).toBe(4);
    expect(b.cards['old00000-0000-4000-8000-000000000000'].loading).toBe(true);
    expect(b.rollup.workers.map((w) => w.text)).toEqual(['3 running', '1 waiting on your answer', '2 idle', '1 no session']);
    const sessionTotal = b.rollup.workers.filter((w) => w.key !== 'no-session').reduce((n, w) => n + w.n, 0);
    expect(sessionTotal + 1).toBe(b.rollup.open);
    expect(b.rollup.workers.find((w) => w.key === 'running')?.n).toBe(b.chips.running);
    // perm (red) + the idle parent of the nested prompt (worker below); the nested worker is no card of its own.
    expect(b.chips.needs).toBe(2);
    expect(b.attention).toBe(2);
    expect(Object.keys(b.cards)).toHaveLength(11);
    expect(b.sevChipShown).toBe(true);
    expect(b.chips.sev1).toBe(1);
    expect(b.lanes.map((l) => l.total)).toEqual([0, 6, 0, 1, 0, 4]);
    expect(b.lanes.find((l) => l.lane.id === 'investigating')?.needs).toBe(2);
    expect(b.changes).toEqual([]);
    expect(b.empty).toBe(false);
  });
});

describe('one time format (C83)', () => {
  it('verbs with units, ago only on relative times, no bare units', () => {
    const texts = [
      agoText('Idle', ago(2 * HOUR), NOW), agoText('Done', ago(2 * DAY), NOW), agoText('Turn ended', ago(12 * MIN), NOW),
      agoText('Active', ago(5 * MIN), NOW), agoText('Done', ago(1_000), NOW), durationText('Stale', ago(3 * DAY), NOW),
      durationText('Waiting', ago(3 * DAY), NOW), agoText('Active', ago(40 * DAY), NOW),
    ];
    expect(texts).toEqual(['Idle 2h ago', 'Done 2d ago', 'Turn ended 12m ago', 'Active 5m ago', 'Done just now', 'Stale 3d', 'Waiting 3d', 'Active 1mo ago']);
    for (const t of texts) expect(t).toMatch(KANBAN_TIME_RE);
    for (const bad of ['5m', 'Stale · 3d', 'Active 5m ago ago', 'idle 2h ago']) expect(bad).not.toMatch(KANBAN_TIME_RE);
    expect(agoText('Idle', undefined, NOW)).toBe('');
  });

  it('every time text a card renders matches', () => {
    const t = withSession({ phase: 'NEED_ACTION', phase_changed_at: ago(3 * DAY) });
    const c = vm(t, { process_status: 'idle', statusUpdatedAt: ago(3 * DAY) });
    for (const s of [c.status.text, c.foot.stale]) expect(s).toMatch(KANBAN_TIME_RE);
    expect(c.foot.activeTooltip.startsWith('Last activity ')).toBe(true);
    const fresh = vm(withSession({ phase: 'IN_PROGRESS', phase_changed_at: ago(5 * MIN) }), { process_status: 'idle', statusUpdatedAt: ago(5 * MIN) });
    expect(fresh.foot.activeText).toMatch(KANBAN_TIME_RE);
  });

  it('N11: a leader\'s lane write is not activity, and a stale card never also says Active', () => {
    const t = withSession({ phase: 'NEED_ACTION', phase_changed_at: ago(3 * DAY), last_session_update: ago(3 * DAY) });
    const card: BoardCard = { lane: 'mitigating', lane_at: ago(MIN), lane_by: 'task:owner-task-id', summary: 'Leader words', summary_at: ago(MIN), summary_by: 'task:owner-task-id' };
    const c = vm(t, { process_status: 'idle', statusUpdatedAt: ago(3 * DAY) }, { card });
    expect(c.foot.stale).toBe('Stale 3d');
    expect(c.foot.activeText).toBe('');
    const moving = vm(withSession({ phase: 'IN_PROGRESS', phase_changed_at: ago(2 * HOUR), last_session_update: ago(2 * HOUR) }),
      { process_status: 'idle', statusUpdatedAt: ago(2 * HOUR) }, { card });
    expect(moving.foot.activeText).toBe('Active 2h ago');
  });

  it('C12: a card completed after it was placed says why it shows in the done lane', () => {
    const t = withSession({ phase: 'COMPLETE', completed_at: ago(MIN) });
    const c = vm(t, null, { card: { lane: 'mitigating', lane_at: ago(HOUR), lane_by: 'human' } });
    expect([c.laneKind, c.completedAfterMove]).toEqual(['done', true]);
    expect(c.status.tooltip).toContain('Completed after it was placed in Mitigating, so it moved here');
    const back = vm(t, null, { card: { lane: 'mitigating', lane_at: ago(1_000), lane_by: 'human' } });
    expect([back.lane, back.completedAfterMove]).toEqual(['mitigating', false]);
    expect(back.status.tooltip).not.toContain('moved here');
  });

  it('clock: HH:MM today, weekday within the week, date before', () => {
    const today = new Date(NOW); today.setHours(9, 5, 0, 0);
    expect(clockText(today.toISOString(), NOW)).toBe('09:05');
    expect(clockText(ago(2 * DAY), NOW)).toMatch(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d{2}:\d{2}$/);
    expect(clockText(ago(20 * DAY), NOW)).toMatch(/^[A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}$/);
  });

  it('N12: a wait end and a tooltip use the same 24 hour clock as the change labels', () => {
    const at = (days: number, h: number, m: number) => { const d = new Date(NOW); d.setDate(d.getDate() + days); d.setHours(h, m, 0, 0); return d.toISOString(); };
    const later = new Date(NOW); later.setHours(23, 59, 0, 0);
    if (later.getTime() > NOW) expect(waitText(later.toISOString(), NOW)).toBe('Today 23:59');
    expect(waitText(at(1, 5, 45), NOW)).toBe('Tomorrow 05:45');
    expect(waitText(at(3, 17, 5), NOW)).toMatch(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) 17:05$/);
    expect(waitText(at(20, 9, 0), NOW)).toMatch(/^[A-Z][a-z]{2} \d{1,2} 09:00$/);
    expect(absoluteText(at(1, 17, 5))).not.toMatch(/AM|PM/);
    expect(absoluteText(at(1, 17, 5))).toContain('17:05');
  });
});

describe('round 4 fixes', () => {
  const base = { lane: 'investigating', summaryHash: '00000000', unread: false };
  it('R3-02: the user\'s own pending Complete moves the card, and it is not counted as changed', () => {
    const t = withSession({ phase: 'COMPLETE', completed_at: ago(MIN) });
    const auto = vm(t, null, { hasBaseline: true, baseline: { ...base, summaryHash: vm(t).snapshot.summaryHash }, baselineAt: ago(HOUR) });
    expect([auto.lane, auto.changed]).toEqual(['resolved', true]);
    const mine = vm(t, null, { hasBaseline: true, baseline: { ...base, summaryHash: vm(t).snapshot.summaryHash }, baselineAt: ago(HOUR), humanPhase: true });
    expect([mine.lane, mine.changed]).toEqual(['resolved', false]);
  });

  it('R3-03: a summary the list payload did not carry is neither a change nor stored as seen', () => {
    const t = withSession({ summary: undefined, has_summary: true } as Partial<Task>);
    const c = vm(t, null, { hasBaseline: true, baseline: { ...base, summaryHash: 'abcdef01' }, baselineAt: ago(HOUR) });
    expect(c.change?.items.some((x) => x.kind === 'summary') ?? false).toBe(false);
    expect(c.snapshot.summaryHash).toBe('811c9dc5');
    const read = vm({ ...t, summary: 'Rollback done.' }, null, { hasBaseline: true, baseline: { ...base, summaryHash: 'abcdef01' }, baselineAt: ago(HOUR) });
    expect(read.change?.items.find((x) => x.kind === 'summary')?.short).toBe('Summary by the worker');
  });
});
