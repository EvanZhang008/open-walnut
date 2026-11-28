/**
 * A script's words never reach a session as the user's, in any local proof mode.
 *
 * 2026-11-28 02:21 UTC: the deep test's notice ("The deep test passes on main ...") was sent by a
 * script through `walnut tools call task_send` with the CLI's automation mark
 * (`x-walnut-caller-kind: automation`, lib/cli-sender.ts), and was stored as `sentBy: "person"`.
 * messages-v1.ts had come to read the mark only through callerSidOrOutside, which keeps the old
 * reading (no session id = the person) outside enforce, so in observe (the person's install) and off
 * (every test server) a marked script was the person. The mark is the caller's own word about itself
 * and counts in every mode (person-caller.ts callerMarkedNotPerson).
 *
 * Guarded two ways: every route that puts words into a session, enumerated from the source, names
 * how it reads its sender (a new route fails until it is registered here); and the shared readers and
 * the send route, in off, observe and enforce, never take a marked caller for the person.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-automation-send-never-person'))

const performSessionSendMock = vi.fn()
vi.mock('../../../src/core/sessions/session-send-core.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../../src/core/sessions/session-send-core.js')>()
  return { ...orig, performSessionSend: (...args: unknown[]) => performSessionSendMock(...args) }
})

import path from 'node:path'
import express from 'express'
import request from 'supertest'
import { ROOT, SRC, walk } from '../../helpers/send-call-sites.js'
import { routeSource, startRouteSource } from '../../../src/core/sessions/send-sent-by.js'
import { callerMarkedNotPerson } from '../../../src/web/routes/person-caller.js'
import { OUTSIDE_CALLER_SID, wordsCallerSid } from '../../../src/web/routes/changed-by.js'
import { setLocalProofModeForTest, type LocalProofMode } from '../../../src/web/routes/local-person-proof.js'
import { messagesV1Router } from '../../../src/web/routes/messages-v1.js'
import { errorHandler } from '../../../src/web/middleware/error-handler.js'

const MODES: LocalProofMode[] = ['off', 'observe', 'enforce']
/** Exactly what the `walnut` CLI sends for a call with no session and no terminal (ops/executor.ts). */
const SCRIPT = { 'user-agent': 'Bun/1.4.4', 'x-walnut-op-call': '1', 'x-walnut-caller-kind': 'automation', 'x-walnut-sender': 'script' }
const LOOPBACK = { remoteAddress: '127.0.0.1', localPort: 3456 }
const req = (headers: Record<string, string>) => ({ headers: { host: 'localhost:3456', ...headers }, socket: LOOPBACK, url: '/api/v1/messages', method: 'POST' })

/**
 * Every call in a route file that puts words into a session or into the person's name: a send, a
 * start, a lane, a letter's answer, a Send now (comments stripped, as only code decides).
 */
