/**
 * A request a page says failed is named by the route the server would take for it, even when it
 * never reached the server (2026-11-22: requests rejected in the page's connection queue right
 * after a restart all read "GET unknown request rejected in the page", 19 in 6 hours, because the
 * real-use monitor knew only templates answered since the boot).
 *
 * The class: every route the server mounts. Counted from the source the way the shadow ratchet
 * counts them (every router server.ts mounts on /api/v1), each gets a sample URL, and each must
 * come back as its template with none of the sample's values in it.
 */
import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import express, { Router } from 'express'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('route-template-of'))

const { routeTemplateOf } = await import('../../src/web/route-template-of.js')
const { TemplateMatcher, pageErrorKind } = await import('../../src/core/usage-watch/normalize.js')

const WEB = path.resolve(__dirname, '../../src/web')
const SAMPLE = 'zq7sample42'

describe('routeTemplateOf', () => {
  const app = express()
  const items = Router()
  items.get('/items/:id', (_q, r) => { r.end() })
  items.post('/items', (_q, r) => { r.end() })
  const inner = Router()
  inner.get('/deep/:name', (_q, r) => { r.end() })
  items.use('/nested', inner)
  app.use((_q, _r, n) => n())
  app.use('/api/plugins/:pluginId', items)
  app.get('/api/routines/:id', (_q, r) => { r.end() })
  app.get('/api/routines/search', (_q, r) => { r.end() })

  it('names a request by the route Express would take, mounts and nesting included', () => {
    expect(routeTemplateOf(app.router, 'GET', '/api/routines/mwo4xvsv-ec9a?x=1')).toBe('GET /api/routines/:id')
    // First registered wins, as in Express: the literal after the parameter never answers.
    expect(routeTemplateOf(app.router, 'GET', '/api/routines/search')).toBe('GET /api/routines/:id')
    expect(routeTemplateOf(app.router, 'GET', '/api/plugins/mail/items/abc')).toBe('GET /api/plugins/mail/items/:id')
    expect(routeTemplateOf(app.router, 'GET', '/api/plugins/mail/nested/deep/x')).toBe('GET /api/plugins/mail/nested/deep/:name')
    expect(routeTemplateOf(app.router, 'POST', '/api/plugins/mail/items')).toBe('POST /api/plugins/mail/items')
    expect(routeTemplateOf(app.router, 'HEAD', '/api/routines/a')).toBe('HEAD /api/routines/:id')
  })

  it('names nothing no route takes, and changes nothing on the router', () => {
    expect(routeTemplateOf(app.router, 'DELETE', '/api/routines/a')).toBeNull()
    expect(routeTemplateOf(app.router, 'GET', '/api/notes/My%20private%20file.md')).toBeNull()
    expect(routeTemplateOf(app.router, 'GET', 'not-a-path')).toBeNull()
    expect(routeTemplateOf(null, 'GET', '/api/routines/a')).toBeNull()
    // The `/api/routines/:id` layer matched above, yet holds no params or path of ours.
    const layer = (app.router as unknown as { stack: Array<{ params?: unknown; path?: unknown }> }).stack.at(-2)!
    expect([layer.params, layer.path]).toEqual([undefined, undefined])
  })

  it('a page failure the server never answered is named by its route, never by its values', () => {
    const t = new TemplateMatcher()
    expect(pageErrorKind('[api] GET /api/routines/mwo4xvsv-ec9a rejected after 60000ms in the connection queue (pool saturated)', '', t)?.kind)
      .toBe('GET unknown request rejected in the page')
    t.resolveWith((m, u) => routeTemplateOf(app.router, m, u))
    expect(pageErrorKind('[api] GET /api/routines/mwo4xvsv-ec9a rejected after 60000ms in the connection queue (pool saturated)', '', t))
      .toEqual({ kind: 'GET /api/routines/:id rejected in the page', route: 'GET /api/routines/:id', request: true, how: 'rejected' })
    // A path no route takes stays unknown (it may hold a file name).
    expect(pageErrorKind('[api] GET /api/notes/My%20private%20file.md FAILED after 5ms', '', t)?.kind).toBe('GET unknown request failed in the page')
  })

  it('every /api/v1 route the server mounts is named, with none of the URL in its name', async () => {
    const server = fs.readFileSync(path.join(WEB, 'server.ts'), 'utf8')
    // Both ways server.ts mounts a router: a name it imported, and `(await import('./routes/x.js')).yRouter`.
    const mounted: Array<{ name: string; file: string }> = []
    for (const m of server.matchAll(/app\.use\('\/api\/v1',\s*(\w+)\)/g)) {
      const imp = new RegExp(String.raw`import\s*\{[^}]*\b${m[1]}\b[^}]*\}\s*from\s*'(\./routes/[^']+)'`).exec(server)
      if (!imp) throw new Error(`no import for ${m[1]} in server.ts`)
      mounted.push({ name: m[1], file: imp[1] })
    }
    for (const m of server.matchAll(/app\.use\('\/api\/v1',\s*\(await import\('(\.\/routes\/[^']+)'\)\)\.(\w+)\)/g)) mounted.push({ name: m[2], file: m[1] })
    expect(mounted.filter((m) => m.file.includes('usage-watch-v1')).length).toBe(1)
    const v1 = express()
    const routes: Array<{ method: string; path: string }> = []
    for (const { name, file } of mounted) {
      const mod = await import(path.join(WEB, file.replace(/\.js$/, '.ts'))) as Record<string, unknown>
      const router = mod[name] as Router & { stack?: Array<{ route?: { path: unknown; methods: Record<string, boolean> } }> }
      v1.use('/api/v1', router)
      for (const layer of router.stack ?? []) {
        if (!layer.route || typeof layer.route.path !== 'string') continue
        for (const m of Object.keys(layer.route.methods)) if (layer.route.methods[m] && m !== '_all') routes.push({ method: m.toUpperCase(), path: layer.route.path })
      }
    }
    expect(routes.length).toBeGreaterThan(50)
    const unnamed: string[] = []
    const leaked: string[] = []
    for (const r of routes) {
      const url = `/api/v1${r.path.replace(/:\w+/g, SAMPLE).replace(/\*\w*/g, `${SAMPLE}/x`)}`
      const name = routeTemplateOf(v1.router, r.method, url)
      if (!name) unnamed.push(`${r.method} ${r.path}`)
      else if (name.includes(SAMPLE)) leaked.push(`${r.method} ${r.path} -> ${name}`)
    }
    expect(unnamed).toEqual([])
    expect(leaked).toEqual([])
  }, 120_000)
})
