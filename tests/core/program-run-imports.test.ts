/**
 * A plugin's program runs on the board (plugin API `sessionImports.include`) are that program's
 * work, not a person's outside session (2026-11-19: 89 of them sat in one user's Needs you, and the
 * project's VP was told "A task you follow ... stopped" for every one). One durable fact, the
 * PROGRAM_RUN_TAG machine tag, and its three readers:
 *   - the importer mints a claimed run with it, filed NEED_ACTION and read, stamps the claimed runs an
 *     older build filed without it, and adoption (a message into the session) takes it off;
 *   - the status reads Waiting on the program when nothing real is asked (user-status.ts), while
 *     every real ask still reads Needs you;
 *   - no VP or Main hears its edges or moves (org-follow.ts reportsToOrgNode, status-push.ts).
 * A person's own outside session is untouched: To read, unread, and its VP hears it.
 *
 * The daemon RPC is the only mock; the task store, session DB, org and ride-along store are real.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-program-run-imports'));
vi.mock('../../src/utils/process.js', () => ({ isProcessAlive: () => true }));

interface FakeHost { candidates: unknown[]; described: Record<string, unknown> }
const hosts = new Map<string, FakeHost>();
const CAPS = ['external-scan-v1', 'external-scan-filter-v1', 'external-describe-v1', 'external-human-v1'];

vi.mock('../../src/providers/daemon-connection.js', () => ({
  getConnectedDaemonConnection: (hostKey: string) => {
    const entry = hosts.get(hostKey);
    if (!entry) return null;
    return {
      hasCapability: (cap: string) => CAPS.includes(cap),
      send: async (cmd: string, params: Record<string, unknown>) => {
        if (cmd === 'sessions.describeExternal') {
          const ids = params.sessionIds as string[];
          if (params.activityOnly === true) return { ok: true, candidates: [], activity: [] };
          return { ok: true, candidates: ids.map((id) => entry.described[id]).filter(Boolean), activity: [] };
        }
        return { ok: true, candidates: entry.candidates, truncated: false };
      },
    };
  },
}));

vi.mock('../../src/core/config-manager.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getConfig: async () => ({ hosts: {}, defaults: {}, external_session_import: { excluded_cwds: {}, auto_complete_after_days: 0 } }),
  };
});

import { WALNUT_HOME } from '../../src/constants.js';
import {
  importExternalSessions, externalImportProject, adoptImportedTask, claimSessionImports, releaseSessionImportClaims,
  _resetImportAuditForTesting, _resetImportClaimsForTesting, IMPORTED_PHASE,
} from '../../src/core/sessions/external-session-import.js';
import { deriveUserStatus, PROGRAM_RUN_WAIT, type UserStatusInput } from '../../src/core/user-status.js';
import { statusInputOf, type StatusFacts } from '../../src/core/user-status-sync.js';
import { EXTERNAL_SESSION_IMPORT_TAG, PLUGIN_RUN_TAG, PROGRAM_RUN_TAG, isExternalImportTask, isProgramRunTask, type Task } from '../../src/core/types.js';
import { BUILTIN_TAG_DISPLAY_RULES, DEFAULT_TAG_DISPLAY_RULES, compileTagDisplay, shownTags } from '../../src/core/tag-display-rules.js';
import { getSessionByClaudeId, importSessionRecord, createSessionRecord, updateSessionRecord, _resetSessionTrackerForTesting } from '../../src/core/session-tracker.js';
import { addTask, getTask, linkSession, updateTask, updateTaskRaw, _resetForTesting as _resetTaskManager } from '../../src/core/task-manager.js';
import { ensureProjectLead } from '../../src/core/org/org-store.js';
import { adoptOnInput, applySessionPhase, PROGRAM_RUN_SEND_SOURCE } from '../../src/core/phase.js';
import { programRunDelivery, programRunRefusal, programSendSource, programStartSource, PROGRAM_RUN_SESSION_REFUSAL } from '../../src/core/sessions/plugin-run.js';
import { resolveCaller } from '../../src/core/sessions/session-send-core.js';
import { noteOrgEdge, reportsToOrgNode } from '../../src/core/sessions/org-follow.js';
import { clearRiding, ridingKeys } from '../../src/core/sessions/status-riding.js';
import { closeDb as closeSessionDb } from '../../src/core/session-db.js';
import { closeDb as closeTaskDb } from '../../src/core/task-db.js';
import { bus, EventNames } from '../../src/core/event-bus.js';

const LOCAL = '__local__';
const PROJECT = externalImportProject(LOCAL);
const VP_SID = '77777777-1111-4222-8333-444444444444';
const recent = () => new Date(Date.now() - 60_000).toISOString();

function candidate(sessionId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId, engine: 'claude', cwd: '/work/sample', title: `Work on ${sessionId}`, origin: 'cli',
    startedAt: recent(), lastActiveAt: recent(), messageCount: 4, transcriptPath: `/work/.claude/${sessionId}.jsonl`, ...over,
  };
}
/** A program's run as the host describes it: the CLI recorded a program as its starter. */
const programRun = (sessionId: string) => candidate(sessionId, { origin: 'sdk-cli', notExternal: 'programmatic' });

async function resetAll(): Promise<void> {
  closeSessionDb();
  closeTaskDb();
  _resetSessionTrackerForTesting();
  _resetTaskManager();
  _resetImportAuditForTesting();
  _resetImportClaimsForTesting();
  clearRiding();
  for (let i = 0; i < 3; i++) {
    try { await fsp.rm(WALNUT_HOME, { recursive: true, force: true }); break; } catch { await new Promise<void>((r) => setImmediate(r)); }
  }
}

