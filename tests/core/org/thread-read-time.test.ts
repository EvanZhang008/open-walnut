/**
 * Ratchet: a message of his counts as having read the node's words only when it came late enough
 * to read them (thread-view.ts readAfter; 2026-11-21, the user: "最恶心的是什么？我没看，但是你把它
 * 给我 mark 了"). 17% of the read marks on his Walnut VP came from a message he sent seconds after a
 * long answer, typed or dictated while it was still being written. Every path that takes his later
 * message as a reading goes through readAfter, and a new writer of the read mark fails here until
 * it says how it decides.
 */
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as model from '../../../src/core/org/threads-model.js';
import { cardView, exchangesOf, hasThreadNews, readAfter, readMsFor, READ_CHARS_PER_SECOND, shownToHim } from '../../../src/core/org/thread-view.js';

const T0 = Date.UTC(2026, 10, 21, 21, 0, 0);
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();
const by = 'task:lead' as const;
/** A long answer, the size of the Walnut VP's reply he dictated over (893 characters). */
const LONG = '面试里不用自己实现限流，说在网关这一层限流就够了。'.repeat(36).slice(0, 893);

const answered = (answerAt: number): model.ThreadsFile => ({ version: 1, taskId: 'lead', threads: [{
  id: 'th-aaaaaa', title: 'Rate limits', state: 'answered', createdAt: at(0), updatedAt: at(answerAt), by,
  messages: [{ id: 'tm-aaaaaa', at: at(0), text: 'How do interviews expect rate limiting?', via: 'chat', answer: { text: LONG, at: at(answerAt) } }],
}] });

