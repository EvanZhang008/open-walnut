/**
 * Where the external-session importer files a machine's sessions (2026-11-03: a machine
 * joined over the host network and its imports landed in a new "Imported from <machine>"
 * project with no VP, alone on the Org page, while the other import projects sat under the
 * user's Operations VP).
 *
 *   - One machine, one project: a row found in ~/.ssh/config that joinedTwins() names as a
 *     joined machine's is not scanned; the joined row is (src/core/hosts/joined-twins.ts).
 *     An import by id on that found row files under the joined row too, and the folders
 *     the user excluded on it stay out of the joined row's scan.
 *   - A new import project goes under the VP of the other import projects, only in the run
 *     that made it (src/core/sessions/import-project-vp.ts), so a project the user gives
 *     back its own VP stays where they put it. With none, under the Others VP, which a new
 *     install's first import makes (2026-11-12: a new install's import became its own VP). The vote reads the org outside its lock, so
 *     an org that changed before the move leaves the project where it is; a test run never
 *     places one.
 *
 * The daemon RPC is the only mock; the task store, session DB and org writes are real (the
 * org read is wrapped only to change the org right after the placement's vote read it).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-import-placement'));
vi.mock('../../src/utils/process.js', () => ({ isProcessAlive: () => true }));

interface FakeHost { candidates: unknown[]; described: Record<string, unknown>; calls: string[]; scanParams?: Record<string, unknown> }
const hosts = new Map<string, FakeHost>();

vi.mock('../../src/providers/daemon-connection.js', () => ({
  getConnectedDaemonConnection: (hostKey: string) => {
    const entry = hosts.get(hostKey);
    if (!entry) return null;
    return {
      hasCapability: (cap: string) => ['external-scan-v1', 'external-scan-filter-v1', 'external-describe-v1'].includes(cap),
      send: async (cmd: string, params: Record<string, unknown>) => {
        entry.calls.push(cmd);
        if (cmd === 'sessions.describeExternal') {
          const ids = params.sessionIds as string[];
          return { ok: true, candidates: ids.map((id) => entry.described[id]).filter(Boolean), activity: [] };
        }
        entry.scanParams = params;
        return { ok: true, candidates: entry.candidates, truncated: false };
      },
    };
  },
}));

// The org writes are the leader's: a replica's import never moves a project.
let serverRole: 'leader' | 'replica' = 'leader';
vi.mock('../../src/core/server-role.js', async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  role: () => serverRole,
}));

let configHosts: Record<string, Record<string, unknown>> = {};
let configNet: unknown;
let configExcluded: Record<string, string[]> = {};
vi.mock('../../src/core/config-manager.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getConfig: async () => ({
      hosts: configHosts, net: configNet, defaults: {},
      external_session_import: { excluded_cwds: configExcluded, auto_complete_after_days: 0 },
    }),
  };
});

/** Runs once right after the next org read from outside org-store (the placement's vote),
 *  which gets the org as it was before the change: the org moving between vote and move.
 *  `voteRead` says that read happened. */
let afterOrgRead: (() => Promise<void>) | undefined;
let voteRead = false;
vi.mock('../../src/core/org/org-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/org/org-store.js')>();
  return {
    ...actual,
    orgTasks: async () => {
      const hook = afterOrgRead;
      if (!hook) return actual.orgTasks();
      afterOrgRead = undefined;
      const before = structuredClone(await actual.orgTasks());
      await hook();
      voteRead = true;
      return before;
    },
  };
});

import {
  importExternalSessions, importSessionsById, externalImportProject,
  _resetImportAuditForTesting, _resetImportClaimsForTesting,
} from '../../src/core/sessions/external-session-import.js';
import { getSessionByClaudeId, _resetSessionTrackerForTesting } from '../../src/core/session-tracker.js';
import { addTask, completeTask, getTask, listTasks, queryTasks, _resetForTesting as _resetTaskManager } from '../../src/core/task-manager.js';
import { ensureProjectLead, getOrgTree, setProjectVp } from '../../src/core/org/org-store.js';
import { findProjectNode, projectKey } from '../../src/core/org/org-tree.js';
import { withTestRun } from '../../src/core/test-run.js';
import { OTHERS_VP_NAME, othersVp } from '../../src/core/sessions/import-project-vp.js';
import { createOrgNode, editOrgNode } from '../../src/core/org/org-node-edit.js';
import { closeDb as closeSessionDb } from '../../src/core/session-db.js';
import { closeDb as closeTaskDb } from '../../src/core/task-db.js';
import { bus } from '../../src/core/event-bus.js';
import { WALNUT_HOME } from '../../src/constants.js';

