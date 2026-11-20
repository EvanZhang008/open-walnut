/**
 * Which words of a woken member are its topic reply (src/core/topics/topic-replies.ts replyFromRows),
 * and the rule a wake carries while people outside Walnut read the topic by mail (topic-text.ts).
 * A reply is posted as the member, and from there emailed to people outside Walnut, so only the
 * words of the turn its own wake opened count:
 *
 *   - wake, reply: posted;
 *   - wake, another task's note, reply: nothing (the reply may answer the note);
 *   - wake in a batch with a person's words: nothing;
 *   - wake delivered into a running turn (right after its tool call): nothing;
 *   - two topics' wakes in one session: each topic gets only the words after its own wake;
 *   - no wake in the chat yet: still waiting;
 *   - a notification riding the wake, and message hints, do not count as other input.
 */
import { describe, expect, it } from 'vitest'
import { buildWalnutMessage } from '../../../src/core/peers/walnut-message-tag.js'
import { renderHintBlock } from '../../../src/core/hints/hint-format.js'
import { replyFromRows, rowFor, type ReplyRow } from '../../../src/core/topics/topic-replies.js'
import { MAIL_READERS_RULE, topicRules } from '../../../src/core/topics/topic-text.js'
import type { Topic, TopicMember } from '../../../src/core/topics/topics-model.js'

const A = 'tp-aaaaaaaaaaaa'
const B = 'tp-bbbbbbbbbbbb'
const SINCE = '2026-11-20T10:00:00.000Z'
const at = (s: number) => new Date(Date.parse(SINCE) + s * 1000).toISOString()

const wake = (id: string) => buildWalnutMessage({ kind: 'topic', attrs: { from: 'Topic: x', about: id, title: '1 new message' }, body: 'Robin: where are we?' })
const note = buildWalnutMessage({ kind: 'peer-note', attrs: { from: 'Task: Orchard', about: 'task-1' }, body: 'Please send me the plan.' })
const rider = buildWalnutMessage({ kind: 'notification', attrs: { from: 'Walnut', about: 'Task: Quill', outcome: 'stopped' }, body: 'Quill stopped.' })

const user = (text: string, s: number): ReplyRow => ({ role: 'user', text, timestamp: at(s) })
const said = (text: string, s: number): ReplyRow => ({ role: 'assistant', text, timestamp: at(s) })
const tool = (s: number): ReplyRow => ({ role: 'assistant', text: 'Bash', timestamp: at(s), kind: 'tool' })

describe('a topic reply is only the words of the turn its own wake opened', () => {
  it('wake then reply: posted (the last words of that turn)', () => {
    expect(replyFromRows([user(wake(A), 1), said('Looking.', 2), tool(3), said('The venue holds Tuesday.', 4)], SINCE, A))
      .toEqual({ text: 'The venue holds Tuesday.', spoke: true })
  })

  it('wake, another task\'s note, then a reply: nothing is posted', () => {
    expect(replyFromRows([user(wake(A), 1), user(note, 2), said('Here is the plan for Orchard: ...', 3)], SINCE, A))
      .toEqual({ text: '', spoke: true, busy: true })
  })

  it('a wake batched with a person\'s words, or delivered into a running turn: nothing is posted', () => {
    expect(replyFromRows([user(`${wake(A)}\n\nAlso, fix the login page.`, 1), said('Done with the login page.', 2)], SINCE, A))
      .toEqual({ text: '', spoke: true, busy: true })
    expect(replyFromRows([said('Building.', 1), tool(2), user(wake(A), 3), said('Build is green.', 4)], SINCE, A))
      .toEqual({ text: '', spoke: true, busy: true })
  })

  it('two topics\' wakes in one session: each topic gets only its own reply', () => {
    const rows = [user(wake(A), 1), said('For A: the venue holds.', 2), user(wake(B), 3), said('For B: the budget is fine.', 4)]
    expect(replyFromRows(rows, SINCE, A)).toEqual({ text: 'For A: the venue holds.', spoke: true })
    expect(replyFromRows(rows, SINCE, B)).toEqual({ text: 'For B: the budget is fine.', spoke: true })
  })

  it('no wake in the chat yet, or no words after it yet: still waiting', () => {
    expect(replyFromRows([said('Earlier work.', 1)], SINCE, A)).toEqual({ text: '', spoke: false })
    expect(replyFromRows([user(wake(A), 1), tool(2)], SINCE, A)).toEqual({ text: '', spoke: false })
    // A wake from before this turn's start is not this turn's.
    expect(replyFromRows([{ ...user(wake(A), 0), timestamp: '2026-11-20T09:00:00.000Z' }, said('Old words.', 1)], SINCE, A)).toEqual({ text: '', spoke: false })
  })

  it('the agent-ack line alone posts nothing and ends the wait (not a busy turn: nothing is said about it)', () => {
    expect(replyFromRows([user(wake(A), 1), said('Checking.', 2), tool(3), said('<walnut-turn status="agent-ack"/>', 4)], SINCE, A))
      .toEqual({ text: '', spoke: true })
  })

  it('a notification riding the wake and Walnut\'s message hints are not other input', () => {
    const hinted = `${renderHintBlock('rich-output', 'rich output mode is on.')}\n\n${rider}\n${wake(A)}`
    expect(rowFor({ text: hinted }, A)).toBe('mine')
    expect(rowFor({ text: wake(B) }, A)).toBe('other')
    expect(rowFor({ text: `${wake(A)}\n${note}` }, A)).toBe('mixed')
    expect(rowFor({ text: `${wake(A)}\n\nAlso this.` }, A)).toBe('mixed')
    expect(replyFromRows([user(hinted, 1), said('Venue holds.', 2)], SINCE, A)).toEqual({ text: 'Venue holds.', spoke: true })
  })
})

describe('the wake\'s rules while people read the topic by mail', () => {
  const base = (persons: Array<TopicMember['status']>): { topic: Topic; me: TopicMember } => {
    const me: TopicMember = { id: 'mb-00000001', ref: { kind: 'task', taskId: 't1' }, name: 'Marina', role: 'member', joinedAt: SINCE, addedBy: 'human', status: 'active' }
    const people: TopicMember[] = persons.map((status, i) => ({ id: `mb-1000000${i}` as TopicMember['id'], ref: { kind: 'person', name: `P${i}`, email: `p${i}@example.com` }, name: `P${i}`, role: 'member', joinedAt: SINCE, addedBy: 'human', status }))
    const topic = { id: A, title: 'x', createdAt: SINCE, updatedAt: SINCE, createdBy: 'human', members: [me, ...people], messages: [], round: { n: 1, startedAt: SINCE, hops: 0, pairs: {} } } as Topic
    return { topic, me }
  }

  it('says email readers are there only while a person is an active member', () => {
    const withPerson = base(['active'])
    expect(topicRules(withPerson.topic, withPerson.me, false)).toContain(`4. ${MAIL_READERS_RULE}`)
    expect(topicRules(withPerson.topic, withPerson.me, true).some((r) => r.endsWith(MAIL_READERS_RULE))).toBe(true)
    for (const statuses of [[], ['pending'], ['left']] as Array<Array<TopicMember['status']>>) {
      const t = base(statuses)
      expect(topicRules(t.topic, t.me, false).some((r) => r.includes(MAIL_READERS_RULE)), statuses.join(',')).toBe(false)
    }
  })
})
