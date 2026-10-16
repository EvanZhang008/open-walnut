/**
 * Ratchet: the route table of a host replica covers the whole real surface
 * (docs/plan/walnut-replica-servers-impl.md, section 3, WP2).
 *
 * The real startServer boots as a host replica in this process (test mode,
 * WALNUT_ROLE=replica), its express 5 router stack is walked recursively
 * (tests/helpers/express-route-walk.ts: every route's method and full path),
 * and the WS handler's registered RPC methods are read. Then:
 *   - every write route has an explicit row (never the defaults), so a new
 *     write never journals by accident;
 *   - a row that journals (host-write, queue:<kind>, note-write) is exact: no
 *     wildcard in its pattern, and it names a route that exists;
 *   - plugin routes are class leader by prefix;
 *   - every /api/v1 route the phone app calls exists and has an exact row;
 *   - every RPC method the server registers is named in the RPC table, and
 *     every name in the table is registered (no stale row).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'
import { useHostReplicaEnv, type HostReplicaEnv } from '../helpers/replica-host-env.js'
import { installMountRecorder, walkRoutes, type WalkedRoute } from '../helpers/express-route-walk.js'
import { classify, journals, patternMatches, ROUTE_TABLE } from '../../src/replica/route-table.js'
import { WS_RPC_TABLE } from '../../src/replica/ws-rpc-table.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-replica-routes'))

// Mount paths are recorded only for routers built after this line.
installMountRecorder()

let env: HostReplicaEnv | null = null
let stopServer: (() => Promise<void>) | null = null
let routes: WalkedRoute[] = []
let rpcMethods: string[] = []

/** What the phone app calls (ios-native, the frozen /api/v1): each needs its own exact row. */
const PHONE_CALLS: Array<[string, string]> = [
  ['GET', '/api/v1/status'],
  ['GET', '/api/v1/instance'],
  ['GET', '/api/v1/me'],
  ['POST', '/api/v1/devices/self'],
  ['GET', '/api/v1/tasks'],
  ['GET', '/api/v1/tasks/:id'],
  ['POST', '/api/v1/tasks'],
  ['PATCH', '/api/v1/tasks/:id'],
  ['GET', '/api/v1/sessions'],
  ['GET', '/api/v1/sessions/:id'],
  ['GET', '/api/v1/sessions/:id/history'],
  ['POST', '/api/v1/sessions/:id/messages'],
  ['GET', '/api/v1/conversations/:id/messages'],
]

const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE', 'ALL'])

beforeAll(async () => {
  const c = await import('../../src/constants.js')
  env = useHostReplicaEnv(c.WALNUT_HOME)
  const role = await import('../../src/core/server-role.js')
  role._resetServerRoleForTesting()
  expect(role.isHostReplica()).toBe(true)
  const server = await import('../../src/web/server.js')
  await server.startServer({ port: 0, dev: true })
  stopServer = server.stopServer
  const app = server._getAppForTesting()
  expect(app).not.toBeNull()
  routes = walkRoutes(app as unknown as Parameters<typeof walkRoutes>[0])
  rpcMethods = (await import('../../src/web/ws/handler.js')).listRpcMethods()
}, 120_000)

afterAll(async () => {
  try { await stopServer?.() } catch { /* already down */ }
  env?.restore()
  ;(await import('../../src/core/server-role.js'))._resetServerRoleForTesting()
}, 60_000)

describe('the route table against the real app', () => {
  it('the walk sees the app: hundreds of routes, the phone calls and the plugin prefix among them', () => {
    expect(routes.length).toBeGreaterThan(200)
    expect(routes.some((r) => r.method === 'GET' && r.path === '/api/v1/tasks')).toBe(true)
  })

  it('every write route has an explicit row (never the defaults)', () => {
    const bare = routes.filter((r) => WRITES.has(r.method) && classify(r.method, r.path).row === null)
    expect(bare.map((r) => `${r.method} ${r.path}`)).toEqual([])
  })

  it('a row that journals is exact (no wildcard) and names a route that exists', () => {
    for (const row of ROUTE_TABLE.filter((r) => journals(r.away))) {
      expect(row.pattern.includes('*'), row.pattern).toBe(false)
      expect(routes.some((r) => patternMatches(row.pattern, r.path)), row.pattern).toBe(true)
    }
    // No walked write lands on a journaling away through a wildcard row.
    for (const r of routes.filter((x) => WRITES.has(x.method))) {
      const d = classify(r.method, r.path)
      if (journals(d.away)) expect(d.row?.pattern.includes('*'), `${r.method} ${r.path}`).toBe(false)
    }
  })

  it('plugin routes are class leader by prefix, and need the Mac away', () => {
    for (const m of ['GET', 'POST', 'DELETE']) {
      expect(classify(m, '/api/plugins/acme/items')).toMatchObject({ cls: 'leader', away: 'needs-leader' })
    }
    for (const r of routes.filter((x) => x.path.startsWith('/api/plugins/'))) {
      expect(classify(r.method === 'ALL' ? 'POST' : r.method, r.path).cls, r.path).toBe('leader')
    }
  })

  it.each(PHONE_CALLS)('the phone call %s %s exists and has its own exact row', (method, p) => {
    expect(routes.some((r) => (r.method === method || r.method === 'ALL') && r.path === p), `${method} ${p} is served`).toBe(true)
    const d = classify(method, p)
    expect(d.row, `${method} ${p}`).not.toBeNull()
    expect(d.row!.pattern.includes('*'), `${method} ${p} row ${d.row!.pattern}`).toBe(false)
  })
})

describe('the WS RPC table against the real handler', () => {
  it('every method the server registers is named in the table', () => {
    expect(rpcMethods.length).toBeGreaterThan(5)
    expect(rpcMethods.filter((m) => !(m in WS_RPC_TABLE)).sort()).toEqual([])
  })

  it('every name in the table is a registered method (no stale row)', () => {
    // The terminal registers only where node-pty loads; its rows stay for the hosts where it does not.
    const optional = (m: string) => m.startsWith('terminal:')
    expect(Object.keys(WS_RPC_TABLE).filter((m) => !rpcMethods.includes(m) && !optional(m)).sort()).toEqual([])
  })

  it('a write never answers here away, a read always does', () => {
    for (const [m, row] of Object.entries(WS_RPC_TABLE)) {
      if (row.kind === 'write') expect(row.away, m).not.toBe('read')
      else expect(row.away, m).toBe('read')
    }
  })
})
