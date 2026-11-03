/**
 * A host link failure is answered 503 host_reconnecting, never a 500 card
 * (src/web/middleware/link-failure-answer.ts).
 *
 * 2026-11-03: a clouddev daemon swap and two tunnel drops timed out the panels'
 * `GET /api/sessions/:id/supervision` polls, and each became a 500 and a red
 * "This API endpoint is failing" card. The class is any route whose daemon command
 * fails on the link and reaches an error funnel, so this file pins:
 *   1. every link failure kind (read from the source union) through the real app
 *      error handler + request logger: 503, the code, plain words, no card;
 *   2. every router error funnel under src/web/routes (enumerated from the source)
 *      hands such an error to the app handler before it answers 500 itself.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import express, { type NextFunction, type Request, type Response } from 'express'
import request from 'supertest'

import { markLinkFailure, type LinkFailureKind } from '../../src/providers/link-failure.js'
import { errorHandler } from '../../src/web/middleware/error-handler.js'
import { requestLogger, _resetRouteHealthForTest } from '../../src/web/middleware/request-logger.js'
import { handsToAppErrorHandler, linkFailureAnswer } from '../../src/web/middleware/link-failure-answer.js'
import { setErrorNotificationSink } from '../../src/logging/subsystem.js'

const ROOT = path.resolve(__dirname, '../..')

/** The kinds the union in link-failure.ts names, so a new kind lands in this test by itself. */
function sourceKinds(): LinkFailureKind[] {
  const src = fs.readFileSync(path.join(ROOT, 'src/providers/link-failure.ts'), 'utf8')
  const union = /export type LinkFailureKind = ([^\n]+)/.exec(src)?.[1] ?? ''
  return [...union.matchAll(/'([a-z-]+)'/g)].map((m) => m[1] as LinkFailureKind)
}

let cards: Array<{ message: string }> = []
beforeEach(() => {
  cards = []
  setErrorNotificationSink((payload) => { cards.push(payload as { message: string }) })
})
afterEach(() => {
  setErrorNotificationSink(null)
  _resetRouteHealthForTest()
})

function app(kind: LinkFailureKind) {
  const server = express()
  server.use(requestLogger)
  const fail = (_req: Request, _res: Response, next: NextFunction) => {
    next(markLinkFailure(new Error(`daemon command timeout: cron.supervision (5000ms) [traceId=abc] ${kind}`), kind))
  }
  server.get('/api/sessions/:id/supervision', fail)
  server.get('/api/v1/sessions/:id/thing', fail)
  server.post('/api/v1/sessions/:id/thing', fail)
  server.get('/api/plain', (_req, _res, next) => { next(new Error('a real bug')) })
  server.use(errorHandler)
  return server
}

async function settle(): Promise<void> {
  // The request logger writes on 'finish'; let it run.
  await new Promise((resolve) => setImmediate(resolve))
}

describe('a host link failure through the app error handler', () => {
  const kinds = sourceKinds()

  it('reads every kind from the source', () => {
    expect(kinds).toEqual(expect.arrayContaining(['no-link', 'lost', 'no-answer']))
  })

  it.each(sourceKinds())('%s answers 503 host_reconnecting in plain words and makes no card', async (kind) => {
    const web = await request(app(kind)).get('/api/sessions/196f0068-85a7-4f59-ad82-873caaae8a3b/supervision')
    expect(web.status).toBe(503)
    expect(web.body).toMatchObject({ error: linkFailureAnswer(markLinkFailure(new Error('x'), kind))!.message, code: 'host_reconnecting' })
    expect(web.body.detail).toContain('daemon command timeout')
    expect(web.body.error).not.toMatch(/traceId|daemon command/)
    const v1 = await request(app(kind)).get('/api/v1/sessions/196f0068-85a7-4f59-ad82-873caaae8a3b/thing')
    expect(v1.status).toBe(503)
    expect(v1.body.error.code).toBe('host_reconnecting')
    expect(typeof v1.body.error.message).toBe('string')
    await settle()
    expect(cards).toEqual([])
  })

  it.each(sourceKinds())('a write that met %s: 503 when it never went out, else 504 that says it may have run', async (kind) => {
    const res = await request(app(kind)).post('/api/v1/sessions/196f0068-85a7-4f59-ad82-873caaae8a3b/thing')
    if (kind === 'no-link') {
      expect(res.status).toBe(503)
      expect(res.body.error.code).toBe('host_reconnecting')
    } else {
      expect(res.status).toBe(504)
      expect(res.body.error.code).toBe('host_no_answer')
      expect(res.body.error.message).toMatch(/may have gone through/)
    }
    await settle()
    expect(cards).toEqual([])
  })

  it('a route\'s own error is still a 500 card', async () => {
    const res = await request(app('no-answer')).get('/api/plain')
    expect(res.status).toBe(500)
    await settle()
    expect(cards.map((c) => c.message)).toContain('GET /api/plain → 500')
  })

  it('an untagged error is not a link failure', () => {
    expect(linkFailureAnswer(new Error('daemon command timeout: x'))).toBeNull()
    expect(handsToAppErrorHandler(new Error('connection closed'))).toBe(false)
    expect(handsToAppErrorHandler(markLinkFailure(new Error('x'), 'lost'))).toBe(true)
  })
})

