/**
 * The session store cache never holds a session's two prompt texts, whatever its status
 * (prompt split, design section 5 test 8; this file replaces session-store-heavy-fields and
 * session-store-scan-bytes). The spawn prompt (`appliedAppendSystemPrompt`, about 22 KB) and a
 * lane's persona (`profile.systemPrompt`, up to 57 KB) were 59 of the Mac's 76 MB of payload
 * (2026-11-25, 7.7k rows): each full scan made hundreds of MB of row text only to drop them again.
 * A cached row carries their stubs (size, blank, and a hash when read from the row); a single-row
 * read has the texts; a list reader that needs one goes through withPromptFields.
 *
 * Ratchets below: (a) only session-db.ts names the prompt table; (b) every file that reads a
 * text says where its text comes from; (c) the allowed callers of the table's readers; (d) one
 * writer of the sessions table; and the whole-table `SELECT *` reads.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import {
  createSessionRecord, getSessionByClaudeId, listSessions, updateSessionRecord, withPromptFields,
  _dropSessionStoreCacheForTesting, _resetSessionTrackerForTesting, _sessionStoreStatsForTesting,
} from '../../src/core/session-tracker.js';
import { closeDb, decodeSessionRow, getDb } from '../../src/core/session-db.js';
import { WALNUT_HOME } from '../../src/constants.js';
import type { SessionRecord } from '../../src/core/types.js';

// Non-ASCII on purpose (as escapes): SQLite's rewrite of the payload keeps it, and sizes are bytes.
const PROMPT = 'spawn prompt \u4e2d\u6587 '.repeat(600);
const PERSONA = 'persona text '.repeat(900);
const STATUSES = ['running', 'idle', 'stopped', 'error'] as const;

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

async function seed(id: string, status: SessionRecord['process_status']): Promise<void> {
  await createSessionRecord(id, `task-${id}`, 'demo');
  await updateSessionRecord(id, {
    process_status: status, appliedAppendSystemPrompt: PROMPT, title: `title ${id}`,
    profile: { systemPrompt: PERSONA, label: 'lane' } as never,
  });
}

/** Payload text and prompt-table reads that statements hand to JS while `fn` runs. */
async function readsBy(fn: () => Promise<unknown>): Promise<{ payloadChars: number; promptReads: number }> {
  const db = getDb()!;
  // Every statement of the wrapper shares one prototype, so a statement compiled earlier (and kept
  // by the per-connection statement cache) is counted too.
  const proto = Object.getPrototypeOf(db.prepare('SELECT 1')) as Record<'all' | 'get', (...p: unknown[]) => unknown>;
  const seen = { payloadChars: 0, promptReads: 0 };
  for (const verb of ['all', 'get'] as const) {
    const real = proto[verb];
    vi.spyOn(proto, verb).mockImplementation(function (this: { source?: string }, ...params: unknown[]) {
      const out = real.apply(this, params);
      const source = this.source ?? '';
      if (/\bsession_prompts\b/.test(source)) seen.promptReads += 1;
      if (/\bFROM sessions\b/.test(source)) {
        for (const r of (verb === 'all' ? out : [out]) as Array<Record<string, unknown> | undefined>) {
          if (typeof r?.payload === 'string') seen.payloadChars += r.payload.length;
        }
      }
      return out;
    });
  }
  try { await fn(); } finally { vi.restoreAllMocks(); }
  return seen;
}

function withoutSha(record: SessionRecord): SessionRecord {
  const out = structuredClone(record);
  if (out.appliedAppendSystemPromptRef) delete out.appliedAppendSystemPromptRef.sha256;
  if (out.profile?.systemPromptRef) delete out.profile.systemPromptRef.sha256;
  return out;
}

