/**
 * The session row codec of the prompt split (src/core/session-prompts.ts, session-db.ts): a record's
 * two prompt texts read back the same whatever shape its row is in. The shapes: an older build's
 * (text in the payload, no stub), release A's (text and stub in the payload, text in the table too),
 * release B's (stub in the payload, text in the table only). Every reader reads all three.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fsp from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-prompt-codec'));

import { WALNUT_HOME } from '../../src/constants.js';
import {
  closeDb, decodeSessionRow, getDb, letPromptTextsLeavePayload, promptTextsInPayload, putSessionRow, readSessionPrompts, rowToSession, stripPromptBatch,
} from '../../src/core/session-db.js';
import { promptChangesOf, promptChangesSetting, promptSha256, promptsOf, withoutPrompts, withPromptStubs, type SessionPrompts } from '../../src/core/session-prompts.js';
import { _resetSessionTrackerForTesting } from '../../src/core/session-tracker.js';
import type { SessionRecord } from '../../src/core/types.js';

beforeEach(async () => {
  closeDb();
  _resetSessionTrackerForTesting();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
});
afterEach(() => { closeDb(); _resetSessionTrackerForTesting(); });

const base = (sid: string): SessionRecord => ({
  claudeSessionId: sid, taskId: '', project: 'demo', process_status: 'stopped', mode: 'default',
  startedAt: '2026-11-26T00:00:00.000Z', lastActiveAt: '2026-11-26T00:00:00.000Z', messageCount: 1,
} as SessionRecord);

// Unicode as test data, in escapes: CJK, an emoji (a surrogate pair), and a combining mark.
const UNICODE = 'prompt \u4e2d\u6587 \ud83d\ude80 e\u0301 '.repeat(200);
const CASES: Array<[string, Partial<SessionRecord>]> = [
  ['both fields', { appliedAppendSystemPrompt: 'spawn '.repeat(3000), profile: { systemPrompt: 'persona '.repeat(2000), systemPromptMode: 'append', allowedTools: ['Read'] } }],
  ['only the spawn prompt', { appliedAppendSystemPrompt: 'spawn only' }],
  ['only the persona', { profile: { systemPrompt: 'persona only', slim: true } }],
  ['an empty spawn prompt', { appliedAppendSystemPrompt: '' }],
  ['a profile that holds only a persona', { profile: { systemPrompt: 'just a persona' } }],
  ['a blank persona', { profile: { systemPrompt: '   \n' } }],
  ['Unicode text', { appliedAppendSystemPrompt: UNICODE, profile: { systemPrompt: UNICODE } }],
  ['no payload field at all', {}],
];

function raw(sid: string): Record<string, any> {
  return getDb()!.prepare('SELECT * FROM sessions WHERE claude_session_id = ?').get(sid) as Record<string, any>;
}
function payloadOf(sid: string): Record<string, any> {
  const p = raw(sid).payload;
  return p ? JSON.parse(p) : {};
}
function tableOf(sid: string): Record<string, { body: string; sha256: string }> {
  const rows = getDb()!.prepare('SELECT field, body, sha256 FROM session_prompts WHERE claude_session_id = ?').all(sid) as Array<{ field: string; body: string; sha256: string }>;
  return Object.fromEntries(rows.map((r) => [r.field, { body: r.body, sha256: r.sha256 }]));
}

/**
 * Every reader gives `want` for `sid`, and the stub record holds no text. `hashed`: the row's
 * stubs stand alone (release B's shape), so they carry the hash; a stub beside its text has none.
 */
