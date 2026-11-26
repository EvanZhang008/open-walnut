/**
 * The prompt split across builds (design section 3.3 and 3.4): release A reads a row release B
 * stripped; a row an older build wrote after the strip (its text in the payload) reads that text,
 * the newer one, and the next strip moves it into the table; and the down migration (`walnut
 * sessions-prompts unsplit`) puts every text back in its payload, where a build before the split
 * reads it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fsp from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-prompt-rollback'));

import { WALNUT_HOME } from '../../src/constants.js';
import { closeDb, getDb, PROMPT_SPLIT_MARKER } from '../../src/core/session-db.js';
import { runPromptPass } from '../../src/core/session-prompt-jobs.js';
import { _resetSessionTrackerForTesting, createSessionRecord, getSessionByClaudeId, listSessions } from '../../src/core/session-tracker.js';

const PROMPT = 'spawn \u4e2d '.repeat(800);
const PERSONA = 'persona '.repeat(600);

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
function table(sid: string): Record<string, string> {
  const rows = getDb()!.prepare('SELECT field, body FROM session_prompts WHERE claude_session_id = ?').all(sid) as Array<{ field: string; body: string }>;
  return Object.fromEntries(rows.map((r) => [r.field, r.body]));
}
function marker(): boolean {
  return !!getDb()!.prepare('SELECT 1 FROM session_migrations WHERE id = ?').get(PROMPT_SPLIT_MARKER);
}
/** What a build before the split reads: its rowToSession took the payload's JSON as the record. */
function oldBuildReads(sid: string): [unknown, unknown] {
  const p = payload(sid);
  return [p.appliedAppendSystemPrompt, p.profile?.systemPrompt];
}

async function seed(n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const sid = `s-${i}`;
    await createSessionRecord(sid, '', 'demo', '/w', {
      initialProcessStatus: i % 2 ? 'stopped' : 'running',
      ...(i % 3 !== 2 ? { appliedAppendSystemPrompt: i === 0 ? '' : `${PROMPT}${i}` } : {}),
      ...(i % 3 !== 1 ? { profile: { systemPrompt: `${PERSONA}${i}`, allowedTools: ['Read'] } } : {}),
    });
    ids.push(sid);
  }
  return ids;
}

describe('the prompt split across builds', () => {
  it('release A reads rows release B stripped, whole by id and as stubs in the list', async () => {
    const ids = await seed(9);
    const before = await Promise.all(ids.map((id) => getSessionByClaudeId(id)));
    const pass = await runPromptPass('strip', { batchRows: 4 });
    expect(pass.rows).toBe(9);
    expect(pass.batches).toBeGreaterThan(2);
    expect(marker()).toBe(true);
    for (const [i, id] of ids.entries()) {
      expect(JSON.stringify(payload(id))).not.toMatch(/"appliedAppendSystemPrompt":"|"systemPrompt":"/);
      expect(await getSessionByClaudeId(id)).toEqual(before[i]);
    }
    const listed = await listSessions();
    expect(listed.every((r) => r.appliedAppendSystemPrompt === undefined && r.profile?.systemPrompt === undefined)).toBe(true);
    expect(listed.find((r) => r.claudeSessionId === 's-0')?.appliedAppendSystemPromptRef?.bytes).toBe(0);
    // A second pass changes nothing.
    expect((await runPromptPass('strip')).rows).toBe(0);
  });

  it('a row an older build wrote after the strip reads its payload text, and the next strip moves it: the newest wins', async () => {
    await seed(3);
    await runPromptPass('strip');
    // An older build reads the stripped row (no text), sets a new spawn prompt, and keeps the stub it does not know.
    const p = payload('s-1');
    p.appliedAppendSystemPrompt = 'written by an older build';
    getDb()!.prepare('UPDATE sessions SET payload = ? WHERE claude_session_id = ?').run(JSON.stringify(p), 's-1');
    expect(table('s-1').appliedAppendSystemPrompt).toBe(`${PROMPT}1`);
    _resetSessionTrackerForTesting();
    expect((await getSessionByClaudeId('s-1'))?.appliedAppendSystemPrompt).toBe('written by an older build');
    expect((await listSessions()).find((r) => r.claudeSessionId === 's-1')?.appliedAppendSystemPromptRef?.bytes).toBe(Buffer.byteLength('written by an older build'));
    expect((await runPromptPass('strip')).rows).toBe(1);
    expect(table('s-1').appliedAppendSystemPrompt).toBe('written by an older build');
    expect(payload('s-1').appliedAppendSystemPrompt).toBeUndefined();
    expect((await getSessionByClaudeId('s-1'))?.appliedAppendSystemPrompt).toBe('written by an older build');
  });

  it('unsplit puts every text back into its payload, byte-equal, so a build before the split reads both fields', async () => {
    const ids = await seed(9);
    const want = new Map(ids.map((id) => [id, oldBuildReads(id)]));
    await runPromptPass('strip');
    expect(oldBuildReads('s-1')).toEqual([undefined, undefined]);
    const back = await runPromptPass('unsplit', { batchRows: 2 });
    expect(back.rows).toBe(9);
    expect(marker()).toBe(false);
    for (const id of ids) {
      expect(oldBuildReads(id), id).toEqual(want.get(id));
      // The shape before the split: no stub beside the text.
      expect(payload(id).appliedAppendSystemPromptRef, id).toBeUndefined();
      expect(payload(id).profile?.systemPromptRef, id).toBeUndefined();
    }
    // The table is kept, and a second pass has nothing to do.
    expect(table('s-1').appliedAppendSystemPrompt).toBe(`${PROMPT}1`);
    expect((await runPromptPass('unsplit')).rows).toBe(0);
  });

  it('unsplit keeps a stub whose text the table lacks, so the row still reads as split and the checks refuse', async () => {
    await seed(3);
    await runPromptPass('strip');
    getDb()!.prepare("DELETE FROM session_prompts WHERE claude_session_id = 's-1' AND field = 'appliedAppendSystemPrompt'").run();
    await runPromptPass('unsplit');
    expect(payload('s-1').appliedAppendSystemPromptRef?.bytes).toBe(Buffer.byteLength(`${PROMPT}1`));
    expect(payload('s-0').appliedAppendSystemPrompt).toBe('');
    const { SPLIT_PROMPT_ROWS_SQL } = await import('../../src/core/session-prompts.js');
    expect((getDb()!.prepare(SPLIT_PROMPT_ROWS_SQL).get() as { n: number }).n).toBe(1);
  });
});
