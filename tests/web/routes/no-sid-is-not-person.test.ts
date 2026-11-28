/**
 * A request that names no session is the person only by the one rule (src/web/routes/person-caller.ts
 * isPersonCaller), never by the missing sid alone (2026-11-28 review). With the local proof enforced,
 * a plain local process (a session's own `curl localhost:3456`, no headers) is an outside caller: its
 * send is an agent's, its Board post is an agent's, its message is no person's word. A request with a
 * proof of the person's client (a browser's fetch metadata) stays the person, and with the proof off
 * (every test server's default) the old rule holds. The ratchet over the source is
 * no-sid-is-not-person-ratchet.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-no-sid-not-person'))

const performSessionSendMock = vi.fn()
vi.mock('../../../src/core/sessions/session-send-core.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../src/core/sessions/session-send-core.js')>()
  return { ...orig, performSessionSend: (...args: unknown[]) => performSessionSendMock(...args) }
})

import express from 'express'
import request from 'supertest'
import { WALNUT_HOME } from '../../../src/constants.js'
import { routeSource, startRouteSource } from '../../../src/core/sessions/send-sent-by.js'
import { requestCaller } from '../../../src/core/sessions/request-caller.js'
import { callerSidOrOutside, changedBy, OUTSIDE_CALLER_SID } from '../../../src/web/routes/changed-by.js'
import { setLocalProofModeForTest } from '../../../src/web/routes/local-person-proof.js'
import { messagesV1Router } from '../../../src/web/routes/messages-v1.js'
import { boardV1Router } from '../../../src/web/routes/board-v1.js'
import { errorHandler } from '../../../src/web/middleware/error-handler.js'
import { addTask } from '../../../src/core/task-manager.js'
import type { Request } from 'express'

const LOOPBACK = { remoteAddress: '127.0.0.1', localPort: 3456 }
const HOST = { host: 'localhost:3456' }
const CURL = { ...HOST, 'user-agent': 'curl/8.7.1' }
const BROWSER = { ...HOST, 'sec-fetch-site': 'same-origin' }
const req = (headers: Record<string, string>) => ({ headers, socket: LOOPBACK, url: '/api/v1/sessions/s/send', method: 'POST' })

afterEach(() => setLocalProofModeForTest('off'))

describe('the shared readers, with the local proof enforced', () => {
  beforeEach(() => setLocalProofModeForTest('enforce'))

  it('a plain local process is an outside caller; the person\'s browser and a session keep their own', () => {
    expect(callerSidOrOutside(req(CURL))).toBe(OUTSIDE_CALLER_SID)
    expect(callerSidOrOutside(req({ ...CURL, 'x-walnut-caller-kind': 'automation' }))).toBe(OUTSIDE_CALLER_SID)
    expect(callerSidOrOutside(req(BROWSER))).toBeUndefined()
    expect(callerSidOrOutside(req({ ...CURL, 'x-walnut-caller-sid': ' sess-1 ' }))).toBe('sess-1')
    expect(requestCaller(req(CURL))).toMatchObject({ callerSid: OUTSIDE_CALLER_SID, outside: true })
    expect(requestCaller(req(BROWSER))).toEqual({})
    expect(requestCaller(req({ 'x-walnut-caller-sid': 'sess-1' }))).toEqual({ callerSid: 'sess-1' })
  })

  it('routeSource and startRouteSource give the person\'s source only to the person', () => {
    expect(routeSource('mobile', req(CURL))).toBe('api-agent')
    expect(routeSource('mobile', req(BROWSER))).toBe('mobile')
    expect(startRouteSource('quick-start', req(CURL))).toBe('automation:script')
    expect(startRouteSource('quick-start', req({ ...CURL, 'x-walnut-sender': 'nightly' }))).toBe('automation:nightly')
    expect(startRouteSource('quick-start', req(BROWSER))).toBe('quick-start')
    // A forged person kind is no person either: the rule refuses any caller kind.
    expect(startRouteSource('quick-start', req({ ...BROWSER, 'x-walnut-caller-kind': 'person' }))).toBe('automation:script')
  })

  it('changedBy labels the plain process an agent, the browser the person', async () => {
    expect(await changedBy(req(CURL) as unknown as Request)).toBe('agent')
    expect(await changedBy(req(BROWSER) as unknown as Request)).toBe('human')
  })
})

describe('the shared readers outside enforce (off on every test server, observe first on the real install): the old rule', () => {
  for (const mode of ['off', 'observe'] as const) {
    it(`${mode}: a header-less loopback request is still the person, and a script keeps what it had`, () => {
      setLocalProofModeForTest(mode)
      expect(callerSidOrOutside(req(CURL))).toBeUndefined()
      expect(routeSource('ui', req(CURL))).toBe('ui')
      expect(startRouteSource('quick-start', req(CURL))).toBe('quick-start')
      // A script that names itself was never a route's person source, and still is not.
      expect(routeSource('ui', req({ ...CURL, 'x-walnut-caller-kind': 'automation' }))).toBe('api-agent')
      expect(startRouteSource('quick-start', req({ ...CURL, 'x-walnut-caller-kind': 'automation', 'x-walnut-sender': 'nightly' }))).toBe('automation:nightly')
      // A core rule kept reading a script's call as the person's own (a cron's task_start keeps its
      // mode): only enforce changes that (2026-11-28 review), so observe changes nothing.
      expect(callerSidOrOutside(req({ ...CURL, 'x-walnut-caller-kind': 'automation' }))).toBeUndefined()
    })
  }
})

function app() {
  const a = express()
  a.use(express.json())
  a.use('/api/v1', messagesV1Router)
  a.use('/api/v1', boardV1Router)
  a.use(errorHandler)
  return a
}

describe('routes: a request with no session and no proof is not recorded as the person', () => {
  beforeEach(async () => {
    await fs.rm(WALNUT_HOME, { recursive: true, force: true })
    await fs.mkdir(WALNUT_HOME, { recursive: true })
    performSessionSendMock.mockReset()
    performSessionSendMock.mockResolvedValue({
      delivery: 'queued', targetSessionId: 'sess-target-1', targetTitle: 'Target', targetTaskId: 'task-77', requestId: 'rq-0123456789ab', messageId: 'qm-1',
    })
  })
  afterEach(async () => { await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {}) })

  it('POST /messages: the plain process sends as an outside caller; the browser as the person', async () => {
    setLocalProofModeForTest('enforce')
    await request(app()).post('/api/v1/messages').set('user-agent', 'curl/8.7.1').send({ to: 'task-77', text: 'hello' })
    expect(performSessionSendMock.mock.calls[0]![0]).toMatchObject({ callerSid: OUTSIDE_CALLER_SID, callerLabel: 'script' })
    await request(app()).post('/api/v1/messages').set('sec-fetch-site', 'same-origin').send({ to: 'task-77', text: 'hello' })
    expect(performSessionSendMock.mock.calls[1]![0].callerSid).toBeUndefined()
  })

  it('POST /messages with the proof off: a header-less request is the person, as before', async () => {
    await request(app()).post('/api/v1/messages').send({ to: 'task-77', text: 'hello' })
    expect(performSessionSendMock.mock.calls[0]![0].callerSid).toBeUndefined()
  })

  it('a Board thread post: the plain process is an agent (stored only), the browser is the user', async () => {
    const { task } = await addTask({ title: 'Board owner', project: 'acme' })
    await request(app()).put(`/api/v1/tasks/${task.id}/board`).set('sec-fetch-site', 'same-origin')
      .send({ html: '<walnut-thread id="rc-1" title="Root cause"></walnut-thread>' }).expect(200)
    setLocalProofModeForTest('enforce')
    const curl = await request(app()).post(`/api/v1/tasks/${task.id}/board/threads/rc-1`).set('user-agent', 'curl/8.7.1').send({ text: 'not his words' })
    expect(curl.status).toBe(201)
    expect(curl.body).toMatchObject({ message: { author: 'agent' }, delivery: { state: 'stored' } })
    const browser = await request(app()).post(`/api/v1/tasks/${task.id}/board/threads/rc-1`).set('sec-fetch-site', 'same-origin').send({ text: 'his words' })
    expect(browser.status).toBe(201)
    expect(browser.body.message).toMatchObject({ author: 'user', text: 'his words' })
  })
})
