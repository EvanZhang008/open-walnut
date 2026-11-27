/**
 * Release B of the prompt split (design section 3.2, test 2): the strip job runs only once its gate
 * (src/core/session-prompt-gate.ts) found that every build this home can go back to reads the split,
 * and until then the writer keeps every text in its payload; a strip run twice moves nothing the
 * second time and sets its marker once; once almost no row holds a text the full scan reads the
 * payloads as they are, with the same records as the guarded scan; and a stripped row whose payload
 * holds a `systemPrompt` string in another object still reads as split (json_type, not a substring).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-prompt-strip'));
// A process killed at the forget of the list of releases: the forget throws, as a kill would end it there.
const death = vi.hoisted(() => ({ atForget: false }));
vi.mock('../../src/core/session-prompt-gate.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/core/session-prompt-gate.js')>();
  return {
    ...real,
    forgetServedVersions: (h: Parameters<typeof real.forgetServedVersions>[0]) => {
      if (death.atForget) throw new Error('test: killed at the forget');
      real.forgetServedVersions(h);
    },
  };
});

import { WALNUT_HOME } from '../../src/constants.js';
import {
  closeDb, dbGeneration, getDb, PLAIN_SCAN_MAX_TEXT_ROWS, PROMPT_SPLIT_MARKER, promptTextsInPayload, sessionScanStats, TEXT_ROWS_INDEX,
} from '../../src/core/session-db.js';
import { runPromptJob, runPromptPass } from '../../src/core/session-prompt-jobs.js';
import { deployRollbackBuilds, LAST_RELEASE_WITHOUT_SPLIT, noteServedVersion, promptStripGate, servedVersions } from '../../src/core/session-prompt-gate.js';
import { SPLIT_PROMPT_ROWS_SQL } from '../../src/core/session-prompts.js';
import { _resetServerRoleForTesting } from '../../src/core/server-role.js';
import {
  _dropSessionStoreCacheForTesting, _resetSessionTrackerForTesting, createSessionRecord, getSessionByClaudeId, listSessions, updateSessionRecord,
} from '../../src/core/session-tracker.js';
import type { SessionRecord } from '../../src/core/types.js';

// Unicode as test data, in an escape.
const PROMPT = 'spawn \u4e2d '.repeat(800);
const PERSONA = 'persona '.repeat(600);
const OPEN = async () => ({ open: true, reason: 'test: open' });
const CLOSED = async () => ({ open: false, reason: 'test: closed' });

beforeEach(async () => {
  closeDb();
  _resetSessionTrackerForTesting();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
});
afterEach(() => { closeDb(); _resetSessionTrackerForTesting(); });

function payload(sid: string): Record<string, any> {
  const p = getDb()!.prepare('SELECT payload FROM sessions WHERE claude_session_id = ?').pluck().get(sid) as string | null;
  return p ? JSON.parse(p) : {};
}
const holdsText = (sid: string) => /"appliedAppendSystemPrompt":"|"systemPrompt":"/.test(JSON.stringify(payload(sid)));
const markers = () => Number(getDb()!.prepare('SELECT count(*) FROM session_migrations WHERE id = ?').pluck().get(PROMPT_SPLIT_MARKER));

async function seed(n: number, prefix = 's'): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const sid = `${prefix}-${i}`;
    await createSessionRecord(sid, '', 'demo', '/w', {
      initialProcessStatus: i % 2 ? 'stopped' : 'idle',
      ...(i % 3 !== 2 ? { appliedAppendSystemPrompt: `${PROMPT}${i}` } : {}),
      ...(i % 3 !== 1 ? { profile: { systemPrompt: `${PERSONA}${i}`, allowedTools: ['Read'] } } : {}),
    });
    ids.push(sid);
  }
  return ids;
}
const whole = (ids: string[]) => Promise.all(ids.map((id) => getSessionByClaudeId(id)));

describe('the strip job waits for its gate', () => {
  it('closed: no row is stripped, a status write keeps its texts in the payload, and no marker is set', async () => {
    const ids = await seed(6);
    const before = await whole(ids);
    const r = await runPromptJob({ gate: CLOSED, version: '9.9.9' });
    expect(r.gate.open).toBe(false);
    expect(r.strip).toBeUndefined();
    expect(promptTextsInPayload()).toBe(true);
    await updateSessionRecord('s-0', { process_status: 'running', activity: 'processing' });
    expect(holdsText('s-0')).toBe(true);
    expect(ids.filter((id) => holdsText(id))).toHaveLength(ids.length);
    expect(markers()).toBe(0);
    const after = await whole(ids);
    expect(after.slice(1)).toEqual(before.slice(1));
    expect(pick(after[0]!)).toEqual(pick(before[0]!));
    // The job noted this release as one that served the store.
    expect(servedVersions(getDb()!)).toEqual(['9.9.9']);
  });

  it('open: every row is stripped, a later write leaves only the stubs, every record reads back the same', async () => {
    const ids = await seed(9);
    const before = await whole(ids);
    const r = await runPromptJob({ gate: OPEN, version: '9.9.9' });
    expect(r.strip?.rows).toBe(9);
    expect(promptTextsInPayload()).toBe(false);
    expect(ids.filter((id) => holdsText(id))).toEqual([]);
    await updateSessionRecord('s-0', { title: 'after the gate' });
    expect(holdsText('s-0')).toBe(false);
    await createSessionRecord('new-1', '', 'demo', '/w', { appliedAppendSystemPrompt: PROMPT, profile: { systemPrompt: PERSONA } });
    expect(holdsText('new-1')).toBe(false);
    expect((await getSessionByClaudeId('new-1'))?.profile?.systemPrompt).toBe(PERSONA);
    const after = await whole(ids);
    for (const [i, id] of ids.entries()) {
      const want = id === 's-0' ? { ...before[i]!, title: 'after the gate' } : before[i]!;
      expect(stripVolatile(after[i]!), id).toEqual(stripVolatile(want));
    }
  });
});

/** The fields a write moves on its own (its time and revision), left out of a comparison. */
function stripVolatile(r: SessionRecord): Partial<SessionRecord> {
  const { lastActiveAt: _a, statusRevision: _r, statusUpdatedAt: _u, last_status_change: _c, statusHistory: _h, ...rest } = r as SessionRecord & Record<string, unknown>;
  return rest;
}
function pick(r: SessionRecord): Partial<SessionRecord> {
  return { appliedAppendSystemPrompt: r.appliedAppendSystemPrompt, profile: r.profile };
}

