/**
 * The Board's Overview (BoardOverview.tsx): the team under the board's owner,
 * each task's live state, sorted into the groups a lead reads first. Pure: no
 * React, no DOM. Unit-pinned in tests/web/board-overview-model.test.ts.
 *
 * The team is the owner's subtree (`parent_task_id`), walked with a seen set and
 * a depth cap so a corrupt cyclic chain cannot loop. Every row lands in ONE
 * group, by the first rule that holds:
 *
 *   Done     the task is complete
 *   Needs you a permission prompt, then a session error, then NEED_ACTION, then
 *            unread output (the last two only while no turn runs), then a board
 *            signal (an unanswered choice, a due reminder, a thread with a new
 *            message) for the task, running or not
 *   Running  the session is running a turn
 *   Open     everything else (idle, stopped, no session, WAITING)
 *
 * Needs you sorts by that reason order, every group then by the latest status
 * change, newest first. Inside a group a row whose parent is in the same group
 * follows it, indented; one whose parent sits elsewhere says whom it is under.
 */
import type { Task } from '@open-walnut/core';
import type { BoardChoice, BoardMessage, BoardReminder, BoardSeen } from './board-model';
import { reminderDue } from './board-items-model';
import { PHASE_LABELS, deriveDisplayStatus, resolveTaskSessionId, taskCircleClass } from '@/utils/session-status';
import { subtaskPlaceLabel, subtasksOf } from '@/components/tasks/subtask-index';
import type { ProcessStatus } from '@/types/session';

/** Levels walked below the owner. Sessions nest at most 3 (MAX_SUBTASK_DEPTH); humans may nest deeper. */
export const TEAM_DEPTH_CAP = 8;
/** Indentation stops here: deeper rows say whom they are under instead. */
export const INDENT_CAP = 2;

/** What the session-status store knows of a task's session (StoredSessionStatus, or the task's enrichment). */
export interface LiveStatus {
  process_status?: string;
  activity?: string | null;
  errorMessage?: string | null;
  pendingPermissionTool?: string | null;
  statusUpdatedAt?: string | null;
}

export type OverviewGroupId = 'needs' | 'running' | 'open' | 'done';
export type NeedReason = 'permission' | 'error' | 'need-action' | 'unread' | 'board';
export type BadgeTone = 'red' | 'green' | 'amber' | 'grey' | 'violet';

/** Needs you, most urgent first. */
export const REASON_RANK: Record<NeedReason, number> = {
  permission: 0, error: 1, 'need-action': 2, unread: 3, board: 4,
};

export const GROUP_ORDER: readonly OverviewGroupId[] = ['needs', 'running', 'open', 'done'];
export const GROUP_LABELS: Record<OverviewGroupId, string> = {
  needs: 'Needs you', running: 'Running', open: 'Open', done: 'Done',
};

export interface TeamMember {
  task: Task;
  /** 1 = a direct subtask of the owner. */
  depth: number;
  parentId: string;
}

/** The owner's subtree, depth first, each task once; nothing below `maxDepth`. */
export function walkTeam(
  ownerId: string,
  childrenOf: (id: string) => readonly Task[],
  maxDepth = TEAM_DEPTH_CAP,
): TeamMember[] {
  const out: TeamMember[] = [];
  const seen = new Set<string>([ownerId]);
  const visit = (parentId: string, depth: number) => {
    if (depth > maxDepth) return;
    for (const child of childrenOf(parentId)) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      out.push({ task: child, depth, parentId });
      visit(child.id, depth + 1);
    }
  };
  visit(ownerId, 1);
  return out;
}

/**
 * Children by `parent_task_id`, through the store's prefix index (subtasksOf).
 * That index only knows parents that are in the list, so an owner the store
 * does not hold (a leader finished long ago and not loaded) is matched directly.
 */
export function teamChildren(tasks: readonly Task[], ownerId: string): (id: string) => readonly Task[] {
  if (tasks.some((t) => t.id === ownerId)) return (id) => subtasksOf(tasks, id);
  const direct = tasks.filter((t) => !!t.parent_task_id && ownerId.startsWith(t.parent_task_id));
  return (id) => (id === ownerId ? direct : subtasksOf(tasks, id));
}

