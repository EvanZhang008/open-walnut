/**
 * task_move end to end over the real task, session, queue and request stores, with two
 * hosts whose daemons are the real move cores (transfer-pack-core.ts, transfer-core.ts)
 * over two folders of this machine, and real git. Only starting and stopping a CLI is
 * stubbed. The case is 2026-10-31's: a session in a SHARED checkout full of other
 * agents' uncommitted files, whose task's real work is a clone in its task directory.
 *
 * Pinned: the task keeps its id, its conversation, its open request and its queued
 * message; exactly its own work arrives on the other host (the clone's commits, edit and
 * untracked file, the task directory's plan), none of the shared checkout's other files;
 * the old host is untouched; a failed start puts the task back where it was.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { createMockConstants } from '../../helpers/mock-constants.js';
import { gitChildEnv } from '../../../src/lib/git-env.js';

const W = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fsx = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const osx = require('node:os') as typeof import('node:os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const px = require('node:path') as typeof import('node:path');
  const root = fsx.realpathSync(fsx.mkdtempSync(px.join(osx.tmpdir(), 'walnut-task-move-e2e-')));
  return {
    root,
    homes: { __local__: px.join(root, 'mac-home'), cloud: px.join(root, 'cloud-home') } as Record<string, string>,
    starts: [] as Array<Record<string, unknown>>,
    stops: [] as string[],
    failStart: false,
    /** A start waits on this while set (a move still in flight). */
    gate: null as Promise<void> | null,
    /** fs.ls of the target fails (the listing is no answer). */
    failList: false,
    nextSid: 0,
    history: {} as Record<string, Array<Record<string, unknown>>>,
    /** The Changed tab's groups for the old session. */
    changes: [] as Array<{ repoRoot: string; label: string; kind: string; files: Array<Record<string, unknown> & { relPath: string }> }>,
  };
});

vi.mock('../../../src/constants.js', () => createMockConstants('task-move'));
vi.mock('../../../src/utils/process.js', () => ({ isProcessAlive: () => true, isProcessAliveAsync: async () => true }));
vi.mock('../../../src/core/agents/host-engines.js', () => ({ hostEngineAvailability: async () => null }));
vi.mock('../../../src/core/config-manager.js', async (orig) => {
  const real = await orig<typeof import('../../../src/core/config-manager.js')>();
  return { ...real, getConfig: async () => ({ ...(await real.getConfig()), hosts: { cloud: { hostname: 'cloud', enabled: true } } }) };
});
vi.mock('../../../src/core/sessions/task-dir-place.js', () => ({
  taskDirForHost: async (taskId: string, host?: string | null) => `${W.homes[host && host !== 'local' ? host : '__local__']}/tasks/${taskId}`,
  ensureTaskDirOnHost: async (taskId: string, host?: string | null) => {
    const h = host && host !== 'local' ? host : '__local__';
    const dir = `${W.homes[h]}/tasks/${taskId}`;
    (await import('node:fs')).mkdirSync(dir, { recursive: true });
    return { path: dir, host: h };
  },
  localTaskDirRoot: () => `${W.homes.__local__}/tasks`,
}));
vi.mock('../../../src/core/daemon-file-reader.js', () => {
  const expand = (host: string, p: string) => (p.startsWith('~/') ? `${W.homes[host]}${p.slice(1)}` : p);
  return {
    DaemonNeedsUpgradeError: class extends Error {},
    DaemonFileReader: class {
      constructor(private host: string) {}
      async writeFile(p: string, content: string) {
        const f = expand(this.host, p);
        const nfs = await import('node:fs');
        nfs.mkdirSync((await import('node:path')).dirname(f), { recursive: true });
        nfs.writeFileSync(f, content);
      }
      async listDir(p: string) { return (await import('node:fs')).readdirSync(expand(this.host, p)); }
      async listDirStrict(p: string) {
        if (W.failList) throw new Error('could not list: the link dropped');
        return (await import('node:fs')).readdirSync(expand(this.host, p));
      }
      async removePath(p: string) {
        const f = expand(this.host, p);
        if (!f.startsWith(W.root)) throw new Error('outside the test root');
        (await import('node:fs')).rmSync(f, { recursive: true, force: true });
      }
      async readFileBytes() { return null; }
    },
  };
});
vi.mock('../../../src/core/sessions/session-lifecycle.js', () => ({
  readProviderSessionHistory: async (sid: string) => ({ messages: W.history[sid] ?? [] }),
  terminateSession: async (sid: string) => {
    W.stops.push(sid);
    const { updateSessionRecord } = await import('../../../src/core/session-tracker.js');
    await updateSessionRecord(sid, { process_status: 'stopped' } as never);
  },
}));
vi.mock('../../../src/core/session-changes.js', () => ({
  // The Changed tab's list for the old session (none by default: it changed nothing in the shared checkout).
  computeSessionChanges: async () => ({ sessionId: 'x', groups: W.changes, fileCount: W.changes.length }),
}));
vi.mock('../../../src/core/sessions/task-start.js', () => ({
  startSessionForTask: async (params: Record<string, unknown>) => {
    W.starts.push(params);
    if (W.gate) await W.gate;
    const { createSessionRecord, updateSessionRecord } = await import('../../../src/core/session-tracker.js');
    const sid = `moved-sid-${++W.nextSid}`;
    await createSessionRecord(sid, String(params.taskIdPrefix), 'Marina', String(params.cwd));
    await updateSessionRecord(sid, { host: params.host === '__local__' ? undefined : params.host, process_status: 'idle', messageCount: 1 } as never);
    if (W.failStart) throw new Error('the CLI would not start');
    return { started: true, sessionId: sid };
  },
}));