describe('a row with one text back in its payload and the other only in the table', () => {
  /** What a build before the split does to a stripped row: sets a new spawn prompt, keeps the stubs it does not know, leaves the column NULL. */
  function olderBuildSetsSpawnPrompt(sid: string, text: string): void {
    const p = payload(sid);
    p.appliedAppendSystemPrompt = text;
    getDb()!.prepare('UPDATE sessions SET payload = ?, prompt_text_refs = NULL WHERE claude_session_id = ?').run(JSON.stringify(p), sid);
    _dropSessionStoreCacheForTesting();
  }
  const both = async (sid: string) => { const r = await getSessionByClaudeId(sid); return [r?.appliedAppendSystemPrompt, r?.profile?.systemPrompt]; };

  it('the strip keeps the persona\'s stub, so the table\'s persona is still read', async () => {
    await createSessionRecord('m1', '', 'demo', '/w', { appliedAppendSystemPrompt: PROMPT, profile: { systemPrompt: PERSONA } });
    await runPromptJob({ gate: OPEN, version: '9.9.9' });
    olderBuildSetsSpawnPrompt('m1', 'newer spawn prompt');
    expect(await both('m1')).toEqual(['newer spawn prompt', PERSONA]);
    expect((await runPromptPass('strip')).rows).toBe(1);
    _dropSessionStoreCacheForTesting();
    expect(await both('m1')).toEqual(['newer spawn prompt', PERSONA]);
    expect(holdsText('m1')).toBe(false);
    expect(payload('m1').profile.systemPromptRef.sha256).toBeTruthy();
  });

  it('a write past the gate keeps it too', async () => {
    await createSessionRecord('m2', '', 'demo', '/w', { appliedAppendSystemPrompt: PROMPT, profile: { systemPrompt: PERSONA } });
    await runPromptJob({ gate: OPEN, version: '9.9.9' });
    olderBuildSetsSpawnPrompt('m2', 'newer spawn prompt');
    await updateSessionRecord('m2', { title: 'a status write' });
    _dropSessionStoreCacheForTesting();
    expect(await both('m2')).toEqual(['newer spawn prompt', PERSONA]);
    expect(holdsText('m2')).toBe(false);
  });
});

