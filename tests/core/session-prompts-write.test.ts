/**
 * The write rules of the prompt split (src/core/session-prompts.ts): a write changes a prompt only
 * where its caller names it, a prompt row is written only when its text differs, renames and deletes
 * take the prompt rows along in the same transaction, and no writer that starts from a record read
 * without its texts (a cached row, a writer's own stub) can clear a prompt by leaving it out.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fsp from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-prompt-write'));

import { TASKS_DIR, WALNUT_HOME } from '../../src/constants.js';
import { applySessionCopy, closeDb, getDb, stripPromptBatch, sweepOrphanSessionPrompts } from '../../src/core/session-db.js';
import { closeDb as closeTaskDb } from '../../src/core/task-db.js';
import { _resetForTesting, addTask } from '../../src/core/task-manager.js';
import {
  _resetSessionTrackerForTesting, acceptAcpPrompt, batchUpdateSessionRecords, createSessionRecord, deleteSessionRecords,
  getSessionByClaudeId, listSessions, renameSessionId, rollbackAcpSessionIdMigration, stageAcpSessionIdMigration,
  updateSessionRecord, updateSessionRecordConditionally, withPromptFields,
} from '../../src/core/session-tracker.js';
import { writingAsHost } from '../../src/core/sessions/session-row-owner.js';
import { isRouterAreaSession, routerAreaProfile } from '../../src/core/router/session-policy.js';
import type { SessionRecord } from '../../src/core/types.js';

const PROMPT = 'spawn prompt '.repeat(900);
const PERSONA = 'persona text '.repeat(700);

beforeEach(async () => {
  closeDb(); closeTaskDb();
  _resetSessionTrackerForTesting(); _resetForTesting();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(TASKS_DIR, { recursive: true });
});
afterEach(async () => {
  closeDb(); closeTaskDb();
  _resetSessionTrackerForTesting(); _resetForTesting();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {});
});

/** Count the prompt table's row writes on the shared connection from here on. */
function countPromptWrites(): () => number {
  const db = getDb()!;
  db.exec(`
    CREATE TEMP TABLE IF NOT EXISTS prompt_row_writes (n INTEGER NOT NULL);
    DELETE FROM temp.prompt_row_writes; INSERT INTO temp.prompt_row_writes (n) VALUES (0);
    CREATE TEMP TRIGGER IF NOT EXISTS prompt_row_writes_i AFTER INSERT ON main.session_prompts BEGIN UPDATE prompt_row_writes SET n = n + 1; END;
    CREATE TEMP TRIGGER IF NOT EXISTS prompt_row_writes_u AFTER UPDATE ON main.session_prompts BEGIN UPDATE prompt_row_writes SET n = n + 1; END;
    CREATE TEMP TRIGGER IF NOT EXISTS prompt_row_writes_d AFTER DELETE ON main.session_prompts BEGIN UPDATE prompt_row_writes SET n = n + 1; END;
  `);
  return () => db.prepare('SELECT n FROM temp.prompt_row_writes').pluck().get() as number;
}

function table(sid: string): Record<string, string> {
  const rows = getDb()!.prepare('SELECT field, body FROM session_prompts WHERE claude_session_id = ?').all(sid) as Array<{ field: string; body: string }>;
  return Object.fromEntries(rows.map((r) => [r.field, r.body]));
}
function payload(sid: string): Record<string, any> {
  const p = getDb()!.prepare('SELECT payload FROM sessions WHERE claude_session_id = ?').pluck().get(sid) as string | null;
  return p ? JSON.parse(p) : {};
}

async function seed(sid: string, status: SessionRecord['process_status'] = 'running'): Promise<void> {
  await createSessionRecord(sid, '', 'demo', '/w', {
    appliedAppendSystemPrompt: PROMPT, profile: { systemPrompt: PERSONA, systemPromptMode: 'append', allowedTools: ['Read'] }, initialProcessStatus: status,
  });
}

/** Both prompts as stored, read whole. */
async function prompts(sid: string): Promise<[string | undefined, string | undefined]> {
  const r = await getSessionByClaudeId(sid);
  return [r?.appliedAppendSystemPrompt, r?.profile?.systemPrompt];
}

