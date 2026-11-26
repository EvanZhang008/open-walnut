/**
 * The `prompt_text_refs` column of a session row (session-db.ts, session-prompts.ts): the stubs of
 * the texts its payload holds, written with the payload, so the cache scan reads them instead of
 * measuring the texts. A build before the split leaves it NULL (its writes do not name it): the scan
 * measures that row, and the fill pass writes the column again.
 *
 * Also here: a stub written beside its text (`inline`) and found without it means a build before
 * the split cleared that text, so the table's copy is never read back; and "blank" is one rule in JS
 * and SQL (isBlankText, BLANK_CHARS_SQL).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fsp from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-prompt-column'));

import { WALNUT_HOME } from '../../src/constants.js';
import { closeDb, getDb, PROMPT_TEXT_REFS_COLUMN, readSessionPrompts, SESSION_COLUMNS } from '../../src/core/session-db.js';
import { runPromptPass } from '../../src/core/session-prompt-jobs.js';
import {
  BLANK_CHARS_SQL, BLANK_CODE_POINTS, hasPersona, isBlankText, SPLIT_PROMPT_ROWS_SQL,
} from '../../src/core/session-prompts.js';
import {
  _dropSessionStoreCacheForTesting, _resetSessionTrackerForTesting, createSessionRecord, getSessionByClaudeId, listSessions, updateSessionRecord,
} from '../../src/core/session-tracker.js';

const PROMPT = 'spawn prompt '.repeat(700);
const PERSONA = 'persona text '.repeat(500);
// Test data: blank in JS (String.prototype.trim) but not in ASCII: ideographic space, no-break space, line separator.
const UNICODE_BLANK = '\u3000\u00a0\u2028 ';

beforeEach(async () => {
  closeDb();
  _resetSessionTrackerForTesting();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
});
afterEach(() => { closeDb(); _resetSessionTrackerForTesting(); });

function raw(sid: string): Record<string, any> {
  return getDb()!.prepare('SELECT * FROM sessions WHERE claude_session_id = ?').get(sid) as Record<string, any>;
}
function payload(sid: string): Record<string, any> {
  return JSON.parse(raw(sid).payload);
}
function table(sid: string): Record<string, string> {
  const rows = getDb()!.prepare('SELECT field, body FROM session_prompts WHERE claude_session_id = ?').all(sid) as Array<{ field: string; body: string }>;
  return Object.fromEntries(rows.map((r) => [r.field, r.body]));
}
/** What a build before the split writes: its own column list (no prompt_text_refs) and this payload. */
function writeAsOldBuild(sid: string, edit: (p: Record<string, any>) => void): void {
  const row = raw(sid);
  const p = JSON.parse(row.payload);
  edit(p);
  const cols = [...SESSION_COLUMNS, 'payload'];
  const values = { ...Object.fromEntries(SESSION_COLUMNS.map((c) => [c, row[c] ?? null])), payload: JSON.stringify(p) };
  getDb()!.prepare(`INSERT OR REPLACE INTO sessions (${cols.join(', ')}) VALUES (${cols.map((c) => '@' + c).join(', ')})`).run(values);
  _dropSessionStoreCacheForTesting();
}
async function cached(sid: string) {
  return (await listSessions()).find((r) => r.claudeSessionId === sid)!;
}
async function seed(sid: string, persona = PERSONA): Promise<void> {
  await createSessionRecord(sid, '', 'demo', '/w', {
    appliedAppendSystemPrompt: PROMPT, profile: { systemPrompt: persona, allowedTools: ['Read'] }, initialProcessStatus: 'running',
  });
}

describe('the prompt_text_refs column', () => {
  it('holds the stubs of the texts the payload holds, for every shape', async () => {
    await seed('s1');
    const want = { appliedAppendSystemPrompt: { bytes: PROMPT.length }, systemPrompt: { bytes: PERSONA.length, blank: false } };
    expect(JSON.parse(raw('s1')[PROMPT_TEXT_REFS_COLUMN])).toEqual(want);
    // Release A's payload stubs say they sit beside their text.
    expect(payload('s1').appliedAppendSystemPromptRef).toEqual({ bytes: PROMPT.length, inline: true });
    await runPromptPass('strip');
    expect(raw('s1')[PROMPT_TEXT_REFS_COLUMN]).toBe('{}');
    expect(payload('s1').appliedAppendSystemPromptRef.inline).toBeUndefined();
    await runPromptPass('unsplit');
    expect(JSON.parse(raw('s1')[PROMPT_TEXT_REFS_COLUMN])).toEqual(want);
  });

  it('the scan reads stubs from it, and measures a row a build before the split wrote until the fill pass writes it again', async () => {
    await seed('s1');
    const fromColumn = await cached('s1');
    writeAsOldBuild('s1', (p) => { p.title = 'old build'; });
    expect(raw('s1')[PROMPT_TEXT_REFS_COLUMN]).toBeNull();
    const measured = await cached('s1');
    expect(measured.title).toBe('old build');
    expect([measured.appliedAppendSystemPromptRef, measured.profile?.systemPromptRef]).toEqual([fromColumn.appliedAppendSystemPromptRef, fromColumn.profile?.systemPromptRef]);
    expect(measured.appliedAppendSystemPrompt).toBeUndefined();
    const fill = await runPromptPass('refs');
    expect(fill.rows).toBe(1);
    expect(JSON.parse(raw('s1')[PROMPT_TEXT_REFS_COLUMN])).toEqual(JSON.parse('{"appliedAppendSystemPrompt":{"bytes":' + PROMPT.length + '},"systemPrompt":{"bytes":' + PERSONA.length + ',"blank":false}}'));
    _dropSessionStoreCacheForTesting();
    expect(await cached('s1')).toEqual(measured);
    expect((await runPromptPass('refs')).rows).toBe(0);
  });
});

