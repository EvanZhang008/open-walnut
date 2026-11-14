import fs from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import * as model from '../../../src/core/org/threads-model.js';
import { shownToHim, cardView } from '../../../src/core/org/thread-view.js';

const at = (n: number) => new Date(Date.UTC(2026, 10, 14, 6, n)).toISOString();
const by = 'task:lead' as const;
const base = (): model.ThreadsFile => ({ version: 1, taskId: 'lead', threads: [{
  id: 'th-aaaaaa', title: 'Thread explanation', state: 'answered', reply: 'The explanation.', replyAt: at(2),
  createdAt: at(0), updatedAt: at(2), by,
  messages: [{ id: 'tm-aaaaaa', at: at(0), text: 'Explain threads?', via: 'chat', answer: { text: 'The explanation.', at: at(2) } }],
}] });
const reacted = () => model.fileMessage(base(), { threadId: 'th-aaaaaa', text: 'Another subject?', via: 'follow-up', at: at(3), messageId: 'tm-bbbbbb' });

describe('a reaction is durable news provenance, not a state', () => {
  it('automatically records what he saw and survives split, repeated reply and a state flip', () => {
    const r = reacted();
    expect(r.thread.known).toEqual({ through: 'tm-aaaaaa', at: at(3), by: 'human' });
    const s = model.splitThreadMessage(r.file, r.thread.id, r.message.id, by, at(4));
    expect(s.from.closed).toMatchObject({ how: 'acked', reacted: true });
    const u = model.updateThread(s.file, s.from.id, { state: 'answered', reply: 'The explanation.', title: 'Renamed', add_tasks: ['build'] }, by, at(5));
    expect(u.thread.replyAt).toBe(at(2));
    expect(shownToHim(u.thread)).toBe(false);
    const news = model.updateThread(u.file, u.thread.id, { reply: 'A new result.' }, by, at(6));
    expect(news.thread.closed).toBeUndefined();
    expect(shownToHim(news.thread)).toBe(true);
  });

  it('a late answer to an earlier message is still news, never consumed by a reaction', () => {
    const r = reacted();
    const late = { ...r.thread, state: 'answered' as const, messages: r.thread.messages.map((m, i) => i === 0 ? { ...m, answer: { text: 'A late result.', at: at(5) } } : m) };
    expect(shownToHim(late)).toBe(true);
    expect(cardView(late).unread.map((x) => x.answer?.text)).toEqual(['A late result.']);
  });

  it('a user reaction hides a pinned card too, while an agent still cannot unpin it', () => {
    const pin = model.updateThread(base(), 'th-aaaaaa', { pin: true }, 'human', at(2));
    expect(() => model.updateThread(pin.file, pin.thread.id, { pin: false }, by, at(3))).toThrow(model.ThreadError);
    const reaction = model.fileMessage(pin.file, { threadId: pin.thread.id, text: 'One more question?', via: 'follow-up', at: at(3) });
    expect(reaction.thread.pinned).toBeUndefined();
    expect(shownToHim(reaction.thread, new Set(), Date.parse(at(4)))).toBe(false);
  });

  it('a retry neither reads new answers nor changes the original receipt', () => {
    const r = reacted();
    const again = model.fileMessage(r.file, { threadId: r.thread.id, text: r.message.text, via: 'follow-up', at: at(8), messageId: r.message.id });
    expect(again.duplicate).toBe(true);
    expect(again.file).toBe(r.file);
    expect(again.thread.reactedAt).toBe(at(3));
  });

  it('splitting a known answer keeps it known in its new subject', () => {
    const r = reacted();
    const s = model.splitThreadMessage(r.file, r.thread.id, 'tm-aaaaaa', by, at(4));
    const u = model.updateThread(s.file, s.thread.id, { state: 'answered' }, by, at(5));
    expect(shownToHim(u.thread)).toBe(false);
    expect(cardView(u.thread).unread).toEqual([]);
  });

  it('merging a known answer never makes it unread in the target', () => {
    const r = reacted();
    const target = model.fileMessage(r.file, { text: 'Other question?', via: 'chat', at: at(1), newThreadId: 'th-bbbbbb' });
    const merged = model.mergeThreads(target.file, r.thread.id, target.thread.id, by, at(4));
    const u = model.updateThread(merged.file, merged.thread.id, { state: 'answered' }, by, at(5));
    expect(shownToHim(u.thread)).toBe(false);
    expect(cardView(u.thread).unread).toEqual([]);
  });

  it('moving and retrying a move keep the reaction on the receiving node', () => {
    const r = reacted();
    const out = model.moveThreadOut(r.file, r.thread.id, { task: 'other', title: 'Other' }, by, at(4));
    const incoming = model.moveThreadIn(model.emptyThreads('other'), out.thread, { task: 'lead', title: 'Lead' }, by, at(5));
    const flipped = model.updateThread(incoming.file, incoming.thread.id, { state: 'answered' }, by, at(6));
    const retry = model.moveThreadIn(flipped.file, out.thread, { task: 'lead', title: 'Lead' }, by, at(7));
    expect(shownToHim(retry.thread)).toBe(false);
    expect(retry.thread.reactedAt).toBe(at(3));
  });

  it('automatic answers and turn-end marks cannot manufacture news', () => {
    const r = reacted();
    const same = model.setAnswers(r.file, new Map([['tm-aaaaaa', { text: 'The explanation.', at: at(2) }]]));
    expect(shownToHim(same.file.threads[0], new Set(), Date.parse(at(4)))).toBe(false);
    const marked = model.markRechecked(same.file, new Map([['th-aaaaaa', { since: at(2), at: at(6), why: 'reply' as const }]]));
    const flipped = model.updateThread(marked, 'th-aaaaaa', { state: 'answered' }, by, at(7));
    expect(shownToHim(flipped.thread)).toBe(false);
  });

  it('a late automatic answer reopens only a system reaction-close', () => {
    const r = reacted();
    const s = model.splitThreadMessage(r.file, r.thread.id, r.message.id, by, at(4));
    const missing = { ...s.file, threads: s.file.threads.map((t) => t.id === s.from.id ? { ...t, messages: t.messages.map(({ answer, ...m }) => m) } : t) };
    const late = model.setAnswers(missing, new Map([['tm-aaaaaa', { text: 'A new late answer.', at: at(5) }]]));
    const u = model.updateThread(late.file, s.from.id, { state: 'answered' }, by, at(6));
    expect(u.thread.closed).toBeUndefined();
    expect(shownToHim(u.thread)).toBe(true);
  });

  it('needs is news but still requires an agent to name a valid user kind', () => {
    const r = reacted();
    expect(() => model.updateThread(r.file, r.thread.id, { state: 'needs' }, by, at(5))).toThrow(model.ThreadError);
    const u = model.updateThread(r.file, r.thread.id, { state: 'needs', user_kind: 'user_info', user_kind_why: 'Only the user has this preference.' }, by, at(5));
    expect(shownToHim(u.thread)).toBe(true);
  });

  it('an agent known prefix stays a prefix across split and does not consume a later answer', () => {
    const file = base();
    delete file.threads[0].reply;
    delete file.threads[0].replyAt;
    file.threads[0].messages.push({ id: 'tm-bbbbbb', at: at(1), text: 'Second ask?', via: 'chat', answer: { text: 'Second answer.', at: at(4) } });
    const reactedElsewhere = model.fileMessage(file, { text: 'Seen the first answer.', via: 'chat', at: at(3), newThreadId: 'th-bbbbbb' });
    const known = model.updateThread(reactedElsewhere.file, 'th-aaaaaa', { known: 'all' }, by, at(5));
    expect(known.thread.known?.through).toBe('tm-aaaaaa');
    const split = model.splitThreadMessage(known.file, known.thread.id, 'tm-aaaaaa', by, at(6));
    expect(shownToHim(split.from)).toBe(true);
    expect(cardView(split.from).unread.map((x) => x.answer?.text)).toEqual(['Second answer.']);
  });

  it('an agent known bookkeeping write never reads a summary posted after the actual reaction', () => {
    const r = reacted();
    const news = model.updateThread(r.file, r.thread.id, { reply: 'Posted after the reaction.' }, by, at(4));
    const mark = model.updateThread(news.file, r.thread.id, { known: 'all' }, by, at(5));
    expect(mark.thread.reactedAt).toBe(at(3));
    expect(shownToHim(mark.thread)).toBe(true);
  });

  it('an agent known prefix based on another subject never reads this summary', () => {
    const r = model.fileMessage(base(), { text: 'Reply elsewhere.', via: 'chat', at: at(3), newThreadId: 'th-bbbbbb' });
    const marked = model.updateThread(r.file, 'th-aaaaaa', { known: 'all' }, by, at(5));
    expect(marked.thread.reactedAt).toBeUndefined();
    expect(shownToHim(marked.thread)).toBe(true);
  });

  it('a human acknowledgement of a system-close makes that close explicit', () => {
    const r = reacted();
    const split = model.splitThreadMessage(r.file, r.thread.id, r.message.id, by, at(4));
    const acked = model.updateThread(split.file, split.from.id, { close: 'acked' }, 'human', at(5));
    expect(acked.thread.closed?.reacted).toBeUndefined();
    const news = model.updateThread(acked.file, acked.thread.id, { reply: 'Later news.' }, by, at(6));
    expect(shownToHim(news.thread)).toBe(false);
  });

  it('move catch-up carries a reaction even when no message was added', () => {
    const original = base();
    const incoming = model.moveThreadIn(model.emptyThreads('other'), original.threads[0], { task: 'lead', title: 'Lead' }, by, at(2));
    const read = model.updateThread(original, 'th-aaaaaa', { known: 'all' }, 'human', at(3));
    const caughtUp = model.addMovedMessages(incoming.file, read.thread, at(4));
    expect(cardView(caughtUp.threads[0]).unread).toEqual([]);
    expect(shownToHim(caughtUp.threads[0])).toBe(false);
  });

  it('an explicit acknowledgement never opens automatically on later words', () => {
    const closed = model.updateThread(base(), 'th-aaaaaa', { close: 'acked' }, 'human', at(3));
    const written = model.updateThread(closed.file, closed.thread.id, { reply: 'Later answer.' }, by, at(4));
    expect(written.thread.closed?.by).toBe('human');
    expect(shownToHim(written.thread)).toBe(false);
  });

  it('silence never lets an agent hide answers with known or close', () => {
    expect(() => model.updateThread(base(), 'th-aaaaaa', { known: 'all' }, by, at(3))).toThrow(model.ThreadError);
    expect(() => model.updateThread(base(), 'th-aaaaaa', { close: 'acked' }, by, at(3))).toThrow(model.ThreadError);
  });

  it('every registered state and metadata patch leaves read words hidden unless it needs the user', () => {
    const r = reacted();
    const s = model.splitThreadMessage(r.file, r.thread.id, r.message.id, by, at(4));
    for (const state of model.THREAD_STATES) {
      for (const patch of [{ title: 'Renamed' }, { ask: 'Same subject' }, { tasks: ['build'] }, { add_tasks: ['check'] }, { reply: 'The explanation.' }, { reopen: true }]) {
        const updated = model.updateThread(s.file, s.from.id, { ...patch, state }, 'human', at(6));
        expect(shownToHim(updated.thread, new Set(), Date.parse(at(180))), JSON.stringify({ state, patch })).toBe(state === 'needs');
      }
    }
    const normalized = model.normalizeThreads(s.file, 'lead');
    const told = model.markClosesTold(normalized, [s.from.id]);
    expect(shownToHim(told.threads.find((t) => t.id === s.from.id)!)).toBe(false);
  });

  it('ratchets every exported model mutation into the reviewed inventory', () => {
    // A new write path must be classified and covered, not silently bypass the receipt rules.
    const source = fs.readFileSync(new URL('../../../src/core/org/threads-model.ts', import.meta.url), 'utf8');
    const parsed = ts.createSourceFile('threads-model.ts', source, ts.ScriptTarget.Latest, true);
    const writes = parsed.statements.filter(ts.isFunctionDeclaration)
      .filter((fn) => fn.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
        && /ThreadsFile|OrgThread\[\]/.test([...fn.parameters.map((p) => p.type?.getText(parsed) ?? ''), fn.type?.getText(parsed) ?? ''].join(' ')))
      .map((fn) => fn.name!.text);
    expect(writes.sort()).toEqual([
      'addMovedMessages', 'emptyThreads', 'enteredNeeds', 'fileMessage', 'lastUserAt', 'markClosesTold',
      'markRechecked', 'mergeThreads', 'moveThreadIn', 'moveThreadOut', 'normalizeThreads', 'openThread',
      'reactedSince', 'recentConversation', 'setAnswers', 'sortedThreads', 'splitThreadMessage',
      'stampLegacyReplyAt', 'sweepClosed', 'updateThread',
    ].sort());
  });
});
