/**
 * Who reads a sync service (src/core/private-tasks/audience.ts), against a real server and two
 * fake sync plugins: one only the user reads (manifest `syncAudience: 'self'`, a personal list)
 * and one that says nothing (shared, a team tracker). 2026-11-01: the privacy check took the
 * user's personal Microsoft To-Do for a shared service and pulled nine of his own tasks out of it,
 * one decision letter each.
 *
 *   - a service only the user reads checks nothing: a task with a private word or one the model
 *     calls private is born synced, and its edits go out;
 *   - a service that says nothing is shared: the check runs;
 *   - the user's setting wins over the manifest, both ways, and turning a service to Only me gives
 *     back every task Walnut kept out of it (linked to its old copy, no second item), settles its
 *     letter, and leaves the user's own Local choice alone;
 *   - several tasks kept out in one burst are ONE letter, and its answer is for each of them.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import type { Server } from 'node:http';
import { createMockConstants } from '../helpers/mock-constants.js';
vi.mock('../../src/constants.js', () => createMockConstants('private-tasks-audience-e2e', { IS_EPHEMERAL: true }));
import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { registry } from '../../src/core/integration-registry.js';
import { addTask, ensureProject, getTask, settleBackgroundPushes } from '../../src/core/task-manager.js';
import { getConfig, updateConfig } from '../../src/core/config-manager.js';
import { getLetter, listLetters } from '../../src/core/human-inbox/store.js';
import { createSpySync, createMockPlugin } from '../core/plugin-test-utils.js';
import { setPrivacyJudgeForTest } from '../../src/core/private-tasks/privacy-judge.js';
import { settleSyncGates } from '../../src/core/private-tasks/sync-gate.js';
import { settleEditStops } from '../../src/core/private-tasks/edit-stop.js';
import { releaseHoldsOfUnsharedServices, resolveAudience } from '../../src/core/private-tasks/audience.js';

const MINE = 'my-list';
const TEAM = 'team-tracker';
let server: Server;
let root: string;
let mine: ReturnType<typeof createSpySync>;
let team: ReturnType<typeof createSpySync>;

async function api(path: string, init: { method?: string; body?: unknown } = {}) {
  const res = await fetch(`${root}${path}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: { 'content-type': 'application/json' },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : {}) as Record<string, any> };
}
const settle = async () => { for (let i = 0; i < 2; i++) { await settleSyncGates(); await settleBackgroundPushes(); await settleEditStops(); } };
const calls = (s: ReturnType<typeof createSpySync>) => Object.values(s).flatMap((fn) => ((fn as { mock?: { calls: unknown[][] } }).mock?.calls ?? []).map((c) => JSON.stringify(c))).join('\n');
async function setAudience(audience: Record<string, 'self' | 'shared'>) {
  const cfg = await getConfig();
  await updateConfig({ private_tasks: { ...(cfg.private_tasks ?? {}), audience } } as never);
}

beforeAll(async () => {
  await updateConfig({ private_tasks: { words: ['marigold'] } } as never);
  server = await startServer({ port: 0, dev: true });
  root = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  setPrivacyJudgeForTest(async (input) => /\bZephyr\b/.test(`${input.title} ${input.description ?? ''}`)
    ? { private: true, reason: 'a private matter' }
    : { private: false, reason: 'team work' });
  let n = 0;
  mine = createSpySync();
  mine.createTask.mockImplementation(async () => ({ [MINE]: { id: `m-${++n}` } }));
  team = createSpySync();
  team.createTask.mockImplementation(async () => ({ [TEAM]: { id: `t-${++n}` } }));
  registry.register(MINE, createMockPlugin({ id: MINE, name: 'My List', sync: mine, syncAudience: 'self' }));
  registry.register(TEAM, createMockPlugin({ id: TEAM, name: 'Team Tracker', sync: team }));
  await ensureProject('Mine', MINE);
  await ensureProject('Team', TEAM);
});
afterAll(async () => {
  await settle();
  setPrivacyJudgeForTest(null);
  registry.unregister(MINE);
  registry.unregister(TEAM);
  await stopServer();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('who reads a sync service', () => {
  it('resolves the setting, then the manifest, then shared', () => {
    expect(resolveAudience({}, 'x', undefined)).toBe('shared');
    expect(resolveAudience({}, 'x', 'self')).toBe('self');
    expect(resolveAudience({ private_tasks: { audience: { x: 'shared' } } }, 'x', 'self')).toBe('shared');
    expect(resolveAudience({ private_tasks: { audience: { x: 'self' } } }, 'x', undefined)).toBe('self');
    // Junk in the setting is ignored.
    expect(resolveAudience({ private_tasks: { audience: { x: 'everyone' as never } } }, 'x', undefined)).toBe('shared');
  });

  it('a service only the user reads checks nothing: private words and private matters sync, and so do their edits', async () => {
    const t = await api('/api/v1/tasks', { body: { title: 'Zephyr marigold budget', project: 'Mine' } });
    expect(t.status).toBe(201);
    await settle();
    const task = await getTask(t.json.task.id);
    expect(task.source).toBe(MINE);
    expect(task.sync_hold).toBeUndefined();
    expect(calls(mine)).toContain('Zephyr marigold budget');
    const edit = await api(`/api/v1/tasks/${task.id}`, { method: 'PATCH', body: { title: 'Zephyr marigold budget for the clinic' } });
    expect(edit.status).toBeLessThan(300);
    await settle();
    expect((await getTask(task.id)).source).toBe(MINE);
    expect(calls(mine)).toContain('Zephyr marigold budget for the clinic');
  });

  it('a service that says nothing is shared: the same task stays local', async () => {
    const t = await api('/api/v1/tasks', { body: { title: 'Zephyr marigold budget', project: 'Team' } });
    await settle();
    expect(await getTask(t.json.task.id)).toMatchObject({ source: 'local', sync_hold: { target: TEAM } });
    expect(calls(team)).not.toContain('Zephyr');
  });

  it('Settings lists each service with who reads it', async () => {
    const r = await api('/api/v1/private-tasks/services');
    expect(r.status).toBe(200);
    const rows = r.json.services as Array<Record<string, unknown>>;
    expect(rows.find((s) => s.id === MINE)).toMatchObject({ name: 'My List', audience: 'self', default: 'self', set: false });
    expect(rows.find((s) => s.id === TEAM)).toMatchObject({ name: 'Team Tracker', audience: 'shared', default: 'shared', set: false });
    expect(rows.some((s) => s.id === 'local')).toBe(false);
  });

  it('several tasks kept out in one burst are one letter, and its answer is for each of them', async () => {
    const a = await api('/api/v1/tasks', { body: { title: 'Zephyr clinic notes', project: 'Team' } });
    const b = await api('/api/v1/tasks', { body: { title: 'Marigold savings plan', project: 'Team' } });
    await settle();
    const la = (await getTask(a.json.task.id)).sync_hold?.letter_id;
    const lb = (await getTask(b.json.task.id)).sync_hold?.letter_id;
    expect(la).toBeTruthy();
    expect(lb).toBe(la);
    const letter = await getLetter(la!);
    expect(letter.subject).toBe('2 tasks kept out of Team Tracker');
    expect(letter.taskRefs).toEqual(expect.arrayContaining([a.json.task.id, b.json.task.id]));
    expect((await api(`/api/v1/human-inbox/${la}/answer`, { body: { actionId: 'keep-local' } })).status).toBeLessThan(300);
    for (const id of [a.json.task.id, b.json.task.id]) {
      await vi.waitFor(async () => expect((await getTask(id)).sync_hold).toMatchObject({ state: 'chosen', by: 'user' }), { timeout: 5000 });
    }
  });

  it('deciding one task of a batch letter from its menu leaves the letter open for the others', async () => {
    const a = await api('/api/v1/tasks', { body: { title: 'Zephyr dentist visit', project: 'Team' } });
    const b = await api('/api/v1/tasks', { body: { title: 'Zephyr school forms', project: 'Team' } });
    await settle();
    const letter = (await getTask(a.json.task.id)).sync_hold!.letter_id!;
    expect((await getTask(b.json.task.id)).sync_hold!.letter_id).toBe(letter);
    expect((await api(`/api/v1/tasks/${a.json.task.id}/make-local`, { body: { outside: 'keep' } })).status).toBe(200);
    expect((await getLetter(letter)).archived).toBe(false);
    expect((await getTask(a.json.task.id)).sync_hold?.letter_id).toBeUndefined();
    expect((await api(`/api/v1/human-inbox/${letter}/answer`, { body: { actionId: 'keep-local' } })).status).toBeLessThan(300);
    await vi.waitFor(async () => expect((await getTask(b.json.task.id)).sync_hold).toMatchObject({ state: 'chosen', by: 'user' }), { timeout: 5000 });
  });

  it('the setting wins over the manifest, and Only me gives back what was kept out, linked to its old copy', async () => {
    await setAudience({ [MINE]: 'shared' });
    // Synced first, then an edit makes it private: it is stopped, its copy kept.
    const s = await api('/api/v1/tasks', { body: { title: 'Plan the move', project: 'Mine' } });
    await settle();
    const synced = await getTask(s.json.task.id);
    expect(synced.source).toBe(MINE);
    const remote = synced.ext;
    await api(`/api/v1/tasks/${synced.id}`, { method: 'PATCH', body: { title: 'Plan the Zephyr move' } });
    await settle();
    const stopped = await getTask(synced.id);
    expect(stopped).toMatchObject({ source: 'local', sync_hold: { by: 'model', outside: { state: 'kept' } } });
    // A new one held at its create, and one the user chose to keep local.
    const born = await api('/api/v1/tasks', { body: { title: 'Zephyr checkup', project: 'Mine' } });
    const chosen = await api('/api/v1/tasks', { body: { title: 'Gift ideas', project: 'Mine', local: true } });
    // The v1 route takes a parent from the calling session only: made here directly.
    const child = { json: await addTask({ title: 'Gift for the neighbours', project: 'Mine', parent_task_id: chosen.json.task.id } as never) };
    await settle();
    expect((await getTask(child.json.task.id)).source).toBe('local');
    expect(await getTask(born.json.task.id)).toMatchObject({ source: 'local', sync_hold: { state: 'private' } });
    const letters = [(await getTask(synced.id)).sync_hold!.letter_id!, (await getTask(born.json.task.id)).sync_hold!.letter_id!];
    expect(letters.every(Boolean)).toBe(true);
    const creates = mine.createTask.mock.calls.length;

    await setAudience({ [MINE]: 'self' });
    // The pass runs on the config write (debounced) and pushes as it goes: wait for its end, the
    // letters settled last.
    await vi.waitFor(async () => {
      for (const id of new Set(letters)) expect(await getLetter(id)).toMatchObject({ archived: true, archivedReason: 'settled' });
    }, { timeout: 15_000 });
    await settle();
    expect((await getTask(born.json.task.id)).source).toBe(MINE);
    const back = await getTask(synced.id);
    expect(back.source).toBe(MINE);
    expect(back.sync_hold).toBeUndefined();
    expect(back.ext).toEqual(remote);
    // The stopped one went back to its old copy; only the one never sent was created there.
    expect(mine.createTask.mock.calls.length).toBe(creates + 1);
    // The user's own Local choice stands.
    expect(await getTask(chosen.json.task.id)).toMatchObject({ source: 'local', sync_hold: { state: 'chosen', by: 'user' } });
    // And so does a subtask that follows it.
    expect(await getTask(child.json.task.id)).toMatchObject({ source: 'local' });
    // Running it again changes nothing.
    expect(await releaseHoldsOfUnsharedServices()).toEqual([]);
    const open = (await listLetters()).letters.filter((l) => !l.archived && /kept out of My List|stopped syncing to My List/.test(l.subject));
    expect(open).toEqual([]);
  });
});