export function isDoneTask(t: Pick<Task, 'phase' | 'status'>): boolean {
  return t.phase === 'COMPLETE' || t.status === 'done';
}

// ── Board signals ──

/** A `<walnut-choice>` or `<walnut-thread>` on the page, as the host parsed it. */
export interface BoardElement {
  id: string;
  title: string;
  /** The `task` attribute as written (may be a prefix of an id), '' when absent. */
  task: string;
}

export interface BoardElements {
  choices: BoardElement[];
  threads: BoardElement[];
}

export const NO_BOARD_ELEMENTS: BoardElements = { choices: [], threads: [] };

export type BoardSignalKind = 'reminder' | 'choice' | 'thread';

/** Something on the page that waits for the user, filed under the task it is about. */
export interface BoardSignal {
  kind: BoardSignalKind;
  /** The element's id (a choice id or a thread id). */
  id: string;
  title: string;
  taskId: string;
  /** New messages, for a thread; 1 otherwise. */
  count: number;
}

const SIGNAL_RANK: Record<BoardSignalKind, number> = { reminder: 0, choice: 1, thread: 2 };

export interface BoardSignalInput {
  choices: Record<string, BoardChoice>;
  reminders: Record<string, BoardReminder>;
  threads: Record<string, BoardMessage[]>;
}

/** The team member a `task` attribute names (exact id, else the one id it is a prefix of), '' when none. */
function memberOf(ref: string, ownerId: string, teamIds: ReadonlySet<string>): string {
  if (!ref) return '';
  if (ref === ownerId || teamIds.has(ref)) return ref;
  if (ref.length < 4) return '';
  if (ownerId.startsWith(ref)) return ownerId;
  let hit = '';
  for (const id of teamIds) {
    if (!id.startsWith(ref)) continue;
    if (hit) return ''; // ambiguous: a guess, not a ref
    hit = id;
  }
  return hit;
}

/**
 * What waits for the user on the page, in the frame's own rules: a choice with
 * no answer, a reminder that is due (it replaces the plain choice signal), a
 * thread with messages newer than this browser read (never the user's own).
 * Only elements the page shows count. Each goes to the task its `task`
 * attribute names when that task is in the team, else (a thread) to the team
 * member who wrote the newest unread message, else to the owner.
 */
export function boardSignals(
  elements: BoardElements,
  data: BoardSignalInput | null,
  seen: BoardSeen,
  ownerId: string,
  teamIds: ReadonlySet<string>,
  now = Date.now(),
): BoardSignal[] {
  if (!data) return [];
  const out: BoardSignal[] = [];
  const byId = new Map<string, BoardElement>();
  for (const el of [...elements.choices, ...elements.threads]) if (el.id && !byId.has(el.id)) byId.set(el.id, el);
  const owned = (el: BoardElement) => memberOf(el.task, ownerId, teamIds) || ownerId;

  const due = new Set<string>();
  for (const [target, reminder] of Object.entries(data.reminders)) {
    const el = byId.get(target);
    if (!el || !reminderDue(reminder, now)) continue;
    due.add(target);
    out.push({ kind: 'reminder', id: target, title: el.title, taskId: owned(el), count: 1 });
  }
  const seenChoice = new Set<string>();
  for (const el of elements.choices) {
    if (!el.id || seenChoice.has(el.id)) continue;
    seenChoice.add(el.id);
    if (data.choices[el.id] || due.has(el.id)) continue;
    out.push({ kind: 'choice', id: el.id, title: el.title, taskId: owned(el), count: 1 });
  }
  const seenThread = new Set<string>();
  for (const el of elements.threads) {
    if (!el.id || seenThread.has(el.id)) continue;
    seenThread.add(el.id);
    const read = seen[el.id] ?? '';
    const fresh = (data.threads[el.id] ?? []).filter((m) => m.author !== 'user' && m.ts > read);
    if (fresh.length === 0) continue;
    let taskId = memberOf(el.task, ownerId, teamIds);
    if (!taskId) {
      const newest = fresh.reduce((a, b) => (b.ts > a.ts ? b : a));
      const author = newest.author.startsWith('task:') ? newest.author.slice(5) : '';
      taskId = author && teamIds.has(author) ? author : ownerId;
    }
    out.push({ kind: 'thread', id: el.id, title: el.title, taskId, count: fresh.length });
  }
  return out.sort((a, b) => SIGNAL_RANK[a.kind] - SIGNAL_RANK[b.kind]);
}

