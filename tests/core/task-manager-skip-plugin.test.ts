/**
 * Tests for addTask's _skipPluginOps flag — the fix for the fork bug.
 *
 * The bug: fork endpoint called addTask() which ran runPluginContentValidation()
 * and threw "CJK characters detected" when the parent task had a plugin source.
 * The fix: fork endpoint passes _skipPluginOps: true to addTask().
 *
 * This test registers a fake plugin with validateContent that rejects CJK,
 * then proves _skipPluginOps bypasses it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-test-fork-skip'));

import { addTask, ensureProject, _resetForTesting } from '../../src/core/task-manager.js';
import { closeDb } from '../../src/core/task-db.js';
import { WALNUT_HOME } from '../../src/constants.js';
import { registry } from '../../src/core/integration-registry.js';
import { createNoopSync, createMockPlugin } from './plugin-test-utils.js';

/** CJK detection regex — matches any CJK Unified Ideograph. */
const CJK_REGEX = /[\u4e00-\u9fff]/;

/** A fake plugin that rejects CJK characters in content validation. */
function createCjkRejecterPlugin() {
  const sync = createNoopSync();
  sync.validateContent = (_task, _field, value) => {
    if (CJK_REGEX.test(value)) {
      return 'CJK characters detected — not supported by this plugin';
    }
    return null;
  };

  return createMockPlugin({
    id: 'fake-cjk-rejecter',
    sync,
    claim: { fn: (() => false) as any, priority: 10 },
  });
}

describe('addTask _skipPluginOps (fork bug fix)', () => {
  beforeEach(async () => {
    // Clean temp directory & reset task-manager state
    closeDb();
    await fs.rm(WALNUT_HOME, { recursive: true, force: true });
    _resetForTesting();

    // Register our fake CJK-rejecting plugin
    if (!registry.has('fake-cjk-rejecter')) {
      registry.register('fake-cjk-rejecter', createCjkRejecterPlugin());
    }

    // Claim a project for the fake plugin: the registry row IS the source of
    // record, so a task filed under PluginProj inherits source=fake-cjk-rejecter
    // and therefore runs that plugin's content validation.
    await ensureProject('PluginProj', 'fake-cjk-rejecter');
  });

  afterEach(async () => {
    closeDb();
    await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  });

  it('creates task with CJK title when _skipPluginOps is true', async () => {
    const { task } = await addTask({
      title: '分叉测试 — Fork of CJK task',
      project: 'PluginProj',
      _skipPluginOps: true,
    });

    expect(task.title).toBe('分叉测试 — Fork of CJK task');
    expect(task.id).toBeTruthy();
    expect(task.source).toBe('fake-cjk-rejecter');
    expect(task.project).toBe('PluginProj');
  });

  it('rejects CJK title WITHOUT _skipPluginOps (proves validation runs)', async () => {
    await expect(
      addTask({
        title: '测试任务 — should fail',
        project: 'PluginProj',
      }),
    ).rejects.toThrow('CJK characters detected');
  });

  it('skips auto-push when _skipPluginOps is true (syncResult is success stub)', async () => {
    const { syncResult } = await addTask({
      title: '推送测试 — fork should not push',
      project: 'PluginProj',
      _skipPluginOps: true,
    });

    expect(syncResult.success).toBe(true);
  });

  it('allows CJK title for local-source tasks (no validateContent)', async () => {
    // Local source has no validateContent, so CJK always passes
    const { task } = await addTask({
      title: '本地任务 — local task with CJK',
      project: 'LocalProject',
    });

    expect(task.title).toBe('本地任务 — local task with CJK');
    expect(task.source).toBe('local');
  });

  it('creates task with CJK description when _skipPluginOps is true', async () => {
    const { task } = await addTask({
      title: 'Fork child',
      description: '这是一个分叉任务的描述',
      project: 'PluginProj',
      _skipPluginOps: true,
    });

    expect(task.description).toBe('这是一个分叉任务的描述');
  });

  it('rejects CJK description WITHOUT _skipPluginOps', async () => {
    await expect(
      addTask({
        title: 'ASCII-only title',
        description: '中文描述 should fail',
        project: 'PluginProj',
      }),
    ).rejects.toThrow('CJK characters detected');
  });
});
