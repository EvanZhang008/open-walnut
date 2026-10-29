/**
 * Claude Code 2.1.284+ writes `api-request-blob` lines into the transcript: a copy
 * of each request message as the model received it (instruction files, MEMORY.md
 * and Walnut's hints merged in), with a role but no uuid or timestamp. They are
 * not conversation messages. Read as rows, they showed a session's whole memory
 * file and its CLAUDE.md as if the user had sent them, stamped "now", once per
 * resume (2026-10-29: a woken worker and its lead both read like that).
 *
 * Line shapes below are the real ones (keys: type, sessionId, hash, message),
 * with neutral content.
 */
import { describe, it, expect, vi } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import { parseSessionMessages } from '../../src/core/session-history.js';

const SID = 'blob-sid';
const INSTRUCTIONS = '<system-reminder>\nInstruction files were re-read when this session started; these differ from their earlier copies:\n\n'
  + 'Contents of /home/u/.claude/projects/acme/memory/MEMORY.md (user\'s auto-memory, persists across conversations):\n\n# Acme Memory\n- a lesson\n</system-reminder>';
const WAKE = '<walnut-message kind="trigger" from="Walnut: wait until" note="the time this task was waiting for has passed">\nThe wait on this task ran until Oct 29.\n</walnut-message>';
const HINT = '<system-reminder>\nWalnut (reply-language): Talk to the user in English.\n</system-reminder>';

function line(o: Record<string, unknown>): string { return JSON.stringify(o); }

function blob(role: string, content: unknown, hash: string): string {
  return line({ type: 'api-request-blob', sessionId: SID, hash, message: { role, content } });
}

const transcript = [
  line({ type: 'user', uuid: 'u1', parentUuid: null, sessionId: SID, timestamp: '2026-10-29T02:01:06.608Z', message: { role: 'user', content: `${WAKE}\n\n${HINT}` } }),
  line({ type: 'attachment', uuid: 'a1', parentUuid: 'u1', sessionId: SID, timestamp: '2026-10-29T02:01:06.703Z', attachment: { type: 'instructions', files: [{ path: '/home/u/.claude/CLAUDE.md', type: 'User', content: '- rule' }] } }),
  line({ type: 'api-request-shape', sessionId: SID }),
  blob('system', [{ type: 'text', text: 'You are an interactive agent.' }], 'h0'),
  blob('user', [{ type: 'text', text: INSTRUCTIONS }, { type: 'text', text: `${WAKE}\n\n[Rich output mode is still on: markdown first]` }], 'h1'),
  blob('assistant', [{ type: 'text', text: 'Copy of an earlier answer.' }], 'h2'),
  blob('user', `${INSTRUCTIONS}\n${WAKE}`, 'h3'),
  line({ type: 'assistant', uuid: 'x1', parentUuid: 'a1', sessionId: SID, timestamp: '2026-10-29T02:01:37.789Z', message: { id: 'msg_1', role: 'assistant', content: [{ type: 'text', text: 'Checked: nothing changed, parked again.' }] } }),
].join('\n') + '\n';

describe('api-request-blob transcript lines', () => {
  it('are never conversation rows: the wake and the real answer are the only rows', () => {
    const msgs = parseSessionMessages(transcript);
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(msgs[1]!.text).toBe('Checked: nothing changed, parked again.');
    for (const m of msgs) {
      expect(m.text).not.toContain('Instruction files were re-read');
      expect(m.text).not.toContain('MEMORY.md');
      expect(m.text).not.toContain('Rich output mode');
      expect(m.text).not.toContain('Copy of an earlier answer');
      expect(m.text).not.toContain('<system-reminder');
    }
    // Every row keeps its own time: none is stamped "now" for want of one.
    expect(msgs.map((m) => m.timestamp)).toEqual(['2026-10-29T02:01:06.608Z', '2026-10-29T02:01:37.789Z']);
  });

  it('the wake row shows its words with the hint taken off', () => {
    const [wake] = parseSessionMessages(transcript);
    expect(wake!.text).toContain('The wait on this task ran until Oct 29.');
    expect(wake!.text).not.toContain('reply-language');
  });

  it('a line with no type (an older capture) still reads as a message', () => {
    const msgs = parseSessionMessages(line({ uuid: 'o1', timestamp: '2026-01-01T00:00:00.000Z', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: 'old row' }] } }) + '\n');
    expect(msgs.map((m) => m.text)).toEqual(['old row']);
  });
});
