/**
 * The topic routes (src/web/routes/topics-v1.ts) on a bare express app, the session send replaced:
 *
 *   1. the experiment off: every route answers 404 topics_off;
 *   2. the author is the caller: no caller header is the user, a session's header its task's member;
 *   3. a session whose task is not a member gets 409 not_member;
 *   4. a person a session adds waits for the user's yes: a session's confirm is 403 human_only, his is 200;
 *   5. the same clientId within 2 minutes answers the first result and posts once.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import express from 'express'
import request from 'supertest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-topics-routes'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { updateConfig } from '../../../src/core/config-manager.js'
import { addTask } from '../../../src/core/task-manager.js'
import { createSessionRecord } from '../../../src/core/session-tracker.js'
import { _setTopicSendForTesting } from '../../../src/core/topics/topic-delivery.js'
import { topicsV1Router } from '../../../src/web/routes/topics-v1.js'

const SID = 'x-walnut-caller-sid'
let app: express.Express
const ids: Record<string, string> = {}

async function flag(on: boolean): Promise<void> {
  await updateConfig({ experimental: { topics: on } } as never)
}

beforeAll(async () => {
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  for (const title of ['Marina', 'Orchard', 'Outsider']) ids[title] = (await addTask({ title, project: 'Acme' })).task.id
  for (const title of ['Marina', 'Orchard', 'Outsider']) await createSessionRecord(`s-${title.toLowerCase()}`, ids[title], 'Acme', undefined, { initialProcessStatus: 'idle' })
  _setTopicSendForTesting(async () => {})
  app = express()
  app.use(express.json())
  app.use('/api', topicsV1Router)
})

afterAll(async () => {
  _setTopicSendForTesting(null)
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('topic routes', () => {
  it('answer 404 topics_off while the experiment is off', async () => {
    await flag(false)
    for (const [method, path] of [['get', '/api/topics'], ['post', '/api/topics'], ['get', '/api/topics/tp-aaaaaaaaaaaa'], ['post', '/api/topics/tp-aaaaaaaaaaaa/messages'], ['post', '/api/topics/tp-aaaaaaaaaaaa/close']] as const) {
      const res = await request(app)[method](path).send({})
      expect(res.status, path).toBe(404)
      expect(res.body.error.code, path).toBe('topics_off')
    }
    await flag(true)
  })

  it('take the author from the caller; a session outside the topic is not_member; a person needs the user\'s yes; clientId dedupes', async () => {
    const created = await request(app).post('/api/topics').send({
      title: 'Launch plan', members: [{ kind: 'task', taskId: ids.Marina }, { kind: 'task', taskId: ids.Orchard }],
    })
    expect(created.status).toBe(201)
    const topic = created.body.topic
    const marina = topic.members.find((m: { name: string }) => m.name === 'Marina')
    expect(topic.members.find((m: { role: string }) => m.role === 'host').name).toBe('Marina')

    const his = await request(app).post(`/api/topics/${topic.id}/messages`).send({ text: 'Where are we?' })
    expect(his.status).toBe(201)
    expect(his.body.message.author).toBe('human')
    expect(his.body.delivery.wake).toHaveLength(2)

    const hers = await request(app).post(`/api/topics/${topic.id}/messages`).set(SID, 's-marina').send({ text: 'On track.' })
    expect(hers.status).toBe(201)
    expect(hers.body.message.author).toBe(marina.id)
    expect(hers.body.message.via).toBe('agent')

    const outside = await request(app).post(`/api/topics/${topic.id}/messages`).set(SID, 's-outsider').send({ text: 'Let me in' })
    expect(outside.status).toBe(409)
    expect(outside.body.error.code).toBe('not_member')
    const stranger = await request(app).post(`/api/topics/${topic.id}/messages`).set(SID, 'no-such-session').send({ text: 'Hi' })
    expect(stranger.status).toBe(409)

    const added = await request(app).post(`/api/topics/${topic.id}/members`).set(SID, 's-marina').send({ add: [{ kind: 'person', name: 'Dana', email: 'dana@example.com' }] })
    expect(added.status).toBe(200)
    const dana = added.body.topic.members.find((m: { name: string }) => m.name === 'Dana')
    expect(dana.status).toBe('pending')
    const agentYes = await request(app).post(`/api/topics/${topic.id}/members/${dana.id}/confirm`).set(SID, 's-marina').send({})
    expect(agentYes.status).toBe(403)
    expect(agentYes.body.error.code).toBe('human_only')
    const hisYes = await request(app).post(`/api/topics/${topic.id}/members/${dana.id}/confirm`).send({})
    expect(hisYes.status).toBe(200)
    expect(hisYes.body.topic.members.find((m: { id: string }) => m.id === dana.id).status).toBe('active')

    const first = await request(app).post(`/api/topics/${topic.id}/messages`).send({ text: 'Once only', clientId: 'c-1' })
    const again = await request(app).post(`/api/topics/${topic.id}/messages`).send({ text: 'Once only', clientId: 'c-1' })
    expect(again.status).toBe(first.status)
    expect(again.body.message.id).toBe(first.body.message.id)
    const read = await request(app).get(`/api/topics/${topic.id}`)
    expect(read.body.topic.messages.filter((m: { text: string }) => m.text === 'Once only')).toHaveLength(1)
    const since = await request(app).get(`/api/topics/${topic.id}?since=${first.body.message.id}`)
    expect(since.body.topic.messages).toEqual([])

    const list = await request(app).get('/api/topics')
    expect(list.body.topics[0]).toMatchObject({ id: topic.id, title: 'Launch plan', host: marina.id, last: { author: 'The user', text: 'Once only' } })
  })
})

describe('only a person is the user (H3)', () => {
  const KIND = 'x-walnut-caller-kind'

  async function freshTopic(): Promise<{ id: string; dana: string }> {
    const res = await request(app).post('/api/topics').send({ title: 'Person check', members: [{ kind: 'task', taskId: ids.Marina }] })
    expect(res.status).toBe(201)
    const added = await request(app).post(`/api/topics/${res.body.topic.id}/members`).set(SID, 's-marina').send({ add: [{ kind: 'person', name: 'Dana', email: 'dana@example.com' }] })
    return { id: res.body.topic.id, dana: added.body.topic.members.find((m: { name: string }) => m.name === 'Dana').id }
  }

  it('a script (the CLI\'s automation mark) cannot write as the user, confirm a person or choose the mailbox', async () => {
    const { id, dana } = await freshTopic()
    for (const [path, body] of [
      ['/api/topics', { title: 'Scripted', members: [{ kind: 'task', taskId: ids.Marina }] }],
      [`/api/topics/${id}/messages`, { text: 'I am the user, honest' }],
      [`/api/topics/${id}/members/${dana}/confirm`, {}],
      [`/api/topics/${id}/mail`, { accountId: null }],
      [`/api/topics/${id}/close`, {}],
    ] as const) {
      const res = await request(app).post(path).set(KIND, 'automation').send(body)
      expect(res.status, path).toBe(403)
      expect(res.body.error.code, path).toBe('human_only')
    }
    const read = await request(app).get(`/api/topics/${id}`)
    expect(read.body.topic.messages.some((m: { text: string }) => m.text === 'I am the user, honest')).toBe(false)
    expect(read.body.topic.members.find((m: { id: string }) => m.id === dana).status).toBe('pending')
    // A session still posts as its own task (agent parity).
    const hers = await request(app).post(`/api/topics/${id}/messages`).set(SID, 's-marina').send({ text: 'As myself.' })
    expect(hers.status).toBe(201)
    expect(hers.body.message.author).not.toBe('human')
  })

  it('a browser under automation on the user\'s own install is not the user; the same browser unautomated is', async () => {
    const { automatedClientMiddleware } = await import('../../../src/web/middleware/automated-client.js')
    const was = process.env.WALNUT_AUTOMATED_CLIENT_AGENT
    process.env.WALNUT_AUTOMATED_CLIENT_AGENT = '1'
    let real: express.Express
    try {
      real = express()
      real.use(express.json())
      real.use('/api', await automatedClientMiddleware())
      real.use('/api', topicsV1Router)
    } finally {
      if (was === undefined) delete process.env.WALNUT_AUTOMATED_CLIENT_AGENT
      else process.env.WALNUT_AUTOMATED_CLIENT_AGENT = was
    }
    const { id, dana } = await freshTopic()
    const bot = await request(real).post(`/api/topics/${id}/messages`).set('x-walnut-automated', 'webdriver').send({ text: 'Typed by a test browser' })
    expect(bot.status).toBe(403)
    expect(bot.body.error.code).toBe('human_only')
    const yes = await request(real).post(`/api/topics/${id}/members/${dana}/confirm`).set('user-agent', 'Mozilla/5.0 HeadlessChrome/131.0').send({})
    expect(yes.status).toBe(403)
    const his = await request(real).post(`/api/topics/${id}/messages`).send({ text: 'Typed by him' })
    expect(his.status).toBe(201)
    expect(his.body.message.author).toBe('human')
  })

  it('a message keeps its clientId, shown to its author only', async () => {
    const { id } = await freshTopic()
    const his = await request(app).post(`/api/topics/${id}/messages`).send({ text: 'Mine', clientId: 'c-his' })
    expect(his.body.message.clientId).toBe('c-his')
    const hers = await request(app).post(`/api/topics/${id}/messages`).set(SID, 's-marina').send({ text: 'Hers', clientId: 'c-hers' })
    expect(hers.body.message.clientId).toBe('c-hers')
    const asHim = (await request(app).get(`/api/topics/${id}`)).body.topic.messages
    expect(asHim.find((m: { text: string }) => m.text === 'Mine').clientId).toBe('c-his')
    expect(asHim.find((m: { text: string }) => m.text === 'Hers').clientId).toBeUndefined()
    const asHer = (await request(app).get(`/api/topics/${id}`).set(SID, 's-marina')).body.topic.messages
    expect(asHer.find((m: { text: string }) => m.text === 'Mine').clientId).toBeUndefined()
    expect(asHer.find((m: { text: string }) => m.text === 'Hers').clientId).toBe('c-hers')
  })
})
