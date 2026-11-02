/**
 * Private tasks against a sync plugin (src/core/private-tasks/): every new task bound for an
 * outside service is born local and judged first; nothing of a private one, or of one the model
 * could not judge, reaches the plugin; an edit that adds a private word stops a synced task
 * before the push; a task turned local keeps its content and its outside copy is kept, archived
 * or neutralized; and the guard refuses any plugin call that carries a local task.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-test-private-tasks'));

import {
  addTask, addTaskFull, updateTask, getTask, ensureProject, makeTaskLocal, releaseSyncHold, setTaskSyncHold,
  _resetForTesting, settleBackgroundPushes, updateTaskRaw,
} from '../../../src/core/task-manager.js';
import { updateConfig } from '../../../src/core/config-manager.js';
import { WALNUT_HOME } from '../../../src/constants.js';
import { registry } from '../../../src/core/integration-registry.js';
import { createSpySync, createMockPlugin } from '../plugin-test-utils.js';
import { setPrivacyJudgeForTest, type PrivacyInput, type PrivacyVerdict } from '../../../src/core/private-tasks/privacy-judge.js';
import { resumeSyncGates, settleSyncGates, onKeptLocalAnswer, LETTER_ACTIONS } from '../../../src/core/private-tasks/sync-gate.js';
import { settleEditStops } from '../../../src/core/private-tasks/edit-stop.js';
import { isPrivateTaskBlocked } from '../../../src/core/private-tasks/sync-guard.js';
import { checkPushText, flushApprovals, resetApprovalsForTest, seedOutsideBaseline, settlePushChecks } from '../../../src/core/private-tasks/push-check.js';
import { listLetters, answerLetter, sendLetter } from '../../../src/core/human-inbox/store.js';
import { pendingKeptForTest, resetKeptDigestForTest, tellKeptDigestNow } from '../../../src/core/private-tasks/kept-digest.js';
import { getRemoteLink, recordRemoteLink } from '../../../src/core/task-remote-links.js';
import type { Task } from '../../../src/core/types.js';

const PLUGIN = 'fake-tracker';
const PROJECT = 'Work';

/** Every text the plugin was handed, from any method: what reached the outside service. */
function sentTexts(sync: ReturnType<typeof createSpySync>): string {
  const out: string[] = [];
  for (const fn of Object.values(sync)) {
    const calls = (fn as { mock?: { calls: unknown[][] } }).mock?.calls ?? [];
    for (const args of calls) out.push(JSON.stringify(args));
  }
  return out.join('\n');
}

/** A decision letter as the version before 2026-11-02 sent one for a kept task: its answer still works. */
async function oldLetter(taskId: string): Promise<string> {
  const letter = await sendLetter({
    subject: 'kept out', type: 'action_required', markdown: 'kept out',
    actions: [{ id: LETTER_ACTIONS.keep, label: 'Keep local' }, { id: LETTER_ACTIONS.sync, label: 'Sync' }],
    taskRefs: [taskId], sender: { sessionId: 'external', host: 'local' },
  });
  await setTaskSyncHold(taskId, (t) => t.sync_hold ? { ...t.sync_hold, letter_id: letter.id } : null);
  return letter.id;
}