describe('session store cache: no cached row holds a prompt text', () => {
  it('a row of every status is listed with stubs only, read whole by id, and filled by withPromptFields', async () => {
    for (const status of STATUSES) await seed(`s-${status}`, status);
    const listed = new Map((await listSessions()).map((s) => [s.claudeSessionId, s]));
    for (const status of STATUSES) {
      const row = listed.get(`s-${status}`)!;
      expect(row.appliedAppendSystemPrompt, status).toBeUndefined();
      expect(row.profile?.systemPrompt, status).toBeUndefined();
      expect(row.appliedAppendSystemPromptRef?.bytes).toBe(Buffer.byteLength(PROMPT));
      expect(row.profile?.systemPromptRef).toMatchObject({ bytes: Buffer.byteLength(PERSONA), blank: false });
      expect((row.profile as { label?: string } | undefined)?.label).toBe('lane');
      const whole = await getSessionByClaudeId(row.claudeSessionId);
      expect([whole?.appliedAppendSystemPrompt, whole?.profile?.systemPrompt]).toEqual([PROMPT, PERSONA]);
      expect(whole?.appliedAppendSystemPromptRef).toBeUndefined();
      const filled = withPromptFields(row);
      expect([filled.appliedAppendSystemPrompt, filled.profile?.systemPrompt]).toEqual([PROMPT, PERSONA]);
    }
  });

  it('a record with no prompt goes through withPromptFields as itself', async () => {
    await createSessionRecord('bare', '', 'demo');
    const row = (await listSessions()).find((s) => s.claudeSessionId === 'bare')!;
    expect(withPromptFields(row)).toBe(row);
  });

  it('a write to any status never erases them, and a session that comes back still lists stubs only', async () => {
    await seed('s1', 'stopped');
    await listSessions();
    await updateSessionRecord('s1', { title: 'renamed' });
    await updateSessionRecord('s1', { process_status: 'running' });
    await updateSessionRecord('s1', { process_status: 'idle', activity: 'processing' });
    const whole = await getSessionByClaudeId('s1');
    expect([whole?.appliedAppendSystemPrompt, whole?.profile?.systemPrompt]).toEqual([PROMPT, PERSONA]);
    const back = (await listSessions()).find((s) => s.claudeSessionId === 's1');
    expect(back?.appliedAppendSystemPrompt).toBeUndefined();
    expect(back?.appliedAppendSystemPromptRef?.bytes).toBe(Buffer.byteLength(PROMPT));
  });
});

describe('session store scan: the prompt texts stay in SQLite', () => {
  it('a full scan reads none of them and lists the stub records a whole read decodes to', async () => {
    for (let i = 0; i < 12; i++) await seed(`s-${i}`, STATUSES[i % STATUSES.length]!);
    _dropSessionStoreCacheForTesting();
    const scansBefore = _sessionStoreStatsForTesting().fullScans;
    let listed: SessionRecord[] = [];
    const seen = await readsBy(async () => { listed = await listSessions(); });
    expect(_sessionStoreStatsForTesting().fullScans).toBe(scansBefore + 1);
    // Old code: every live row's prompt and persona (about 6 times this bound); the code before
    // that, every row's.
    expect(seen.payloadChars).toBeLessThan(PROMPT.length);
    expect(seen.promptReads).toBe(0);

    // The same records decodeSessionRow makes of a whole row, less the hash a scan does not compute.
    const whole = (getDb()!.prepare('SELECT * FROM sessions WHERE claude_session_id LIKE ?').all('s-%') as Array<Record<string, unknown>>)
      .map((r) => withoutSha(decodeSessionRow(r)));
    const byId = (rows: SessionRecord[]) => new Map(rows.filter((r) => r.claudeSessionId.startsWith('s-')).map((r) => [r.claudeSessionId, r]));
    expect(byId(listed)).toEqual(byId(whole));
  });

  it('a row whose payload is not JSON reads as before', async () => {
    await seed('s-bad', 'stopped');
    await seed('s-good', 'running');
    getDb()!.prepare('UPDATE sessions SET payload = ? WHERE claude_session_id = ?').run('{"systemPrompt": not json', 's-bad');
    _dropSessionStoreCacheForTesting();
    const listed = new Map((await listSessions()).map((r) => [r.claudeSessionId, r]));
    expect(listed.get('s-bad')?.title).toBe('title s-bad');
    expect(listed.get('s-good')?.appliedAppendSystemPrompt).toBeUndefined();
    expect((listed.get('s-good')?.profile as { label?: string } | undefined)?.label).toBe('lane');
  });

  it('the write-through patch reads no prompt row, and caches a row of any status without its texts', async () => {
    for (const status of STATUSES) await seed(`p-${status}`, status);
    await listSessions();
    for (const status of STATUSES) {
      const seen = await readsBy(() => updateSessionRecord(`p-${status}`, { title: `renamed ${status}` }));
      expect(seen.promptReads, status).toBe(0);
      // The writer's own read (its transaction) and the patch's read of the row it wrote: each
      // reads the payload once (release A's payload still holds both texts for an older build).
      expect(seen.payloadChars, status).toBeLessThan(2 * (PROMPT.length + PERSONA.length) + 4000);
    }
    const listed = new Map((await listSessions()).map((r) => [r.claudeSessionId, r]));
    for (const status of STATUSES) {
      expect(listed.get(`p-${status}`)?.title).toBe(`renamed ${status}`);
      expect(listed.get(`p-${status}`)?.appliedAppendSystemPrompt).toBeUndefined();
    }
    // The patch reads its rows whole and decodes them in JS: the records are the full scan's.
    _dropSessionStoreCacheForTesting();
    const scanned = new Map((await listSessions()).map((r) => [r.claudeSessionId, r]));
    expect(scanned).toEqual(listed);
  });
});

// ── Ratchets over src/ ──

