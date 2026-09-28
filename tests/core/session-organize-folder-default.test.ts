/**
 * session-organize — a project the launch took from its FOLDER is final only
 * when the folder is that project's own declared folder. A project inherited
 * from a parent folder (or one of several projects sharing a folder) is a
 * default the fast model may overturn from the cwd + message.
 *
 * Incident (2026-09-28): a team subfolder of a shared checkout was launched
 * with "triage the team's tickets"; the checkout's project owned every folder
 * under it, and auto-organize never ran because the client had supplied a
 * project.
 *
 * Real: organize code, task-manager (SQLite temp store). Fake: sendMessage,
 * project digest.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-session-organize-folder'));

const sendMessageMock = vi.fn();
vi.mock('../../src/model/model.js', () => ({
  sendMessage: (...args: unknown[]) => sendMessageMock(...args),
}));
const digestMock = vi.fn();
vi.mock('../../src/core/quick-task-digest.js', () => ({
  buildProjectDigest: (...args: unknown[]) => digestMock(...args),
}));

import { WALNUT_HOME } from '../../src/constants.js';
import { folderDefaultKind, organizeQuickStartTask } from '../../src/core/session-organize.js';
import {
  addTask, addToGroup, createFolder, getTask, updateTask, setProjectMetadata, _resetForTesting as resetTaskManager,
} from '../../src/core/task-manager.js';
import { closeDb } from '../../src/core/task-db.js';

const CHECKOUT = '/work/hub/context';
const TEAM_DIR = `${CHECKOUT}/teams/marina`;

function textResult(text: string) {
  return { content: [{ type: 'text', text }], stopReason: 'end_turn' };
}

const DIGEST = {
  digest: [
    '- Context Agent (2 open tasks): "Pipeline cleanup"',
    '- Marina Team (4 open tasks): "Ticket triage"; "Alarm tuning"',
  ].join('\n'),
  projects: ['Context Agent', 'Marina Team', 'Hub Review'],
};

/** What quick-start leaves behind: a task already filed under the folder's project. */
async function launchedUnder(project: string) {
  const { task } = await addTask({ title: 'Session: marina', project });
  return getTask(task.id);
}

function promptOf(call = 0): string {
  return sendMessageMock.mock.calls[call][0].messages[0].content as string;
}

beforeEach(async () => {
  closeDb();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  resetTaskManager();
  sendMessageMock.mockReset();
  digestMock.mockReset();
  digestMock.mockResolvedValue(DIGEST);
  await setProjectMetadata('Context Agent', { default_cwd: `${CHECKOUT}/` });
  await setProjectMetadata('Marina Team', { default_cwd: '/elsewhere/marina' });
});