beforeEach(async () => {
  await resetAll();
  hosts.clear();
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
});
afterEach(async () => {
  bus.clear();
  await resetAll();
});

async function taskForSession(sessionId: string): Promise<Task> {
  const rec = await getSessionByClaudeId(sessionId);
  expect(rec?.taskId).toBeTruthy();
  return getTask(rec!.taskId);
}

/** The status the sync derives for the stored row and its stored session record. */
async function statusOfStored(task: Task, sessionId: string) {
  const rec = await getSessionByClaudeId(sessionId);
  const facts: StatusFacts = {
    sessions: new Map([[sessionId, { processStatus: rec?.process_status, taskId: rec?.taskId, errorReason: rec?.status_reason }]]),
    letters: new Map(), choices: new Map(), requestsFrom: new Map(), triggers: new Map(), schedules: new Map(),
    titles: new Map(), sessionsOf: new Map([[task.id, [sessionId]]]),
  };
  return deriveUserStatus(statusInputOf(await getTask(task.id), facts));
}

/** The import project's VP with an idle session, so the node above can hear an edge. */
async function vpThatHears(): Promise<string> {
  const vp = await ensureProjectLead(PROJECT);
  await createSessionRecord(VP_SID, vp.id, PROJECT, WALNUT_HOME);
  await updateSessionRecord(VP_SID, { process_status: 'idle' });
  return vp.id;
}

/** The edge the request-watch hook hands the node above when a turn ends with the task open. */
async function stopEdgeRides(task: Task, sessionId: string): Promise<boolean> {
  return noteOrgEdge(await getTask(task.id), { kind: 'stopped', sessionId, lastWords: { text: 'Finished the pass over the sample data.' } });
}

describe("a claimed run is filed as its program's work; a person's own session as before", () => {
  it('scenarios 1 and 2: both tags, NEED_ACTION, read, Waiting on the program, and no edge reaches the VP; the person keeps today\'s result', async () => {
    await vpThatHears();
    hosts.set(LOCAL, { candidates: [candidate('person-1')], described: { 'run-1': programRun('run-1') } });
    claimSessionImports('plugin:acme-sync:1', LOCAL, ['run-1']);
    expect((await importExternalSessions()).imported).toBe(2);

    const run = await taskForSession('run-1');
    expect(run.tags).toEqual(expect.arrayContaining([EXTERNAL_SESSION_IMPORT_TAG, PROGRAM_RUN_TAG]));
    expect(run.phase).toBe(IMPORTED_PHASE);
    expect(run.unread).toBe(false);
    const runStatus = await statusOfStored(run, 'run-1');
    expect(runStatus).toMatchObject({ state: 'waiting', kind: 'outside', waitingOn: PROGRAM_RUN_WAIT });
    expect(reportsToOrgNode(run)).toBe(false);
    expect(await stopEdgeRides(run, 'run-1')).toBe(false);
    expect(ridingKeys(VP_SID)).not.toContain(run.id);

    const person = await taskForSession('person-1');
    expect(person.tags).toEqual([EXTERNAL_SESSION_IMPORT_TAG]);
    expect(person.phase).toBe(IMPORTED_PHASE);
    expect(person.unread).toBe(true);
    expect(await statusOfStored(person, 'person-1')).toMatchObject({ state: 'read', toRead: 'turn' });
    expect(await stopEdgeRides(person, 'person-1')).toBe(true);
    expect(ridingKeys(VP_SID)).toContain(person.id);
  });

  it('no task:updated of the import run carries a program run that is still unread', async () => {
    hosts.set(LOCAL, { candidates: [], described: { 'run-2': programRun('run-2') } });
    claimSessionImports('plugin:acme-sync:1', LOCAL, ['run-2']);
    const seen: Array<{ phase?: string; unread?: boolean; tags?: string[] }> = [];
    bus.subscribe('test:program-run-events', (e) => {
      const t = (e.data as { task?: Task } | undefined)?.task;
      if (t?.tags?.includes(PROGRAM_RUN_TAG)) seen.push({ phase: t.phase, unread: t.unread, tags: t.tags });
    }, { global: true, interest: [EventNames.TASK_UPDATED, EventNames.TASK_PHASE_CHANGED] });
    expect((await importExternalSessions()).imported).toBe(1);
    await new Promise<void>((r) => setImmediate(r));
    const filed = seen.filter((s) => s.phase === IMPORTED_PHASE);
    expect(filed.length).toBeGreaterThan(0);
    expect(filed.every((s) => s.unread === false)).toBe(true);
  });
});

