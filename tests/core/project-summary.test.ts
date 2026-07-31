/**
 * project-summary — fast-model per-project summaries regenerated at task-count
 * thresholds (1, 2, 4, 8, 20, then every 20). Contract pinned:
 *   - threshold math (exact hits below 20, modulo after)
 *   - full regeneration: previous summary + task titles reach the prompt;
 *     missing descriptions never block
 *   - persisted into .metadata_project as summary + summary_task_count
 *   - non-threshold counts and bulk sources never call the model
 *   - stale/duplicate crossings deduped via summary_task_count
 *
 * Real: summary code, task-manager (SQLite temp store). Fake: sendMessage,
 * config.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-project-summary'));

const sendMessageMock = vi.fn();
vi.mock('../../src/agent/model.js', () => ({
  sendMessage: (...args: unknown[]) => sendMessageMock(...args),
}));
// config-manager is NOT mocked: constants point at a temp WALNUT_HOME, so the
// real one serves first-run defaults (bedrock provider) — and task-manager's
// addTask needs the full config shape (defaults.priority etc.).

import { WALNUT_HOME } from '../../src/constants.js';
import {
  isSummaryThreshold, maybeRefreshForTask, refreshProjectSummary, __resetProjectSummaryState,
} from '../../src/core/project-summary.js';
import { addTask, getTask, getProjectMetadata, _resetForTesting as resetTaskManager } from '../../src/core/task-manager.js';
import { closeDb } from '../../src/core/task-db.js';
import type { Task } from '../../src/core/types.js';

function textResult(text: string) {
  return { content: [{ type: 'text', text }], stopReason: 'end_turn' };
}

let seedCounter = 0;
async function seedTasks(n: number, category = 'Work', project = 'walnut'): Promise<Task> {
  let last: Task | undefined;
  for (let i = 0; i < n; i++) {
    const { task } = await addTask({ title: `Task number ${++seedCounter}`, category, project });
    last = task;
  }
  return getTask(last!.id);
}

beforeEach(async () => {
  closeDb(); // rm alone leaves the open handle → tasks leak across tests
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  resetTaskManager();
  __resetProjectSummaryState();
  seedCounter = 0;
  sendMessageMock.mockReset();
  sendMessageMock.mockResolvedValue(textResult('{"summary":"A project about walnut development."}'));
});

afterEach(async () => {
  closeDb();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('isSummaryThreshold', () => {
  it('hits exactly 1, 2, 4, 8, 20, then every 20', () => {
    const hits = Array.from({ length: 61 }, (_, i) => i).filter(isSummaryThreshold);
    expect(hits).toEqual([1, 2, 4, 8, 20, 40, 60]);
  });
});

describe('maybeRefreshForTask', () => {
  it('generates and persists summary + summary_task_count at a threshold', async () => {
    const task = await seedTasks(1);

    const ran = await maybeRefreshForTask(task, 'web-api');

    expect(ran).toBe(true);
    expect(sendMessageMock).toHaveBeenCalledOnce();
    const meta = await getProjectMetadata('Work', 'walnut');
    expect(meta?.summary).toBe('A project about walnut development.');
    expect(meta?.summary_task_count).toBe(1);
  });

  it('does nothing between thresholds', async () => {
    const task = await seedTasks(3); // 3 is not a threshold

    const ran = await maybeRefreshForTask(task, 'web-api');

    expect(ran).toBe(false);
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('skips bulk sources, subtasks, and metadata tasks', async () => {
    const task = await seedTasks(1);
    expect(await maybeRefreshForTask(task, 'jira-sync')).toBe(false);
    expect(await maybeRefreshForTask({ ...task, parent_task_id: 'x' }, 'web-api')).toBe(false);
    expect(await maybeRefreshForTask({ ...task, title: '.metadata_project' }, 'web-api')).toBe(false);
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('dedupes a re-fired threshold via summary_task_count', async () => {
    const task = await seedTasks(2);

    expect(await maybeRefreshForTask(task, 'web-api')).toBe(true);
    expect(await maybeRefreshForTask(task, 'web-api')).toBe(false); // same count, already recorded
    expect(sendMessageMock).toHaveBeenCalledOnce();
  });

  it('feeds the previous summary and task titles into the prompt; tolerates missing descriptions', async () => {
    const task = await seedTasks(2);
    await maybeRefreshForTask(task, 'web-api'); // seeds previous summary at count 2

    // Two more tasks → count 4 (threshold). None of the tasks have descriptions.
    const t4 = await seedTasks(2);
    sendMessageMock.mockResolvedValue(textResult('{"summary":"Updated: walnut work continues."}'));
    expect(await maybeRefreshForTask(t4, 'web-api')).toBe(true);

    const content = sendMessageMock.mock.calls.at(-1)![0].messages[0].content as string;
    expect(content).toContain('Previous summary:');
    expect(content).toContain('A project about walnut development.');
    expect(content).toContain('Task number 4');
    const meta = await getProjectMetadata('Work', 'walnut');
    expect(meta?.summary).toBe('Updated: walnut work continues.');
    expect(meta?.summary_task_count).toBe(4);
  });

  it('keeps prior metadata keys when writing the summary', async () => {
    const { setProjectMetadata } = await import('../../src/core/task-manager.js');
    await setProjectMetadata('Work', 'walnut', { default_cwd: '/tmp/walnut' });
    const task = await seedTasks(1);

    await maybeRefreshForTask(task, 'web-api');

    const meta = await getProjectMetadata('Work', 'walnut');
    expect(meta?.default_cwd).toBe('/tmp/walnut');
    expect(meta?.summary).toBeTruthy();
  });
});

describe('refreshProjectSummary', () => {
  it('returns false (and persists nothing) when the model output is unusable', async () => {
    await seedTasks(1);
    sendMessageMock.mockResolvedValue(textResult('not json'));

    expect(await refreshProjectSummary('Work', 'walnut')).toBe(false);
    expect(await getProjectMetadata('Work', 'walnut')).toBeNull();
  });

  it('returns false for a project with no tasks', async () => {
    expect(await refreshProjectSummary('Work', 'ghost')).toBe(false);
    expect(sendMessageMock).not.toHaveBeenCalled();
  });
});
