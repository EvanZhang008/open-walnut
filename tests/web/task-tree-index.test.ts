/**
 * The parent-link index behind the home task panel
 * (web/src/components/tasks/task-tree-index.ts) and the Leader pill
 * (web/src/components/tasks/subtask-index.ts).
 *
 * Both used to resolve `parent_task_id` (a full id or a short id prefix) with a
 * `find(startsWith)` scan per subtask over every task, on every task event. The
 * replacements must answer exactly what those scans answered, so each helper is
 * checked against the old code, kept here verbatim as the reference, on a board
 * the size of a real one: 6,578 tasks, 150 of them subtasks, with ambiguous
 * prefixes, orphans, nesting, children listed before their parents, a subtask
 * whose own id carries its reference, and cross-project subtasks.
 */
import { describe, expect, it } from 'vitest';
import type { Task } from '@open-walnut/core';
import {
  ParentRefMatcher,
  countSubtasksByParent,
  parentRefsOf,
  resolveParentRef,
  withSubtaskContext,
} from '../../web/src/components/tasks/task-tree-index';
import { subtasksOf } from '../../web/src/components/tasks/subtask-index';

// --- The old code, verbatim -------------------------------------------------

function refFind(list: readonly Task[], ref: string): Task | undefined {
  return list.find((t) => t.id.startsWith(ref));
}

function refCount(tasks: readonly Task[]): Map<string, number> {
  const countMap = new Map<string, number>();
  for (const task of tasks) {
    if (task.parent_task_id) {
      const parent = tasks.find((t) => t.id.startsWith(task.parent_task_id!));
      if (parent) countMap.set(parent.id, (countMap.get(parent.id) ?? 0) + 1);
    }
  }
  return countMap;
}

