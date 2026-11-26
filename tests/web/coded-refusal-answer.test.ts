/**
 * A refusal that carries its own status and code is answered by them on every route, never as a
 * 500 `internal` (src/lib/coded-refusal.ts, src/web/middleware/coded-refusal-answer.ts).
 *
 * 2026-11-26: a task update whose description broke a sync plugin's content rule went through
 * the v1 router's funnel as "api-v1 unhandled error", 500 internal. The funnels and the route
 * wrappers are enumerated from the source in tests/web/link-failure-answer.test.ts (each hands
 * the error on or calls sendOwnAnswer); this file checks the answer itself, and keeps a bare
 * `throw new Error` out of the route files.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import express, { Router, type NextFunction, type Request, type Response } from 'express'
import request from 'supertest'

import { refusal } from '../../src/lib/coded-refusal.js'
import { errorHandler } from '../../src/web/middleware/error-handler.js'
import { requestLogger, _resetRouteHealthForTest } from '../../src/web/middleware/request-logger.js'
import { handsToAppErrorHandler } from '../../src/web/middleware/link-failure-answer.js'
import { sendOwnAnswer } from '../../src/web/middleware/coded-refusal-answer.js'
import { setErrorNotificationSink } from '../../src/logging/subsystem.js'

const ROOT = path.resolve(__dirname, '../..')

let cards: Array<{ message: string }> = []
beforeEach(() => {
  cards = []
  setErrorNotificationSink((payload) => { cards.push(payload as { message: string }) })
})
afterEach(() => {
  setErrorNotificationSink(null)
  _resetRouteHealthForTest()
})

/** A v1 router with the funnel every v1 router ends in, a wrapper that answers its own 500, and the app handler. */
function app() {
  const server = express()
  server.use(requestLogger)
  const rule = () => refusal('content_rule', 'Titles are in English here', 422)
  const v1 = Router()
  v1.patch('/tasks/:id', (_req, _res, next) => { next(rule()) })
  v1.get('/broken', (_req, _res, next) => { next(new Error('a real bug')) })
  v1.get('/wrapped', (req, res) => {
    const err = rule()
    if (sendOwnAnswer(req, res, err)) return
    res.status(500).json({ error: { code: 'internal', message: err.message } })
  })
  v1.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (handsToAppErrorHandler(err) && !res.headersSent) { next(err); return }
    res.status(500).json({ error: { code: 'internal', message: err instanceof Error ? err.message : String(err) } })
  })
  server.use('/api/v1', v1)
  server.patch('/api/tasks/:id', (_req, _res, next) => { next(rule()) })
  server.get('/api/gone', (_req, _res, next) => { next(refusal('not_supported_cloud', 'Not on a replica', 501)) })
  server.use(errorHandler)
  return server
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

describe('a coded refusal is answered by its own status and code', () => {
  it('through a v1 router\'s funnel: the frozen error shape, no card', async () => {
    const res = await request(app()).patch('/api/v1/tasks/t1')
    expect(res.status).toBe(422)
    expect(res.body).toEqual({ error: { code: 'content_rule', message: 'Titles are in English here' } })
    await settle()
    expect(cards).toEqual([])
  })

  it('through a route outside v1: the message with its code beside it', async () => {
    const res = await request(app()).patch('/api/tasks/t1')
    expect(res.status).toBe(422)
    expect(res.body).toEqual({ error: 'Titles are in English here', code: 'content_rule' })
  })

  it('from a wrapper that answers a caught error itself', async () => {
    const res = await request(app()).get('/api/v1/wrapped')
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('content_rule')
  })

  it('a 501 this box does not do by design keeps its code', async () => {
    const res = await request(app()).get('/api/gone')
    expect(res.status).toBe(501)
    expect(res.body).toEqual({ error: 'Not on a replica', code: 'not_supported_cloud' })
  })

  it('an error with no code is still the funnel\'s 500', async () => {
    const res = await request(app()).get('/api/v1/broken')
    expect(res.status).toBe(500)
    expect(res.body.error.code).toBe('internal')
  })
})

describe('ratchet: a route file throws no bare Error for something the caller can fix', () => {
  // A bare `throw new Error` (or one passed to next or reject) that reaches a funnel is a 500. What a route refuses is answered
  // there (res.status) or thrown with its status and code. The ones left, by file, with why each
  // never reaches a funnel as a refusal: a new one fails this test until it is coded or listed.
  const BARE: Record<string, [number, string]> = {
    'auth-rpc.ts': [2, 'socket RPC: its reply carries words only'],
    'backup-encrypted.ts': [1, 'a connect that failed: caught there and settled as its outcome'],
    'browser-logs.ts': [1, 'socket RPC: its reply carries words only'],
    'chat.ts': [1, 'a turn that failed, inside the turn\'s own stream'],
    'config.ts': [2, 'a model list that did not load: caught there, answered as an empty list'],
    'cloud-setup.ts': [1, 'a detection that ran out of time: a fault'],
    'engines.ts': [1, 'caught three lines below and answered 409'],
    'file-content-bridge-media.ts': [1, 'a relay that ran out of time: a fault'],
    'git-bundle-push.ts': [2, 'a git child process that failed or ran out of time: a fault'],
    'leader-switch.ts': [2, 'a deadline that ran out: a fault of the copy link'],
    'plugin-jobs-routes.ts': [1, 'caught in its route and answered by statusOf'],
    'plugin-runtime.ts': [3, 'caught in its route and answered by the plugin runtime\'s own status map'],
    'secrets-v1.ts': [1, 'a secret that could not be saved: a fault, in plain words'],
    'session-chat.ts': [26, 'socket RPC: its reply carries words only'],
    'session-transcript-relay.ts': [2, 'the bridge\'s relay handler: answered to the companion in words'],
    'sessions.ts': [2, 'an execution session that did not start: a fault'],
    'slash-commands.ts': [1, 'a host the config does not name: caught by its route'],
  }

  it('each route file holds exactly the listed ones', () => {
    const dir = path.join(ROOT, 'src/web/routes')
    const found: Record<string, number> = {}
    for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
      const n = [...fs.readFileSync(path.join(dir, name), 'utf8').matchAll(/(?:throw |next\(|reject\()(?:new )?Error\(/g)].length
      if (n) found[name] = n
    }
    expect(found).toEqual(Object.fromEntries(Object.entries(BARE).map(([file, [n]]) => [file, n])))
  })
})