describe('a write changes a prompt only where its caller names it', () => {
  it('a status update, a batch update and an ACP accept write no prompt row and keep both texts', async () => {
    await seed('s1');
    expect(table('s1')).toEqual({ appliedAppendSystemPrompt: PROMPT, 'profile.systemPrompt': PERSONA });
    const writes = countPromptWrites();
    await updateSessionRecord('s1', { process_status: 'idle', activity: 'processing' });
    await batchUpdateSessionRecords(['s1'], { process_status: 'running' });
    await acceptAcpPrompt('s1', 'cmd-1');
    expect(writes()).toBe(0);
    expect(await prompts('s1')).toEqual([PROMPT, PERSONA]);
    // Release A: the payload still holds both texts for an older build.
    expect(payload('s1').appliedAppendSystemPrompt).toBe(PROMPT);
    expect(payload('s1').profile.systemPrompt).toBe(PERSONA);
  });

  it('a set of the same text writes no prompt row; a new text writes one; a clear deletes it', async () => {
    await seed('s2');
    const writes = countPromptWrites();
    await updateSessionRecord('s2', { appliedAppendSystemPrompt: PROMPT });
    expect(writes()).toBe(0);
    await updateSessionRecord('s2', { appliedAppendSystemPrompt: `${PROMPT} v2`, title: 'x' });
    expect(writes()).toBe(1);
    expect(table('s2').appliedAppendSystemPrompt).toBe(`${PROMPT} v2`);
    await updateSessionRecord('s2', { appliedAppendSystemPrompt: undefined });
    expect(writes()).toBe(2);
    expect(table('s2').appliedAppendSystemPrompt).toBeUndefined();
    expect(payload('s2').appliedAppendSystemPrompt).toBeUndefined();
    expect(payload('s2').appliedAppendSystemPromptRef).toBeUndefined();
    expect((await prompts('s2'))[0]).toBeUndefined();
  });

  it('a set of the same text is no write at all (the row, its activity time and its revision stay)', async () => {
    await seed('s2b', 'idle');
    const row = () => getDb()!.prepare('SELECT last_active_at, status_revision, payload FROM sessions WHERE claude_session_id = ?').get('s2b');
    const before = row();
    // The clock moves a minute on, so any write would stamp a new activity time.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 60_000);
    try {
      await updateSessionRecord('s2b', { appliedAppendSystemPrompt: PROMPT });
      await updateSessionRecord('s2b', { profile: { systemPrompt: PERSONA, systemPromptMode: 'append', allowedTools: ['Read'] } });
    } finally {
      vi.useRealTimers();
    }
    expect(row()).toEqual(before);
  });

  it('the record a clear hands back carries no stub of the cleared text', async () => {
    await seed('s2c');
    const cleared = await updateSessionRecord('s2c', { appliedAppendSystemPrompt: undefined });
    expect(cleared.appliedAppendSystemPrompt).toBeUndefined();
    expect(cleared.appliedAppendSystemPromptRef).toBeUndefined();
    const set = await updateSessionRecord('s2c', { appliedAppendSystemPrompt: 'new prompt' });
    expect(set.appliedAppendSystemPrompt).toBe('new prompt');
    expect(set.appliedAppendSystemPromptRef).toBeUndefined();
  });

  it('on the leader, a patch of a host-judged row changes no prompt its host owns (single, batch, conditional)', async () => {
    await createSessionRecord('h1', '', 'demo', '/w', { host: 'devbox' });
    await writingAsHost(() => updateSessionRecord('h1', {
      judge: 'host', process_status: 'idle', appliedAppendSystemPrompt: PROMPT, profile: { systemPrompt: PERSONA, systemPromptMode: 'append', allowedTools: ['Read'] },
    }));
    expect(await prompts('h1')).toEqual([PROMPT, PERSONA]);
    // The leader's own field lands; the host's prompt fields in the same patch are left out.
    const r = await updateSessionRecord('h1', { title: 'Renamed', appliedAppendSystemPrompt: undefined, profile: { allowedTools: ['Read', 'Bash'] } });
    expect(r.title).toBe('Renamed');
    expect(await prompts('h1')).toEqual([PROMPT, PERSONA]);
    expect(table('h1')).toEqual({ appliedAppendSystemPrompt: PROMPT, 'profile.systemPrompt': PERSONA });
    await batchUpdateSessionRecords(['h1'], { title: 'Batch', appliedAppendSystemPrompt: 'other prompt' });
    expect(await prompts('h1')).toEqual([PROMPT, PERSONA]);
    await updateSessionRecordConditionally('h1', { title: 'Cond', profile: { allowedTools: ['X'] } }, () => true);
    expect(await prompts('h1')).toEqual([PROMPT, PERSONA]);
    expect((await getSessionByClaudeId('h1'))?.profile?.allowedTools).toEqual(['Read']);
    expect(table('h1')).toEqual({ appliedAppendSystemPrompt: PROMPT, 'profile.systemPrompt': PERSONA });
  });

  it('a profile update that leaves the persona out clears it (as a whole-profile write always did)', async () => {
    await seed('s3');
    await updateSessionRecord('s3', { profile: { systemPromptMode: 'append', allowedTools: ['Read'] } });
    expect(table('s3')['profile.systemPrompt']).toBeUndefined();
    expect(await prompts('s3')).toEqual([PROMPT, undefined]);
    await updateSessionRecord('s3', { profile: undefined });
    expect((await getSessionByClaudeId('s3'))?.profile).toBeUndefined();
  });
});

