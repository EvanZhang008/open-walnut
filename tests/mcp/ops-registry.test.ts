/**
 * Registry contract tests (P1) + registry↔server parity (P4).
 *
 * Parity: every op with an HTTP binding must resolve to a REAL route on the
 * server — a rename or removal on either side fails here mechanically instead
 * of surfacing as a runtime 404 in someone's session. The server's route table
 * is read from the live Express app (startServer port 0), so the check is
 * against what actually serves, not against a hand-maintained list.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-ops-registry'))

import { WALNUT_HOME } from '../../src/constants.js'
import { listOps, materializeBinding, executeOp } from '../../src/ops/index.js'

describe('ops registry — shape contract', () => {
  it('every op has a stable snake_case name, title, description, and tags', () => {
    const ops = listOps()
    expect(ops.length).toBeGreaterThanOrEqual(15)
    for (const op of ops) {
      expect(op.name, 'op name style').toMatch(/^[a-z][a-z0-9_]*$/)
      expect(op.title.length, `${op.name} title`).toBeGreaterThan(3)
      // The description is the model's only affordance — enforce substance.
      expect(op.description.length, `${op.name} description`).toBeGreaterThan(40)
      expect(typeof op.tags.readonly).toBe('boolean')
      expect(['allow', 'deny']).toContain(op.tags.remote)
      expect(!!op.bind || !!op.handler, `${op.name} has an executor`).toBe(true)
    }
  })

  it('destructive ops never allow the remote (gateway) transport', () => {
    for (const op of listOps()) {
      if (op.tags.destructive) {
        expect(op.tags.remote, `${op.name} is destructive`).toBe('deny')
      }
    }
  })

  it('the original 10 MCP tool names survive the registry port (public contract)', () => {
    const names = listOps().map((o) => o.name)
    for (const n of [
      'task_list', 'task_get', 'search', 'project_list', 'session_list', 'walnut_status',
      'task_create', 'task_update', 'task_complete', 'task_delete',
    ]) expect(names).toContain(n)
  })
})

describe('ops registry — binding materialization', () => {
  it('fills path params and routes leftovers to query (GET) or body (POST)', () => {
    const get = materializeBinding({ method: 'GET', path: '/tasks' }, { status: 'todo', q: 'x y' })
    expect(get.path).toBe('/tasks?status=todo&q=x+y')
    expect(get.body).toBeUndefined()

    const post = materializeBinding({ method: 'POST', path: '/tasks/:id/complete' }, { id: 'a b' })
    expect(post.path).toBe('/tasks/a%20b/complete')
    expect(post.body).toEqual({})
  })

  it('rejects a missing path param instead of emitting a broken URL', () => {
    expect(() => materializeBinding({ method: 'GET', path: '/tasks/:id' }, {})).toThrow(/:id/)
  })

  it('binding overrides pin args to query/body regardless of method', () => {
    const put = materializeBinding(
      { method: 'PUT', path: '/memory/:doc', body: ['content'] },
      { doc: 'global', content: 'hello' },
    )
    expect(put.path).toBe('/memory/global')
    expect(put.body).toEqual({ content: 'hello' })
  })
})

describe('ops registry — arg validation (executor front door)', () => {
  it('rejects unknown args and type mismatches identically for every surface', async () => {
    const bad = await executeOp('task_get', { id: 'x', nope: 1 })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.message).toContain('Invalid arguments')

    const missing = await executeOp('task_get', {})
    expect(missing.ok).toBe(false)
  })

  it('the api passthrough refuses non-/api/ paths', async () => {
    const r = await executeOp('api', { method: 'GET', path: '/etc/passwd' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toContain('/api/')
  })

  it('unknown op name yields a friendly catalog pointer, not a throw', async () => {
    const r = await executeOp('definitely_not_an_op', {})
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toContain('walnut tools list')
  })
})

// ── P4: parity against the real server route table ──────────────────────────

/**
 * Ask the live Express 5 app whether (method, path) resolves to a REAL route,
 * using Express's OWN layer matchers (layer.matchers[0](path) → {path} | false).
 * This is stronger than string-comparing a hand-extracted route table: the
 * exact matching Express does in production decides parity.
 */
