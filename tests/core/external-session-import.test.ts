/**
 * External-session importer tests — the server half: daemon scan results in,
 * per-host project + one task per session out.
 *
 * The daemon RPC is the only mock (there is no real daemon in a unit run);
 * task store and session DB are the real ones, so the 1-session-per-task slot
 * rule, project registry, and duplicate protection are genuinely exercised.
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
  externalImportProject,
} from '../../src/core/sessions/external-session-import.js';
import {
  getSessionByClaudeId,
  importSessionRecord,
  _resetSessionTrackerForTesting,
} from '../../src/core/session-tracker.js';
import {
  getTask,
  queryTasks,
  addTask,
  addSessionToHistory,
  getStoreProjects,
  _resetForTesting as _resetTaskManager,
} from '../../src/core/task-manager.js';
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

/** The imported task for a session id (session slot → task). */
async function taskForSession(sessionId: string) {
  const record = await getSessionByClaudeId(sessionId);
  expect(record?.taskId).toBeTruthy();
  return getTask(record!.taskId);
}

// BOTH dbs must close before the rm: each is a module-level singleton, and
// deleting the file under a live handle leaves it on an unlinked inode — the
// next test then reads the PREVIOUS test's tasks.
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

describe('importExternalSessions — one task per session', () => {
  it('creates a task per session, titled with the session name, in the per-host project', async () => {
    setHost('__local__', {
      candidates: [
        candidate({ sessionId: 'a-1', title: 'Fix the login bug' }),
        candidate({ sessionId: 'a-2', title: '排查 Bedrock proxy 502 错误' }),
      ],
    });

    const result = await importExternalSessions();
    expect(result.imported).toBe(2);
    expect(result.projectByHost['__local__']).toBe(externalImportProject('__local__'));

    const t1 = await taskForSession('a-1');
    const t2 = await taskForSession('a-2');
    expect(t1.id).not.toBe(t2.id);
    // Task title IS the session's auto-generated name.
    expect(t1.title).toBe('Fix the login bug');
    expect(t2.title).toBe('排查 Bedrock proxy 502 错误');
    // Both grouped under the host's project.
    expect(t1.project).toBe(externalImportProject('__local__'));
    expect(t2.project).toBe(t1.project);
    // Normal 1-session-per-task shape: session sits in the SLOT.
    expect(t1.session_id).toBe('a-1');
    expect(t2.session_id).toBe('a-2');
  });

  it('imports the session record with real metadata and timestamps', async () => {
    setHost('__local__', { candidates: [candidate({ sessionId: 'meta-1', engine: 'codex', origin: 'codex-tui' })] });
    await importExternalSessions();
    const record = await getSessionByClaudeId('meta-1');
    expect(record).toMatchObject({
      title: 'Fix the login bug',
      cwd: '/Users/dev/proj',
      process_status: 'stopped',
      provider: 'cli',
      engine: 'codex',
      messageCount: 12,
      startedAt: '2026-08-10T10:00:00.000Z',
      lastActiveAt: '2026-08-10T12:00:00.000Z',
      project: externalImportProject('__local__'),
    });
    expect(record?.host).toBeUndefined(); // local stores no host sentinel
    expect(record?.human_note).toContain('outside Walnut');
  });

  it('groups each host under its own project and persists the remote host', async () => {
    configHosts = { buildbox: { hostname: 'cloud.example' } };
    setHost('__local__', { candidates: [candidate({ sessionId: 'local-1' })] });
    setHost('buildbox', { candidates: [candidate({ sessionId: 'remote-1' })] });

    const result = await importExternalSessions();
    expect(result.imported).toBe(2);
    expect((await taskForSession('local-1')).project).toBe('Imported from this Mac');
    expect((await taskForSession('remote-1')).project).toBe('Imported from buildbox');
    expect((await getSessionByClaudeId('remote-1'))?.host).toBe('buildbox');
  });

  it('creates the project registry row as local so no sync provider can claim it', async () => {
    setHost('__local__', { candidates: [candidate()] });
    await importExternalSessions();
    const projects = await getStoreProjects();
    const key = Object.keys(projects).find(
      (k) => k.toLowerCase() === externalImportProject('__local__').toLowerCase());
    expect(key).toBeTruthy();
    expect(projects[key!].source).toBe('local');
  });

  it('never re-imports a session that already has its task', async () => {
    const host = setHost('__local__', { candidates: [candidate({ sessionId: 'dup' })] });
    await importExternalSessions();
    const second = await importExternalSessions();
    expect(second.imported).toBe(0);
    expect(second.skipped).toBe(1);
    // The now-known id is passed down so the daemon never parses it again.
    expect(host.calls[1].knownSessionIds).toContain('dup');
    // Still exactly one task for it.
    expect((await queryTasks({ tagsAll: ['walnut:external-sessions'] }))).toHaveLength(1);
  });

  it('untitled sessions fall back to an engine-labeled name', async () => {
    setHost('__local__', {
      candidates: [
        candidate({ sessionId: 'nt-claude', title: undefined }),
        candidate({ sessionId: 'nt-codex', title: undefined, engine: 'codex' }),
      ],
    });
    await importExternalSessions();
    expect((await taskForSession('nt-claude')).title).toContain('Claude session');
    expect((await taskForSession('nt-codex')).title).toContain('Codex session');
  });

  it('skips hosts whose daemon lacks the capability', async () => {
    setHost('__local__', { capabilities: ['changes-v1'], candidates: [candidate()] });
    const result = await importExternalSessions();
    expect(result.imported).toBe(0);
    expect(result.hostsScanned).toEqual([]);
    expect(result.hostsSkipped).toContain('__local__');
  });

  it('skips a disabled config host', async () => {
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

  it('does not leave an orphan task when the session id races in mid-import', async () => {
    setHost('__local__', { candidates: [candidate({ sessionId: 'race-1' })] });
    // Pre-claim the session id AFTER the scan would have run: simulate by
    // seeding the record now — importCandidate re-checks and then
    // importSessionRecord throws, and the freshly-minted task must be removed.
    const { task: preTask } = await addTask({
      title: 'pre-existing owner', project: '', source: 'local', _skipPluginOps: true,
    });
    await importSessionRecord({
      claudeSessionId: 'race-1', taskId: preTask.id, project: '',
    });

    const result = await importExternalSessions();
    expect(result.imported).toBe(0);
    // No import-tagged task minted for the raced id.
    expect(await queryTasks({ tagsAll: ['walnut:external-sessions'] })).toHaveLength(0);
  });

  it('forwards the requested window to the daemon', async () => {
    const host = setHost('__local__', { candidates: [] });
    await importExternalSessions({ windowMs: 7 * 24 * 60 * 60 * 1000 });
    expect(host.calls[0].sinceMs).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

describe('importExternalSessions — fallback-name re-title', () => {
  it('re-imports a task stuck with the fallback name once the scan yields a title', async () => {
    // Seed what the buggy scanner produced: fallback-named task, no title.
    setHost('__local__', { candidates: [candidate({ sessionId: 'deadbeef-1111', title: undefined })] });
    await importExternalSessions();
    const before = await taskForSession('deadbeef-1111');
    expect(before.title).toBe('Claude session deadbeef');

    // Fixed scanner now returns the real title for the same session.
    setHost('__local__', { candidates: [candidate({ sessionId: 'deadbeef-1111', title: 'Investigate ticket 12345' })] });
    const result = await importExternalSessions();
    expect(result.imported).toBe(1);
    const after = await taskForSession('deadbeef-1111');
    expect(after.title).toBe('Investigate ticket 12345');
    expect(after.id).not.toBe(before.id);
    // Exactly one task remains for the session.
    expect(await queryTasks({ tagsAll: ['walnut:external-sessions'] })).toHaveLength(1);
  });

  it('does not loop on a transcript that truly has no title', async () => {
    const host = setHost('__local__', { candidates: [candidate({ sessionId: 'cafebabe-2222', title: undefined })] });
    await importExternalSessions();
    const first = await taskForSession('cafebabe-2222');
    expect(first.title).toBe('Claude session cafebabe');

    // Next tick still yields no title: the task must survive untouched. The id
    // is deliberately left OUT of knownSessionIds so the daemon keeps offering
    // it — the upgrade happens the tick its transcript finally has a title.
    const second = await importExternalSessions();
    expect(second.imported).toBe(0);
    expect((await taskForSession('cafebabe-2222')).id).toBe(first.id);
    expect(host.calls[1].knownSessionIds).not.toContain('cafebabe-2222');
  });

  it('never touches a user-renamed task that merely looks fallback-ish', async () => {
    // A task the user created themselves with a similar name but no import tag.
    await addTask({ title: 'Claude session 12345678', project: '', source: 'local', _skipPluginOps: true });
    setHost('__local__', { candidates: [] });
    await importExternalSessions();
    expect((await queryTasks({}))).toHaveLength(1);
  });
});

describe('importExternalSessions — v1 bucket migration', () => {
  /** Seed a v1-shape bucket: one task holding N sessions in session_ids history. */
  async function seedLegacyBucket(host: string, sessionIds: string[]) {
    const hostTag = `walnut:host:${host}`;
    const { task } = await addTask({
      title: host === '__local__'
        ? 'Sessions opened outside Walnut (this Mac)'
        : `Sessions opened outside Walnut (${host})`,
      project: 'Imported Sessions',
      source: 'local',
      priority: 'none',
      tags: ['walnut:external-sessions', hostTag],
      _skipPluginOps: true,
    });
    for (const sid of sessionIds) {
      await importSessionRecord({
        claudeSessionId: sid, taskId: task.id, project: 'Imported Sessions',
        title: `old ${sid}`, startedAt: '2026-08-01T00:00:00.000Z',
        lastActiveAt: '2026-08-01T01:00:00.000Z', messageCount: 3,
      });
      await addSessionToHistory(task.id, sid);
    }
    return task;
  }

  it('replaces a v1 bucket with per-session tasks via re-import', async () => {
    await seedLegacyBucket('__local__', ['v1-a', 'v1-b']);
    // The daemon scan re-offers those sessions (their transcripts still exist).
    setHost('__local__', {
      candidates: [
        candidate({ sessionId: 'v1-a', title: 'Real title A' }),
        candidate({ sessionId: 'v1-b', title: 'Real title B' }),
      ],
    });

    const result = await importExternalSessions();
    expect(result.cleanedLegacyBuckets).toBe(1);
    expect(result.imported).toBe(2);

    // The bucket and the v1 project are gone…
    const holders = await queryTasks({ tagsAll: ['walnut:external-sessions'] });
    expect(holders.map((t) => t.title).sort()).toEqual(['Real title A', 'Real title B']);
    const projects = await getStoreProjects();
    expect(Object.keys(projects).find((k) => k === 'Imported Sessions')).toBeUndefined();
    // …and each session now owns a task with the transcript's title.
    expect((await taskForSession('v1-a')).title).toBe('Real title A');
    expect((await taskForSession('v1-b')).project).toBe(externalImportProject('__local__'));
  });

  it('keeps the v1 project alive when the user filed their own tasks in it', async () => {
    await seedLegacyBucket('__local__', ['v1-x']);
    await addTask({
      title: 'my own note', project: 'Imported Sessions', source: 'local', _skipPluginOps: true,
    });
    setHost('__local__', { candidates: [candidate({ sessionId: 'v1-x', title: 'Back' })] });

    await importExternalSessions();
    const projects = await getStoreProjects();
    expect(Object.keys(projects)).toContain('Imported Sessions');
  });

  it('cleanup is a no-op once buckets are gone', async () => {
    setHost('__local__', { candidates: [] });
    const result = await importExternalSessions();
    expect(result.cleanedLegacyBuckets).toBe(0);
    expect(result.imported).toBe(0);
  });
});
