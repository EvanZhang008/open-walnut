/**
 * An attach from a listed record (the startup reconcile reads the cache, whose profiles carry a
 * stub of the persona and no text, session-db.ts): the instance keeps the whole profile, so a
 * record it writes again (a lost row, a new id) keeps the persona.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';
import { mockLocalDaemonReader } from '../helpers/mock-local-daemon-reader.js';

vi.mock('../../src/constants.js', () => createMockConstants());
vi.mock('../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader());

import { ClaudeCodeSession } from '../../src/providers/claude-code-session.js';
import { bus } from '../../src/core/event-bus.js';
import { WALNUT_HOME, SESSION_STREAMS_DIR } from '../../src/constants.js';
import { createSessionRecord, deleteSessionRecords, getSessionByClaudeId, listSessions } from '../../src/core/session-tracker.js';
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js';

const MOCK_CLI = path.resolve(import.meta.dirname, 'mock-claude.mjs');
const PERSONA = 'persona text '.repeat(300);
let daemon: MockDaemon;

beforeAll(async () => { daemon = await createMockDaemon(); });
afterAll(async () => { await daemon.stop().catch(() => {}); });
beforeEach(async () => {
  bus.clear();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(SESSION_STREAMS_DIR, { recursive: true });
});
afterEach(async () => {
  bus.clear();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
});

describe('attach from a listed record', () => {
  it('keeps the whole profile, and the record it writes again after its row was lost keeps the persona', async () => {
    await createSessionRecord('att-1', 'task-att', 'proj', '/tmp', {
      pid: 999999, outputFile: '/tmp/nonexistent.jsonl', profile: { systemPrompt: PERSONA, systemPromptMode: 'append', allowedTools: ['Read'] },
    });
    const listed = (await listSessions()).find((r) => r.claudeSessionId === 'att-1')!;
    expect(listed.profile?.systemPrompt).toBeUndefined();
    expect(listed.profile?.systemPromptRef?.bytes).toBe(PERSONA.length);
    const session = await ClaudeCodeSession.attachToExisting(listed, MOCK_CLI, `ws://127.0.0.1:${daemon.port}`) as ClaudeCodeSession & {
      _profile: { systemPrompt?: string } | undefined; persistSessionRecord(sid: string, cwd?: string): Promise<void>; detach(): void;
    };
    try {
      expect(session._profile?.systemPrompt).toBe(PERSONA);
      await deleteSessionRecords(new Set(['att-1']), 'test: a lost row');
      await session.persistSessionRecord('att-1', '/tmp');
      expect((await getSessionByClaudeId('att-1'))?.profile?.systemPrompt).toBe(PERSONA);
    } finally {
      session.detach();
    }
  });
});
