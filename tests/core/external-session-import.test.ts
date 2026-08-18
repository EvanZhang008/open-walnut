/**
 * External-session importer tests — the server half: daemon scan results in,
 * per-host holder task + session records out.
 *
 * The daemon RPC is the only mock (there is no real daemon in a unit run);
 * task store and session DB are the real ones, so the 1-session-per-task slot
 * rule, tag lookup, and duplicate protection are genuinely exercised.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());
vi.mock('../../src/utils/process.js', () => ({ isProcessAlive: () => true }));

// Daemon layer: one fake connection per host, capability-gated like the real one.
interface FakeHost {
  capabilities: string[];
  candidates: unknown[];
  truncated?: boolean;
  /** Set to make the RPC reject, exercising the per-host failure path. */
  fail?: boolean;
  calls: Array<Record<string, unknown>>;
}
const hosts = new Map<string, FakeHost>();

vi.mock('../../src/providers/daemon-connection.js', () => ({
  getConnectedDaemonConnection: (hostKey: string) => {
    const entry = hosts.get(hostKey);
    if (!entry) return null;
    return {
      hasCapability: (cap: string) => entry.capabilities.includes(cap),
      send: async (_cmd: string, params: Record<string, unknown>) => {
        entry.calls.push(params);
        if (entry.fail) throw new Error('ssh exploded');
        return { ok: true, candidates: entry.candidates, truncated: entry.truncated === true };
      },
    };
  },
}));

let configHosts: Record<string, { hostname: string; enabled?: boolean }> = {};
vi.mock('../../src/core/config-manager.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, getConfig: async () => ({ hosts: configHosts, defaults: {} }) };
});

import {
  importExternalSessions,
  externalHolderTaskTitle,
  EXTERNAL_SESSIONS_PROJECT,
} from '../../src/core/sessions/external-session-import.js';
import { getSessionByClaudeId, getSessionsForTask, _resetSessionTrackerForTesting } from '../../src/core/session-tracker.js';
import { getTask, queryTasks, _resetForTesting as _resetTaskManager } from '../../src/core/task-manager.js';
import { closeDb as closeSessionDb } from '../../src/core/session-db.js';
import { closeDb as closeTaskDb } from '../../src/core/task-db.js';
import { bus } from '../../src/core/event-bus.js';
import { WALNUT_HOME } from '../../src/constants.js';

/** rm with retries — WAL checkpoint files can reappear mid-delete (ENOTEMPTY). */
async function rmWalnutHome(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    try { await fsp.rm(WALNUT_HOME, { recursive: true, force: true }); return; }
    catch { await new Promise((r) => setTimeout(r, 50)); }
  }
}

function candidate(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: 'ext-1',
    engine: 'claude',
    cwd: '/Users/dev/proj',
    title: 'Fix the login bug',
    origin: 'cli',
    startedAt: '2026-08-10T10:00:00.000Z',
    lastActiveAt: '2026-08-10T12:00:00.000Z',
    messageCount: 12,
    transcriptPath: '/Users/dev/.claude/projects/x/ext-1.jsonl',
    ...over,
  };
}

function setHost(host: string, over: Partial<FakeHost> = {}): FakeHost {
  const entry: FakeHost = {
    capabilities: ['external-scan-v1'], candidates: [], calls: [], ...over,
  };
  hosts.set(host, entry);
  return entry;
}

// BOTH dbs must close before the rm: each is a module-level singleton, and
// deleting the file under a live handle leaves it on an unlinked inode — the
// next test then reads the PREVIOUS test's tasks (holder tasks accumulating
// across cases is exactly how this bit).
async function resetAll(): Promise<void> {
  closeSessionDb();
  closeTaskDb();
  _resetSessionTrackerForTesting();
  _resetTaskManager();
  await rmWalnutHome();
}

beforeEach(async () => {
  await resetAll();
  hosts.clear();
  configHosts = {};
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
});

afterEach(async () => {
  bus.clear();
  await resetAll();
});

