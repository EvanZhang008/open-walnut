/**
 * Claude Code's own error reply is its error line, never the assistant's answer.
 *
 * 2026-11-06: "Prompt is too long" (and every "API Error: ...") drew as the assistant's bubble, as if
 * the model had said it. The CLI writes it as a synthetic assistant message it marks itself
 * (utils/messages.ts createAssistantAPIErrorMessage: `isApiErrorMessage` in the transcript, `error`
 * on the stream-json line), so the history reads that mark, in both forms a session's history is
 * read from, and only that mark: the CLI's other synthetic messages and every model reply stay
 * answers. The live twin is in tests/providers/claude-code-session.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { parseSessionMessages, CLI_ERROR_PREFIX } from '../../../src/core/session-history.js';
import { compactedAtOrAfter } from '../../../src/core/sessions/context-full-recovery.js';

const at = (s: number) => `2026-11-06T09:00:${String(s).padStart(2, '0')}.000Z`;
const user = (uuid: string, text: string, s: number) => ({ type: 'user', uuid, timestamp: at(s), message: { role: 'user', content: text } });
const assistant = (uuid: string, text: string, s: number, fields: Record<string, unknown> = {}, model = '<synthetic>') => ({
  type: 'assistant', uuid, timestamp: at(s), ...fields,
  message: { id: `msg-${uuid}`, type: 'message', role: 'assistant', model, content: [{ type: 'text', text }] },
});
const parse = (lines: object[]) => parseSessionMessages(lines.map((l) => JSON.stringify(l)).join('\n'));

describe("Claude Code's own error reply in a session's history", () => {
  const replies = ['Prompt is too long', 'API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}', 'Input is too long for requested model.'];

  for (const text of replies) {
    it(`reads "${text.slice(0, 24)}" as the CLI's error line, in the transcript and in the stream capture`, () => {
      for (const fields of [{ isApiErrorMessage: true, error: 'invalid_request' }, { error: 'invalid_request' }]) {
        const rows = parse([user('u1', 'hi', 1), assistant('a1', text, 2, fields)]);
        expect(rows.map((r) => r.role)).toEqual(['user', 'system']);
        expect(rows[1]).toMatchObject({ role: 'system', systemVariant: 'error', cliError: true, text: `${CLI_ERROR_PREFIX}${text}` });
      }
    });
  }

  it('the CLI\'s other synthetic messages and a model\'s reply naming the phrase stay answers', () => {
    const rows = parse([
      user('u1', 'hi', 1),
      assistant('a1', 'No response requested.', 2),
      user('u2', 'why?', 3),
      assistant('a2', 'Your prompt is too long for one message, so I split it.', 4, {}, 'claude-opus-5-5'),
    ]);
    expect(rows.map((r) => [r.role, r.cliError ?? false])).toEqual([['user', false], ['assistant', false], ['user', false], ['assistant', false]]);
  });

  it('the recovery still finds the overflow it compacted for, read as an error line', () => {
    const rows = parse([user('u1', 'hi', 1), assistant('a1', 'Prompt is too long', 2, { isApiErrorMessage: true })]);
    const done = { role: 'system', systemVariant: 'compact', text: 'Context compacted', timestamp: at(1) };
    // The host's clock is behind: the compaction's own time is before the overflow's.
    expect(compactedAtOrAfter([...rows, done], at(30))).toBe(true);
    expect(compactedAtOrAfter([done, ...rows], at(30))).toBe(false);
  });
});

describe('every reader of the turn keeps it', () => {
  it('the transcript keeps it as the turn\'s last words, and a notice says it answered nothing', async () => {
    const { lastTurnOf, CONTEXT_FULL_NOTICE_WORDS } = await import('../../../src/core/sessions/session-request-notify.js');
    const { readFileSync } = await import('node:fs');
    // buildSessionTranscript (task_history, notices, last_words, the phone) maps the row back to the
    // CLI's own words; without it the turn read empty and a notice quoted an EARLIER answer.
    expect(readFileSync(new URL('../../../src/core/session-projection.ts', import.meta.url), 'utf8'))
      .toMatch(/row\.role === 'system' && row\.cliError \? \{ \.\.\.row, role: 'assistant' as const \}/);
    const turn = lastTurnOf([
      { role: 'assistant', text: 'An earlier answer.' },
      { role: 'user', text: 'please reply to rq-1' },
      { role: 'assistant', text: `${CLI_ERROR_PREFIX}Prompt is too long` },
    ]);
    expect(turn?.words?.text).toBe(CONTEXT_FULL_NOTICE_WORDS);
  });

  it('a reconnecting client\'s snapshot draws it as the live stream does', async () => {
    const { sessionStreamBuffer } = await import('../../../src/web/session-stream-buffer.js');
    const SID = 'cli-error-row-buffer';
    sessionStreamBuffer.clear(SID);
    sessionStreamBuffer.markStreaming(SID);
    sessionStreamBuffer.appendSystem(SID, 'error', `${CLI_ERROR_PREFIX}Prompt is too long`, undefined, undefined, 'u-ptl', undefined, true);
    expect(sessionStreamBuffer.getSnapshot(SID).blocks.filter((b) => b.type === 'system'))
      .toEqual([expect.objectContaining({ variant: 'error', cliError: true, uuid: 'u-ptl' })]);
    sessionStreamBuffer.clear(SID);
  });
});
