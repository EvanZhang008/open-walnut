/**
 * GUARD: the words a person sends are always a row of their own that reads as theirs,
 * whatever Claude Code stored them beside.
 *
 * 2026-11-21 (the user: "why the word I see not render as my word?"): a peer's reply
 * and his message were queued while a turn ran, and Claude Code drained both into
 * one stored line. The row held an envelope, so the chat drew his words as plain
 * text inside the reply's card (no bubble) and the phone read the row as an
 * agent's. Earlier fixes covered one member each: Walnut's notes in front of the
 * words (history-walnut-riders.ts), notes after them (splitTrailingRiders), a
 * message hint (projectUserText). The class is "a stored user line that holds the
 * person's words AND something that is not theirs"; its members are every kind of
 * non-person send (enumerated from the envelope parser's own lists below) times
 * every way a line comes to hold two sends.
 *
 * For every member the parse (src/core/history-parse.ts, the one source the web,
 * the Mac app and the phone read) must give exactly one row that `transcriptSentBy`
 * reads as the person's, holding exactly his words, and the web's row rule
 * (SessionMessage: riders off, then no envelope left) must draw it as his bubble.
 * A new envelope kind or native peer tag without a sample here fails the first test.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSessionMessages } from '../../src/core/session-history.js';
import { transcriptSentBy, personTextOf } from '../../src/core/sessions/transcript-sent-by.js';
import { NATIVE_PEER_TAGS, parseSessionEnvelopes } from '../../src/lib/history-session-envelope.js';
import { splitRiders } from '../../src/lib/history-walnut-riders.js';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const WORDS = 'why medium effort, default is high';
const HINT = '<system-reminder>\nWalnut (threads): filed under thread th-cb9059f1df18 "Move the leader".\n</system-reminder>';

/** One send of each kind a person's words can be stored beside. */
const SAMPLES: Record<string, string> = {
  reply: '<walnut-message kind="reply" from="Merge the hosts [c89810f3]" from-session="c89810f3-ba6e-47e3-9360-1666d2968923" from-task="a7f3fe86-ba1e-5bf5-a10a-64a2d2e74759" title="Three steps live" request="rq-d534f90d737c" note="your user\'s other session answering your request">\nNothing is stuck.\n</walnut-message>',
  'peer-note': '<walnut-message kind="peer-note" from="Walnut VP [3ccf06d9]" from-session="3ccf06d9-dbdd-49a1-ab98-1537944f64d4" from-task="mvm0n3bu-6910" title="A request" note="from another of your user\'s own sessions">\nPlease look at the chat order.\n</walnut-message>',
  notification: '<walnut-message kind="notification" from="Walnut" about="Mac memory [1aa2c800]" about-session="1aa2c800-cb49-45d0-8820-8303e51c0c89" outcome="completed" note="automated Walnut status notice">\nYour subtask finished.\n</walnut-message>',
  // The legacy trailer a reply request rode in before the tag (still in older transcripts).
  'reply-request': [
    '[Reply requested \u2014 rq-0a1b2c3d4e5f] The sender asked Walnut to route your answer back.',
    'When you have finished the work above (and only then), send the result:',
    'walnut tools call session_send \'{"in_reply_to":"rq-0a1b2c3d4e5f","text":"<your result summary>"}\'',
    'Keep the reply self-contained: outcome, key facts/paths, and anything the sender must act on.',
  ].join('\n'),
  topic: '<walnut-message kind="topic" from="Topic: release [a1b2c3d4]" note="lines posted to a topic you are in">\nThe build is green.\n</walnut-message>',
  trigger: '<walnut-message kind="trigger" from="Walnut: re-check" note="do your letters to the user still need him">\nCheck the letters.\n</walnut-message>',
  'app-state': '<walnut-message kind="app-state" from="Walnut" app="board" note="the app\'s state">\nThe board has 3 cards.\n</walnut-message>',
  'teammate-message': '<teammate-message teammate_id="researcher" summary="found it">\nThe file is in src.\n</teammate-message>',
  'cross-session-message': '<cross-session-message from="fixture-96 [310819]" from-session="6c055e2b-0000-4000-8000-000000000000">\nhello from another session\n</cross-session-message>',
  'agent-message': '<agent-message from="helper">\nA note from a helper.\n</agent-message>',
};