const MAC = 'a'.repeat(64);
const LOCAL = externalImportProject('__local__');
const DEVBOX = externalImportProject('devbox');
const STUDIO = externalImportProject('Studio-MacBook');

async function rmWalnutHome(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    try { await fsp.rm(WALNUT_HOME, { recursive: true, force: true }); return; }
    catch { await new Promise((r) => setTimeout(r, 50)); }
  }
}

function candidate(sessionId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId, engine: 'claude', cwd: '/Users/dev/proj', title: `Work in ${sessionId}`, origin: 'cli',
    startedAt: '2026-11-01T10:00:00.000Z', lastActiveAt: '2026-11-01T12:00:00.000Z', messageCount: 4,
    transcriptPath: `/Users/dev/.claude/projects/x/${sessionId}.jsonl`, ...over,
  };
}

function setHost(host: string, candidates: unknown[] = [], described: Record<string, unknown> = {}): FakeHost {
  const entry: FakeHost = { candidates, described, calls: [] };
  hosts.set(host, entry);
  return entry;
}

async function projectOf(sessionId: string): Promise<string | undefined> {
  const record = await getSessionByClaudeId(sessionId);
  return record?.taskId ? (await getTask(record.taskId)).project : undefined;
}

/** The project whose lead leads `project` on the Org page, '' when it is its own. */
async function vpOfProject(project: string): Promise<string | undefined> {
  return findProjectNode(await getOrgTree(), project)?.vp ?? '';
}

/** The leads whose own project is `project` (closed ones too). */
async function ownLeadsOf(project: string): Promise<string[]> {
  return (await listTasks()).filter((t) => t.org_role === 'lead' && projectKey(t.project) === projectKey(project)).map((t) => t.id);
}

/** This Mac's and devbox's imports, both put under the Operations VP by the user. */
async function seedImportsUnderOperations(): Promise<{ id: string }> {
  setHost('__local__', [candidate('local-1')]);
  setHost('devbox', [candidate('devbox-1')]);
  configHosts = { devbox: { hostname: 'dev.example.com', user: 'me', enabled: true } };
  await importExternalSessions();
  const ops = await ensureProjectLead('Operations');
  await setProjectVp(LOCAL, 'Operations');
  await setProjectVp(DEVBOX, 'Operations');
  expect(await vpOfProject(LOCAL)).toBe('Operations');
  expect(await vpOfProject(DEVBOX)).toBe('Operations');
  return ops;
}

/** studio-mac, found in ~/.ssh/config at a private address the joined Mac reported itself. */
function foundStudioTwin(): void {
  configHosts['studio-mac'] = { hostname: '10.20.30.40', user: 'sam', discovered: true, enabled: true };
  configNet = { enabled: true, where: { [MAC]: { addrs: ['10.20.30.40:62955'], self: ['10.20.30.40:62955'] } } };
}

/** Studio-MacBook joins over the host network (a `net` row), connected with these sessions. */
function joinStudio(sessionIds: string[]): FakeHost {
  configHosts['Studio-MacBook'] = {
    hostname: 'Studio-MacBook.walnut-net.invalid', label: 'Studio-MacBook', transport: 'net', endpoint: MAC, enabled: true,
  };
  return setHost('Studio-MacBook', sessionIds.map((id) => candidate(id)));
}

async function resetAll(): Promise<void> {
  closeSessionDb();
  closeTaskDb();
  _resetSessionTrackerForTesting();
  _resetTaskManager();
  _resetImportAuditForTesting();
  _resetImportClaimsForTesting();
  await rmWalnutHome();
}

beforeEach(async () => {
  await resetAll();
  hosts.clear();
  configHosts = {};
  configNet = undefined;
  configExcluded = {};
  afterOrgRead = undefined;
  voteRead = false;
  serverRole = 'leader';
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  bus.clear();
  await resetAll();
});

