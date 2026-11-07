/**
 * The phone's transcript user rows name the queue row they delivered (`walnutMessageId`).
 *
 * 2026-11-06, the user's phone: a message showed twice, as its queue card and as the
 * transcript's row, because the phone could only pair them by text. The id the phone
 * posted (`qm-mobile-…`, the queue row id) now rides the user row on both producers of
 * the v1 transcript: the primary's projection (buildSessionTranscript, bound by the
 * echo-claim registry over a real fixture JSONL) and the companion's tail of the
 * stream file (transcriptFromJsonl, from the daemon's walnut-injected marker).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../../helpers/mock-constants.js';
import { mockLocalDaemonReader } from '../../helpers/mock-local-daemon-reader.js';

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-transcript-message-id'));
vi.mock('../../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader());

const CWD = '/tmp/marina/workspace';

vi.mock('../../../src/core/session-tracker.js', () => ({
  getSessionByClaudeId: async (id: string) => ({
    claudeSessionId: id,
    cwd: CWD,
    process_status: 'idle',
    startedAt: '2026-11-06T00:00:00Z',
    lastActiveAt: '2026-11-06T00:00:00Z',
  }),
}));

import { CLAUDE_HOME } from '../../../src/constants.js';
import { encodeProjectPath } from '../../../src/core/session-history.js';
import { buildSessionTranscript } from '../../../src/core/session-projection.js';
import { transcriptFromJsonl } from '../../../src/core/sessions/transcript-from-jsonl.js';
import { registerEchoClaims } from '../../../src/core/echo-claims.js';

const tmpBase = path.dirname(CLAUDE_HOME);
const at = (s: number) => new Date(Date.now() + s * 1000).toISOString();
const user = (uuid: string, text: string, s: number) => ({
  type: 'user', uuid, timestamp: at(s), message: { role: 'user', content: [{ type: 'text', text }] },
});
const assistant = (uuid: string, text: string, s: number) => ({
  type: 'assistant', uuid, timestamp: at(s),
  message: { id: `msg-${uuid}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text }] },
});

beforeEach(async () => {
  await fsp.rm(tmpBase, { recursive: true, force: true });
  await fsp.mkdir(tmpBase, { recursive: true });
});

afterEach(async () => {
  await fsp.rm(tmpBase, { recursive: true, force: true }).catch(() => {});
});

type Row = { role: string; text: string; kind?: string; walnutMessageId?: string };

describe('the v1 transcript names the queue row a user line delivered', () => {
  it('the primary projection carries the bound id on that user row only', async () => {
    const SID = 'transcript-message-id-primary';
    const dir = path.join(CLAUDE_HOME, 'projects', encodeProjectPath(CWD));
    await fsp.mkdir(dir, { recursive: true });
    registerEchoClaims(SID, ['qm-mobile-07094d496de9'], 'from the phone');
    await fsp.writeFile(path.join(dir, `${SID}.jsonl`), [
      user('u1', 'typed in a terminal', 1),
      assistant('a1', 'ok', 2),
      user('u2', 'from the phone', 3),
      assistant('a2', 'got it', 4),
    ].map((l) => JSON.stringify(l)).join('\n'));
    for (const opts of [{}, { live: true }, { rich: true }]) {
      const rows = ((await buildSessionTranscript(SID, opts)).messages as Row[]).filter((r) => !r.kind);
      const users = rows.filter((r) => r.role === 'user');
      expect(users.map((r) => [r.text, r.walnutMessageId])).toEqual([
        ['typed in a terminal', undefined],
        ['from the phone', 'qm-mobile-07094d496de9'],
      ]);
      expect(rows.filter((r) => r.role === 'assistant').every((r) => r.walnutMessageId === undefined)).toBe(true);
    }
  });

  it("the companion's tail of the stream file reads the id off the daemon's marker", () => {
    const main = [
      JSON.stringify({ type: 'user', subtype: 'walnut-injected', message: { role: 'user', content: 'from the phone' }, walnutMessageId: 'qm-mobile-abc123', timestamp: at(1) }),
      JSON.stringify(assistant('a1', 'got it', 2)),
      JSON.stringify(user('u2', 'no marker', 3)),
    ].join('\n');
    const rows = (transcriptFromJsonl('transcript-message-id-cloud', main) as { messages: Row[] }).messages;
    expect(rows.filter((r) => r.role === 'user').map((r) => [r.text, r.walnutMessageId])).toEqual([
      ['from the phone', 'qm-mobile-abc123'],
      ['no marker', undefined],
    ]);
  });
});