describe('every non-person send has a sample', () => {
  it('the samples name exactly the envelope kinds and native peer tags the parser knows', () => {
    const src = read('src/lib/history-session-envelope.ts');
    const union = src.match(/export type SessionEnvelopeKind = ([^;]+);/);
    const tagKinds = src.match(/const TAG_KINDS = new Set\(\[([^\]]+)\]\)/);
    expect(union, 'SessionEnvelopeKind is declared as a string union').toBeTruthy();
    expect(tagKinds, 'the tag kinds are declared as `const TAG_KINDS = new Set([...])`').toBeTruthy();
    const kinds = new Set([...union![1].matchAll(/'([^']+)'/g), ...tagKinds![1].matchAll(/'([^']+)'/g)].map((m) => m[1]));
    // A new kind or tag: add a sample above, so its rows are checked below.
    expect(Object.keys(SAMPLES).sort()).toEqual([...kinds, ...NATIVE_PEER_TAGS].sort());
  });

  it('each sample is something the parser reads as an envelope, never as words', () => {
    for (const [kind, text] of Object.entries(SAMPLES)) {
      const segments = parseSessionEnvelopes(text);
      expect(segments?.some((s) => s.kind === 'envelope'), kind).toBe(true);
    }
  });
});

const T = (s: number) => new Date(Date.UTC(2026, 10, 21, 20, 49, s)).toISOString();
const LINE = 'f3bf1943-3045-4c1f-a5ae-78b635d7d3ed';
const OTHER = '87782fa1-2e16-44b3-b239-788c63f0b0b6';
const enqueue = (s: number, content?: string) => ({ type: 'queue-operation', operation: 'enqueue', timestamp: T(s), sessionId: 's', ...(content !== undefined ? { content } : {}) });
const dequeue = (s: number) => ({ type: 'queue-operation', operation: 'dequeue', timestamp: T(s), sessionId: 's' });
const userLine = (content: unknown, uuid: string, extra: Record<string, unknown> = {}) => ({
  type: 'user', uuid, parentUuid: 'p0', timestamp: T(41), promptSource: 'sdk', turnOrigin: 'sdk', version: '2.1.322',
  message: { role: 'user', content }, ...extra,
});
const turn = { type: 'assistant', uuid: 'a0', timestamp: T(30), message: { id: 'msg-0', role: 'assistant', content: [{ type: 'text', text: 'working on it' }] } };
const answer = { type: 'assistant', uuid: 'a1', timestamp: T(45), message: { id: 'msg-1', role: 'assistant', content: [{ type: 'text', text: 'here is why' }] } };
const IMAGE = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } };
const PICTURE_WORDS = `${WORDS}\n\n[Images attached — use the Read tool to view them]\n- /tmp/open-walnut/images/1-a.png`;

/** How the person's send reaches the CLI: the text of his line, and its blocks when he sent a picture. */
const PERSON_SENDS: Record<string, { text: string; words: string; picture?: true }> = {
  // The console, the Mac app, Ask here and a follow-up all send words and the hints Walnut adds.
  typed: { text: `${WORDS}\n\n${HINT}`, words: WORDS },
  // The phone's send and voice input reach the queue as the same plain words.
  plain: { text: WORDS, words: WORDS },
  picture: { text: PICTURE_WORDS, words: PICTURE_WORDS, picture: true },
};