const ROOT = path.resolve(__dirname, '../..');
function sources(): Array<{ rel: string; text: string }> {
  const out: Array<{ rel: string; text: string }> = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.tsx?$/.test(e.name) || /\.test\./.test(e.name)) continue;
      out.push({ rel: path.relative(ROOT, p).split(path.sep).join('/'), text: fs.readFileSync(p, 'utf8') });
    }
  };
  walk(path.join(ROOT, 'src'));
  return out;
}

/** The top-level functions of a file, each with its text up to the next one. */
function functionsOf(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const heads = [...text.matchAll(/^(?:export )?(?:async )?function\*? ?(\w+)/gm)];
  heads.forEach((m, i) => out.set(m[1]!, text.slice(m.index!, heads[i + 1]?.index ?? text.length)));
  return out;
}

/** `file:function` for each top-level function whose text calls `name(`, its own definition left out. */
function callersOf(name: string): string[] {
  const found: string[] = [];
  const call = new RegExp(`\\b${name}\\(`);
  for (const { rel, text } of sources()) {
    if (!call.test(text)) continue;
    for (const [fn, body] of functionsOf(text)) {
      if (fn !== name && call.test(body)) found.push(`${rel}:${fn}`);
    }
    // A call outside every top-level function (a const arrow, a class method).
    const outside = [...functionsOf(text).values()].reduce((rest, body) => rest.replace(body, ''), text);
    if (call.test(outside)) found.push(`${rel}:<outside a top-level function>`);
  }
  return found.sort();
}

describe('ratchet (a): the prompt table is named in one file', () => {
  it('only src/core/session-db.ts names session_prompts', () => {
    expect(sources().filter((s) => /\bsession_prompts\b/.test(s.text)).map((s) => s.rel)).toEqual(['src/core/session-db.ts']);
  });
});

/**
 * Every file that reads the two texts, and where each takes its text from (re-checked for the
 * prompt split, 2026-11-26). "single-row" = getSessionByClaudeId, getSessionByLane or another
 * one-row read, which returns the record whole; "built" = it makes the value itself; "stub" = it
 * reads only a stub (size, blank, hash), which a cached row has; "withPromptFields" = a list row
 * filled whole. A NEW reader fails here: check where its record comes from (a listed row has no
 * text) and add it with its source.
 */
const AUDITED_READERS: Readonly<Record<string, string>> = {
  'src/core/offline-merge/apply-session.ts': 'built: writes both on a new record from the handover item',
  'src/core/replication/kinds/personas.ts': 'built: buildLaneProfile, never a session row',
  'src/core/replication/kinds/sessions.ts': 'names both (and the spawn stub) in PROCESS_FIELDS, which a copy leaves out',
  'src/core/router/session-policy.ts': 'stub: isRouterAreaSession asks hasPersona, true on a stub or a text',
  'src/core/router/simplify-migration.ts': 'withPromptFields: its backup reads each listed row whole',
  'src/core/session-db.ts': 'the codec: names the fields in the scan SQL, the stubs and the table',
  'src/core/session-prompts.ts': 'the codec helpers: stubs, changes and shapes; reads no record',
  'src/core/session-tracker.ts': 'single-row reads and writers in their transaction; withPromptFields',
  'src/core/sessions/ask-profile-prefix.ts': 'built: the profile buildLaneProfile made',
  'src/core/sessions/cloud-chat-lane.ts': 'built: the profile it builds; single-row: getSessionByClaudeId for the seed check',
  'src/core/sessions/instruction-notice.ts': 'single-row (open-items, the writer transaction); withPromptFields (host-slice)',
  'src/core/sessions/lane-turn-catch-up.ts': 'single-row: lane-turn reads getSessionByClaudeId',
  'src/core/sessions/own-readback.ts': 'single-row: open-items reads getSessionByClaudeId',
  'src/core/sessions/personal-ai-lane.ts': 'built: the lane profile; single-row: the context checks read getSessionByClaudeId',
  'src/core/sessions/place-notice.ts': 'single-row: open-items and the writer transaction',
  'src/core/sessions/prompt-refresh-respawn.ts': 'single-row: deps.getSession is getSessionByClaudeId',
  'src/core/sessions/prompt-refresh.ts': 'single-row text; promptOwedOnResume also answers on the stub bytes',
  'src/core/sessions/side-thread-fork.ts': 'built: writes the fork prefix it made',
  'src/core/sessions/session-row-owner.ts': 'names the fields in its owner table; reads no record',
  'src/core/sessions/spawn-prefix.ts': 'single-row: the session and its parent read by getSessionByClaudeId',
  'src/core/types.ts': 'the type',
  'src/providers/claude-code-session.ts': 'built: the profile passed to the spawn, or a single-row read at resume',
  'src/web/routes/context-inspector.ts': 'single-row: getSessionByClaudeId or getSessionByLane',
  'src/web/routes/sessions.ts': 'the list strips both (withoutPrompts); one session reads single-row',
};