describe('scenario 3: claimed runs an older build filed without the tag', () => {
  /** The shape an older importer left: the importer's tag only, NEED_ACTION and unread. */
  async function olderImport(sessionId: string, over: { tags?: string[]; phase?: Task['phase'] } = {}): Promise<string> {
    const { task } = await addTask({ title: `Older ${sessionId}`, project: PROJECT, source: 'local', tags: over.tags ?? [EXTERNAL_SESSION_IMPORT_TAG], _skipPluginOps: true });
    await importSessionRecord({ claudeSessionId: sessionId, taskId: task.id, project: PROJECT, title: task.title, lastActiveAt: recent(), messageCount: 3, provider: 'cli' });
    await linkSession(task.id, sessionId);
    if ((over.phase ?? 'NEED_ACTION') !== 'TODO') await updateTaskRaw(task.id, { phase: over.phase ?? 'NEED_ACTION', unread: true }, { leaveHeld: true });
    return task.id;
  }

  it('one run stamps it and clears unread, a second changes nothing, and a task someone wrote to is never stamped', async () => {
    const stale = await olderImport('old-run-1');
    const stillTodo = await olderImport('old-run-2', { phase: 'TODO' });
    const writtenTo = await olderImport('old-run-3', { tags: ['label:mine'] });
    const person = await olderImport('old-person-1');
    hosts.set(LOCAL, { candidates: [], described: {} });
    claimSessionImports('plugin:acme-sync:1', LOCAL, ['old-run-1', 'old-run-2', 'old-run-3']);

    const announced: string[] = [];
    bus.subscribe('test:stamp-events', (e) => {
      const t = (e.data as { task?: Task } | undefined)?.task;
      if (t?.id) announced.push(t.id);
    }, { global: true, interest: [EventNames.TASK_UPDATED] });

    const first = await importExternalSessions();
    expect(first.programRuns).toBe(2);
    const stamped = await getTask(stale);
    expect(stamped.tags).toEqual(expect.arrayContaining([EXTERNAL_SESSION_IMPORT_TAG, PROGRAM_RUN_TAG]));
    expect(stamped).toMatchObject({ phase: 'NEED_ACTION', unread: false });
    // The write announces the row, which is what derives its user status again.
    expect(announced).toContain(stale);
    expect(await statusOfStored(stamped, 'old-run-1')).toMatchObject({ state: 'waiting', kind: 'outside' });
    // A stamped TODO is then filed as started, and read.
    expect(await getTask(stillTodo)).toMatchObject({ phase: IMPORTED_PHASE, unread: false });
    expect((await getTask(stillTodo)).tags).toContain(PROGRAM_RUN_TAG);
    // Someone wrote to it (the importer's tag is gone): a regular task, never stamped.
    expect((await getTask(writtenTo)).tags).toEqual(['label:mine']);
    expect(await getTask(person)).toMatchObject({ unread: true, tags: [EXTERNAL_SESSION_IMPORT_TAG] });

    const before = await getTask(stale);
    const second = await importExternalSessions();
    expect(second.programRuns).toBe(0);
    expect((await getTask(stale)).updated_at).toBe(before.updated_at);
  });

  it('is bounded per run', async () => {
    for (const sid of ['cap-1', 'cap-2', 'cap-3']) await olderImport(sid);
    hosts.set(LOCAL, { candidates: [], described: {} });
    claimSessionImports('plugin:acme-sync:1', LOCAL, ['cap-1', 'cap-2', 'cap-3']);
    expect((await importExternalSessions({ limits: { programRuns: 2 } })).programRuns).toBe(2);
    expect((await importExternalSessions({ limits: { programRuns: 2 } })).programRuns).toBe(1);
    expect((await importExternalSessions({ limits: { programRuns: 2 } })).programRuns).toBe(0);
  });
});

describe('scenario 4: adoption makes it a regular task', () => {
  it('a message into a program run removes both tags, and its next turn end reads and reports like any task', async () => {
    await vpThatHears();
    hosts.set(LOCAL, { candidates: [], described: { 'run-4': programRun('run-4') } });
    claimSessionImports('plugin:acme-sync:1', LOCAL, ['run-4']);
    await importExternalSessions();
    const run = await taskForSession('run-4');
    expect(await adoptImportedTask(run.id, 'test')).toBe(true);
    const adopted = await getTask(run.id);
    expect(adopted.tags ?? []).not.toContain(EXTERNAL_SESSION_IMPORT_TAG);
    expect(adopted.tags ?? []).not.toContain(PROGRAM_RUN_TAG);
    // Its turn ends: the hand-back is the user's to read, and the VP hears the edge.
    await updateTaskRaw(run.id, { phase: 'NEED_ACTION', unread: true }, { leaveHeld: true });
    expect(await statusOfStored(adopted, 'run-4')).toMatchObject({ state: 'read', toRead: 'turn' });
    expect(reportsToOrgNode(await getTask(run.id))).toBe(true);
    expect(await stopEdgeRides(adopted, 'run-4')).toBe(true);
    expect(ridingKeys(VP_SID)).toContain(run.id);
    // Not stamped again: nobody's import any more.
    expect((await importExternalSessions()).programRuns).toBe(0);
    expect((await getTask(run.id)).tags ?? []).not.toContain(PROGRAM_RUN_TAG);
  });
});

describe('adoption happens in applySessionPhase, whoever sent the input', () => {
  for (const source of ['trigger-host-delivery', 'offline-handover', 'router-delivery']) {
    it(`an input from ${source} removes both tags`, async () => {
      hosts.set(LOCAL, { candidates: [], described: { 'run-a': programRun('run-a') } });
      claimSessionImports('plugin:acme-sync:1', LOCAL, ['run-a']);
      await importExternalSessions();
      const run = await taskForSession('run-a');
      expect(isProgramRunTask(run)).toBe(true);
      await applySessionPhase(run.id, 'session:input', source, { sessionId: 'run-a' });
      const after = await getTask(run.id);
      expect(after.tags ?? []).not.toContain(EXTERNAL_SESSION_IMPORT_TAG);
      expect(after.tags ?? []).not.toContain(PROGRAM_RUN_TAG);
      expect(reportsToOrgNode(after)).toBe(true);
    });
  }
});

