/**
 * A Claude Code hook's added context reaches the model as a
 * `hook_additional_context` attachment line and was in no history row, so the
 * chat never showed it (2026-10-29: nothing added to a turn may stay invisible).
 * It is now an injected context row at its place. Line shapes are the CLI's,
 * neutral text.
 */
import { describe, expect, it } from 'vitest';
import { hookContextText, parseSessionMessages } from '../../src/core/session-history.js';

const T = (s: number) => new Date(Date.UTC(2026, 9, 29, 20, 0, s)).toISOString();
const parse = (lines: unknown[]) => parseSessionMessages(lines.map((l) => JSON.stringify(l)).join('\n'));
function user(uuid: string, parent: string | null, content: unknown, s: number) {
  return { type: 'user', uuid, parentUuid: parent, timestamp: T(s), message: { role: 'user', content } };
}
function assistant(uuid: string, parent: string, id: string, text: string, s: number) {
  return { type: 'assistant', uuid, parentUuid: parent, timestamp: T(s), message: { id, role: 'assistant', content: [{ type: 'text', text }] } };
}
function hookContext(uuid: string, parent: string, content: unknown, s: number, hookEvent = 'SessionStart') {
  return {
    type: 'attachment', uuid, parentUuid: parent, isSidechain: false, timestamp: T(s),
    attachment: { type: 'hook_additional_context', content, hookName: hookEvent, toolUseID: hookEvent, hookEvent },
  };
}

describe('hook added context in history', () => {
  it('is an injected context row at its place, its text whole', () => {
    const rows = parse([
      user('u1', null, 'Please tidy the notes.', 0),
      hookContext('h1', 'u1', ['Your task stands in project "Sample".', 'Still open: one review.'], 1),
      assistant('a1', 'h1', 'msg_1', 'Done.', 2),
    ]);
    expect(rows.map((r) => `${r.role}${r.injected ? '*' : ''}`)).toEqual(['user', 'user*', 'assistant']);
    expect(rows[1].text).toBe('Hook context (SessionStart hook):\n\nYour task stands in project "Sample".\n\nStill open: one review.');
  });

  it('adds nothing for an empty hook output, and keeps an unknown event name out of the text', () => {
    expect(parse([user('u1', null, 'Hi.', 0), hookContext('h1', 'u1', ['', '  '], 1)]).map((r) => r.role)).toEqual(['user']);
    expect(hookContextText(['note'], 'Bad event!')).toBe('Hook context (a hook):\n\nnote');
    expect(hookContextText('one string', 'PostToolUse')).toBe('Hook context (PostToolUse hook):\n\none string');
    expect(hookContextText(undefined, 'PostToolUse')).toBeNull();
  });
});
