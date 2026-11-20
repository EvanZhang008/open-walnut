/**
 * A member is never stuck behind a topic turn that no longer runs (src/core/topics/topic-turn-live.ts,
 * topic-delivery.ts claimTurn, topic-replies.ts endTurnsOf / expirePendingTurns), with the session
 * send, the transcript read and the "is a turn live" reading replaced:
 *
 *   1. a new wake is held back only by a turn of the same session that still runs (or was claimed
 *      under a minute ago); a stale one, or one in another session, is replaced and the wake goes;
 *   2. a session's stop or error drops its turns after what it said is posted; a live one keeps them;
 *   3. a dropped turn that was told more (`more`) sends its one follow-up wake, an expired one too.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-topic-turn-live'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { updateConfig } from '../../../src/core/config-manager.js'
import { addTask } from '../../../src/core/task-manager.js'
import { createSessionRecord } from '../../../src/core/session-tracker.js'
import { bus, EventNames } from '../../../src/core/event-bus.js'
import { buildWalnutMessage } from '../../../src/core/peers/walnut-message-tag.js'
import { _setTopicSendForTesting, QUEUED_WHY } from '../../../src/core/topics/topic-delivery.js'
import {
  _resetTopicRepliesForTesting, _setTopicTranscriptForTesting, endsTopicTurn, endTurnsOf, expirePendingTurns, notePendingTurn, startTopics,
  type ReplyRow,
} from '../../../src/core/topics/topic-replies.js'
import {
  _setTopicTurnLiveForTesting, sessionTurnLive, TOPIC_TURN_SETTLE_MS, turnHoldsWake,
} from '../../../src/core/topics/topic-turn-live.js'
import { createTopic, postMessage } from '../../../src/core/topics/topic-post.js'
import { readTopic, updateMember } from '../../../src/core/topics/topics-store.js'
import { PENDING_TURN_MAX_MS, type Topic, type TopicMember } from '../../../src/core/topics/topics-model.js'

const sent: Array<{ sid: string; text: string }> = []
const rows = new Map<string, ReplyRow[]>()
const live = new Set<string>()
const ids: Record<string, string> = {}
let topic: Topic

const marina = async (): Promise<TopicMember> => (await readTopic(topic.id))!.members.find((m) => m.name === 'Marina')!
const sentTo = (sid: string) => sent.filter((s) => s.sid === sid).map((s) => s.text)
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()

/** Marina's turn in `sessionId`, claimed `age` ago. */
async function turnOfMarina(sessionId: string, age: number, more?: boolean): Promise<void> {
  const t = (await readTopic(topic.id))!
  await updateMember(topic.id, (await marina()).id, { pendingTurn: { sessionId, since: ago(age), messageId: t.messages.at(-1)!.id, ...(more ? { more } : {}) } })
  notePendingTurn(sessionId, topic.id)
}

beforeAll(async () => {
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  await updateConfig({ experimental: { topics: true }, user: { name: 'Robin' } } as never)
  for (const title of ['Marina', 'Orchard']) ids[title] = (await addTask({ title, project: 'Acme' })).task.id
  for (const title of ['Marina', 'Orchard']) {
    await createSessionRecord(`s-${title.toLowerCase()}`, ids[title], 'Acme', undefined, { initialProcessStatus: 'idle' })
  }
  _setTopicSendForTesting(async (sid, text) => { sent.push({ sid, text }) })
  _setTopicTranscriptForTesting(async (sid, since) => (rows.get(sid) ?? []).filter((r) => r.timestamp >= since))
  topic = (await createTopic({
    title: 'Launch plan',
    members: ['Marina', 'Orchard'].map((t) => ({ kind: 'task' as const, taskId: ids[t] })),
    by: 'human',
  })).topic
  await postMessage(topic.id, { author: 'human', text: 'Kickoff', via: 'ui' })
})

beforeEach(async () => {
  _resetTopicRepliesForTesting()
  _setTopicTurnLiveForTesting(async (sid) => live.has(sid))
  live.clear()
  rows.clear()
  await updateMember(topic.id, (await marina()).id, { pendingTurn: undefined })
})