describe('importExternalSessions', () => {
  it('imports a local candidate into a per-host holder task', async () => {
    setHost('__local__', { candidates: [candidate()] });

    const result = await importExternalSessions();
    expect(result.imported).toBe(1);
    expect(result.hostsScanned).toEqual(['__local__']);

    const taskId = result.taskIdByHost['__local__'];
    const task = await getTask(taskId);
    expect(task.title).toBe(externalHolderTaskTitle('__local__'));
    // A real project, NOT the Inbox — in the Inbox these buckets sit unlabeled
    // among loose tasks and are effectively invisible.
    expect(task.project).toBe(EXTERNAL_SESSIONS_PROJECT);
    expect(task.session_ids).toContain('ext-1');
    // A bucket has no single live session — the slot must stay empty.
    expect(task.session_id).toBeFalsy();

    const record = await getSessionByClaudeId('ext-1');
    expect(record).toMatchObject({
      taskId,
      title: 'Fix the login bug',
      cwd: '/Users/dev/proj',
      process_status: 'stopped',
      provider: 'cli',
      messageCount: 12,
      startedAt: '2026-08-10T10:00:00.000Z',
      lastActiveAt: '2026-08-10T12:00:00.000Z',
      // Session rows carry their own project copy (search + filters read it).
      project: EXTERNAL_SESSIONS_PROJECT,
    });
    // Local sessions store no host sentinel.
    expect(record?.host).toBeUndefined();
    expect(record?.human_note).toContain('outside Walnut');
  });

  it('keeps the transcript\'s real timestamps (regression)', async () => {
    // engine/provider/human_note used to be patched on with a second
    // updateSessionRecord call, and that call bumps lastActiveAt to now (right
    // for a live session) — so every imported session claimed it had just been
    // active and sorted above genuinely-live work. They must be set at create.
    setHost('__local__', {
      candidates: [candidate({
        sessionId: 'old-1',
        engine: 'codex',
        startedAt: '2026-07-01T09:00:00.000Z',
        lastActiveAt: '2026-07-01T09:30:00.000Z',
      })],
    });
    await importExternalSessions();
    const record = await getSessionByClaudeId('old-1');
    expect(record?.startedAt).toBe('2026-07-01T09:00:00.000Z');
    expect(record?.lastActiveAt).toBe('2026-07-01T09:30:00.000Z');
    // …and the metadata still landed.
    expect(record?.engine).toBe('codex');
    expect(record?.provider).toBe('cli');
  });

  it('stamps engine=codex so the UI reads the right history source', async () => {
    setHost('__local__', {
      candidates: [
        candidate({ sessionId: 'cl-1', engine: 'claude' }),
        candidate({ sessionId: 'cx-1', engine: 'codex', origin: 'codex-tui' }),
      ],
    });
    await importExternalSessions();
    expect((await getSessionByClaudeId('cl-1'))?.engine).toBeUndefined();
    expect((await getSessionByClaudeId('cx-1'))?.engine).toBe('codex');
  });

  it('gives each host its own holder task and persists the remote host', async () => {
    configHosts = { buildbox: { hostname: 'cloud.example' } };
    setHost('__local__', { candidates: [candidate({ sessionId: 'local-1' })] });
    setHost('buildbox', { candidates: [candidate({ sessionId: 'remote-1' })] });

    const result = await importExternalSessions();
    expect(result.imported).toBe(2);
    const localTask = result.taskIdByHost['__local__'];
    const remoteTask = result.taskIdByHost['buildbox'];
    expect(localTask).not.toBe(remoteTask);
    expect((await getTask(remoteTask)).title).toContain('buildbox');
    expect((await getSessionByClaudeId('remote-1'))?.host).toBe('buildbox');
    expect((await getSessionByClaudeId('local-1'))?.host).toBeUndefined();
  });

  it('reuses the holder task across runs instead of duplicating it', async () => {
    const host = setHost('__local__', { candidates: [candidate({ sessionId: 'a' })] });
    const first = await importExternalSessions();
    host.candidates = [candidate({ sessionId: 'b' })];
    const second = await importExternalSessions();

    expect(second.taskIdByHost['__local__']).toBe(first.taskIdByHost['__local__']);
    const holders = await queryTasks({ tagsAll: ['walnut:external-sessions'] });
    expect(holders).toHaveLength(1);
    expect((await getSessionsForTask(holders[0].id)).map((s) => s.claudeSessionId).sort())
      .toEqual(['a', 'b']);
  });

  it('creates the project registry row so the group is real, not a bare label', async () => {
    setHost('__local__', { candidates: [candidate()] });
    await importExternalSessions();
    const { getStoreProjects } = await import('../../src/core/task-manager.js');
    const projects = await getStoreProjects();
    const key = Object.keys(projects).find((k) => k.toLowerCase() === EXTERNAL_SESSIONS_PROJECT.toLowerCase());
    expect(key).toBeTruthy();
    // source 'local' — a sync provider must never be able to claim this project.
    expect(projects[key!].source).toBe('local');
  });

  it('moves a pre-project bucket out of the Inbox and drags its sessions along', async () => {
    // Buckets created before the project existed landed in the Inbox with
    // project='' on both the task AND every imported session row.
    const host = setHost('__local__', { candidates: [candidate({ sessionId: 'legacy-1' })] });
    const first = await importExternalSessions();
    const taskId = first.taskIdByHost['__local__'];
    const { updateTask } = await import('../../src/core/task-manager.js');
    const { updateSessionRecord } = await import('../../src/core/session-tracker.js');
    await updateTask(taskId, { project: '' });
    await updateSessionRecord('legacy-1', { project: '' });
    expect((await getTask(taskId)).project).toBe('');

    host.candidates = [candidate({ sessionId: 'legacy-2' })];
    const second = await importExternalSessions();
    expect(second.taskIdByHost['__local__']).toBe(taskId);
    expect((await getTask(taskId)).project).toBe(EXTERNAL_SESSIONS_PROJECT);
    // Both the backfilled OLD session and the NEW one carry the project.
    for (const sid of ['legacy-1', 'legacy-2']) {
      expect((await getSessionByClaudeId(sid))?.project).toBe(EXTERNAL_SESSIONS_PROJECT);
    }
  });

  it('heals a stranded bucket even when the tick has nothing new to import (regression)', async () => {
    // The heal used to hang off the import path, so once every session was
    // already tracked the scan returned 0 candidates, the holder task was never
    // touched, and a bucket stranded in the Inbox stayed there forever.
    const host = setHost('__local__', { candidates: [candidate({ sessionId: 'only-1' })] });
    const first = await importExternalSessions();
    const taskId = first.taskIdByHost['__local__'];
    const { updateTask } = await import('../../src/core/task-manager.js');
    const { updateSessionRecord } = await import('../../src/core/session-tracker.js');
    await updateTask(taskId, { project: '' });
    await updateSessionRecord('only-1', { project: '' });

    host.candidates = []; // steady state: nothing new
    const second = await importExternalSessions();
    expect(second.imported).toBe(0);
    expect(second.taskIdByHost['__local__']).toBe(taskId);
    expect((await getTask(taskId)).project).toBe(EXTERNAL_SESSIONS_PROJECT);
    expect((await getSessionByClaudeId('only-1'))?.project).toBe(EXTERNAL_SESSIONS_PROJECT);
  });

  it('still never mints an empty bucket on a host with no external sessions', async () => {
    setHost('__local__', { candidates: [] });
    const result = await importExternalSessions();
    expect(result.taskIdByHost).toEqual({});
    expect(await queryTasks({ tagsAll: ['walnut:external-sessions'] })).toHaveLength(0);
  });

  it('respects a deliberate move to a different project', async () => {
    const host = setHost('__local__', { candidates: [candidate({ sessionId: 'moved-1' })] });
    const first = await importExternalSessions();
    const taskId = first.taskIdByHost['__local__'];
    const { updateTask } = await import('../../src/core/task-manager.js');
    await updateTask(taskId, { project: 'Walnut' });

    host.candidates = [candidate({ sessionId: 'moved-2' })];
    await importExternalSessions();
    // Only the empty/Inbox case self-heals — the user's own filing stands.
    expect((await getTask(taskId)).project).toBe('Walnut');
  });

  it('finds the holder task again after the user renames it', async () => {
    const host = setHost('__local__', { candidates: [candidate({ sessionId: 'a' })] });
    const first = await importExternalSessions();
    const { updateTask } = await import('../../src/core/task-manager.js');
    await updateTask(first.taskIdByHost['__local__'], { title: 'My imported junk drawer' });

    host.candidates = [candidate({ sessionId: 'b' })];
    const second = await importExternalSessions();
    expect(second.taskIdByHost['__local__']).toBe(first.taskIdByHost['__local__']);
    expect(await queryTasks({ tagsAll: ['walnut:external-sessions'] })).toHaveLength(1);
  });

  it('skips a candidate Walnut already tracks and tells the daemon about it', async () => {
    const host = setHost('__local__', { candidates: [candidate({ sessionId: 'dup' })] });
    await importExternalSessions();

    const second = await importExternalSessions();
    expect(second.imported).toBe(0);
    expect(second.skipped).toBe(1);
    // Second scan must pass the now-known id down so the daemon never parses it.
    expect(host.calls[1].knownSessionIds).toContain('dup');
  });

  it('never creates an empty holder task when a host has nothing to import', async () => {
    setHost('__local__', { candidates: [] });
    const result = await importExternalSessions();
    expect(result.imported).toBe(0);
    expect(result.taskIdByHost).toEqual({});
    expect(await queryTasks({ tagsAll: ['walnut:external-sessions'] })).toHaveLength(0);
  });

  it('skips hosts whose daemon lacks the capability', async () => {
    setHost('__local__', { capabilities: ['changes-v1'], candidates: [candidate()] });
    const result = await importExternalSessions();
    expect(result.imported).toBe(0);
    expect(result.hostsScanned).toEqual([]);
    expect(result.hostsSkipped).toContain('__local__');
  });

  it('skips a config host that is disabled', async () => {
    configHosts = { offbox: { hostname: 'off.example', enabled: false } };
    setHost('__local__', { candidates: [] });
    setHost('offbox', { candidates: [candidate({ sessionId: 'nope' })] });
    const result = await importExternalSessions();
    expect(result.hostsScanned).toEqual(['__local__']);
    expect(await getSessionByClaudeId('nope')).toBeNull();
  });

  it('keeps going when one host fails', async () => {
    configHosts = { badbox: { hostname: 'bad.example' } };
    setHost('__local__', { candidates: [candidate({ sessionId: 'good' })] });
    setHost('badbox', { fail: true });

    const result = await importExternalSessions();
    expect(result.imported).toBe(1);
    expect(await getSessionByClaudeId('good')).not.toBeNull();
  });

  it('reports daemon-side truncation rather than hiding it', async () => {
    setHost('__local__', { candidates: [candidate()], truncated: true });
    expect((await importExternalSessions()).truncated).toBe(true);
  });

  it('drops malformed candidates without failing the run', async () => {
    setHost('__local__', {
      candidates: [{ engine: 'claude' }, null, candidate({ sessionId: 'ok' })],
    });
    const result = await importExternalSessions();
    expect(result.imported).toBe(1);
    expect(await getSessionByClaudeId('ok')).not.toBeNull();
  });

  it('falls back to a generated title when the transcript had none', async () => {
    setHost('__local__', {
      candidates: [
        candidate({ sessionId: 'no-title-claude', title: undefined }),
        candidate({ sessionId: 'no-title-codex', title: undefined, engine: 'codex' }),
      ],
    });
    await importExternalSessions();
    expect((await getSessionByClaudeId('no-title-claude'))?.title).toContain('Claude session');
    expect((await getSessionByClaudeId('no-title-codex'))?.title).toContain('Codex session');
  });

  it('forwards the requested window to the daemon', async () => {
    const host = setHost('__local__', { candidates: [] });
    await importExternalSessions({ windowMs: 7 * 24 * 60 * 60 * 1000 });
    expect(host.calls[0].sinceMs).toBe(7 * 24 * 60 * 60 * 1000);
  });
});
