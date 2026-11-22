/**
 * The session store cache leaves a stopped session's heavy prompt fields in SQLite
 * (2026-11-20 memory work: about 90 MB of the live server's heap on the maintainer's board).
 * A single-row read still has them; a list reader that needs them goes through withHeavyFields.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import {
  createSessionRecord, listSessions, getSessionByClaudeId, updateSessionRecord, withHeavyFields,
  _resetSessionTrackerForTesting,
} from '../../src/core/session-tracker.js';
import { closeDb } from '../../src/core/session-db.js';
import { WALNUT_HOME } from '../../src/constants.js';

const PROMPT = 'spawn prompt 中文 '.repeat(500);
const PERSONA = 'persona text '.repeat(800);

beforeEach(async () => {
  closeDb();
  _resetSessionTrackerForTesting();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
});
afterEach(async () => {
  closeDb();
  _resetSessionTrackerForTesting();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {});
});

async function seed(id: string, status: 'running' | 'stopped' | 'error'): Promise<void> {
  await createSessionRecord(id, '', 'demo');
  await updateSessionRecord(id, {
    process_status: status, appliedAppendSystemPrompt: PROMPT,
    profile: { systemPrompt: PERSONA, label: 'lane' } as never,
  });
}

describe('session store cache: heavy prompt fields', () => {
  it('a stopped or errored session is listed without them and read whole by id', async () => {
    await seed('s-stopped', 'stopped');
    await seed('s-error', 'error');
    await seed('s-live', 'running');
    const listed = new Map((await listSessions()).map((s) => [s.claudeSessionId, s]));
    for (const id of ['s-stopped', 's-error']) {
      expect(listed.get(id)?.appliedAppendSystemPrompt).toBeUndefined();
      expect(listed.get(id)?.profile?.systemPrompt).toBeUndefined();
      expect((listed.get(id)?.profile as { label?: string } | undefined)?.label).toBe('lane');
      const whole = await getSessionByClaudeId(id);
      expect(whole?.appliedAppendSystemPrompt).toBe(PROMPT);
      expect(whole?.profile?.systemPrompt).toBe(PERSONA);
      const filled = withHeavyFields(listed.get(id)!);
      expect(filled.appliedAppendSystemPrompt).toBe(PROMPT);
      expect(filled.profile?.systemPrompt).toBe(PERSONA);
    }
    expect(listed.get('s-live')?.appliedAppendSystemPrompt).toBe(PROMPT);
    expect(listed.get('s-live')?.profile?.systemPrompt).toBe(PERSONA);
    expect(withHeavyFields(listed.get('s-live')!)).toBe(listed.get('s-live'));
  });

  it('a write to a stopped session never erases them, and a session that comes back carries them again', async () => {
    await seed('s1', 'stopped');
    await listSessions();
    await updateSessionRecord('s1', { title: 'renamed' });
    expect((await getSessionByClaudeId('s1'))?.appliedAppendSystemPrompt).toBe(PROMPT);
    await updateSessionRecord('s1', { process_status: 'running' });
    const back = (await listSessions()).find((s) => s.claudeSessionId === 's1');
    expect(back?.appliedAppendSystemPrompt).toBe(PROMPT);
    expect(back?.profile?.systemPrompt).toBe(PERSONA);
  });
});

/**
 * Every file that reads these two fields, as audited on 2026-11-20: each takes its record from a
 * single-row SQLite read (getSessionByClaudeId, getSessionByLane, a write transaction), builds the
 * value itself, or goes through withHeavyFields. A NEW reader fails here: check where its record
 * comes from (a list reads them as absent for a stopped session) and add it.
 */
const AUDITED_READERS: readonly string[] = [
  'src/core/offline-merge/apply-session.ts',
  'src/core/replication/kinds/personas.ts',
  'src/core/replication/kinds/sessions.ts',
  'src/core/router/session-policy.ts',
  'src/core/router/simplify-migration.ts',
  'src/core/session-tracker.ts',
  'src/core/sessions/ask-profile-prefix.ts',
  'src/core/sessions/cloud-chat-lane.ts',
  'src/core/sessions/instruction-notice.ts',
  'src/core/sessions/lane-turn-catch-up.ts',
  'src/core/sessions/own-readback.ts',
  'src/core/sessions/personal-ai-lane.ts',
  'src/core/sessions/place-notice.ts',
  'src/core/sessions/prompt-refresh-respawn.ts',
  'src/core/sessions/prompt-refresh.ts',
  'src/core/sessions/side-thread-fork.ts',
  'src/core/sessions/session-row-owner.ts', // names the field in its owner table; reads no record
  'src/core/sessions/spawn-prefix.ts',
  'src/core/types.ts',
  'src/providers/claude-code-session.ts',
  'src/web/routes/context-inspector.ts',
  'src/web/routes/sessions.ts',
];

describe('ratchet: readers of the heavy prompt fields are audited', () => {
  it('names every file that reads them, and no file that no longer does', () => {
    const root = path.resolve(__dirname, '../..');
    const found: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!/\.tsx?$/.test(e.name) || /\.test\./.test(e.name)) continue;
        const rel = path.relative(root, p).split(path.sep).join('/');
        if (rel === 'src/providers/daemon-source.ts' || rel === 'src/providers/daemon-standalone.ts') continue;
        if (/appliedAppendSystemPrompt|profile\??\.systemPrompt/.test(fs.readFileSync(p, 'utf8'))) found.push(rel);
      }
    };
    walk(path.join(root, 'src'));
    expect(found.filter((f) => !AUDITED_READERS.includes(f)), 'new readers: check their record source').toEqual([]);
    expect(AUDITED_READERS.filter((f) => !found.includes(f)), 'stale entries').toEqual([]);
  });
});
