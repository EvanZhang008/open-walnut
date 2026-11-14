/**
 * A user line Claude Code merged from several queued sends keeps every send's uuid.
 *
 * inc-1794638780357 (2026-11-14): Claude Code 2.1.322 drained two mid-turn sends into
 * one line, written under the LAST send's uuid with the first in `mergedSendUuids`.
 * The parse dropped that field, so the first send's bubble had no row carrying its
 * uuid. Line shape copied from that transcript, neutral text.
 */
import { describe, expect, it } from 'vitest';
import { parseSessionMessages } from '../../src/core/session-history.js';

const T = (s: number) => new Date(Date.UTC(2026, 10, 14, 6, 43, s)).toISOString();
const parse = (lines: unknown[]) => parseSessionMessages(lines.map((l) => JSON.stringify(l)).join('\n'));
const FIRST = '57d9de80-8fd2-4f1a-9bfb-e8262550d73a';
const SECOND = 'adf27595-d712-4ba9-89db-40d06709e9b0';

function mergedLine(extra: Record<string, unknown>) {
  return {
    parentUuid: 'p0', isSidechain: false, promptId: 'pr1', type: 'user',
    message: { role: 'user', content: 'first words\nsecond words' },
    uuid: SECOND, timestamp: T(43), permissionMode: 'bypassPermissions', promptSource: 'sdk', turnOrigin: 'sdk',
    turnAttributionKey: SECOND, userType: 'external', entrypoint: 'sdk-cli', sessionId: 's', version: '2.1.322',
    ...extra,
  };
}

describe('merged sends', () => {
  it('the row carries the other sends as mergedUuids beside its own msgId', () => {
    const lines = [
      { type: 'queue-operation', operation: 'enqueue', timestamp: T(27), sessionId: 's', content: 'first words' },
      { type: 'queue-operation', operation: 'enqueue', timestamp: T(34), sessionId: 's', content: 'second words' },
      { type: 'queue-operation', operation: 'dequeue', timestamp: T(43), sessionId: 's' },
      { type: 'queue-operation', operation: 'dequeue', timestamp: T(43), sessionId: 's' },
      mergedLine({ mergedSendUuids: [FIRST] }),
    ];
    const users = parse(lines).filter((m) => m.role === 'user');
    expect(users.map((m) => m.text)).toEqual(['first words\nsecond words']);
    expect(users[0].msgId).toBe(SECOND);
    expect(users[0].mergedUuids).toEqual([FIRST]);
  });

  it('a line without the field, or with a malformed one, has no mergedUuids', () => {
    expect(parse([mergedLine({})]).find((m) => m.role === 'user')).not.toHaveProperty('mergedUuids');
    expect(parse([mergedLine({ mergedSendUuids: 'x' })]).find((m) => m.role === 'user')).not.toHaveProperty('mergedUuids');
    expect(parse([mergedLine({ mergedSendUuids: [7, ''] })]).find((m) => m.role === 'user')).not.toHaveProperty('mergedUuids');
  });
});