describe('a leftover program-run tag alone is inert', () => {
  it('a task with only walnut:program-run (its importer tag replaced by hand) reads and reports like a regular task', async () => {
    await vpThatHears();
    const sid = 'left-1';
    const { task } = await addTask({ title: 'Kept by hand', project: PROJECT, source: 'local', tags: [PROGRAM_RUN_TAG], _skipPluginOps: true });
    await importSessionRecord({ claudeSessionId: sid, taskId: task.id, project: PROJECT, title: task.title, lastActiveAt: recent(), messageCount: 3, provider: 'cli' });
    await linkSession(task.id, sid);
    await updateTaskRaw(task.id, { phase: 'NEED_ACTION', unread: true }, { leaveHeld: true });
    const stored = await getTask(task.id);
    expect(isProgramRunTask(stored)).toBe(false);
    expect(await statusOfStored(stored, sid)).toMatchObject({ state: 'read', toRead: 'turn' });
    expect(reportsToOrgNode(stored)).toBe(true);
    expect(await stopEdgeRides(stored, sid)).toBe(true);
    expect(ridingKeys(VP_SID)).toContain(task.id);
  });
});

describe('the audit never removes a tagged program run', () => {
  it('after a restart with no claim yet it keeps the tagged run, and still removes an untagged program\'s import', async () => {
    hosts.set(LOCAL, { candidates: [], described: { 'run-t': programRun('run-t'), 'plain-p': programRun('plain-p') } });
    claimSessionImports('plugin:acme-sync:1', LOCAL, ['run-t']);
    await importExternalSessions();
    const tagged = await taskForSession('run-t');
    // An import an older scanner let through: a program's run nobody claimed, the importer's tag only.
    const { task: plain } = await addTask({ title: 'Script run', project: PROJECT, source: 'local', tags: [EXTERNAL_SESSION_IMPORT_TAG], _skipPluginOps: true });
    await importSessionRecord({ claudeSessionId: 'plain-p', taskId: plain.id, project: PROJECT, title: plain.title, lastActiveAt: recent(), messageCount: 3, provider: 'cli' });
    await linkSession(plain.id, 'plain-p');
    // A restart: no claim yet (the plugin has not loaded), nothing audited in this process.
    _resetImportClaimsForTesting();
    _resetImportAuditForTesting();
    expect((await importExternalSessions()).removed).toBe(1);
    expect((await getTask(tagged.id)).tags).toContain(PROGRAM_RUN_TAG);
    expect(await getSessionByClaudeId('run-t')).toBeTruthy();
    await expect(getTask(plain.id)).rejects.toThrow();
  });
});

describe('scenario 6: the tag is the fact', () => {
  it('the claim ending or a restart changes neither the tag nor the status', async () => {
    hosts.set(LOCAL, { candidates: [], described: { 'run-6': programRun('run-6') } });
    claimSessionImports('plugin:acme-sync:1', LOCAL, ['run-6']);
    await importExternalSessions();
    const run = await taskForSession('run-6');
    const expected = { state: 'waiting', kind: 'outside', waitingOn: PROGRAM_RUN_WAIT };
    expect(await statusOfStored(run, 'run-6')).toMatchObject(expected);

    // The plugin stops: its claim ends.
    releaseSessionImportClaims('plugin:acme-sync:1');
    expect(await statusOfStored(run, 'run-6')).toMatchObject(expected);
    await importExternalSessions();
    expect((await getTask(run.id)).tags).toContain(PROGRAM_RUN_TAG);
    expect(reportsToOrgNode(await getTask(run.id))).toBe(false);

    // A restart: the process forgets every claim; the plugin claims again on its first pass.
    _resetImportClaimsForTesting();
    claimSessionImports('plugin:acme-sync:2', LOCAL, ['run-6']);
    expect((await importExternalSessions()).programRuns).toBe(0);
    expect(await getTask(run.id)).toMatchObject({ unread: false, phase: IMPORTED_PHASE });
    expect(await statusOfStored(run, 'run-6')).toMatchObject(expected);
  });
});

describe("a program run's status (user-status.ts derive)", () => {
  const base: UserStatusInput = { phase: 'NEED_ACTION', hasSession: true, processStatus: 'stopped', programRun: true };

  it('scenario 5: a real ask still reads Needs you', () => {
    expect(deriveUserStatus({ ...base, openLetter: 'Approve the sample upload' })).toMatchObject({ state: 'needs', source: 'letter' });
    expect(deriveUserStatus({ ...base, processStatus: 'idle', pendingPermissionTool: 'Bash' })).toMatchObject({ state: 'needs', source: 'prompt' });
    expect(deriveUserStatus({ ...base, markedByPerson: true })).toMatchObject({ state: 'needs' });
    expect(deriveUserStatus({ ...base, processStatus: 'error', errorMessage: 'The model call failed' }).state).toBe('needs');
  });

  it('class guard 7a: with no ask facts it is never To read and never Needs you, in any phase or process status', () => {
    const phases = ['TODO', 'NEED_ACTION', 'IN_PROGRESS', 'WAITING', undefined];
    const processes = [undefined, 'idle', 'stopped', 'running'];
    const rows: string[] = [];
    for (const phase of phases) for (const processStatus of processes) for (const hasSession of [true, false]) {
      const s = deriveUserStatus({ phase, processStatus, hasSession, programRun: true });
      if (s.state === 'read' || s.state === 'needs') rows.push(`${phase}/${processStatus}/${hasSession}: ${s.state}`);
    }
    expect(rows).toEqual([]);
    // The same facts without the tag (a person's session) are the user's to read, as before.
    expect(deriveUserStatus({ ...base, programRun: undefined }).state).toBe('read');
  });

  it('its machine tag shows no pill', () => {
    const compiled = compileTagDisplay([...BUILTIN_TAG_DISPLAY_RULES, ...DEFAULT_TAG_DISPLAY_RULES]);
    expect(shownTags([PROGRAM_RUN_TAG, EXTERNAL_SESSION_IMPORT_TAG, 'sev:2'], compiled)).toEqual(['sev:2']);
  });
});