function expectReadsBack(sid: string, want: SessionPrompts, extra: Partial<SessionRecord>, hashed: boolean): void {
  const whole = rowToSession(raw(sid));
  expect(promptsOf(whole)).toEqual(want);
  expect(whole.appliedAppendSystemPromptRef).toBeUndefined();
  expect(whole.profile?.systemPromptRef).toBeUndefined();
  if (extra.profile) expect(whole.profile).toEqual(extra.profile);
  expect(readSessionPrompts(getDb()!, sid)).toEqual(want);
  const stub = decodeSessionRow(raw(sid));
  expect(stub.appliedAppendSystemPrompt).toBeUndefined();
  expect(stub.profile?.systemPrompt).toBeUndefined();
  if (want.appliedAppendSystemPrompt !== undefined) {
    expect(stub.appliedAppendSystemPromptRef).toEqual({ ...(hashed ? { sha256: promptSha256(want.appliedAppendSystemPrompt) } : {}), bytes: Buffer.byteLength(want.appliedAppendSystemPrompt) });
  } else expect(stub.appliedAppendSystemPromptRef).toBeUndefined();
  if (want.systemPrompt !== undefined) {
    expect(stub.profile?.systemPromptRef).toEqual({ ...(hashed ? { sha256: promptSha256(want.systemPrompt) } : {}), bytes: Buffer.byteLength(want.systemPrompt), blank: !want.systemPrompt.trim() });
  } else expect(stub.profile?.systemPromptRef).toBeUndefined();
}

describe('the prompt codec: every shape reads back the same texts', () => {
  it.each(CASES)('%s', (_name, extra) => {
    const sid = `s-${Math.random().toString(36).slice(2)}`;
    const record = { ...base(sid), ...extra } as SessionRecord;
    const want = promptsOf(record);
    const db = getDb()!;

    // Release A's write (and B's before its gate opened): the text stays in the payload beside its stub, and goes to the table.
    expect(promptTextsInPayload()).toBe(true);
    db.transaction(() => putSessionRow(db, record, promptChangesSetting(want)))();
    const a = payloadOf(sid);
    expect(a.appliedAppendSystemPrompt).toBe(want.appliedAppendSystemPrompt);
    expect(a.profile?.systemPrompt).toBe(want.systemPrompt);
    for (const [field, text] of [['appliedAppendSystemPrompt', want.appliedAppendSystemPrompt], ['profile.systemPrompt', want.systemPrompt]] as const) {
      if (text === undefined) expect(tableOf(sid)[field]).toBeUndefined();
      else expect(tableOf(sid)[field]).toEqual({ body: text, sha256: promptSha256(text) });
    }
    expectReadsBack(sid, want, extra, false);

    // Release B's shape (the strip): the payload never holds a text, only the stubs.
    db.transaction(() => { for (let at = 0, done = false; !done;) { const b = stripPromptBatch(db, at); at = b.lastRowid; done = b.done; } })();
    const b = payloadOf(sid);
    expect(JSON.stringify(b)).not.toMatch(/"appliedAppendSystemPrompt":"|"systemPrompt":"/);
    if (want.appliedAppendSystemPrompt !== undefined) expect(b.appliedAppendSystemPromptRef.sha256).toBe(promptSha256(want.appliedAppendSystemPrompt));
    if (want.systemPrompt !== undefined) expect(b.profile.systemPromptRef.sha256).toBe(promptSha256(want.systemPrompt));
    expectReadsBack(sid, want, extra, true);

    // Release B's write once its gate opened: the record's texts go to the table only.
    letPromptTextsLeavePayload();
    db.transaction(() => putSessionRow(db, { ...record, messageCount: 2 }, promptChangesSetting(want)))();
    expect(JSON.stringify(payloadOf(sid))).not.toMatch(/"appliedAppendSystemPrompt":"|"systemPrompt":"/);
    expect(raw(sid).prompt_text_refs).toBe('{}');
    expectReadsBack(sid, want, extra, true);
    // A new open starts with the texts in the payload again, until its own gate opens.
    closeDb();
    expect(promptTextsInPayload()).toBe(true);
  });

  it('an older build\'s row (text in the payload, no stub, no table row) reads the same', () => {
    const db = getDb()!;
    const record = { ...base('old'), ...CASES[0]![1] } as SessionRecord;
    const { claudeSessionId: _id, taskId: _t, project: _p, process_status: _s, mode: _m, startedAt: _st, lastActiveAt: _l, messageCount: _c, ...payload } = record;
    db.prepare(`INSERT INTO sessions (claude_session_id, task_id, project, process_status, mode, started_at, last_active_at, message_count, payload)
      VALUES (?, '', 'demo', 'stopped', 'default', ?, ?, 1, ?)`).run('old', record.startedAt, record.lastActiveAt, JSON.stringify(payload));
    expectReadsBack('old', promptsOf(record), CASES[0]![1], false);
  });

  it('a stub an older build left beside a text it changed is never trusted', () => {
    const db = getDb()!;
    const record = { ...base('stale'), appliedAppendSystemPrompt: 'first' } as SessionRecord;
    db.transaction(() => putSessionRow(db, record, promptChangesSetting(promptsOf(record))))();
    // An older build rewrites the text and keeps the stub it does not know.
    const p = payloadOf('stale');
    p.appliedAppendSystemPrompt = 'second, newer';
    db.prepare('UPDATE sessions SET payload = ? WHERE claude_session_id = ?').run(JSON.stringify(p), 'stale');
    expect(decodeSessionRow(raw('stale')).appliedAppendSystemPromptRef).toEqual({ bytes: Buffer.byteLength('second, newer') });
    expect(rowToSession(raw('stale')).appliedAppendSystemPrompt).toBe('second, newer');
  });
});

