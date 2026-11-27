/**
 * The window of a later open, before its strip gate answers (release B, session-prompt-jobs.ts):
 * the writer must never put a prompt text back into a payload that no longer holds it. Each open
 * starts with the gate unknown and the job asks it 120 s later; release B wrote release A's shape
 * ('both') in that window, so every row written in it (a host's channel batch above all, written
 * every few seconds and replayed at a restart) got its text back from the table, and each boot's
 * strip pass moved the same rows again (2026-11-27 on the Mac: 4 host rows, 108,500 bytes at every
 * boot). Before the gate answers, a write keeps the shape each prompt has: a stripped one stays
 * stripped, one still in its payload stays there.
 *
 * Every writer of a session row goes through putSessionRow (ratchet (d) in
 * session-store-prompt-readers.test.ts); this file drives each kind of caller through it in the
 * window and checks the payloads, the prompt_text_refs column and that every prompt still reads.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fsp from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-prompt-reopen-window'));

import { WALNUT_HOME } from '../../src/constants.js';
import {
  applySessionCopy, closeDb, decodeSessionRow, getDb, PROMPT_TEXT_REFS_COLUMN, promptTextsInPayload, putSessionRow, transaction,
} from '../../src/core/session-db.js';
import { runPromptJob } from '../../src/core/session-prompt-jobs.js';
import { promptChangesOf } from '../../src/core/session-prompts.js';
import {
  _resetSessionTrackerForTesting, createSessionRecord, getSessionByClaudeId, updateSessionRecord,
} from '../../src/core/session-tracker.js';
import type { SessionRecord } from '../../src/core/types.js';
import { applyHanded } from '../helpers/handed-rows.js';

// Unicode as test data, in an escape.
const PROMPT = 'spawn \u4e2d '.repeat(800);
const PERSONA = 'persona '.repeat(600);
const HOST = 'devbox';
const OPEN = async () => ({ open: true, reason: 'test: open' });
const CLOSED = async () => ({ open: false, reason: 'test: closed' });

beforeEach(async () => {
  closeDb();
  _resetSessionTrackerForTesting();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
  hostSeq = 0;
});
afterEach(() => { closeDb(); _resetSessionTrackerForTesting(); });

function raw(sid: string): { payload: Record<string, any>; refs: unknown } {
  const r = getDb()!.prepare(`SELECT payload, ${PROMPT_TEXT_REFS_COLUMN} AS refs FROM sessions WHERE claude_session_id = ?`).get(sid) as { payload: string | null; refs: unknown };
  return { payload: r.payload ? JSON.parse(r.payload) : {}, refs: r.refs };
}
const holdsText = (sid: string) => /"appliedAppendSystemPrompt":"|"systemPrompt":"/.test(JSON.stringify(raw(sid).payload));
const textRows = () => (getDb()!.prepare('SELECT claude_session_id FROM sessions').pluck().all() as string[]).filter(holdsText).sort();

const born = (sid: string, extra: Partial<SessionRecord> = {}): Record<string, unknown> => ({
  claudeSessionId: sid, taskId: '', project: 'p', process_status: 'running', mode: 'default', host: HOST, judge: 'host',
  startedAt: '2026-11-27T00:00:00.000Z', lastActiveAt: '2026-11-27T00:00:00.000Z', messageCount: 0, title: 'From host',
  statusRevision: 1, statusUpdatedAt: '2026-11-27T00:00:00.000Z', ...extra,
});

/** The host's log position: each batch's records come after the last one's. */
let hostSeq = 0;
/** One batch of the host's channel records, in log order after every earlier one. */
function hostBatch(rows: Array<{ sid: string; patch: Record<string, unknown>; born?: boolean }>, renames: Array<{ from: string; to: string }> = []) {
  return applyHanded({
    hostId: HOST, rows: rows.map((r) => ({ ...r, seq: ++hostSeq })), renames: renames.map((r) => ({ ...r, seq: ++hostSeq })),
    cursor: { logId: 'L1', seq: hostSeq },
  });
}

/** A store whose gate opened once and whose strip ran (an earlier open), then a restart: the gate is unknown again. */
async function strippedThenReopened(): Promise<void> {
  await createSessionRecord('local-1', '', 'p', '/w', { appliedAppendSystemPrompt: `${PROMPT}local`, profile: { systemPrompt: `${PERSONA}local`, allowedTools: ['Read'] } });
  await createSessionRecord('local-2', '', 'p', '/w', { profile: { systemPrompt: `${PERSONA}local-2` } });
  for (const sid of ['h1', 'h2', 'h3', 'h4', 'h5']) {
    const seq = ++hostSeq;
    await applyHanded({
      hostId: HOST, renames: [], cursor: { logId: 'L1', seq },
      rows: [{ sid, born: true, seq, patch: born(sid, { appliedAppendSystemPrompt: `${PROMPT}${sid}`, profile: { systemPrompt: `${PERSONA}${sid}` } } as Partial<SessionRecord>) }],
    });
  }
  const r = await runPromptJob({ gate: OPEN, version: '9.9.9' });
  expect(r.strip?.rows).toBe(7);
  expect(textRows()).toEqual([]);
  // The restart: a new open, its gate not asked yet.
  closeDb();
  _resetSessionTrackerForTesting();
  getDb();
}