describe('one machine is scanned once', () => {
  it('a row found in ~/.ssh/config that is a joined machine is skipped; the joined row is scanned', async () => {
    // The same Mac twice: found at a private address it reported itself, and joined.
    configHosts = { devbox: { hostname: 'dev.example.com', user: 'me', discovered: true, enabled: true } };
    foundStudioTwin();
    const studio = joinStudio(['studio-1']);
    // Its SSH row has a warm daemon too, offering the very same session.
    const twin = setHost('studio-mac', [candidate('studio-1')]);
    setHost('devbox', [candidate('devbox-1')]);

    const result = await importExternalSessions();
    expect(result.hostsScanned.sort()).toEqual(['Studio-MacBook', 'devbox']);
    expect(result.hostsSkipped).toContain('studio-mac');
    expect(twin.calls).toEqual([]);
    expect(studio.calls).toContain('sessions.discoverExternal');
    expect(await projectOf('studio-1')).toBe(STUDIO);
    // A found row that is no joined machine is scanned as before.
    expect(await projectOf('devbox-1')).toBe(DEVBOX);
    expect(await queryTasks({ projects: [externalImportProject('studio-mac')] })).toEqual([]);
  });

  it('folders the user excluded on the found row stay out of the joined row\'s scan', async () => {
    foundStudioTwin();
    configExcluded = { 'studio-mac': ['/Users/sam/private'], 'Studio-MacBook': ['/Users/sam/tmp'] };
    const studio = joinStudio([]);
    studio.candidates = [candidate('studio-1', { cwd: '/Users/sam/private/notes' }), candidate('studio-2')];
    await importExternalSessions();
    expect(studio.scanParams?.excludedCwds).toEqual(['/Users/sam/tmp', '/Users/sam/private']);
    expect(await getSessionByClaudeId('studio-1')).toBeFalsy();
    expect(await projectOf('studio-2')).toBe(STUDIO);
  });

  it('an import by id on the found row files under the joined row', async () => {
    foundStudioTwin();
    joinStudio([]).described = { 'studio-9': candidate('studio-9') };
    const twin = setHost('studio-mac', [], { 'studio-9': candidate('studio-9') });
    expect((await importSessionsById('studio-mac', ['studio-9'])).imported).toEqual(['studio-9']);
    expect(await projectOf('studio-9')).toBe(STUDIO);
    expect((await getSessionByClaudeId('studio-9'))?.host).toBe('Studio-MacBook');
    expect(twin.calls).toEqual([]);
    expect(await queryTasks({ projects: [externalImportProject('studio-mac')] })).toEqual([]);
  });

  it('an import by id on the found row, with the joined row not connected, answers as an unconnected host', async () => {
    foundStudioTwin();
    joinStudio([]);
    hosts.delete('Studio-MacBook');
    const twin = setHost('studio-mac', [], { 'studio-9': candidate('studio-9') });
    await expect(importSessionsById('studio-mac', ['studio-9'])).rejects.toThrow(/Studio-MacBook .*not connected/);
    expect(twin.calls).toEqual([]);
    expect(await getSessionByClaudeId('studio-9')).toBeFalsy();
  });

  it('with no joined twin, a found row is scanned as before', async () => {
    configHosts = { 'studio-mac': { hostname: '10.20.30.40', user: 'sam', discovered: true, enabled: true } };
    setHost('studio-mac', [candidate('studio-1')]);
    const result = await importExternalSessions();
    expect(result.hostsScanned).toContain('studio-mac');
    expect(await projectOf('studio-1')).toBe(externalImportProject('studio-mac'));
  });
});

