/**
 * The Org page's "Never remind me" (web/src/components/org/org-reorg-reminder.ts) is a ui-prefs
 * key, written through `PUT /api/ui-prefs`, the route tests/core/test-run-prefs-gate.test.ts
 * lists as gated. Checked on a REAL server with marking on: a test run's "never" stays in the
 * run's own copy (the user still gets reminded), and an agent's write (a session caller, as the
 * `api` op sends it) lands in the user's file like the user's own click does.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Server as HttpServer } from 'node:http'
import fs from 'node:fs/promises'

import { WALNUT_HOME, UI_PREFS_FILE } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { _resetTestRunPrefsForTest } from '../../src/core/test-run-prefs.js'
import { REORG_NEVER_KEY, REORG_NEVER_VALUE, reorgNeverFrom } from '../../web/src/components/org/org-reorg-reminder.js'

let server: HttpServer
let port: number
const savedMark = process.env.WALNUT_TEST_RUN_MARK

async function api(method: string, route: string, body?: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(`http://localhost:${port}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await r.text()
  return { status: r.status, data: text ? JSON.parse(text) : null }
}

const never = async (headers: Record<string, string> = {}) => {
  const prefs = (await api('GET', '/api/ui-prefs', undefined, headers)).data.prefs as Record<string, { v: string | null }>
  return reorgNeverFrom(prefs[REORG_NEVER_KEY]?.v)
}
const fileHolds = async () => (await fs.readFile(UI_PREFS_FILE, 'utf8').catch(() => '')).includes(REORG_NEVER_KEY)

beforeAll(async () => {
  process.env.WALNUT_TEST_RUN_MARK = '1'
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  _resetTestRunPrefsForTest()
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
}, 90_000)

afterAll(async () => {
  await stopServer()
  _resetTestRunPrefsForTest()
  if (savedMark === undefined) delete process.env.WALNUT_TEST_RUN_MARK
  else process.env.WALNUT_TEST_RUN_MARK = savedMark
  await fs.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe('"Never remind me" for the reorg reminder', () => {
  it('a test run\'s write stays in its own copy: the user is still reminded', async () => {
    const run = { 'x-walnut-test-run': 'reorg-probe' }
    const put = await api('PUT', '/api/ui-prefs', { prefs: { [REORG_NEVER_KEY]: { v: REORG_NEVER_VALUE, ts: Date.now() } } }, run)
    expect(put.status).toBe(200)
    expect(await never(run)).toBe(true)
    expect(await never()).toBe(false)
    expect(await fileHolds()).toBe(false)
  })

  it('an agent turns it off through the same route, for the user', async () => {
    const agent = { 'x-walnut-caller-sid': 'session-reorg-agent' }
    const put = await api('PUT', '/api/ui-prefs', { prefs: { [REORG_NEVER_KEY]: { v: REORG_NEVER_VALUE, ts: Date.now() } } }, agent)
    expect(put.status).toBe(200)
    expect(await never()).toBe(true)
    expect(await fileHolds()).toBe(true)
  })

  it('a later write turns it back on', async () => {
    expect((await api('PUT', '/api/ui-prefs', { prefs: { [REORG_NEVER_KEY]: { v: null, ts: Date.now() + 1000 } } })).status).toBe(200)
    expect(await never()).toBe(false)
  })
})
