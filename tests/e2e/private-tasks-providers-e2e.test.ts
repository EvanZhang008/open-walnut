/**
 * The rules of each task provider (src/core/private-tasks/provider-rules.ts), against a real
 * server and two fake sync plugins: one only the user reads (manifest `syncAudience: 'self'`, a
 * personal list, so its check is off by default) and one that says nothing (checked). 2026-11-01:
 * the privacy check took the user's personal Microsoft To-Do for a shared service and pulled nine
 * of his own tasks out of it, one decision letter each; then the user asked for the rules per
 * provider, hard rules and an AI rule, each answering pass or fail with a reason.
 *
 *   - a provider whose check is off checks nothing: a task with a hard-rule word or one the AI
 *     fails is born synced, and its edits go out;
 *   - a provider that says nothing is checked;
 *   - each provider's hard rules and AI rule are its own, and the AI rule reaches the judge;
 *   - Settings lists each provider with its rules and tries a title against them;
 *   - the user's setting wins over the manifest, both ways, and turning a check off gives back
 *     every task Walnut kept out (linked to its old copy, no second item), settles a letter an
 *     earlier version sent for it, and leaves the user's own Local choice alone;
 *   - a task kept out asks the user nothing (2026-11-02: three decision letters in four hours,
 *     all unread, though the safe choice was applied): Main hears the day's kept tasks in one line;
 *   - a batch letter an earlier version sent still answers for each of its tasks.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import type { Server } from 'node:http';
import { createMockConstants } from '../helpers/mock-constants.js';
vi.mock('../../src/constants.js', () => createMockConstants('private-tasks-audience-e2e', { IS_EPHEMERAL: true }));
import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { registry } from '../../src/core/integration-registry.js';
import { addTask, ensureProject, getTask, setTaskSyncHold, settleBackgroundPushes } from '../../src/core/task-manager.js';
import { getConfig, updateConfig } from '../../src/core/config-manager.js';
import { getLetter, listLetters, sendLetter } from '../../src/core/human-inbox/store.js';
import { pendingKeptForTest, resetKeptDigestForTest, tellKeptDigestNow } from '../../src/core/private-tasks/kept-digest.js';

/** A decision letter as the version before 2026-11-02 sent one, for these kept tasks. */
async function oldLetter(taskIds: string[]): Promise<string> {
  const letter = await sendLetter({
    subject: `${taskIds.length} tasks kept out of Team Tracker`, type: 'action_required', markdown: 'kept out',
    actions: [{ id: 'keep-local', label: 'Keep all local' }, { id: 'sync', label: 'Sync all' }],
    taskRefs: taskIds, sender: { sessionId: 'external', host: 'local' },
  });
  for (const id of taskIds) await setTaskSyncHold(id, (t) => t.sync_hold ? { ...t.sync_hold, letter_id: letter.id } : null);
  return letter.id;
}
import { createSpySync, createMockPlugin } from '../core/plugin-test-utils.js';
import { setPrivacyJudgeForTest } from '../../src/core/private-tasks/privacy-judge.js';
import { settleSyncGates } from '../../src/core/private-tasks/sync-gate.js';
import { settleEditStops } from '../../src/core/private-tasks/edit-stop.js';
import { DEFAULT_AI_RULE, releaseHoldsOfUnsharedServices, resolveSyncRules } from '../../src/core/private-tasks/provider-rules.js';

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
async function setProvider(id: string, rules: Record<string, unknown>) {
  const cfg = await getConfig();
  const providers = { ...(cfg.private_tasks?.providers ?? {}), [id]: { ...(cfg.private_tasks?.providers?.[id] ?? {}), ...rules } };
  await updateConfig({ private_tasks: { ...(cfg.private_tasks ?? {}), providers } } as never);
}
/** What the judge was asked, newest last. */
const judged: Array<{ title: string; rule?: string; service?: string }> = [];

