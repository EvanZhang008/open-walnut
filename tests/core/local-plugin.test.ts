/**
 * Unit tests for the local plugin (src/integrations/local/index.ts).
 *
 * Section B from PLUGIN_TEST_PLAN.md.
 * Tests:
 * - B1: register() calls registerSync with all 16 methods
 * - B2: every sync method resolves without error
 * - B3: createTask returns null
 * - B4: source claim returns true for any category
 * - B5: source claim has priority -1
 * - B6: display metadata has badge "L"
 * - B7: display.getExternalUrl returns null
 * - B8: display.isSynced returns false
 */
import { describe, it, expect } from 'vitest';
import registerLocal from '../../src/integrations/local/index.js';
import { createTestPluginApi, createMockTask } from './plugin-test-utils.js';

// ── Setup ──

const { api, collected } = createTestPluginApi({ id: 'local', name: 'Local' });
registerLocal(api);

// ── Tests ──

describe('Local plugin: registerSync', () => {
  it('B1: registers sync with all 16 methods', () => {
    expect(collected.sync).not.toBeNull();
    const sync = collected.sync!;
    const expectedMethods = [
      'createTask', 'deleteTask',
      'updateTitle', 'updateDescription', 'updateSummary', 'updateNote',
      'updateConversationLog', 'updatePriority', 'updatePhase', 'updateDueDate',
      'updateStar', 'updateCategory', 'updateDependencies',
      'associateSubtask', 'disassociateSubtask',
      'syncPoll',
    ];
    for (const method of expectedMethods) {
      expect(typeof (sync as any)[method]).toBe('function');
    }
    expect(expectedMethods).toHaveLength(16);
  });

  it('B2: every sync method resolves without error', async () => {
    const sync = collected.sync!;
    const task = createMockTask();
    const childTask = createMockTask({ id: 'child-1' });
    const ctx = {
      getTasks: () => [],
      updateTask: async () => task,
      addTask: async () => task,
      deleteTask: async () => {},
      emit: () => {},
    };

    // All methods should resolve without throwing
    await expect(sync.createTask(task)).resolves.not.toThrow();
    await expect(sync.deleteTask(task)).resolves.not.toThrow();
    await expect(sync.updateTitle(task, 'new title')).resolves.not.toThrow();
    await expect(sync.updateDescription(task, 'desc')).resolves.not.toThrow();
    await expect(sync.updateSummary(task, 'sum')).resolves.not.toThrow();
    await expect(sync.updateNote(task, 'note')).resolves.not.toThrow();
    await expect(sync.updateConversationLog(task, 'log')).resolves.not.toThrow();
    await expect(sync.updatePriority(task, 'high')).resolves.not.toThrow();
    await expect(sync.updatePhase(task, 'IN_PROGRESS')).resolves.not.toThrow();
    await expect(sync.updateDueDate(task, '2026-01-01')).resolves.not.toThrow();
    await expect(sync.updateStar(task, true)).resolves.not.toThrow();
    await expect(sync.updateCategory(task, 'Work', 'Project')).resolves.not.toThrow();
    await expect(sync.updateDependencies(task, ['dep-1'])).resolves.not.toThrow();
    await expect(sync.associateSubtask(task, childTask)).resolves.not.toThrow();
    await expect(sync.disassociateSubtask(task, childTask)).resolves.not.toThrow();
    await expect(sync.syncPoll(ctx)).resolves.not.toThrow();
  });

  it('B3: createTask returns null', async () => {
    const sync = collected.sync!;
    const task = createMockTask();
    const result = await sync.createTask(task);
    expect(result).toBeNull();
  });
});

describe('Local plugin: source claim', () => {
  it('B4: source claim returns true for any category', () => {
    expect(collected.claim).not.toBeNull();
    expect(collected.claim!.fn('anything')).toBe(true);
    expect(collected.claim!.fn('')).toBe(true);
    expect(collected.claim!.fn('Work')).toBe(true);
    expect(collected.claim!.fn('Personal')).toBe(true);
  });

  it('B5: source claim has priority -1', () => {
    expect(collected.claim!.priority).toBe(-1);
  });
});

describe('Local plugin: display metadata', () => {
  it('B6: display badge is "L" with color "#8E8E93"', () => {
    expect(collected.display).not.toBeNull();
    expect(collected.display!.badge).toBe('L');
    expect(collected.display!.badgeColor).toBe('#8E8E93');
  });

  it('B7: getExternalUrl returns null', () => {
    const task = createMockTask();
    expect(collected.display!.getExternalUrl(task)).toBeNull();
  });

  it('B8: isSynced returns false', () => {
    const task = createMockTask();
    expect(collected.display!.isSynced(task)).toBe(false);
  });

  it('externalLinkLabel is "Local"', () => {
    expect(collected.display!.externalLinkLabel).toBe('Local');
  });

  it('syncTooltip describes local-only', () => {
    const task = createMockTask();
    expect(collected.display!.syncTooltip?.(task)).toContain('Local only');
  });
});