describe('class guard 7b: the importer mints tasks in one place, and that place tags claims', () => {
  it('external-session-import.ts has one addTask( call, whose tags name PROGRAM_RUN_TAG for a claimed id', async () => {
    const src = await fsp.readFile(path.join(process.cwd(), 'src/core/sessions/external-session-import.ts'), 'utf8');
    const sites = [...src.matchAll(/\baddTask\(/g)].map((m) => m.index!);
    expect(sites).toHaveLength(1);
    const call = src.slice(sites[0], src.indexOf('});', sites[0]));
    expect(call).toMatch(/tags:[^\n]*isClaimedImport\(host, candidate\.sessionId\)[^\n]*PROGRAM_RUN_TAG/);
    // Adoption takes both tags off (the program's own send keeps it a program's run: PLUGIN_RUN_TAG).
    expect(src).toMatch(/remove_tags: \[HOLDER_TAG, PROGRAM_RUN_TAG, /);
  });
});

/**
 * A plugin's job runs its program inside Walnut (core/sessions/plugin-run.ts): it creates a task per
 * unit of its work with PLUGIN_RUN_TAG in `tags` (the route turns that into addTask's program_run), and
 * its later sends and starts are an outside caller's. The tag makes such a task read and report exactly
 * like an imported program run, while nobody but the program wrote to it.
 */
describe("a program's run a plugin's job runs in Walnut (PLUGIN_RUN_TAG)", () => {
  const SID = 'plugin-run-1';

  /** A task the job created as its run (the route's program_run), with a session that ran its first turn. */
  async function pluginRun(opts: { programRun?: boolean; tags?: string[]; sid?: string } = {}): Promise<Task> {
    const sid = opts.sid ?? SID;
    const { task } = await addTask({ title: 'Ticket 42', project: PROJECT, source: 'local', ...(opts.tags ? { tags: opts.tags } : {}), program_run: opts.programRun ?? true, _skipPluginOps: true });
    await createSessionRecord(sid, task.id, PROJECT, WALNUT_HOME);
    await updateSessionRecord(sid, { process_status: 'idle' });
    await linkSession(task.id, sid);
    await updateTaskRaw(task.id, { phase: 'IN_PROGRESS', unread: false }, { leaveHeld: true });
    return getTask(task.id);
  }

  it('is born with the marker only through the program\'s create; a forged tag alone is dropped', async () => {
    const run = await pluginRun();
    expect(run.tags).toEqual([PLUGIN_RUN_TAG]);
    expect(isProgramRunTask(run)).toBe(true);
    expect(isExternalImportTask(run)).toBe(false);
    const forged = await pluginRun({ programRun: false, tags: [PLUGIN_RUN_TAG, 'sev:2'], sid: 'plugin-run-forged' });
    expect(forged.tags).toEqual(['sev:2']);
    expect(isProgramRunTask(forged)).toBe(false);
  });

  it('its turn end is filed read and reads Waiting on the program; a real ask still reads Needs you', async () => {
    const run = await pluginRun();
    await applySessionPhase(run.id, 'session:result', 'test', { sessionId: SID });
    const ended = await getTask(run.id);
    expect(ended).toMatchObject({ phase: 'NEED_ACTION', unread: false });
    expect(await statusOfStored(ended, SID)).toMatchObject({ state: 'waiting', kind: 'outside', waitingOn: PROGRAM_RUN_WAIT });
    const input = statusInputOf(ended, { sessions: new Map([[SID, { processStatus: 'idle', taskId: run.id }]]), letters: new Map(), choices: new Map(), requestsFrom: new Map(), triggers: new Map(), schedules: new Map(), titles: new Map(), sessionsOf: new Map([[run.id, [SID]]]) });
    expect(input.programRun).toBe(true);
    expect(deriveUserStatus({ ...input, openLetter: 'Approve the refund' })).toMatchObject({ state: 'needs', source: 'letter' });
    expect(deriveUserStatus({ ...input, pendingPermissionTool: 'AskUserQuestion' })).toMatchObject({ state: 'needs', source: 'prompt' });
    expect(deriveUserStatus({ ...input, markedByPerson: true })).toMatchObject({ state: 'needs' });
    // The same turn end of a regular task is the user's to read.
    const plain = await pluginRun({ programRun: false, sid: 'plugin-run-plain' });
    await applySessionPhase(plain.id, 'session:result', 'test', { sessionId: 'plugin-run-plain' });
    expect(await getTask(plain.id)).toMatchObject({ phase: 'NEED_ACTION', unread: true });
  });

  it('no VP or Main hears it', async () => {
    await vpThatHears();
    const run = await pluginRun();
    expect(reportsToOrgNode(run)).toBe(false);
    expect(await stopEdgeRides(run, SID)).toBe(false);
    expect(ridingKeys(VP_SID)).not.toContain(run.id);
  });

  it('no tag write puts the marker on or takes it off', async () => {
    const run = await pluginRun();
    await updateTask(run.id, { set_tags: ['sev:1'] });
    expect((await getTask(run.id)).tags).toEqual(['sev:1', PLUGIN_RUN_TAG]);
    await updateTask(run.id, { remove_tags: [PLUGIN_RUN_TAG] });
    expect((await getTask(run.id)).tags).toContain(PLUGIN_RUN_TAG);
    await updateTask(run.id, { set_tags: [] });
    expect((await getTask(run.id)).tags).toEqual([PLUGIN_RUN_TAG]);
    const plain = await pluginRun({ programRun: false, sid: 'plugin-run-plain-2' });
    await updateTask(plain.id, { add_tags: [PLUGIN_RUN_TAG, 'sev:3'] });
    expect((await getTask(plain.id)).tags).toEqual(['sev:3']);
    await updateTask(plain.id, { set_tags: [PLUGIN_RUN_TAG] });
    expect((await getTask(plain.id)).tags ?? []).toEqual([]);
  });

  /** A session record an engine switch replaced (engine-switch-marker.ts): it resolves to an outside caller. */
  async function supersededSession(sid: string): Promise<void> {
    const { task } = await addTask({ title: 'Switched', project: PROJECT, source: 'local', _skipPluginOps: true });
    await createSessionRecord(sid, task.id, PROJECT, WALNUT_HOME);
    await updateSessionRecord(sid, { archive_reason: 'engine_switched:codex' } as never);
  }

  it("only a program's own call creates a run: not a session, a person, an unknown or replaced sid, or a script naming itself", async () => {
    const { task } = await addTask({ title: 'Caller', project: PROJECT, source: 'local', _skipPluginOps: true });
    await createSessionRecord('caller-session-1', task.id, PROJECT, WALNUT_HOME);
    await supersededSession('caller-replaced-1');
    expect((await resolveCaller('caller-replaced-1')).kind).toBe('external');
    for (const from of [
      { sid: 'caller-session-1' }, { sid: 'caller-session-1', pluginId: 'acme' }, {}, { pluginId: 'acme' },
      { sid: 'caller-not-tracked' }, { sid: 'caller-replaced-1' }, { sid: 'external', label: 'nightly-report' },
    ]) expect(await programRunRefusal(from), JSON.stringify(from)).toBe(PROGRAM_RUN_SESSION_REFUSAL);
    // A job online (the gateway's anonymous caller), a job on its host's replica (its plugin named), the server half.
    for (const from of [{ sid: 'external' }, { sid: 'plugin-job:0f1e2d3c', pluginId: 'acme' }, { sid: 'plugin:acme' }]) {
      expect(await programRunRefusal(from), JSON.stringify(from)).toBeNull();
    }
  });

  it("who sends decides: only a program's own send or start into a program run is the program's", async () => {
    const run = await pluginRun();
    const plain = await pluginRun({ programRun: false, sid: 'plugin-run-plain-3' });
    const { task: callerTask } = await addTask({ title: 'Peer', project: PROJECT, source: 'local', _skipPluginOps: true });
    await createSessionRecord('caller-session-2', callerTask.id, PROJECT, WALNUT_HOME);
    await supersededSession('caller-replaced-2');
    const session = await resolveCaller('caller-session-2');
    expect(session.kind).toBe('session');
    const ext = await resolveCaller('external');
    // A job online, a job on its host's replica, a plugin's server half: the program's own.
    expect(await programSendSource(ext, { sid: 'external' }, undefined, run.id)).toBe(PROGRAM_RUN_SEND_SOURCE);
    expect(await programSendSource({ kind: 'external' }, { sid: 'plugin-job:0f1e2d3c', pluginId: 'acme' }, undefined, run.id)).toBe(PROGRAM_RUN_SEND_SOURCE);
    expect(await programSendSource(await resolveCaller('plugin:acme'), { sid: 'plugin:acme' }, undefined, run.id)).toBe(PROGRAM_RUN_SEND_SOURCE);
    expect(await programStartSource({ sid: 'external' }, run.id.slice(0, 8))).toBe(PROGRAM_RUN_SEND_SOURCE);
    // An unknown or replaced sid, a script naming itself, a session (even through a plugin), a person, a
    // caller naming its own source (the router), a regular task: as today ('peer' or 'cli', which adopt).
    expect(await programSendSource(await resolveCaller('caller-not-tracked'), { sid: 'caller-not-tracked' }, undefined, run.id)).toBeNull();
    expect(await programSendSource(await resolveCaller('caller-replaced-2'), { sid: 'caller-replaced-2' }, undefined, run.id)).toBeNull();
    expect(await programSendSource(ext, { sid: 'external', label: 'nightly-report' }, undefined, run.id)).toBeNull();
    expect(await programSendSource(session, { sid: 'caller-session-2', pluginId: 'acme' }, undefined, run.id)).toBeNull();
    expect(await programSendSource({ kind: 'human' }, { pluginId: 'acme' }, undefined, run.id)).toBeNull();
    expect(await programSendSource(ext, { sid: 'external' }, 'api-agent', run.id)).toBeNull();
    expect(await programSendSource(ext, { sid: 'external' }, undefined, plain.id)).toBeNull();
    expect(await programStartSource({ sid: 'caller-not-tracked' }, run.id)).toBeNull();
    expect(await programStartSource({ sid: 'caller-session-2', pluginId: 'acme' }, run.id)).toBeNull();
    expect(await programStartSource({ pluginId: 'acme' }, run.id)).toBeNull();
    // A start the route already named the program's keeps it as it continues, unless a session asks.
    expect(await programSendSource(ext, { sid: 'external' }, PROGRAM_RUN_SEND_SOURCE, run.id)).toBe(PROGRAM_RUN_SEND_SOURCE);
    expect(await programSendSource(session, { sid: 'caller-session-2' }, PROGRAM_RUN_SEND_SOURCE, run.id)).toBeNull();
  });

  it("a host's recorded delivery is the program's by the sender the host recorded", async () => {
    const run = await pluginRun();
    const plain = await pluginRun({ programRun: false, sid: 'plugin-run-plain-5' });
    const imported = { tags: [EXTERNAL_SESSION_IMPORT_TAG, PROGRAM_RUN_TAG] } as Task;
    const { task: callerTask } = await addTask({ title: 'Peer', project: PROJECT, source: 'local', _skipPluginOps: true });
    await createSessionRecord('caller-session-3', callerTask.id, PROJECT, WALNUT_HOME);
    // As online: the gateway's anonymous caller or a plugin's sid, into any program run.
    expect(await programRunDelivery('external', run)).toBe(true);
    expect(await programRunDelivery('external', imported)).toBe(true);
    expect(await programRunDelivery('plugin:acme', run)).toBe(true);
    // No sender (follower.send: the phone or a job, the record cannot tell): the program's in a plugin's run only.
    expect(await programRunDelivery('', run)).toBe(true);
    expect(await programRunDelivery('', imported)).toBe(false);
    // A session's sid or an unknown one, and anything into a regular task: someone else's.
    expect(await programRunDelivery('caller-session-3', run)).toBe(false);
    expect(await programRunDelivery('caller-not-tracked', run)).toBe(false);
    expect(await programRunDelivery('external', plain)).toBe(false);
    expect(await programRunDelivery('', plain)).toBe(false);
  });

  it('a death whose result may be lost is the user\'s to read, even in a program run', async () => {
    const run = await pluginRun();
    await applySessionPhase(run.id, 'session:result', 'health-monitor:remote-dead-recovery', { sessionId: SID, resultLost: true });
    expect(await getTask(run.id)).toMatchObject({ phase: 'NEED_ACTION', unread: true });
    // The health monitor's remote dead recovery passes it (session-health-monitor.ts).
    const monitor = await fsp.readFile(path.join(process.cwd(), 'src/core/session-health-monitor.ts'), 'utf8');
    expect(monitor).toMatch(/'health-monitor:remote-dead-recovery',\s*\n[^\n]*\n\s*\{[^}]*resultLost: true/);
  });

  it("a host's delivery into a task that is not complete decides whose it is without moving its phase", async () => {
    const run = await pluginRun();
    await adoptOnInput(run.id, PROGRAM_RUN_SEND_SOURCE, 'offline-handover');
    expect(await getTask(run.id)).toMatchObject({ phase: 'IN_PROGRESS', tags: [PLUGIN_RUN_TAG] });
    await adoptOnInput(run.id, 'offline-handover', 'offline-handover');
    const adopted = await getTask(run.id);
    expect(adopted.phase).toBe('IN_PROGRESS');
    expect(adopted.tags ?? []).not.toContain(PLUGIN_RUN_TAG);
  });

  it('no raw tag write puts the marker on or takes it off; only a takeover\'s permit does', async () => {
    const run = await pluginRun();
    await updateTaskRaw(run.id, { tags: ['sev:4'] });
    expect((await getTask(run.id)).tags).toEqual(['sev:4', PLUGIN_RUN_TAG]);
    await updateTaskRaw(run.id, { tags: null as never });
    expect((await getTask(run.id)).tags).toEqual([PLUGIN_RUN_TAG]);
    const plain = await pluginRun({ programRun: false, sid: 'plugin-run-plain-4' });
    await updateTaskRaw(plain.id, { tags: [PLUGIN_RUN_TAG, 'sev:5'] });
    expect((await getTask(plain.id)).tags).toEqual(['sev:5']);
    await updateTaskRaw(plain.id, { tags: [PLUGIN_RUN_TAG] }, { pluginRunMarker: true });
    expect((await getTask(plain.id)).tags).toEqual([PLUGIN_RUN_TAG]);
  });

  // Each side of adoption, by the source a message into the session carries (phase.ts inputAdoptsPluginRun;
  // the whole list is tests/core/program-run-adoption-sources.test.ts).
  const ADOPTERS = ['ui', 'mobile', 'cli', 'api-v1', 'human-inbox', 'peer', 'api-agent'];
  const KEEPERS = [PROGRAM_RUN_SEND_SOURCE, 'walnut-notify', 'auto-recover', 'restart', 'retry', 'context-compact', 'idle-compact', 'routine-trigger', 'wait-until'];
  for (const source of ADOPTERS) {
    it(`a message from "${source}" (a person or another task) makes it a regular task, whose next turn end is the user's`, async () => {
      await vpThatHears();
      const run = await pluginRun();
      await applySessionPhase(run.id, 'session:input', 'session.ts:handleSend', { sessionId: SID, sendSource: source });
      const adopted = await getTask(run.id);
      expect(adopted.tags ?? []).not.toContain(PLUGIN_RUN_TAG);
      expect(isProgramRunTask(adopted)).toBe(false);
      expect(reportsToOrgNode(adopted)).toBe(true);
      await applySessionPhase(run.id, 'session:result', 'test', { sessionId: SID });
      expect(await getTask(run.id)).toMatchObject({ phase: 'NEED_ACTION', unread: true });
    });
  }
  for (const source of KEEPERS) {
    it(`a message from "${source}" (the program or Walnut itself) leaves it the program's run`, async () => {
      const run = await pluginRun();
      await applySessionPhase(run.id, 'session:input', 'session.ts:handleSend', { sessionId: SID, sendSource: source });
      expect((await getTask(run.id)).tags).toContain(PLUGIN_RUN_TAG);
    });
  }
  for (const positional of ['trigger-host-delivery', 'router-delivery']) {
    it(`Walnut's own ${positional} input leaves it the program's run`, async () => {
      const run = await pluginRun();
      await applySessionPhase(run.id, 'session:input', positional, { sessionId: SID });
      expect((await getTask(run.id)).tags).toContain(PLUGIN_RUN_TAG);
    });
  }
});

describe("the program's own send into an imported run, or into a regular task", () => {
  it('into an imported program run: the import tags come off and it stays a program run', async () => {
    hosts.set(LOCAL, { candidates: [], described: { 'run-p': programRun('run-p') } });
    claimSessionImports('plugin:acme-sync:1', LOCAL, ['run-p']);
    await importExternalSessions();
    const run = await taskForSession('run-p');
    await applySessionPhase(run.id, 'session:input', 'session.ts:handleSend', { sessionId: 'run-p', sendSource: PROGRAM_RUN_SEND_SOURCE });
    const taken = await getTask(run.id);
    expect(taken.tags ?? []).not.toContain(EXTERNAL_SESSION_IMPORT_TAG);
    expect(taken.tags ?? []).not.toContain(PROGRAM_RUN_TAG);
    expect(taken.tags).toContain(PLUGIN_RUN_TAG);
    expect(isProgramRunTask(taken)).toBe(true);
    expect(reportsToOrgNode(taken)).toBe(false);
    // The importer owns it no more, and its passes leave it alone.
    expect((await importExternalSessions()).programRuns).toBe(0);
    expect((await getTask(run.id)).tags).toEqual(taken.tags);
    // A person's message then makes it a regular task.
    await applySessionPhase(run.id, 'session:input', 'session.ts:handleSend', { sessionId: 'run-p', sendSource: 'ui' });
    expect(isProgramRunTask(await getTask(run.id))).toBe(false);
  });

  it("a send that is no program's ('peer': an unknown sid) into an imported program run adopts it, as on main", async () => {
    hosts.set(LOCAL, { candidates: [], described: { 'run-q': programRun('run-q') } });
    claimSessionImports('plugin:acme-sync:2', LOCAL, ['run-q']);
    await importExternalSessions();
    const run = await taskForSession('run-q');
    expect(await programSendSource(await resolveCaller('caller-not-tracked'), { sid: 'caller-not-tracked' }, undefined, run.id)).toBeNull();
    await applySessionPhase(run.id, 'session:input', 'session.ts:handleSend', { sessionId: 'run-q', sendSource: 'peer' });
    const adopted = await getTask(run.id);
    expect(adopted.tags ?? []).toEqual([]);
    expect(isProgramRunTask(adopted)).toBe(false);
  });

  it("into a person's own import: adopted as any input does, with no marker", async () => {
    hosts.set(LOCAL, { candidates: [candidate('person-p')], described: {} });
    await importExternalSessions();
    const mine = await taskForSession('person-p');
    await applySessionPhase(mine.id, 'session:input', 'session.ts:handleSend', { sessionId: 'person-p', sendSource: PROGRAM_RUN_SEND_SOURCE });
    expect((await getTask(mine.id)).tags ?? []).toEqual([]);
  });

  it('into a regular task: it marks nothing', async () => {
    const { task } = await addTask({ title: 'Mine', project: PROJECT, source: 'local', _skipPluginOps: true });
    await applySessionPhase(task.id, 'session:input', 'session.ts:handleSend', { sendSource: PROGRAM_RUN_SEND_SOURCE });
    expect((await getTask(task.id)).tags ?? []).toEqual([]);
    expect(isProgramRunTask(await getTask(task.id))).toBe(false);
  });
});

describe('class guard 7c: every reader of "a program run" asks the one helper', () => {
  it('only types.ts reads the markers; the files that name them write them, and the readers call isProgramRunTask', async () => {
    const { loadSources } = await import('../helpers/source-files.js');
    const src = await loadSources(process.cwd(), ['src', 'web/src']);
    // Nobody tests a marker by hand: types.ts holds the only checks.
    expect(src.filesWith(/\.includes\((?:PROGRAM_RUN_TAG|PLUGIN_RUN_TAG)\)|'walnut:(?:program|plugin)-run'/)).toEqual(['src/core/types.ts']);
    // The files that name a marker: its writers (mint, stamp, adopt, keep), each one on purpose.
    expect(src.filesWith(/\b(?:PROGRAM_RUN_TAG|PLUGIN_RUN_TAG)\b/)).toEqual([
      'src/core/plugins/server-api.ts', 'src/core/sessions/external-session-import.ts', 'src/core/sessions/plugin-run.ts',
      'src/core/task-manager.ts', 'src/core/types.ts', 'src/web/routes/api-v1.ts',
    ]);
    // Who reads "a program's run": the status, the read marker, org follow, status push, team notes, the importer,
    // and who-sends-decides (plugin-run.ts).
    expect(src.filesWith(/\bisProgramRunTask\(/)).toEqual([
      'src/core/org/team-note.ts', 'src/core/phase.ts', 'src/core/sessions/external-session-import.ts', 'src/core/sessions/org-follow.ts',
      'src/core/sessions/plugin-run.ts', 'src/core/sessions/status-push.ts', 'src/core/types.ts', 'src/core/user-status-sync.ts',
    ]);
  });
});
