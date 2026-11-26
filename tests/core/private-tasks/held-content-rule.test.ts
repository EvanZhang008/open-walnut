/**
 * A task held by the private-task gate is bound for its project's service, so its text meets that
 * service's content rule from its first write (2026-11-26: a task born held in a tracker project
 * kept a description the tracker refuses; the gate released it, and the tracker refused its
 * create on every sync tick, 44 background errors in 9 hours). Judged by `local` while held, the
 * rule was skipped at create and on every edit. A release (the gate's or a person's Sync) never
 * pushes text the rule refuses either: the task stays local and says why.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-test-held-content-rule'));

import {
  addTask, getTask, ensureProject, releaseSyncHold, setTaskSyncHold, updateDescription, updateTask,
  contentRuleSource, ContentValidationError, _resetForTesting, settleBackgroundPushes,
} from '../../../src/core/task-manager.js';
import { WALNUT_HOME } from '../../../src/constants.js';
import { registry } from '../../../src/core/integration-registry.js';
import { createSpySync, createMockPlugin } from '../plugin-test-utils.js';
import { setPrivacyJudgeForTest } from '../../../src/core/private-tasks/privacy-judge.js';
import { settleSyncGates } from '../../../src/core/private-tasks/sync-gate.js';
import { settlePushChecks, flushApprovals, resetApprovalsForTest } from '../../../src/core/private-tasks/push-check.js';
import { settleEditStops } from '../../../src/core/private-tasks/edit-stop.js';
import { resetKeptDigestForTest } from '../../../src/core/private-tasks/kept-digest.js';

const PLUGIN = 'english-tracker';
const PROJECT = 'Team';
/** Test data: two CJK ideographs, escaped so the source stays ASCII. */
const CJK = '\u4e2d\u6587';
const REFUSED = (field: string) => `Tracker tasks must be in English: CJK characters detected in ${field}.`;

describe('a held task meets its service\'s content rule', () => {
  let sync: ReturnType<typeof createSpySync>;
  let release: () => void;

  beforeEach(async () => {
    await fs.rm(WALNUT_HOME, { recursive: true, force: true });
    _resetForTesting();
    resetApprovalsForTest();
    resetKeptDigestForTest(async () => true);
    // The judge waits until a test lets it answer, so a task stays `checking` while it is edited.
    let gate = new Promise<void>((r) => { release = r; });
    setPrivacyJudgeForTest(async () => { await gate; gate = Promise.resolve(); return { private: false, reason: 'team work' }; });
    sync = createSpySync();
    let n = 0;
    sync.createTask.mockImplementation(async () => ({ [PLUGIN]: { id: `r-${++n}` } }));
    (sync as Record<string, unknown>).validateContent = (_t: unknown, field: string, value: string) =>
      /[\u4e00-\u9fff]/.test(value) ? REFUSED(field) : null;
    if (registry.has(PLUGIN)) registry.unregister(PLUGIN);
    registry.register(PLUGIN, createMockPlugin({ id: PLUGIN, sync }));
    await ensureProject(PROJECT, PLUGIN);
  });

  afterEach(async () => {
    release();
    await settleSyncGates();
    await settlePushChecks();
    await settleEditStops();
    await settleBackgroundPushes();
    await flushApprovals();
    setPrivacyJudgeForTest(null);
    registry.unregister(PLUGIN);
    await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  });

  it('refuses a create whose description the service refuses, though the task is born held', async () => {
    const err = await addTask({ title: 'Plain context package', project: PROJECT, description: `Notes ${CJK}` }).catch((e) => e);
    expect(err).toBeInstanceOf(ContentValidationError);
    expect((err as Error).message).toBe(REFUSED('description'));
    expect(sync.createTask).not.toHaveBeenCalled();
  });

  it('judges edits of a task still being checked by the service it goes to', async () => {
    const { task } = await addTask({ title: 'Plain context package', project: PROJECT, description: 'In English' });
    expect(task.source).toBe('local');
    expect(task.sync_hold).toMatchObject({ state: 'checking', target: PLUGIN });
    expect(contentRuleSource(task)).toBe(PLUGIN);
    await expect(updateDescription(task.id, `Now ${CJK}`)).rejects.toBeInstanceOf(ContentValidationError);
    await expect(updateTask(task.id, { title: `Title ${CJK}` })).rejects.toBeInstanceOf(ContentValidationError);
    release();
    await settleSyncGates();
    const after = await getTask(task.id);
    expect(after.source).toBe(PLUGIN);
    expect(sync.createTask).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(sync.createTask.mock.calls)).not.toContain(CJK);
  });

  it('leaves a task kept local on purpose free to hold any text', async () => {
    const { task } = await addTask({ title: 'Private notes', project: PROJECT, source: 'local', description: `Mine ${CJK}` });
    expect(task.source).toBe('local');
    expect(task.sync_hold?.state).toBe('chosen');
    expect(contentRuleSource(task)).toBe('local');
    await updateDescription(task.id, `Still mine ${CJK}`);
  });

  it('a person\'s Sync of such a task sends nothing and says why', async () => {
    const { task } = await addTask({ title: 'Private notes', project: PROJECT, source: 'local', description: `Mine ${CJK}` });
    const out = await releaseSyncHold(task.id, undefined, 'user');
    expect(out).toMatchObject({ released: false, reason: 'content_rejected', detail: REFUSED('description') });
    expect((await getTask(task.id)).source).toBe('local');
    await settleBackgroundPushes();
    expect(sync.createTask).not.toHaveBeenCalled();
  });

  it('a task the gate still checks whose old text breaks the rule waits, not judged again at each boot', async () => {
    // Text written before held tasks were judged by their target: kept local, then put back to checking.
    const { task } = await addTask({ title: 'Older task', project: PROJECT, source: 'local', description: `Old ${CJK}` });
    await setTaskSyncHold(task.id, (t) => ({ ...t.sync_hold!, state: 'checking', by: undefined }));
    const out = await releaseSyncHold(task.id);
    expect(out).toMatchObject({ released: false, reason: 'content_rejected' });
    const after = await getTask(task.id);
    expect(after.source).toBe('local');
    expect(after.sync_hold?.state).toBe('unjudged');
    expect(after.sync_hold?.reason).toContain(REFUSED('description'));
    expect(sync.createTask).not.toHaveBeenCalled();
  });
});