describe('the gate after a build before the split wrote the store', () => {
  const realGate = (version: string) => (h: Parameters<typeof promptStripGate>[0]) => promptStripGate(h, { rollbackBuilds: [], version });

  it('stays closed for that open, and opens only after a later release served the store again', async () => {
    await seed(3);
    expect((await runPromptJob({ gate: realGate('0.6.38'), version: '0.6.38' })).gate.open).toBe(false);
    // Weeks on 0.6.37: its writes leave the column NULL.
    getDb()!.prepare("UPDATE sessions SET prompt_text_refs = NULL WHERE claude_session_id = 's-1'").run();
    const back = await runPromptJob({ gate: realGate('0.6.39'), version: '0.6.39' });
    expect(back.gate).toMatchObject({ open: false, reason: expect.stringContaining('build before the prompt split') });
    expect(back.strip).toBeUndefined();
    expect(servedVersions(getDb()!)).toEqual(['0.6.39']);
    expect((await runPromptJob({ gate: realGate('0.6.39'), version: '0.6.39' })).gate.open).toBe(false);
    const next = await runPromptJob({ gate: realGate('0.6.40'), version: '0.6.40' });
    expect(next.gate).toMatchObject({ open: true, olderVersion: '0.6.39' });
    expect(next.strip?.rows).toBe(3);
  });

  it('a kill after the fill and before the forget still leaves the gate closed on the next open', async () => {
    await seed(3);
    await runPromptJob({ gate: realGate('0.6.38'), version: '0.6.38' });
    // Weeks on 0.6.37, then 0.6.39 is killed between its fill and its forget.
    getDb()!.prepare("UPDATE sessions SET prompt_text_refs = NULL WHERE claude_session_id = 's-1'").run();
    death.atForget = true;
    try {
      await expect(runPromptJob({ gate: realGate('0.6.39'), version: '0.6.39' })).rejects.toThrow('killed at the forget');
    } finally {
      death.atForget = false;
    }
    closeDb();
    _resetSessionTrackerForTesting();
    const next = await runPromptJob({ gate: realGate('0.6.39'), version: '0.6.39' });
    expect(next.gate.open).toBe(false);
    expect(next.strip).toBeUndefined();
    expect(holdsText('s-0')).toBe(true);
  });

  it('a server that stopped being the leader after the job was armed does not strip', async () => {
    await seed(3);
    const was = process.env.WALNUT_HOST_SERVER;
    process.env.WALNUT_HOST_SERVER = '1';
    _resetServerRoleForTesting();
    try {
      const r = await runPromptJob({ gate: OPEN, version: '9.9.9' });
      expect(r.gate).toMatchObject({ open: false, reason: expect.stringContaining('not the leader') });
      expect(r.strip).toBeUndefined();
    } finally {
      if (was === undefined) delete process.env.WALNUT_HOST_SERVER; else process.env.WALNUT_HOST_SERVER = was;
      _resetServerRoleForTesting();
    }
    expect(promptTextsInPayload()).toBe(true);
    expect(holdsText('s-0')).toBe(true);
  });

  it('a store reopened between the arm and the job is not stripped', async () => {
    await seed(3);
    const armedAt = dbGeneration();
    closeDb();
    getDb();
    const r = await runPromptJob({ gate: OPEN, version: '9.9.9', generation: armedAt });
    expect(r.gate.open).toBe(false);
    expect(r.strip).toBeUndefined();
    expect(holdsText('s-0')).toBe(true);
  });

  it('a store reopened while the gate was asked is not stripped', async () => {
    await seed(3);
    const r = await runPromptJob({ version: '9.9.9', gate: async () => { closeDb(); getDb(); return { open: true, reason: 'test: open' }; } });
    expect(r.gate).toMatchObject({ open: false, reason: expect.stringContaining('reopened') });
    expect(r.strip).toBeUndefined();
    expect(promptTextsInPayload()).toBe(true);
    expect(holdsText('s-0')).toBe(true);
  });
});

describe('strip idempotence (test 2)', () => {
  it('a second pass writes zero rows and the marker is set once', async () => {
    await seed(7);
    // Old-shape rows: what a build before the split wrote (texts, no stubs, no column).
    getDb()!.prepare('UPDATE sessions SET prompt_text_refs = NULL').run();
    const first = await runPromptPass('strip', { batchRows: 3 });
    expect(first.rows).toBe(7);
    expect(markers()).toBe(1);
    const changes = Number(getDb()!.prepare('SELECT total_changes()').pluck().get());
    const second = await runPromptPass('strip', { batchRows: 3 });
    expect(second.rows).toBe(0);
    // The marker's INSERT OR IGNORE is the only statement that ran, and it changed nothing.
    expect(Number(getDb()!.prepare('SELECT total_changes()').pluck().get())).toBe(changes);
    expect(markers()).toBe(1);
  });
});