const ENTRY = /\b(sendMessageToSession|deliverToSession|enqueueMessage|startSessionForTask|quickStartSession|continueTaskConversation|performSessionSend|performMobileLaunch|getOrCreateLaneSession|answerLetterAndDeliver|answerLetterOnThread|sendQueuedNow)\(|sessionRunner\.startSession\(|bus\.emit\(EventNames\.SESSION_START\b/g
const code = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
const entryCalls = (text: string) => [...text.matchAll(ENTRY)].filter((m) => !/function\s+$/.test(text.slice(Math.max(0, m.index! - 12), m.index))).length

/**
 * Each route file with such calls: how many, and how it reads who sent them (`reads`, every pattern
 * must be in its code). A new call, in a new file or a listed one, fails until it is checked and its
 * count and reader written here.
 */
const ROUTE_SENDERS: Record<string, { calls: number; reads: RegExp[]; why: string }> = {
  'src/web/routes/messages-v1.ts': { calls: 2, reads: [/wordsCallerSid\(req\) === OUTSIDE_CALLER_SID/, /const callerSid = wordsCallerSid\(req\)/], why: 'task_send / session_send and Send now: wordsCallerSid, every mode' },
  'src/web/routes/human-inbox-v1.ts': { calls: 1, reads: [/const answererSid = wordsCallerSid\b/], why: 'a letter\'s answer, reply or settle: wordsCallerSid' },
  'src/web/routes/session-send-v1.ts': { calls: 2, reads: [/sentThread && record\.taskId && routeSource\('mobile', req\) === 'mobile'/, /source: routeSource\('mobile', req\)/], why: 'the phone and HTTP send, and a letter answered from it: routeSource' },
  'src/web/routes/quick-input-v1.ts': { calls: 4, reads: [/routeSource\('ui', req\)/, /startRouteSource\('quick-input', req\)/, /startRouteSource\('api-v1', req\)/], why: 'quick input: routeSource and startRouteSource' },
  'src/web/routes/sessions.ts': { calls: 2, reads: [/source: startRouteSource\('quick-start', req\)/, /attributionSource: 'execute-plan:framed-message'/], why: 'quick start: startRouteSource; a plan\'s execution: framed' },
  'src/web/routes/task-v1.ts': { calls: 1, reads: [/startRouteSource\('api-v1', req\)/], why: 'task_start: startRouteSource' },
  'src/web/routes/session-launch-v1.ts': { calls: 2, reads: [/startRouteSource\('cloud-exec-launch', req\)/, /startRouteSource\('mobile-launch', req\)/], why: 'mobile and cloud launches: startRouteSource' },
  'src/web/routes/session-chat.ts': {
    calls: 5,
    reads: [/rpcCallerIsPerson\(\) \? \{\} : \{ callerSid: OUTSIDE_CALLER_SID \}/, /rpcCallerIsPerson\(\) \? attributedUnlessAutomated/, /const source = person \? 'ui' : 'api-agent'/, /if \(person && sentThread/, /source: person \? 'web-ui-retry' : 'peer'/],
    why: 'the socket: the upgrade\'s person rule (ws/rpc-caller.ts) on start, continue, send, a letter\'s answer and a retry',
  },
  'src/web/routes/triage-rules-v1.ts': { calls: 2, reads: [/source: 'api-agent',\s*callerLabel: 'Inbox Triage routing rule'/, /message: text, source: 'api-agent'/], why: 'a routed item: a fixed non-person source' },
  'src/web/routes/notifications.ts': { calls: 1, reads: [/source: 'notification-fix'/], why: 'a notification fix: a fixed non-person source' },
  'src/web/routes/conversations.ts': { calls: 1, reads: [/getOrCreateLaneSession\(agentId, cid\)/], why: 'makes a lane; puts no words in it' },
  'src/web/routes/chat-turn-relay.ts': { calls: 1, reads: [/getOrCreateLaneSession\(agentId, conversationId\)/], why: 'makes a lane; puts no words in it' },
  'src/web/routes/personal-ai-v1.ts': { calls: 1, reads: [/getOrCreateLaneSession\(ids\.agentId, ids\.conversationId\)/], why: 'makes a lane; puts no words in it' },
}

describe('every route that puts words into a session names how it reads the sender (ratchet)', () => {
  const found: Record<string, number> = {}
  for (const f of walk(path.join(SRC, 'web'))) {
    const rel = path.relative(ROOT, f)
    const n = entryCalls(code(rel))
    if (n) found[rel] = n
  }
  it('the list matches the source, call for call', () => {
    const listed = Object.fromEntries(Object.entries(ROUTE_SENDERS).map(([f, e]) => [f, e.calls]))
    expect(found, 'a route with a new send, start, letter answer or Send now: check how it reads its sender, then register it in ROUTE_SENDERS').toEqual(listed)
  })
  for (const [file, { reads, why }] of Object.entries(ROUTE_SENDERS)) {
    it(`${file}: ${why}`, () => {
      const text = code(file)
      for (const r of reads) expect(text).toMatch(r)
    })
  }
})

describe('a marked script is never the person, in every proof mode', () => {
  afterEach(() => setLocalProofModeForTest('off'))
  for (const mode of MODES) {
    it(`${mode}: the shared readers`, () => {
      setLocalProofModeForTest(mode)
      expect(callerMarkedNotPerson(req(SCRIPT))).toBe(true)
      expect(callerMarkedNotPerson(req({ ...SCRIPT, 'x-walnut-caller-kind': 'cron-job' }))).toBe(true)
      // A forged person kind proves nothing (isPersonCaller reads any kind the same way).
      expect(callerMarkedNotPerson(req({ 'x-walnut-caller-kind': 'person' }))).toBe(true)
      expect(callerMarkedNotPerson(req({ 'x-walnut-caller-sid': 'sess-1' }))).toBe(true)
      expect(callerMarkedNotPerson(req({ 'sec-fetch-site': 'same-origin' }))).toBe(false)
      expect(wordsCallerSid(req(SCRIPT))).toBe(OUTSIDE_CALLER_SID)
      expect(wordsCallerSid(req({ 'x-walnut-caller-sid': 'sess-1' }))).toBe('sess-1')
      expect(wordsCallerSid(req({ 'sec-fetch-site': 'same-origin' }))).toBeUndefined()
      expect(routeSource('ui', req(SCRIPT))).toBe('api-agent')
      expect(startRouteSource('api-v1', req(SCRIPT))).toBe('automation:script')
    })
  }
})

describe('POST /api/v1/messages (task_send) from a script', () => {
  const app = () => {
    const a = express()
    a.use(express.json())
    a.use('/api/v1', messagesV1Router)
    a.use(errorHandler)
    return a
  }
  beforeEach(() => {
    performSessionSendMock.mockReset()
    performSessionSendMock.mockResolvedValue({ delivery: 'queued', targetSessionId: 'sess-target-1', targetTaskId: 'task-77', messageId: 'qm-1' })
  })
  afterEach(() => setLocalProofModeForTest('off'))

  for (const mode of MODES) {
    it(`${mode}: sends as the automation that names itself, never as the user`, async () => {
      setLocalProofModeForTest(mode)
      const text = 'The deep test passes on main 199bb2cbde. It is the deep-green commit now.'
      let r = request(app()).post('/api/v1/messages')
      for (const [k, v] of Object.entries({ ...SCRIPT, 'x-walnut-sender': 'deep-test' })) r = r.set(k, v)
      expect((await r.send({ to: 'task-77', title: 'Deep test passes again', text, expect_reply: false })).status).toBe(202)
      expect(performSessionSendMock.mock.calls[0]![0]).toMatchObject({ callerSid: 'external', callerLabel: 'deep-test' })
    })
  }

  it('the person\'s own browser still sends as the person, and a session as itself', async () => {
    setLocalProofModeForTest('observe')
    await request(app()).post('/api/v1/messages').set('sec-fetch-site', 'same-origin').send({ to: 'task-77', text: 'Mine.' }).expect(202)
    expect(performSessionSendMock.mock.calls[0]![0].callerSid).toBeUndefined()
    await request(app()).post('/api/v1/messages').set('x-walnut-caller-sid', 'sess-9').send({ to: 'task-77', text: 'A peer.' }).expect(202)
    expect(performSessionSendMock.mock.calls[1]![0]).toMatchObject({ callerSid: 'sess-9' })
    expect(performSessionSendMock.mock.calls[1]![0].callerLabel).toBeUndefined()
  })
})
