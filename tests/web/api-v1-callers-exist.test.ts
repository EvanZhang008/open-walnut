/**
 * Ratchet: every /api/v1 address the shipped code names is a route the real server serves.
 *
 * 2026-11-19: a deploy's wait loop polled `GET /api/v1/health` every 10 s, 30 times, and got
 * 404 each time (no such route: liveness is /api/system/health), which raised a log-spike alarm
 * on the health page. A caller naming a route that does not exist only shows up as 404 lines
 * in production, so this test finds them first.
 *
 * The real startServer boots in this process (leader, test mode) and its express router stack
 * is walked (tests/helpers/express-route-walk.ts). Then every `/api/v1/...` literal in the
 * committed code an agent, a client or a script runs is read (the server and the web app, the
 * phone and desktop apps, scripts, plugins, and the skills agents follow), its interpolations
 * (`${id}`, Swift `\(id)`, `:id`, `{id}`, `<id>`) made one sample segment, and it must match a
 * route of the real app. A literal that ends in `/` is a prefix the code completes, and needs
 * a route under it. The guessed liveness addresses (LIVENESS_ALIASES, routes/system.ts) are
 * checked to answer too.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'
import { installMountRecorder, walkRoutes, type WalkedRoute } from '../helpers/express-route-walk.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-v1-callers'))

// Mount paths are recorded only for routers built after this line.
installMountRecorder()

const ROOT = path.resolve(__dirname, '../..')

/** Where callers live. Tests, docs and the changelog are left out: they quote old and planned routes. */
const CALLER_DIRS = ['src', 'web/src', 'ios-native', 'desktop', 'desktop-windows', 'scripts', 'packages', 'plugin-store', 'skills', 'bin', 'native']
const CALLER_EXT = /\.(ts|tsx|js|mjs|cjs|swift|sh|py|md)$/

/**
 * /api/v1 routes a test boot does not mount, each with where they are mounted. Keep this short:
 * a new entry needs a reason a reader can check in server.ts.
 */
const NOT_IN_TEST_BOOT: Array<{ path: string; why: string }> = [
  { path: '/api/v1/net', why: "routes/net-v1.ts, mounted only where bootPolicy('host-network-door') holds (the companion)" },
]

/** Literals a function returns as a base its callers complete, each with where it is completed. */
const BASES: Array<{ literal: string; why: string }> = [
  { literal: '/api/v1/human-inbox/${encodeURIComponent(letterId)}/items/${encodeURIComponent(itemId)}', why: 'itemRoute() in web/src/api/human-inbox-items.ts; every caller adds /prepare, /execute, /execution or /tasks' },
]

let stopServer: (() => Promise<void>) | null = null
let routes: WalkedRoute[] = []
let baseUrl = ''

beforeAll(async () => {
  const server = await import('../../src/web/server.js')
  const http = await server.startServer({ port: 0, dev: true })
  stopServer = server.stopServer
  const app = server._getAppForTesting()
  expect(app).not.toBeNull()
  routes = walkRoutes(app as unknown as Parameters<typeof walkRoutes>[0])
  const addr = http.address()
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
}, 120_000)

afterAll(async () => {
  try { await stopServer?.() } catch { /* already down */ }
}, 60_000)

/** A segment of a caller that the code fills in (an id, an action): it can be any segment. */
const ANY = '\u0000any'

/** An express 5 route path as one or more segment lists (each optional `{...}` group in or out). */
function routeShapes(p: string): string[][] {
  if (p.includes('<regexp')) return []
  const open = p.indexOf('{')
  if (open >= 0) {
    let depth = 0; let close = -1
    for (let i = open; i < p.length; i++) {
      if (p[i] === '{') depth++
      else if (p[i] === '}' && --depth === 0) { close = i; break }
    }
    if (close < 0) return []
    const inner = p.slice(open + 1, close)
    if (inner.startsWith('*')) return routeShapes(`${p.slice(0, open)}*${p.slice(close + 1)}`)
    return [...routeShapes(p.slice(0, open) + p.slice(close + 1)), ...routeShapes(p.slice(0, open) + inner + p.slice(close + 1))]
  }
  return [p.split('/').filter(Boolean)]
}

/** Does a route shape serve the caller's segments (`prefix`: some path under them)? */
function serves(shape: string[], caller: string[], prefix: boolean): boolean {
  for (let i = 0; i < caller.length; i++) {
    const r = shape[i]
    if (r === undefined) return false
    if (r.startsWith('*')) return true
    const c = caller[i]!
    if (c === ANY || r.startsWith(':')) continue
    if (r !== c) return false
  }
  // Every caller segment matched: an exact call needs the route to end here (or a rest),
  // a prefix needs nothing more.
  return prefix || shape.length === caller.length || !!shape[caller.length]?.startsWith('*')
}

