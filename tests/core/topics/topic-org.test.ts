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
import { createTopic, postMessage } from '../../../src/core/topics/topic-post.js'
import { readTopic } from '../../../src/core/topics/topics-store.js'
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
    const t = (await readTopic(topic.id))!
    sent.length = 0
    const hers = await postMessage(topic.id, { author: member(t, 'Marina').id, text: '@CEO the venue sent the contract.', via: 'agent' })
    expect(hers.delivery.wake).toEqual([member(t, 'CEO').id])
    expect(sent).toEqual(['s-main'])
  })
})
