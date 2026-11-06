/**
 * The phone's transcript rows of Claude Code's own error reply ("Prompt is too long").
 *
 * 2026-11-06: the web drew it as an error line (cli-error-rows.test.ts) while the phone still drew
 * it as the assistant's bubble, because the v1 transcript maps the history's error row back to
 * `role: 'assistant'` (it is the turn's last words for task_history, notices and last_words) and
 * said nothing more. The row now carries `cliError: true`, on both producers of these rows: the
 * primary's projection (buildSessionTranscript, over a real fixture JSONL read by the real history
 * parser) and the cloud companion's tail of the stream file (transcriptFromJsonl).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../../helpers/mock-constants.js';
import { mockLocalDaemonReader } from '../../helpers/mock-local-daemon-reader.js';

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-cli-error-transcript'));
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
import { CLI_ERROR_PREFIX } from '../../../src/core/sessions/cli-error-reply.js';

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

type Row = { role: string; text: string; kind?: string; cliError?: true };

describe("the v1 transcript marks Claude Code's own error reply", () => {
  it('the primary projection keeps it role assistant, marked cliError, its text the error line', async () => {
    const SID = 'cli-error-transcript-primary';
    await writeJsonl(SID, [
      user('u1', 'hi', 1),
      assistant('a1', 'Hello there.', 2),
      user('u2', 'please go on', 3),
      assistant('a2', 'Prompt is too long', 4, { isApiErrorMessage: true, error: 'invalid_request' }, '<synthetic>'),
    ]);
    for (const opts of [{}, { live: true }, { rich: true }, { full: true }]) {
      const rows = (await buildSessionTranscript(SID, opts)).messages as Row[];
      const texts = rows.filter((r) => !r.kind);
      expect(texts.map((r) => r.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
      const last = texts[texts.length - 1];
      expect(last).toMatchObject({ role: 'assistant', cliError: true, text: `${CLI_ERROR_PREFIX}Prompt is too long` });
      expect(last.text.startsWith('Claude Code: ')).toBe(true);
      // The model's own reply is an answer, unmarked.
      expect(texts[1].cliError).toBeUndefined();
    }
  });

  it("the cloud's tail of the stream file reads the same row, and a model reply naming the phrase stays an answer", () => {
    const main = [
      user('u1', 'hi', 1),
      // The stream-json form: no transcript mark, the error named on the synthetic message.
      assistant('a1', 'API Error: 529 overloaded', 2, { error: 'overloaded' }, '<synthetic>'),
      user('u2', 'why?', 3),
      assistant('a2', 'Your prompt is too long for one message, so I split it.', 4),
    ].map((l) => JSON.stringify(l)).join('\n');
    const rows = (transcriptFromJsonl('cli-error-transcript-cloud', main) as { messages: Row[] }).messages;
    expect(rows.map((r) => [r.role, r.cliError ?? false])).toEqual([
      ['user', false], ['assistant', true], ['user', false], ['assistant', false],
    ]);
    expect(rows[1].text).toBe(`${CLI_ERROR_PREFIX}API Error: 529 overloaded`);
  });
});
