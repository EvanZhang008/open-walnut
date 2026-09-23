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
  /** Answer to sessions.describeExternal (by-id re-read), keyed by session id. */
  described?: Record<string, unknown>;
  /** Answer to an activityOnly describe: session id → transcript mtime (ISO).
   *  An id absent here is "no transcript on this host". */
  activity?: Record<string, string>;
  activityCalls: string[][];
  truncated?: boolean;
  /** Set to make the RPC reject, exercising the per-host failure path. */
  fail?: boolean;
  calls: Array<Record<string, unknown>>;
  describeCalls: string[][];
}
const hosts = new Map<string, FakeHost>();

vi.mock('../../src/providers/daemon-connection.js', () => ({
  getConnectedDaemonConnection: (hostKey: string) => {
    const entry = hosts.get(hostKey);
    if (!entry) return null;
    return {
      hasCapability: (cap: string) => entry.capabilities.includes(cap),
      send: async (cmd: string, params: Record<string, unknown>) => {
        if (entry.fail) throw new Error('ssh exploded');
        if (cmd === 'sessions.describeExternal') {
          const ids = params.sessionIds as string[];
          if (params.activityOnly === true) {
            entry.activityCalls.push(ids);
            return {
              ok: true, candidates: [],
              activity: ids.filter((id) => entry.activity?.[id]).map((id) => ({ sessionId: id, lastActiveAt: entry.activity![id] })),
            };
          }
          entry.describeCalls.push(ids);
          return { ok: true, candidates: ids.map((id) => entry.described?.[id]).filter(Boolean), activity: [] };
        }
        entry.calls.push(params);
        return { ok: true, candidates: entry.candidates, truncated: entry.truncated === true };
      },
    };
  },
}));

let configHosts: Record<string, { hostname: string; enabled?: boolean }> = {};
let excludedCwds: Record<string, string[]> = {};
/** Idle window in days; undefined = the production default (7). The import-shape
 *  tests seed sessions last active on 2026-08-10 and run on the real clock, so
 *  they switch the sweep off (0) to keep the two behaviours separately pinned. */
let autoCompleteDays: number | undefined = 0;
vi.mock('../../src/core/config-manager.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getConfig: async () => ({
      hosts: configHosts, defaults: {},
      external_session_import: { excluded_cwds: excludedCwds, auto_complete_after_days: autoCompleteDays },
    }),
  };
});