describe('the scan once almost no row holds a text', () => {
  it('reads stripped rows plain and the few text rows through the guarded SQL, with the guarded scan\'s records', async () => {
    const ids = await seed(8);
    await runPromptJob({ gate: OPEN, version: '9.9.9' });
    // Two rows a build before the split wrote since: text back in the payload, the column NULL.
    for (const sid of ['s-1', 's-4']) {
      const p = payload(sid);
      p.appliedAppendSystemPrompt = `older build ${sid}`;
      getDb()!.prepare('UPDATE sessions SET payload = ?, prompt_text_refs = NULL WHERE claude_session_id = ?').run(JSON.stringify(p), sid);
    }
    expect(getDb()!.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(TEXT_ROWS_INDEX)).toBeTruthy();
    const plan = getDb()!.prepare(`EXPLAIN QUERY PLAN SELECT count(*) FROM sessions INDEXED BY ${TEXT_ROWS_INDEX} WHERE coalesce(prompt_text_refs, '') <> '{}'`).all() as Array<{ detail: string }>;
    expect(plan.map((p) => p.detail).join(' ')).toContain(TEXT_ROWS_INDEX);
    _dropSessionStoreCacheForTesting();
    const plainBefore = sessionScanStats().plain;
    const listed = await listSessions();
    expect(sessionScanStats().plain).toBe(plainBefore + 1);
    expect(listed.map((r) => r.claudeSessionId).sort()).toEqual([...ids].sort());
    expect(listed.every((r) => r.appliedAppendSystemPrompt === undefined && r.profile?.systemPrompt === undefined)).toBe(true);
    expect(listed.find((r) => r.claudeSessionId === 's-1')?.appliedAppendSystemPromptRef?.bytes).toBe(Buffer.byteLength('older build s-1'));

    // The same records as the guarded scan of every row (the index gone).
    closeDb();
    _resetSessionTrackerForTesting();
    getDb()!.exec(`DROP INDEX IF EXISTS ${TEXT_ROWS_INDEX}`);
    const guardedBefore = sessionScanStats().guarded;
    const guarded = await listSessions();
    expect(sessionScanStats().guarded).toBe(guardedBefore + 1);
    expect(guarded).toEqual(listed);
  });

  it('with more text rows than the plain scan takes, one guarded query reads them all', async () => {
    await seed(PLAIN_SCAN_MAX_TEXT_ROWS + 1);
    _dropSessionStoreCacheForTesting();
    const guardedBefore = sessionScanStats().guarded;
    const listed = await listSessions();
    expect(sessionScanStats().guarded).toBe(guardedBefore + 1);
    expect(listed.every((r) => r.appliedAppendSystemPrompt === undefined && r.profile?.systemPrompt === undefined)).toBe(true);
  });
});

describe('a split row is told by the JSON path\'s type', () => {
  it('a stripped persona whose payload has another object\'s systemPrompt string still counts as split', async () => {
    await createSessionRecord('lane', '', 'demo', '/w', { profile: { systemPrompt: PERSONA }, initialProcessStatus: 'stopped' });
    await runPromptPass('strip');
    const p = payload('lane');
    p.agentDraft = { systemPrompt: 'a quoted "systemPrompt":"x" elsewhere' };
    getDb()!.prepare('UPDATE sessions SET payload = ? WHERE claude_session_id = ?').run(JSON.stringify(p), 'lane');
    expect(Number((getDb()!.prepare(SPLIT_PROMPT_ROWS_SQL).get() as { n: number }).n)).toBe(1);
    // The persona back in the payload (a build before the split wrote it): no longer split.
    p.profile.systemPrompt = 'back';
    getDb()!.prepare('UPDATE sessions SET payload = ? WHERE claude_session_id = ?').run(JSON.stringify(p), 'lane');
    expect(Number((getDb()!.prepare(SPLIT_PROMPT_ROWS_SQL).get() as { n: number }).n)).toBe(0);
  });
});