describe('the prompt helpers', () => {
  it('a whole row or profile whose stub sat beside a text it no longer holds (inline) clears that prompt', () => {
    const inline = { bytes: 10, inline: true as const };
    expect(promptChangesOf({ appliedAppendSystemPromptRef: inline, profile: { systemPromptRef: inline } }, { whole: true }))
      .toEqual({ appliedAppendSystemPrompt: null, systemPrompt: null });
    // A stub that stands for the table's text keeps it.
    expect(promptChangesOf({ appliedAppendSystemPromptRef: { bytes: 10 }, profile: { systemPromptRef: { bytes: 10 } } }, { whole: true })).toEqual({});
  });

  it('withoutPrompts and withPromptStubs never change the record they are given', () => {
    const plain = { claudeSessionId: 'x', title: 't' } as Partial<SessionRecord>;
    expect(withoutPrompts(plain)).not.toBe(plain);
    const stubbed = withPromptStubs(plain, { appliedAppendSystemPrompt: 'text' });
    expect(stubbed.appliedAppendSystemPromptRef?.bytes).toBe(4);
    expect(plain).toEqual({ claudeSessionId: 'x', title: 't' });
  });

  it('putSessionRow leaves the record it is given as it was', () => {
    const db = getDb()!;
    const records: SessionRecord[] = [
      { claudeSessionId: 'keep-1', taskId: '', project: 'p', process_status: 'idle', mode: 'default', startedAt: 'x', lastActiveAt: 'x', messageCount: 0 } as SessionRecord,
      { claudeSessionId: 'keep-2', taskId: '', project: 'p', process_status: 'idle', mode: 'default', startedAt: 'x', lastActiveAt: 'x', messageCount: 0,
        appliedAppendSystemPrompt: 'spawn', profile: { systemPrompt: 'persona', allowedTools: ['Read'] } } as SessionRecord,
    ];
    for (const r of records) {
      const before = structuredClone(r);
      db.transaction(() => putSessionRow(db, r, promptChangesSetting(promptsOf(r)), { insert: true }))();
      expect(r).toEqual(before);
    }
    // A write that names no prompt, of a record with no prompt key, on a row that holds both: the
    // stored texts go into the row, never onto the caller's record.
    const bare = { ...records[0]!, claudeSessionId: 'keep-2', title: 'later', profile: { allowedTools: ['Read'] } } as SessionRecord;
    const before = structuredClone(bare);
    db.transaction(() => putSessionRow(db, bare))();
    expect(bare).toEqual(before);
    expect(readSessionPrompts(db, 'keep-2')).toEqual({ appliedAppendSystemPrompt: 'spawn', systemPrompt: 'persona' });
  });
});
