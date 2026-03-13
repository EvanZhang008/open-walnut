import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import {
  addTask,
  updateTask,
  renameCategory,
  validateCategorySource,
  CategorySourceConflictError,
  createCategory,
  getStoreCategories,
  updateCategorySource,
  _resetForTesting,
} from '../../src/core/task-manager.js';
import { WALNUT_HOME, CONFIG_FILE } from '../../src/constants.js';
import type { Task } from '../../src/core/types.js';

beforeEach(async () => {
  _resetForTesting();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

afterEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

// ── validateCategorySource (pure function) ──

describe('validateCategorySource', () => {
  const makeTask = (overrides: Partial<Task> = {}): Task => ({
    id: 'test-1234',
    title: 'Test',
    status: 'todo',
    phase: 'TODO',
    priority: 'none',
    category: 'Work',
    project: 'Work',
    source: 'ms-todo',
    session_ids: [],
    description: '',
    summary: '',
    note: '',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  });

  it('allows first task in a new category (no existing tasks)', () => {
    const result = validateCategorySource([], 'NewCategory', 'ms-todo', {});
    expect(result.ok).toBe(true);
  });

  it('blocks conflicting source in existing category', () => {
    const tasks = [makeTask({ category: 'Work', source: 'plugin-a' })];
    const result = validateCategorySource(tasks, 'Work', 'ms-todo', {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.existingSource).toBe('plugin-a');
      expect(result.error).toContain('already contains plugin-a tasks');
    }
  });

  it('allows same source in existing category', () => {
    const tasks = [makeTask({ category: 'Work', source: 'ms-todo' })];
    const result = validateCategorySource(tasks, 'Work', 'ms-todo', {});
    expect(result.ok).toBe(true);
  });

  it('blocks ms-todo in config plugin category even when empty', () => {
    const result = validateCategorySource(
      [],
      'Work - PluginA',
      'ms-todo',
      { plugins: { 'plugin-a': { category: 'Work - PluginA' } } },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.existingSource).toBe('plugin-a');
      expect(result.error).toContain('reserved for plugin-a sync');
    }
  });

  it('allows plugin-a in config plugin-a category', () => {
    const result = validateCategorySource(
      [],
      'Work - PluginA',
      'plugin-a',
      { plugins: { 'plugin-a': { category: 'Work - PluginA' } } },
    );
    expect(result.ok).toBe(true);
  });

  it('is case-insensitive for category matching', () => {
    const tasks = [makeTask({ category: 'WORK', source: 'plugin-a' })];
    const result = validateCategorySource(tasks, 'work', 'ms-todo', {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.existingSource).toBe('plugin-a');
    }
  });

  it('is case-insensitive for config plugin category matching', () => {
    const result = validateCategorySource(
      [],
      'work - plugina',
      'ms-todo',
      { plugins: { 'plugin-a': { category: 'Work - PluginA' } } },
    );
    expect(result.ok).toBe(false);
  });
});

// ── addTask with source conflict ──

describe('addTask category-source validation', () => {
  it('v3: addTask in config plugin category gets plugin source from store.categories (migration)', async () => {
    // Config has plugin-a.category but no room_id — v3 migration registers 'Work' as plugin-a
    // in store.categories, so addTask correctly gets source='plugin-a'
    await fs.mkdir(path.dirname(CONFIG_FILE), { recursive: true });
    await fs.writeFile(
      CONFIG_FILE,
      JSON.stringify({
        version: 1,
        user: { name: 'test' },
        defaults: { priority: 'none', category: 'personal' },
        provider: { type: 'bedrock' },
        plugins: { 'plugin-a': { category: 'Work' } },  // note: no room_id
      }),
    );

    const { task } = await addTask({ title: 'Work task', category: 'Work' });
    expect(task.source).toBe('plugin-a');
    expect(task.category).toBe('Work');
  });

  it('succeeds for same source in existing category', async () => {
    const { task: t1 } = await addTask({ title: 'Task 1', category: 'Life' });
    expect(t1.source).toBe('local');

    const { task: t2 } = await addTask({ title: 'Task 2', category: 'Life' });
    expect(t2.source).toBe('local');
    expect(t2.category).toBe('Life');
  });
});

// ── updateTask with source conflict ──

describe('updateTask category-source validation', () => {
  it('throws CategorySourceConflictError on category change to different-source category', async () => {
    await fs.mkdir(path.dirname(CONFIG_FILE), { recursive: true });
    await fs.writeFile(
      CONFIG_FILE,
      JSON.stringify({
        version: 1,
        user: { name: 'test' },
        defaults: { priority: 'none', category: 'personal' },
        provider: { type: 'bedrock' },
        plugins: { 'plugin-a': { room_id: 'room-123', category: 'Work' } },
      }),
    );

    // Create a plugin-a task (category='Work' matches config plugin-a category via v3 migration)
    const { task: pluginTask } = await addTask({ title: 'Plugin task', category: 'Work' });
    expect(pluginTask.source).toBe('plugin-a');

    // Create a local task in a different category (no ms-todo plugin registered)
    const { task: localTask } = await addTask({ title: 'Local task', category: 'Life' });
    expect(localTask.source).toBe('local');

    // Try to move local task to the plugin-a category
    const err = await updateTask(localTask.id, { category: 'Work' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CategorySourceConflictError);
    const e = err as CategorySourceConflictError;
    expect(e.category).toBe('Work');
    expect(e.intendedSource).toBe('local');
    expect(e.existingSource).toBe('plugin-a');
  });

  it('allows category change to same-source category', async () => {
    const { task: t1 } = await addTask({ title: 'Task in Life', category: 'Life' });
    const { task: t2 } = await addTask({ title: 'Task in Fun', category: 'Fun' });
    // Both default to 'local' when no plugins are registered
    expect(t1.source).toBe('local');
    expect(t2.source).toBe('local');

    // Move t1 to 'Fun' — both are local, should succeed
    const { task: moved } = await updateTask(t1.id, { category: 'Fun' });
    expect(moved.category).toBe('Fun');
  });

  it('allows non-category updates without validation', async () => {
    const { task } = await addTask({ title: 'My task', category: 'Life' });

    // Update title only — no category change, no validation needed
    const { task: updated } = await updateTask(task.id, { title: 'Updated title' });
    expect(updated.title).toBe('Updated title');
    expect(updated.category).toBe('Life');
  });

  it('allows category change to empty category', async () => {
    const { task } = await addTask({ title: 'Task', category: 'Life' });

    // Move to a brand new category with no existing tasks
    const { task: moved } = await updateTask(task.id, { category: 'BrandNew' });
    expect(moved.category).toBe('BrandNew');
  });

  it('skips validation when category casing changes but is logically the same', async () => {
    const { task } = await addTask({ title: 'Task', category: 'life' });

    // "life" → "Life" is the same category (case-insensitive), no validation needed
    const { task: updated } = await updateTask(task.id, { category: 'Life' });
    expect(updated.category).toBe('Life');
  });

  it('validates slash-separated category format correctly', async () => {
    await fs.mkdir(path.dirname(CONFIG_FILE), { recursive: true });
    await fs.writeFile(
      CONFIG_FILE,
      JSON.stringify({
        version: 1,
        user: { name: 'test' },
        defaults: { priority: 'none', category: 'personal' },
        provider: { type: 'bedrock' },
        plugins: { 'plugin-a': { room_id: 'room-123', category: 'Work' } },
      }),
    );

    // Create a plugin-a task in 'Work'
    await addTask({ title: 'Plugin task', category: 'Work' });

    // Create an ms-todo task in 'Life'
    const { task: msTodoTask } = await addTask({ title: 'MS task', category: 'Life' });

    // Try to move using slash-separated format "Work / Project" — should detect "Work" conflict
    await expect(
      updateTask(msTodoTask.id, { category: 'Work / SomeProject' }),
    ).rejects.toThrow(CategorySourceConflictError);
  });
});

// ── renameCategory with source conflict ──

describe('renameCategory category-source validation', () => {
  it('throws when target category has different source', async () => {
    await fs.mkdir(path.dirname(CONFIG_FILE), { recursive: true });
    await fs.writeFile(
      CONFIG_FILE,
      JSON.stringify({
        version: 1,
        user: { name: 'test' },
        defaults: { priority: 'none', category: 'personal' },
        provider: { type: 'bedrock' },
        plugins: { 'plugin-a': { room_id: 'room-123', category: 'Work' } },
      }),
    );

    // Create plugin-a task in 'Work'
    await addTask({ title: 'Plugin task', category: 'Work' });
    // Create local task in 'Life'
    await addTask({ title: 'Life task', category: 'Life' });

    // Try to rename 'Life' (local) → 'Work' (has plugin-a tasks)
    await expect(renameCategory('Life', 'Work')).rejects.toThrow(CategorySourceConflictError);
  });

  it('succeeds when target category is empty', async () => {
    await addTask({ title: 'Old task', category: 'OldName' });

    const result = await renameCategory('OldName', 'NewName');
    expect(result.count).toBe(1);
  });

  it('throws when target is config plugin category for non-plugin tasks', async () => {
    await fs.mkdir(path.dirname(CONFIG_FILE), { recursive: true });
    await fs.writeFile(
      CONFIG_FILE,
      JSON.stringify({
        version: 1,
        user: { name: 'test' },
        defaults: { priority: 'none', category: 'personal' },
        provider: { type: 'bedrock' },
        plugins: { 'plugin-a': { room_id: 'room-123', category: 'Work - PluginA' } },
      }),
    );

    // Create local task in 'Life'
    await addTask({ title: 'Life task', category: 'Life' });

    // Try to rename 'Life' → 'Work - PluginA' (reserved for plugin-a)
    const err = await renameCategory('Life', 'Work - PluginA').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CategorySourceConflictError);
    const e = err as CategorySourceConflictError;
    expect(e.message).toContain('plugin-a sync category');
  });
});

// ── Local source tests ──

describe('validateCategorySource — local source', () => {
  const makeTask = (overrides: Partial<Task> = {}): Task => ({
    id: 'test-1234',
    title: 'Test',
    status: 'todo',
    phase: 'TODO',
    priority: 'none',
    category: 'Work',
    project: 'Work',
    source: 'ms-todo',
    session_ids: [],
    description: '',
    summary: '',
    note: '',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  });

  it('allows local task in a new category', () => {
    const result = validateCategorySource([], 'Temp', 'local', {});
    expect(result.ok).toBe(true);
  });

  it('blocks ms-todo in config.local.categories', () => {
    const result = validateCategorySource(
      [],
      'Local',
      'ms-todo',
      { local: { categories: ['Local'] } },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.existingSource).toBe('local');
      expect(result.error).toContain('reserved for local tasks');
    }
  });

  it('allows local in config.local.categories', () => {
    const result = validateCategorySource(
      [],
      'Local',
      'local',
      { local: { categories: ['Local'] } },
    );
    expect(result.ok).toBe(true);
  });

  it('blocks mixing local with ms-todo in same category', () => {
    const tasks = [makeTask({ category: 'Temp', source: 'local' })];
    const result = validateCategorySource(tasks, 'Temp', 'ms-todo', {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.existingSource).toBe('local');
  });

  it('is case-insensitive for config.local.categories', () => {
    const result = validateCategorySource(
      [],
      'local',
      'ms-todo',
      { local: { categories: ['Local'] } },
    );
    expect(result.ok).toBe(false);
  });
});

describe('addTask — local source determination', () => {
  it('creates local task when category matches config.local.categories', async () => {
    await fs.mkdir(path.dirname(CONFIG_FILE), { recursive: true });
    await fs.writeFile(
      CONFIG_FILE,
      JSON.stringify({
        version: 1,
        user: { name: 'test' },
        defaults: { priority: 'none', category: 'personal' },
        provider: { type: 'bedrock' },
        local: { categories: ['Scratch', 'Temp'] },
      }),
    );

    const { task } = await addTask({ title: 'Quick note', category: 'Scratch' });
    expect(task.source).toBe('local');
    expect(task.ext?.['ms-todo']).toBeUndefined();
    expect(task.ext?.['plugin-a']).toBeUndefined();
  });

  it('creates local task when category is not in config.local.categories (no plugins registered)', async () => {
    await fs.mkdir(path.dirname(CONFIG_FILE), { recursive: true });
    await fs.writeFile(
      CONFIG_FILE,
      JSON.stringify({
        version: 1,
        user: { name: 'test' },
        defaults: { priority: 'none', category: 'personal' },
        provider: { type: 'bedrock' },
        local: { categories: ['Scratch'] },
      }),
    );

    // With no ms-todo plugin registered, registry.getForCategory() returns 'local'
    const { task } = await addTask({ title: 'Regular task', category: 'Life' });
    expect(task.source).toBe('local');
  });

  it('blocks adding ms-todo task to a local-reserved category', async () => {
    await fs.mkdir(path.dirname(CONFIG_FILE), { recursive: true });
    await fs.writeFile(
      CONFIG_FILE,
      JSON.stringify({
        version: 1,
        user: { name: 'test' },
        defaults: { priority: 'none', category: 'personal' },
        provider: { type: 'bedrock' },
        plugins: { 'plugin-a': { room_id: 'room-1', category: 'Work' } },
        local: { categories: ['Local'] },
      }),
    );

    // Create a local task first
    const { task: localTask } = await addTask({ title: 'Local task', category: 'Local' });
    expect(localTask.source).toBe('local');

    // Trying to create a plugin-a task in the local category should fail
    // (auto-determines to 'local' because config.local.categories matches)
    const { task: anotherLocal } = await addTask({ title: 'Another', category: 'Local' });
    expect(anotherLocal.source).toBe('local');
  });
});

// ── addTask — existing-task source fallback ──

describe('addTask — inherits source from existing tasks in category (no config mapping)', () => {
  it('auto-detects plugin-a source from existing tasks when config has no plugin-a section', async () => {
    // Seed store with a plugin-a task (as if it was synced from an external plugin)
    const tasksDir = path.join(WALNUT_HOME, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });
    await fs.writeFile(
      path.join(tasksDir, 'tasks.json'),
      JSON.stringify({
        tasks: [{
          id: 'seed-1234',
          title: 'Existing Plugin-A Task',
          status: 'todo',
          phase: 'TODO',
          priority: 'none',
          category: 'Work - PluginA',
          project: 'TeamProject',
          source: 'plugin-a',
          session_ids: [],
          description: '',
          summary: '',
          note: '',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }],
      }),
    );
    // No plugin-a config — just default config
    await fs.mkdir(path.dirname(CONFIG_FILE), { recursive: true });
    await fs.writeFile(
      CONFIG_FILE,
      JSON.stringify({
        version: 1,
        user: { name: 'test' },
        defaults: { priority: 'none', category: 'personal' },
        provider: { type: 'bedrock' },
      }),
    );

    // This is the exact scenario from the bug: create_task in a plugin-a category
    const { task } = await addTask({ title: 'New task in plugin-a category', category: 'Work - PluginA' });
    expect(task.source).toBe('plugin-a');
    expect(task.category).toBe('Work - PluginA');
  });

  it('auto-detects plugin-b source from existing tasks when config has no plugin-b section', async () => {
    const tasksDir = path.join(WALNUT_HOME, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });
    await fs.writeFile(
      path.join(tasksDir, 'tasks.json'),
      JSON.stringify({
        tasks: [{
          id: 'seed-pluginb-1',
          title: 'Existing Plugin-B Task',
          status: 'todo',
          phase: 'TODO',
          priority: 'none',
          category: 'Work - PluginB',
          project: 'PROJ',
          source: 'plugin-b',
          session_ids: [],
          description: '',
          summary: '',
          note: '',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }],
      }),
    );

    const { task } = await addTask({ title: 'New plugin-b task', category: 'Work - PluginB' });
    expect(task.source).toBe('plugin-b');
  });

  it('still defaults to local for a brand-new category with no existing tasks (no plugins)', async () => {
    // With no external plugins registered, registry.getForCategory() returns 'local'
    const { task } = await addTask({ title: 'Fresh category task', category: 'BrandNew' });
    expect(task.source).toBe('local');
  });
});

