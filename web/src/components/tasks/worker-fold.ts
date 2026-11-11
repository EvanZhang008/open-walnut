/**
 * Workers fold into their leader on the Home list (2026-11-11, the user picked design 2 of ten:
 * "我选二 ... 比较克制"). A worker is a task whose parent is a real leader: a task of the user's,
 * open, and no org node. A VP or Main never counts ("不要把 VP 算进去 ... 所有 task 都是 VP 下面的"),
 * so their tasks stay rows of their own.
 *
 * A folded worker is not a row: its leader's row carries it, as one summary line that opens
 * into a short tree. When the leader is not in this view (a Focus worker whose leader is not
 * in Focus), the worker still folds into it: the leader is drawn where the worker would have
 * been, as a quiet row that is there for its workers (the user: "即使他不在这个 focus 里面").
 *
 * The person can show one worker separately (a row of its own again), a whole team, or every
 * worker (the Display menu); each choice is a view choice, kept by view-memory, and never
 * changes the task itself. Pure; TodoPanel and StatusSections render the result.
 */
import type { Dispatch, SetStateAction } from 'react';
import type { Task } from '@open-walnut/core';
import { usePageView } from '@/utils/view-memory';
import { subtasksOf } from './subtask-index';
import { taskUserState } from '../../utils/session-status';
import { drawnSectionOf, type DrawnSectionKey } from './status-sections';

export interface WorkerFoldView {
  /** Workers fold into their leader (the default). Off: every worker is a row, as before. */
  fold: boolean;
  /** Leaders whose whole team is shown as rows. */
  teams: string[];
  /** Workers shown as rows of their own. */
  separate: string[];
  /** Leaders whose folded tree is open. */
  open: string[];
}

export const DEFAULT_WORKER_FOLD: WorkerFoldView = { fold: true, teams: [], separate: [], open: [] };

/** Each list keeps at most this many ids, the last written kept (a stale id costs nothing). */
export const WORKER_FOLD_IDS_MAX = 200;

const isIdList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

export function isWorkerFoldView(v: unknown): v is WorkerFoldView {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.fold === 'boolean' && isIdList(o.teams) && isIdList(o.separate) && isIdList(o.open);
}

/** `list` with `id` in or out, capped to the last WORKER_FOLD_IDS_MAX. */
export function withId(list: readonly string[], id: string, on: boolean): string[] {
  const rest = list.filter((x) => x !== id);
  return on ? [...rest, id].slice(-WORKER_FOLD_IDS_MAX) : rest;
}

function isDone(t: Task): boolean {
  return t.phase === 'COMPLETE' || t.status === 'done';
}

/** A task that can lead a folded team: open, and no VP or Main (org nodes). */
export function countsAsLeader(t: Task): boolean {
  return !t.org_role && !isDone(t);
}

const PARENTS = new WeakMap<readonly Task[], Map<string, Task>>();

/** Child id -> its parent task, read once per task array (parent refs may be id prefixes). */
function parentIndex(tasks: readonly Task[]): Map<string, Task> {
  let index = PARENTS.get(tasks);
  if (index) return index;
  index = new Map();
  for (const p of tasks) for (const c of subtasksOf(tasks, p.id)) if (!index.has(c.id)) index.set(c.id, p);
  PARENTS.set(tasks, index);
  return index;
}

/** The leader `t` folds into by its own parent link: its parent, when that counts as a leader. */
export function foldLeaderOf(tasks: readonly Task[], t: Task): Task | undefined {
  if (!t.parent_task_id || isDone(t)) return undefined;
  const p = parentIndex(tasks).get(t.id);
  return p && countsAsLeader(p) ? p : undefined;
}

/** True when `t` is no row of its own in this view: it folds into its leader. */
export function isFoldedWorker(tasks: readonly Task[], t: Task, view: WorkerFoldView): boolean {
  if (!view.fold) return false;
  const leader = foldLeaderOf(tasks, t);
  if (!leader) return false;
  return !view.teams.includes(leader.id) && !view.separate.includes(t.id);
}

