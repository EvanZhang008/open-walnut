/**
 * A turn the CLI begins on a line the chat hides opens on its first row (`opensTurn`).
 *
 * 2026-11-19: a lead session waited on a background agent, and each of the agent's progress
 * notifications woke it for one line. The CLI logs each wake-up as a `<task-notification>` user
 * line, which every history surface hides, so the rows carried no trace of the ten turn
 * boundaries: the clients read the hour as ONE turn and every new line reshaped all the lines
 * before it (folded "9 updates" while it settled, flat while the reader watched it stream).
 *
 * Every producer of history rows must say where such a turn opens, the same way: the history
 * parser (web), the primary's v1 transcript projection and the cloud companion's tail of the
 * stream file (phone). A new producer that forgets reads as the bug again, so all three run on
 * one fixture here and must agree row for row.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../../helpers/mock-constants.js';
import { mockLocalDaemonReader } from '../../helpers/mock-local-daemon-reader.js';

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-hidden-turn-start'));
vi.mock('../../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader());

const CWD = '/tmp/marina/hidden-turns';

vi.mock('../../../src/core/session-tracker.js', () => ({
  getSessionByClaudeId: async (id: string) => ({
    claudeSessionId: id,
    cwd: CWD,
    process_status: 'idle',
    startedAt: '2026-11-19T00:00:00Z',
    lastActiveAt: '2026-11-19T00:00:00Z',
  }),
}));

import { CLAUDE_HOME } from '../../../src/constants.js';
import { encodeProjectPath, parseSessionMessages } from '../../../src/core/session-history.js';
import { buildSessionTranscript } from '../../../src/core/session-projection.js';
import { transcriptFromJsonl } from '../../../src/core/sessions/transcript-from-jsonl.js';

const tmpBase = path.dirname(CLAUDE_HOME);
const at = (s: number) => `2026-11-19T03:00:${String(s).padStart(2, '0')}.000Z`;
const person = (uuid: string, text: string, s: number) => ({
  type: 'user', uuid, timestamp: at(s), origin: { kind: 'human' }, message: { role: 'user', content: text },
});
// The CLI's own line for a background agent's progress (CLI 2.1.32x transcript shape, neutral text).
const notification = (uuid: string, s: number, extra: Record<string, unknown> = {}) => ({
  type: 'user', uuid, timestamp: at(s), origin: { kind: 'task-notification' }, ...extra,
  message: { role: 'user', content: `<task-notification>\n<task-id>agent-${uuid}</task-id>\n<status>running</status>\n<summary>Still working</summary>\n</task-notification>` },
});
const said = (uuid: string, text: string, s: number, extra: Record<string, unknown> = {}) => ({
  type: 'assistant', uuid, timestamp: at(s), ...extra,
  message: { id: `msg-${uuid}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text }] },
});
const called = (uuid: string, id: string, s: number) => ({
  type: 'assistant', uuid, timestamp: at(s),
  message: { id: `msg-${uuid}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'make check' } }] },
});
const result = (uuid: string, id: string, s: number) => ({
  type: 'user', uuid, timestamp: at(s), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
});

const LINES = [
  person('u1', 'Start the work and tell me how it goes.', 1),
  said('a1', 'Started; a background agent is on it.', 2),
  notification('n1', 3),
  said('a2', 'PROGRESS_ONE tests are running.', 4),
  notification('n2', 5),
  said('a3', '<walnut-turn status="agent-ack"/>', 6),
  notification('n3', 7),
  called('a4', 'tool-1', 8),
  result('r1', 'tool-1', 9),
  said('a5', 'PROGRESS_TWO the build passed.', 10),
  // A nested agent's own notification rides its parent's lane: it opens no main turn.
  notification('n4', 11, { parent_tool_use_id: 'tool-parent' }),
  person('u2', 'Thanks, carry on.', 12),
  said('a6', 'Will do.', 13),
];

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

type Row = { role: string; text: string; kind?: string; opensTurn?: true };
/** Each row as `text|opens`, tool rows by their tool, the notification lines never among them. */
const marks = (rows: readonly Row[]) => rows.map((r) => `${r.kind === 'tool' ? `tool:${r.text}` : r.text.slice(0, 16)}${r.opensTurn ? '|opens' : ''}`);
const EXPECTED = [
  'Start the work a',
  'Started; a backg',
  'PROGRESS_ONE tes|opens',
  '<walnut-turn sta|opens',
  'tool:Bash|opens',
  'PROGRESS_TWO the',
  'Thanks, carry on',
  'Will do.',
];