/** One signal in the row's words. */
export function signalText(s: BoardSignal): string {
  const name = s.title || s.id;
  if (s.kind === 'reminder') return `Reminder due: ${name}`;
  if (s.kind === 'choice') return `Choice on the page: ${name}`;
  return `${s.count} new ${s.count === 1 ? 'message' : 'messages'} in ${name}`;
}

/** The row's summary of its signals: the first one, and how many more. */
export function signalsText(signals: readonly BoardSignal[]): string {
  if (signals.length === 0) return '';
  const more = signals.length - 1;
  return more > 0 ? `${signalText(signals[0])} (+${more} more)` : signalText(signals[0]);
}

// ── One row's state ──

export interface RowBadge {
  label: string;
  tone: BadgeTone;
}

export interface RowState {
  group: OverviewGroupId;
  reason: NeedReason | null;
  badge: RowBadge;
  /** The grey "now" line: what it does, what it waits on, or why it needs you ('' = nothing to say). */
  now: string;
  /** ISO time of the latest status change ('' when unknown). */
  at: string;
  running: boolean;
}

export interface DescribeOptions {
  /** How a WAITING task's `wait_until` reads ("Fri 9:00"). */
  formatWaitUntil?: (iso: string) => string;
}

function permissionText(tool: string): string {
  if (tool === 'AskUserQuestion') return 'Asked you a question';
  if (tool === 'ExitPlanMode') return 'Plan waiting for your approval';
  return `Waiting for approval: ${tool}`;
}

function activityText(activity: string | null | undefined): string {
  const a = (activity ?? '').trim();
  return a ? a.charAt(0).toUpperCase() + a.slice(1) : 'Working';
}

function latest(...stamps: Array<string | null | undefined>): string {
  let best = '';
  let bestMs = -Infinity;
  for (const s of stamps) {
    if (!s) continue;
    const ms = Date.parse(s);
    if (Number.isFinite(ms) && ms > bestMs) { best = s; bestMs = ms; }
  }
  return best;
}

/**
 * A task's group, reason, badge and "now" line. `live` is the session-status
 * store's record for its session (the task's enrichment when the store has none).
 *
 * The badge is the LIVE state: the session's (Waiting when a prompt is open,
 * then Error, Running, Idle, Stopped), a WAITING task's Waiting, else the phase
 * of a task with no session.
 */
export function describeTask(
  task: Task,
  live: LiveStatus | null,
  signals: readonly BoardSignal[],
  opts: DescribeOptions = {},
): RowState {
  const done = isDoneTask(task);
  const hasSession = !!resolveTaskSessionId(task);
  const ps = (hasSession ? live?.process_status : undefined) as ProcessStatus | undefined;
  const tool = live?.pendingPermissionTool || '';
  const display = ps ? deriveDisplayStatus(ps, tool ? { requestId: tool } : null) : null;
  const running = display === 'running';
  const at = latest(
    hasSession ? live?.statusUpdatedAt : null,
    task.phase_changed_at,
    task.last_session_update,
    done ? task.completed_at : null,
  ) || task.updated_at || '';

  if (done) return { group: 'done', reason: null, badge: { label: 'Done', tone: 'green' }, now: '', at, running: false };

  const badge: RowBadge = display === 'waiting' ? { label: 'Waiting', tone: 'red' }
    : display === 'error' ? { label: 'Error', tone: 'red' }
      : display === 'running' ? { label: 'Running', tone: 'green' }
        : task.phase === 'WAITING' ? { label: 'Waiting', tone: 'violet' }
          : display === 'idle' ? { label: 'Idle', tone: 'amber' }
            : display === 'stopped' ? { label: 'Stopped', tone: 'grey' }
              : {
                label: PHASE_LABELS[task.phase] ?? task.phase,
                tone: task.phase === 'NEED_ACTION' ? 'red' : task.phase === 'IN_PROGRESS' ? 'amber' : 'grey',
              };

  let reason: NeedReason | null = null;
  if (display === 'waiting') reason = 'permission';
  else if (display === 'error') reason = 'error';
  else if (!running && task.phase === 'NEED_ACTION') reason = 'need-action';
  else if (!running && task.unread) reason = 'unread';
  else if (signals.length > 0) reason = 'board';

  const board = signalsText(signals);
  const withBoard = (text: string) => (board && reason !== 'board' ? `${text} · ${board}` : text);
  let now = '';
  if (reason === 'permission') now = withBoard(permissionText(tool));
  else if (reason === 'error') now = withBoard(live?.errorMessage?.trim() || 'The session stopped on an error');
  else if (reason === 'need-action') now = withBoard('Handed back to you');
  else if (reason === 'unread') now = withBoard('New output you have not read');
  else if (reason === 'board') now = running ? `${board} · ${activityText(live?.activity)}` : board;
  else if (running) now = activityText(live?.activity);
  else if (task.phase === 'WAITING') {
    now = task.wait_until
      ? `Until ${(opts.formatWaitUntil ?? ((iso: string) => new Date(iso).toLocaleString()))(task.wait_until)}`
      : 'Until something happens';
  } else if (!hasSession && task.phase === 'TODO') now = 'Not started';

  const group: OverviewGroupId = reason ? 'needs' : running ? 'running' : 'open';
  return { group, reason, badge, now, at, running };
}