afterEach(async () => {
  closeDb();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('folderDefaultKind', () => {
  const projects = {
    'Context Agent': { metadata: { default_cwd: `${CHECKOUT}/` } },
    'Hub Review': { metadata: { default_cwd: '/work/shared' } },
    'Other Review': { metadata: { default_cwd: '/work/shared/' } },
    'No Folder': { metadata: {} },
    Bare: {},
  };

  it("is final only on the project's own folder, however the slashes fall", () => {
    expect(folderDefaultKind(projects, 'Context Agent', CHECKOUT)).toBe('final');
    expect(folderDefaultKind(projects, 'context agent', `${CHECKOUT}//`)).toBe('final');
  });

  it('a folder two projects declare is shared, whichever of them the launch carried', () => {
    expect(folderDefaultKind(projects, 'Hub Review', '/work/shared')).toBe('shared');
    expect(folderDefaultKind(projects, 'Other Review', '/work/shared/')).toBe('shared');
  });

  it('the nearest declared folder decides, the same walk as the draft column', () => {
    // A subfolder of the shared checkout: the incident, sent by an older client
    // that took the first declarer by name.
    expect(folderDefaultKind(projects, 'Hub Review', '/work/shared/teams/marina')).toBe('shared');
    // The nearest owner is another project: the launch's project is not backed.
    expect(folderDefaultKind(projects, 'Hub Review', `${CHECKOUT}/teams/marina`)).toBe('shared');
    // A farther owner never outranks a nearer one.
    const nested = { ...projects, 'Marina Team': { metadata: { default_cwd: `${CHECKOUT}/teams/marina` } } };
    expect(folderDefaultKind(nested, 'Marina Team', `${CHECKOUT}/teams/marina/pkg`)).toBe('inherited');
    expect(folderDefaultKind(nested, 'Context Agent', `${CHECKOUT}/teams/marina/pkg`)).toBe('shared');
  });

  it('a parent folder, or a project with no folder at all, is inherited', () => {
    expect(folderDefaultKind(projects, 'Context Agent', TEAM_DIR)).toBe('inherited');
    expect(folderDefaultKind(projects, 'No Folder', '/work/elsewhere')).toBe('inherited');
    expect(folderDefaultKind(projects, 'Bare', '')).toBe('inherited');
    // Paths are case-sensitive.
    expect(folderDefaultKind(projects, 'Context Agent', CHECKOUT.toUpperCase())).toBe('inherited');
  });
});

describe('organizeQuickStartTask with a folder default', () => {
  it("moves a task off an inherited project when the message fits another, and tells the model it may keep it", async () => {
    const task = await launchedUnder('Context Agent');
    sendMessageMock.mockResolvedValue(textResult('{"project":"Marina Team"}'));

    await organizeQuickStartTask(task.id, TEAM_DIR, "triage the marina team's tickets", { folderProject: 'Context Agent' });

    expect((await getTask(task.id)).project).toBe('Marina Team');
    expect(promptOf()).toContain('currently filed under "Context Agent" only because its working directory is inside');
    expect(promptOf()).toContain(TEAM_DIR);
  });

  it('keeps the inherited project when the model agrees or finds nothing better', async () => {
    const task = await launchedUnder('Context Agent');
    sendMessageMock.mockResolvedValueOnce(textResult('{"project":"context agent"}'));
    await organizeQuickStartTask(task.id, TEAM_DIR, 'clean up the pipeline', { folderProject: 'Context Agent' });
    const kept = await getTask(task.id);
    expect(kept.project).toBe('Context Agent');
    // Same project in another casing is not a move: nothing was written.
    expect(kept.updated_at).toBe(task.updated_at);

    sendMessageMock.mockResolvedValueOnce(textResult('{}'));
    await organizeQuickStartTask(task.id, TEAM_DIR, 'hello', { folderProject: 'Context Agent' });
    expect((await getTask(task.id)).project).toBe('Context Agent');
  });

  it("never asks the model when the launch folder IS the project's own folder", async () => {
    const task = await launchedUnder('Context Agent');
    sendMessageMock.mockResolvedValue(textResult('{"project":"Marina Team"}'));

    await organizeQuickStartTask(task.id, CHECKOUT, 'triage tickets', { folderProject: 'Context Agent' });

    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(digestMock).not.toHaveBeenCalled();
    expect((await getTask(task.id)).project).toBe('Context Agent');
  });

  it('a folder two projects declare is not final even on the folder itself, and gets no keep hint', async () => {
    await setProjectMetadata('Hub Review', { default_cwd: CHECKOUT });
    const task = await launchedUnder('Context Agent');
    sendMessageMock.mockResolvedValue(textResult('{"project":"Hub Review"}'));

    await organizeQuickStartTask(task.id, CHECKOUT, 'review the threat model', { folderProject: 'Context Agent' });

    expect((await getTask(task.id)).project).toBe('Hub Review');
    // The older client's pick between the two was alphabetical, not evidence.
    expect(promptOf()).not.toContain('currently filed under');
  });

  it('does not clobber a move the user made while the model was thinking', async () => {
    const task = await launchedUnder('Context Agent');
    sendMessageMock.mockImplementation(async () => {
      await updateTask(task.id, { project: 'Hub Review' }, { source: 'test' });
      return textResult('{"project":"Marina Team"}');
    });

    await organizeQuickStartTask(task.id, TEAM_DIR, 'triage tickets', { folderProject: 'Context Agent' });

    expect((await getTask(task.id)).project).toBe('Hub Review');
  });

  it('does not move a task someone filed into one of its project\'s folders meanwhile', async () => {
    const task = await launchedUnder('Context Agent');
    const folder = await createFolder('Tickets', 'Context Agent');
    sendMessageMock.mockImplementation(async () => {
      await addToGroup(folder.group_id, [task.id]);
      return textResult('{"project":"Marina Team"}');
    });

    await organizeQuickStartTask(task.id, TEAM_DIR, 'triage tickets', { folderProject: 'Context Agent' });

    const after = await getTask(task.id);
    expect(after.project).toBe('Context Agent');
    expect(after.group_id).toBe(folder.group_id);
  });

  it('without a folder default, a filed task is still left alone (the old contract)', async () => {
    const task = await launchedUnder('Context Agent');
    sendMessageMock.mockResolvedValue(textResult('{"project":"Marina Team"}'));

    await organizeQuickStartTask(task.id, TEAM_DIR, 'triage tickets');

    expect((await getTask(task.id)).project).toBe('Context Agent');
    expect(promptOf()).not.toContain('currently filed under');
  });
});