describe('a turn the CLI began on a hidden notification opens on its first row', () => {
  it('the history parser marks it and hides the notification itself', () => {
    const rows = parseSessionMessages(LINES.map((l) => JSON.stringify(l)).join('\n')) as Row[];
    const shown = rows.flatMap((r): Row[] => r.role === 'assistant' && !(r.text ?? '').trim() && (r as { tools?: unknown[] }).tools?.length
      ? [{ ...r, kind: 'tool', text: 'Bash' }] : [r]);
    expect(marks(shown)).toEqual(EXPECTED);
    expect(rows.some((r) => r.text.includes('<task-notification>'))).toBe(false);
  });

  it('the primary v1 transcript marks the same rows', async () => {
    const SID = 'hidden-turn-start-primary';
    await writeJsonl(SID, LINES);
    for (const opts of [{}, { live: true }, { rich: true }, { full: true }]) {
      const rows = (await buildSessionTranscript(SID, opts)).messages as Row[];
      expect(marks(rows)).toEqual(EXPECTED);
    }
  });

  it("the cloud companion's tail of the stream file marks the same rows", () => {
    const out = transcriptFromJsonl('hidden-turn-start-cloud', LINES.map((l) => JSON.stringify(l)).join('\n'));
    expect(marks(out.messages as Row[])).toEqual(EXPECTED);
  });

  // A notification taken while the turn ran: the CLI writes only its enqueue and a
  // queued_command attachment (no user line), and it opens no turn on any producer.
  const NOTE = '<task-notification>\n<task-id>agent-mid</task-id>\n<status>completed</status>\n</task-notification>';
  const MID_TURN = [
    person('u1', 'Run the checks.', 1),
    called('a1', 'tool-1', 2),
    { type: 'queue-operation', operation: 'enqueue', timestamp: at(3), sessionId: 's', content: NOTE },
    result('r1', 'tool-1', 4),
    { type: 'attachment', uuid: 'q1', parentUuid: 'r1', timestamp: at(4), attachment: { type: 'queued_command', prompt: NOTE, commandMode: 'task-notification' } },
    { type: 'queue-operation', operation: 'remove', timestamp: at(4), sessionId: 's', content: NOTE },
    called('a2', 'tool-2', 5),
    result('r2', 'tool-2', 6),
    said('a3', 'All checks passed.', 7),
  ];
  it('a notification taken mid-turn opens no turn', async () => {
    const parsed = parseSessionMessages(MID_TURN.map((l) => JSON.stringify(l)).join('\n')) as Row[];
    expect(parsed.filter((r) => r.opensTurn)).toEqual([]);
    const SID = 'hidden-turn-start-mid-turn';
    await writeJsonl(SID, MID_TURN);
    expect(((await buildSessionTranscript(SID, { rich: true })).messages as Row[]).filter((r) => r.opensTurn)).toEqual([]);
    expect((transcriptFromJsonl(SID, MID_TURN.map((l) => JSON.stringify(l)).join('\n')).messages as Row[]).filter((r) => r.opensTurn)).toEqual([]);
  });

  it('the v1 transcript passes the mark on past a row it leaves out', async () => {
    // A Walnut notice (a system row, never a transcript row) right after the hidden line.
    const SID = 'hidden-turn-start-notice-first';
    await writeJsonl(SID, [
      person('u1', 'Start.', 1),
      said('a1', 'Started.', 2),
      notification('n1', 3),
      said('a2', 'Prompt is too long', 4, { isApiErrorMessage: true, error: 'invalid_request' }),
      said('a3', 'PROGRESS_ONE resumed.', 5),
    ]);
    const rows = (await buildSessionTranscript(SID, { rich: true })).messages as Row[];
    expect(rows.filter((r) => r.opensTurn).length).toBe(1);
  });
});