// ── The whole overview ──

export interface OverviewRow extends RowState {
  id: string;
  task: Task;
  /** The phase circle's class (taskCircleClass: grey, blue, blue pulsing, done). */
  circle: string;
  depth: number;
  parentId: string;
  signals: BoardSignal[];
  /** Open subtasks this task leads (a nested leader), counted in the team. */
  openSubtasks: number;
  /** The project, when the team spans projects and this one differs from the owner's ('' otherwise). */
  place: string;
}

export interface PlacedRow extends OverviewRow {
  /** Visual indent (0 … INDENT_CAP): this row's parent is the row above it, in the same group. */
  indent: number;
  /** The parent's title, for a nested row whose parent is not above it in this group ('' otherwise). */
  under: string;
}

export interface OverviewGroup {
  id: OverviewGroupId;
  label: string;
  rows: PlacedRow[];
}

export interface TeamOverview {
  ownerId: string;
  /** The owner's row; null when the store does not have the owner (deleted, or not loaded). */
  leader: OverviewRow | null;
  /** The non-empty groups, in GROUP_ORDER. */
  groups: OverviewGroup[];
  members: number;
  open: number;
  done: number;
  /** Rows (the leader's included) that need the user. */
  attention: number;
  signals: BoardSignal[];
}

export interface OverviewInput {
  ownerId: string;
  /** The store's row for the owner, when it has one. */
  owner: Task | null;
  childrenOf: (id: string) => readonly Task[];
  statusOf: (task: Task) => LiveStatus | null;
  elements: BoardElements;
  board: BoardSignalInput | null;
  seen: BoardSeen;
  now?: number;
  formatWaitUntil?: (iso: string) => string;
}

function stampMs(iso: string): number {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? ms : -Infinity;
}

/** Needs-you reason first, then the latest status change, newest first; an unknown time last. */
function compareRows(a: OverviewRow, b: OverviewRow): number {
  const ra = a.reason ? REASON_RANK[a.reason] : 9;
  const rb = b.reason ? REASON_RANK[b.reason] : 9;
  if (ra !== rb) return ra - rb;
  const ta = stampMs(a.at);
  const tb = stampMs(b.at);
  if (ta === tb) return 0;
  return tb > ta ? 1 : -1;
}

/** One group's rows in reading order (see the module comment). Stable for equal keys. */
export function orderGroup(rows: readonly OverviewRow[], titleOf: (id: string) => string): PlacedRow[] {
  const ids = new Set(rows.map((r) => r.id));
  const kids = new Map<string, OverviewRow[]>();
  const roots: OverviewRow[] = [];
  for (const r of rows) {
    if (ids.has(r.parentId)) {
      const list = kids.get(r.parentId);
      if (list) list.push(r); else kids.set(r.parentId, [r]);
    } else roots.push(r);
  }
  const out: PlacedRow[] = [];
  const placed = new Set<string>();
  const emit = (r: OverviewRow, level: number) => {
    if (placed.has(r.id)) return;
    placed.add(r.id);
    out.push({ ...r, indent: Math.min(level, INDENT_CAP), under: level === 0 && r.depth > 1 ? titleOf(r.parentId) : '' });
    for (const c of [...(kids.get(r.id) ?? [])].sort(compareRows)) emit(c, level + 1);
  };
  for (const r of [...roots].sort(compareRows)) emit(r, 0);
  return out;
}

