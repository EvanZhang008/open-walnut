/**
 * Every task list sorts by priority in Walnut's ONE native order: VALID_PRIORITIES
 * (immediate, important, backlog, none), legacy values folded the server's way.
 *
 * Before this guard each list kept its own rank table: the query sort, the /tasks
 * table and the Tasks panel. They drifted: the /tasks table sank a legacy "high"
 * task with the priority-less pile, and the Tasks panel read "medium" as important
 * while the server reads it as backlog. Now each one ranks with task-query's
 * priorityRank, and the scan below fails on any new rank table of its own.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { VALID_PRIORITIES, type Task, type TaskPriority } from '../../src/core/types.js';
import { compareTasksForQuery, priorityRank } from '../../src/core/task-query.js';
import { sortTasks } from '../../web/src/components/tasks/tasks-page-sort';

const ROOT = path.resolve(__dirname, '../..');

let seq = 0;
function task(priority: string | undefined): Task {
  seq += 1;
  return {
    id: `t-${String(seq).padStart(3, '0')}`,
    title: `Task ${seq}`,
    status: 'todo',
    phase: 'TODO',
    priority: priority as TaskPriority,
    project: '',
    created_at: '2026-11-01T00:00:00Z',
    updated_at: '2026-11-01T00:00:00Z',
  } as Task;
}

/** One task per native priority plus the legacy values, in a scrambled order. */
function scrambled(): Task[] {
  return ['none', 'low', 'backlog', 'high', 'important', 'medium', 'immediate'].map(task);
}

/** The native place each stored value must sort at: legacy folded as the server folds it. */
const EXPECTED_PLACE: Record<string, number> = {
  immediate: 0, high: 0, important: 1, backlog: 2, medium: 2, low: 2, none: 3,
};

function places(tasks: Task[]): number[] {
  return tasks.map((t) => EXPECTED_PLACE[t.priority as string]);
}

describe('the native priority order', () => {
  it('is VALID_PRIORITIES, first to last', () => {
    expect(VALID_PRIORITIES).toEqual(['immediate', 'important', 'backlog', 'none']);
    expect(VALID_PRIORITIES.map((p) => priorityRank(p))).toEqual([0, 1, 2, 3]);
  });

  it('folds legacy values the server way and puts unknown ones after none', () => {
    expect(priorityRank('high')).toBe(priorityRank('immediate'));
    expect(priorityRank('medium')).toBe(priorityRank('backlog'));
    expect(priorityRank('low')).toBe(priorityRank('backlog'));
    expect(priorityRank(undefined)).toBeGreaterThan(priorityRank('none'));
    expect(priorityRank('garbage')).toBeGreaterThan(priorityRank('none'));
  });
});

describe('every task list sorts by that order', () => {
  it('the query sort (REST, the agent tool, both task surfaces)', () => {
    const sorted = [...scrambled()].sort((a, b) => compareTasksForQuery(a, b, 'priority'));
    expect(places(sorted)).toEqual([...places(sorted)].sort((a, b) => a - b));
  });

  it('the /tasks table, ascending, with none last in both directions', () => {
    const asc = sortTasks(scrambled(), { key: 'priority', dir: 'asc' });
    expect(places(asc)).toEqual([0, 0, 1, 2, 2, 2, 3]);
    const desc = sortTasks(scrambled(), { key: 'priority', dir: 'desc' });
    expect(places(desc)).toEqual([2, 2, 2, 1, 0, 0, 3]);
  });

  it('the Tasks panel ranks with priorityRank, not a table of its own', () => {
    const src = fs.readFileSync(path.join(ROOT, 'web/src/components/tasks/TodoPanel.tsx'), 'utf8');
    const body = src.slice(src.indexOf('function comparePriority('), src.indexOf('function comparePriority(') + 600);
    expect(body).toContain('priorityRank(a.priority)');
    expect(body).toContain('priorityRank(b.priority)');
  });
});

/**
 * Rank tables written out by hand. Each entry here is a deliberate order that is
 * not a list's priority sort; anything else must call priorityRank.
 */
const ALLOWED: Record<string, string> = {
  // The session start queue launches unset work before backlog work on purpose
  // (tests/core/sessions/start-queue.test.ts): a launch order, not a list.
  'src/core/sessions/start-queue.ts': 'launch order: unset before backlog',
  // The iOS app is Swift and cannot import task-query; its rank is checked below.
  'ios-native/Walnut/API/Models.swift': 'Swift twin, order checked below',
};

function walk(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mjs|js|swift)$/.test(entry.name) && !/\.test\.|\.spec\./.test(entry.name)) out.push(full);
  }
}

describe('no list keeps its own priority rank table', () => {
  it('finds a hand-written rank only where it is allowed', () => {
    const files: string[] = [];
    for (const dir of ['src', 'web/src', 'ios-native/Walnut', 'plugins']) {
      if (fs.existsSync(path.join(ROOT, dir))) walk(path.join(ROOT, dir), files);
    }
    // A map from a priority to a number (`immediate: 0`) or a Swift case returning one.
    const rankTable = /\bimmediate['"]?\s*:\s*\d|case\s+\.immediate\s*:\s*return\s+\d/;
    const found = files
      .filter((f) => rankTable.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(ROOT, f).split(path.sep).join('/'));
    const unexpected = found.filter((f) => !(f in ALLOWED));
    expect(unexpected, 'rank with priorityRank from src/core/task-query.ts instead').toEqual([]);
    // Every allowed entry still exists, so a stale allowance does not hide a new table.
    for (const f of Object.keys(ALLOWED)) expect(found).toContain(f);
  });

  it('the iOS twin ranks in the native order', () => {
    const swift = fs.readFileSync(path.join(ROOT, 'ios-native/Walnut/API/Models.swift'), 'utf8');
    const block = swift.slice(swift.indexOf('var sortRank: Int'), swift.indexOf('var sortRank: Int') + 400);
    const rank = (c: string) => Number(new RegExp(`case \\.${c}[^:]*:\\s*return\\s+(\\d)`).exec(block)?.[1]);
    expect(VALID_PRIORITIES.map(rank)).toEqual([0, 1, 2, 3]);
  });
});
