/**
 * The fullscreen review cards' content (ThreadReviewSidebar.tsx): the messages
 * are indexed once, each card reads its newest round from that index, and a
 * streamed answer only replaces its own card's answer (no rescan per token).
 */
import { describe, expect, it } from 'vitest';
import { answerExcerpt, buildReviewEntries, reviewTurnIndex, withLiveAnswers } from '@/components/sessions/ThreadReviewSidebar';
import type { SessionHistoryMessage } from '@/types/session';
import type { ThreadTree } from '@/utils/thread-tree';

const msg = (role: 'user' | 'assistant', id: string, text: string) => ({ role, msgId: id, text }) as unknown as SessionHistoryMessage;
const messages = [
  msg('user', 'u1', 'Why the oldest page?'), msg('assistant', 'a1', 'Because it is the cheapest to drop.'),
  msg('user', 'u2', 'Main thread words'), msg('assistant', 'a2', 'Main answer'),
  msg('user', 'u3', 'And after a restart?'), msg('assistant', 'a3a', 'Let me check.'), msg('assistant', 'a3b', 'It replays the log first.'),
  msg('user', 'u4', 'Second question'),
];
const node = (key: string, turnIds: string[]) => ({ key, headId: turnIds[0], label: key, turnIds });
const tree = { byKey: new Map([['q1', node('q1', ['u1', 'u3'])], ['q2', node('q2', ['u4'])]]) } as unknown as ThreadTree;

describe('review card entries', () => {
  const turns = reviewTurnIndex(messages);
  const entries = buildReviewEntries({
    keys: ['q1', 'q2', 'gone'], tree, metaIndex: new Map(), numbers: new Map([['q1', 1], ['q2', 2]]), turns,
    markStates: new Map([['q2', 'waiting']]),
  });

  it('one entry per known question, its newest round and the final reply of that round', () => {
    expect(entries.map((e) => e.key)).toEqual(['q1', 'q2']);
    expect(entries[0]).toMatchObject({ number: 1, rounds: 2, question: 'And after a restart?', answer: 'It replays the log first.', state: 'read' });
    expect(entries[1]).toMatchObject({ number: 2, rounds: 1, question: 'Second question', answer: '', state: 'waiting' });
  });

  it('live words replace only the streaming card, and keep the others as they were', () => {
    const live = withLiveAnswers(entries, new Map([['q2', 'Streaming now']]));
    expect(live[1].answer).toBe('Streaming now');
    expect(live[0]).toBe(entries[0]);
    expect(withLiveAnswers(entries, new Map())).toBe(entries);
  });
});

describe('the answer excerpt', () => {
  it('drops the reply tag line, as the question card does', () => {
    expect(answerExcerpt('[Q2]\nThe router hashes the key.')).toBe('The router hashes the key.');
    expect(answerExcerpt('**[Q12]**\n\nTwo cases.')).toBe('Two cases.');
    expect(answerExcerpt('No tag here [Q3] in the middle')).toBe('No tag here [Q3] in the middle');
  });
  it('a streamed answer holding only the start of its tag shows nothing yet', () => {
    expect(answerExcerpt('[')).toBe('');
    expect(answerExcerpt('[Q')).toBe('');
    expect(answerExcerpt('[Q1')).toBe('');
    expect(withLiveAnswers([{ key: 'k', title: 't', state: 'answering', question: 'q', answer: '', rounds: 1 }], new Map([['k', '[Q4]\nStreaming']]))[0].answer).toBe('Streaming');
  });
});
