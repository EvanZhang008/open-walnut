/**
 * A message sent while a turn runs reaches the model as a `queued_command`
 * attachment, and the CLI then logs `remove` for it (query.ts: the queue is
 * drained into attachments, then `removeFromQueue(consumedCommands)`). A Stop
 * with cancel_queued also logs `remove`, but with no attachment. Only that
 * second kind was never part of the conversation.
 *
 * Regression pinned here (inc-1790637095180): every `remove` was read as a
 * drop, so a mid-turn send vanished from history and its "Delivered" bubble
 * stayed below the later turns, as if it were the newest message.
 * Line shapes are the CLI 2.1.280 transcript's, neutral text.
 */
import { describe, it, expect } from 'vitest';
import { parseSessionMessages } from '../../src/core/session-history.js';

const T = (s: number) => new Date(Date.UTC(2026, 8, 28, 23, 0, s)).toISOString();

function enqueue(content: string, s: number) {
  return { type: 'queue-operation', operation: 'enqueue', timestamp: T(s), sessionId: 's', content };
}
function remove(content: string, s: number) {
  return { type: 'queue-operation', operation: 'remove', timestamp: T(s), sessionId: 's', content };
}
function dequeue(s: number) {
  return { type: 'queue-operation', operation: 'dequeue', timestamp: T(s), sessionId: 's' };
}
function queuedCommand(uuid: string, parent: string, prompt: unknown, s: number, extra: Record<string, unknown> = {}) {
  return {
    type: 'attachment', uuid, parentUuid: parent, isSidechain: false, timestamp: T(s),
    attachment: { type: 'queued_command', prompt, commandMode: 'prompt', source_uuid: `src-${uuid}`, ...extra },
  };
}
function reminder(uuid: string, parent: string, s: number) {
  return { type: 'attachment', uuid, parentUuid: parent, timestamp: T(s), attachment: { type: 'total_tokens_reminder' } };
}
function user(uuid: string, parent: string | null, content: unknown, s: number, extra: Record<string, unknown> = {}) {
  return { type: 'user', uuid, parentUuid: parent, timestamp: T(s), message: { role: 'user', content }, ...extra };
}
function assistant(uuid: string, parent: string, id: string, content: unknown[], s: number) {
  return { type: 'assistant', uuid, parentUuid: parent, timestamp: T(s), message: { id, role: 'assistant', content } };
}
const toolUse = (id: string) => ({ type: 'tool_use', id, name: 'Bash', input: { command: 'sleep 60' } });
const toolResult = (id: string) => [{ type: 'tool_result', tool_use_id: id, content: 'ok' }];

const parse = (lines: unknown[]) => parseSessionMessages(lines.map((l) => JSON.stringify(l)).join('\n'));
/** What a reader sees: the typed messages, the assistant's words, and the system rows. */
function timeline(lines: unknown[]): string[] {
  return parse(lines)
    .filter((m) => !m.injected)
    .map((m) => (m.role === 'assistant' && !m.text && m.tools?.length ? `${m.role}:[tool]` : `${m.role}:${m.text}`));
}

const A = 'Cut the migration section entirely.';
const B = 'Code is the source of truth, not the docs.';
const C = 'Now remove the paragraph about two copies.';

