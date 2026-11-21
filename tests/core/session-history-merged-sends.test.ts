/**
 * A user line Claude Code merged from several queued sends is one row per send.
 *
 * inc-1794638780357 (2026-11-14): Claude Code 2.1.322 drained two queued sends into
 * one line, written under the LAST send's uuid with the first in `mergedSendUuids`.
 * 2026-11-21: a peer's reply and the user's own words were drained into one line;
 * the row held an envelope, so the chat drew his words inside the reply's card
 * instead of his bubble, and the phone read the whole row as an agent's. Each send
 * is its own row now, under its own uuid, with the line's uuid kept for a rewind.
 * Line shapes copied from those transcripts, neutral text.
 */
import { describe, expect, it } from 'vitest';
import { parseSessionMessages } from '../../src/core/session-history.js';
import { transcriptSentBy, personTextOf } from '../../src/core/sessions/transcript-sent-by.js';

const T = (s: number) => new Date(Date.UTC(2026, 10, 14, 6, 43, s)).toISOString();
const parse = (lines: unknown[]) => parseSessionMessages(lines.map((l) => JSON.stringify(l)).join('\n'));
const FIRST = '57d9de80-8fd2-4f1a-9bfb-e8262550d73a';
const SECOND = 'adf27595-d712-4ba9-89db-40d06709e9b0';
const enqueue = (s: number, content?: string) => ({ type: 'queue-operation', operation: 'enqueue', timestamp: T(s), sessionId: 's', ...(content !== undefined ? { content } : {}) });
const dequeue = (s: number) => ({ type: 'queue-operation', operation: 'dequeue', timestamp: T(s), sessionId: 's' });

function mergedLine(content: unknown, extra: Record<string, unknown>) {
  return {
    parentUuid: 'p0', isSidechain: false, promptId: 'pr1', type: 'user',
    message: { role: 'user', content },
    uuid: SECOND, timestamp: T(43), permissionMode: 'bypassPermissions', promptSource: 'sdk', turnOrigin: 'sdk',
    turnAttributionKey: SECOND, userType: 'external', entrypoint: 'sdk-cli', sessionId: 's', version: '2.1.322',
    ...extra,
  };
}

const REPLY = [
  '<walnut-message kind="reply" from="Merge the hosts [c89810f3]" from-session="c89810f3-ba6e-47e3-9360-1666d2968923" from-task="a7f3fe86-ba1e-5bf5-a10a-64a2d2e74759" host="devbox" title="Three steps live" request="rq-d534f90d737c" note="your user\'s other session answering your request: its own account, not checked by you">',
  'Nothing is stuck; three of the steps are live behind their switch.',
  '</walnut-message>',
  '',
  '<system-reminder>',
  'Walnut (threads-tidy): threads to tidy: th-a5982e0f99c2 (did he react to your answer?).',
  '</system-reminder>',
].join('\n');
const WORDS = 'why medium effort, default is high, a big task is xhigh';
const PERSON = [
  WORDS,
  '',
  '<system-reminder>',
  'Walnut (threads): filed under thread th-cb9059f1df18 "Move the leader": it came right after his last message there.',
  '</system-reminder>',
].join('\n');