export function buildTeamOverview(input: OverviewInput): TeamOverview {
  const { ownerId, owner, childrenOf, statusOf } = input;
  const members = walkTeam(ownerId, childrenOf);
  const teamIds = new Set(members.map((m) => m.task.id));
  const signals = boardSignals(input.elements, input.board, input.seen, ownerId, teamIds, input.now);
  const signalsOf = new Map<string, BoardSignal[]>();
  for (const s of signals) {
    const list = signalsOf.get(s.taskId);
    if (list) list.push(s); else signalsOf.set(s.taskId, [s]);
  }
  const titles = new Map<string, string>(members.map((m) => [m.task.id, m.task.title]));
  if (owner) titles.set(ownerId, owner.title);
  const spans = new Set([owner?.project ?? '', ...members.map((m) => m.task.project ?? '')]
    .map((p) => p.trim().toLowerCase())).size > 1;
  const opts: DescribeOptions = { formatWaitUntil: input.formatWaitUntil };

  const rowOf = (task: Task, depth: number, parentId: string): OverviewRow => {
    const own = signalsOf.get(task.id) ?? [];
    const live = statusOf(task);
    return {
      ...describeTask(task, live, own, opts),
      circle: taskCircleClass(task, live),
      id: task.id,
      task,
      depth,
      parentId,
      signals: own,
      openSubtasks: childrenOf(task.id).filter((c) => teamIds.has(c.id) && !isDoneTask(c)).length,
      place: spans && depth > 0 ? subtaskPlaceLabel(task, owner?.project) : '',
    };
  };

  const rows = members.map((m) => rowOf(m.task, m.depth, m.parentId));
  const leader = owner ? rowOf(owner, 0, '') : null;
  const titleOf = (id: string) => titles.get(id) ?? '';
  const groups: OverviewGroup[] = [];
  for (const id of GROUP_ORDER) {
    const inGroup = rows.filter((r) => r.group === id);
    if (inGroup.length) groups.push({ id, label: GROUP_LABELS[id], rows: orderGroup(inGroup, titleOf) });
  }
  const done = rows.filter((r) => r.group === 'done').length;
  const needs = rows.filter((r) => r.group === 'needs').length;
  return {
    ownerId,
    leader,
    groups,
    members: rows.length,
    open: rows.length - done,
    done,
    attention: needs + (leader?.group === 'needs' ? 1 : 0),
    signals,
  };
}

/** "12 open · 30 done", with "No workers yet" for an empty team. */
export function rollupText(o: Pick<TeamOverview, 'members' | 'open' | 'done'>): string {
  if (o.members === 0) return 'No workers yet';
  return `${o.open} open · ${o.done} done`;
}

/** Done share of the team, 0-100, rounded. */
export function donePercent(o: Pick<TeamOverview, 'members' | 'done'>): number {
  return o.members ? Math.round((o.done / o.members) * 100) : 0;
}

/** A row's time, short: "now", "3m", "2h", "4d", "3w", "5mo" ('' for no time). */
export function compactAgo(ago: string): string {
  if (!ago) return '';
  if (ago === 'just now') return 'now';
  return ago.replace(/ ago$/, '');
}

/** The row's hover text: the whole story in one place (the narrow pane hides the "now" line). */
export function rowTooltip(r: PlacedRow | OverviewRow, opts: { when?: string } = {}): string {
  const lines = [r.task.title];
  const state = r.now ? `${r.badge.label} · ${r.now}` : r.badge.label;
  lines.push(state);
  if ('under' in r && r.under) lines.push(`Under ${r.under}`);
  if (r.place) lines.push(`In project ${r.place}`);
  for (const s of r.signals.slice(1)) lines.push(signalText(s));
  if (r.openSubtasks > 0) lines.push(`Leads ${r.openSubtasks} open ${r.openSubtasks === 1 ? 'subtask' : 'subtasks'}`);
  if (opts.when) lines.push(`Last change ${opts.when}`);
  return lines.join('\n');
}