/** One caller literal as segments, and whether the code completes it (a prefix). */
function normalizeCaller(raw: string): { segments: string[]; prefix: boolean } | null {
  let s = raw
  // An interpolation glued to the end of a segment (`/tasks${query}`, `/switch-engine${q}`)
  // adds a query or a suffix: the address is what comes before it.
  s = s.replace(/([^/])(?:\$\{|\\\().*$/, '$1')
  s = s
    .replace(/\$\{[^}]*\}/g, ANY) // JS template
    .replace(/\\\((?:[^()]|\([^()]*\))*\)/g, ANY) // Swift interpolation
    .replace(/\{[A-Za-z_]\w*\}/g, ANY) // {id}
    .replace(/(^|\/):[A-Za-z_]\w*\+?(?=\/|$)/g, `$1${ANY}`) // :id
  s = s.replace(/[?#].*$/, '').replace(/[.,:;]+$/, '')
  if (!s.startsWith('/api/v1/')) return null
  const prefix = s.endsWith('/') || s.endsWith('/...')
  s = s.replace(/\/\.\.\.$/, '/')
  return { segments: s.split('/').filter(Boolean), prefix }
}

/** Test code, mock and stub servers: they name routes on purpose that the real app lacks. */
const NOT_A_CALLER = /(^|\/)(tests?|__tests__|WalnutTests|WalnutUITests|fixtures)\/|\.(test|spec)\.|mock-server|stub-server/

/**
 * An address the code sends a request to: it starts a string literal (`'/api/v1/x'`,
 * `"/api/v1/x"`, a template), or follows a base URL inside one (`${base}/api/v1/x`,
 * Swift `\(base)/api/v1/x`, `http://127.0.0.1:3456/api/v1/x`). A comment or a sentence
 * that names a route in prose (`GET /api/v1/x`, `(/api/v1/x)`) is not a call.
 */
const CALL = new RegExp(
  String.raw`(?:['"` + '`' + String.raw`]|\}|\)|:\d+|localhost|\$\w+|\$\{\w+\})` +
  String.raw`(\/api\/v1\/(?:\$\{[^}]*\}|\\\((?:[^()]|\([^()]*\))*\)|\{[A-Za-z_]\w*\}|[^\s'"` + '`' + String.raw`<>,;|*()\[\]{}\\])*)`,
  'g',
)

function callerLiterals(): Map<string, string[]> {
  const files = execFileSync('git', ['ls-files', '--', ...CALLER_DIRS], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter((f) => CALLER_EXT.test(f) && !NOT_A_CALLER.test(f))
  const found = new Map<string, string[]>()
  for (const f of files) {
    let text: string
    try { text = fs.readFileSync(path.join(ROOT, f), 'utf8') } catch { continue }
    if (!text.includes('/api/v1/')) continue
    const js = /\.(ts|tsx|js|mjs|cjs)$/.test(f)
    for (const m of text.matchAll(CALL)) {
      const lit = m[1]!
      // A backtick opens a string only in JS; elsewhere it quotes a route in prose.
      if (!js && m[0].startsWith('`')) continue
      const lineEnd = text.indexOf('\n', m.index)
      const line = text.slice(text.lastIndexOf('\n', m.index) + 1, lineEnd < 0 ? undefined : lineEnd)
      // A mount (`app.use('/api/v1/x', ...)`) names a prefix for routes, not a call.
      if (/\.use\(\s*\[?\s*['"]/.test(line)) continue
      const at = `${f}:${text.slice(0, m.index).split('\n').length}`
      const list = found.get(lit) ?? []
      list.push(at)
      found.set(lit, list)
    }
  }
  return found
}

describe('/api/v1 callers', () => {
  it('the walk sees the app', () => {
    expect(routes.length).toBeGreaterThan(200)
    expect(routes.some((r) => r.path === '/api/v1/tasks')).toBe(true)
  })

  it('every /api/v1 address the code names is served', () => {
    const shapes = routes.flatMap((r) => routeShapes(r.path))
    const missing: string[] = []
    let checked = 0
    for (const [lit, where] of callerLiterals()) {
      const c = normalizeCaller(BASES.some((b) => b.literal === lit) ? `${lit}/` : lit)
      if (!c) continue
      checked++
      const joined = `/${c.segments.join('/')}`
      if (NOT_IN_TEST_BOOT.some((m) => joined === m.path || joined.startsWith(`${m.path}/`))) continue
      if (shapes.some((shape) => serves(shape, c.segments, c.prefix))) continue
      missing.push(`${lit}  (${where.slice(0, 3).join(', ')}${where.length > 3 ? `, +${where.length - 3}` : ''})`)
    }
    expect(checked).toBeGreaterThan(100)
    expect(missing, `addresses no route serves:\n${missing.join('\n')}`).toEqual([])
  })

  it('the matcher catches the 2026-11-19 guess and passes real calls', async () => {
    const { LIVENESS_ALIASES } = await import('../../src/web/routes/system.js')
    const aliases = new Set<string>(LIVENESS_ALIASES)
    const shapes = routes.filter((r) => !aliases.has(r.path)).flatMap((r) => routeShapes(r.path))
    const ok = (lit: string) => { const c = normalizeCaller(lit)!; return shapes.some((sh) => serves(sh, c.segments, c.prefix)) }
    const who = (lit: string) => { const c = normalizeCaller(lit)!; return routes.filter((r) => !aliases.has(r.path) && routeShapes(r.path).some((sh) => serves(sh, c.segments, c.prefix))).map((r) => `${r.method} ${r.path}`) }
    expect(who('/api/v1/health')).toEqual([])
    expect(ok('/api/v1/no-such-area/${id}')).toBe(false)
    expect(ok('/api/v1/health/status')).toBe(true)
    expect(ok('/api/v1/tasks/${id}')).toBe(true)
    expect(ok('/api/v1/sessions/\\(id)/history?limit=5')).toBe(true)
    expect(ok('/api/v1/tasks/${id}/${action}')).toBe(true)
  })

  it('the guessed liveness addresses answer what /api/system/health answers', async () => {
    const { LIVENESS_ALIASES } = await import('../../src/web/routes/system.js')
    const canonical = await (await fetch(`${baseUrl}/api/system/health`)).json() as Record<string, unknown>
    for (const p of LIVENESS_ALIASES) {
      const res = await fetch(`${baseUrl}${p}`)
      expect(res.status, p).toBe(200)
      const body = await res.json() as Record<string, unknown>
      expect(body.status, p).toBe(canonical.status)
    }
    // Exact paths only: the Apple Health routes below them keep their own answers.
    expect((await fetch(`${baseUrl}/api/v1/health/nope`)).status).not.toBe(200)
  })
})