describe('a new import project goes under the VP of the other import projects', () => {
  it('a joined machine\'s first import lands under the Operations VP', async () => {
    const ops = await seedImportsUnderOperations();
    joinStudio(['studio-1']);
    await importExternalSessions();
    expect(await projectOf('studio-1')).toBe(STUDIO);
    expect(await vpOfProject(STUDIO)).toBe('Operations');
    expect((await getTask(ops.id)).org_leads).toEqual([LOCAL, DEVBOX, STUDIO]);
  });

  it('a project the user gave back its own VP is not moved again by a later import', async () => {
    const ops = await seedImportsUnderOperations();
    joinStudio(['studio-1']);
    await importExternalSessions();
    expect(await vpOfProject(STUDIO)).toBe('Operations');

    await setProjectVp(STUDIO, '');
    expect(await vpOfProject(STUDIO)).toBe('');
    hosts.get('Studio-MacBook')!.candidates = [candidate('studio-2')];
    expect((await importExternalSessions()).imported).toBe(1);
    expect(await projectOf('studio-2')).toBe(STUDIO);
    expect(await vpOfProject(STUDIO)).toBe('');
    expect((await getTask(ops.id)).org_leads).toEqual([LOCAL, DEVBOX]);
  });

  it('a project that already exists with no VP is left alone', async () => {
    await seedImportsUnderOperations();
    // The project was made before (a task the user filed there), with no VP.
    await addTask({ title: 'Older import', project: STUDIO, source: 'local' });
    joinStudio(['studio-1']);
    expect((await importExternalSessions()).imported).toBe(1);
    expect(await projectOf('studio-1')).toBe(STUDIO);
    expect(await vpOfProject(STUDIO)).toBe('');
  });

  it('an install whose import project stands on its own keeps that: no Others VP is made, nothing moves', async () => {
    // An older install: "Imported from this Mac" was made before, by a run that placed nothing.
    await addTask({ title: 'Older import', project: LOCAL, source: 'local' });
    setHost('__local__', [candidate('local-1')]);
    await importExternalSessions();
    await ensureProjectLead('Operations');
    joinStudio(['studio-1']);
    await importExternalSessions();
    expect(await projectOf('studio-1')).toBe(STUDIO);
    expect(await vpOfProject(STUDIO)).toBe('');
    expect(await vpOfProject(LOCAL)).toBe('');
    expect(othersVp(await listTasks())).toBeUndefined();
  });

  it('a closed VP is never reopened for it', async () => {
    const ops = await seedImportsUnderOperations();
    await completeTask(ops.id, { source: 'api' });
    joinStudio(['studio-1']);
    expect((await importExternalSessions()).imported).toBe(1);
    expect(await projectOf('studio-1')).toBe(STUDIO);
    expect((await getTask(ops.id)).phase).toBe('COMPLETE');
    expect((await getTask(ops.id)).org_leads).toEqual([LOCAL, DEVBOX]);
    // With no open VP to vote for, it goes where what no VP owns goes: the Others VP.
    expect(await vpOfProject(STUDIO)).toBe(OTHERS_VP_NAME);
    // No lead was made for a sibling, nor for the new project, to put it under.
    for (const p of [LOCAL, DEVBOX, STUDIO]) expect(await ownLeadsOf(p)).toEqual([]);
  });

  it('a replica never moves a project', async () => {
    const ops = await seedImportsUnderOperations();
    serverRole = 'replica';
    joinStudio(['studio-1']);
    await importExternalSessions();
    expect(await projectOf('studio-1')).toBe(STUDIO);
    expect(await vpOfProject(STUDIO)).toBe('');
    expect((await getTask(ops.id)).org_leads).toEqual([LOCAL, DEVBOX]);
  });

  it('an import asked for by id that makes the project places it too', async () => {
    const ops = await seedImportsUnderOperations();
    joinStudio([]);
    hosts.get('Studio-MacBook')!.described = { 'studio-9': candidate('studio-9') };
    expect((await importSessionsById('Studio-MacBook', ['studio-9'])).imported).toEqual(['studio-9']);
    expect(await vpOfProject(STUDIO)).toBe('Operations');
    expect((await getTask(ops.id)).org_leads).toContain(STUDIO);
  });

  it('a test run\'s import by id never puts its project under a VP', async () => {
    const ops = await seedImportsUnderOperations();
    joinStudio([]);
    hosts.get('Studio-MacBook')!.described = { 'studio-9': candidate('studio-9') };
    afterOrgRead = async () => {};
    const res = await withTestRun('placement-probe', () => importSessionsById('Studio-MacBook', ['studio-9']));
    expect(res.imported).toEqual(['studio-9']);
    // It never got as far as a vote (the move would see the test's project only by luck).
    expect(voteRead).toBe(false);
    expect((await getTask(ops.id)).org_leads).toEqual([LOCAL, DEVBOX]);
  });

  it('a project of the user\'s own named like an import project gets no vote', async () => {
    setHost('__local__', [candidate('local-1')]);
    await importExternalSessions();
    await addTask({ title: 'Trip plan', project: 'Imported from Japan', source: 'local' });
    await ensureProjectLead('Travel');
    await setProjectVp('Imported from Japan', 'Travel');
    joinStudio(['studio-1']);
    expect((await importExternalSessions()).imported).toBe(1);
    expect(await projectOf('studio-1')).toBe(STUDIO);
    // It follows this Mac's import (under the Others VP the first import made), never Travel.
    expect(await vpOfProject(STUDIO)).toBe(OTHERS_VP_NAME);
    expect(await vpOfProject('Imported from Japan')).toBe('Travel');
  });

  it('a tie between two VPs goes to the VP of the sibling first by name, whichever VP is older', async () => {
    setHost('__local__', [candidate('local-1')]);
    setHost('devbox', [candidate('devbox-1')]);
    configHosts = { devbox: { hostname: 'dev.example.com', user: 'me', enabled: true } };
    await importExternalSessions();
    await ensureProjectLead('Operations');
    await ensureProjectLead('Fleet');
    await setProjectVp(LOCAL, 'Operations');
    await setProjectVp(DEVBOX, 'Fleet');
    joinStudio(['studio-1']);
    await importExternalSessions();
    // "imported from devbox" sorts before "imported from this mac".
    expect(await vpOfProject(STUDIO)).toBe('Fleet');
  });
});