import { WALNUT_HOME } from '../../../src/constants.js';
import { addTask, getTask, _resetForTesting } from '../../../src/core/task-manager.js';
import { closeDb as closeTaskDb } from '../../../src/core/task-db.js';
import { closeDb as closeSessionDb } from '../../../src/core/session-db.js';
import { createSessionRecord, getSessionByClaudeId, updateSessionRecord, _resetSessionTrackerForTesting } from '../../../src/core/session-tracker.js';
import { requestEngineSwitch } from '../../../src/core/sessions/engine-switch.js';
import { taskConversation } from '../../../src/core/sessions/task-session-claim.js';
import { createSessionRequest, getSessionRequest } from '../../../src/core/session-requests.js';
import { getStore, mutateStore } from '../../../src/core/session-queue-store.js';
import { __setTransferConnectionResolverForTesting, type TransferConn } from '../../../src/core/transfer/daemon-transfer-client.js';
import { createTransferPack, type TransferPackDeps } from '../../../src/providers/transfer-pack-core.js';
import { createTransferCore, type TransferCoreDeps } from '../../../src/providers/transfer-core.js';
import { recordRepoPath, repoKey } from '../../../src/core/hosts/host-profile.js';
import { __setHostLoadProberForTesting } from '../../../src/core/hosts/placement.js';
import { placeStartByLoad } from '../../../src/core/sessions/start-placement.js';
import { sendMessageToSession } from '../../../src/core/session-message-queue.js';
import { MOVE_HELD_REASON } from '../../../src/core/sessions/engine-switch-io.js';

const gitconfig = path.join(W.root, 'gitconfig');
fs.writeFileSync(gitconfig, '[user]\n\tname = Mover\n\temail = mover@example.com\n[init]\n\tdefaultBranch = main\n')
const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: W.root, TMPDIR: W.root, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1', LANG: 'C' };
const URL = 'https://example.invalid/acme/marina.git';
const guardedSpawn = ((cmd: string, args: string[], o: Record<string, unknown>) => {
  if (o.cwd && !String(o.cwd).startsWith(W.root)) throw new Error('spawn outside the test root: ' + String(o.cwd));
  return spawn(cmd, args, o);
});