afterAll(async () => {
  _setTopicSendForTesting(null)
  _setTopicTranscriptForTesting(null)
  _setTopicTurnLiveForTesting(null)
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('which turn holds a new wake back', () => {
  it('only a turn of the same session that is live, or claimed under a minute ago, and never past 2 hours', () => {
    const now = Date.now()
    const turn = (age: number, sessionId = 's-a') => ({ sessionId, since: new Date(now - age).toISOString(), messageId: 'tpm-000000000001' })
    expect(turnHoldsWake(turn(5 * 60_000), 's-a', true, now)).toBe(true)
    expect(turnHoldsWake(turn(5 * 60_000), 's-a', false, now)).toBe(false)
    expect(turnHoldsWake(turn(TOPIC_TURN_SETTLE_MS - 1000), 's-a', false, now)).toBe(true)
    expect(turnHoldsWake(turn(5 * 60_000, 's-old'), 's-a', true, now)).toBe(false)
    expect(turnHoldsWake(turn(PENDING_TURN_MAX_MS + 1000), 's-a', true, now)).toBe(false)
  })

  it('reads the session itself: an idle session with nothing queued, or none at all, runs no turn', async () => {
    _setTopicTurnLiveForTesting(null)
    expect(await sessionTurnLive('s-marina')).toBe(false)
    expect(await sessionTurnLive('s-nobody')).toBe(false)
  })
})

describe('a stale turn never holds a member back (M2)', () => {
  it('a turn whose session runs no turn any more is replaced: the wake goes at once', async () => {
    await turnOfMarina('s-marina', 5 * 60_000)
    const sends = sentTo('s-marina').length
    const out = await postMessage(topic.id, { author: 'human', text: '@Marina are the dates fixed?', via: 'ui' })
    expect(sentTo('s-marina').slice(sends)).toHaveLength(1)
    const t = (await readTopic(topic.id))!
    expect(t.messages.find((m) => m.id === out.message.id)?.woke).toContain((await marina()).id)
    expect((await marina()).pendingTurn).toMatchObject({ sessionId: 's-marina', messageId: out.message.id })
  })

  it('a turn in another session (the member\'s session changed) is replaced', async () => {
    live.add('s-old')
    await turnOfMarina('s-old', 5 * 60_000)
    const sends = sentTo('s-marina').length
    const out = await postMessage(topic.id, { author: 'human', text: '@Marina and the venue?', via: 'ui' })
    expect(sentTo('s-marina').slice(sends)).toHaveLength(1)
    expect((await marina()).pendingTurn).toMatchObject({ sessionId: 's-marina', messageId: out.message.id })
  })

  it('a turn its session still runs holds the wake: it is marked more', async () => {
    live.add('s-marina')
    await turnOfMarina('s-marina', 5 * 60_000)
    const sends = sentTo('s-marina').length
    const out = await postMessage(topic.id, { author: 'human', text: '@Marina one more thing', via: 'ui' })
    expect(sentTo('s-marina').slice(sends)).toHaveLength(0)
    const t = (await readTopic(topic.id))!
    expect(t.messages.find((m) => m.id === out.message.id)?.refused).toContainEqual({ member: (await marina()).id, why: QUEUED_WHY })
    expect((await marina()).pendingTurn?.more).toBe(true)
  })
})

describe('a stopped or failed session lets its turns go (M2)', () => {
  it('drops a turn that never spoke, and sends the one follow-up wake when it was told more', async () => {
    live.add('s-marina')
    await turnOfMarina('s-marina', 5 * 60_000)
    await postMessage(topic.id, { author: 'human', text: '@Marina the line it missed', via: 'ui' })
    expect((await marina()).pendingTurn?.more).toBe(true)
    // The session stopped: nothing runs and nothing is queued.
    live.delete('s-marina')
    const sends = sentTo('s-marina').length
    expect(await endTurnsOf('s-marina')).toBe(1)
    const followUp = sentTo('s-marina').slice(sends)
    expect(followUp).toHaveLength(1)
    expect(followUp[0]).toContain('the line it missed')
    // The follow-up is a fresh turn, without `more`.
    expect((await marina()).pendingTurn).toMatchObject({ sessionId: 's-marina' })
    expect((await marina()).pendingTurn?.more).toBeUndefined()
  })

  it('posts what the turn said before the stop, and drops nothing more', async () => {
    await turnOfMarina('s-marina', 5 * 60_000)
    const turn = (await marina()).pendingTurn!
    const later = new Date(Date.parse(turn.since) + 1000).toISOString()
    rows.set('s-marina', [
      { role: 'user', text: buildWalnutMessage({ kind: 'topic', attrs: { from: 'Topic: Launch plan', about: topic.id }, body: 'x' }), timestamp: later },
      { role: 'assistant', text: 'Dates are fixed.', timestamp: later },
    ])
    expect(await endTurnsOf('s-marina')).toBe(0)
    const t = (await readTopic(topic.id))!
    expect(t.messages.at(-1)).toMatchObject({ author: (await marina()).id, text: 'Dates are fixed.' })
    expect((await marina()).pendingTurn).toBeUndefined()
  })

  it('keeps the turn while the session holds a queued wake, or the turn was claimed under a minute ago', async () => {
    live.add('s-marina')
    await turnOfMarina('s-marina', 5 * 60_000)
    expect(await endTurnsOf('s-marina')).toBe(0)
    expect((await marina()).pendingTurn).toBeDefined()
    live.delete('s-marina')
    await turnOfMarina('s-marina', 1000)
    expect(await endTurnsOf('s-marina')).toBe(0)
    expect((await marina()).pendingTurn).toBeDefined()
  })

  it('a session:error or a stop on the bus drops the turn; a delivery failure still queued does not count', async () => {
    expect(endsTopicTurn('session:error', { sessionId: 's', error: 'boom' })).toBe(true)
    expect(endsTopicTurn('session:error', { sessionId: 's', errorKind: 'delivery_failed' })).toBe(false)
    expect(endsTopicTurn('session:error', { sessionId: 's', errorKind: 'delivery_failed', parked: true })).toBe(true)
    expect(endsTopicTurn('session:status-changed', { sessionId: 's', process_status: 'stopped' })).toBe(true)
    expect(endsTopicTurn('session:status-changed', { sessionId: 's', status: { process_status: 'error' } })).toBe(true)
    expect(endsTopicTurn('session:status-changed', { sessionId: 's', process_status: 'idle' })).toBe(false)
    expect(endsTopicTurn('session:result', { sessionId: 's' })).toBe(false)

    const replies = startTopics()
    try {
      await turnOfMarina('s-marina', 5 * 60_000)
      // The start's own index of pending turns is built first.
      await replies.ready
      notePendingTurn('s-marina', topic.id)
      bus.emit(EventNames.SESSION_ERROR, { sessionId: 's-marina', error: 'the model call failed' }, ['*'], { source: 'test' })
      await vi.waitFor(async () => expect((await marina()).pendingTurn).toBeUndefined(), { timeout: 5_000 })
    } finally {
      replies.stop()
    }
  })

  it('an expired turn that was told more sends its one follow-up wake', async () => {
    live.add('s-marina')
    await turnOfMarina('s-marina', 5 * 60_000)
    await postMessage(topic.id, { author: 'human', text: '@Marina still there?', via: 'ui' })
    const m = await marina()
    await updateMember(topic.id, m.id, { pendingTurn: { ...m.pendingTurn!, since: ago(PENDING_TURN_MAX_MS + 60_000) } })
    live.delete('s-marina')
    const sends = sentTo('s-marina').length
    expect(await expirePendingTurns()).toBe(1)
    const followUp = sentTo('s-marina').slice(sends)
    expect(followUp).toHaveLength(1)
    expect(followUp[0]).toContain('still there?')
  })
})
