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
import type { Server } from 'node:http'

const failures: Record<string, { code: string; status: number }> = {
  gemini: { code: 'budget_unsupported', status: 400 },
  fresh: { code: 'session_not_found', status: 404 },
  unadopted: { code: 'NOT_FOUND', status: 404 },
}
vi.mock('../../src/core/usage/session-budget.js', () => ({
  getSessionBudget: async (sid: string) => {
    const f = failures[sid]
    if (!f) return { sessionId: sid, engine: 'claude' }
    throw Object.assign(new Error(f.code), f)
  },
}))

const { usageRouter } = await import('../../src/web/routes/usage.js')
let server: Server
let base = ''
beforeAll(async () => {
  const app = express()
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
  it('answers null to a client that asks, for an engine without budgets and a session not recorded yet', async () => {
    expect(await get('gemini?absent=null')).toEqual({ status: 200, body: null })
    expect(await get('fresh?absent=null')).toEqual({ status: 200, body: null })
  })

  it('keeps the old statuses for a client that does not ask', async () => {
    expect((await get('gemini')).status).toBe(400)
    expect((await get('fresh')).status).toBe(404)
  })

  it('a session its daemon does not know answers null too, and a budget is a budget', async () => {
    expect(await get('unadopted?absent=null')).toEqual({ status: 200, body: null })
    expect((await get('unadopted')).status).toBe(404)
    expect(await get('claude-1?absent=null')).toEqual({ status: 200, body: { sessionId: 'claude-1', engine: 'claude' } })
  })
})