describe('a new install\'s import goes under the Others VP, never a VP of its own (2026-11-12)', () => {
  it('the first import makes the Others VP and goes under it; no VP is made for the import project', async () => {
    setHost('__local__', [candidate('local-1')]);
    await importExternalSessions();
    expect(await projectOf('local-1')).toBe(LOCAL);
    expect(await vpOfProject(LOCAL)).toBe(OTHERS_VP_NAME);
    expect(await ownLeadsOf(LOCAL)).toEqual([]);
    const leads = (await listTasks()).filter((t) => t.org_role === 'lead');
    expect(leads).toHaveLength(1);
    expect(leads[0]).toMatchObject({ project: OTHERS_VP_NAME, org_vp_only: true, org_leads: [LOCAL] });
    expect(othersVp(leads)?.id).toBe(leads[0]!.id);
    // The next machine's import joins it (the sibling vote), and no second Others VP is made.
    joinStudio(['studio-1']);
    await importExternalSessions();
    expect(await vpOfProject(STUDIO)).toBe(OTHERS_VP_NAME);
    expect((await listTasks()).filter((t) => t.org_role === 'lead')).toHaveLength(1);
  });

  it('two hosts imported in one first run both go under one Others VP', async () => {
    setHost('__local__', [candidate('local-1')]);
    setHost('devbox', [candidate('devbox-1')]);
    configHosts = { devbox: { hostname: 'dev.example.com', user: 'me', enabled: true } };
    await importExternalSessions();
    expect(await vpOfProject(LOCAL)).toBe(OTHERS_VP_NAME);
    expect(await vpOfProject(DEVBOX)).toBe(OTHERS_VP_NAME);
    expect((await listTasks()).filter((t) => t.org_role === 'lead')).toHaveLength(1);
  });

  it('a VP the user named Others takes the first import; none is made', async () => {
    const ops = await ensureProjectLead('Operations');
    await editOrgNode(ops.id, { name: OTHERS_VP_NAME });
    setHost('__local__', [candidate('local-1')]);
    await importExternalSessions();
    expect(await vpOfProject(LOCAL)).toBe('Operations');
    expect((await getTask(ops.id)).org_leads).toEqual([LOCAL]);
    expect((await listTasks()).filter((t) => t.org_role === 'lead').map((t) => t.id)).toEqual([ops.id]);
  });

  it('a closed Others VP is not reopened: the import stands on its own', async () => {
    const others = await createOrgNode({ name: OTHERS_VP_NAME }, true);
    await completeTask(others.id, { source: 'api' });
    setHost('__local__', [candidate('local-1')]);
    await importExternalSessions();
    expect((await getTask(others.id)).phase).toBe('COMPLETE');
    expect(await vpOfProject(LOCAL)).toBe('');
    expect((await listTasks()).filter((t) => t.org_role === 'lead' && t.phase !== 'COMPLETE')).toEqual([]);
  });

  it('a closed Others VP the user renamed is still found, so it is neither made again nor reopened', async () => {
    const others = await createOrgNode({ name: OTHERS_VP_NAME }, true);
    await editOrgNode(others.id, { name: 'Misc' });
    await completeTask(others.id, { source: 'api' });
    setHost('__local__', [candidate('local-1')]);
    await importExternalSessions();
    expect((await getTask(others.id)).phase).toBe('COMPLETE');
    expect(await vpOfProject(LOCAL)).toBe('');
    expect((await listTasks()).filter((t) => t.org_role === 'lead' && t.phase !== 'COMPLETE')).toEqual([]);
  });

  it('an existing "Imported from this Mac" VP is left as it is, and no Others VP is made beside it', async () => {
    // An install from before: the import project became a VP of its own.
    await addTask({ title: 'Older import', project: LOCAL, source: 'local' });
    const own = await ensureProjectLead(LOCAL);
    setHost('__local__', [candidate('local-1')]);
    await importExternalSessions();
    expect(await vpOfProject(LOCAL)).toBe('');
    expect((await getTask(own.id)).phase).not.toBe('COMPLETE');
    // The next machine's import stands on its own, as on that install before.
    joinStudio(['studio-1']);
    await importExternalSessions();
    expect(await vpOfProject(STUDIO)).toBe('');
    expect(othersVp(await listTasks())).toBeUndefined();
  });

  it('a test run\'s first import makes no Others VP', async () => {
    setHost('__local__', [candidate('local-1')]);
    await withTestRun('placement-probe', () => importExternalSessions());
    expect((await listTasks()).filter((t) => t.org_role === 'lead')).toEqual([]);
  });
});

