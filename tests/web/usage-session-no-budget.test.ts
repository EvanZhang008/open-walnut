/**
 * GET /api/usage/sessions/:sid with no budget to show. A client that asks
 * (`absent=null`) gets 200 null, so the browser logs no failed request for every
 * Gemini, Goose, Pi or DeepSeek panel and every new session (2026-10-30). Without
 * the parameter, an older bundle still open across a deploy keeps its 400/404,
 * because it reads `null.sessionId`. A daemon that does not know the session (new,
 * stored, or not adopted yet after a restart) answers the same; the web store keeps
 * a budget it already showed (tests/web/session-usage-store.test.ts).
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import express from 'express'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Server } from 'node:http'

const failures: Record<string, { code: string; status: number }> = {
  gemini: { code: 'budget_unsupported', status: 400 },
  fresh: { code: 'session_not_found', status: 404 },
  unadopted: { code: 'NOT_FOUND', status: 404 },
  offline: { code: 'budget_unavailable', status: 503 },
  timedout: { code: 'budget_timeout', status: 503 },
  olderhost: { code: 'budget_needs_upgrade', status: 503 },
  denied: { code: 'NOT_OWNED', status: 403 },
  unknown: { code: 'new_failure_kind', status: 503 },
}
// The session's host not reachable now (link-failure.ts): no connection, or no answer in time.
const linkDown: Record<string, 'no-link' | 'no-answer'> = { hostaway: 'no-link', hostsilent: 'no-answer' }
vi.mock('../../src/core/usage/session-budget.js', async () => {
  const { markLinkFailure } = await import('../../src/providers/link-failure.js')
  const answer = async (sid: string) => {
    if (linkDown[sid]) throw markLinkFailure(new Error(`Connection to devbox failed 7s ago: devbox is not online`), linkDown[sid]!)
    const f = failures[sid]
    if (!f) return { sessionId: sid, engine: 'claude' }
    throw Object.assign(new Error(f.code), f)
  }
  return { getSessionBudget: answer, configureSessionBudget: answer }
})

const { usageRouter } = await import('../../src/web/routes/usage.js')
let server: Server
let base = ''
beforeAll(async () => {
  const app = express()
  app.use(express.json())
  app.use('/api/usage', usageRouter)
  server = await new Promise<Server>((r) => { const s = app.listen(0, () => r(s)) })
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/usage/sessions`
})
afterAll(() => { server.closeAllConnections(); server.close() })

async function get(path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${base}/${path}`)
  return { status: res.status, body: await res.json() }
}

describe('a session with no budget', () => {
  it('pins every absence code in the route so a new code cannot silently swallow a host failure', () => {
    const source = fs.readFileSync(fileURLToPath(new URL('../../src/web/routes/usage.ts', import.meta.url)), 'utf8')
    const codes = /const NO_BUDGET_CODES = new Set\(\[([^\]]*)\]\)/.exec(source)?.[1]
    expect(codes).toBeDefined()
    expect([...codes!.matchAll(/'([^']+)'/g)].map(match => match[1]).sort()).toEqual(
      Object.values(failures).filter(failure => failure.status === 400 || failure.status === 404).map(failure => failure.code).sort(),
    )
  })
  it('answers null to a client that asks, for an engine without budgets and a session not recorded yet', async () => {
    expect(await get('gemini?absent=null')).toEqual({ status: 200, body: null })
    expect(await get('fresh?absent=null')).toEqual({ status: 200, body: null })
  })

  it('keeps the old statuses for a client that does not ask', async () => {
    expect((await get('gemini')).status).toBe(400)
    expect((await get('fresh')).status).toBe(404)
  })

  it.each(Object.entries(failures).filter(([, failure]) => failure.status !== 400 && failure.status !== 404))(
    'keeps %s failures visible instead of interpreting unavailable as no budget', async (sid, failure) => {
      for (const query of ['', '?absent=null']) {
        expect(await get(`${sid}${query}`)).toEqual({ status: failure.status, body: { error: failure.code, code: failure.code } })
      }
    },
  )

  it('a failed poll recovers on the same session without losing the error meaning', async () => {
    expect((await get('offline?absent=null')).status).toBe(503)
    const failure = failures.offline
    try {
      delete failures.offline
      expect(await get('offline?absent=null')).toEqual({ status: 200, body: { sessionId: 'offline', engine: 'claude' } })
    } finally { failures.offline = failure }
  })

  it('a session its daemon does not know answers null too, and a budget is a budget', async () => {
    expect(await get('unadopted?absent=null')).toEqual({ status: 200, body: null })
    expect((await get('unadopted')).status).toBe(404)
    expect(await get('claude-1?absent=null')).toEqual({ status: 200, body: { sessionId: 'claude-1', engine: 'claude' } })
  })

  // 2026-11-26: while clouddev was unreachable this route answered five 503s an hour as its own
  // server errors (code budget_unavailable). A host not reachable now is the host's answer.
  it('a host not reachable now answers host_reconnecting for a read, with or without absent=null', async () => {
    for (const sid of Object.keys(linkDown)) {
      for (const query of ['', '?absent=null']) {
        const got = await get(`${sid}${query}`)
        expect(got.status, sid).toBe(503)
        expect((got.body as { code?: string }).code, sid).toBe('host_reconnecting')
      }
    }
  })

  it('a change its host never got is a 503 to try again; one that may have run there is a 504', async () => {
    const patch = (sid: string) => fetch(`${base}/${sid}/budget`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ limitUsd: 5, revision: 1 }) })
    const never = await patch('hostaway')
    expect(never.status).toBe(503)
    expect((await never.json()).code).toBe('host_reconnecting')
    const maybe = await patch('hostsilent')
    expect(maybe.status).toBe(504)
    expect((await maybe.json()).code).toBe('host_no_answer')
  })
})