describe('mid-turn sends the CLI consumed as queued_command attachments', () => {
  it('shows the message at its place in the turn, across a mid-turn compaction (incident shape)', () => {
    const lines = [
      enqueue(A, 0), dequeue(0),
      user('uA', null, A, 1),
      assistant('a1', 'uA', 'msg_1', [{ type: 'thinking', thinking: 'plan' }], 19),
      assistant('a2', 'a1', 'msg_1', [toolUse('toolu_1')], 32),
      enqueue(B, 46),
      user('tr1', 'a2', toolResult('toolu_1'), 155),
      queuedCommand('q1', 'tr1', B, 46),
      reminder('r1', 'q1', 155),
      remove(B, 155),
      { type: 'system', subtype: 'compact_boundary', uuid: 'cb', parentUuid: null, logicalParentUuid: 'r1', timestamp: T(378), content: 'Conversation compacted', compactMetadata: { trigger: 'auto', preTokens: 500_000 } },
      user('sum', 'cb', 'This session is being continued from a previous conversation.', 378, { isCompactSummary: true, isVisibleInTranscriptOnly: true }),
      enqueue(C, 397),
      assistant('a3', 'sum', 'msg_2', [{ type: 'text', text: 'The migration section is gone.' }], 399),
      { type: 'system', subtype: 'stop_hook_summary', uuid: 'sh', parentUuid: 'a3', timestamp: T(399) },
      dequeue(399),
      user('uC', 'sh', C, 399),
      assistant('a4', 'uC', 'msg_3', [{ type: 'text', text: 'Proposed edits below.' }], 450),
    ];
    const rows = timeline(lines);
    expect(rows.filter((r) => r === `user:${B}`)).toHaveLength(1);
    expect(rows).toEqual([
      `user:${A}`,
      'assistant:[tool]',
      `user:${B}`,
      'system:Context compacted',
      'assistant:The migration section is gone.',
      `user:${C}`,
      'assistant:Proposed edits below.',
    ]);
    // Placed where it was sent: the enqueue's own time, not the time the tool finished.
    expect(parse(lines).find((m) => m.text === B)?.timestamp).toBe(T(46));
  });

  it('counts the attachment as proof when it lands after the remove (the writes race)', () => {
    const rows = timeline([
      user('u1', null, A, 1),
      assistant('a1', 'u1', 'msg_1', [toolUse('toolu_1')], 2),
      enqueue(B, 3),
      user('tr1', 'a1', toolResult('toolu_1'), 5),
      remove(B, 5),
      reminder('r1', 'tr1', 5),
      queuedCommand('q1', 'r1', B, 3),
      assistant('a2', 'q1', 'msg_2', [{ type: 'text', text: 'Done.' }], 6),
    ]);
    expect(rows).toEqual([`user:${A}`, 'assistant:[tool]', `user:${B}`, 'assistant:Done.']);
  });

  it('reads the text of an image send (prompt is a content array)', () => {
    const withImage = '[Images attached]\n- /tmp/shot.png\nWhy is this cut off?';
    const rows = timeline([
      user('u1', null, A, 1),
      assistant('a1', 'u1', 'msg_1', [toolUse('toolu_1')], 2),
      enqueue(withImage, 3),
      user('tr1', 'a1', toolResult('toolu_1'), 5),
      queuedCommand('q1', 'tr1', [{ type: 'text', text: withImage }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }], 3),
      remove(withImage, 5),
    ]);
    expect(rows).toContain(`user:${withImage}`);
  });

  it('shows the same text twice when it was queued twice and both ran', () => {
    const rows = timeline([
      user('u1', null, A, 1),
      assistant('a1', 'u1', 'msg_1', [toolUse('toolu_1')], 2),
      enqueue('continue', 3),
      enqueue('continue', 4),
      user('tr1', 'a1', toolResult('toolu_1'), 5),
      queuedCommand('q1', 'tr1', 'continue', 3),
      queuedCommand('q2', 'q1', 'continue', 4),
      remove('continue', 5),
      remove('continue', 5),
    ]);
    expect(rows.filter((r) => r === 'user:continue')).toHaveLength(2);
  });

  it('never takes a later identical user line as the consumed message\'s twin', () => {
    // The mid-turn send ran as an attachment; the same words typed again at a
    // later turn start are a second message with their own user line.
    const rows = timeline([
      user('u1', null, A, 1),
      assistant('a1', 'u1', 'msg_1', [toolUse('toolu_1')], 2),
      enqueue('go on', 3),
      user('tr1', 'a1', toolResult('toolu_1'), 5),
      queuedCommand('q1', 'tr1', 'go on', 3),
      remove('go on', 5),
      assistant('a2', 'q1', 'msg_2', [{ type: 'text', text: 'First answer.' }], 6),
      enqueue('go on', 7), dequeue(7),
      user('u2', 'a2', 'go on', 7),
      assistant('a3', 'u2', 'msg_3', [{ type: 'text', text: 'Second answer.' }], 8),
    ]);
    expect(rows).toEqual([
      `user:${A}`, 'assistant:[tool]', 'user:go on', 'assistant:First answer.', 'user:go on', 'assistant:Second answer.',
    ]);
  });

  it('keeps the row while the turn is still running and after the remove lands (no vanish mid-flight)', () => {
    const head = [
      user('u1', null, A, 1),
      assistant('a1', 'u1', 'msg_1', [toolUse('toolu_1')], 2),
      enqueue(B, 3),
    ];
    expect(timeline(head)).toContain(`user:${B}`);
    const later = [...head, user('tr1', 'a1', toolResult('toolu_1'), 5), queuedCommand('q1', 'tr1', B, 3), remove(B, 5)];
    expect(timeline(later).filter((r) => r === `user:${B}`)).toHaveLength(1);
  });

  it('carries the uuid the line was sent under (source_uuid) on the queue row, and only there', () => {
    // A question sent mid-turn is anchored under the uuid Walnut pre-assigned;
    // the CLI keeps that uuid only on its attachment (2026-10-08: the question
    // lost its number and title, and its follow-up was filed under another one).
    const lines = [
      user('u1', null, A, 1),
      assistant('a1', 'u1', 'msg_1', [toolUse('toolu_1')], 2),
      enqueue(B, 3),
      user('tr1', 'a1', toolResult('toolu_1'), 5),
      queuedCommand('q1', 'tr1', B, 3),
      remove(B, 5),
      enqueue(C, 6),
      assistant('a2', 'q1', 'msg_2', [{ type: 'text', text: 'Done.' }], 7),
    ];
    const rows = parse(lines);
    const queued = rows.find((m) => m.text === B);
    expect(queued?.msgId).toBe(`queue-${T(3)}`);
    expect(queued?.sourceUuid).toBe('src-q1');
    // Not consumed by an attachment (still waiting): no uuid to report.
    expect(rows.find((m) => m.text === C)?.sourceUuid).toBeUndefined();
    expect(rows.find((m) => m.text === A)?.sourceUuid).toBeUndefined();
  });

  it('keeps a consumed task notification hidden', () => {
    const note = '<task-notification><tool-use-id>toolu_9</tool-use-id><status>completed</status></task-notification>';
    const rows = timeline([
      user('u1', null, A, 1),
      assistant('a1', 'u1', 'msg_1', [toolUse('toolu_1')], 2),
      enqueue(note, 3),
      user('tr1', 'a1', toolResult('toolu_1'), 5),
      queuedCommand('q1', 'tr1', note, 3, { commandMode: 'task-notification' }),
      remove(note, 5),
    ]);
    expect(rows.some((r) => r.includes('task-notification'))).toBe(false);
  });
});