describe('a writer that starts from a record read without its texts never clears a prompt (design section 6, rows 4 to 6)', () => {
  it('a profile built from a cached row of a live session keeps its persona', async () => {
    await seed('live', 'running');
    const cached = (await listSessions()).find((s) => s.claudeSessionId === 'live')!;
    expect(cached.profile?.systemPrompt).toBeUndefined();
    expect(cached.profile?.systemPromptRef?.bytes).toBe(Buffer.byteLength(PERSONA));
    const writes = countPromptWrites();
    await updateSessionRecord('live', { profile: { ...cached.profile, mcpServers: { walnut: { type: 'stdio', command: '/bin/true' } } } as never });
    expect(writes()).toBe(0);
    const whole = await getSessionByClaudeId('live');
    expect(whole?.profile?.systemPrompt).toBe(PERSONA);
    expect(whole?.profile?.mcpServers).toEqual({ walnut: { type: 'stdio', command: '/bin/true' } });
    expect(whole?.profile?.systemPromptRef).toBeUndefined();
  });

  it('the same from a stopped row, and from the record a writer handed back', async () => {
    await seed('stopped', 'stopped');
    const cached = (await listSessions()).find((s) => s.claudeSessionId === 'stopped')!;
    await updateSessionRecord('stopped', { profile: { ...cached.profile, allowedTools: ['Read', 'Grep'] } as never });
    const back = await updateSessionRecord('stopped', { title: 'renamed' });
    expect(back.profile?.systemPrompt).toBeUndefined();
    await updateSessionRecord('stopped', { profile: { ...back.profile, slim: false } as never });
    expect(await prompts('stopped')).toEqual([PROMPT, PERSONA]);
    expect((await getSessionByClaudeId('stopped'))?.profile).toMatchObject({ allowedTools: ['Read', 'Grep'], slim: false });
  });

  it('withPromptFields reads a cached row whole, for any status', async () => {
    await seed('l1', 'running');
    await seed('l2', 'stopped');
    for (const s of (await listSessions()).filter((r) => r.claudeSessionId.startsWith('l'))) {
      const whole = withPromptFields(s);
      expect([whole.appliedAppendSystemPrompt, whole.profile?.systemPrompt]).toEqual([PROMPT, PERSONA]);
    }
  });

  it('a profile filled on an existing record comes with its persona; a stub profile is never written as a new one', async () => {
    await createSessionRecord('f1', '', 'demo', '/w');
    await createSessionRecord('f1', '', 'demo', '/w', { pid: 42, profile: { systemPrompt: PERSONA } });
    expect((await prompts('f1'))[1]).toBe(PERSONA);
    const cached = (await listSessions()).find((s) => s.claudeSessionId === 'f1')!;
    // Write-once: the runner's copy (a stub) never replaces the stored profile.
    await createSessionRecord('f1', '', 'demo', '/w', { pid: 43, profile: cached.profile });
    expect((await prompts('f1'))[1]).toBe(PERSONA);
  });

  it('a row the strip already moved (a rollback to release A) keeps its prompts through status writes, and A writes the text back beside the stub', async () => {
    await seed('moved', 'running');
    const db = getDb()!;
    db.transaction(() => stripPromptBatch(db, 0, 100))();
    expect(payload('moved').appliedAppendSystemPrompt).toBeUndefined();
    const writes = countPromptWrites();
    await updateSessionRecord('moved', { process_status: 'idle' });
    expect(writes()).toBe(0);
    expect(await prompts('moved')).toEqual([PROMPT, PERSONA]);
    expect(payload('moved').appliedAppendSystemPrompt).toBe(PROMPT);
  });
});