describe('private tasks against a sync plugin', () => {
  let sync: ReturnType<typeof createSpySync>;
  let judged: PrivacyInput[];
  let verdict: (input: PrivacyInput) => Promise<PrivacyVerdict>;

  beforeEach(async () => {
    await fs.rm(WALNUT_HOME, { recursive: true, force: true });
    _resetForTesting();
    resetApprovalsForTest();
    resetKeptDigestForTest(async () => true);
    judged = [];
    verdict = async () => ({ private: false, reason: 'team work' });
    setPrivacyJudgeForTest(async (input) => { judged.push(input); return verdict(input); });
    sync = createSpySync();
    let n = 0;
    sync.createTask.mockImplementation(async () => ({ [PLUGIN]: { id: `r-${++n}` } }));
    if (registry.has(PLUGIN)) registry.unregister(PLUGIN);
    registry.register(PLUGIN, createMockPlugin({ id: PLUGIN, sync }));
    await ensureProject(PROJECT, PLUGIN);
    await updateConfig({ private_tasks: { words: ['marigold'] } } as never);
  });

  afterEach(async () => {
    await settleSyncGates();
    await settlePushChecks();
    await settleEditStops();
    await settleBackgroundPushes();
    await flushApprovals();
    setPrivacyJudgeForTest(null);
    registry.unregister(PLUGIN);
    await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  });

  it('a task the model judges to be work is held local until then, then synced once', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    verdict = async () => { await gate; return { private: false, reason: 'team work' }; };
    const { task } = await addTask({ title: 'Fix the login retry', project: PROJECT, asyncPush: true });
    expect(task.source).toBe('local');
    expect(task.sync_hold).toMatchObject({ state: 'checking', target: PLUGIN });
    // Nothing reaches the plugin while it is judged.
    await new Promise((r) => setTimeout(r, 30));
    expect(sync.createTask).not.toHaveBeenCalled();
    release();
    await settleSyncGates();
    const after = await getTask(task.id);
    expect(after.source).toBe(PLUGIN);
    expect(after.sync_hold).toBeUndefined();
    expect(sync.createTask).toHaveBeenCalledTimes(1);
    expect(judged.map((j) => j.title)).toEqual(['Fix the login retry']);
  });

  it('a task the model judges private stays local, nothing is sent, and no letter asks the user: Main hears it in the day\'s line', async () => {
    verdict = async () => ({ private: true, reason: 'a private matter' });
    const { task } = await addTask({ title: 'Notes on Zephyr for the review', project: PROJECT, description: 'Zephyr details' });
    await settleSyncGates();
    const after = await getTask(task.id);
    expect(after.source).toBe('local');
    expect(after.sync_hold).toMatchObject({ state: 'private', by: 'model', target: PLUGIN });
    expect(after.sync_hold?.reason).toContain('a private matter');
    expect(sentTexts(sync)).not.toContain('Zephyr');
    expect((await listLetters()).letters).toHaveLength(0);
    expect(after.sync_hold?.letter_id).toBeUndefined();
    expect(await pendingKeptForTest()).toEqual([task.id]);
    const line = await tellKeptDigestNow();
    expect(line).toContain(`"Notes on Zephyr for the review" (${task.id})`);
    expect(line).toContain('Nothing waits on the user');
    // Told once: the next call has nothing to say.
    expect(await tellKeptDigestNow()).toBeNull();
  });

  it('when the model cannot answer the task stays local and the user is told: no push goes out unjudged', async () => {
    verdict = async () => { throw new Error('the model did not answer within 20 s'); };
    const { task } = await addTask({ title: 'Plan the rollout', project: PROJECT });
    await settleSyncGates();
    const after = await getTask(task.id);
    expect(after.source).toBe('local');
    expect(after.sync_hold).toMatchObject({ state: 'unjudged' });
    expect(after.sync_hold?.reason).toContain('did not answer');
    expect(sync.createTask).not.toHaveBeenCalled();
    expect((await listLetters()).letters).toHaveLength(0);
    expect(await pendingKeptForTest()).toEqual([task.id]);
  });

  it('a private word keeps it local without asking the model', async () => {
    const { task } = await addTask({ title: 'My marigold packet', project: PROJECT });
    await settleSyncGates();
    expect(judged).toHaveLength(0);
    const after = await getTask(task.id);
    expect(after.sync_hold).toMatchObject({ state: 'private', by: 'words' });
    expect(sync.createTask).not.toHaveBeenCalled();
  });

  it('a creator\'s Local choice is honoured, also beside a synced parent', async () => {
    const { task: parent } = await addTask({ title: 'Release train', project: PROJECT });
    await settleSyncGates();
    expect((await getTask(parent.id)).source).toBe(PLUGIN);
    const { task } = await addTask({ title: 'Side note', project: PROJECT, source: 'local', parent_task_id: parent.id });
    expect(task.source).toBe('local');
    expect(task.sync_hold).toMatchObject({ state: 'chosen', by: 'user', target: PLUGIN });
    await settleSyncGates();
    expect(judged.map((j) => j.title)).toEqual(['Release train']);
  });

  it('a subtask of a private task is private too', async () => {
    const { task: parent } = await addTask({ title: 'Marigold case', project: PROJECT });
    const { task: child } = await addTask({ title: 'Collect quotes', project: PROJECT, parent_task_id: parent.id });
    await settleSyncGates();
    expect(child.source).toBe('local');
    expect(child.sync_hold).toMatchObject({ state: 'chosen', reason: 'Its parent task is kept local' });
    expect(sync.createTask).not.toHaveBeenCalled();
  });

  it('an edit while it is judged is judged again before anything is sent', async () => {
    let first = true;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((r) => { releaseFirst = r; });
    verdict = async (input) => {
      if (first) { first = false; await firstGate; return { private: false, reason: 'team work' }; }
      return { private: /zephyr/i.test(input.description ?? '') , reason: 'a private matter' };
    };
    const { task } = await addTask({ title: 'Prep for the sync', project: PROJECT });
    await new Promise((r) => setTimeout(r, 20));
    await updateTask(task.id, {}, { source: 'api' }).catch(() => {});
    const { updateDescription } = await import('../../../src/core/task-manager.js');
    await updateDescription(task.id, 'ask about my zephyr plan');
    releaseFirst();
    await settleSyncGates();
    const after = await getTask(task.id);
    expect(judged).toHaveLength(2);
    expect(after.source).toBe('local');
    expect(after.sync_hold).toMatchObject({ state: 'private', by: 'model' });
    expect(sentTexts(sync)).not.toContain('zephyr');
  });

  it('an edit that adds a private word to a synced task stops it before the push', async () => {
    const { task } = await addTask({ title: 'Quarterly notes', project: PROJECT });
    await settleSyncGates();
    await settleBackgroundPushes();
    const synced = await getTask(task.id);
    expect(synced.source).toBe(PLUGIN);
    expect(synced.ext?.[PLUGIN]).toBeTruthy();
    await updateTask(task.id, { title: 'Quarterly notes for my marigold' }, { source: 'api' });
    await settleEditStops();
    const after = await getTask(task.id);
    expect(after.source).toBe('local');
    expect(after.title).toBe('Quarterly notes for my marigold');
    expect(after.sync_hold).toMatchObject({ state: 'private', by: 'words', target: PLUGIN, outside: { state: 'kept', source: PLUGIN } });
    expect(sentTexts(sync)).not.toContain('my marigold');
    // Its remote id is released: no pull imports the outside copy again.
    expect(getRemoteLink(PLUGIN, 'r-1')?.state).toBe('released');
    expect((await listLetters()).letters).toHaveLength(0);
    expect(await pendingKeptForTest()).toEqual([task.id]);
  });

  it('the guard refuses any plugin call carrying a local or held task', async () => {
    const { task } = await addTask({ title: 'Local by choice', project: PROJECT, source: 'local' });
    const plugin = registry.get(PLUGIN)!;
    const err = await plugin.sync.createTask(task).catch((e: unknown) => e);
    expect(isPrivateTaskBlocked(err)).toBe(true);
    const { task: synced } = await addTask({ title: 'Synced parent', project: PROJECT });
    await settleSyncGates();
    const parent = await getTask(synced.id);
    const err2 = await plugin.sync.associateSubtask(parent, task).catch((e: unknown) => e);
    expect(isPrivateTaskBlocked(err2)).toBe(true);
    expect(sync.associateSubtask).not.toHaveBeenCalled();
    expect(sync.createTask).toHaveBeenCalledTimes(1);
  });

  it('make local keeps all content; archive closes the copy; neutralize replaces its text first', async () => {
    const { task } = await addTask({ title: 'Design review', project: PROJECT, description: 'long design notes' });
    await settleSyncGates();
    await settleBackgroundPushes();
    const made = await makeTaskLocal(task.id, { state: 'chosen', by: 'user', at: new Date().toISOString() }, 'neutralize');
    expect(made.unlinked).toBe(true);
    expect(made.outside).toEqual({ action: 'neutralize', done: true });
    const after = await getTask(task.id);
    expect(after).toMatchObject({ source: 'local', title: 'Design review', description: 'long design notes', project: PROJECT });
    expect(after.ext).toBeUndefined();
    expect(after.sync_hold?.outside?.state).toBe('neutralized');
    // The plugin got the neutral title and empty text, never the content, then the close.
    const titleCall = sync.updateTitle.mock.calls.at(-1)!;
    expect(titleCall[1]).toMatch(/^\[Moved\] \(title removed\) \[open-walnut:/);
    expect((titleCall[0] as Task).title).toBe(titleCall[1]);
    expect((titleCall[0] as Task).description).toBe('');
    expect(sync.updateDescription.mock.calls.at(-1)![1]).toBe('');
    expect(sync.updatePhase.mock.calls.at(-1)![1]).toBe('COMPLETE');
  });

  it('a task turned local and kept links to its copy again on "Sync to", no second item', async () => {
    const { task } = await addTask({ title: 'Tracker item', project: PROJECT });
    await settleSyncGates();
    await settleBackgroundPushes();
    await makeTaskLocal(task.id, { state: 'chosen', by: 'user', at: new Date().toISOString() }, 'keep');
    expect(getRemoteLink(PLUGIN, 'r-1')?.state).toBe('released');
    const out = await releaseSyncHold(task.id);
    expect(out.released).toBe(true);
    const after = await getTask(task.id);
    expect(after.source).toBe(PLUGIN);
    expect(after.ext?.[PLUGIN]).toEqual({ id: 'r-1' });
    expect(sync.createTask).toHaveBeenCalledTimes(1);
    expect(sync.pushTask).toHaveBeenCalled();
    expect(getRemoteLink(PLUGIN, 'r-1')?.state).toBe('owned');
  });

  it('a pull never imports an item a task released', async () => {
    recordRemoteLink({ source: PLUGIN, remoteId: 'r-9', taskId: 'gone', remoteList: null, state: 'released', reason: 'test' });
    await expect(addTaskFull({
      title: 'Back again', status: 'todo', phase: 'TODO', priority: 'none', project: PROJECT, source: PLUGIN,
      session_ids: [], description: '', summary: '', note: '', created_at: '', updated_at: '',
      ext: { [PLUGIN]: { id: 'r-9' } },
    } as Omit<Task, 'id'>)).rejects.toThrow(/released or deleted/);
  });

  it('a restart judges again every task left checking', async () => {
    const { task } = await addTask({ title: 'Ship the fix', project: PROJECT, source: 'local' });
    await setTaskSyncHold(task.id, { target: PLUGIN, state: 'checking', at: new Date().toISOString() });
    expect(await resumeSyncGates()).toBe(1);
    expect((await getTask(task.id)).source).toBe(PLUGIN);
  });

  it('the user\'s "Sync to" on a letter an earlier version sent sends it; a task answering in their place does not', async () => {
    verdict = async () => ({ private: true, reason: 'a private matter' });
    const { task } = await addTask({ title: 'Zephyr draft', project: PROJECT });
    await settleSyncGates();
    const letterId = await oldLetter(task.id);
    await answerLetter(letterId, { actionId: LETTER_ACTIONS.sync, by: { sessionId: 's-1', taskId: 't-1' } });
    await onKeptLocalAnswer({ letterId, actionId: LETTER_ACTIONS.sync });
    expect((await getTask(task.id)).source).toBe('local');
    await answerLetter(letterId, { actionId: LETTER_ACTIONS.sync });
    await onKeptLocalAnswer({ letterId, actionId: LETTER_ACTIONS.sync });
    expect((await getTask(task.id)).source).toBe(PLUGIN);
  });

  it('a held task moved to a project that does not sync drops its hold; back in a synced one it keeps it', async () => {
    const { task } = await addTask({ title: 'Marigold notes', project: PROJECT });
    await updateTask(task.id, { project: 'Personal' }, { source: 'api' });
    expect((await getTask(task.id)).sync_hold).toBeUndefined();
    await updateTaskRaw(task.id, { sync_hold: { target: PLUGIN, state: 'chosen', at: '' } } as Partial<Task>);
    await updateTask(task.id, { project: PROJECT }, { source: 'api' });
    const back = await getTask(task.id);
    expect(back.source).toBe('local');
    expect(back.sync_hold?.target).toBe(PLUGIN);
    expect(sync.createTask).not.toHaveBeenCalled();
  });

  describe('the check on every push of new text', () => {
    async function syncedTask(title: string, description = '') {
      const { task } = await addTask({ title, project: PROJECT, description });
      await settleSyncGates();
      await settleBackgroundPushes();
      const t = await getTask(task.id);
      expect(t.source).toBe(PLUGIN);
      return t;
    }

    it('a text pushed as judged at birth is not judged again; an edit is, before it goes out', async () => {
      const t = await syncedTask('Fix the cache');
      expect(judged).toHaveLength(1);
      await updateTask(t.id, { priority: 'high' }, { source: 'api' });
      expect(judged).toHaveLength(1);
      verdict = async (input) => ({ private: /zephyr/i.test(input.description ?? ''), reason: 'a private matter' });
      const { updateDescription } = await import('../../../src/core/task-manager.js');
      await updateDescription(t.id, 'plan the zephyr surprise');
      await settleEditStops();
      expect(judged).toHaveLength(2);
      const after = await getTask(t.id);
      expect(after).toMatchObject({ source: 'local', sync_hold: { state: 'private', by: 'model', outside: { state: 'kept' } } });
      expect(after.description).toContain('zephyr');
      expect(sentTexts(sync)).not.toContain('zephyr');
      expect((await listLetters()).letters).toHaveLength(0);
      expect(await pendingKeptForTest()).toContain(t.id);
    });

    it('a work edit is judged once and goes out', async () => {
      const t = await syncedTask('Fix the cache');
      const { updateDescription } = await import('../../../src/core/task-manager.js');
      await updateDescription(t.id, 'evict on write');
      await updateTask(t.id, { priority: 'low' }, { source: 'api' });
      await settleBackgroundPushes();
      expect(judged.map((j) => j.description ?? '')).toEqual(['', 'evict on write']);
      expect((await getTask(t.id)).source).toBe(PLUGIN);
      expect(sentTexts(sync)).toContain('evict on write');
    });

    it('when the model cannot check an edit, nothing goes out and the user is told', async () => {
      const t = await syncedTask('Fix the cache');
      verdict = async () => { throw new Error('the model did not answer within 20 s'); };
      await updateTask(t.id, { title: 'Fix the cache, part two' }, { source: 'api' });
      await settleEditStops();
      expect(await getTask(t.id)).toMatchObject({ source: 'local', sync_hold: { state: 'unjudged', by: 'model' } });
      expect(sentTexts(sync)).not.toContain('part two');
      expect((await listLetters()).letters).toHaveLength(0);
      expect(await pendingKeptForTest()).toContain(t.id);
    });

    it('the user\'s Sync on a task kept by a word accepts that word for it; a later push is not stopped by it', async () => {
      const { task } = await addTask({ title: 'Marigold tracker dashboard', project: PROJECT });
      await settleSyncGates();
      const letterId = await oldLetter(task.id);
      await answerLetter(letterId, { actionId: LETTER_ACTIONS.sync });
      await onKeptLocalAnswer({ letterId, actionId: LETTER_ACTIONS.sync });
      await settleEditStops();
      expect((await getTask(task.id)).source).toBe(PLUGIN);
      expect(sync.createTask).toHaveBeenCalledTimes(1);
      const { updateDescription } = await import('../../../src/core/task-manager.js');
      await updateDescription(task.id, 'charts for the marigold funnel');
      await settleEditStops();
      expect((await getTask(task.id)).source).toBe(PLUGIN);
      // The approval is on disk: a restart keeps it.
      await flushApprovals();
      resetApprovalsForTest();
      await updateTask(task.id, { title: 'Marigold tracker dashboard v2' }, { source: 'api' });
      await settleEditStops();
      expect((await getTask(task.id)).source).toBe(PLUGIN);
    });

    it('neutralizing a copy sends no text to judge', async () => {
      const t = await syncedTask('Fix the cache', 'details');
      const before = judged.length;
      await makeTaskLocal(t.id, { state: 'chosen', by: 'user', at: new Date().toISOString() }, 'neutralize');
      expect(judged.length).toBe(before);
      expect(sync.updateTitle.mock.calls.at(-1)![1]).toMatch(/^\[Moved\] \(title removed\)/);
    });

    it('with the model check off only the words are checked', async () => {
      await updateConfig({ private_tasks: { words: ['marigold'], model_check: false } } as never);
      const { task } = await addTask({ title: 'Fix the cache', project: PROJECT });
      expect(task.source).toBe(PLUGIN);
      const { updateDescription } = await import('../../../src/core/task-manager.js');
      await updateDescription(task.id, 'anything at all');
      await settleBackgroundPushes();
      expect(judged).toHaveLength(0);
      expect((await getTask(task.id)).source).toBe(PLUGIN);
    });
  });

  describe('after the review', () => {
    it('text already outside (synced before the check, or pulled) is not judged; a change to it is', async () => {
      resetApprovalsForTest({ seeded: false });
      const old = { id: 'old-1', source: PLUGIN, title: 'Old synced item', description: 'pushed long ago', updated_at: '2020-01-01T00:00:00.000Z' };
      expect(await seedOutsideBaseline([old, { ...old, id: 'new-1', updated_at: new Date().toISOString() }])).toBe(1);
      expect(await checkPushText({ id: 'old-1', project: PROJECT }, { title: old.title, description: old.description })).toEqual({ ok: true });
      expect(judged).toHaveLength(0);
      await checkPushText({ id: 'old-1', project: PROJECT }, { title: old.title, description: 'a new line' });
      expect(judged).toHaveLength(1);
      // Seeded once: a later call records nothing.
      expect(await seedOutsideBaseline([{ ...old, id: 'old-2' }])).toBe(0);

      const pulled = await addTaskFull({
        title: 'Pulled from the service', status: 'todo', phase: 'TODO', priority: 'none', project: PROJECT, source: PLUGIN,
        session_ids: [], description: 'remote text', summary: '', note: '', created_at: '', updated_at: '',
        ext: { [PLUGIN]: { id: 'r-pulled' } },
      } as Omit<Task, 'id'>);
      expect(await checkPushText(pulled, { title: pulled.title, description: 'remote text', note: '', summary: '' })).toEqual({ ok: true });
      expect(judged).toHaveLength(1);
    });

    it('text approved for one service is judged again before it goes to another; the same text twice is judged once', async () => {
      const t = { id: 'moved-1', project: PROJECT };
      const text = { title: 'Quarterly roadmap', description: 'milestones' };
      expect(await checkPushText(t, text, { target: 'svc-a' })).toEqual({ ok: true });
      expect(judged).toHaveLength(1);
      expect(await checkPushText(t, text, { target: 'svc-a' })).toEqual({ ok: true });
      expect(judged).toHaveLength(1);
      // Moved to a project that syncs to another service: that service has not seen it.
      expect(await checkPushText(t, text, { target: 'svc-b', rule: 'keep out roadmaps' })).toEqual({ ok: true });
      expect(judged).toHaveLength(2);
      expect(judged.at(-1)!.rule).toBe('keep out roadmaps');
      // Two pushes of the same text at once, to two services: each is judged.
      await Promise.all([
        checkPushText({ id: 'moved-2', project: PROJECT }, text, { target: 'svc-a' }),
        checkPushText({ id: 'moved-2', project: PROJECT }, text, { target: 'svc-b' }),
      ]);
      expect(judged).toHaveLength(4);
      // An approval an older Walnut wrote (no service named) still holds.
      const { approveOutsideText } = await import('../../../src/core/private-tasks/push-check.js');
      await approveOutsideText('legacy-1', text);
      expect(await checkPushText({ id: 'legacy-1', project: PROJECT }, text, { target: 'svc-b' })).toEqual({ ok: true });
      expect(judged).toHaveLength(4);
    });

    it('a text still changing at the last try is released on the text judged; the new text is judged at its push', async () => {
      const { updateDescription } = await import('../../../src/core/task-manager.js');
      const next = ['second', 'third', 'about my zephyr plan'];
      let taskId = '';
      verdict = async (input) => {
        const change = next.shift();
        if (change) await updateDescription(taskId, change);
        return { private: /zephyr/.test(input.description ?? ''), reason: 'a private matter' };
      };
      const { task } = await addTask({ title: 'Prep notes', project: PROJECT, description: 'first', asyncPush: true });
      taskId = task.id;
      await settleSyncGates();
      await settleBackgroundPushes();
      await settleEditStops();
      const after = await getTask(task.id);
      expect(after.description).toBe('about my zephyr plan');
      expect(after.source).toBe('local');
      expect(after.sync_hold).toMatchObject({ state: 'private', by: 'model' });
      expect(sentTexts(sync)).not.toContain('zephyr');
    });

    it('a subtask of a parent still being checked waits for it and stays local with it', async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      verdict = async (input) => {
        if (input.title === 'Zephyr review packet') { await gate; return { private: true, reason: 'a private matter' }; }
        return { private: false, reason: 'team work' };
      };
      const { task: parent } = await addTask({ title: 'Zephyr review packet', project: PROJECT });
      const { task: child } = await addTask({ title: 'Draft the summary', project: PROJECT, parent_task_id: parent.id });
      expect(child.sync_hold?.state).toBe('checking');
      await new Promise((r) => setTimeout(r, 30));
      expect(sync.createTask).not.toHaveBeenCalled();
      release();
      await settleSyncGates();
      expect(await getTask(child.id)).toMatchObject({ source: 'local', sync_hold: { state: 'chosen', reason: 'Its parent task is kept local' } });
      expect(sync.createTask).not.toHaveBeenCalled();
    });

    it('a model that did not answer once is asked again before a push is stopped', async () => {
      const { task } = await addTask({ title: 'Fix the cache', project: PROJECT });
      await settleSyncGates();
      let calls = 0;
      verdict = async () => { if (++calls === 1) throw new Error('timeout'); return { private: false, reason: 'team work' }; };
      const { updateDescription } = await import('../../../src/core/task-manager.js');
      await updateDescription(task.id, 'evict on write');
      await settleEditStops();
      expect(calls).toBe(2);
      expect((await getTask(task.id)).source).toBe(PLUGIN);
    });
  });
});