/** The row that carries `t`: its leader, or that leader's own leader while the leader folds too. */
export function foldHostOf(tasks: readonly Task[], t: Task, view: WorkerFoldView): Task | undefined {
  let host = foldLeaderOf(tasks, t);
  const seen = new Set<string>([t.id]);
  while (host && !seen.has(host.id) && isFoldedWorker(tasks, host, view)) {
    seen.add(host.id);
    host = foldLeaderOf(tasks, host);
  }
  return host && !seen.has(host.id) ? host : undefined;
}

export interface FoldEntry {
  task: Task;
  depth: number;
  /** A row of its own in this view (shown separately, or in a section that never folds). */
  out: boolean;
}

export interface FoldedSections<K extends string> {
  /** Each section's rows, folded workers out and hosts placed. */
  rows: Record<K, Task[]>;
  /** Host id -> its workers in this view, in tree order (depth 0 = its own workers). */
  trees: Map<string, FoldEntry[]>;
  /** Leaders drawn only for their workers: not in this view themselves. */
  quiet: Set<string>;
  /** Leaders drawn above their own section, with their working team: id -> their own section. */
  movedFrom: Map<string, K>;
}

/** Sections that never fold: Watching was picked by hand, Needs you is the user's to act on, Completed is history. */
export const WORKER_FOLD_KEEP: ReadonlySet<string> = new Set(['watching', 'needs', 'done']);

const STATE_ORDER: Record<string, number> = { needs: 0, read: 0, working: 1, waiting: 2, done: 3 };

/**
 * Fold the sections' workers into their hosts. `sections` lists each section's rows in the
 * order they are drawn (the most active first); `keep` names the sections that never fold
 * (Watching was picked by hand, Needs you is the user's to act on, Completed is history).
 * A host carries its folded workers in the most active section among its own and theirs, so a
 * working worker never sinks into a folded Waiting section; a host the view does not hold is
 * drawn quiet in the place of its first folded worker.
 */
export function foldSections<K extends string>(
  tasks: readonly Task[],
  sections: readonly (readonly [K, readonly Task[]])[],
  view: WorkerFoldView,
  keep: ReadonlySet<string> = new Set(),
): FoldedSections<K> {
  const rows = {} as Record<K, Task[]>;
  const trees = new Map<string, FoldEntry[]>();
  const quiet = new Set<string>();
  const movedFrom = new Map<string, K>();
  if (!view.fold) {
    for (const [k, list] of sections) rows[k] = [...list];
    return { rows, trees, quiet, movedFrom };
  }
  const rank = new Map<K, number>(sections.map(([k], i) => [k, i]));
  const at = new Map<string, K>();
  for (const [k, list] of sections) for (const t of list) if (!at.has(t.id)) at.set(t.id, k);
  const folded = new Map<string, Task[]>();
  const shown = new Map<string, Task[]>();
  const firstAt = new Map<string, { k: K; before: string }>();
  const push = (m: Map<string, Task[]>, id: string, t: Task) => {
    const l = m.get(id);
    if (!l) m.set(id, [t]); else if (!l.some((x) => x.id === t.id)) l.push(t);
  };
  for (const [k, list] of sections) {
    for (const t of list) {
      if (at.get(t.id) !== k) continue;
      const host = foldHostOf(tasks, t, view);
      if (!host) continue;
      if (!keep.has(k) && isFoldedWorker(tasks, t, view)) {
        push(folded, host.id, t);
        if (!firstAt.has(host.id)) firstAt.set(host.id, { k, before: t.id });
      } else push(shown, host.id, t);
    }
  }
  // Where each host with folded workers is drawn: id -> section and the row it goes before.
  const place = new Map<string, { k: K; before: string }>();
  for (const [hostId, first] of firstAt) {
    const own = at.get(hostId);
    if (own === undefined) { quiet.add(hostId); place.set(hostId, first); continue; }
    if (keep.has(own) || (rank.get(own) ?? 0) <= (rank.get(first.k) ?? 0)) continue;
    movedFrom.set(hostId, own);
    place.set(hostId, first);
  }
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const before = new Map<string, Task[]>();
  for (const [hostId, p] of place) {
    const host = byId.get(hostId);
    if (host) push(before, p.before, host);
  }
  for (const [k, list] of sections) {
    const out: Task[] = [];
    for (const t of list) {
      for (const h of before.get(t.id) ?? []) if (place.get(h.id)?.k === k) out.push(h);
      if (place.has(t.id) && at.get(t.id) === k && !quiet.has(t.id)) continue; // moved up
      if (at.get(t.id) === k && !keep.has(k) && isFoldedWorker(tasks, t, view) && foldHostOf(tasks, t, view)) continue;
      out.push(t);
    }
    rows[k] = out;
  }
  const hosts = new Set<string>([...folded.keys(), ...shown.keys()]);
  for (const hostId of hosts) {
    // A host neither drawn nor carrying a folded worker has no row to hang a tree on.
    if (!at.has(hostId) && !quiet.has(hostId)) continue;
    const outIds = new Set((shown.get(hostId) ?? []).map((t) => t.id));
    const entries = treeOf(tasks, hostId, [...(folded.get(hostId) ?? []), ...(shown.get(hostId) ?? [])], view, outIds);
    if (entries.length) trees.set(hostId, entries);
  }
  return { rows, trees, quiet, movedFrom };
}