describe('queued messages the CLI dropped without running them', () => {
  it('still hides a cancelled message, even with another message\'s attachment in between', () => {
    const rows = timeline([
      user('u1', null, A, 1),
      assistant('a1', 'u1', 'msg_1', [toolUse('toolu_1')], 2),
      enqueue(B, 3),
      enqueue('Reply with one word', 4),
      user('tr1', 'a1', toolResult('toolu_1'), 5),
      queuedCommand('q1', 'tr1', B, 3),
      remove(B, 5),
      remove('Reply with one word', 6),
      user('int', 'q1', [{ type: 'text', text: '[Request interrupted by user]' }], 6),
    ]);
    expect(rows).toContain(`user:${B}`);
    expect(rows.some((r) => r.includes('Reply with one word'))).toBe(false);
  });

  it('a cancelled message sent again and run mid-turn shows once, at the resend', () => {
    const lines = [
      user('u1', null, A, 1),
      assistant('a1', 'u1', 'msg_1', [{ type: 'text', text: 'Working.' }], 2),
      enqueue(B, 3),
      remove(B, 4),
      user('int', 'a1', [{ type: 'text', text: '[Request interrupted by user]' }], 4),
      enqueue(A, 10), dequeue(10),
      user('u2', 'int', A, 10),
      assistant('a2', 'u2', 'msg_2', [toolUse('toolu_2')], 11),
      enqueue(B, 12),
      user('tr2', 'a2', toolResult('toolu_2'), 14),
      queuedCommand('q2', 'tr2', B, 12),
      remove(B, 14),
    ];
    const shown = parse(lines).filter((m) => m.text === B);
    expect(shown).toHaveLength(1);
    expect(shown[0].timestamp).toBe(T(12));
  });
});