function sameProjectKey(a: string | undefined, b: string | undefined): boolean {
  return (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase();
}

function refContext(tasks: readonly Task[], matched: readonly Task[], eligible: (t: Task) => boolean): Task[] {
  const result = [...matched];
  const included = new Set<string>(matched.map((t) => t.id));
  let added = true;
  while (added) {
    added = false;
    for (const t of tasks) {
      if (included.has(t.id)) continue;
      if (!t.parent_task_id) continue;
      if (!eligible(t)) continue;
      const parentVisible = result.some((p) => p.id.startsWith(t.parent_task_id!) && sameProjectKey(p.project, t.project));
      if (parentVisible) {
        result.push(t);
        included.add(t.id);
        added = true;
      }
    }
  }
  return result;
}

function isDone(t: Task): boolean {
  return t.phase === 'COMPLETE' || t.status === 'done';
}

function refBuildIndex(tasks: readonly Task[]): Map<string, Task[]> {
  const byPrefix = new Map<string, Task[]>();
  for (const t of tasks) {
    if (!t.parent_task_id) continue;
    const list = byPrefix.get(t.parent_task_id);
    if (list) list.push(t); else byPrefix.set(t.parent_task_id, [t]);
  }
  const index = new Map<string, Task[]>();
  if (byPrefix.size === 0) return index;
  for (const parent of tasks) {
    let children: Task[] | undefined;
    for (const [prefix, list] of byPrefix) {
      if (!parent.id.startsWith(prefix)) continue;
      children = children ? children.concat(list) : list.slice();
    }
    if (!children) continue;
    children.sort((a, b) => Number(isDone(a)) - Number(isDone(b)));
    index.set(parent.id, children);
  }
  return index;
}

// --- A realistic board --------------------------------------------------------

/** Deterministic PRNG (mulberry32), so a failure reproduces. */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function task(over: Partial<Task> & { id: string }): Task {
  return { title: over.id, project: 'Walnut', phase: 'TODO', status: 'todo', created_at: '', updated_at: '', ...over } as unknown as Task;
}

const PROJECTS = ['Walnut', 'walnut ', 'Ops', 'Home', 'Garden', 'Reading', 'Travel', 'Health', 'Taxes', ''];
const TOTAL = 6578;
const SUBTASKS = 150;

/** Ids shaped like the store's: base36 milliseconds, a dash, four hex digits. */
function buildBoard(seed: number): Task[] {
  const rand = rng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
  let ms = 1_700_000_000_000;
  const tops: Task[] = [];
  for (let i = 0; i < TOTAL - SUBTASKS; i++) {
    // Every 40th task shares its millisecond with the previous one, so its
    // 8-character prefix is ambiguous.
    if (i % 40 !== 0) ms += 1 + Math.floor(rand() * 5000);
    const id = `${ms.toString(36)}-${Math.floor(rand() * 0xffff).toString(16).padStart(4, '0')}`;
    const done = rand() < 0.6;
    tops.push(task({ id, project: pick(PROJECTS), phase: done ? 'COMPLETE' : 'TODO', status: done ? 'done' : 'todo' }));
  }
  const subs: Task[] = [];
  for (let i = 0; i < SUBTASKS - 1; i++) {
    ms += 1 + Math.floor(rand() * 5000);
    const id = `${ms.toString(36)}-${Math.floor(rand() * 0xffff).toString(16).padStart(4, '0')}`;
    // Nest under an earlier subtask a third of the time (depth up to ~4).
    const parent = subs.length > 0 && rand() < 0.33 ? pick(subs) : pick(tops.slice(0, 900));
    const r = rand();
    let ref: string;
    if (r < 0.06) ref = `zz${i}`; // orphan: resolves to nothing
    else if (r < 0.1) ref = parent.id.slice(0, 5); // odd prefix length
    else if (r < 0.55) ref = parent.id.slice(0, 8); // short prefix (maybe ambiguous)
    else ref = parent.id; // full id
    const project = rand() < 0.8 ? parent.project : pick(PROJECTS);
    const done = rand() < 0.3;
    subs.push(task({ id, parent_task_id: ref, project, phase: done ? 'COMPLETE' : 'TODO', status: done ? 'done' : 'todo' }));
  }
  // A subtask whose own id starts with its reference: the old scan could
  // answer the subtask itself when it is listed first.
  const host = tops[5];
  subs.push(task({ id: `${host.id.slice(0, 8)}-self`, parent_task_id: host.id.slice(0, 8), project: host.project }));
  // Interleave: most subtasks sit after the tops, some before them, so the
  // context passes see a child before its parent.
  const board = [...tops];
  for (const sub of subs) {
    const at = rand() < 0.25 ? Math.floor(rand() * board.length) : board.length;
    board.splice(at, 0, sub);
  }
  return board;
}

const BOARD = buildBoard(7);

describe('the synthetic board', () => {
  it('has the shape of a real one', () => {
    expect(BOARD.length).toBe(TOTAL);
    const subs = BOARD.filter((t) => t.parent_task_id);
    expect(subs.length).toBe(SUBTASKS);
    const refs = parentRefsOf(BOARD);
    expect(refs.size).toBeGreaterThan(80);
    expect(new Set([...refs].map((r) => r.length)).size).toBeGreaterThan(2);
    // At least one reference is ambiguous, and at least one matches nothing.
    expect([...refs].some((r) => BOARD.filter((t) => t.id.startsWith(r)).length > 1)).toBe(true);
    expect([...refs].some((r) => !BOARD.some((t) => t.id.startsWith(r)))).toBe(true);
  });
});

describe('ParentRefMatcher', () => {
  it('lists the references an id starts with, in the order they were given', () => {
    const m = new ParentRefMatcher(['abcdefgh-1234', 'abc', 'abcdefgh', 'x', 'abc']);
    expect(m.size).toBe(4);
    expect(m.refsOf('abcdefgh-1234')).toEqual(['abcdefgh-1234', 'abc', 'abcdefgh']);
    expect(m.refsOf('abcdefgh')).toEqual(['abc', 'abcdefgh']);
    expect(m.refsOf('ab')).toEqual([]);
    expect(m.refsOf('')).toEqual([]);
    expect(new ParentRefMatcher([]).refsOf('abc')).toEqual([]);
  });

  it('never counts an id shorter than a reference as a match', () => {
    const m = new ParentRefMatcher(['ab', 'abcd']);
    expect(m.refsOf('ab')).toEqual(['ab']);
    expect(m.refsOf('abc')).toEqual(['ab']);
  });

  it('agrees with startsWith over every board id and reference', () => {
    const refs = [...parentRefsOf(BOARD)];
    const m = new ParentRefMatcher(refs);
    for (const t of BOARD) {
      expect(m.refsOf(t.id)).toEqual(refs.filter((r) => t.id.startsWith(r)));
    }
  });
});

describe('resolveParentRef', () => {
  it('answers what list.find(startsWith) answers, for every reference on the board', () => {
    const list = [...BOARD];
    for (const ref of parentRefsOf(list)) expect(resolveParentRef(list, ref)).toBe(refFind(list, ref));
  });

  it('answers references no member carries the same way', () => {
    const list = [...BOARD];
    for (const ref of ['', 'nope', BOARD[100].id, BOARD[100].id.slice(0, 3), `${BOARD[3].id}x`]) {
      expect(resolveParentRef(list, ref)).toBe(refFind(list, ref));
      expect(resolveParentRef(list, ref)).toBe(refFind(list, ref));
    }
  });

  it('matches on a filtered sub-list too (the rendered rows)', () => {
    const rows = BOARD.filter((t) => t.status !== 'done');
    for (const ref of parentRefsOf(rows)) expect(resolveParentRef(rows, ref)).toBe(refFind(rows, ref));
    expect(resolveParentRef([], 'abc')).toBeUndefined();
  });

  it('can answer the subtask itself, exactly as the old scan did', () => {
    const host = BOARD.find((t) => t.id.endsWith('-self'))!;
    const selfFirst = [host, ...BOARD.filter((t) => t !== host)];
    expect(resolveParentRef(selfFirst, host.parent_task_id!)).toBe(host);
    expect(resolveParentRef(selfFirst, host.parent_task_id!)).toBe(refFind(selfFirst, host.parent_task_id!));
  });
});

describe('countSubtasksByParent', () => {
  it('equals the old per-subtask count', () => {
    const list = [...BOARD];
    expect([...countSubtasksByParent(list)]).toEqual([...refCount(list)]);
    const rows = BOARD.filter((_, i) => i % 3 !== 0);
    expect([...countSubtasksByParent(rows)]).toEqual([...refCount(rows)]);
    expect(countSubtasksByParent([]).size).toBe(0);
  });
});

describe('withSubtaskContext', () => {
  const eligibleCases: Array<[string, (t: Task) => boolean]> = [
    ['every subtask', () => true],
    ['open subtasks only', (t) => t.status !== 'done'],
    ['nothing', () => false],
  ];
  const matchedCases: Array<[string, (tasks: Task[]) => Task[]]> = [
    ['nothing matched', () => []],
    ['everything matched', (tasks) => tasks],
    ['one project', (tasks) => tasks.filter((t) => sameProjectKey(t.project, 'walnut'))],
    ['open top-level tasks', (tasks) => tasks.filter((t) => !t.parent_task_id && t.status !== 'done')],
    ['every seventh task', (tasks) => tasks.filter((_, i) => i % 7 === 0)],
  ];
  for (const [mName, pickMatched] of matchedCases) {
    for (const [eName, eligible] of eligibleCases) {
      it(`lists the same rows in the same order (${mName}, ${eName})`, () => {
        const matched = pickMatched(BOARD);
        const got = withSubtaskContext(BOARD, matched, eligible);
        const want = refContext(BOARD, matched, eligible);
        expect(got.map((t) => t.id)).toEqual(want.map((t) => t.id));
      });
    }
  }

  it('pulls a nested subtask in through its listed parent, never across projects', () => {
    const top = task({ id: 'aaaaaaaa-0001', project: 'Walnut' });
    const child = task({ id: 'bbbbbbbb-0001', parent_task_id: 'aaaaaaaa', project: 'walnut ' });
    const grandchild = task({ id: 'cccccccc-0001', parent_task_id: 'bbbbbbbb-0001', project: 'WALNUT' });
    const elsewhere = task({ id: 'dddddddd-0001', parent_task_id: 'aaaaaaaa-0001', project: 'Ops' });
    const tasks = [grandchild, elsewhere, child, top];
    const got = withSubtaskContext(tasks, [top], () => true);
    expect(got.map((t) => t.id)).toEqual(['aaaaaaaa-0001', 'bbbbbbbb-0001', 'cccccccc-0001']);
    expect(got.map((t) => t.id)).toEqual(refContext(tasks, [top], () => true).map((t) => t.id));
  });
});

describe('subtasksOf', () => {
  it('lists the same subtasks, in the same order, as the old index', () => {
    const list = [...BOARD];
    const want = refBuildIndex(list);
    for (const t of list) {
      expect(subtasksOf(list, t.id).map((s) => s.id)).toEqual((want.get(t.id) ?? []).map((s) => s.id));
    }
    expect(subtasksOf(list, 'nope')).toEqual([]);
  });

  it('keeps the old concat order when one parent matches several references', () => {
    const leader = task({ id: 'muabcdef-1234' });
    const byPrefix = task({ id: 'c1', parent_task_id: 'muabcdef' });
    const byShort = task({ id: 'c2', parent_task_id: 'mua' });
    const byFull = task({ id: 'c3', parent_task_id: 'muabcdef-1234' });
    const tasks = [byPrefix, byFull, leader, byShort];
    expect(subtasksOf(tasks, leader.id).map((t) => t.id))
      .toEqual((refBuildIndex(tasks).get(leader.id) ?? []).map((t) => t.id));
  });
});

describe('build cost on a real-sized board', () => {
  // Loose bound: this runs on a machine shared with other test runs.
  const BOUND_MS = 200;
  const time = (fn: () => unknown): number => {
    const t0 = performance.now();
    fn();
    return performance.now() - t0;
  };

  it('builds every index once in well under the bound', () => {
    const matched = BOARD.filter((t) => !t.parent_task_id && t.status !== 'done');
    const open = (t: Task) => t.status !== 'done';
    const count = time(() => countSubtasksByParent([...BOARD]));
    const context = time(() => withSubtaskContext(BOARD, matched, open));
    const leader = time(() => subtasksOf([...BOARD], BOARD[0].id));
    expect(count, `countSubtasksByParent took ${count.toFixed(1)}ms`).toBeLessThan(BOUND_MS);
    expect(context, `withSubtaskContext took ${context.toFixed(1)}ms`).toBeLessThan(BOUND_MS);
    expect(leader, `subtasksOf index build took ${leader.toFixed(1)}ms`).toBeLessThan(BOUND_MS);
  });
});