type Lines = unknown[];
/** Every way one stored line comes to hold the person's send beside another. */
const SHAPES: Record<string, (other: string, mine: { text: string; picture?: true }) => Lines | null> = {
  // Both queued while a turn ran, drained at its end into one line (the 2026-11-21 report).
  'drained, other first': (other, mine) => mine.picture
    ? [turn, enqueue(32, other), enqueue(33), dequeue(41), dequeue(41),
      userLine([{ type: 'text', text: other }, IMAGE, { type: 'text', text: mine.text }], LINE, { mergedSendUuids: [OTHER] }), answer]
    : [turn, enqueue(32, other), enqueue(33, mine.text), dequeue(41), dequeue(41),
      userLine(`${other}\n${mine.text}`, LINE, { mergedSendUuids: [OTHER] }), answer],
  'drained, person first': (other, mine) => mine.picture
    ? [turn, enqueue(32), enqueue(33, other), dequeue(41), dequeue(41),
      userLine([IMAGE, { type: 'text', text: mine.text }, { type: 'text', text: other }], LINE, { mergedSendUuids: [OTHER] }), answer]
    : [turn, enqueue(32, mine.text), enqueue(33, other), dequeue(41), dequeue(41),
      userLine(`${mine.text}\n${other}`, LINE, { mergedSendUuids: [OTHER] }), answer],
  // A CLI older than `mergedSendUuids` drains the same way and names nothing.
  'drained, unnamed': (other, mine) => mine.picture ? null
    : [turn, enqueue(32, other), enqueue(33, mine.text), dequeue(41), dequeue(41), userLine(`${other}\n${mine.text}`, LINE), answer],
  // Each taken on its own: the other one mid-turn, then his as the next turn's line.
  'taken apart': (other, mine) => mine.picture ? null
    : [turn, enqueue(32, other), { type: 'attachment', uuid: 'att-1', timestamp: T(34), attachment: { type: 'queued_command', prompt: other } },
      { type: 'queue-operation', operation: 'remove', timestamp: T(34), sessionId: 's', content: other },
      userLine(mine.text, LINE), answer],
};

describe("the person's words are a row of their own that reads as his", () => {
  for (const [shape, build] of Object.entries(SHAPES)) {
    for (const [kind, other] of Object.entries(SAMPLES)) {
      for (const [source, mine] of Object.entries(PERSON_SENDS)) {
        const lines = build(other, mine);
        if (!lines) continue;
        it(`${shape} · beside a ${kind} · ${source}`, () => {
          const rows = parseSessionMessages(lines.map((l) => JSON.stringify(l)).join('\n')).filter((m) => m.role === 'user');
          const persons = rows.filter((r) => transcriptSentBy(r) === 'person');
          expect(persons, rows.map((r) => `${transcriptSentBy(r)}: ${r.text.slice(0, 60)}`).join(' | ')).toHaveLength(1);
          const row = persons[0]!;
          // The server's rule (the phone, task_history, prompt recall): his words and nothing else.
          expect((personTextOf(row.text) ?? row.text).trim()).toBe(mine.words);
          // The web's rule (SessionMessage): Walnut's notes split off, no envelope left, so a bubble.
          const body = splitRiders(row.text)?.body ?? row.text;
          expect(parseSessionEnvelopes(body)).toBeNull();
          // And no other row carries his words.
          expect(rows.filter((r) => r !== row && r.text.includes(WORDS))).toHaveLength(0);
        });
      }
    }
  }
});

describe('the web draws a row with no envelope left as the person\'s bubble', () => {
  it('SessionMessage still decides the bubble from the rider split and the envelope parse', () => {
    const src = read('web/src/components/sessions/SessionMessage.tsx');
    // If this decision moves, move the web rule in the test above with it.
    expect(src).toMatch(/const riderSplit = useMemo\(\(\) => \(isUser && text \? splitRiders\(text\) : null\)/);
    expect(src).toMatch(/const personWords = !\(envelopeSegments \|\| \(bannerSplit && !bodyText\)\);/);
    expect(src).toMatch(/: isUser \? 'session-msg-user' : 'session-msg-assistant'/);
  });
});
