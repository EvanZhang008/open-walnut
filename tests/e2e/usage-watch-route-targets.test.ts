/**
 * A route watch target names a route the real app serves, by the app's own router
 * (src/core/usage-watch/route-target.ts, web/route-template-of.ts).
 *
 * 2026-11-27: `route:GET /api/sessions/:id/history` and `route:GET /api/v1/org/avatars/:id.png` ended
 * "No use" with 0 uses on routes the app served thousands and hundreds of times: the server records
 * `:sessionId` and `:file`. Pinned on the real app:
 *   - set keeps a target under the name the server records it, and refuses one no route serves;
 *   - every route a watch is shown as an example (the op's help and description) is one the app serves;
 *   - every /api route the app registers is a target set takes as it is, a route registered with a list
 *     of paths included (2026-11-27 review: `GET /api/health` was refused, the resolver skipped them),
 *     and one a parameter route hands on with `next()` (`GET /api/v1/tasks/enriched`).
 * Only the Claude CLI is absent.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-usage-watch-route-targets'))

import { _getAppForTesting, startServer, stopServer } from '../../src/web/server.js'
import { addTask } from '../../src/core/task-manager.js'
import { servedRouteName } from '../../src/core/usage-watch/route-target.js'
import { installMountRecorder, walkRoutes } from '../helpers/express-route-walk.js'

// Mount paths are recorded only for routers built after this line.
installMountRecorder()

const ROOT = path.resolve(__dirname, '../..')
let server: HttpServer
let base: string
let task = ''

const set = (targets: string[]) => fetch(`${base}/api/v1/usage-watch`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ action: 'set', task, targets, check_after: '24h' }),
})

beforeAll(async () => {
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  task = (await addTask({ title: 'Route target watch', project: 'Ships' })).task.id
}, 60_000)

afterAll(async () => {
  await stopServer()
})

describe('a route watch target on the real app', () => {
  it('is kept under the name the server records, whatever its parameters are named', async () => {
    const res = await set(['route:GET /api/sessions/:id/history', 'route:GET /api/v1/org/avatars/:id.png', 'route:GET /api/tasks/:taskId'])
    const body = await res.json() as { watch?: { targets: string[] }; outcome?: string }
    expect(res.status, JSON.stringify(body)).toBe(200)
    expect(body.watch!.targets).toEqual([
      `route:${servedRouteName('GET /api/sessions/:id/history')}`,
      `route:${servedRouteName('GET /api/v1/org/avatars/:id.png')}`,
      `route:${servedRouteName('GET /api/tasks/:taskId')}`,
    ])
    expect(body.watch!.targets[0]).toBe('route:GET /api/sessions/:sessionId/history')
    expect(body.watch!.targets[1]).toBe('route:GET /api/v1/org/avatars/:file')
  })

  it('is refused when no route of the app serves it, or real use never records it', async () => {
    for (const t of ['route:GET /api/sessions/:id/histroy', 'route:GET /api/no/such/route', 'route:POST /api/sessions/:id/history', 'route:GET /host-door']) {
      const res = await set([t])
      const body = await res.json() as { code?: string; error?: string }
      expect(res.status, `${t}: ${JSON.stringify(body)}`).toBe(400)
      expect(body.code).toBe('bad_target')
      expect(body.error).toMatch(t.includes('/api/') ? /is no route this server serves/ : /is no \/api\/ route/)
    }
  })

  it('every route shown as an example of a watch target is one the app serves', () => {
    const files = ['src/core/usage-watch/actions.ts', 'src/ops/usage-watch.ts']
    const examples = new Set<string>()
    for (const f of files) {
      for (const m of fs.readFileSync(path.join(ROOT, f), 'utf8').matchAll(/route:((?:GET|POST|PUT|PATCH|DELETE) \/[A-Za-z0-9_\-/:.*]+)/g)) {
        // A placeholder (`route:GET /api/...`) names no route.
        if (!m[1]!.includes('...')) examples.add(m[1]!)
      }
    }
    expect(examples.size).toBeGreaterThan(0)
    for (const e of examples) expect(servedRouteName(e), e).toBe(e)
  })

  it('every /api route the app registers is a target set takes as it is', () => {
    const app = _getAppForTesting()
    expect(app).not.toBeNull()
    const names = new Set<string>()
    for (const r of walkRoutes(app as never)) {
      // A route under a parameter mount is recorded with that part as `:id`; a regexp names no template.
      if (!r.path.startsWith('/api/') || r.method === 'ALL' || r.path.includes('<regexp')) continue
      names.add(`${r.method} ${r.path}`)
    }
    expect(names.size).toBeGreaterThan(300)
    const refused: string[] = []
    for (const n of names) {
      const served = servedRouteName(n)
      if (served === null) refused.push(n)
    }
    expect(refused).toEqual([])
  })
})