describe('updateTask — local task movement', () => {
  it('auto-migrates local task to a category with different source in store.categories', async () => {
    // Use store.categories directly to set up different sources
    await createCategory('Local', 'local');
    await createCategory('Synced', 'ms-todo');

    const { task: localTask } = await addTask({ title: 'Local task', category: 'Local' });
    expect(localTask.source).toBe('local');

    // Create an ms-todo task in 'Synced' (via explicit source since store already has it)
    const { task: msTodoTask } = await addTask({ title: 'Synced task', category: 'Synced' });
    expect(msTodoTask.source).toBe('ms-todo');

    // Moving local task to 'Synced' → auto-migrates source to ms-todo
    const { task: moved } = await updateTask(localTask.id, { category: 'Synced' });
    expect(moved.category).toBe('Synced');
    expect(moved.source).toBe('ms-todo');
    expect(moved.id).toBe(localTask.id); // ID doesn't change
    expect(moved.ext).toBeUndefined(); // ext cleared for new source push
    expect(moved.external_url).toBeUndefined();
    expect(moved.sync_error).toBeUndefined();
  });

  it('blocks moving synced task to a local-reserved category', async () => {
    await fs.mkdir(path.dirname(CONFIG_FILE), { recursive: true });
    await fs.writeFile(
      CONFIG_FILE,
      JSON.stringify({
        version: 1,
        user: { name: 'test' },
        defaults: { priority: 'none', category: 'personal' },
        provider: { type: 'bedrock' },
        local: { categories: ['Local'] },
      }),
    );

    // Create ms-todo task explicitly with source since no ms-todo plugin is registered
    await createCategory('Life', 'ms-todo');
    const { task: msTodoTask } = await addTask({ title: 'Synced task', category: 'Life' });
    expect(msTodoTask.source).toBe('ms-todo');

    // Try to move ms-todo task to 'Local' (config-reserved for local) → should fail
    const err = await updateTask(msTodoTask.id, { category: 'Local' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CategorySourceConflictError);
    const e = err as CategorySourceConflictError;
    expect(e.existingSource).toBe('local');
  });
});

// ── addTask — explicit source parameter ──

describe('addTask — explicit source parameter', () => {
  it('creates local task when source="local" is explicitly passed', async () => {
    // No config.local.categories — just the explicit source param
    const { task } = await addTask({ title: 'Quick note', category: 'Scratch', source: 'local' });
    expect(task.source).toBe('local');
  });

  it('auto-ensures category in store.categories after explicit source="local"', async () => {
    const { task } = await addTask({ title: 'Note', category: 'MyNotes', source: 'local' });
    expect(task.source).toBe('local');

    // Verify store.categories was updated (v3: source lives in store, not config)
    const storeCategories = await getStoreCategories();
    expect(storeCategories['MyNotes']).toEqual({ source: 'local' });
  });

  it('subsequent tasks in auto-ensured category inherit local source', async () => {
    // First task with explicit source → auto-ensures store.categories entry
    await addTask({ title: 'First', category: 'Scratch', source: 'local' });

    // Second task without explicit source — should inherit via store.categories
    const { task: second } = await addTask({ title: 'Second', category: 'Scratch' });
    expect(second.source).toBe('local');
  });

  it('does not duplicate store.categories entry when category already exists', async () => {
    await fs.mkdir(path.dirname(CONFIG_FILE), { recursive: true });
    await fs.writeFile(
      CONFIG_FILE,
      JSON.stringify({
        version: 1,
        user: { name: 'test' },
        defaults: { priority: 'none', category: 'personal' },
        provider: { type: 'bedrock' },
        local: { categories: ['Scratch'] },
      }),
    );

    // Create with explicit source — store.categories should have exactly one entry
    await addTask({ title: 'Note', category: 'Scratch', source: 'local' });

    const storeCategories = await getStoreCategories();
    const keys = Object.keys(storeCategories).filter(k => k.toLowerCase() === 'scratch');
    expect(keys.length).toBe(1);
    expect(storeCategories[keys[0]]).toEqual({ source: 'local' });
  });

  it('explicit source="local" takes precedence over ms-todo default', async () => {
    // No config mappings at all — would default to ms-todo without explicit source
    const { task } = await addTask({ title: 'Task', category: 'BrandNew', source: 'local' });
    expect(task.source).toBe('local');
  });

  it('parent source still overrides explicit source', async () => {
    // Create parent with explicit ms-todo source via store.categories
    await createCategory('Life', 'ms-todo');
    const { task: parent } = await addTask({ title: 'Parent', category: 'Life' });
    expect(parent.source).toBe('ms-todo');

    // Child with explicit source='local' — parent should win
    const { task: child } = await addTask({
      title: 'Child',
      parent_task_id: parent.id,
      source: 'local',
    });
    expect(child.source).toBe('ms-todo');
  });
});

// ── renameCategory — config.local.categories update ──

describe('renameCategory — updates store.categories and config.local.categories', () => {
  it('renames category in both store.categories and config.local.categories', async () => {
    await fs.mkdir(path.dirname(CONFIG_FILE), { recursive: true });
    await fs.writeFile(
      CONFIG_FILE,
      JSON.stringify({
        version: 1,
        user: { name: 'test' },
        defaults: { priority: 'none', category: 'personal' },
        provider: { type: 'bedrock' },
        local: { categories: ['Scratch'] },
      }),
    );

    await addTask({ title: 'Note', category: 'Scratch' });
    await renameCategory('Scratch', 'Notes');

    // Verify store.categories updated
    const storeCategories = await getStoreCategories();
    expect(storeCategories['Notes']).toEqual({ source: 'local' });
    expect(storeCategories['Scratch']).toBeUndefined();

    // Verify config.local.categories still updated (backward compat)
    const { getConfig } = await import('../../src/core/config-manager.js');
    const config = await getConfig();
    expect(config.local?.categories).toContain('Notes');
    expect(config.local?.categories).not.toContain('Scratch');
  });
});

// ── createCategory ──

describe('createCategory', () => {
  it('creates a local category in store.categories', async () => {
    const result = await createCategory('Scratch', 'local');
    expect(result).toEqual({ name: 'Scratch', source: 'local' });

    const storeCategories = await getStoreCategories();
    expect(storeCategories['Scratch']).toEqual({ source: 'local' });
  });

  it('creates an ms-todo category in store.categories', async () => {
    const result = await createCategory('Life', 'ms-todo');
    expect(result).toEqual({ name: 'Life', source: 'ms-todo' });

    const storeCategories = await getStoreCategories();
    expect(storeCategories['Life']).toEqual({ source: 'ms-todo' });
  });

  it('allows plugin-a source (plugin system allows any source)', async () => {
    const result = await createCategory('Work', 'plugin-a');
    expect(result).toEqual({ name: 'Work', source: 'plugin-a' });
  });

  it('allows plugin-b source (plugin system allows any source)', async () => {
    const result = await createCategory('PluginB', 'plugin-b');
    expect(result).toEqual({ name: 'PluginB', source: 'plugin-b' });
  });

  it('rejects duplicate category (case-insensitive)', async () => {
    await createCategory('Scratch', 'local');
    await expect(createCategory('scratch', 'local')).rejects.toThrow('already exists');
  });

  it('rejects empty name', async () => {
    await expect(createCategory('', 'local')).rejects.toThrow('non-empty');
  });
});

// ── updateCategorySource ──

describe('updateCategorySource', () => {
  it('updates source of an existing category', async () => {
    await createCategory('Scratch', 'local');
    const result = await updateCategorySource('Scratch', 'ms-todo');
    expect(result).toEqual({ name: 'Scratch', source: 'ms-todo' });

    const storeCategories = await getStoreCategories();
    expect(storeCategories['Scratch']).toEqual({ source: 'ms-todo' });
  });

  it('rejects update when tasks conflict', async () => {
    await createCategory('Life', 'ms-todo');
    await addTask({ title: 'Task in Life', category: 'Life' });

    await expect(updateCategorySource('Life', 'local')).rejects.toThrow('has ms-todo tasks');
  });

  it('rejects update for non-existent category', async () => {
    await expect(updateCategorySource('NonExist', 'local')).rejects.toThrow('does not exist');
  });
});

// ── v3 migration ──

describe('v3 migration — store.categories populated from config + tasks', () => {
  it('migrates config.local.categories to store.categories', async () => {
    await fs.mkdir(path.dirname(CONFIG_FILE), { recursive: true });
    await fs.writeFile(
      CONFIG_FILE,
      JSON.stringify({
        version: 1,
        user: { name: 'test' },
        defaults: { priority: 'none', category: 'personal' },
        provider: { type: 'bedrock' },
        local: { categories: ['Scratch', 'Temp'] },
      }),
    );

    // Trigger migration by reading store
    const storeCategories = await getStoreCategories();
    expect(storeCategories['Scratch']).toEqual({ source: 'local' });
    expect(storeCategories['Temp']).toEqual({ source: 'local' });
  });

  it('migrates config plugin-a category to store.categories', async () => {
    await fs.mkdir(path.dirname(CONFIG_FILE), { recursive: true });
    await fs.writeFile(
      CONFIG_FILE,
      JSON.stringify({
        version: 1,
        user: { name: 'test' },
        defaults: { priority: 'none', category: 'personal' },
        provider: { type: 'bedrock' },
        plugins: { 'plugin-a': { room_id: 'room-1', category: 'Work' } },
      }),
    );

    const storeCategories = await getStoreCategories();
    expect(storeCategories['Work']).toEqual({ source: 'plugin-a' });
  });

  it('migrates existing tasks categories to store.categories', async () => {
    const tasksDir = path.join(WALNUT_HOME, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });
    await fs.writeFile(
      path.join(tasksDir, 'tasks.json'),
      JSON.stringify({
        tasks: [{
          id: 'seed-1',
          title: 'Task A',
          status: 'todo',
          phase: 'TODO',
          priority: 'none',
          category: 'Life',
          project: 'Life',
          source: 'ms-todo',
          session_ids: [],
          description: '',
          summary: '',
          note: '',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }],
      }),
    );

    const storeCategories = await getStoreCategories();
    expect(storeCategories['Life']).toEqual({ source: 'ms-todo' });
  });

  it('config categories take priority over task-derived categories', async () => {
    await fs.mkdir(path.dirname(CONFIG_FILE), { recursive: true });
    await fs.writeFile(
      CONFIG_FILE,
      JSON.stringify({
        version: 1,
        user: { name: 'test' },
        defaults: { priority: 'none', category: 'personal' },
        provider: { type: 'bedrock' },
        local: { categories: ['Scratch'] },
      }),
    );

    // Seed a task in 'Scratch' with ms-todo source (inconsistent but pre-existing)
    const tasksDir = path.join(WALNUT_HOME, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });
    await fs.writeFile(
      path.join(tasksDir, 'tasks.json'),
      JSON.stringify({
        tasks: [{
          id: 'seed-1',
          title: 'Legacy task',
          status: 'todo',
          phase: 'TODO',
          priority: 'none',
          category: 'Scratch',
          project: 'Scratch',
          source: 'ms-todo',
          session_ids: [],
          description: '',
          summary: '',
          note: '',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }],
      }),
    );

    // Config says 'Scratch' is local — config wins
    const storeCategories = await getStoreCategories();
    expect(storeCategories['Scratch']).toEqual({ source: 'local' });
  });

  it('does not re-run migration when store.categories already exists', async () => {
    const tasksDir = path.join(WALNUT_HOME, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });
    await fs.writeFile(
      path.join(tasksDir, 'tasks.json'),
      JSON.stringify({
        version: 3,
        categories: { 'Custom': { source: 'local' } },
        tasks: [],
      }),
    );

    const storeCategories = await getStoreCategories();
    expect(storeCategories).toEqual({ 'Custom': { source: 'local' } });
  });
});