function appMatchesRoute(app: unknown, method: string, probePath: string): boolean {
  const stack = (app as { router?: { stack?: unknown[] } }).router?.stack ?? []
  return matchStack(stack as Array<Record<string, unknown>>, method.toLowerCase(), probePath)
}

function matchStack(stack: Array<Record<string, unknown>>, method: string, probePath: string): boolean {
  for (const layer of stack) {
    const route = layer.route as { methods?: Record<string, boolean> } | undefined
    const matcher = (layer.matchers as Array<(p: string) => false | { path: string }> | undefined)?.[0]
    if (route) {
      if (!route.methods?.[method]) continue
      if (matcher?.(probePath)) return true
      continue
    }
    const handle = layer.handle as { stack?: unknown[] } | undefined
    if (handle?.stack) {
      const hit = matcher?.(probePath)
      if (!hit) continue
      const rest = probePath.slice(hit.path.length) || '/'
      if (matchStack(handle.stack as Array<Record<string, unknown>>, method, rest)) return true
    }
  }
  return false
}

/**
 * Build a concrete probe path for a binding, filling `:params` with a VALID
 * value from the op's own input schema (an enum's first entry when the param
 * is an enum — `GET /memory/:doc` must probe /memory/global, not /memory/probe,
 * because the server routes global/user as literals).
 */
function probePathFor(op: { bind?: { path: string }; input: Record<string, unknown> }): string {
  const bindPath = op.bind!.path
  return `/api/v1${bindPath.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_, name: string) => {
    const schema = op.input[name] as { def?: { type?: string; entries?: Record<string, string> } } | undefined
    const def = schema?.def
    if (def?.type === 'enum' && def.entries) return Object.values(def.entries)[0]
    return 'probe'
  })}`
}

describe('ops registry — parity with the live server (P4)', () => {
  let server: HttpServer
  let stop: (() => Promise<void>) | undefined

  beforeAll(async () => {
    await fs.rm(WALNUT_HOME, { recursive: true, force: true })
    await fs.mkdir(WALNUT_HOME, { recursive: true })
    const { startServer, stopServer } = await import('../../src/web/server.js')
    server = await startServer({ port: 0, dev: true })
    stop = stopServer
  }, 30_000)

  afterAll(async () => {
    await stop?.()
    await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
  })

  it('every bound op resolves to a real route (Express\'s own matchers decide)', async () => {
    const app = server.listeners('request')[0]
    // Sanity: the matcher walk works at all (a known route resolves, junk doesn't).
    expect(appMatchesRoute(app, 'GET', '/api/v1/status')).toBe(true)
    expect(appMatchesRoute(app, 'GET', '/api/v1/definitely-not-a-route-xyz')).toBe(false)

    const misses: string[] = []
    for (const op of listOps()) {
      if (!op.bind) continue
      if (!appMatchesRoute(app, op.bind.method, probePathFor(op))) {
        misses.push(`${op.name}: ${op.bind.method} /api/v1${op.bind.path}`)
      }
    }
    expect(misses, `unbound ops:\n${misses.join('\n')}`).toEqual([])
  })

  it('spot-check: a live call through the executor round-trips', async () => {
    const addr = server.address()
    if (!addr || typeof addr === 'string') throw new Error('no port')
    const r = await executeOp('walnut_status', {}, { apiBase: `http://127.0.0.1:${addr.port}` })
    expect(r.ok).toBe(true)
    if (r.ok) expect((r.result as { mode?: unknown }).mode).toBeDefined()
  })

  it('handler-based ops still hit real endpoints (task_update round-trip)', async () => {
    const addr = server.address()
    if (!addr || typeof addr === 'string') throw new Error('no port')
    const base = `http://127.0.0.1:${addr.port}`
    const created = await executeOp('task_create', { title: 'parity probe' }, { apiBase: base })
    expect(created.ok).toBe(true)
    const id = ((created as { result?: { task?: { id?: string } } }).result?.task?.id) ?? ''
    expect(id).toBeTruthy()
    const updated = await executeOp('task_update', { id, priority: 'backlog' }, { apiBase: base })
    expect(updated.ok).toBe(true)
    const deleted = await executeOp('task_delete', { id }, { apiBase: base })
    expect(deleted.ok).toBe(true)
  })
})