import {
  importExternalSessions,
  externalImportProject,
  adoptImportedTask,
  importFolderLabel,
  isStaleImportTitle,
} from '../../src/core/sessions/external-session-import.js';
import { EXTERNAL_SESSION_IMPORT_TAG } from '../../src/core/types.js';
import {
  getSessionByClaudeId,
  importSessionRecord,
  _resetSessionTrackerForTesting,
} from '../../src/core/session-tracker.js';
import {
  getTask,
  queryTasks,
  addTask,
  updateTask,
  updateTaskRaw,
  addSessionToHistory,
  getStoreProjects,
  listGroups,
  _resetForTesting as _resetTaskManager,
} from '../../src/core/task-manager.js';
import { closeDb as closeSessionDb } from '../../src/core/session-db.js';
import { closeDb as closeTaskDb } from '../../src/core/task-db.js';
import { bus, EventNames } from '../../src/core/event-bus.js';
import { log } from '../../src/logging/index.js';
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
    capabilities: ['external-scan-v1', 'external-scan-filter-v1', 'external-describe-v1'],
    candidates: [], calls: [], describeCalls: [], activityCalls: [], ...over,
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
  excludedCwds = {};
  autoCompleteDays = 0;
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
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
    expect(t1.pinned).not.toBe(true);
    expect(t2.pinned).not.toBe(true);
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
    // A terminal session the user ran themselves wakes up ASKING. Bypass is now
    // an option on importSessionRecord (an adopted ✦ search already ran
    // unattended, so continuing it must not prompt) — this pins that the option
    // stays opt-in: resuming someone's own session must not silently hand it
    // more than it had at their prompt.
    expect(record?.mode).toBe('default');
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

  it('applies exclusions by host and rechecks daemon candidates before creating tasks', async () => {
    excludedCwds = { __local__: ['/Users/dev/probes'] };
    configHosts = { buildbox: { hostname: 'build.example' } };
    const local = setHost('__local__', { candidates: [
      candidate({ sessionId: 'probe', cwd: '/Users/dev/probes/run' }),
      candidate({ sessionId: 'real', cwd: '/Users/dev/probes-app' }),
    ] });
    setHost('buildbox', { candidates: [candidate({ sessionId: 'remote', cwd: '/Users/dev/probes/run' })] });
    const result = await importExternalSessions();
    expect(result.imported).toBe(2);
    expect(await getSessionByClaudeId('probe')).toBeNull();
    expect(await getSessionByClaudeId('remote')).not.toBeNull();
    expect(local.calls[0].excludedCwds).toEqual(['/Users/dev/probes']);
    excludedCwds = {};
    expect((await importExternalSessions()).imported).toBe(1);
  });

  it('does not scan an old daemon that cannot apply configured exclusions before its limit', async () => {
    excludedCwds = { __local__: ['/Users/dev/probes'] };
    const host = setHost('__local__', { capabilities: ['external-scan-v1'], candidates: [candidate()] });
    const info = vi.spyOn(log.session, 'info');
    const result = await importExternalSessions();
    expect(info).toHaveBeenCalledWith('external session scan requires daemon filter capability', { host: '__local__' });
    expect(result.hostsSkipped).toContain('__local__');
    expect(host.calls).toHaveLength(0);
    expect(result.imported).toBe(0);
  });

  it('serializes concurrent imports and does not duplicate tasks', async () => {
    setHost('__local__', { candidates: [candidate({ sessionId: 'same' })] });
    const results = await Promise.all([importExternalSessions(), importExternalSessions()]);
    expect(results.reduce((n, result) => n + result.imported, 0)).toBe(1);
    expect(await queryTasks({ tagsAll: ['walnut:external-sessions'] })).toHaveLength(1);
  });

  it('forwards the requested window to the daemon', async () => {
    const host = setHost('__local__', { candidates: [] });
    await importExternalSessions({ windowMs: 7 * 24 * 60 * 60 * 1000 });
    expect(host.calls[0].sinceMs).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

describe('importExternalSessions — fallback-name re-title', () => {
  it('retitles in place without losing task identity or session timestamps', async () => {
    // Seed what the buggy scanner produced: fallback-named task, no title.
    setHost('__local__', { candidates: [candidate({ sessionId: 'deadbeef-1111', title: undefined })] });
    await importExternalSessions();
    const before = await taskForSession('deadbeef-1111');
    expect(before.title).toBe('Claude session deadbeef');

    // Fixed scanner now returns the real title for the same session.
    setHost('__local__', { candidates: [candidate({ sessionId: 'deadbeef-1111', title: 'Investigate ticket 12345' })] });
    const result = await importExternalSessions();
    expect(result.imported).toBe(0);
    expect(result.retitled).toBe(1);
    const after = await taskForSession('deadbeef-1111');
    expect(after.title).toBe('Investigate ticket 12345');
    expect(after.id).toBe(before.id);
    expect(after.created_at).toBe(before.created_at);
    expect((await getSessionByClaudeId('deadbeef-1111'))).toMatchObject({
      title: 'Investigate ticket 12345',
      startedAt: '2026-08-10T10:00:00.000Z',
      lastActiveAt: '2026-08-10T12:00:00.000Z',
    });
    // Exactly one task remains for the session.
    expect(await queryTasks({ tagsAll: ['walnut:external-sessions'] })).toHaveLength(1);
  });

  it('preserves filing, completion, notes, pins and historical sessions when a title arrives late', async () => {
    setHost('__local__', { candidates: [candidate({ sessionId: 'deadbeef-1111', title: undefined })] });
    await importExternalSessions();
    const original = await taskForSession('deadbeef-1111');
    await updateTask(original.id, { project: 'Actual work', phase: 'COMPLETE' }, { source: 'api' });
    await updateTaskRaw(original.id, { note: 'Keep my notes', pinned: true, group_id: 'my-folder' });
    const before = await getTask(original.id);
    const sessionBefore = await getSessionByClaudeId('deadbeef-1111');
    const host = setHost('__local__', { candidates: [candidate({ sessionId: 'deadbeef-1111', title: 'Real work' })] });
    const emit = vi.spyOn(bus, 'emit');
    const info = vi.spyOn(log.session, 'info');
    expect((await importExternalSessions()).retitled).toBe(1);
    expect(emit.mock.calls.some(([event]) => event === EventNames.TASK_COMPLETED)).toBe(false);
    expect(emit).toHaveBeenCalledWith(EventNames.TASK_UPDATED, expect.objectContaining({ task: expect.objectContaining({ id: original.id }) }), ['web-ui'], { source: 'external-session-import' });
    expect(info).toHaveBeenCalledWith('imported external sessions', expect.objectContaining({ imported: 0, retitled: 1 }));
    const after = await getTask(original.id);
    expect(after).toEqual({ ...before, title: 'Real work' });
    expect(host.calls[0].knownSessionIds).not.toContain('deadbeef-1111');
    expect(await getSessionByClaudeId('deadbeef-1111')).toEqual({ ...sessionBefore, title: 'Real work' });
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

  it('does not overwrite a human title applied before a delayed write acquires the task lock', async () => {
    const { task } = await addTask({ title: 'Claude session deadbeef', source: 'local', _skipPluginOps: true });
    await updateTaskRaw(task.id, { title: 'My chosen title' });
    const result = await updateTaskRaw(task.id, { title: 'Late scanner title' }, {
      shouldUpdate: current => current.title === 'Claude session deadbeef',
    });
    expect(result.changed).toBe(false);
    expect((await getTask(task.id)).title).toBe('My chosen title');
  });

  it.each(['Scanner title', undefined])('uses the human session title and stops rescanning (scanner title: %s)', async (title) => {
    setHost('__local__', { candidates: [candidate({ sessionId: 'deadbeef-1111', title: undefined })] });
    await importExternalSessions();
    const { updateSessionRecord } = await import('../../src/core/session-tracker.js');
    await updateSessionRecord('deadbeef-1111', { title: 'My session title' });
    const before = await taskForSession('deadbeef-1111');
    const sessionBefore = await getSessionByClaudeId('deadbeef-1111');
    const host = setHost('__local__', { candidates: [candidate({ sessionId: 'deadbeef-1111', title })] });
    expect((await importExternalSessions()).retitled).toBe(1);
    expect(await taskForSession('deadbeef-1111')).toEqual({ ...before, title: 'My session title' });
    expect(await getSessionByClaudeId('deadbeef-1111')).toEqual(sessionBefore);
    expect((await importExternalSessions()).retitled).toBe(0);
    expect(host.calls[1].knownSessionIds).toContain('deadbeef-1111');
  });

  it('recovers after the task write fails without rebuilding the session', async () => {
    setHost('__local__', { candidates: [candidate({ sessionId: 'deadbeef-1111', title: undefined })] });
    await importExternalSessions();
    const before = await taskForSession('deadbeef-1111');
    const trackerBefore = await getSessionByClaudeId('deadbeef-1111');
    const tasks = await import('../../src/core/task-manager.js');
    vi.spyOn(tasks, 'updateTaskRaw').mockRejectedValueOnce(new Error('Injected task write failure'));
    setHost('__local__', { candidates: [candidate({ sessionId: 'deadbeef-1111', title: 'Recovered title' })] });
    expect(await importExternalSessions()).toMatchObject({ imported: 0, retitled: 0, skipped: 1 });
    expect(await taskForSession('deadbeef-1111')).toEqual(before);
    expect(await getSessionByClaudeId('deadbeef-1111')).toEqual({ ...trackerBefore, title: 'Recovered title' });
    expect((await importExternalSessions()).retitled).toBe(1);
    expect(await taskForSession('deadbeef-1111')).toEqual({ ...before, title: 'Recovered title' });
  });

  it('preserves a task renamed between the session write and the task write', async () => {
    setHost('__local__', { candidates: [candidate({ sessionId: 'deadbeef-1111', title: undefined })] });
    await importExternalSessions();
    const before = await taskForSession('deadbeef-1111');
    const tracker = await import('../../src/core/session-tracker.js');
    const writeSession = tracker.updateSessionRecordConditionally;
    vi.spyOn(tracker, 'updateSessionRecordConditionally').mockImplementationOnce(async (...args) => {
      const session = await writeSession(...args);
      await updateTaskRaw(before.id, { title: 'Human task title' });
      return session;
    });
    const host = setHost('__local__', { candidates: [candidate({ sessionId: 'deadbeef-1111', title: 'Scanner title' })] });
    expect((await importExternalSessions()).retitled).toBe(0);
    expect(await taskForSession('deadbeef-1111')).toEqual({ ...before, title: 'Human task title' });
    expect((await importExternalSessions()).retitled).toBe(0);
    expect(host.calls[1].knownSessionIds).toContain('deadbeef-1111');
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

  it('preserves legacy buckets on excluded hosts so filtering cannot erase their history', async () => {
    const bucket = await seedLegacyBucket('buildbox', ['v1-hidden']);
    const before = await getTask(bucket.id);
    const sessionBefore = await getSessionByClaudeId('v1-hidden');
    excludedCwds = { buildbox: ['/Users/dev/probes'] };
    setHost('__local__', { candidates: [candidate({ sessionId: 'local-new' })] });

    const result = await importExternalSessions();
    expect(result.cleanedLegacyBuckets).toBe(0);
    expect(result.imported).toBe(1);
    expect(await getTask(bucket.id)).toEqual(before);
    expect(await getSessionByClaudeId('v1-hidden')).toEqual(sessionBefore);
    expect(Object.keys(await getStoreProjects())).toContain('Imported Sessions');
  });

  it('cleanup is a no-op once buckets are gone', async () => {
    setHost('__local__', { candidates: [] });
    const result = await importExternalSessions();
    expect(result.cleanedLegacyBuckets).toBe(0);
    expect(result.imported).toBe(0);
  });
});

// ── Imported type lifecycle: idle sweep + adoption ────────────────────────

const TAG = EXTERNAL_SESSION_IMPORT_TAG;
/** candidate()'s lastActiveAt. */
const AUG10 = Date.parse('2026-08-10T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

describe('importExternalSessions — idle auto-complete (rolling window)', () => {
  beforeEach(() => { autoCompleteDays = undefined; }); // production default: 7 days

  it('completes an import already idle past the window in the same tick, and leaves a fresh one TODO', async () => {
    setHost('__local__', {
      candidates: [
        candidate({ sessionId: 'old-1' }),
        candidate({ sessionId: 'new-1', lastActiveAt: new Date(AUG10 + 6 * DAY).toISOString() }),
      ],
    });
    const now = AUG10 + 8 * DAY;
    const result = await importExternalSessions({ now });
    expect(result).toMatchObject({ imported: 2, completed: 1 });

    const old = await taskForSession('old-1');
    expect(old.phase).toBe('COMPLETE');
    expect(old.status).toBe('done');
    expect(old.completed_at).toBe(new Date(now).toISOString());
    // Mirrors applyPhase('COMPLETE'): no session slot; the association survives.
    expect(old.session_id).toBeUndefined();
    expect((await getSessionByClaudeId('old-1'))?.taskId).toBe(old.id);
    // Still the imported TYPE: the pill stays, adoption is still possible.
    expect(old.tags).toContain(TAG);

    const fresh = await taskForSession('new-1');
    expect(fresh.phase).toBe('TODO');
    expect(fresh.session_id).toBe('new-1');
  });

  it('is rolling: the task is completed on the tick it crosses the line, not before, and only once', async () => {
    setHost('__local__', { candidates: [candidate({ sessionId: 'roll-1' })] });
    expect((await importExternalSessions({ now: AUG10 + 6 * DAY })).completed).toBe(0);
    expect((await taskForSession('roll-1')).phase).toBe('TODO');

    setHost('__local__', { candidates: [] });
    expect((await importExternalSessions({ now: AUG10 + 7 * DAY - 1 })).completed).toBe(0);
    expect((await importExternalSessions({ now: AUG10 + 7 * DAY })).completed).toBe(1);
    expect((await taskForSession('roll-1')).phase).toBe('COMPLETE');
    expect((await importExternalSessions({ now: AUG10 + 30 * DAY })).completed).toBe(0);
  });

  it('honours the configured window; 0 disables the sweep', async () => {
    autoCompleteDays = 2;
    setHost('__local__', { candidates: [candidate({ sessionId: 'cfg-1' })] });
    expect((await importExternalSessions({ now: AUG10 + 2 * DAY })).completed).toBe(1);

    autoCompleteDays = 0;
    setHost('__local__', { candidates: [candidate({ sessionId: 'cfg-2' })] });
    expect((await importExternalSessions({ now: AUG10 + 400 * DAY })).completed).toBe(0);
    expect((await taskForSession('cfg-2')).phase).toBe('TODO');
  });

  it('completes nothing without evidence from the host, then catches up once it answers', async () => {
    setHost('__local__', { candidates: [candidate({ sessionId: 'nohost-1' })] });
    await importExternalSessions({ now: AUG10 });
    hosts.clear();
    expect((await importExternalSessions({ now: AUG10 + 8 * DAY })).completed).toBe(0);
    expect((await taskForSession('nohost-1')).phase).toBe('TODO');

    // An old daemon without the describe capability is no evidence either.
    setHost('__local__', { capabilities: ['external-scan-v1', 'external-scan-filter-v1'], candidates: [] });
    expect((await importExternalSessions({ now: AUG10 + 8 * DAY })).completed).toBe(0);

    const host = setHost('__local__', { candidates: [] });
    const emit = vi.spyOn(bus, 'emit');
    expect((await importExternalSessions({ now: AUG10 + 8 * DAY })).completed).toBe(1);
    expect(host.activityCalls).toEqual([['nohost-1']]);
    // Rows are written silently; ONE coarse refresh tells the web to refetch.
    expect(emit.mock.calls.filter(([event]) => event === EventNames.TASK_COMPLETED)).toHaveLength(0);
    expect(emit).toHaveBeenCalledWith(EventNames.TASK_UPDATED, {}, [], { source: 'external-session-import' });
  });

  it('keeps a session someone still uses in a terminal open, and refreshes its recorded clock', async () => {
    setHost('__local__', { candidates: [candidate({ sessionId: 'live-1' })] });
    await importExternalSessions({ now: AUG10 });
    // Ten days later the transcript was written yesterday: the user is still in it.
    const yesterday = new Date(AUG10 + 9 * DAY).toISOString();
    setHost('__local__', { candidates: [], activity: { 'live-1': yesterday } });
    expect((await importExternalSessions({ now: AUG10 + 10 * DAY })).completed).toBe(0);
    expect((await taskForSession('live-1')).phase).toBe('TODO');
    expect((await getSessionByClaudeId('live-1'))?.lastActiveAt).toBe(yesterday);

    // Once it really goes quiet for a week past that, it is completed.
    const host = setHost('__local__', { candidates: [], activity: { 'live-1': yesterday } });
    expect((await importExternalSessions({ now: AUG10 + 15 * DAY })).completed).toBe(0);
    expect(host.activityCalls).toEqual([]); // the refreshed record says not due: no RPC
    expect((await importExternalSessions({ now: AUG10 + 16 * DAY })).completed).toBe(1);
  });

  it('never completes an import the user filed into a project of their own', async () => {
    setHost('__local__', { candidates: [candidate({ sessionId: 'moved-1' })] });
    await importExternalSessions({ now: AUG10 });
    const task = await taskForSession('moved-1');
    await updateTask(task.id, { project: 'My real work' }, { source: 'api' });
    setHost('__local__', { candidates: [] });
    expect((await importExternalSessions({ now: AUG10 + 365 * DAY })).completed).toBe(0);
    expect((await getTask(task.id)).phase).toBe('TODO');
  });

  it('never completes a task the importer does not own, even inside the import project', async () => {
    await addTask({ title: 'My own todo', project: externalImportProject('__local__'), source: 'local', _skipPluginOps: true });
    setHost('__local__', { candidates: [] });
    expect((await importExternalSessions({ now: Date.now() + 365 * DAY })).completed).toBe(0);
    expect((await queryTasks({}))[0].phase).toBe('TODO');
  });

  it('retires the longest-idle rows first when a run is capped, and finishes next tick', async () => {
    setHost('__local__', {
      candidates: [
        candidate({ sessionId: 'cap-newer', lastActiveAt: new Date(AUG10 + 1 * DAY).toISOString() }),
        candidate({ sessionId: 'cap-oldest', lastActiveAt: new Date(AUG10 - 5 * DAY).toISOString() }),
        candidate({ sessionId: 'cap-mid' }),
      ],
    });
    const now = AUG10 + 30 * DAY;
    expect((await importExternalSessions({ now, limits: { sweep: 2 } })).completed).toBe(2);
    expect((await taskForSession('cap-oldest')).phase).toBe('COMPLETE');
    expect((await taskForSession('cap-mid')).phase).toBe('COMPLETE');
    expect((await taskForSession('cap-newer')).phase).toBe('TODO');
    setHost('__local__', { candidates: [] });
    expect((await importExternalSessions({ now, limits: { sweep: 2 } })).completed).toBe(1);
    expect((await taskForSession('cap-newer')).phase).toBe('COMPLETE');
  });
});

describe('adoptImportedTask — a message into the session ends the imported type', () => {
  beforeEach(() => { autoCompleteDays = undefined; });

  it('removes the tag, announces the task, is idempotent, and the task is never swept afterwards', async () => {
    setHost('__local__', { candidates: [candidate({ sessionId: 'adopt-1' })] });
    await importExternalSessions({ now: AUG10 });
    const task = await taskForSession('adopt-1');
    expect(task.tags).toContain(TAG);

    const emit = vi.spyOn(bus, 'emit');
    expect(await adoptImportedTask(task.id, 'test')).toBe(true);
    const adopted = await getTask(task.id);
    expect(adopted.tags ?? []).not.toContain(TAG);
    // Project and folder are kept: adoption changes the type, not the filing.
    expect(adopted.project).toBe(task.project);
    expect(adopted.group_id).toBe(task.group_id);
    expect(emit).toHaveBeenCalledWith(
      EventNames.TASK_UPDATED,
      expect.objectContaining({ task: expect.objectContaining({ id: task.id }) }),
      expect.anything(), expect.objectContaining({ source: 'external-session-import' }),
    );
    expect(await adoptImportedTask(task.id, 'test')).toBe(false);

    setHost('__local__', { candidates: [] });
    expect((await importExternalSessions({ now: AUG10 + 365 * DAY })).completed).toBe(0);
    expect((await getTask(task.id)).phase).toBe('TODO');
  });

  it('is a no-op for a task the importer never owned', async () => {
    const { task } = await addTask({ title: 'Mine', source: 'local', tags: ['mine'], _skipPluginOps: true });
    const emit = vi.spyOn(bus, 'emit');
    expect(await adoptImportedTask(task.id, 'test')).toBe(false);
    expect(await adoptImportedTask('no-such-task', 'test')).toBe(false);
    expect((await getTask(task.id)).tags).toEqual(['mine']);
    expect(emit).not.toHaveBeenCalled();
  });
});

// ── Placeholder titles: compaction summaries are replaced like fallbacks ───

const COMPACT_TITLE = 'This session is being continued from a previous conversation that ran out of context. The conversation is summarized below:';

describe('importExternalSessions — compaction-summary titles', () => {
  it('classifies placeholders', () => {
    expect(isStaleImportTitle('Claude session deadbeef')).toBe(true);
    expect(isStaleImportTitle(COMPACT_TITLE)).toBe(true);
    expect(isStaleImportTitle('<walnut-cache-warmup>This is a cache warm-up')).toBe(true);
    expect(isStaleImportTitle('<system-reminder>ctx</system-reminder>')).toBe(true);
    expect(isStaleImportTitle('[Request interrupted by user]')).toBe(true);
    expect(isStaleImportTitle('/deploy staging now')).toBe(false);
    expect(isStaleImportTitle('/model some-model[1m]')).toBe(true);
    expect(isStaleImportTitle('/modelling notes')).toBe(false);
    expect(isStaleImportTitle('! git status')).toBe(false);
    expect(isStaleImportTitle('Fix the flaky test')).toBe(false);
    expect(isStaleImportTitle('Claude session notahex!')).toBe(false);
  });

  it('never mints a task titled with a compaction summary, even if a daemon offers one', async () => {
    setHost('__local__', { candidates: [candidate({ sessionId: 'c0ffee01-mint', title: COMPACT_TITLE })] });
    await importExternalSessions();
    expect((await taskForSession('c0ffee01-mint')).title).toBe('Claude session c0ffee01');
  });

  it('renames a task the old scanner titled with a compaction summary once a real title arrives', async () => {
    // Seed the pre-fix state: task and session both carry the summary as title.
    setHost('__local__', { candidates: [candidate({ sessionId: 'c0ffee02-0001', title: 'placeholder' })] });
    await importExternalSessions();
    const task = await taskForSession('c0ffee02-0001');
    await updateTaskRaw(task.id, { title: COMPACT_TITLE });
    const { updateSessionRecord } = await import('../../src/core/session-tracker.js');
    await updateSessionRecord('c0ffee02-0001', { title: COMPACT_TITLE });

    // The fixed daemon re-reads the transcript and finds the human's message.
    const host = setHost('__local__', { candidates: [candidate({ sessionId: 'c0ffee02-0001', title: 'now fix the flaky test' })] });
    const result = await importExternalSessions();
    expect(host.calls[0].knownSessionIds).not.toContain('c0ffee02-0001');
    expect(result).toMatchObject({ imported: 0, retitled: 1 });
    expect((await getTask(task.id)).title).toBe('now fix the flaky test');
    expect((await getSessionByClaudeId('c0ffee02-0001'))?.title).toBe('now fix the flaky test');
    // Fixed: leaves the re-offer set.
    const again = setHost('__local__', { candidates: [] });
    await importExternalSessions();
    expect(again.calls[0].knownSessionIds).toContain('c0ffee02-0001');
  });

  it('renames a task an older scanner titled with a Walnut warm-up turn', async () => {
    setHost('__local__', { candidates: [candidate({ sessionId: 'c0ffee08-0008', title: 'placeholder' })] });
    await importExternalSessions();
    const task = await taskForSession('c0ffee08-0008');
    const warm = '<walnut-cache-warmup>This is a cache warm-up from Walnut.';
    await updateTaskRaw(task.id, { title: warm });
    const { updateSessionRecord } = await import('../../src/core/session-tracker.js');
    await updateSessionRecord('c0ffee08-0008', { title: warm });
    setHost('__local__', { candidates: [], described: { 'c0ffee08-0008': candidate({ sessionId: 'c0ffee08-0008', title: 'look at the failing build' }) } });
    expect((await importExternalSessions()).retitled).toBe(1);
    expect((await getTask(task.id)).title).toBe('look at the failing build');
  });

  it('never swaps one placeholder for another and keeps waiting for a real title', async () => {
    setHost('__local__', { candidates: [candidate({ sessionId: 'c0ffee03-0002', title: undefined })] });
    await importExternalSessions();
    const task = await taskForSession('c0ffee03-0002');
    await updateTaskRaw(task.id, { title: COMPACT_TITLE });
    const host = setHost('__local__', { candidates: [candidate({ sessionId: 'c0ffee03-0002', title: COMPACT_TITLE })] });
    expect((await importExternalSessions()).retitled).toBe(0);
    expect((await getTask(task.id)).title).toBe(COMPACT_TITLE);
    expect(host.calls[0].knownSessionIds).not.toContain('c0ffee03-0002');
  });
});

// ── cwd folders ───────────────────────────────────────────────────────────

describe('importFolderLabel', () => {
  it('collapses the known home and keeps the last two segments', () => {
    expect(importFolderLabel('/Users/me/workplace/myCode/walnut', '/Users/me')).toBe('myCode/walnut');
    expect(importFolderLabel('/Users/me/.claude', '/Users/me')).toBe('~/.claude');
    expect(importFolderLabel('/Users/me', '/Users/me')).toBe('~');
    expect(importFolderLabel('/Users/me/', '/Users/me/')).toBe('~');
  });
  it('recognises common home roots on a host whose home is unknown', () => {
    expect(importFolderLabel('/local/home/alice/.claude')).toBe('~/.claude');
    expect(importFolderLabel('/home/alice/src/app')).toBe('src/app');
    expect(importFolderLabel('/Users/bob')).toBe('~');
    expect(importFolderLabel('/local/home/alice')).toBe('~');
  });
  it('falls back to plain path segments elsewhere', () => {
    expect(importFolderLabel('/opt/x')).toBe('opt/x');
    expect(importFolderLabel('/srv')).toBe('srv');
    expect(importFolderLabel('/')).toBe('/');
    expect(importFolderLabel('/Usersx/bob/proj')).toBe('bob/proj');
  });
});

describe('importExternalSessions — one folder per working directory', () => {
  it('files imports into a folder per cwd under the host project, labelled by the cwd', async () => {
    setHost('__local__', {
      candidates: [
        candidate({ sessionId: 'f-1', cwd: '/Users/dev/proj' }),
        candidate({ sessionId: 'f-2', cwd: '/Users/dev/proj' }),
        candidate({ sessionId: 'f-3', cwd: '/Users/dev/other/thing' }),
        candidate({ sessionId: 'f-4', cwd: undefined }),
      ],
    });
    const emit = vi.spyOn(bus, 'emit');
    await importExternalSessions();
    const [a, b, c, d] = await Promise.all(['f-1', 'f-2', 'f-3', 'f-4'].map(taskForSession));
    expect(a.group_id).toBeTruthy();
    expect(b.group_id).toBe(a.group_id);
    expect(c.group_id).toBeTruthy();
    expect(c.group_id).not.toBe(a.group_id);
    expect(d.group_id).toBeUndefined(); // nothing to group by

    const groups = await listGroups();
    const fa = groups.find((g) => g.group_id === a.group_id);
    const fc = groups.find((g) => g.group_id === c.group_id);
    expect(fa).toMatchObject({ label: '~/proj', project: externalImportProject('__local__') });
    expect(fc).toMatchObject({ label: 'other/thing', project: externalImportProject('__local__') });
    // One folder event per folder created, none for the reuse.
    expect(emit.mock.calls.filter(([event]) => event === EventNames.TASK_GROUPS_CHANGED)).toHaveLength(2);
  });

  it('reuses the cwd folder on later ticks and keeps hosts apart', async () => {
    configHosts = { devbox: { hostname: 'devbox.local' } };
    setHost('__local__', { candidates: [candidate({ sessionId: 'r-1', cwd: '/Users/dev/proj' })] });
    setHost('devbox', { candidates: [candidate({ sessionId: 'r-2', cwd: '/Users/dev/proj' })] });
    await importExternalSessions();
    setHost('__local__', { candidates: [candidate({ sessionId: 'r-3', cwd: '/Users/dev/proj' })] });
    setHost('devbox', { candidates: [] });
    await importExternalSessions();
    const [r1, r2, r3] = await Promise.all(['r-1', 'r-2', 'r-3'].map(taskForSession));
    expect(r3.group_id).toBe(r1.group_id);
    expect(r2.group_id).not.toBe(r1.group_id);
    expect((await listGroups()).find((g) => g.group_id === r2.group_id)?.project).toBe(externalImportProject('devbox'));
  });

  it('backfills folders for imports that predate them, bounded per run', async () => {
    setHost('__local__', {
      candidates: [
        candidate({ sessionId: 'b-1', cwd: '/Users/dev/proj' }),
        candidate({ sessionId: 'b-2', cwd: '/Users/dev/proj' }),
        candidate({ sessionId: 'b-3', cwd: '/Users/dev/other' }),
      ],
    });
    await importExternalSessions();
    // Simulate an install from before cwd folders existed: members without a folder.
    const ids = await Promise.all(['b-1', 'b-2', 'b-3'].map(async (sid) => (await taskForSession(sid)).id));
    for (const id of ids) await updateTaskRaw(id, { group_id: null as unknown as undefined });
    for (const id of ids) expect((await getTask(id)).group_id).toBeUndefined();

    setHost('__local__', { candidates: [] });
    expect((await importExternalSessions({ limits: { folderBackfill: 2 } })).foldered).toBe(2);
    expect((await importExternalSessions({ limits: { folderBackfill: 2 } })).foldered).toBe(1);
    expect((await importExternalSessions()).foldered).toBe(0);
    const [b1, b2, b3] = await Promise.all(ids.map((id) => getTask(id)));
    expect(b1.group_id).toBeTruthy();
    expect(b2.group_id).toBe(b1.group_id);
    expect(b3.group_id).not.toBe(b1.group_id);
    expect((await listGroups()).find((g) => g.group_id === b1.group_id)?.label).toBe('~/proj');
  });

  it('leaves a user-filed import alone and never folders a task the importer does not own', async () => {
    setHost('__local__', { candidates: [candidate({ sessionId: 'u-1', cwd: '/Users/dev/proj' })] });
    await importExternalSessions();
    const imported = await taskForSession('u-1');
    await updateTaskRaw(imported.id, { group_id: 'users-own-folder' });
    const { task: mine } = await addTask({
      title: 'Mine', project: externalImportProject('__local__'), cwd: '/Users/dev/proj', source: 'local', _skipPluginOps: true,
    });
    setHost('__local__', { candidates: [] });
    expect((await importExternalSessions()).foldered).toBe(0);
    expect((await getTask(imported.id)).group_id).toBe('users-own-folder');
    expect((await getTask(mine.id)).group_id).toBeUndefined();
  });
});

describe('importExternalSessions — placeholder titles outside the scan window', () => {
  it('asks the host for the placeholder-titled ids the scan no longer offers and retitles from the answer', async () => {
    setHost('__local__', { candidates: [candidate({ sessionId: 'c0ffee04-0004', title: undefined })] });
    await importExternalSessions();
    const task = await taskForSession('c0ffee04-0004');
    expect(task.title).toBe('Claude session c0ffee04');

    // The file aged out of the window: the scan returns nothing, describe knows it.
    const host = setHost('__local__', {
      candidates: [],
      described: { 'c0ffee04-0004': candidate({ sessionId: 'c0ffee04-0004', title: 'Found by id' }) },
    });
    const result = await importExternalSessions();
    expect(host.describeCalls).toEqual([['c0ffee04-0004']]);
    expect(result).toMatchObject({ imported: 0, retitled: 1 });
    expect((await getTask(task.id)).title).toBe('Found by id');
    // Fixed: no longer asked for.
    await importExternalSessions();
    expect(host.describeCalls).toHaveLength(1);
  });

  it('does not ask twice for a session the scan already offered, and asks only the owning host', async () => {
    configHosts = { devbox: { hostname: 'devbox.local' } };
    setHost('__local__', { candidates: [candidate({ sessionId: 'c0ffee05-0005', title: undefined })] });
    setHost('devbox', { candidates: [candidate({ sessionId: 'c0ffee06-0006', title: undefined })] });
    await importExternalSessions();
    const local = setHost('__local__', { candidates: [candidate({ sessionId: 'c0ffee05-0005', title: undefined })] });
    const devbox = setHost('devbox', { candidates: [] });
    await importExternalSessions();
    expect(local.describeCalls).toEqual([]);
    expect(devbox.describeCalls).toEqual([['c0ffee06-0006']]);
  });

  it('keeps working against a daemon without the describe capability', async () => {
    setHost('__local__', { capabilities: ['external-scan-v1', 'external-scan-filter-v1'], candidates: [candidate({ sessionId: 'c0ffee07-0007', title: undefined })] });
    await importExternalSessions();
    const host = setHost('__local__', { capabilities: ['external-scan-v1', 'external-scan-filter-v1'], candidates: [] });
    expect((await importExternalSessions()).retitled).toBe(0);
    expect(host.describeCalls).toEqual([]);
    expect((await taskForSession('c0ffee07-0007')).title).toBe('Claude session c0ffee07');
  });
});

describe('adoptImportedTask — edge cases', () => {
  it('keeps a tag added by someone else and never re-announces a completed task as completed', async () => {
    setHost('__local__', { candidates: [candidate({ sessionId: 'adopt-2' })] });
    await importExternalSessions();
    const task = await taskForSession('adopt-2');
    await updateTask(task.id, { add_tags: ['mine'], phase: 'COMPLETE' }, { source: 'api' });
    const emit = vi.spyOn(bus, 'emit');
    expect(await adoptImportedTask(task.id, 'test')).toBe(true);
    const after = await getTask(task.id);
    expect(after.tags).toEqual(['mine']);
    expect(after.phase).toBe('COMPLETE');
    expect(emit.mock.calls.filter(([event]) => event === EventNames.TASK_COMPLETED)).toHaveLength(0);
  });
});

describe('importExternalSessions — folder identity outlives its imported members', () => {
  it('reuses the cwd folder after every member was adopted', async () => {
    setHost('__local__', { candidates: [candidate({ sessionId: 'fa-1', cwd: '/Users/dev/proj' })] });
    await importExternalSessions();
    const first = await taskForSession('fa-1');
    await adoptImportedTask(first.id, 'test');
    setHost('__local__', { candidates: [candidate({ sessionId: 'fa-2', cwd: '/Users/dev/proj' })] });
    await importExternalSessions();
    expect((await taskForSession('fa-2')).group_id).toBe(first.group_id);
    expect((await listGroups()).filter((g) => g.label === '~/proj')).toHaveLength(1);
  });

  it('reuses an emptied same-label folder instead of minting a twin, but never one holding another dir', async () => {
    setHost('__local__', { candidates: [candidate({ sessionId: 'fe-1', cwd: '/Users/dev/proj' })] });
    await importExternalSessions();
    const first = await taskForSession('fe-1');
    // Moving the only member to another project empties the folder (a move
    // always drops folder membership).
    await updateTask(first.id, { project: 'Elsewhere' }, { source: 'api' });
    expect((await getTask(first.id)).group_id).toBeUndefined();
    setHost('__local__', { candidates: [candidate({ sessionId: 'fe-2', cwd: '/Users/dev/proj' })] });
    await importExternalSessions();
    expect((await taskForSession('fe-2')).group_id).toBe(first.group_id);

    // A real label collision: two cwds whose last two segments match.
    setHost('__local__', {
      candidates: [
        candidate({ sessionId: 'fc-1', cwd: '/srv/a/team/app' }),
        candidate({ sessionId: 'fc-2', cwd: '/srv/b/team/app' }),
      ],
    });
    await importExternalSessions();
    const [c1, c2] = await Promise.all(['fc-1', 'fc-2'].map(taskForSession));
    expect(c1.group_id).not.toBe(c2.group_id);
    expect((await listGroups()).filter((g) => g.label === 'team/app')).toHaveLength(2);
  });

  it('removes a folder it minted for an import that lost the race', async () => {
    setHost('__local__', { candidates: [candidate({ sessionId: 'race-f', cwd: '/Users/dev/brand-new' })] });
    const tracker = await import('../../src/core/session-tracker.js');
    vi.spyOn(tracker, 'importSessionRecord').mockRejectedValueOnce(new Error('id raced in'));
    await importExternalSessions();
    expect((await listGroups()).filter((g) => g.label === '~/brand-new')).toHaveLength(0);
    // Next tick imports it normally, into a fresh folder.
    await importExternalSessions();
    expect((await taskForSession('race-f')).group_id).toBeTruthy();
    expect((await listGroups()).filter((g) => g.label === '~/brand-new')).toHaveLength(1);
  });
});

describe('importExternalSessions — placeholder re-read rotates', () => {
  it('asks the least recently asked ids first, so hopeless transcripts cannot starve the rest', async () => {
    const ids = ['c0ffee11-0001', 'c0ffee12-0002', 'c0ffee13-0003'];
    setHost('__local__', { candidates: ids.map((sessionId) => candidate({ sessionId, title: undefined })) });
    await importExternalSessions();
    const host = setHost('__local__', { candidates: [] });
    await importExternalSessions({ limits: { retitle: 2 } });
    await importExternalSessions({ limits: { retitle: 2 } });
    const asked = host.describeCalls.flat();
    expect(new Set(asked)).toEqual(new Set(ids));
    expect(host.describeCalls.every((call) => call.length <= 2)).toBe(true);
  });
});