/** The workers as a tree under the host: a chain through a folded leader shows that leader too. */
function treeOf(tasks: readonly Task[], hostId: string, workers: readonly Task[], view: WorkerFoldView, outIds: ReadonlySet<string>): FoldEntry[] {
  const children = new Map<string, Task[]>();
  const add = (parentId: string, t: Task) => {
    const l = children.get(parentId);
    if (!l) children.set(parentId, [t]); else if (!l.some((x) => x.id === t.id)) l.push(t);
  };
  for (const w of workers) {
    let t: Task = w;
    let leader = foldLeaderOf(tasks, t);
    // Climb to the host, adding each folded leader on the way as a line of its own.
    for (let i = 0; leader && i < 16; i++) {
      add(leader.id, t);
      if (leader.id === hostId) break;
      if (!isFoldedWorker(tasks, leader, view)) break;
      t = leader;
      leader = foldLeaderOf(tasks, t);
    }
  }
  const order = (a: Task, b: Task) => (STATE_ORDER[taskUserState(a)] ?? 2) - (STATE_ORDER[taskUserState(b)] ?? 2);
  const out: FoldEntry[] = [];
  const seen = new Set<string>([hostId]);
  const walk = (id: string, depth: number) => {
    for (const c of [...(children.get(id) ?? [])].sort(order)) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      out.push({ task: c, depth, out: outIds.has(c.id) });
      walk(c.id, depth + 1);
    }
  };
  walk(hostId, 0);
  return out;
}

/** The user state's section, for a line that has none of its own (a tree line, a quiet leader). */
export function stateSectionKey(t: Task): DrawnSectionKey {
  return drawnSectionOf(t);
}

/** "1 needs you · 5 working · 3 waiting · 2 in the list": the host's workers by the state the user sees. */
export function foldMixLine(entries: readonly FoldEntry[]): string {
  const c = { needs: 0, working: 0, waiting: 0, notstarted: 0 };
  let out = 0;
  for (const e of entries) {
    const s = stateSectionKey(e.task);
    if (s === 'needs') c.needs++;
    else if (s === 'working') c.working++;
    else if (s === 'waiting') c.waiting++;
    else if (s === 'notstarted') c.notstarted++;
    if (e.out) out++;
  }
  const outWords = out === 0 ? '' : out === entries.length ? 'all in the list' : `${out} in the list`;
  return [c.needs && `${c.needs} need${c.needs === 1 ? 's' : ''} you`, c.working && `${c.working} working`, c.waiting && `${c.waiting} waiting`, c.notstarted && `${c.notstarted} not started`, outWords]
    .filter(Boolean).join(' · ');
}

/** The view, kept by view-memory (`open-walnut-view:home.workerFold`), the same in every mount. */
export function useWorkerFold(): [WorkerFoldView, Dispatch<SetStateAction<WorkerFoldView>>] {
  return usePageView('home', 'workerFold', DEFAULT_WORKER_FOLD, isWorkerFoldView);
}
