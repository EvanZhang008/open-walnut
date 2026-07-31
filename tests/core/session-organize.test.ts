/**
 * session-organize — fast-model category/project placement for quick-start
 * sessions (replaces the old per-launch butler wake-up). Contract pinned:
 *   - model suggestion matching a known category/project → task moved
 *   - hallucinated names → dropped by canonicalMatch, task stays put
 *   - task already moved (by user/butler) during the model call → no clobber
 *   - model error / non-JSON → never throws, task stays put
 *
 * Real: organize code, task-manager (SQLite temp store). Fake: sendMessage,
 * config, category digest.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-session-organize'));

const sendMessageMock = vi.fn();
vi.mock('../../src/agent/model.js', () => ({
  sendMessage: (...args: unknown[]) => sendMessageMock(...args),
}));
// config-manager is NOT mocked: constants point at a temp WALNUT_HOME, so the
// real one serves first-run defaults (bedrock provider) — and task-manager's
// addTask needs the full config shape (defaults.priority etc.).
const digestMock = vi.fn();
vi.mock('../../src/core/quick-task-digest.js', () => ({
  buildCategoryDigest: (...args: unknown[]) => digestMock(...args),
}));

import { WALNUT_HOME } from '../../src/constants.js';
import { suggestSessionPlacement, organizeQuickStartTask } from '../../src/core/session-organize.js';
import { addTask, getTask, updateTask, _resetForTesting as resetTaskManager } from '../../src/core/task-manager.js';
import { closeDb } from '../../src/core/task-db.js';

function textResult(text: string) {
  return { content: [{ type: 'text', text }], stopReason: 'end_turn' };
}

const DIGEST = {
  digest: '- Work (3 open tasks): "Fix pipeline"\n  - walnut: "Add STT route"\n- Life (1 open tasks): "Buy milk"',
  categories: ['Work', 'Life'],
  projectsByCategory: { Work: ['walnut'], Life: [] },
};

async function makeQuickStartTask() {
  const { task } = await addTask({ title: 'Session: walnut', category: 'Local', project: 'Quick Start' });
  return getTask(task.id);
}

beforeEach(async () => {
  closeDb(); // rm alone leaves the open handle → tasks leak across tests
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  resetTaskManager();
  sendMessageMock.mockReset();
  digestMock.mockReset();
  digestMock.mockResolvedValue(DIGEST);
});

afterEach(async () => {
  closeDb();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('suggestSessionPlacement', () => {
  it('returns a canonical category + project when the model matches known names', async () => {
    sendMessageMock.mockResolvedValue(textResult('{"category":"work","project":"WALNUT"}'));
    const s = await suggestSessionPlacement({ cwd: '/Users/me/walnut', message: 'fix the STT route' });
    expect(s).toEqual({ category: 'Work', project: 'walnut' });
    // cwd and message both reach the model
    const content = sendMessageMock.mock.calls[0][0].messages[0].content as string;
    expect(content).toContain('/Users/me/walnut');
    expect(content).toContain('fix the STT route');
  });

  it('drops hallucinated category names', async () => {
    sendMessageMock.mockResolvedValue(textResult('{"category":"Made Up Stuff"}'));
    await expect(suggestSessionPlacement({ cwd: '/tmp/x' })).resolves.toEqual({});
  });

  it('keeps the category but drops a hallucinated project', async () => {
    sendMessageMock.mockResolvedValue(textResult('{"category":"Work","project":"nonexistent"}'));
    await expect(suggestSessionPlacement({ cwd: '/tmp/x' })).resolves.toEqual({ category: 'Work' });
  });

  it('never throws on model failure or garbage output', async () => {
    sendMessageMock.mockRejectedValue(new Error('model unavailable'));
    await expect(suggestSessionPlacement({ cwd: '/tmp/x' })).resolves.toEqual({});
    sendMessageMock.mockResolvedValue(textResult('not json at all'));
    await expect(suggestSessionPlacement({ cwd: '/tmp/x' })).resolves.toEqual({});
  });

  it('returns empty when there are no categories yet', async () => {
    digestMock.mockResolvedValue({ digest: '', categories: [], projectsByCategory: {} });
    await expect(suggestSessionPlacement({ cwd: '/tmp/x' })).resolves.toEqual({});
    expect(sendMessageMock).not.toHaveBeenCalled();
  });
});

describe('organizeQuickStartTask', () => {
  it('moves a default-placed task to the suggested category/project', async () => {
    const task = await makeQuickStartTask();
    sendMessageMock.mockResolvedValue(textResult('{"category":"Work","project":"walnut"}'));

    await organizeQuickStartTask(task.id, '/Users/me/walnut', 'fix stuff');

    const after = await getTask(task.id);
    expect(after.category).toBe('Work');
    expect(after.project).toBe('walnut');
  });

  it('defaults project to the category name when only category matched', async () => {
    const task = await makeQuickStartTask();
    sendMessageMock.mockResolvedValue(textResult('{"category":"Life"}'));

    await organizeQuickStartTask(task.id, '/tmp/errands', 'buy groceries');

    const after = await getTask(task.id);
    expect(after.category).toBe('Life');
    expect(after.project).toBe('Life');
  });

  it('does not clobber a move that happened while the model was thinking', async () => {
    const task = await makeQuickStartTask();
    sendMessageMock.mockImplementation(async () => {
      await updateTask(task.id, { category: 'Life', project: 'Life' }, { source: 'test' });
      return textResult('{"category":"Work","project":"walnut"}');
    });

    await organizeQuickStartTask(task.id, '/Users/me/walnut');

    const after = await getTask(task.id);
    expect(after.category).toBe('Life');
  });

  it('leaves the task put when nothing matches', async () => {
    const task = await makeQuickStartTask();
    sendMessageMock.mockResolvedValue(textResult('{}'));

    await organizeQuickStartTask(task.id, '/tmp/x');

    const after = await getTask(task.id);
    expect(after.category).toBe('Local');
    expect(after.project).toBe('Quick Start');
  });

  it('ignores a suggestion of Local (the transit stop itself)', async () => {
    const task = await makeQuickStartTask();
    digestMock.mockResolvedValue({
      digest: '- Local (2 open tasks): "Session: walnut"',
      categories: ['Local'],
      projectsByCategory: { Local: [] },
    });
    sendMessageMock.mockResolvedValue(textResult('{"category":"Local"}'));

    await organizeQuickStartTask(task.id, '/tmp/x');

    const after = await getTask(task.id);
    expect(after.project).toBe('Quick Start'); // not rewritten to Local/Local
  });
});
