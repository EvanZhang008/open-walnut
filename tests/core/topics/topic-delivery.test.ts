/**
 * A topic message reaching its members, and their replies coming back (src/core/topics/
 * topic-delivery.ts, topic-replies.ts), with the session send and the transcript read replaced:
 *
 *   members: Marina (task, session), Orchard (task, session), Fence (complete task), Quill (task, no session)
 *
 *   1. the user's message wakes Marina and Orchard with one `topic` envelope each: the unread lines,
 *      the members, the rules; Fence and Quill are refused with why and one Walnut line says so;
 *   2. a member's message with no @mention folds: the next message of each other member carries it
 *      as a held `topic-news` notice, and its readUpto moves;
 *   3. a woken member's real reply is posted as that member and wakes whom it @mentions;
 *   4. an agent-ack reply posts nothing and ends the wait; no words yet keeps it waiting;
 *   5. a topic turn past 2 hours is dropped.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-topic-delivery'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { updateConfig } from '../../../src/core/config-manager.js'
import { addTask, updateTaskRaw } from '../../../src/core/task-manager.js'
import { createSessionRecord } from '../../../src/core/session-tracker.js'
import { pendingHeldNotices, _clearHeldNotices } from '../../../src/core/sessions/held-notices.js'
import { parseWalnutMessage } from '../../../src/core/peers/walnut-message-tag.js'
import { _setTopicSendForTesting } from '../../../src/core/topics/topic-delivery.js'
import { _setTopicTranscriptForTesting, _resetTopicRepliesForTesting, captureReplies, expirePendingTurns, type ReplyRow } from '../../../src/core/topics/topic-replies.js'
import { createTopic, postMessage } from '../../../src/core/topics/topic-post.js'
import { readTopic, updateMember } from '../../../src/core/topics/topics-store.js'
import type { Topic, TopicMember } from '../../../src/core/topics/topics-model.js'

const sent: Array<{ sid: string; text: string }> = []
const rows = new Map<string, ReplyRow[]>()
const ids: Record<string, string> = {}
let topic: Topic

const byName = (t: Topic, name: string): TopicMember => t.members.find((m) => m.name === name)!
const sentTo = (sid: string) => sent.filter((s) => s.sid === sid).map((s) => s.text)

beforeAll(async () => {
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  await updateConfig({ experimental: { topics: true }, user: { name: 'Robin' } } as never)
  for (const title of ['Marina', 'Orchard', 'Fence', 'Quill']) {
    ids[title] = (await addTask({ title, project: 'Acme' })).task.id
  }
  await updateTaskRaw(ids.Fence, { phase: 'COMPLETE' } as never)
  for (const title of ['Marina', 'Orchard', 'Fence']) {
    await createSessionRecord(`s-${title.toLowerCase()}`, ids[title], 'Acme', undefined, { initialProcessStatus: 'idle' })
  }
  _setTopicSendForTesting(async (sid, text) => { sent.push({ sid, text }) })
  _setTopicTranscriptForTesting(async (sid, since) => (rows.get(sid) ?? []).filter((r) => r.timestamp >= since))
  _resetTopicRepliesForTesting()
  _clearHeldNotices()
  topic = (await createTopic({
    title: 'Launch plan',
    members: ['Marina', 'Orchard', 'Fence', 'Quill'].map((t) => ({ kind: 'task' as const, taskId: ids[t] })),
    by: 'human',
  })).topic
})

afterAll(async () => {
  _setTopicSendForTesting(null)
  _setTopicTranscriptForTesting(null)
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('topic delivery', () => {
  it('the user\'s message wakes the members with a session, with the unread lines and the rules; the others are refused', async () => {
    const out = await postMessage(topic.id, { author: 'human', text: 'Where are we on the launch dates?', via: 'ui' })
    const t = (await readTopic(topic.id))!
    const [marina, orchard, fence, quill] = ['Marina', 'Orchard', 'Fence', 'Quill'].map((n) => byName(t, n))
    expect(out.delivery.wake).toEqual([marina.id, orchard.id])
    expect(out.delivery.refused).toEqual([
      { member: fence.id, why: 'its task is complete' },
      { member: quill.id, why: 'its task has no session' },
    ])
    const wake = sentTo('s-marina')[0]
    const env = parseWalnutMessage(wake)!
    expect(env.kind).toBe('topic')
    expect(env.attrs.about).toBe(topic.id)
    expect(env.body).toContain('Robin (the user\'s own words, relayed by Walnut: his request to act on): Where are we on the launch dates?')
    expect(env.body).toContain('@Orchard (task ')
    expect(env.body).toContain('1. Your reply in this turn is posted to the topic as you. Mention @Name only to wake someone; 3 wakes left this round.')
    expect(env.body).toContain('2. Nothing new to add: answer with the agent-ack line only')
    expect(env.body).toContain('3. Write what this topic means for your own work into your own task')
    expect(sentTo('s-fence')).toEqual([])
    expect(marina.pendingTurn).toMatchObject({ sessionId: 's-marina', messageId: out.message.id })
    expect(marina.readUpto).toBe(out.message.id)
    // Who was not woken, and why, is on the message itself (the web's reach line); no extra Walnut line.
    expect(t.messages.filter((m) => m.author === 'walnut')).toEqual([])
    expect(t.messages.find((m) => m.id === out.message.id)?.refused).toEqual(expect.arrayContaining([
      { member: fence.id, why: 'its task is complete' }, { member: quill.id, why: 'its task has no session' },
    ]))
    expect(t.messages.find((m) => m.id === out.message.id)?.woke).toEqual([marina.id, orchard.id])
  })

  it('a member\'s message with no @mention folds into the others\' next message', async () => {
    const before = (await readTopic(topic.id))!
    const marina = byName(before, 'Marina')
    const sends = sent.length
    const out = await postMessage(topic.id, { author: marina.id, text: 'The dates hold for next week.', via: 'agent' })
    expect(out.delivery.wake).toEqual([])
    expect(sent.length).toBe(sends)
    const held = await pendingHeldNotices('s-orchard')
    expect(held?.text).toContain('outcome="topic-news"')
    expect(held?.text).toContain('Marina: The dates hold for next week.')
    held?.release()
    const t = (await readTopic(topic.id))!
    expect(byName(t, 'Orchard').readUpto).toBe(out.message.id)
    // No session: nothing held, and it reads the line with its next wake.
    expect(byName(t, 'Quill').readUpto).toBeUndefined()
  })

  it('a woken member\'s reply is posted as it and wakes whom it names', async () => {
    const t = (await readTopic(topic.id))!
    const turn = byName(t, 'Orchard').pendingTurn!
    const later = new Date(Date.parse(turn.since) + 1000).toISOString()
    rows.set('s-orchard', [
      { role: 'user', text: sentTo('s-orchard').at(-1)!, timestamp: later },
      { role: 'assistant', text: 'Checking.', timestamp: later, kind: 'tool' },
      { role: 'assistant', text: '@Marina the venue confirmed Tuesday. <walnut-turn status="agent-ack"/>', timestamp: later },
    ])
    const sends = sentTo('s-marina').length
    expect(await captureReplies('s-orchard')).toBe(1)
    const after = (await readTopic(topic.id))!
    const reply = after.messages.filter((m) => m.author === byName(after, 'Orchard').id).at(-1)!
    expect(reply).toMatchObject({ text: '@Marina the venue confirmed Tuesday.', via: 'agent', mentions: [byName(after, 'Marina').id] })
    expect(reply.woke).toEqual([byName(after, 'Marina').id])
    expect(byName(after, 'Orchard').pendingTurn).toBeUndefined()
    expect(after.round.hops).toBe(1)
    const wake = sentTo('s-marina').slice(sends)
    expect(wake).toHaveLength(1)
    expect(wake[0]).toContain('Orchard: @Marina the venue confirmed Tuesday.')
    expect(wake[0]).toContain('2 wakes left this round')
  })

  it('an agent-ack reply posts nothing; no words yet keeps the turn waiting', async () => {
    const t = (await readTopic(topic.id))!
    const marina = byName(t, 'Marina')
    const turn = marina.pendingTurn!
    rows.set('s-marina', [])
    expect(await captureReplies('s-marina')).toBe(0)
    expect(byName((await readTopic(topic.id))!, 'Marina').pendingTurn).toEqual(turn)
    const later = new Date(Date.parse(turn.since) + 2000).toISOString()
    rows.set('s-marina', [
      { role: 'user', text: sentTo('s-marina').at(-1)!, timestamp: later },
      { role: 'assistant', text: '<walnut-turn status="agent-ack"/>', timestamp: later },
    ])
    const count = (await readTopic(topic.id))!.messages.length
    expect(await captureReplies('s-marina')).toBe(0)
    const after = (await readTopic(topic.id))!
    expect(after.messages).toHaveLength(count)
    expect(byName(after, 'Marina').pendingTurn).toBeUndefined()
  })

  it('one session woken by two topics: each topic gets only the reply after its own wake', async () => {
    const other = (await createTopic({
      title: 'Venue',
      members: ['Marina', 'Orchard'].map((t) => ({ kind: 'task' as const, taskId: ids[t] })),
      by: 'human',
    })).topic
    const sends = sentTo('s-marina').length
    await postMessage(topic.id, { author: 'human', text: '@Marina which day?', via: 'ui' })
    await postMessage(other.id, { author: 'human', text: '@Marina which room?', via: 'ui' })
    const [wakeLaunch, wakeVenue] = sentTo('s-marina').slice(sends)
    expect(parseWalnutMessage(wakeLaunch)?.attrs.about).toBe(topic.id)
    expect(parseWalnutMessage(wakeVenue)?.attrs.about).toBe(other.id)
    const t = Date.now() + 5000
    const iso = (s: number) => new Date(t + s * 1000).toISOString()
    rows.set('s-marina', [
      { role: 'user', text: wakeLaunch, timestamp: iso(1) },
      { role: 'assistant', text: 'Tuesday.', timestamp: iso(2) },
      { role: 'user', text: wakeVenue, timestamp: iso(3) },
      { role: 'assistant', text: 'The big room.', timestamp: iso(4) },
    ])
    expect(await captureReplies('s-marina')).toBe(2)
    const launch = (await readTopic(topic.id))!
    const venue = (await readTopic(other.id))!
    const lastOf = (x: Topic) => x.messages.filter((m) => m.author === byName(x, 'Marina').id).at(-1)?.text
    expect(lastOf(launch)).toBe('Tuesday.')
    expect(lastOf(venue)).toBe('The big room.')
  })

  it('a topic turn older than 2 hours is dropped', async () => {
    const t = (await readTopic(topic.id))!
    const old = new Date(Date.now() - 3 * 3600_000).toISOString()
    await updateMember(t.id, byName(t, 'Orchard').id, { pendingTurn: { sessionId: 's-orchard', since: old, messageId: t.messages[0].id } })
    expect(await expirePendingTurns()).toBe(1)
    expect(byName((await readTopic(topic.id))!, 'Orchard').pendingTurn).toBeUndefined()
  })
})