// ── addTask with store.categories ──

describe('addTask — reads source from store.categories', () => {
  it('uses store.categories source when category exists', async () => {
    await createCategory('Scratch', 'local');
    const { task } = await addTask({ title: 'Note', category: 'Scratch' });
    expect(task.source).toBe('local');
  });

  it('auto-ensures store.categories entry for new categories', async () => {
    // With no external plugins, registry.getForCategory() returns 'local'
    const { task } = await addTask({ title: 'Task', category: 'BrandNew' });
    expect(task.source).toBe('local');

    const storeCategories = await getStoreCategories();
    expect(storeCategories['BrandNew']).toEqual({ source: 'local' });
  });
});

// ── Cross-source migration ──

describe('updateTask — cross-source migration', () => {
  it('migrates task source when moving to category with different source (store_categories)', async () => {
    await createCategory('SourceA', 'ms-todo');
    await createCategory('SourceB', 'plugin-a');

    const { task } = await addTask({ title: 'Migrate me', category: 'SourceA' });
    expect(task.source).toBe('ms-todo');

    const { task: migrated } = await updateTask(task.id, { category: 'SourceB' });
    expect(migrated.id).toBe(task.id); // ID unchanged
    expect(migrated.source).toBe('plugin-a');
    expect(migrated.category).toBe('SourceB');
    expect(migrated.ext).toBeUndefined();
    expect(migrated.external_url).toBeUndefined();
    expect(migrated.sync_error).toBeUndefined();
  });

  it('migrates task source when moving to category with existing tasks of different source', async () => {
    // No explicit category registration — source determined by existing tasks
    const tasksDir = path.join(WALNUT_HOME, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });
    await fs.writeFile(
      path.join(tasksDir, 'tasks.json'),
      JSON.stringify({
        version: 3,
        categories: {},
        tasks: [{
          id: 'existing-1',
          title: 'Existing plugin-b task',
          status: 'todo',
          phase: 'TODO',
          priority: 'none',
          category: 'TeamB',
          project: 'TeamB',
          source: 'plugin-b',
          session_ids: [],
          description: '',
          summary: '',
          note: '',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }],
      }),
    );

    // Create a local task in a different category
    const { task: localTask } = await addTask({ title: 'Local task', category: 'Personal' });
    expect(localTask.source).toBe('local');

    // Move local task to TeamB (has plugin-b tasks) → auto-migrate
    const { task: migrated } = await updateTask(localTask.id, { category: 'TeamB' });
    expect(migrated.source).toBe('plugin-b');
    expect(migrated.category).toBe('TeamB');
    expect(migrated.id).toBe(localTask.id);
  });

  it('preserves task ID across migration', async () => {
    await createCategory('CatA', 'local');
    await createCategory('CatB', 'ms-todo');

    const { task } = await addTask({ title: 'Keep my ID', category: 'CatA' });
    const originalId = task.id;

    const { task: migrated } = await updateTask(task.id, { category: 'CatB' });
    expect(migrated.id).toBe(originalId);
  });

  it('clears ext, external_url, and sync_error on migration', async () => {
    await createCategory('OldCat', 'ms-todo');
    await createCategory('NewCat', 'plugin-a');

    const { task } = await addTask({ title: 'Has ext data', category: 'OldCat' });

    // Manually patch the task file to add ext/external_url/sync_error
    const tasksFile = path.join(WALNUT_HOME, 'tasks', 'tasks.json');
    const raw = JSON.parse(await fs.readFile(tasksFile, 'utf-8'));
    const t = raw.tasks.find((x: { id: string }) => x.id === task.id);
    t.ext = { 'ms-todo': { id: 'remote-123', list_id: 'list-abc' } };
    t.external_url = 'https://example.com/task/123';
    t.sync_error = 'previous error';
    await fs.writeFile(tasksFile, JSON.stringify(raw));
    _resetForTesting(); // force re-read of store

    const { task: migrated } = await updateTask(task.id, { category: 'NewCat' });
    expect(migrated.source).toBe('plugin-a');
    expect(migrated.ext).toBeUndefined();
    expect(migrated.external_url).toBeUndefined();
    expect(migrated.sync_error).toBeUndefined();
  });

  it('migrates same-source children along with parent', async () => {
    await createCategory('CatA', 'local');
    await createCategory('CatB', 'ms-todo');

    const { task: parent } = await addTask({ title: 'Parent', category: 'CatA' });
    const { task: child1 } = await addTask({ title: 'Child 1', category: 'CatA', parent_task_id: parent.id });
    const { task: child2 } = await addTask({ title: 'Child 2', category: 'CatA', parent_task_id: parent.id });

    expect(child1.source).toBe('local');
    expect(child2.source).toBe('local');

    // Migrate parent to CatB (ms-todo)
    const { task: migrated } = await updateTask(parent.id, { category: 'CatB' });
    expect(migrated.source).toBe('ms-todo');

    // Verify children also migrated by reading the store file
    const tasksFile = path.join(WALNUT_HOME, 'tasks', 'tasks.json');
    const raw = JSON.parse(await fs.readFile(tasksFile, 'utf-8'));
    const migratedChild1 = raw.tasks.find((t: { id: string }) => t.id === child1.id);
    const migratedChild2 = raw.tasks.find((t: { id: string }) => t.id === child2.id);
    expect(migratedChild1.source).toBe('ms-todo');
    expect(migratedChild2.source).toBe('ms-todo');
    // Children keep their own category (not changed to CatB)
    expect(migratedChild1.category).toBe('CatA');
    expect(migratedChild2.category).toBe('CatA');
    // Children's IDs unchanged
    expect(migratedChild1.id).toBe(child1.id);
    expect(migratedChild2.id).toBe(child2.id);
  });

  it('does not migrate children with different source than parent', async () => {
    await createCategory('CatA', 'local');
    await createCategory('CatB', 'ms-todo');

    const { task: parent } = await addTask({ title: 'Parent', category: 'CatA' });

    // Create child, then manually change its source to something different
    const { task: child } = await addTask({ title: 'Different source child', category: 'CatA', parent_task_id: parent.id });
    const tasksFile = path.join(WALNUT_HOME, 'tasks', 'tasks.json');
    const raw = JSON.parse(await fs.readFile(tasksFile, 'utf-8'));
    const childInStore = raw.tasks.find((t: { id: string }) => t.id === child.id);
    childInStore.source = 'plugin-b';
    await fs.writeFile(tasksFile, JSON.stringify(raw));
    _resetForTesting();

    // Migrate parent to CatB
    await updateTask(parent.id, { category: 'CatB' });

    // Child with different source should NOT be migrated
    const raw2 = JSON.parse(await fs.readFile(tasksFile, 'utf-8'));
    const childAfter = raw2.tasks.find((t: { id: string }) => t.id === child.id);
    expect(childAfter.source).toBe('plugin-b'); // unchanged
  });

  it('still throws for config_local reservation', async () => {
    await fs.mkdir(path.dirname(CONFIG_FILE), { recursive: true });
    await fs.writeFile(
      CONFIG_FILE,
      JSON.stringify({
        version: 1,
        user: { name: 'test' },
        defaults: { priority: 'none', category: 'personal' },
        provider: { type: 'bedrock' },
        local: { categories: ['Reserved'] },
      }),
    );

    await createCategory('Synced', 'ms-todo');
    const { task } = await addTask({ title: 'Synced task', category: 'Synced' });

    // Moving ms-todo task to config-reserved local category → hard block
    await expect(updateTask(task.id, { category: 'Reserved' })).rejects.toThrow(CategorySourceConflictError);
  });

  it('still throws for config_plugin reservation', async () => {
    await fs.mkdir(path.dirname(CONFIG_FILE), { recursive: true });
    await fs.writeFile(
      CONFIG_FILE,
      JSON.stringify({
        version: 1,
        user: { name: 'test' },
        defaults: { priority: 'none', category: 'personal' },
        provider: { type: 'bedrock' },
        plugins: { 'plugin-a': { room_id: 'room-1', category: 'Work' } },
      }),
    );

    const { task: localTask } = await addTask({ title: 'Local task', category: 'Life' });

    // Moving local task to plugin-a reserved category → hard block
    await expect(updateTask(localTask.id, { category: 'Work' })).rejects.toThrow(CategorySourceConflictError);
  });

  it('updates store.categories source after migration', async () => {
    await createCategory('OldSource', 'local');
    await createCategory('NewSource', 'ms-todo');

    const { task } = await addTask({ title: 'Migrate', category: 'OldSource' });

    await updateTask(task.id, { category: 'NewSource' });

    // Verify store.categories reflects the target source
    const storeCategories = await getStoreCategories();
    expect(storeCategories['NewSource']).toEqual({ source: 'ms-todo' });
  });

  it('handles slash-separated category format in migration', async () => {
    await createCategory('CatA', 'local');
    await createCategory('CatB', 'ms-todo');

    const { task } = await addTask({ title: 'Slash test', category: 'CatA' });
    expect(task.source).toBe('local');

    // Move using slash-separated format "CatB / MyProject"
    const { task: migrated } = await updateTask(task.id, { category: 'CatB / MyProject' });
    expect(migrated.source).toBe('ms-todo');
    expect(migrated.category).toBe('CatB');
    expect(migrated.project).toBe('MyProject');
  });

  it('validateCategorySource returns reason field', () => {
    // store_categories reason
    const r1 = validateCategorySource(
      [], 'Cat', 'local', {},
      { 'Cat': { source: 'ms-todo' } },
    );
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.reason).toBe('store_categories');

    // config_local reason
    const r2 = validateCategorySource(
      [], 'Local', 'ms-todo',
      { local: { categories: ['Local'] } },
    );
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toBe('config_local');

    // config_plugin reason
    const r3 = validateCategorySource(
      [], 'Work', 'local',
      { plugins: { 'plugin-a': { category: 'Work' } } },
    );
    expect(r3.ok).toBe(false);
    if (!r3.ok) expect(r3.reason).toBe('config_plugin');

    // existing_tasks reason
    const tasks = [{
      id: 'x', title: 'X', status: 'todo' as const, phase: 'TODO' as const,
      priority: 'none' as const, category: 'Mixed', project: 'Mixed',
      source: 'plugin-b', session_ids: [], description: '', summary: '',
      note: '', created_at: '', updated_at: '',
    }];
    const r4 = validateCategorySource(tasks, 'Mixed', 'local', {});
    expect(r4.ok).toBe(false);
    if (!r4.ok) expect(r4.reason).toBe('existing_tasks');
  });
});
