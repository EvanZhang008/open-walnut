/**
 * Choosing the mailbox a topic emails from (POST /api/topics/:id/mail, topic-post.ts
 * chooseTopicMail) on a bare express app, the mail plugin replaced by a fake transport:
 *
 *   1. GET /api/topics/mail-accounts lists the plugin's accounts; with no plugin, none and available false;
 *   2. a session caller is refused 403 human_only: the mail goes out in the user's name;
 *   3. an unknown account is 400, one that cannot send 409 cannot_send, no plugin 503;
 *   4. his choice of a send-capable account is kept (with everyMinutes) and said by one Walnut line;
 *      null takes it off again.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import express from 'express'
import request from 'supertest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-topic-mail-choice'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { updateConfig } from '../../../src/core/config-manager.js'
import { addTask } from '../../../src/core/task-manager.js'
import { createSessionRecord } from '../../../src/core/session-tracker.js'
import { _setTopicSendForTesting } from '../../../src/core/topics/topic-delivery.js'
import { registerTopicMailTransport, type TopicMailTransport } from '../../../src/core/topics/topic-mail-port.js'
import { topicsV1Router } from '../../../src/web/routes/topics-v1.js'

const SID = 'x-walnut-caller-sid'
let app: express.Express
let topicId = ''
let unregister: (() => void) | null = null

const transport: TopicMailTransport = {
  accounts: async () => [
    { accountId: 'acct-work', address: 'robin@example.com', canSend: true },
    { accountId: 'acct-feed', address: 'feed@example.com', canSend: false },
  ],
  send: async () => { throw new Error('no mail in this test') },
  sendState: async (draftId) => ({ draftId, state: 'discarded' }),
  drop: async () => {},
  bodyText: async () => '',
  handBack: async () => {},
}

beforeAll(async () => {
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  await updateConfig({ experimental: { topics: true } } as never)
  const marina = (await addTask({ title: 'Marina', project: 'Acme' })).task.id
  await createSessionRecord('s-marina', marina, 'Acme', undefined, { initialProcessStatus: 'idle' })
  _setTopicSendForTesting(async () => {})
  app = express()
  app.use(express.json())
  app.use('/api', topicsV1Router)
  const made = await request(app).post('/api/topics').send({
    title: 'Venue', members: [{ kind: 'task', taskId: marina }, { kind: 'person', name: 'Dana', email: 'dana@example.com' }],
  })
  expect(made.status).toBe(201)
  topicId = made.body.topic.id
})

afterAll(async () => {
  unregister?.()
  _setTopicSendForTesting(null)
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('the mailbox a topic emails from', () => {
  it('with no mail plugin: no accounts to list, and a choice is refused 503', async () => {
    const list = await request(app).get('/api/topics/mail-accounts')
    expect(list.status).toBe(200)
    expect(list.body).toEqual({ accounts: [], available: false })
    const res = await request(app).post(`/api/topics/${topicId}/mail`).send({ accountId: 'acct-work' })
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('mail_unavailable')
  })

  it('lists the plugin\'s accounts; a session may not choose; a wrong or send-less account is refused', async () => {
    unregister = registerTopicMailTransport(transport)
    const list = await request(app).get('/api/topics/mail-accounts')
    expect(list.body.available).toBe(true)
    expect(list.body.accounts.map((a: { accountId: string }) => a.accountId)).toEqual(['acct-work', 'acct-feed'])

    const agent = await request(app).post(`/api/topics/${topicId}/mail`).set(SID, 's-marina').send({ accountId: 'acct-work' })
    expect(agent.status).toBe(403)
    expect(agent.body.error.code).toBe('human_only')

    const unknown = await request(app).post(`/api/topics/${topicId}/mail`).send({ accountId: 'acct-gone' })
    expect(unknown.status).toBe(400)
    const sendless = await request(app).post(`/api/topics/${topicId}/mail`).send({ accountId: 'acct-feed' })
    expect(sendless.status).toBe(409)
    expect(sendless.body.error.code).toBe('cannot_send')
    const badEvery = await request(app).post(`/api/topics/${topicId}/mail`).send({ accountId: 'acct-work', everyMinutes: 0 })
    expect(badEvery.status).toBe(400)
    const badId = await request(app).post(`/api/topics/${topicId}/mail`).send({ accountId: 42 })
    expect(badId.status).toBe(400)

    const topic = (await request(app).get(`/api/topics/${topicId}`)).body.topic
    expect(topic.mail.accountId).toBeUndefined()
  })

  it('keeps his choice and says so once; null takes it off', async () => {
    const res = await request(app).post(`/api/topics/${topicId}/mail`).send({ accountId: 'acct-work', everyMinutes: 30 })
    expect(res.status).toBe(200)
    expect(res.body.topic.mail).toEqual({ accountId: 'acct-work', everyMinutes: 30 })
    const again = await request(app).post(`/api/topics/${topicId}/mail`).send({ accountId: 'acct-work' })
    expect(again.body.topic.mail).toEqual({ accountId: 'acct-work', everyMinutes: 30 })
    const lines = again.body.topic.messages.filter((m: { author: string }) => m.author === 'walnut').map((m: { text: string }) => m.text)
    expect(lines.filter((t: string) => t.includes('robin@example.com'))).toEqual(['Email to this topic\'s people now goes out from robin@example.com.'])

    const off = await request(app).post(`/api/topics/${topicId}/mail`).send({ accountId: null })
    expect(off.status).toBe(200)
    expect(off.body.topic.mail).toEqual({ everyMinutes: 30 })
    expect(off.body.topic.messages.at(-1).text).toBe('No mailbox is chosen: nothing is emailed.')
  })
})