describe('merged sends', () => {
  it('two plain sends: two rows, the first under its own uuid with the line kept for a rewind', () => {
    const lines = [
      enqueue(27, 'first words'),
      enqueue(34, 'second words'),
      dequeue(43), dequeue(43),
      mergedLine('first words\nsecond words', { mergedSendUuids: [FIRST] }),
    ];
    const users = parse(lines).filter((m) => m.role === 'user');
    expect(users.map((m) => m.text)).toEqual(['first words', 'second words']);
    expect(users.map((m) => m.msgId)).toEqual([FIRST, SECOND]);
    expect(users[0].lineUuid).toBe(SECOND);
    expect(users[1]).not.toHaveProperty('lineUuid');
    expect(users.some((m) => m.mergedUuids)).toBe(false);
  });

  it("a peer's reply drained with the person's words (2026-11-21): the reply is the agent's row, the words are the person's own", () => {
    const lines = [
      enqueue(32, REPLY),
      enqueue(33, PERSON),
      dequeue(41), dequeue(41),
      mergedLine(`${REPLY}\n${PERSON}`, { mergedSendUuids: [FIRST] }),
    ];
    const users = parse(lines).filter((m) => m.role === 'user');
    expect(users).toHaveLength(2);
    expect(users[0].text.startsWith('<walnut-message kind="reply"')).toBe(true);
    expect(transcriptSentBy(users[0])).toBe('agent');
    expect(users[1].text).toBe(WORDS);
    expect(transcriptSentBy(users[1])).toBe('person');
    expect(personTextOf(users[1].text)).toBeUndefined(); // the whole row is his
    expect(users[1].msgId).toBe(SECOND);
  });

  it('the run is found however far back it was queued when the line names its sends', () => {
    const filler = Array.from({ length: 120 }, (_, k) => ({
      type: 'assistant', uuid: `a-${k}`, timestamp: T(35),
      message: { id: `msg-${k}`, role: 'assistant', content: [{ type: 'text', text: `step ${k}` }] },
    }));
    const lines = [enqueue(32, REPLY), enqueue(33, PERSON), ...filler, dequeue(41), dequeue(41),
      mergedLine(`${REPLY}\n${PERSON}`, { mergedSendUuids: [FIRST] })];
    const users = parse(lines).filter((m) => m.role === 'user');
    expect(users.map((m) => transcriptSentBy(m))).toEqual(['agent', 'person']);
  });

  it('a line of blocks (a send with a picture) splits after each send\'s text block', () => {
    const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } };
    const pictureText = 'look at this\n\n[Images attached — use the Read tool to view them]\n- /tmp/open-walnut/images/1-a.png';
    const lines = [
      enqueue(32, REPLY),
      enqueue(33),
      dequeue(41), dequeue(41),
      mergedLine([{ type: 'text', text: REPLY }, image, { type: 'text', text: pictureText }], { mergedSendUuids: [FIRST] }),
    ];
    const users = parse(lines).filter((m) => m.role === 'user');
    expect(users).toHaveLength(2);
    expect(transcriptSentBy(users[0])).toBe('agent');
    expect(transcriptSentBy(users[1])).toBe('person');
    expect(users[1].text.startsWith('look at this')).toBe(true);
    expect(users.map((m) => m.msgId)).toEqual([FIRST, SECOND]);
  });

  it('the same joined line twice (a stream replay) is still one row per send, nothing appended', () => {
    const line = mergedLine('first words\nsecond words', { mergedSendUuids: [FIRST] });
    const users = parse([enqueue(27, 'first words'), enqueue(34, 'second words'), dequeue(43), dequeue(43), line, line]).filter((m) => m.role === 'user');
    expect(users.map((m) => m.text)).toEqual(['first words', 'second words']);
    expect(users.some((m) => m.mergedUuids)).toBe(false);
  });

  it("the line's one origin marks only the send that is another session's mail", () => {
    const lines = [enqueue(32, REPLY), enqueue(33, PERSON), dequeue(41), dequeue(41),
      mergedLine(`${REPLY}\n${PERSON}`, { mergedSendUuids: [FIRST], origin: { kind: 'peer' } })];
    const users = parse(lines).filter((m) => m.role === 'user');
    expect(users.map((m) => transcriptSentBy(m))).toEqual(['agent', 'person']);
  });

  it('a line whose sends cannot be told apart stays one row and keeps the list', () => {
    // No enqueues in the file (a tail read, an older capture): the '\n' join says nothing.
    const users = parse([mergedLine('first words\nsecond words', { mergedSendUuids: [FIRST] })]).filter((m) => m.role === 'user');
    expect(users.map((m) => m.text)).toEqual(['first words\nsecond words']);
    expect(users[0].mergedUuids).toEqual([FIRST]);
  });

  it('a line without the field, or with a malformed one, has no mergedUuids', () => {
    expect(parse([mergedLine('a\nb', {})]).find((m) => m.role === 'user')).not.toHaveProperty('mergedUuids');
    expect(parse([mergedLine('a\nb', { mergedSendUuids: 'x' })]).find((m) => m.role === 'user')).not.toHaveProperty('mergedUuids');
    expect(parse([mergedLine('a\nb', { mergedSendUuids: [7, ''] })]).find((m) => m.role === 'user')).not.toHaveProperty('mergedUuids');
  });
});
