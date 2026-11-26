/**
 * A scan of the session store cache never reads a stopped session's heavy prompt fields into JS.
 *
 * 2026-11-25 on the Mac: 7.7k session rows, 75 MB of payload text, 56 MB of it the spawn prompt and
 * persona of stopped sessions. Each whole-table `SELECT *` made about 380 MB of row text and records (150 MB now)
 * only for slimForCache to drop those two fields again, and a start ran 5 to 17 such scans in its
 * first minutes (the `memory burst` lines' sessionStore.fullScans): heapUsed 1.1 to 2.5 GB and
 * external 0.9 to 2 GB while the kept caches were 200 to 360 MB. The scan now asks SQLite for the
 * payload without them (session-db.ts sessionCacheRowsSql).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import {
  createSessionRecord, listSessions, updateSessionRecord,
  _dropSessionStoreCacheForTesting, _resetSessionTrackerForTesting, _sessionStoreStatsForTesting,
} from '../../src/core/session-tracker.js';
import { closeDb, getDb, rowToSession } from '../../src/core/session-db.js';
import { WALNUT_HOME } from '../../src/constants.js';

// Non-ASCII on purpose: SQLite's rewrite of the payload keeps it.
const PROMPT = 'spawn prompt \u4e2d\u6587 '.repeat(600);
const PERSONA = 'persona text '.repeat(900);
const STOPPED = 12;

beforeEach(async () => {
  closeDb();
  _resetSessionTrackerForTesting();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
});
afterEach(async () => {
  vi.restoreAllMocks();
  closeDb();
  _resetSessionTrackerForTesting();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {});
});

async function seed(id: string, status: 'running' | 'stopped' | 'error'): Promise<void> {
  await createSessionRecord(id, `task-${id}`, 'demo');
  await updateSessionRecord(id, {
    process_status: status, appliedAppendSystemPrompt: PROMPT, title: `title ${id}`,
    profile: { systemPrompt: PERSONA, label: 'lane' } as never,
  });
}

/** Payload text each statement over the sessions table hands to JS, while `fn` runs. */
async function payloadCharsReadBy(fn: () => Promise<unknown>): Promise<number> {
  const db = getDb()!;
  // Every statement of the wrapper shares one prototype, so a statement compiled earlier (and kept
  // by the per-connection statement cache) is counted too.
  const proto = Object.getPrototypeOf(db.prepare('SELECT 1')) as { all: (...p: unknown[]) => unknown[] };
  const real = proto.all;
  let chars = 0;
  vi.spyOn(proto, 'all').mockImplementation(function (this: { source?: string }, ...params: unknown[]) {
    const rows = real.apply(this, params);
    if (/\bFROM sessions\b/.test(this.source ?? '')) {
      for (const r of rows as Array<Record<string, unknown>>) if (typeof r?.payload === 'string') chars += r.payload.length;
    }
    return rows;
  });
  try { await fn(); } finally { vi.mocked(proto.all).mockRestore(); }
  return chars;
}

describe('session store scan: heavy prompt fields stay in SQLite', () => {
  it('a full scan reads a small part of the payload text, and lists the same records as before', async () => {
    for (let i = 0; i < STOPPED; i++) await seed(`s-stopped-${i}`, i % 3 === 0 ? 'error' : 'stopped');
    await seed('s-live', 'running');
    _dropSessionStoreCacheForTesting();
    const scansBefore = _sessionStoreStatsForTesting().fullScans;
    let listed: Awaited<ReturnType<typeof listSessions>> = [];
    const chars = await payloadCharsReadBy(async () => { listed = await listSessions(); });
    expect(_sessionStoreStatsForTesting().fullScans).toBe(scansBefore + 1);
    // The live row keeps its fields (the cache holds them); the stopped ones' never reach JS.
    // Old code: every row's prompt and persona, about 13 times this bound.
    expect(chars).toBeLessThan(2 * (PROMPT.length + PERSONA.length));

    // The same records slimForCache made of a whole `SELECT *` row.
    const whole = (getDb()!.prepare('SELECT * FROM sessions').all() as Array<Record<string, unknown>>).map(rowToSession);
    const expected = whole.map((r) => {
      if (r.process_status !== 'stopped' && r.process_status !== 'error') return r;
      const slim = { ...r };
      delete slim.appliedAppendSystemPrompt;
      const { systemPrompt: _persona, ...rest } = r.profile!;
      slim.profile = rest as typeof r.profile;
      return slim;
    });
    const byId = (rows: typeof expected) => new Map(rows.map((r) => [r.claudeSessionId, r]));
    expect(byId(listed)).toEqual(byId(expected));
    expect(listed.find((r) => r.claudeSessionId === 's-live')?.appliedAppendSystemPrompt).toBe(PROMPT);
  });

  it('a row whose payload is not JSON reads as before', async () => {
    await seed('s-bad', 'stopped');
    await seed('s-good', 'stopped');
    getDb()!.prepare('UPDATE sessions SET payload = ? WHERE claude_session_id = ?').run('{"systemPrompt": not json', 's-bad');
    _dropSessionStoreCacheForTesting();
    const listed = new Map((await listSessions()).map((r) => [r.claudeSessionId, r]));
    expect(listed.get('s-bad')?.title).toBe('title s-bad');
    expect(listed.get('s-good')?.appliedAppendSystemPrompt).toBeUndefined();
    expect((listed.get('s-good')?.profile as { label?: string } | undefined)?.label).toBe('lane');
  });

  it('the write-through patch reads a stopped row without them too', async () => {
    await seed('s1', 'stopped');
    await listSessions();
    const chars = await payloadCharsReadBy(() => updateSessionRecord('s1', { title: 'renamed' }));
    const listed = (await listSessions()).find((r) => r.claudeSessionId === 's1');
    expect(listed?.title).toBe('renamed');
    expect(listed?.appliedAppendSystemPrompt).toBeUndefined();
    // Old code: the patch's `SELECT *` read the row's prompt and persona whole.
    expect(chars).toBeLessThan((PROMPT.length + PERSONA.length) / 2);
  });
});

/**
 * Every whole-table `SELECT *` of the sessions table in src/. The cache's scan goes through
 * sessionCacheRowsSql; the one left is the uncached path (WALNUT_STORE_CACHE=0), which hands
 * whole records out. A new one reads every stopped session's prompts into JS on each call:
 * read through the cache (listSessions, readStoreView) or select only the columns it needs.
 */
describe('ratchet: whole-table reads of the sessions table', () => {
  it('names each one', () => {
    const root = path.resolve(__dirname, '../..');
    const found: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!/\.tsx?$/.test(e.name)) continue;
        const text = fs.readFileSync(p, 'utf8');
        const n = text.match(/SELECT \* FROM sessions\s*['"`]/g)?.length ?? 0;
        if (n > 0) found.push(`${path.relative(root, p).split(path.sep).join('/')}:${n}`);
      }
    };
    walk(path.join(root, 'src'));
    expect(found.sort()).toEqual(['src/core/session-tracker.ts:1']);
  });
});