beforeAll(async () => {
  await updateConfig({ private_tasks: { words: ['marigold'] } } as never);
  server = await startServer({ port: 0, dev: true });
  root = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  setPrivacyJudgeForTest(async (input) => {
    judged.push({ title: input.title, rule: input.rule, service: input.service });
    // A rule that names Quokka keeps Quokka out; any rule keeps Zephyr out.
    const out = /\bZephyr\b/.test(`${input.title} ${input.description ?? ''}`)
      || (/Quokka/.test(input.rule ?? '') && /\bQuokka\b/.test(input.title));
    return out ? { private: true, reason: 'a private matter' } : { private: false, reason: 'team work' };
  });
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

describe('the rules of each task provider', () => {
  it('resolves the setting, then the manifest, then checked; words, AI and its rule default', () => {
    expect(resolveSyncRules({}, 'x', undefined)).toMatchObject({ check: true, checkSet: false, checkDefault: true, words: [], ai: true, aiRule: DEFAULT_AI_RULE });
    expect(resolveSyncRules({}, 'x', 'self')).toMatchObject({ check: false, checkDefault: false });
    // A service only the user reads, checked at their word: the hard rules apply, the default AI
    // rule (written for a shared service) stays off until they turn it on.
    expect(resolveSyncRules({ private_tasks: { providers: { x: { check: true } } } }, 'x', 'self')).toMatchObject({ check: true, checkSet: true, ai: false });
    expect(resolveSyncRules({ private_tasks: { providers: { x: { check: true, ai: true } } } }, 'x', 'self').ai).toBe(true);
    expect(resolveSyncRules({ private_tasks: { providers: { x: { check: false } } } }, 'x', undefined).check).toBe(false);
    // The earlier per-service form still reads, and the shared list and switch are the defaults.
    expect(resolveSyncRules({ private_tasks: { audience: { x: 'self' } } }, 'x', undefined).check).toBe(false);
    expect(resolveSyncRules({ private_tasks: { words: ['a'], model_check: false } }, 'x', undefined)).toMatchObject({ words: ['a'], ai: false });
    expect(resolveSyncRules({ private_tasks: { words: ['a'], providers: { x: { words: ['b'], ai: true, ai_rule: ' keep out B ' } } } }, 'x', undefined))
      .toMatchObject({ words: ['b'], ai: true, aiRule: 'keep out B' });
    // An empty rule is the default rule.
    expect(resolveSyncRules({ private_tasks: { providers: { x: { ai_rule: '  ' } } } }, 'x', undefined).aiRule).toBe(DEFAULT_AI_RULE);
  });

  it('a provider whose check is off checks nothing: hard-rule words and AI fails sync, and so do their edits', async () => {
    const t = await api('/api/v1/tasks', { body: { title: 'Zephyr marigold budget', project: 'Mine' } });
    expect(t.status).toBe(201);
    await settle();
    const task = await getTask(t.json.task.id);
    expect(task.source).toBe(MINE);
    expect(task.sync_hold).toBeUndefined();
    expect(calls(mine)).toContain('Zephyr marigold budget');
    const edit = await api(`/api/v1/tasks/${task.id}`, { method: 'PATCH', body: { title: 'Zephyr marigold budget for the kites' } });
    expect(edit.status).toBeLessThan(300);
    await settle();
    expect((await getTask(task.id)).source).toBe(MINE);
    expect(calls(mine)).toContain('Zephyr marigold budget for the kites');
  });

  it('a provider that says nothing is checked: the same task stays local', async () => {
    const t = await api('/api/v1/tasks', { body: { title: 'Zephyr marigold budget', project: 'Team' } });
    await settle();
    expect(await getTask(t.json.task.id)).toMatchObject({ source: 'local', sync_hold: { target: TEAM } });
    expect(calls(team)).not.toContain('Zephyr');
  });

  it('Settings lists each provider with its rules, and tries a title against them', async () => {
    const r = await api('/api/v1/private-tasks/providers');
    expect(r.status).toBe(200);
    const rows = r.json.providers as Array<Record<string, unknown>>;
    expect(rows.find((s) => s.id === MINE)).toMatchObject({ name: 'My List', check: false, check_set: false, check_default: false, ai: false, ai_rule: DEFAULT_AI_RULE });
    expect(rows.find((s) => s.id === TEAM)).toMatchObject({ name: 'Team Tracker', check: true, check_default: true, words: ['marigold'] });
    expect(rows.some((s) => s.id === 'local')).toBe(false);
    // The earlier list still answers for a window opened before.
    expect((await api('/api/v1/private-tasks/services')).json.services.find((s: { id: string }) => s.id === MINE)).toMatchObject({ audience: 'self' });
    // Try a title: the hard rules always; the AI rule only when asked, with the rule given.
    const words = await api('/api/v1/private-tasks/test', { body: { text: 'my marigold plan', provider: TEAM } });
    expect(words.json).toMatchObject({ match: 'marigold' });
    expect(words.json.ai).toBeUndefined();
    const ai = await api('/api/v1/private-tasks/test', { body: { text: 'Quokka budget', provider: TEAM, ai: true, ai_rule: 'Keep out anything about Quokka' } });
    expect(ai.json.ai).toEqual({ pass: false, reason: 'a private matter' });
    expect(judged.at(-1)).toMatchObject({ title: 'Quokka budget', rule: 'Keep out anything about Quokka', service: 'Team Tracker' });
    const pass = await api('/api/v1/private-tasks/test', { body: { text: 'Fix the login page', provider: TEAM, ai: true } });
    expect(pass.json.ai).toEqual({ pass: true, reason: 'team work' });
    expect(judged.at(-1)?.rule).toBe(DEFAULT_AI_RULE);
  });

  it('each provider has its own hard rules and AI rule, and the AI rule reaches the judge', async () => {
    await setProvider(TEAM, { words: ['pelican'], ai_rule: 'Keep out anything about Quokka' });
    try {
      // The shared list no longer applies here: this provider has its own.
      const m = await api('/api/v1/tasks', { body: { title: 'Marigold release notes', project: 'Team' } });
      const p = await api('/api/v1/tasks', { body: { title: 'Pelican offsite plan', project: 'Team' } });
      const q = await api('/api/v1/tasks', { body: { title: 'Quokka budget review', project: 'Team' } });
      await settle();
      expect((await getTask(m.json.task.id)).source).toBe(TEAM);
      expect(await getTask(p.json.task.id)).toMatchObject({ source: 'local', sync_hold: { state: 'private', by: 'words' } });
      expect(await getTask(q.json.task.id)).toMatchObject({ source: 'local', sync_hold: { state: 'private', by: 'model' } });
      expect((await getTask(q.json.task.id)).sync_hold?.reason).toBe('It did not pass the AI rule: a private matter');
      expect(judged.find((j) => j.title === 'Quokka budget review')).toMatchObject({ rule: 'Keep out anything about Quokka', service: 'Team Tracker' });
    } finally {
      await setProvider(TEAM, { words: undefined, ai_rule: undefined });
    }
  });

  it('tasks kept out ask the user nothing: no letter, and Main hears the day\'s kept tasks in one line', async () => {
    const before = (await listLetters()).letters.length
    const a = await api('/api/v1/tasks', { body: { title: 'Zephyr kite notes', project: 'Team' } });
    const b = await api('/api/v1/tasks', { body: { title: 'Marigold puzzle plan', project: 'Team' } });
    await settle();
    for (const id of [a.json.task.id, b.json.task.id]) {
      expect(await getTask(id)).toMatchObject({ source: 'local', sync_hold: { state: 'private' } });
      expect((await getTask(id)).sync_hold?.letter_id).toBeUndefined();
    }
    expect((await listLetters()).letters.length).toBe(before);
    expect(await pendingKeptForTest()).toEqual(expect.arrayContaining([a.json.task.id, b.json.task.id]));
    // Main takes the line here (the fixture has no Main session).
    const told: string[] = [];
    resetKeptDigestForTest(async (l) => { told.push(l); return true; });
    const line = await tellKeptDigestNow();
    expect(told).toEqual([line]);
    expect(line).toMatch(/Walnut kept \d+ out of Team Tracker/);
    expect(line).toContain(`"Zephyr kite notes" (${a.json.task.id})`);
    expect(line).toContain('Nothing waits on the user');
    expect(await pendingKeptForTest()).toEqual([]);
  });

  it('a batch letter an earlier version sent answers for each of its tasks', async () => {
    const a = await api('/api/v1/tasks', { body: { title: 'Zephyr kite notes', project: 'Team' } });
    const b = await api('/api/v1/tasks', { body: { title: 'Marigold puzzle plan', project: 'Team' } });
    await settle();
    const la = await oldLetter([a.json.task.id, b.json.task.id]);
    expect((await api(`/api/v1/human-inbox/${la}/answer`, { body: { actionId: 'keep-local' } })).status).toBeLessThan(300);
    for (const id of [a.json.task.id, b.json.task.id]) {
      await vi.waitFor(async () => expect((await getTask(id)).sync_hold).toMatchObject({ state: 'chosen', by: 'user' }), { timeout: 5000 });
    }
  });

  it('deciding one task of an earlier batch letter from its menu leaves the letter open for the others', async () => {
    const a = await api('/api/v1/tasks', { body: { title: 'Zephyr kite repair', project: 'Team' } });
    const b = await api('/api/v1/tasks', { body: { title: 'Zephyr glider forms', project: 'Team' } });
    await settle();
    const letter = await oldLetter([a.json.task.id, b.json.task.id]);
    expect((await getTask(b.json.task.id)).sync_hold!.letter_id).toBe(letter);
    expect((await api(`/api/v1/tasks/${a.json.task.id}/make-local`, { body: { outside: 'keep' } })).status).toBe(200);
    expect((await getLetter(letter)).archived).toBe(false);
    expect((await getTask(a.json.task.id)).sync_hold?.letter_id).toBeUndefined();
    expect((await api(`/api/v1/human-inbox/${letter}/answer`, { body: { actionId: 'keep-local' } })).status).toBeLessThan(300);
    await vi.waitFor(async () => expect((await getTask(b.json.task.id)).sync_hold).toMatchObject({ state: 'chosen', by: 'user' }), { timeout: 5000 });
  });

  it('the setting wins over the manifest, and turning the check off gives back what was kept out, linked to its old copy', async () => {
    await setProvider(MINE, { check: true, ai: true });
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
    // Walnut sends no letter now; one an earlier version sent is settled by the release.
    const letters = [await oldLetter([born.json.task.id])];
    const creates = mine.createTask.mock.calls.length;

    await setProvider(MINE, { check: false });
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
