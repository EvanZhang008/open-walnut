/**
 * Topics and the org (src/core/topics/topic-post.ts, topic-delivery.ts), the session send replaced:
 *
 *   1. a topic Main hosts opens its thread on Main out of the user's sight (pending, with a summary
 *      of what the topic is about): his Threads list it only once the host sets a state;
 *   2. with the org switched off (org.enabled false), a member's message never wakes Main (it reads
 *      it next time, refused 'the org is off'), and the user's own message still does.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-topic-org'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { updateConfig } from '../../../src/core/config-manager.js'
import { addTask, updateTaskRaw } from '../../../src/core/task-manager.js'
import { createSessionRecord } from '../../../src/core/session-tracker.js'
import { _resetOrgEnabledForTesting } from '../../../src/core/org/org-enabled.js'
import { patchThread, readThreads } from '../../../src/core/org/threads-store.js'
import { listedForHim } from '../../../src/core/org/thread-view.js'
import { _setTopicSendForTesting, ORG_OFF_WHY } from '../../../src/core/topics/topic-delivery.js'
import { _clearHeldNotices } from '../../../src/core/sessions/held-notices.js'
import { changeMembers, createTopic, postMessage } from '../../../src/core/topics/topic-post.js'
import { topicRules } from '../../../src/core/topics/topic-text.js'
import { mutateTopic, readTopic } from '../../../src/core/topics/topics-store.js'
import type { Topic } from '../../../src/core/topics/topics-model.js'

const sent: string[] = []
const ids: Record<string, string> = {}
let topic: Topic

const member = (t: Topic, name: string) => t.members.find((m) => m.name === name)!

beforeAll(async () => {
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  await updateConfig({ experimental: { topics: true }, user: { name: 'Robin' } } as never)
  ids.main = (await addTask({ title: 'Main', project: 'Acme' })).task.id
  await updateTaskRaw(ids.main, { org_role: 'main' } as never)
  ids.marina = (await addTask({ title: 'Marina', project: 'Acme' })).task.id
  await createSessionRecord('s-main', ids.main, 'Acme', undefined, { initialProcessStatus: 'idle' })
  await createSessionRecord('s-marina', ids.marina, 'Acme', undefined, { initialProcessStatus: 'idle' })
  _setTopicSendForTesting(async (sid) => { sent.push(sid) })
  _clearHeldNotices()
  _resetOrgEnabledForTesting(true)
  topic = (await createTopic({
    title: 'Venue choice',
    members: [{ kind: 'org', node: 'main' }, { kind: 'task', taskId: ids.marina }],
    by: 'human',
  })).topic
})

afterAll(async () => {
  _setTopicSendForTesting(null)
  _resetOrgEnabledForTesting()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('the host thread', () => {
  it('opens pending with a summary, out of his Threads until the host gives it a state', async () => {
    expect(topic.thread?.node).toBe(ids.main)
    const thread = (await readThreads(ids.main)).threads.find((t) => t.id === topic.thread!.threadId)!
    expect(thread.state).toBe('pending')
    expect(thread.reply).toContain('Venue choice')
    expect(thread.reply).toContain('Marina')
    expect(listedForHim([thread])).toEqual([])

    await patchThread(ids.main, thread.id, { state: 'answered', reply: 'The venue is booked for Tuesday.' }, `task:${ids.main}`)
    const shown = (await readThreads(ids.main)).threads.find((t) => t.id === thread.id)!
    expect(listedForHim([shown]).map((t) => t.id)).toEqual([thread.id])
  })
})

describe('the org switched off', () => {
  it('a member\'s message does not wake Main; the user\'s own still does', async () => {
    _resetOrgEnabledForTesting(false)
    try {
      const t = (await readTopic(topic.id))!
      const ceo = member(t, 'CEO')
      sent.length = 0
      const hers = await postMessage(topic.id, { author: member(t, 'Marina').id, text: '@CEO can you sign off the venue?', via: 'agent' })
      expect(hers.message.mentions).toEqual([ceo.id])
      expect(hers.delivery.wake).toEqual([])
      expect(hers.delivery.fold).toContain(ceo.id)
      expect(hers.delivery.refused).toEqual([{ member: ceo.id, why: ORG_OFF_WHY }])
      expect(sent).toEqual([])

      const his = await postMessage(topic.id, { author: 'human', text: '@CEO please sign off the venue.', via: 'ui' })
      expect(his.delivery.wake).toEqual([ceo.id])
      expect(sent).toEqual(['s-main'])
    } finally {
      _resetOrgEnabledForTesting(true)
    }
  })

  it('with the org on, the same member\'s message wakes Main', async () => {
    // The turn the user's message woke has ended (else this wake waits for it: one turn at a time).
    await mutateTopic(topic.id, (one) => { for (const m of one.members) delete m.pendingTurn })
    const t = (await readTopic(topic.id))!
    sent.length = 0
    const hers = await postMessage(topic.id, { author: member(t, 'Marina').id, text: '@CEO the venue sent the contract.', via: 'agent' })
    expect(hers.delivery.wake).toEqual([member(t, 'CEO').id])
    expect(sent).toEqual(['s-main'])
  })
})

describe('one task is one member (L3)', () => {
  it('adding Main\'s own task to a topic Main is in is refused, naming the member it already is', async () => {
    await expect(changeMembers(topic.id, { add: [{ kind: 'task', taskId: ids.main }] }, 'human'))
      .rejects.toMatchObject({ code: 'already_member', status: 409, message: expect.stringContaining('@CEO') })
    await expect(createTopic({ title: 'Twice', members: [{ kind: 'org', node: 'main' }, { kind: 'task', taskId: ids.main }], by: 'human' }))
      .rejects.toMatchObject({ code: 'already_member' })
    expect((await readTopic(topic.id))!.members.filter((m) => m.status !== 'left')).toHaveLength(2)
  })
})

describe('the host and its thread (L2)', () => {
  it('the host is removed only with a new host named; the thread moves to the new host\'s Threads', async () => {
    const t = (await createTopic({ title: 'Catering', members: [{ kind: 'org', node: 'main' }, { kind: 'task', taskId: ids.marina }], by: 'human' })).topic
    const ceo = member(t, 'CEO')
    const marina = member(t, 'Marina')
    expect(ceo.role).toBe('host')
    expect(t.thread?.node).toBe(ids.main)
    await expect(changeMembers(t.id, { remove: [ceo.id] }, 'human')).rejects.toMatchObject({ code: 'host_required', status: 409 })
    expect(member((await readTopic(t.id))!, 'CEO').status).toBe('active')

    // Marina keeps Threads (turned on for her): the thread goes there with the host.
    await updateTaskRaw(ids.marina, { threads_on: true } as never)
    const after = await changeMembers(t.id, { remove: [ceo.id], host: marina.id }, 'human')
    expect(member(after, 'Marina').role).toBe('host')
    expect(member(after, 'CEO')).toMatchObject({ status: 'left', role: 'member' })
    expect(after.thread?.node).toBe(ids.marina)
    expect((await readThreads(ids.marina)).threads.some((x) => x.id === after.thread!.threadId && !x.closed)).toBe(true)
    // Off Main's open Threads: closed there, pointing at Marina (or only a pointer left).
    const left = (await readThreads(ids.main)).threads.find((x) => x.id === t.thread!.threadId)
    expect(!left || !!left.closed || !!left.movedTo).toBe(true)
    expect(after.messages.at(-1)?.text).toContain('@Marina hosts the topic now')
  })

  it('the closing wake tells the host to set its thread to answered with the conclusion', async () => {
    const t = (await readTopic(topic.id))!
    const host = t.members.find((m) => m.role === 'host')!
    const rules = topicRules(t, host, true).join('\n')
    expect(rules).toContain(`set its thread ${t.thread!.threadId} to answered with the topic's conclusion`)
    expect(topicRules(t, member(t, 'Marina'), true).join('\n')).not.toContain('to answered')
  })
})