describe('before the gate answers, a write never puts a stripped prompt back in its payload', () => {
  it('every kind of row write in the window leaves the stripped rows stripped, and every prompt reads', async () => {
    await strippedThenReopened();
    expect(promptTextsInPayload()).toBe(true);
    const batch = hostBatch;

    // A status write of the server's own.
    await updateSessionRecord('local-1', { process_status: 'running', activity: 'processing' });
    // A new persona set on a stripped row.
    await updateSessionRecord('local-2', { profile: { systemPrompt: `${PERSONA}local-2 v2` } });
    // A host's status patch (the hot write of the Mac's report), two in one batch.
    await batch([{ sid: 'h1', patch: { process_status: 'idle', lastActiveAt: new Date().toISOString() } }, { sid: 'h2', patch: { messageCount: 3 } }]);
    // A host's patch that names a new spawn prompt.
    await batch([{ sid: 'h3', patch: { appliedAppendSystemPrompt: `${PROMPT}h3 v2` } }]);
    // A host's whole row again (a resync or a rows frame), texts and all.
    await batch([{ sid: 'h4', born: true, patch: born('h4', { appliedAppendSystemPrompt: `${PROMPT}h4`, profile: { systemPrompt: `${PERSONA}h4` }, messageCount: 9 } as Partial<SessionRecord>) }]);
    // A rename: the new id takes the old row's prompts.
    await batch([], [{ from: 'h5', to: 'h5-new' }]);
    // A copy apply and a direct write of the one writer with a whole record.
    const copy = (await getSessionByClaudeId('local-1'))!;
    applySessionCopy({ rows: [{ ...copy, title: 'copied' }] });
    transaction((h) => {
      const rec = decodeSessionRow(h.prepare('SELECT * FROM sessions WHERE claude_session_id = ?').get('h2') as Record<string, any>);
      putSessionRow(h, { ...rec, title: 'direct' }, promptChangesOf({}));
    });

    expect(textRows()).toEqual([]);
    for (const sid of ['local-1', 'local-2', 'h1', 'h2', 'h3', 'h4', 'h5-new']) {
      const { payload, refs } = raw(sid);
      expect(refs, sid).toBe('{}');
      // Each stub stands for its text (a hash, not `inline`): the table holds it.
      if (payload.appliedAppendSystemPromptRef) expect(payload.appliedAppendSystemPromptRef, sid).toMatchObject({ sha256: expect.any(String) });
      if (payload.profile?.systemPromptRef) expect(payload.profile.systemPromptRef.inline, sid).toBeUndefined();
    }
    // No prompt was lost, and the ones the writes set are the new ones.
    const want: Record<string, { a?: string; p?: string }> = {
      'local-1': { a: `${PROMPT}local`, p: `${PERSONA}local` },
      'local-2': { p: `${PERSONA}local-2 v2` },
      h1: { a: `${PROMPT}h1`, p: `${PERSONA}h1` },
      h2: { a: `${PROMPT}h2`, p: `${PERSONA}h2` },
      h3: { a: `${PROMPT}h3 v2`, p: `${PERSONA}h3` },
      h4: { a: `${PROMPT}h4`, p: `${PERSONA}h4` },
      'h5-new': { a: `${PROMPT}h5`, p: `${PERSONA}h5` },
    };
    for (const [sid, w] of Object.entries(want)) {
      const rec = await getSessionByClaudeId(sid);
      expect(rec?.appliedAppendSystemPrompt, sid).toBe(w.a);
      expect(rec?.profile?.systemPrompt, sid).toBe(w.p);
    }
    expect(await getSessionByClaudeId('h5')).toBeNull();

    // The gate opens: nothing is left for its strip.
    const r = await runPromptJob({ gate: OPEN, version: '9.9.9' });
    expect(r.strip?.rows).toBe(0);
  });

  it('a row that still holds its text keeps it until the gate answers, and a new row is born in the shape every build reads', async () => {
    await strippedThenReopened();
    // A build before the split wrote this row since (its text back in the payload, no column).
    getDb()!.prepare(`UPDATE sessions SET payload = json_set(payload, '$.appliedAppendSystemPrompt', ?), ${PROMPT_TEXT_REFS_COLUMN} = NULL WHERE claude_session_id = 'h1'`).run(`${PROMPT}older`);
    expect(holdsText('h1')).toBe(true);
    await hostBatch([{ sid: 'h1', patch: { messageCount: 4 } }]);
    expect(raw('h1').payload.appliedAppendSystemPrompt).toBe(`${PROMPT}older`);
    // Its persona stayed stripped.
    expect(raw('h1').payload.profile.systemPrompt).toBeUndefined();
    expect((await getSessionByClaudeId('h1'))?.profile?.systemPrompt).toBe(`${PERSONA}h1`);
    await createSessionRecord('new-1', '', 'p', '/w', { appliedAppendSystemPrompt: `${PROMPT}new` });
    expect(raw('new-1').payload.appliedAppendSystemPrompt).toBe(`${PROMPT}new`);
  });

  it('a gate that answers closed writes release A\'s shape again from then on (the texts back as rows are written)', async () => {
    await strippedThenReopened();
    await hostBatch([{ sid: 'h1', patch: { messageCount: 4 } }]);
    expect(holdsText('h1')).toBe(false);
    const r = await runPromptJob({ gate: CLOSED, version: '9.9.9' });
    expect(r.gate.open).toBe(false);
    await hostBatch([{ sid: 'h1', patch: { messageCount: 5 } }]);
    expect(raw('h1').payload.appliedAppendSystemPrompt).toBe(`${PROMPT}h1`);
    expect(raw('h1').payload.profile.systemPrompt).toBe(`${PERSONA}h1`);
  });
});
