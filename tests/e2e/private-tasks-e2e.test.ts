/**
 * Private tasks against a real server and a fake sync plugin (src/core/private-tasks/): the HTTP
 * create paths (v1, the web route, the task_create op) are born local and judged; a task the
 * check keeps local sends nothing and asks the user nothing, and its menu's Sync sends it; the task menu routes
 * make a synced task local (its copy kept, archived or neutralized) and send it back; a session
 * cannot send a kept task out without the user's words; and the Settings test route.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import type { Server } from 'node:http';
import { createMockConstants } from '../helpers/mock-constants.js';
vi.mock('../../src/constants.js', () => createMockConstants('private-tasks-e2e', { IS_EPHEMERAL: true }));
import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { registry } from '../../src/core/integration-registry.js';
import { ensureProject, getTask, settleBackgroundPushes } from '../../src/core/task-manager.js';
import { updateConfig } from '../../src/core/config-manager.js';
import { createSpySync, createMockPlugin } from '../core/plugin-test-utils.js';
import { setPrivacyJudgeForTest } from '../../src/core/private-tasks/privacy-judge.js';
import { settleSyncGates } from '../../src/core/private-tasks/sync-gate.js';
import { settleEditStops } from '../../src/core/private-tasks/edit-stop.js';
import { executeOp } from '../../src/ops/index.js';

const PLUGIN = 'fake-tracker';
let server: Server;
let root: string;
let sync: ReturnType<typeof createSpySync>;

async function api(path: string, init: { method?: string; body?: unknown; sid?: string } = {}) {
  const res = await fetch(`${root}${path}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: { 'content-type': 'application/json', ...(init.sid ? { 'x-walnut-caller-sid': init.sid } : {}) },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : {}) as Record<string, any> };
}
// A push runs in the background and may start a stop, which may start a push: settle twice.
const settle = async () => { for (let i = 0; i < 2; i++) { await settleSyncGates(); await settleBackgroundPushes(); await settleEditStops(); } };
const sent = () => Object.values(sync).flatMap((fn) => ((fn as { mock?: { calls: unknown[][] } }).mock?.calls ?? []).map((c) => JSON.stringify(c))).join('\n');

beforeAll(async () => {
  // Written before the server starts: a config change while plugins activate reloads them.
  await updateConfig({ private_tasks: { words: ['marigold'] } } as never);
  server = await startServer({ port: 0, dev: true });
  root = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  setPrivacyJudgeForTest(async (input) => /\bZephyr\b/.test(`${input.title} ${input.description ?? ''}`)
    ? { private: true, reason: 'a private matter' }
    : { private: false, reason: 'team work' });
  sync = createSpySync();
  let n = 0;
  sync.createTask.mockImplementation(async () => ({ [PLUGIN]: { id: `r-${++n}` } }));
  registry.register(PLUGIN, createMockPlugin({ id: PLUGIN, sync }));
  await ensureProject('Work', PLUGIN);
});
afterAll(async () => {
  await settle();
  setPrivacyJudgeForTest(null);
  registry.unregister(PLUGIN);
  await stopServer();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('private tasks over HTTP', () => {
  it('v1 create: local:true stays local, a work task is judged then synced, a private one stays local', async () => {
    const chosen = await api('/api/v1/tasks', { body: { title: 'My own list', project: 'Work', local: true } });
    expect(chosen.status).toBe(201);
    expect(chosen.json.task).toMatchObject({ sync_hold: { state: 'chosen', target: PLUGIN } });
    const bad = await api('/api/v1/tasks', { body: { title: 'x', project: 'Work', local: 'yes' } });
    expect(bad.status).toBe(400);

    const work = await api('/api/v1/tasks', { body: { title: 'Fix the login retry', project: 'Work' } });
    const priv = await api('/api/v1/tasks', { body: { title: 'Notes on Zephyr for the review', project: 'Work' } });
    const word = await api('/api/v1/tasks', { body: { title: 'Marigold packet', project: 'Work' } });
    await settle();
    expect((await getTask(work.json.task.id)).source).toBe(PLUGIN);
    expect(await getTask(priv.json.task.id)).toMatchObject({ source: 'local', sync_hold: { state: 'private', by: 'model' } });
    expect(await getTask(word.json.task.id)).toMatchObject({ source: 'local', sync_hold: { state: 'private', by: 'words' } });
    expect(sent()).toContain('Fix the login retry');
    expect(sent()).not.toMatch(/Zephyr|Marigold packet|My own list/);
    // The projection says where it stands.
    const read = await api(`/api/v1/tasks/${priv.json.task.id}`);
    expect(read.json.task.sync_hold).toMatchObject({ state: 'private', target: PLUGIN });
    expect(read.json.task.sync_hold.reason).toContain('a private matter');
  });

  it('a kept task asks the user nothing: no letter, and the user\'s Sync in its menu sends it', async () => {
    const a = await api('/api/v1/tasks', { body: { title: 'Zephyr onboarding plan', project: 'Work' } });
    await settle();
    expect(await getTask(a.json.task.id)).toMatchObject({ source: 'local', sync_hold: { state: 'private' } });
    expect((await getTask(a.json.task.id)).sync_hold?.letter_id).toBeUndefined();
    const inbox = await api('/api/v1/human-inbox?limit=100');
    expect(JSON.stringify(inbox.json)).not.toContain('Zephyr onboarding plan');
    expect((await api(`/api/v1/tasks/${a.json.task.id}/sync-to-project`, { body: {} })).status).toBe(200);
    await vi.waitFor(async () => expect((await getTask(a.json.task.id)).source).toBe(PLUGIN), { timeout: 5000 });
  });

  it('make local (archive) unlinks and closes the copy; a session needs the user\'s words to send it back', async () => {
    const t = await api('/api/v1/tasks', { body: { title: 'Rollout checklist', project: 'Work', description: 'steps' } });
    await settle();
    expect((await getTask(t.json.task.id)).source).toBe(PLUGIN);
    const made = await api(`/api/v1/tasks/${t.json.task.id}/make-local`, { body: { outside: 'archive' } });
    expect(made.status).toBe(200);
    expect(made.json).toMatchObject({ unlinked: true, from: PLUGIN, outside: { action: 'archive', done: true } });
    expect(made.json.outcome).toMatch(/no longer syncs .* was archived/);
    expect(await getTask(t.json.task.id)).toMatchObject({ source: 'local', title: 'Rollout checklist', description: 'steps', project: 'Work' });
    expect(sync.updatePhase.mock.calls.at(-1)![1]).toBe('COMPLETE');

    const refused = await api(`/api/v1/tasks/${t.json.task.id}/sync-to-project`, { body: {}, sid: 'some-session' });
    expect(refused.status).toBe(403);
    expect(refused.json.error?.code ?? refused.json.code).toBe('user_decision');
    const ok = await api(`/api/v1/tasks/${t.json.task.id}/sync-to-project`, { body: { user_words: 'send the rollout checklist back' }, sid: 'some-session' });
    expect(ok.status).toBe(200);
    expect((await getTask(t.json.task.id)).source).toBe(PLUGIN);
    const again = await api(`/api/v1/tasks/${t.json.task.id}/sync-to-project`, { body: {} });
    expect(again.status).toBe(409);
  });

  it('an edit adding a private word stops the push and makes it local', async () => {
    const t = await api('/api/v1/tasks', { body: { title: 'Quarter goals', project: 'Work' } });
    await settle();
    const r = await api(`/api/v1/tasks/${t.json.task.id}`, { method: 'PATCH', body: { title: 'Quarter goals for my marigold' } });
    expect(r.status).toBeLessThan(300);
    await settle();
    expect(await getTask(t.json.task.id)).toMatchObject({ source: 'local', sync_hold: { state: 'private', by: 'words', outside: { state: 'kept' } } });
    expect(sent()).not.toContain('for my marigold');
  });

  it('task_create local:true and task_make_local work for an agent', async () => {
    const created = await executeOp('task_create', { title: 'Agent private note', project: 'Work', local: true, record_only: true }, { apiBase: root, origin: '__local__' });
    expect(created.ok, created.ok ? '' : created.message).toBe(true);
    const id = (created.result as { task?: { id: string }; id?: string }).task?.id ?? (created.result as { id: string }).id;
    expect(await getTask(id)).toMatchObject({ source: 'local', sync_hold: { state: 'chosen' } });

    const t = await api('/api/v1/tasks', { body: { title: 'Agent-made work item', project: 'Work' } });
    await settle();
    const made = await executeOp('task_make_local', { id: t.json.task.id, outside: 'neutralize' }, { apiBase: root, origin: '__local__' });
    expect(made.ok, made.ok ? '' : made.message).toBe(true);
    expect(await getTask(t.json.task.id)).toMatchObject({ source: 'local', title: 'Agent-made work item', sync_hold: { outside: { state: 'neutralized' } } });
    expect(sync.updateTitle.mock.calls.at(-1)![1]).toMatch(/^\[Moved\] \(title removed\)/);
  });

  it('Settings test route reports the match and the lines that are not patterns', async () => {
    const r = await api('/api/v1/private-tasks/test', { body: { text: 'My marigold case', words: ['marigold', '/(bad/'] } });
    expect(r.json).toEqual({ match: 'marigold', invalid: ['/(bad/'] });
    const saved = await api('/api/v1/private-tasks/test', { body: { text: 'nothing here' } });
    expect(saved.json).toEqual({ match: null, invalid: [] });
  });

  it('the phone reads which projects sync, with the service name, and a launch takes sync', async () => {
    const r = await api('/api/v1/projects');
    const work = (r.json.projects as Array<Record<string, unknown>>).find((p) => p.name === 'Work');
    expect(work).toMatchObject({ source: PLUGIN, source_name: PLUGIN });
    const { validateMobileLaunchBody } = await import('../../src/core/sessions/mobile-launch.js');
    expect(validateMobileLaunchBody({ cwd: '/w', project: 'Work', sync: 'project' })).toMatchObject({ sync: 'project' });
    expect(validateMobileLaunchBody({ cwd: '/w', project: 'Work', sync: 'local' })).not.toHaveProperty('sync');
    expect(() => validateMobileLaunchBody({ cwd: '/w', sync: 'yes' })).toThrow(/sync must be local or project/);
  });
});
