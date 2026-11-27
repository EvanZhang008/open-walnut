/**
 * A strip pass killed in the middle (design section 3.5, test 3): a child process strips the store
 * and is SIGKILLed after N batches. On reopen the file is intact, every row is in one shape or the
 * other (its texts in the payload, or only its stubs there and its texts in the prompt table), every
 * record reads back as before, and the next pass finishes the rest.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-prompt-crash'));

import { WALNUT_HOME } from '../../src/constants.js';
import { closeDb, getDb } from '../../src/core/session-db.js';
import { runPromptPass } from '../../src/core/session-prompt-jobs.js';
import { _resetSessionTrackerForTesting, createSessionRecord, getSessionByClaudeId } from '../../src/core/session-tracker.js';
import type { SessionRecord } from '../../src/core/types.js';

const CHILD = path.resolve(import.meta.dirname, '../helpers/prompt-strip-child.ts');
const ROWS = 24;

beforeEach(async () => {
  closeDb();
  _resetSessionTrackerForTesting();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
});
afterEach(() => { closeDb(); _resetSessionTrackerForTesting(); });

/** Run the child's strip; SIGKILL it once it printed `killAfter` batches. Resolves how it ended. */
function stripInChild(killAfter: number, holdAtUpdate = 0): Promise<{ signal: string | null; batches: number; done: boolean; inTx: boolean }> {
  return new Promise((resolve, reject) => {
    const kid = spawn(process.execPath, [CHILD], {
      env: {
        ...process.env, OPEN_WALNUT_HOME: WALNUT_HOME, NODE_ENV: 'test', WALNUT_DAEMON_DIR: path.join(WALNUT_HOME, 'daemon'), WALNUT_LOG_LEVEL: 'error',
        STRIP_HOLD_AT_UPDATE: String(holdAtUpdate),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let batches = 0;
    let done = false;
    let inTx = false;
    let err = '';
    kid.stdout.on('data', (d: Buffer) => {
      for (const line of String(d).split('\n')) {
        if (line.startsWith('batch ')) batches = Number(line.slice(6));
        if (line === 'done') done = true;
        if (line === 'in-tx') inTx = true;
      }
      if ((holdAtUpdate > 0 ? inTx : batches >= killAfter) && kid.exitCode === null && kid.signalCode === null && kid.pid && kid.pid > 1) kid.kill('SIGKILL');
    });
    kid.stderr.on('data', (d: Buffer) => { err += String(d); });
    kid.on('error', reject);
    kid.on('exit', (code, signal) => {
      if (signal !== 'SIGKILL' && code !== 0) reject(new Error(`strip child exited ${code}: ${err.slice(-2000)}`));
      else resolve({ signal, batches, done, inTx });
    });
  });
}

function shapes(): { old: number; stripped: number; mixed: string[] } {
  const db = getDb()!;
  const table = new Map<string, Set<string>>();
  for (const r of db.prepare('SELECT claude_session_id AS sid, field FROM session_prompts').all() as Array<{ sid: string; field: string }>) {
    if (!table.has(r.sid)) table.set(r.sid, new Set());
    table.get(r.sid)!.add(r.field);
  }
  const out = { old: 0, stripped: 0, mixed: [] as string[] };
  for (const r of db.prepare('SELECT claude_session_id AS sid, payload FROM sessions').all() as Array<{ sid: string; payload: string }>) {
    const p = JSON.parse(r.payload);
    const texts = [typeof p.appliedAppendSystemPrompt === 'string', typeof p.profile?.systemPrompt === 'string'];
    const stubs = [!!p.appliedAppendSystemPromptRef && !p.appliedAppendSystemPromptRef.inline, !!p.profile?.systemPromptRef && !p.profile.systemPromptRef.inline];
    if (texts.some(Boolean) && !stubs.some(Boolean)) out.old++;
    else if (!texts.some(Boolean) && stubs.some(Boolean) && (!stubs[0] || table.get(r.sid)?.has('appliedAppendSystemPrompt')) && (!stubs[1] || table.get(r.sid)?.has('profile.systemPrompt'))) out.stripped++;
    else out.mixed.push(r.sid);
  }
  return out;
}

describe('a strip killed in the middle (test 3)', () => {
  it('leaves every row in one shape or the other, loses nothing, and the next pass finishes', { timeout: 120_000 }, async () => {
    const ids: string[] = [];
    for (let i = 0; i < ROWS; i++) {
      const sid = `c-${String(i).padStart(2, '0')}`;
      await createSessionRecord(sid, '', 'demo', '/w', {
        initialProcessStatus: 'stopped',
        appliedAppendSystemPrompt: `spawn \u4e2d ${i} `.repeat(400),
        ...(i % 2 ? { profile: { systemPrompt: `persona ${i} `.repeat(300) } } : {}),
      });
      ids.push(sid);
    }
    // Old-shape rows, as a build before the split left them (no stubs, no column).
    getDb()!.exec("UPDATE sessions SET payload = json_remove(payload, '$.appliedAppendSystemPromptRef', '$.profile.systemPromptRef'), prompt_text_refs = NULL");
    const want = new Map<string, SessionRecord | null>();
    for (const id of ids) want.set(id, await getSessionByClaudeId(id));
    closeDb();
    _resetSessionTrackerForTesting();

    let left = ROWS;
    for (const n of [2, 4]) {
      const run = await stripInChild(n);
      expect(run.signal).toBe('SIGKILL');
      expect(run.done).toBe(false);
      expect(getDb()!.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
      const s = shapes();
      expect(s.mixed).toEqual([]);
      expect(s.old + s.stripped).toBe(ROWS);
      // Some rows moved, some are still to do.
      expect(s.old).toBeLessThan(left);
      expect(s.old).toBeGreaterThan(0);
      left = s.old;
      for (const id of ids) expect(await getSessionByClaudeId(id), id).toEqual(want.get(id));
      closeDb();
      _resetSessionTrackerForTesting();
    }

    const finish = await runPromptPass('strip');
    expect(finish.rows).toBe(left);
    expect(shapes()).toEqual({ old: 0, stripped: ROWS, mixed: [] });
    for (const id of ids) expect(await getSessionByClaudeId(id), id).toEqual(want.get(id));
  });

  it('a kill inside a batch\'s open transaction loses that whole batch, and nothing else', { timeout: 120_000 }, async () => {
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      const sid = `t-${i}`;
      await createSessionRecord(sid, '', 'demo', '/w', { initialProcessStatus: 'stopped', appliedAppendSystemPrompt: `spawn \u4e2d ${i} `.repeat(400), profile: { systemPrompt: `persona ${i} `.repeat(300) } });
      ids.push(sid);
    }
    getDb()!.exec("UPDATE sessions SET payload = json_remove(payload, '$.appliedAppendSystemPromptRef', '$.profile.systemPromptRef'), prompt_text_refs = NULL");
    const want = new Map<string, SessionRecord | null>();
    for (const id of ids) want.set(id, await getSessionByClaudeId(id));
    closeDb();
    _resetSessionTrackerForTesting();
    // Batches of 2 rows: the 6th row write is the second of batch 3, after its first was written.
    const run = await stripInChild(0, 6);
    expect(run).toMatchObject({ signal: 'SIGKILL', inTx: true, batches: 2, done: false });
    expect(getDb()!.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
    // Batches 1 and 2 committed (4 rows); batch 3's first row rolled back with it.
    expect(shapes()).toEqual({ old: 6, stripped: 4, mixed: [] });
    for (const id of ids) expect(await getSessionByClaudeId(id), id).toEqual(want.get(id));
    expect((await runPromptPass('strip')).rows).toBe(6);
    expect(shapes()).toEqual({ old: 0, stripped: 10, mixed: [] });
    for (const id of ids) expect(await getSessionByClaudeId(id), id).toEqual(want.get(id));
  });
});
