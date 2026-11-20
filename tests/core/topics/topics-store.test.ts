/**
 * Topics on disk (src/core/topics/topics-store.ts): one JSON file per topic under the data home,
 * written under its lock.
 *
 *   1. a topic written reads back the same, lists newest first, and emits topic:updated;
 *   2. two writers appending at the same time keep every message (the lock serializes them);
 *   3. past 2000 messages the oldest are dropped and counted;
 *   4. updateMember sets and removes fields (the mail bridge's `mail`, a cleared pendingTurn);
 *   5. a follower keeps no topics: reads are empty, writes refuse.
 */
import { afterAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-topics-store'))
const role = vi.hoisted(() => ({ follower: false }))
vi.mock('../../../src/core/server-role.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), isFollower: () => role.follower }))

import { WALNUT_HOME } from '../../../src/constants.js'
import { bus, EventNames } from '../../../src/core/event-bus.js'
import { listTopics, mutateTopic, readTopic, topicsDir, updateMember, writeNewTopic } from '../../../src/core/topics/topics-store.js'
import { TOPIC_MESSAGES_MAX, freshRound, newMessageId, newTopicId, type MemberId, type Topic } from '../../../src/core/topics/topics-model.js'

afterAll(async () => { await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {}) })

function blank(title: string, at = new Date().toISOString()): Topic {
  return {
    id: newTopicId(), title, createdAt: at, updatedAt: at, createdBy: 'human', messages: [], round: freshRound(0, at),
    members: [{ id: 'mb-00000001' as MemberId, ref: { kind: 'task', taskId: 't-marina' }, name: 'Marina', role: 'host', joinedAt: at, addedBy: 'human', status: 'active' }],
  }
}

const line = (text: string) => ({ id: newMessageId(), at: new Date().toISOString(), author: 'human' as const, text, mentions: [], via: 'ui' as const })

describe('topics store', () => {
  it('round trip: written, read back, listed newest first, one event per write', async () => {
    const seen: string[] = []
    bus.subscribe('test-topics-store', (e) => { seen.push((e.data as { topicId: string }).topicId) }, { global: true, interest: [EventNames.TOPIC_UPDATED] })
    const a = await writeNewTopic(blank('Launch plan', '2020-01-01T10:00:00.000Z'))
    const b = await writeNewTopic(blank('Fence repair', '2020-01-01T11:00:00.000Z'))
    expect(await readTopic(a.id)).toEqual(a)
    expect(JSON.parse(await fs.readFile(path.join(topicsDir(), `${a.id}.json`), 'utf8')).title).toBe('Launch plan')
    await mutateTopic(a.id, (t) => { t.messages.push(line('first')) })
    const ids = (await listTopics()).map((t) => t.id)
    expect(ids.indexOf(a.id)).toBeLessThan(ids.indexOf(b.id))
    expect(seen).toEqual([a.id, b.id, a.id])
    bus.unsubscribe('test-topics-store')
    expect(await readTopic('tp-000000000000')).toBeNull()
    await expect(mutateTopic('tp-000000000000', () => {})).rejects.toMatchObject({ code: 'not_found' })
  })

  it('two writers appending at once keep every message', async () => {
    const t = await writeNewTopic(blank('Busy'))
    const writer = (who: string) => Promise.all(Array.from({ length: 15 }, (_, i) => mutateTopic(t.id, (x) => { x.messages.push(line(`${who}-${i}`)) })))
    await Promise.all([writer('a'), writer('b')])
    const texts = (await readTopic(t.id))!.messages.map((m) => m.text)
    expect(texts).toHaveLength(30)
    for (let i = 0; i < 15; i++) expect(texts).toEqual(expect.arrayContaining([`a-${i}`, `b-${i}`]))
  })

  it(`keeps the newest ${TOPIC_MESSAGES_MAX} messages and counts the dropped ones`, async () => {
    const t = await writeNewTopic(blank('Long'))
    await mutateTopic(t.id, (x) => { for (let i = 0; i < TOPIC_MESSAGES_MAX + 5; i++) x.messages.push(line(`m${i}`)) })
    const after = (await readTopic(t.id))!
    expect(after.messages).toHaveLength(TOPIC_MESSAGES_MAX)
    expect(after.messages[0].text).toBe('m5')
    expect(after.droppedMessages).toBe(5)
  })

  it('updateMember sets and removes fields', async () => {
    const t = await writeNewTopic(blank('Members'))
    await updateMember(t.id, 'mb-00000001', { pendingTurn: { sessionId: 's1', since: '2026-11-20T10:00:00.000Z', messageId: 'tpm-000000000001' }, mail: { lastSentAt: 'x' } })
    expect((await readTopic(t.id))!.members[0]).toMatchObject({ pendingTurn: { sessionId: 's1' }, mail: { lastSentAt: 'x' } })
    await updateMember(t.id, 'mb-00000001', { pendingTurn: undefined })
    expect((await readTopic(t.id))!.members[0].pendingTurn).toBeUndefined()
    await expect(updateMember(t.id, 'mb-0000ffff', { status: 'left' })).rejects.toMatchObject({ code: 'not_found' })
  })

  it('a follower keeps no topics', async () => {
    const t = await writeNewTopic(blank('Leader only'))
    role.follower = true
    try {
      expect(await listTopics()).toEqual([])
      expect(await readTopic(t.id)).toBeNull()
      await expect(writeNewTopic(blank('Nope'))).rejects.toMatchObject({ code: 'primary_only' })
    } finally {
      role.follower = false
    }
  })
})
