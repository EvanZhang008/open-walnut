/**
 * session-organize — fast-model PROJECT placement for quick-start sessions
 * (replaces the old per-launch Personal AI wake-up). Contract pinned:
 *   - model suggestion matching a known project → task moved out of Inbox
 *   - hallucinated names → dropped by canonicalMatch, task stays in Inbox
 *   - this pass may never CREATE a project (only quick-add's human-confirmed
 *     path can) — an unknown name is a no-op
 *   - task already filed (by user/Personal AI) during the model call → no clobber
 *   - model error / non-JSON → never throws, task stays in Inbox
 *
 * Real: organize code, task-manager (SQLite temp store). Fake: sendMessage,
 * config, project digest.
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
  buildProjectDigest: (...args: unknown[]) => digestMock(...args),
}));

import { WALNUT_HOME } from '../../src/constants.js';
import { suggestSessionPlacement, organizeQuickStartTask } from '../../src/core/session-organize.js';
import { addTask, getTask, updateTask, _resetForTesting as resetTaskManager } from '../../src/core/task-manager.js';
import { closeDb } from '../../src/core/task-db.js';

function textResult(text: string) {
  return { content: [{ type: 'text', text }], stopReason: 'end_turn' };
}

const DIGEST = {
  digest: [
    '- walnut (3 open tasks): "Add STT route"; "Fix pipeline"',
    '  about: The Walnut Personal AI repo.',
    '- Errands (1 open tasks): "Buy milk"',
  ].join('\n'),
  projects: ['walnut', 'Errands'],
};

/** A quick-start task lands in Inbox (no project) — that is what this pass files. */
async function makeQuickStartTask() {
  const { task } = await addTask({ title: 'Session: walnut' });
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
  it('returns the canonical project spelling when the model matches a known name', async () => {
    sendMessageMock.mockResolvedValue(textResult('{"project":"WALNUT"}'));
    const s = await suggestSessionPlacement({ cwd: '/Users/me/walnut', message: 'fix the STT route' });
    expect(s).toEqual({ project: 'walnut' });
    // cwd and message both reach the model
    const content = sendMessageMock.mock.calls[0][0].messages[0].content as string;
    expect(content).toContain('/Users/me/walnut');
    expect(content).toContain('fix the STT route');
  });

  it('drops a hallucinated project name (this pass may not create projects)', async () => {
    sendMessageMock.mockResolvedValue(textResult('{"project":"Made Up Stuff"}'));
    await expect(suggestSessionPlacement({ cwd: '/tmp/x' })).resolves.toEqual({});
  });

  it('never throws on model failure or garbage output', async () => {
    sendMessageMock.mockRejectedValue(new Error('model unavailable'));
    await expect(suggestSessionPlacement({ cwd: '/tmp/x' })).resolves.toEqual({});
    sendMessageMock.mockResolvedValue(textResult('not json at all'));
    await expect(suggestSessionPlacement({ cwd: '/tmp/x' })).resolves.toEqual({});
  });

  it('returns empty without calling the model when there are no projects yet', async () => {
    digestMock.mockResolvedValue({ digest: '', projects: [] });
    await expect(suggestSessionPlacement({ cwd: '/tmp/x' })).resolves.toEqual({});
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('tells the model it may not invent a project name', async () => {
    sendMessageMock.mockResolvedValue(textResult('{}'));
    await suggestSessionPlacement({ cwd: '/tmp/x' });
    const system = sendMessageMock.mock.calls[0][0].system as string;
    expect(system).toContain('NEVER invent a name not in the list');
    expect(system).toContain('stays in Inbox');
  });
});

describe('organizeQuickStartTask', () => {
  it('files an Inbox task into the suggested project', async () => {
    const task = await makeQuickStartTask();
    expect(task.project).toBe('');
    sendMessageMock.mockResolvedValue(textResult('{"project":"walnut"}'));

    await organizeQuickStartTask(task.id, '/Users/me/walnut', 'fix stuff');

    const after = await getTask(task.id);
    expect(after.project).toBe('walnut');
  });

  it('does not clobber a placement that happened while the model was thinking', async () => {
    const task = await makeQuickStartTask();
    sendMessageMock.mockImplementation(async () => {
      await updateTask(task.id, { project: 'Errands' }, { source: 'test' });
      return textResult('{"project":"walnut"}');
    });

    await organizeQuickStartTask(task.id, '/Users/me/walnut');

    const after = await getTask(task.id);
    expect(after.project).toBe('Errands');
  });

  it('leaves the task in Inbox when nothing matches', async () => {
    const task = await makeQuickStartTask();
    sendMessageMock.mockResolvedValue(textResult('{}'));

    await organizeQuickStartTask(task.id, '/tmp/x');

    const after = await getTask(task.id);
    expect(after.project).toBe('');
  });

  it('leaves the task in Inbox when the model names a project that does not exist', async () => {
    const task = await makeQuickStartTask();
    sendMessageMock.mockResolvedValue(textResult('{"project":"Brand New Thing"}'));

    await organizeQuickStartTask(task.id, '/tmp/x');

    const after = await getTask(task.id);
    expect(after.project).toBe('');
  });
});