describe('every router error funnel hands a link failure to the app handler', () => {
  const dir = path.join(ROOT, 'src/web/routes')
  const funnels: Array<{ file: string; body: string }> = []
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
    const src = fs.readFileSync(path.join(dir, name), 'utf8')
    // A four-argument error middleware: `.use((err` or `.use(function (err`.
    for (const m of src.matchAll(/\.use\(\s*(?:async\s*)?(?:function\s*)?\(\s*err\b/g)) {
      funnels.push({ file: name, body: codeOnly(src.slice(m.index!, m.index! + 1200)) })
    }
  }

  it('finds the funnels', () => {
    expect(funnels.length).toBeGreaterThanOrEqual(18)
  })

  it.each(funnels.map((f) => [f.file, f.body]))('%s', (_file, body) => {
    const hand = body.indexOf('handsToAppErrorHandler(err)')
    expect(hand, 'call handsToAppErrorHandler(err) and pass the error on with next(err)').toBeGreaterThan(-1)
    const own500 = body.search(/\b500\b/)
    if (own500 !== -1) expect(hand).toBeLessThan(own500)
  })
})

/** Source lines with comment-only lines blanked (the funnels' comments name "a 500 card" too). */
function codeOnly(text: string): string {
  return text.split('\n').map((line) => (/^\s*(\/\/|\*|\/\*)/.test(line) ? '' : line)).join('\n')
}

/**
 * Every place a route answers 500 itself, besides the funnels: in the v1 error
 * vocabulary (`500, 'internal'`) anywhere, and any 500 in a file that talks to a host.
 * Each must first answer a link failure (`sendLinkFailure`, or hand it on), or be
 * listed here with why no host command can reach it.
 */
const LOCAL_ONLY_500: Record<string, string> = {
  "files.ts|open failed": "runs this Mac's `open`",
  "api-v1.ts|update produced no task row": 'a task write that returned nothing, not a thrown error',
}
const TALKS_TO_HOST = /DaemonConnection|daemon-connection|\bconn\.send\(|boundHostRead|remote-read-bound|core\/hosts\/link/
const OWN_500 = /status\(500\)|sendError\(res, 500\b|\b500, 'internal'|code: 'internal'/
/** The v1 error vocabulary's own 500 (`sendError(res, 500, 'internal', ...)`), which every v1 router shares. */
const V1_OWN_500 = /\b500, 'internal'|code: 'internal'/

describe('every route that answers 500 itself answers a link failure first', () => {
  const dir = path.join(ROOT, 'src/web/routes')
  const sites: Array<{ key: string; file: string; line: string; before: string }> = []
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
    const src = fs.readFileSync(path.join(dir, name), 'utf8')
    const lines = codeOnly(src).split('\n')
    const talks = TALKS_TO_HOST.test(src)
    lines.forEach((line, i) => {
      if (!OWN_500.test(line)) return
      if (!talks && !V1_OWN_500.test(line)) return
      const before = lines.slice(Math.max(0, i - 14), i + 1).join('\n')
      // The funnels are checked above.
      if (/\.use\(\s*\(\s*err\b/.test(before) && before.includes('handsToAppErrorHandler(err)')) return
      sites.push({ key: `${name}:${i + 1}`, file: name, line: line.trim(), before })
    })
  }

  it('finds the sites', () => {
    expect(sites.length).toBeGreaterThanOrEqual(8)
  })

  it.each(sites.map((s) => [s.key, s]))('%s', (_key, site) => {
    const exempt = Object.keys(LOCAL_ONLY_500).find((k) => {
      const [file, words] = k.split('|')
      return file === site.file && site.line.includes(words)
    })
    if (exempt) return
    expect(/sendLinkFailure\(|handsToAppErrorHandler\(/.test(site.before),
      `${site.line}: answer a link failure first with sendLinkFailure(req, res, err), or list it in LOCAL_ONLY_500 with why no host command reaches it`).toBe(true)
  })

  it('every exemption still names a real site', () => {
    for (const key of Object.keys(LOCAL_ONLY_500)) {
      const [file, words] = key.split('|')
      expect(sites.some((s) => s.file === file && s.line.includes(words)), key).toBe(true)
    }
  })
})
