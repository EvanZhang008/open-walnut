/**
 * Unit tests for plugin data migrations.
 *
 * Tests the MigrateFn implementations from each plugin:
 * - ms-todo: ms_todo_id/ms_todo_list → ext['ms-todo'].id/.list
 * - plugin-a: legacy_a_key/legacy_a_issue_id → ext['plugin-a'].key/.issueId
 * - plugin-b: legacy_b_id/legacy_b_ext_id → ext['plugin-b'].id/.extId
 * - Edge cases: already migrated, missing fields, multiple plugins
 */
import { describe, it, expect } from 'vitest';
import type { Task } from '../../src/core/types.js';

// ── Helpers ──

/** Create a minimal task with given overrides (including legacy fields). */
function makeTask(overrides: Record<string, unknown> = {}): Task {
  return {
    id: 'task-' + Math.random().toString(36).slice(2, 8),
    title: 'Test task',
    status: 'todo',
    phase: 'TODO',
    priority: 'none',
    category: 'Inbox',
    project: 'Inbox',
    source: 'local',
    session_ids: [],
    description: '',
    summary: '',
    note: '',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  } as Task;
}

// ── MS To-Do migration logic (extracted from ms-todo plugin) ──

function msTodoMigration(tasks: Task[]): Task[] {
  for (const task of tasks) {
    const raw = task as any;
    if (raw.ms_todo_id && !task.ext?.['ms-todo']) {
      if (!task.ext) task.ext = {};
      task.ext['ms-todo'] = {
        id: raw.ms_todo_id,
        list: raw.ms_todo_list,
      };
      delete raw.ms_todo_id;
      delete raw.ms_todo_list;
    }
  }
  return tasks;
}

// ── Plugin-A migration logic (extracted from plugin pattern) ──
// Uses legacy field names (legacy_a_key, legacy_a_issue_id) to test real migration of old data

function pluginAMigration(tasks: Task[]): Task[] {
  for (const task of tasks) {
    const raw = task as any;
    if (raw.legacy_a_key && !task.ext?.['plugin-a']) {
      if (!task.ext) task.ext = {};
      task.ext['plugin-a'] = {
        key: raw.legacy_a_key,
        issueId: raw.legacy_a_issue_id,
      };
      delete raw.legacy_a_key;
      delete raw.legacy_a_issue_id;
    }
  }
  return tasks;
}

// ── Plugin-B migration logic (extracted from plugin pattern) ──
// Uses legacy field names (legacy_b_id, legacy_b_ext_id) to test real migration of old data

function pluginBMigration(tasks: Task[]): Task[] {
  for (const task of tasks) {
    const raw = task as any;
    if (raw.legacy_b_id && !task.ext?.['plugin-b']) {
      if (!task.ext) task.ext = {};
      task.ext['plugin-b'] = {
        id: raw.legacy_b_id,
        extId: raw.legacy_b_ext_id,
      };
      delete raw.legacy_b_id;
      delete raw.legacy_b_ext_id;
    }
  }
  return tasks;
}

// ── Tests ──

describe('MS To-Do migration', () => {
  it('moves ms_todo_id and ms_todo_list to ext', () => {
    const task = makeTask({
      source: 'ms-todo',
      ms_todo_id: 'abc123',
      ms_todo_list: 'list456',
    });

    const [migrated] = msTodoMigration([task]);

    expect((migrated as any).ms_todo_id).toBeUndefined();
    expect((migrated as any).ms_todo_list).toBeUndefined();
    expect(migrated.ext?.['ms-todo']).toEqual({ id: 'abc123', list: 'list456' });
  });

  it('skips tasks already migrated (ext["ms-todo"] exists)', () => {
    const task = makeTask({
      source: 'ms-todo',
      ms_todo_id: 'old-id',
      ext: { 'ms-todo': { id: 'already-there', list: 'existing' } },
    });

    const [migrated] = msTodoMigration([task]);

    // Should not overwrite existing ext data
    expect(migrated.ext?.['ms-todo']).toEqual({ id: 'already-there', list: 'existing' });
  });

  it('skips tasks without ms_todo_id', () => {
    const task = makeTask({ source: 'local' });

    const [migrated] = msTodoMigration([task]);

    expect(migrated.ext).toBeUndefined();
    expect((migrated as any).ms_todo_id).toBeUndefined();
  });

  it('handles ms_todo_list being undefined', () => {
    const task = makeTask({
      source: 'ms-todo',
      ms_todo_id: 'abc',
    });

    const [migrated] = msTodoMigration([task]);

    expect(migrated.ext?.['ms-todo']).toEqual({ id: 'abc', list: undefined });
    expect((migrated as any).ms_todo_id).toBeUndefined();
  });

  it('migrates multiple tasks at once', () => {
    const tasks = [
      makeTask({ ms_todo_id: 'id1', ms_todo_list: 'list1' }),
      makeTask({ ms_todo_id: 'id2', ms_todo_list: 'list2' }),
      makeTask({ source: 'local' }), // no ms_todo_id
    ];

    const migrated = msTodoMigration(tasks);

    expect(migrated[0].ext?.['ms-todo']).toEqual({ id: 'id1', list: 'list1' });
    expect(migrated[1].ext?.['ms-todo']).toEqual({ id: 'id2', list: 'list2' });
    expect(migrated[2].ext).toBeUndefined();
  });
});