describe('ratchet (b): readers of the prompt texts are audited', () => {
  it('names every file that reads them, each with its source, and no file that no longer does', () => {
    const found = sources()
      .filter((s) => s.rel !== 'src/providers/daemon-standalone.ts')
      .filter((s) => /appliedAppendSystemPrompt|profile\??\.systemPrompt/.test(s.text)).map((s) => s.rel);
    const audited = Object.keys(AUDITED_READERS);
    expect(found.filter((f) => !audited.includes(f)), 'new readers: check their record source').toEqual([]);
    expect(audited.filter((f) => !found.includes(f)), 'stale entries').toEqual([]);
  });
});

describe('ratchet (c): only named callers read the prompt table', () => {
  it('the table body is read only by the codec, and the codec\'s readers only by their named callers', () => {
    const db = functionsOf(fs.readFileSync(path.join(ROOT, 'src/core/session-db.ts'), 'utf8'));
    const bodyReaders = [...db].filter(([, body]) => /SELECT[^;]*\bbody\b[^;]*FROM session_prompts/.test(body)).map(([fn]) => fn).sort();
    // refreshPromptStubsIn: an offline home's stub refresh after the leader switch moved a path in a text.
    expect(bodyReaders).toEqual(['refreshPromptStubsIn', 'shadowCheck', 'tablePrompts']);
    // The whole read of a row (rowToSession), the stored state a writer compares, and the unsplit.
    expect(callersOf('tablePrompts')).toEqual([
      'src/core/session-db.ts:putSessionRow', 'src/core/session-db.ts:readSessionPrompts', 'src/core/session-db.ts:wholeRecordOf',
    ]);
    expect(callersOf('wholeRecordOf')).toEqual(['src/core/session-db.ts:rowToSession', 'src/core/session-db.ts:rowToSessionIn']);
    expect(callersOf('readSessionPrompts')).toEqual(['src/core/session-db.ts:promptBatch']);
    // The stub decoder reads no table: the cache scan, the patch and the list stay off it.
    for (const fn of ['decodeSessionRow', 'scanStubsOf', 'sessionCacheRowsSql']) {
      expect(db.get(fn), fn).toBeDefined();
      expect(db.get(fn)!, fn).not.toMatch(/tablePrompts\(|wholeRecordOf\(|readSessionPrompts\(|rowToSession(In)?\(/);
    }
  });

  it('withPromptFields (a single-row read per stub row) is called only where a list row needs its text', () => {
    // host-boot: the own rows the host channel announces whole; host-slice: the routing notice of
    // a host's copy; simplify-migration: its backup of router profiles.
    // Named, not only called: two pass it on (`.map(withPromptFields)`, `heavyOf(s, withPromptFields)`).
    const naming = sources().filter((s) => /\bwithPromptFields\b/.test(s.text)).map((s) => s.rel).sort();
    expect(naming).toEqual([
      'src/core/host-slice.ts', 'src/core/router/simplify-migration.ts', 'src/core/session-channel/host-boot.ts', 'src/core/session-tracker.ts',
    ]);
    // The tracker only defines it.
    const tracker = sources().find((s) => s.rel === 'src/core/session-tracker.ts')!.text;
    expect(tracker.match(/\bwithPromptFields\b/g)).toHaveLength(2);
  });
});

describe('ratchet (d): one writer of the sessions table', () => {
  it('every INSERT into sessions is in putSessionRow', () => {
    const found: string[] = [];
    for (const { rel, text } of sources()) {
      for (const [fn, body] of functionsOf(text)) {
        const n = body.match(/INSERT (?:OR \w+ )?INTO sessions[\s(]/g)?.length ?? 0;
        if (n > 0) found.push(`${rel}:${fn}:${n}`);
      }
    }
    expect(found).toEqual(['src/core/session-db.ts:putSessionRow:2']);
  });
});

/**
 * Every whole-table `SELECT *` of the sessions table in src/. The cache's scan goes through
 * sessionCacheRowsSql; the one left is the uncached path (WALNUT_STORE_CACHE=0), which decodes
 * stubs too. A new one reads every row's payload, texts and all, into JS on each call: read
 * through the cache (listSessions, readStoreView) or select only the columns it needs.
 */
describe('ratchet: whole-table reads of the sessions table', () => {
  it('names each one', () => {
    const found = sources()
      .map(({ rel, text }) => [rel, text.match(/SELECT \* FROM sessions\s*['"`]/g)?.length ?? 0] as const)
      .filter(([, n]) => n > 0).map(([rel, n]) => `${rel}:${n}`);
    expect(found.sort()).toEqual(['src/core/session-tracker.ts:1']);
  });
});