/** One host's daemon: the real move cores over that host's home, plus fs.readRange and fs.find. */
function daemonFor(host: string): TransferConn {
  const home = W.homes[host];
  const pack = createTransferPack({ fs, path, crypto, spawn: guardedSpawn as unknown as TransferPackDeps['spawn'], env, home });
  const core = createTransferCore({ fs, path, crypto, spawn: guardedSpawn as unknown as TransferCoreDeps['spawn'], env, home });
  const expand = (p: string) => (p.startsWith('~/') ? `${home}${p.slice(1)}` : p);
  const answer = async (fn: () => Promise<unknown>) => {
    try { return { ok: true, ...(await fn() as Record<string, unknown>) }; } catch (err) {
      const e = err as Error & { code?: string; data?: Record<string, unknown> };
      return { ok: false, error: e.message, code: e.code ?? 'failed', ...(e.data ?? {}) };
    }
  };
  return {
    hasCapability: () => true,
    send: async (cmd, p) => {
      switch (cmd) {
        case 'transfer.pack': return answer(() => pack.pack(p));
        case 'transfer.scan': return answer(() => pack.scan(p));
        case 'transfer.apply': return answer(() => pack.apply(p));
        case 'transfer.clear': return answer(() => pack.clear(p));
        case 'fs.writePart': return answer(() => core.writePart(p, { boundHome: null, origin: null }));
        case 'fs.find': return { ok: true, files: [] };
        case 'fs.readRange': {
          const f = expand(String(p.path));
          const buf = fs.readFileSync(f);
          const start = Number(p.start); const len = Number(p.length);
          const part = buf.subarray(start, start + len);
          return { ok: true, data: part.toString('base64'), bytesRead: part.length, fileSize: buf.length };
        }
        default: return { ok: false, error: `${cmd} is not in this test daemon`, code: 'unknown' };
      }
    },
  };
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, env: gitChildEnv(env), stdio: 'pipe' }).toString('utf8').trim();
}
function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

let shared = '';
let targetBase = '';
/** The Mac's shared checkout (other agents' files in it), the task's clone and plan, the cloud's own checkout. */
function world(taskId: string): { clone: string } {
  const base = path.join(W.root, 'world');
  fs.rmSync(base, { recursive: true, force: true });
  const bare = path.join(base, 'remote.git');
  shared = path.join(base, 'mac-workplace', 'marina');
  targetBase = path.join(base, 'cloud-workplace', 'marina');
  fs.mkdirSync(path.dirname(shared), { recursive: true });
  fs.mkdirSync(path.dirname(targetBase), { recursive: true });
  execFileSync('git', ['init', '-q', '--bare', bare], { env: gitChildEnv(env) });
  git(path.dirname(shared), ['clone', '-q', bare, shared]);
  write(path.join(shared, 'a.txt'), 'a1\n');
  write(path.join(shared, 'b.txt'), 'b1\n');
  git(shared, ['add', '-A']);
  git(shared, ['commit', '-q', '-m', 'base']);
  git(shared, ['push', '-q', 'origin', 'main']);
  git(path.dirname(targetBase), ['clone', '-q', bare, targetBase]);
  git(shared, ['remote', 'set-url', 'origin', URL]);
  const taskDir = `${W.homes.__local__}/tasks/${taskId}`;
  const clone = path.join(taskDir, 'marina');
  fs.mkdirSync(taskDir, { recursive: true });
  git(taskDir, ['clone', '-q', '--shared', shared, clone]);
  git(clone, ['checkout', '-q', '-b', 'wt/move']);
  write(path.join(clone, 'feature.txt'), 'f1\n');
  git(clone, ['add', '-A']);
  git(clone, ['commit', '-q', '-m', 'the task\'s commit']);
  write(path.join(clone, 'b.txt'), 'b edited by the task\n');
  write(path.join(clone, 'scratch.txt'), 'untracked of the task\n');
  write(path.join(taskDir, 'plan.md'), '# the task\'s plan\n');
  // Other agents' work in progress in the shared checkout.
  write(path.join(shared, 'a.txt'), 'FOREIGN edit\n');
  write(path.join(shared, 'foreign.txt'), 'FOREIGN untracked\n');
  return { clone };
}

beforeEach(async () => {
  closeTaskDb(); closeSessionDb(); _resetForTesting(); _resetSessionTrackerForTesting();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
  for (const h of Object.values(W.homes)) { fs.rmSync(h, { recursive: true, force: true }); fs.mkdirSync(h, { recursive: true }); }
  W.starts.length = 0; W.stops.length = 0; W.failStart = false; W.history = {}; W.changes = []; W.gate = null; W.failList = false;
  await mutateStore((st) => { st.queues = {}; }, false, true);
  __setTransferConnectionResolverForTesting(async (host) => (W.homes[host] ? [daemonFor(host)] : []));
});

