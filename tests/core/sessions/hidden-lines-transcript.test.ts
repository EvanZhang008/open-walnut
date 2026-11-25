/**
 * The phone's transcript rows carry what Walnut hid from a reply (`hidden`), on a rich read only,
 * so a developer's phone folds it under the reply as the web does (ui.show_hidden_lines,
 * 2026-11-25). Over a real fixture JSONL read by the real history parser.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../../helpers/mock-constants.js';
import { mockLocalDaemonReader } from '../../helpers/mock-local-daemon-reader.js';

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-hidden-lines-transcript'));
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

const tmpBase = path.dirname(CLAUDE_HOME);
const at = (s: number) => `2026-11-06T09:00:${String(s).padStart(2, '0')}.000Z`;
const user = (uuid: string, text: string, s: number) => ({
  type: 'user', uuid, timestamp: at(s), message: { role: 'user', content: [{ type: 'text', text }] },
});
const assistant = (uuid: string, text: string, s: number, fields: Record<string, unknown> = {}, model = 'claude-opus-5-5') => ({
  type: 'assistant', uuid, timestamp: at(s), ...fields,
  message: { id: `msg-${uuid}`, type: 'message', role: 'assistant', model, content: [{ type: 'text', text }] },
});

beforeEach(async () => {
  await fsp.rm(tmpBase, { recursive: true, force: true });
  await fsp.mkdir(tmpBase, { recursive: true });
});

afterEach(async () => {
  await fsp.rm(tmpBase, { recursive: true, force: true }).catch(() => {});
});

async function writeJsonl(sessionId: string, lines: unknown[]): Promise<void> {
  const dir = path.join(CLAUDE_HOME, 'projects', encodeProjectPath(CWD));
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n'));
}

type Row = { role: string; text: string; kind?: string; hidden?: string };

describe('the v1 transcript carries the lines Walnut hid from a reply', () => {
  it('a rich read has them on the reply row; a slim read and a whole reply have none', async () => {
    const SID = 'hidden-lines-transcript';
    await writeJsonl(SID, [
      user('u1', 'is it live?', 1),
      assistant('a1', 'Yes, it is live.\n\nFOR_USER_STATE: answered\nFOR_USER_NOW: nothing runs', 2),
      user('u2', 'thanks', 3),
      assistant('a2', 'You are welcome.', 4),
    ]);
    const rich = (await buildSessionTranscript(SID, { rich: true })).messages as Row[];
    const reply = rich.find((r) => r.text.startsWith('Yes, it is live.'));
    expect(reply?.text).toBe('Yes, it is live.');
    expect(reply?.hidden).toBe('FOR_USER_STATE: answered\nFOR_USER_NOW: nothing runs');
    expect(rich.find((r) => r.text === 'You are welcome.')).not.toHaveProperty('hidden');
    // The slim tail rides the bridge under a frame cap: no hidden lines there.
    const slim = (await buildSessionTranscript(SID)).messages as Row[];
    expect(slim.some((r) => r.hidden)).toBe(false);
  });
});