describe('reading time', () => {
  it('is the length at the reading speed, at least two seconds', () => {
    expect(readMsFor('ok')).toBe(2_000);
    expect(readMsFor(LONG)).toBe(Math.ceil((893 / READ_CHARS_PER_SECOND) * 1000));
    expect(readAfter({ at: at(0), text: LONG }, at(12))).toBe(false);
    expect(readAfter({ at: at(0), text: LONG }, at(40))).toBe(true);
    expect(readAfter({ at: at(0), text: 'ok' }, undefined)).toBe(false);
  });

  it('a message he sent seconds after a long answer leaves it unread on his card, and a later one reads it', () => {
    const fast = model.fileMessage(answered(10), { threadId: 'th-aaaaaa', text: 'And what about the database?', via: 'follow-up', at: at(22), messageId: 'tm-bbbbbb' });
    // 12 s after 893 characters: not read; the answer stays on his card, and no known mark covers it.
    expect(fast.thread.messages[0]!.readAt).toBeUndefined();
    expect(fast.thread.known).toBeUndefined();
    expect(exchangesOf(fast.thread)[0]!.known).toBe(false);
    expect(cardView(fast.thread).unread.map((x) => x.answer?.text)).toEqual([LONG]);
    expect(shownToHim({ ...fast.thread, state: 'answered' }, new Set(), Date.parse(at(23)))).toBe(true);

    const slow = model.fileMessage(fast.file, { threadId: 'th-aaaaaa', text: 'Thanks, clear.', via: 'follow-up', at: at(120), messageId: 'tm-cccccc' });
    expect(slow.thread.messages[0]!.readAt).toBe(at(120));
    expect(slow.thread.known).toMatchObject({ through: 'tm-aaaaaa', by: 'human' });
    expect(exchangesOf(slow.thread)[0]!.known).toBe(true);
  });

  it('the known mark stops before the first answer he could not have read', () => {
    const file: model.ThreadsFile = { version: 1, taskId: 'lead', threads: [{
      id: 'th-aaaaaa', title: 'Two answers', state: 'answered', createdAt: at(0), updatedAt: at(100), by,
      messages: [
        { id: 'tm-aaaaaa', at: at(0), text: 'First?', via: 'chat', answer: { text: LONG, at: at(90) } },
        { id: 'tm-bbbbbb', at: at(1), text: 'Second?', via: 'chat', answer: { text: 'Short.', at: at(91) } },
      ],
    }] };
    const r = model.fileMessage(file, { threadId: 'th-aaaaaa', text: 'Next one', via: 'follow-up', at: at(95), messageId: 'tm-cccccc' });
    expect(r.thread.messages[0]!.readAt).toBeUndefined();
    expect(r.thread.messages[1]!.readAt).toBe(at(95));
    expect(r.thread.known).toBeUndefined();
  });

  it('the node\'s own first post is read only by a message that could follow reading it', () => {
    const opened: model.ThreadsFile = { version: 1, taskId: 'lead', threads: [{
      id: 'th-aaaaaa', title: 'Delete 4.6 GB?', state: 'needs', createdAt: at(0), updatedAt: at(0), by,
      opener: { text: LONG, at: at(0), from: 'task', by },
      messages: [],
    }] };
    const fast = model.fileMessage(opened, { threadId: 'th-aaaaaa', text: 'wait', via: 'follow-up', at: at(5), messageId: 'tm-bbbbbb' });
    expect(exchangesOf(fast.thread)[0]!.known).toBe(false);
    const slow = model.fileMessage(opened, { threadId: 'th-aaaaaa', text: 'no, keep git', via: 'follow-up', at: at(60), messageId: 'tm-bbbbbb' });
    expect(exchangesOf(slow.thread)[0]!.known).toBe(true);
  });

  it('a node may mark known or close only after a message of his that could follow reading the answer', () => {
    // His other message, 12 s after the answer, in another thread.
    const elsewhere = model.fileMessage(answered(10), { text: 'Another subject', via: 'chat', at: at(22), newThreadId: 'th-bbbbbb' });
    expect(() => model.updateThread(elsewhere.file, 'th-aaaaaa', { known: 'all' }, by, at(23))).toThrow(/not_reacted|has not written/);
    expect(() => model.updateThread(elsewhere.file, 'th-aaaaaa', { close: 'acked' }, by, at(23))).toThrow(/has not written/);
    const later = model.fileMessage(elsewhere.file, { threadId: 'th-bbbbbb', text: 'And one more', via: 'follow-up', at: at(200), messageId: 'tm-dddddd' });
    const marked = model.updateThread(later.file, 'th-aaaaaa', { known: 'all' }, by, at(201));
    expect(marked.thread.messages[0]!.readAt).toBe(at(200));
  });

  it('an "ok" a second after a long answer lets no node close it; one he could have read it before does', () => {
    const fast = model.fileMessage(answered(10), { threadId: 'th-aaaaaa', text: 'ok', via: 'follow-up', at: at(11), messageId: 'tm-bbbbbb' });
    expect(() => model.updateThread(fast.file, 'th-aaaaaa', { close: 'acked' }, by, at(12))).toThrow(/has not written/);
    const slow = model.fileMessage(answered(10), { threadId: 'th-aaaaaa', text: 'ok', via: 'follow-up', at: at(60), messageId: 'tm-bbbbbb' });
    expect(model.updateThread(slow.file, 'th-aaaaaa', { close: 'acked' }, by, at(61)).thread.closed).toMatchObject({ how: 'acked' });
  });

  it('a summary he could not have read yet stays news on his card', () => {
    const base = answered(10).threads[0]!;
    const summary = { ...base, reply: LONG, replyAt: at(100), messages: base.messages.map((m) => ({ ...m, readAt: at(60) })), known: { through: 'tm-aaaaaa', by: 'human' as const, at: at(60) } };
    // His message elsewhere a second after the summary: not a reading of it.
    expect(hasThreadNews({ ...summary, reactedAt: at(101) })).toBe(true);
    expect(hasThreadNews({ ...summary, reactedAt: at(200) })).toBe(false);
  });

  it('his own Acknowledge, known and close need no reading time', () => {
    const own = model.updateThread(answered(10), 'th-aaaaaa', { known: 'all' }, 'human', at(11));
    expect(own.thread.messages[0]!.readAt).toBe(at(11));
    const closed = model.updateThread(answered(10), 'th-aaaaaa', { close: 'acked' }, 'human', at(11));
    expect(closed.thread.closed).toMatchObject({ how: 'acked', by: 'human' });
  });

  it('every writer of a thread message\'s read mark is one of the reviewed ones', () => {
    // A new place that sets readAt must decide it with readAfter (or say why it needs no time) and join this list.
    const src = fs.readFileSync('src/core/org/threads-model.ts', 'utf8');
    const writers: string[] = [];
    const lines = src.split('\n');
    let fn = '';
    for (const line of lines) {
      const m = /^(?:export )?function (\w+)/.exec(line);
      if (m) fn = m[1]!;
      if (/readAt:\s|\{ readAt \}/.test(line)) writers.push(fn);
    }
    expect([...new Set(writers)].sort()).toEqual(['mergeMovedCopy', 'preserveReaction', 'recordReaction', 'updateThread'].sort());
    expect(src).toMatch(/m\.answer && readAfter\(m\.answer, at\)/);
    expect(src).toMatch(/readAfter\(m\.answer, readAt\)/);
    for (const other of fs.readdirSync('src/core/org').filter((f) => f.endsWith('.ts') && f !== 'threads-model.ts')) {
      const text = fs.readFileSync(`src/core/org/${other}`, 'utf8');
      expect(/\breadAt:\s/.test(text), `${other} writes a thread read mark`).toBe(false);
    }
  });
});