describe('a text a build before the split cleared stays cleared (never read back from the table)', () => {
  it('the spawn prompt it removed beside its inline stub is gone for every reader, and its table row goes with the next write', async () => {
    await seed('c1');
    expect(table('c1').appliedAppendSystemPrompt).toBe(PROMPT);
    // An older build clears it: its record kept the stub it does not know, and dropped the text.
    writeAsOldBuild('c1', (p) => { delete p.appliedAppendSystemPrompt; });
    expect((await getSessionByClaudeId('c1'))?.appliedAppendSystemPrompt).toBeUndefined();
    expect((await getSessionByClaudeId('c1'))?.profile?.systemPrompt).toBe(PERSONA);
    expect(readSessionPrompts(getDb()!, 'c1')).toEqual({ systemPrompt: PERSONA });
    const row = await cached('c1');
    expect(row.appliedAppendSystemPromptRef).toBeUndefined();
    expect(row.profile?.systemPromptRef?.bytes).toBe(PERSONA.length);
    // Not a split row: the rollback check has nothing to refuse for it.
    expect((getDb()!.prepare(SPLIT_PROMPT_ROWS_SQL).get() as { n: number }).n).toBe(0);
    await updateSessionRecord('c1', { process_status: 'idle' });
    expect(table('c1').appliedAppendSystemPrompt).toBeUndefined();
    expect(payload('c1').appliedAppendSystemPromptRef).toBeUndefined();
    await runPromptPass('unsplit');
    expect((await getSessionByClaudeId('c1'))?.appliedAppendSystemPrompt).toBeUndefined();
  });

  it('a stripped row an older build rewrote (its stub stands for the table) still reads the table', async () => {
    await seed('k1');
    await runPromptPass('strip');
    writeAsOldBuild('k1', (p) => { p.title = 'old build'; });
    expect((await getSessionByClaudeId('k1'))?.appliedAppendSystemPrompt).toBe(PROMPT);
    expect((getDb()!.prepare(SPLIT_PROMPT_ROWS_SQL).get() as { n: number }).n).toBe(1);
  });
});

describe('blank is one rule in JS and SQL', () => {
  it('isBlankText is String.prototype.trim for every UTF-16 code unit', () => {
    const differ: number[] = [];
    for (let c = 0; c <= 0xffff; c++) {
      const ch = String.fromCharCode(c);
      if (isBlankText(ch) !== !ch.trim()) differ.push(c);
    }
    expect(differ).toEqual([]);
  });

  it('SQLite trims exactly the same characters', () => {
    const db = getDb()!;
    const sqlBlank = (text: string) => db.prepare(`SELECT trim(?, ${BLANK_CHARS_SQL}) = '' AS b`).pluck().get(text) === 1;
    for (const c of BLANK_CODE_POINTS) expect(sqlBlank(String.fromCodePoint(c)), c.toString(16)).toBe(true);
    for (const c of [0x200b, 0x85, 0x180e, 0x41, 0x4e2d]) expect(sqlBlank(String.fromCodePoint(c)), c.toString(16)).toBe(!String.fromCodePoint(c).trim());
  });

  it('a Unicode-blank persona is blank whole, in a writer stub, from the column and measured by the scan', async () => {
    await seed('b1', UNICODE_BLANK);
    expect(hasPersona((await getSessionByClaudeId('b1'))!.profile)).toBe(false);
    expect((await cached('b1')).profile?.systemPromptRef?.blank).toBe(true);
    writeAsOldBuild('b1', () => {});
    const measured = await cached('b1');
    expect(measured.profile?.systemPromptRef?.blank).toBe(true);
    expect(hasPersona(measured.profile)).toBe(false);
  });
});