describe('the org changes between the vote and the move: nothing moves', () => {
  async function importAfter(change: () => Promise<void>): Promise<void> {
    afterOrgRead = change;
    joinStudio(['studio-1']);
    expect((await importExternalSessions()).imported).toBe(1);
    expect(voteRead).toBe(true);
    expect(await projectOf('studio-1')).toBe(STUDIO);
  }

  it('the other import projects were given back their own VPs: no lead is made for one', async () => {
    const ops = await seedImportsUnderOperations();
    await importAfter(async () => { await setProjectVp(LOCAL, ''); await setProjectVp(DEVBOX, ''); });
    expect(await vpOfProject(STUDIO)).toBe('');
    for (const p of [LOCAL, DEVBOX, STUDIO]) expect(await ownLeadsOf(p)).toEqual([]);
    expect((await getTask(ops.id)).org_leads ?? []).toEqual([]);
  });

  it('the VP was closed: it is not reopened', async () => {
    const ops = await seedImportsUnderOperations();
    await importAfter(async () => { await completeTask(ops.id, { source: 'api' }); });
    expect((await getTask(ops.id)).phase).toBe('COMPLETE');
    expect((await getTask(ops.id)).org_leads).toEqual([LOCAL, DEVBOX]);
    expect(await vpOfProject(STUDIO)).toBe('');
  });

  it('the other import projects moved under another VP: it does not follow on a stale vote', async () => {
    const ops = await seedImportsUnderOperations();
    let fleet = '';
    await importAfter(async () => {
      fleet = (await ensureProjectLead('Fleet')).id;
      await setProjectVp(LOCAL, 'Fleet');
      await setProjectVp(DEVBOX, 'Fleet');
    });
    expect(await vpOfProject(STUDIO)).toBe('');
    expect((await getTask(fleet)).org_leads).toEqual([LOCAL, DEVBOX]);
    expect((await getTask(ops.id)).org_leads ?? []).toEqual([]);
  });

  it('the new project got a lead of its own: that lead is not closed', async () => {
    const ops = await seedImportsUnderOperations();
    let own = '';
    await importAfter(async () => { own = (await ensureProjectLead(STUDIO)).id; });
    expect((await getTask(own)).phase).not.toBe('COMPLETE');
    expect((await getTask(ops.id)).org_leads).toEqual([LOCAL, DEVBOX]);
    expect(await vpOfProject(STUDIO)).toBe('');
  });
});