afterEach(async () => {
  __setTransferConnectionResolverForTesting(null);
  await new Promise((r) => setTimeout(r, 30));
  closeTaskDb(); closeSessionDb();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
});
afterAll(() => { if (W.root.includes('walnut-task-move-e2e-')) fs.rmSync(W.root, { recursive: true, force: true }); });

async function taskInSharedCheckout(): Promise<{ taskId: string; sid: string; clone: string }> {
  const { task } = await addTask({ title: 'Speed up the parser', project: 'Marina' } as never);
  const { clone } = world(task.id);
  const sid = 'mac-sid';
  await createSessionRecord(sid, task.id, 'Marina', shared);
  await updateSessionRecord(sid, { process_status: 'idle', messageCount: 4 } as never);
  W.history[sid] = [
    { role: 'user', text: 'Make the parser faster', timestamp: '2026-10-31T04:00:00Z' },
    { role: 'assistant', text: 'Committed the fast path on wt/move; the word is HERON.', timestamp: '2026-10-31T04:10:00Z' },
  ];
  // The cloud host already has a checkout of this repository: the clone takes seconds.
  await recordRepoPath('cloud', repoKey(URL, 'marina'), targetBase);
  return { taskId: task.id, sid, clone };
}

describe('task_move', () => {
  it('keeps the task and its conversation, and carries exactly its own work', async () => {
    const { taskId, sid, clone } = await taskInSharedCheckout();
    const head = git(clone, ['rev-parse', 'HEAD']);
    // An open request to the old session, and a message parked in its queue (a pending one would make the move wait for it).
    const req = await createSessionRequest({ fromSessionId: 'lead-sid', toSessionId: sid, toTaskId: taskId, text: 'How far along?' });
    await mutateStore((st) => {
      st.queues[sid] = [{ id: 'qm-wait', sessionId: sid, message: 'one more thing', status: 'parked', createdAt: new Date().toISOString() } as never];
    }, false, true);

    const res = await requestEngineSwitch({ taskId, engine: 'claude', host: 'cloud', message: 'Carry on.', source: 'test' });

    expect(res).toMatchObject({ state: 'done', taskId, fromSessionId: sid, host: 'cloud', fromHost: '__local__' });
    const destTaskDir = `${W.homes.cloud}/tasks/${taskId}`;
    const dest = `${destTaskDir}/marina`;
    expect(W.starts).toHaveLength(1);
    expect(W.starts[0]).toMatchObject({ taskIdPrefix: taskId, host: 'cloud', cwd: dest, engine: 'claude', source: 'engine-switch' });
    const message = String(W.starts[0].message);
    expect(message).toContain('This task moved from this Mac to cloud');
    expect(message).toContain('the word is HERON');
    expect(message).toContain(`-> ${dest}`);
    expect(message.trimEnd().endsWith('Carry on.')).toBe(true);
    expect(res.moved?.join(' ')).toMatch(/1 commit no remote has, uncommitted changes, 1 untracked file/);

    // Exactly the task's own work on the cloud host.
    expect(git(dest, ['rev-parse', 'HEAD'])).toBe(head);
    expect(git(dest, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('wt/move');
    expect(fs.readFileSync(`${dest}/b.txt`, 'utf8')).toBe('b edited by the task\n');
    expect(fs.readFileSync(`${dest}/scratch.txt`, 'utf8')).toBe('untracked of the task\n');
    expect(fs.readFileSync(`${destTaskDir}/plan.md`, 'utf8')).toBe('# the task\'s plan\n');
    expect(fs.readFileSync(`${dest}/a.txt`, 'utf8')).toBe('a1\n');
    expect(fs.existsSync(`${dest}/foreign.txt`)).toBe(false);
    expect(git(dest, ['remote', 'get-url', 'origin'])).toBe(URL);
    // The Mac is untouched: the shared checkout keeps the other agents' files, the clone stays as a backup.
    expect(fs.readFileSync(path.join(shared, 'a.txt'), 'utf8')).toBe('FOREIGN edit\n');
    expect(fs.existsSync(path.join(shared, 'foreign.txt'))).toBe(true);
    expect(git(clone, ['rev-parse', 'HEAD'])).toBe(head);

    // Same task: its active session is the new one, the old one is its history, requests and queue follow.
    const newSid = res.sessionId!;
    expect((await taskConversation(taskId))?.claudeSessionId).toBe(newSid);
    expect(await getSessionByClaudeId(sid)).toMatchObject({ taskId, archived: true, supersededBy: newSid });
    expect((await getSessionByClaudeId(newSid))?.engineSwitch).toMatchObject({ fromSessionId: sid, fromHost: '__local__', fromCwd: shared });
    expect((await getSessionRequest(req.id))?.toSessionId).toBe(newSid);
    expect((await getStore()).queues[newSid]?.map((r) => r.id)).toContain('qm-wait');
    expect((await getTask(taskId)).engine_switch).toMatchObject({ state: 'done', move: true, from_host: '__local__', session_id: newSid });
    expect(W.stops).toEqual([sid]);
  }, 120_000);

  it('a task that worked IN the shared checkout carries only the files its session changed there', async () => {
    const { taskId, sid, clone } = await taskInSharedCheckout();
    // No clone of its own this time; it edited own.txt in the shared checkout itself.
    fs.rmSync(path.dirname(clone), { recursive: true, force: true });
    write(path.join(shared, 'own.txt'), 'the task\'s edit\n');
    // The Changed list as the session recorded it: own.txt was new when it first wrote it.
    W.changes = [{ repoRoot: shared, label: 'marina', kind: 'cwd', files: [{ relPath: 'own.txt', filePath: path.join(shared, 'own.txt'), status: 'added', before: '', after: 'the task\'s edit\n', ops: 1, partial: false }] }];

    const res = await requestEngineSwitch({ taskId, engine: 'claude', host: 'cloud', message: 'Carry on.', source: 'test' });

    const dest = `${W.homes.cloud}/tasks/${taskId}/marina`;
    expect(res).toMatchObject({ state: 'done', host: 'cloud' });
    expect(W.starts[0]).toMatchObject({ cwd: dest });
    expect(fs.readFileSync(`${dest}/own.txt`, 'utf8')).toBe('the task\'s edit\n');
    expect(fs.readFileSync(`${dest}/a.txt`, 'utf8')).toBe('a1\n');
    expect(fs.existsSync(`${dest}/foreign.txt`)).toBe(false);
    const said = res.moved!.join('\n');
    expect(said).toContain('a shared checkout: only this task\'s own files');
    // Done: the task's own file left the shared checkout, backed up under its task directory on the Mac.
    expect(fs.existsSync(path.join(shared, 'own.txt'))).toBe(false);
    expect(said).toMatch(/Cleared from .* 1 file this task changed, backed up in .*\/tasks\/.*\/moved-out\/\d{4}-\d{2}-\d{2}-marina-to-cloud/);
    const backups = fs.readdirSync(`${W.homes.__local__}/tasks/${taskId}/moved-out`);
    expect(backups).toHaveLength(1);
    expect(fs.readdirSync(`${W.homes.__local__}/tasks/${taskId}/moved-out/${backups[0]}`)).toContain('untracked.tgz');
    // Never another writer's files.
    expect(fs.readFileSync(path.join(shared, 'a.txt'), 'utf8')).toBe('FOREIGN edit\n');
    expect(fs.existsSync(path.join(shared, 'foreign.txt'))).toBe(true);
    expect(said).toMatch(/Left on the old host: 2 changed files .* that this task did not change \((a\.txt, foreign\.txt|foreign\.txt, a\.txt)\)/);
    expect((await getSessionByClaudeId(sid))?.archived).toBe(true);
  }, 120_000);

  it('placement: a first start on an overloaded Mac goes to the cloud host, in the task directory, from the cloud\'s own checkout', async () => {
    const { taskId, clone } = await taskInSharedCheckout();
    fs.rmSync(path.dirname(clone), { recursive: true, force: true });
    const now = new Date().toISOString();
    const GB = 1024 ** 3;
    __setHostLoadProberForTesting(async (host) => (host === '__local__'
      ? { cpus: 14, load: [600, 500, 400], cpuBusy: 0.6, memTotalBytes: 48 * GB, memAvailBytes: 2 * GB, diskPath: '/', diskFreeBytes: 20 * GB, diskTotalBytes: 1000 * GB, at: now }
      : { cpus: 48, load: [3, 3, 3], cpuBusy: 0.05, memTotalBytes: 192 * GB, memAvailBytes: 150 * GB, diskPath: '/', diskFreeBytes: 2000 * GB, diskTotalBytes: 3000 * GB, at: now }));
    try {
      const task = await getTask(taskId);
      const launch = { host: '', cwd: shared, message: 'Make the parser faster.' };
      const placed = await placeStartByLoad(task, {}, launch, 'claude');
      const dest = `${W.homes.cloud}/tasks/${taskId}/marina`;
      expect(placed).toMatchObject({ host: 'cloud', moved: true, from: '__local__', cwd: dest, setUp: true });
      expect(placed!.reason).toMatch(/^this Mac is overloaded \(load 600 on 14 CPUs/);
      expect(launch).toMatchObject({ host: 'cloud', cwd: dest });
      expect(launch.message).toContain('Walnut placed this task on cloud: this Mac is overloaded');
      expect(launch.message.trimEnd().endsWith('Make the parser faster.')).toBe(true);
      // The committed state only: none of the shared checkout's work in progress.
      expect(fs.readFileSync(`${dest}/a.txt`, 'utf8')).toBe('a1\n');
      expect(fs.existsSync(`${dest}/foreign.txt`)).toBe(false);
      expect(git(dest, ['rev-parse', 'HEAD'])).toBe(git(shared, ['rev-parse', 'HEAD']));
      expect(fs.readFileSync(`${dest}/.git/objects/info/alternates`, 'utf8').trim()).toBe(`${targetBase}/.git/objects`);

      // A start that names its host, or Mac-only work, is never placed.
      expect(await placeStartByLoad(task, { host: '' }, { host: '', cwd: shared, message: 'x' }, 'claude')).toBeNull();
      const ios = await placeStartByLoad({ ...task, title: 'Fix the iOS share sheet' }, {}, { host: '', cwd: shared, message: 'x' }, 'claude');
      expect(ios).toMatchObject({ host: '', moved: false });
      // A task with an isolated workspace runs in it.
      expect(await placeStartByLoad({ ...task, workspace: { state: 'preparing' } as never }, {}, { host: '', cwd: shared, message: 'x' }, 'claude')).toBeNull();
      // Setting up past the budget: the start stays where it was, untouched.
      process.env.WALNUT_PLACE_SETUP_MS = '1';
      try {
        const late = { host: '', cwd: shared, message: 'x' };
        const slow = await placeStartByLoad(task, {}, late, 'claude');
        expect(slow).toMatchObject({ host: '', moved: false });
        // Either the read of the folder or the setup ran out of the budget.
        expect(slow!.reason).toMatch(/(could not be prepared there in time; it stays|no other host has room)$/);
        expect(late).toEqual({ host: '', cwd: shared, message: 'x' });
      } finally {
        delete process.env.WALNUT_PLACE_SETUP_MS;
      }
    } finally {
      __setHostLoadProberForTesting(null);
    }
  }, 120_000);

  it('a failed start puts the task back on its host; the copy stays for a retry', async () => {
    const { taskId, sid } = await taskInSharedCheckout();
    // Its own file in the shared checkout stays there: only a finished move clears it.
    write(path.join(shared, 'own.txt'), 'the task\'s edit\n');
    W.changes = [{ repoRoot: shared, label: 'marina', kind: 'cwd', files: [{ relPath: 'own.txt' }] }];
    W.failStart = true;
    await expect(requestEngineSwitch({ taskId, engine: 'claude', host: 'cloud', message: 'Carry on.', source: 'test' }))
      .rejects.toMatchObject({ code: 'start_failed', message: expect.stringContaining('The task stays on this Mac') });
    expect((await taskConversation(taskId))?.claudeSessionId).toBe(sid);
    const old = await getSessionByClaudeId(sid);
    expect(old?.archived).toBeFalsy();
    expect((await getTask(taskId)).engine_switch).toMatchObject({ state: 'failed', move: true });
    expect(fs.readFileSync(path.join(shared, 'own.txt'), 'utf8')).toBe('the task\'s edit\n');
  }, 120_000);

  it('a message sent while the task moves is held at once (never waits for the copy) and goes with the task', async () => {
    const { taskId, sid } = await taskInSharedCheckout();
    let open!: () => void;
    W.gate = new Promise<void>((r) => { open = r; });
    const moving = requestEngineSwitch({ taskId, engine: 'claude', host: 'cloud', message: 'Carry on.', source: 'test' });
    await vi.waitFor(() => expect(W.starts).toHaveLength(1), { timeout: 60_000, interval: 50 });
    const t0 = Date.now();
    const row = await sendMessageToSession(sid, 'Also add a test.', { source: 'ui', taskId });
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(row).toMatchObject({ sessionId: sid, status: 'parked', parkedReason: MOVE_HELD_REASON });
    open();
    const res = await moving;
    const queued = (await getStore()).queues[res.sessionId!] ?? [];
    expect(queued.find((r) => r.id === row.id)).toMatchObject({ status: 'pending', sessionId: res.sessionId });
    expect(queued.find((r) => r.id === row.id)?.parkedReason).toBeUndefined();
    expect((await getStore()).queues[sid] ?? []).toEqual([]);
  }, 120_000);

  it('a held message goes back to the old session when the move fails', async () => {
    const { taskId, sid } = await taskInSharedCheckout();
    let open!: () => void;
    W.gate = new Promise<void>((r) => { open = r; });
    W.failStart = true;
    const moving = requestEngineSwitch({ taskId, engine: 'claude', host: 'cloud', message: 'Carry on.', source: 'test' }).catch((e: unknown) => e);
    await vi.waitFor(() => expect(W.starts).toHaveLength(1), { timeout: 60_000, interval: 50 });
    const row = await sendMessageToSession(sid, 'Also add a test.', { source: 'ui', taskId });
    open();
    expect(await moving).toMatchObject({ code: 'start_failed' });
    expect(((await getStore()).queues[sid] ?? []).find((r) => r.id === row.id)).toMatchObject({ status: 'pending' });
  }, 120_000);

  it('a move back never touches what the target task directory already holds', async () => {
    const { taskId } = await taskInSharedCheckout();
    const destTaskDir = `${W.homes.cloud}/tasks/${taskId}`;
    // The copy an earlier move left there, with work of its own.
    write(`${destTaskDir}/marina/keep.txt`, 'an older copy\n');
    const res = await requestEngineSwitch({ taskId, engine: 'claude', host: 'cloud', message: 'Carry on.', source: 'test' });
    expect(res).toMatchObject({ state: 'done' });
    expect(W.starts[0]).toMatchObject({ cwd: `${destTaskDir}/marina-2` });
    expect(fs.readdirSync(`${destTaskDir}/marina`)).toEqual(['keep.txt']);
    expect(git(`${destTaskDir}/marina-2`, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('wt/move');
  }, 120_000);

  it('a target task directory that cannot be read fails the move; the task stays', async () => {
    const { taskId, sid } = await taskInSharedCheckout();
    W.failList = true;
    await expect(requestEngineSwitch({ taskId, engine: 'claude', host: 'cloud', message: 'Carry on.', source: 'test' }))
      .rejects.toMatchObject({ code: 'target_task_dir' });
    expect((await taskConversation(taskId))?.claudeSessionId).toBe(sid);
    expect(W.starts).toHaveLength(0);
  }, 60_000);

  it('a move waits for a running turn (an agent moving itself), and refuses the host it is on', async () => {
    const { taskId, sid } = await taskInSharedCheckout();
    await expect(requestEngineSwitch({ taskId, engine: 'claude', host: 'local', message: 'x', source: 'test' })).rejects.toMatchObject({ code: 'same_host' });
    await expect(requestEngineSwitch({ taskId, engine: 'claude', host: 'nowhere', message: 'x', source: 'test' })).rejects.toMatchObject({ code: 'unknown_host' });
    await updateSessionRecord(sid, { process_status: 'running' } as never);
    const res = await requestEngineSwitch({ taskId, engine: 'claude', host: 'cloud', message: 'Carry on.', source: 'test' });
    expect(res).toMatchObject({ state: 'pending', host: 'cloud' });
    expect((await getTask(taskId)).engine_switch).toMatchObject({ state: 'pending', move: true, to: { host: 'cloud' } });
    expect(W.starts).toHaveLength(0);
  }, 60_000);
});