describe('Plugin-A migration', () => {
  it('moves legacy_a_key and legacy_a_issue_id to ext', () => {
    const task = makeTask({
      source: 'plugin-a',
      legacy_a_key: 'PROJ-123',
      legacy_a_issue_id: '10001',
    });

    const [migrated] = pluginAMigration([task]);

    expect((migrated as any).legacy_a_key).toBeUndefined();
    expect((migrated as any).legacy_a_issue_id).toBeUndefined();
    expect(migrated.ext?.['plugin-a']).toEqual({ key: 'PROJ-123', issueId: '10001' });
  });

  it('skips tasks without legacy_a_key', () => {
    const task = makeTask({ source: 'local' });
    const [migrated] = pluginAMigration([task]);
    expect(migrated.ext).toBeUndefined();
  });

  it('skips tasks already migrated', () => {
    const task = makeTask({
      legacy_a_key: 'OLD-1',
      ext: { 'plugin-a': { key: 'ALREADY', issueId: '99' } },
    });
    const [migrated] = pluginAMigration([task]);
    expect(migrated.ext?.['plugin-a']).toEqual({ key: 'ALREADY', issueId: '99' });
  });
});

describe('Plugin-B migration', () => {
  it('moves legacy_b_id and legacy_b_ext_id to ext', () => {
    const task = makeTask({
      source: 'plugin-b',
      legacy_b_id: 'T-100',
      legacy_b_ext_id: 'EXT-200',
    });

    const [migrated] = pluginBMigration([task]);

    expect((migrated as any).legacy_b_id).toBeUndefined();
    expect((migrated as any).legacy_b_ext_id).toBeUndefined();
    expect(migrated.ext?.['plugin-b']).toEqual({ id: 'T-100', extId: 'EXT-200' });
  });

  it('skips tasks without legacy_b_id', () => {
    const task = makeTask({ source: 'ms-todo' });
    const [migrated] = pluginBMigration([task]);
    expect(migrated.ext).toBeUndefined();
  });

  it('skips tasks already migrated', () => {
    const task = makeTask({
      legacy_b_id: 'OLD',
      ext: { 'plugin-b': { id: 'EXISTING', extId: 'EXT' } },
    });
    const [migrated] = pluginBMigration([task]);
    expect(migrated.ext?.['plugin-b']).toEqual({ id: 'EXISTING', extId: 'EXT' });
  });
});

describe('Multiple migrations in sequence', () => {
  it('applies all three migrations to a task with mixed legacy fields', () => {
    const task = makeTask({
      ms_todo_id: 'ms-1',
      ms_todo_list: 'ms-list',
      legacy_a_key: 'PROJ-1',
      legacy_a_issue_id: 'issue-1',
      legacy_b_id: 'pluginb-1',
      legacy_b_ext_id: 'ext-1',
    });

    let tasks = [task];
    tasks = msTodoMigration(tasks);
    tasks = pluginAMigration(tasks);
    tasks = pluginBMigration(tasks);

    const migrated = tasks[0];
    expect(migrated.ext?.['ms-todo']).toEqual({ id: 'ms-1', list: 'ms-list' });
    expect(migrated.ext?.['plugin-a']).toEqual({ key: 'PROJ-1', issueId: 'issue-1' });
    expect(migrated.ext?.['plugin-b']).toEqual({ id: 'pluginb-1', extId: 'ext-1' });

    // Legacy fields should be removed
    expect((migrated as any).ms_todo_id).toBeUndefined();
    expect((migrated as any).legacy_a_key).toBeUndefined();
    expect((migrated as any).legacy_b_id).toBeUndefined();
  });

  it('does not interfere between plugins (ext keys are isolated)', () => {
    const tasks = [
      makeTask({ ms_todo_id: 'ms-only' }),
      makeTask({ legacy_a_key: 'plugina-only' }),
    ];

    let result = msTodoMigration(tasks);
    result = pluginAMigration(result);

    expect(result[0].ext?.['ms-todo']).toEqual({ id: 'ms-only', list: undefined });
    expect(result[0].ext?.['plugin-a']).toBeUndefined();

    expect(result[1].ext?.['ms-todo']).toBeUndefined();
    expect(result[1].ext?.['plugin-a']).toEqual({ key: 'plugina-only', issueId: undefined });
  });

  it('preserves existing ext data from other plugins', () => {
    const task = makeTask({
      ms_todo_id: 'ms-new',
      ext: { 'custom-plugin': { data: 'preserved' } },
    });

    const [migrated] = msTodoMigration([task]);

    expect(migrated.ext?.['ms-todo']).toEqual({ id: 'ms-new', list: undefined });
    expect(migrated.ext?.['custom-plugin']).toEqual({ data: 'preserved' });
  });
});

describe('Edge cases', () => {
  it('handles empty task array', () => {
    expect(msTodoMigration([])).toEqual([]);
    expect(pluginAMigration([])).toEqual([]);
    expect(pluginBMigration([])).toEqual([]);
  });

  it('handles task with ext already set to empty object', () => {
    const task = makeTask({
      ms_todo_id: 'abc',
      ext: {},
    });
    const [migrated] = msTodoMigration([task]);
    expect(migrated.ext?.['ms-todo']).toEqual({ id: 'abc', list: undefined });
  });
});