describe('renames and deletes take the prompt rows along', () => {
  it('renameSessionId moves them, an old-shape row included', async () => {
    await seed('r-old');
    await renameSessionId('r-old', 'r-new', { title: 'after' });
    expect(table('r-old')).toEqual({});
    expect(table('r-new')).toEqual({ appliedAppendSystemPrompt: PROMPT, 'profile.systemPrompt': PERSONA });
    expect(await prompts('r-new')).toEqual([PROMPT, PERSONA]);
    // A moved (new-shape) row: the table is its only source.
    const db = getDb()!;
    db.transaction(() => stripPromptBatch(db, 0, 100))();
    await renameSessionId('r-new', 'r-third');
    expect(await prompts('r-third')).toEqual([PROMPT, PERSONA]);
    expect(table('r-new')).toEqual({});
  });

  it('an ACP id staging copies them to the replacement, and its rollback drops the replacement\'s', async () => {
    await createSessionRecord('acp-old', '', 'demo', '/w', { engine: 'opencode' as never, acpRuntimeId: 'rt-1', appliedAppendSystemPrompt: PROMPT, profile: { systemPrompt: PERSONA } });
    await stageAcpSessionIdMigration('acp-old', 'acp-new');
    expect(await prompts('acp-new')).toEqual([PROMPT, PERSONA]);
    expect(await prompts('acp-old')).toEqual([PROMPT, PERSONA]);
    expect(await rollbackAcpSessionIdMigration('acp-old', 'acp-new')).toBe(true);
    expect(table('acp-new')).toEqual({});
    expect(await prompts('acp-old')).toEqual([PROMPT, PERSONA]);
  });

  it('a sessions copy that removes a row removes its prompt rows with it', async () => {
    await seed('cp1');
    await seed('cp2');
    applySessionCopy({ removeIds: ['cp1'] });
    expect(table('cp1')).toEqual({});
    expect(table('cp2')).toEqual({ appliedAppendSystemPrompt: PROMPT, 'profile.systemPrompt': PERSONA });
  });

  it('deleteSessionRecords removes them; the orphan sweep removes only rows without a session', async () => {
    await seed('d1');
    await seed('d2');
    expect(await deleteSessionRecords(new Set(['d1']), 'test')).toBe(1);
    expect(table('d1')).toEqual({});
    const db = getDb()!;
    db.prepare("INSERT INTO session_prompts (claude_session_id, field, body, sha256, updated_at) VALUES ('ghost', 'appliedAppendSystemPrompt', 'x', 'y', 'z')").run();
    expect(sweepOrphanSessionPrompts(db)).toBe(1);
    expect(table('ghost')).toEqual({});
    expect(table('d2')).toEqual({ appliedAppendSystemPrompt: PROMPT, 'profile.systemPrompt': PERSONA });
  });
});

describe('the router guard on stubs (design section 6, row 6)', () => {
  async function router(): Promise<string> {
    const { task } = await addTask({ title: 'Router fixture', project: '', source: 'local', router_area_id: 'desk', org_role: 'router' });
    await createSessionRecord('router-1', task.id, '', undefined, { host: '__local__', profile: routerAreaProfile('desk'), initialProcessStatus: 'running' });
    return 'router-1';
  }

  it('isRouterAreaSession answers on a cached row as on the whole record', async () => {
    const sid = await router();
    const area = { id: 'desk', host: '__local__' } as never;
    const cached = (await listSessions()).find((s) => s.claudeSessionId === sid)!;
    expect(cached.profile?.systemPrompt).toBeUndefined();
    expect(isRouterAreaSession(cached, area)).toBe(true);
    expect(isRouterAreaSession((await getSessionByClaudeId(sid))!, area)).toBe(true);
    // A blank persona is no router's, from the text or the stub.
    const blank = { ...cached, profile: { ...cached.profile, systemPromptRef: { ...cached.profile!.systemPromptRef!, blank: true } } };
    expect(isRouterAreaSession(blank, area)).toBe(false);
  });

  it('the history rule still checks a changed router persona (a blank or missing one is refused) and still passes a status update', async () => {
    const sid = await router();
    const { systemPrompt: _persona, ...withoutPersona } = routerAreaProfile('desk');
    // The rule asks only that a router keeps a persona (isRouterAreaSession), as before the split.
    for (const profile of [{ ...routerAreaProfile('desk'), systemPrompt: '  \n' }, withoutPersona]) {
      await expect(updateSessionRecord(sid, { profile })).rejects.toMatchObject({ code: 'router_history_not_isolated', status: 409 });
    }
    await expect(updateSessionRecord(sid, { process_status: 'idle' })).resolves.toMatchObject({ process_status: 'idle' });
    // A profile built from the cached row (its persona a stub) is the same profile: no refusal, no change.
    const cached = (await listSessions()).find((s) => s.claudeSessionId === sid)!;
    await expect(updateSessionRecord(sid, { profile: cached.profile })).resolves.toBeTruthy();
    expect((await getSessionByClaudeId(sid))?.profile).toEqual(routerAreaProfile('desk'));
  });
});
