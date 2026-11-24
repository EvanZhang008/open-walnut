/**
 * The phone's reads that a real CLOUD_MODE server (the companion) answers itself reach the Mac's
 * real use (src/core/usage-watch/companion-uses.ts), under the path the phone called.
 *
 * 2026-11-24: GET /api/v1/sessions/:id/transcript, how the phone reads a chat, had no row in a week:
 * the companion answers it (web/v1-forward/policy.ts, a paged read), and real use ran only on the
 * Mac. The Mac is a fake behind the relay seam (callPrimaryControl), away for every other action,
 * so the box answers every call itself, as it does while the Mac sleeps.
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import type { Server as HttpServer } from 'node:http'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-companion-real-use', { CLOUD_MODE: true }))

const mac = { rows: [] as Array<{ batch: string; rows: Array<{ name: string; agg: { calls: number } }> }> }
vi.mock('../../../src/web/routes/v1-control-relay.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/web/routes/v1-control-relay.js')>()),
  callPrimaryControl: async (action: string, _sid: string, params: any) => {
    if (action === 'server.usage.rows') { mac.rows.push(JSON.parse(JSON.stringify(params))); return { ok: true, result: { added: params.rows.length, refused: 0 } } }
    return { ok: false, failure: { kind: 'bridge_offline', message: 'No live bridge', notSent: true } }
  },
}))

import { WALNUT_HOME } from '../../../src/constants.js'
import { installMountRecorder, walkRoutes, type WalkedRoute } from '../../helpers/express-route-walk.js'

// Mount paths are recorded only for routers built after this line: the server is imported below it.
installMountRecorder()

let server: HttpServer
let port = 0
let stopServer: () => Promise<void> = async () => {}
let flushUsage: () => void = () => {}
let routes: WalkedRoute[] = []
const phone = crypto.randomBytes(16).toString('hex')
const sha = (t: string) => crypto.createHash('sha256').update(t, 'utf-8').digest('hex')

beforeAll(async () => {
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  await fs.writeFile(path.join(WALNUT_HOME, 'auth.json'), JSON.stringify({ devices: [
    { name: 'my-phone', id: 'd00000000000000c5', tokenHash: sha(phone), createdAt: new Date().toISOString() },
  ] }), { mode: 0o600 })
  ;(await import('../../../src/core/device-auth.js'))._resetDeviceAuthForTesting()
  const web = await import('../../../src/web/server.js')
  stopServer = web.stopServer
  flushUsage = (await import('../../../src/core/usage-watch/record.js')).flushUsage
  server = await web.startServer({ port: 0, dev: true })
  routes = walkRoutes(web._getAppForTesting() as unknown as Parameters<typeof walkRoutes>[0])
  const addr = server.address()
  port = typeof addr === 'object' && addr ? addr.port : 0
}, 120_000)

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
}, 60_000)

describe('the companion\'s own answers in the Mac\'s real use', () => {
  it('the phone\'s transcript read and task list reach the Mac under the path called', async () => {
    const get = (p: string) => fetch(`http://127.0.0.1:${port}${p}`, { headers: { Authorization: `Bearer ${phone}` } }).then(async (r) => { await r.arrayBuffer(); return r.status })
    // The transcript and the task list are answered by their routes; the skills and memory reads by
    // the copy readers before any route (replica/companion-copy-routes.ts), the references read by
    // one router's reader for a route of another (routes/console-v1.ts, library-v1.ts).
    const calls: Array<[string, string]> = [
      ['/api/v1/sessions/5f1c2a77-0b2e-4d43-9c55-2f6ad3e0c1ab/transcript?rich=1&visible=14', 'GET /api/v1/sessions/:id/transcript'],
      ['/api/v1/tasks', 'GET /api/v1/tasks'],
      ['/api/v1/skills', 'GET /api/v1/skills'],
      ['/api/v1/skills/demo-skill/references', 'GET /api/v1/skills/:dirName/references'],
      ['/api/v1/memory/browse', 'GET /api/v1/memory/browse'],
    ]
    const statuses: number[] = []
    for (const [url] of calls) statuses.push(await get(url))
    // Answered here, whatever the answer (the Mac is away): none went unanswered.
    expect(statuses.every((s) => s > 0 && s !== 401)).toBe(true)
    await vi.waitFor(() => {
      flushUsage()
      const names = mac.rows.flatMap((b) => b.rows.map((r) => r.name))
      for (const [, name] of calls) expect(names, name).toContain(name)
    }, { timeout: 15_000, interval: 300 })
    // No content rides it: only route templates, never the session's id.
    expect(JSON.stringify(mac.rows)).not.toContain('5f1c2a77')
  })

  // Every kind of call the companion keeps for itself is answered by a route of its own, which the
  // request logger names and counts. A call answered before any route (a middleware) would reach
  // neither box's real use.
  it('every call the companion keeps is answered by a route it counts', async () => {
    const { COMPANION_ROUTES } = await import('../../../src/web/v1-forward/policy.js')
    const v1 = routes.filter((r) => r.path.startsWith('/api/v1/')).map((r) => ({ method: r.method, rel: r.path.slice('/api/v1'.length).replace(/:[^/]+/g, 'x1') }))
    const unrouted = COMPANION_ROUTES.filter((rule) => !v1.some((r) => (!rule.methods || rule.methods.includes(r.method) || r.method === 'ALL') && rule.re.test(r.rel.toLowerCase()) && !(rule.unless && rule.unless.test(r.rel.toLowerCase()))))
    expect(unrouted.map((r) => `${r.methods?.join(',') ?? 'ANY'} ${r.re.source} (${r.why})`)).toEqual([])
  })

  // A router whose middleware answers before its routes (a copy reader) names those answers as the
  // routes (web/middleware/answer-name.ts), or they reach neither box's real use.
  it('every router with a copy reader names what it answers', async () => {
    const src = path.resolve(__dirname, '../../../src')
    const missing: string[] = []
    const walk = async (d: string): Promise<void> => {
      for (const e of await fs.readdir(d, { withFileTypes: true })) {
        const p = path.join(d, e.name)
        if (e.isDirectory()) { await walk(p); continue }
        if (!e.name.endsWith('.ts')) continue
        const text = await fs.readFile(p, 'utf8')
        for (const m of text.matchAll(/(\w+)\.use\(\s*(?:companion|replica|hostCopy)\w*\(/g)) {
          const named = text.indexOf(`${m[1]}.use(nameAnswersHere())`)
          if (named < 0 || named > m.index!) missing.push(`${path.relative(src, p)}: ${m[0]}`)
        }
      }
    }
    await walk(src)
    expect(missing).toEqual([])
  })

  // The companion's answer that is the Mac's answer is the Mac's to count (v1-forward/counted-on-mac.ts):
  // every relay of an HTTP call to the Mac marks what it passes on.
  it('every relay of a call to the Mac marks the Mac\'s answer', async () => {
    const src = path.resolve(__dirname, '../../../src')
    const relays: string[] = []
    const unmarked: string[] = []
    const walk = async (d: string): Promise<void> => {
      for (const e of await fs.readdir(d, { withFileTypes: true })) {
        const p = path.join(d, e.name)
        if (e.isDirectory()) { await walk(p); continue }
        if (!e.name.endsWith('.ts')) continue
        const text = await fs.readFile(p, 'utf8')
        if (!/callPrimaryControl\(\s*'server\.http'|forwardOnStream\(\{/.test(text) || p.endsWith('stream-forward.ts')) continue
        relays.push(path.relative(src, p))
        if (!text.includes("'X-Walnut-Answered-By', 'primary'")) unmarked.push(path.relative(src, p))
      }
    }
    await walk(src)
    expect(relays.length).toBeGreaterThanOrEqual(2)
    expect(unmarked).toEqual([])
    // The stream's answer is marked where it is written.
    expect(await fs.readFile(path.join(src, 'web/v1-forward/stream-forward.ts'), 'utf8')).toContain("res.setHeader('X-Walnut-Answered-By', 'primary')")
  })
})