describe('the strip gate', () => {
  it('elsewhere than a deploy: open only after an older release that reads the split served the store', async () => {
    const db = getDb()!;
    expect((await promptStripGate(db, { rollbackBuilds: [], version: '0.6.40' })).open).toBe(false);
    noteServedVersion(db, '0.6.40');
    // Only itself: the release before it may be from before the split.
    expect((await promptStripGate(db, { rollbackBuilds: [], version: '0.6.40' })).open).toBe(false);
    // A newer release that served it says nothing of the one before this.
    noteServedVersion(db, '0.6.41');
    expect((await promptStripGate(db, { rollbackBuilds: [], version: '0.6.40' })).open).toBe(false);
    expect(await promptStripGate(db, { rollbackBuilds: [], version: '0.6.41' })).toMatchObject({ open: true, olderVersion: '0.6.40' });
    // A nightly of the next release is newer than the release it follows.
    expect((await promptStripGate(db, { rollbackBuilds: [], version: '0.6.42-nightly.20261201' })).olderVersion).toBe('0.6.41');
    // A build of main between releases reports the last release; that number's published build
    // cannot read the split, so its record opens nothing.
    const fresh = getDb()!;
    fresh.exec('DELETE FROM session_store_versions');
    noteServedVersion(fresh, LAST_RELEASE_WITHOUT_SPLIT);
    expect((await promptStripGate(fresh, { rollbackBuilds: [], version: '0.6.38' })).open).toBe(false);
    noteServedVersion(fresh, '0.6.38');
    expect((await promptStripGate(fresh, { rollbackBuilds: [], version: '0.6.39' })).open).toBe(true);
    noteServedVersion(fresh, '0.6.40');
    noteServedVersion(fresh, '0.6.41');
    // A version that does not parse is not recorded and never opens it.
    noteServedVersion(db, '0.0.0-garbled version');
    expect((await promptStripGate(db, { rollbackBuilds: [], version: null })).open).toBe(false);
    expect(servedVersions(db).sort()).toEqual([LAST_RELEASE_WITHOUT_SPLIT, '0.6.38', '0.6.40', '0.6.41']);
  });

  it('on a deploy: every rollback build must answer the probe, whatever the store recorded', async () => {
    const db = getDb()!;
    noteServedVersion(db, '0.6.40');
    const asked: string[] = [];
    const reads = (ok: Set<string>) => async (f: string) => { asked.push(f); return ok.has(f); };
    expect((await promptStripGate(db, { rollbackBuilds: ['/lkg', '/good'], version: '0.6.41', reads: reads(new Set(['/lkg'])) })))
      .toMatchObject({ open: false, reason: expect.stringContaining('/good') });
    expect((await promptStripGate(db, { rollbackBuilds: ['/lkg', '/good'], version: '0.6.37', reads: reads(new Set(['/lkg', '/good'])) })).open).toBe(true);
    expect(asked).toEqual(['/lkg', '/good', '/lkg', '/good']);
  });

  it('finds the deploy\'s last-known-good file and the launcher\'s good version as the deploy lays them out', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-gate-builds.'));
    try {
      const target = `walnut-${process.platform}-${process.arch}`;
      const state = path.join(root, 'state');
      const lkg = path.join(state, 'open-walnut/open-walnut-lkg/dist-bin', target);
      const version = path.join(state, 'open-walnut/service/versions/open-walnut-stage.1.2');
      fs.mkdirSync(path.dirname(lkg), { recursive: true });
      fs.writeFileSync(lkg, '');
      fs.mkdirSync(path.join(version, 'dist-bin'), { recursive: true });
      fs.writeFileSync(path.join(version, 'dist-bin', target), '');
      fs.mkdirSync(path.join(state, 'open-walnut/service/launcher'), { recursive: true });
      fs.writeFileSync(path.join(state, 'open-walnut/service/launcher/state'), `current=${version}/run\ngood=${version}/run\nphase=committed\n`);
      const env = { XDG_STATE_HOME: state, TMPDIR: path.join(root, 'tmp') };
      if (process.platform === 'darwin' || process.platform === 'linux') {
        expect(deployRollbackBuilds(env, root)).toEqual([lkg, path.join(version, 'dist-bin', target)]);
      }
      // A machine that never ran the deploy has none.
      expect(deployRollbackBuilds({ XDG_STATE_HOME: path.join(root, 'none'), TMPDIR: path.join(root, 'tmp') }, root)).toEqual([]);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
