/**
 * Ratchet: no literal /api/v1 route is shadowed by a parameter route registered before it
 * (2026-10-31: `GET /hosts/:host` of the fleet view, mounted before the move router,
 * answered `GET /hosts/load` with "Walnut has no host named load", so host_load and the
 * kebab's host rows broke on prod).
 *
 * Counted from the source: every router server.ts mounts on /api/v1, in its mount order,
 * and every route in each. A literal path (no `:` or `*`) that an earlier route of the
 * same method also matches fails here, whichever router either lives in, unless the
 * earlier route's own file names the word it would swallow (the convention: a reserved
 * set it answers with `next()`, as RESERVED_TASK_SUBPATHS in task-v1.ts).
 */
import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('v1-route-shadow'))

const WEB = path.resolve(__dirname, '../../src/web')

interface RouteLayer { router: string; file: string; path: string; methods: string[]; match: (p: string) => boolean }

async function v1Routes(): Promise<RouteLayer[]> {
  const server = fs.readFileSync(path.join(WEB, 'server.ts'), 'utf8')
  const mounted = [...server.matchAll(/app\.use\('\/api\/v1',\s*(\w+)\)/g)].map((m) => m[1])
  const out: RouteLayer[] = []
  for (const name of mounted) {
    const imp = new RegExp(String.raw`import\s*\{[^}]*\b${name}\b[^}]*\}\s*from\s*'(\./routes/[^']+)'`).exec(server)
    if (!imp) throw new Error(`no import for ${name} in server.ts`)
    const mod = await import(path.join(WEB, imp[1].replace(/\.js$/, '.ts'))) as Record<string, unknown>
    const router = mod[name] as { stack?: Array<{ route?: { path: unknown; methods: Record<string, boolean> }; match: (p: string) => boolean }> }
    for (const layer of router.stack ?? []) {
      if (!layer.route || typeof layer.route.path !== 'string') continue
      out.push({
        router: name, file: path.join(WEB, imp[1].replace(/\.js$/, '.ts')), path: layer.route.path,
        methods: Object.keys(layer.route.methods).filter((m) => layer.route!.methods[m]),
        match: (p) => layer.match(p),
      })
    }
  }
  return out
}

describe('/api/v1 routes', () => {
  it('no literal path is answered by an earlier parameter route', async () => {
    const routes = await v1Routes()
    expect(routes.length).toBeGreaterThan(50)
    const shadowed: string[] = []
    routes.forEach((r, i) => {
      if (/[:*(]/.test(r.path)) return
      for (const e of routes.slice(0, i)) {
        if (e.path === r.path || !e.methods.some((m) => r.methods.includes(m))) continue
        if (!e.match(r.path)) continue
        // The word the earlier route's parameter would take, and whether its file passes it on.
        const es = e.path.split('/'); const rs = r.path.split('/')
        const word = rs.find((seg, k) => es[k]?.startsWith(':') && seg !== es[k])
        if (word && fs.readFileSync(e.file, 'utf8').includes(`'${word}'`)) continue
        shadowed.push(`${r.methods.join(',').toUpperCase()} ${r.path} (${r.router}) is answered first by ${e.path} (${e.router})`)
      }
    })
    expect(shadowed).toEqual([])
  }, 120_000)

  it('the case that shipped: GET /hosts/load reaches the move router', async () => {
    const routes = await v1Routes()
    const first = routes.find((r) => r.methods.includes('get') && r.match('/hosts/load'))
    expect(first).toMatchObject({ router: 'taskMoveV1Router', path: '/hosts/load' })
  }, 120_000)
})
