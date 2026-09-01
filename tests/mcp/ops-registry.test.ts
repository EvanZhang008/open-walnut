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
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-ops-registry'))

import { BUILTIN_SKILLS_DIR, WALNUT_HOME } from '../../src/constants.js'
import { listOps, materializeBinding, executeOp } from '../../src/ops/index.js'
import { PHASE_ORDER } from '../../src/core/phase.js'

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

  it('search ops carry a 30s timeout (embedding cold-start exceeds the 10s default)', () => {
    // Cold semantic search loads the embedding model (measured >10s); the 10s
    // default made "search is warming up" read as "search is broken". Regression
    // guard for the 2026-08-15 star-incident fix.
    for (const name of ['search', 'note_search']) {
      const op = listOps().find((o) => o.name === name)
      expect(op?.timeoutMs, `${name} timeoutMs`).toBe(30_000)
    }
  })

  it('the search op description says sessions are searched by default', () => {
    const op = listOps().find((o) => o.name === 'search')
    expect(op?.description).toMatch(/session transcripts/i)
    expect(op?.description).toMatch(/searched by default/i)
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

  it('keeps a server-root-absolute bind absolute and appends its args as query', () => {
    // task_list binds /api/tasks (the canonical composable-query route), not a
    // /api/v1-relative path — materialization must leave the path untouched and
    // still route every leftover arg to the query string.
    const list = materializeBinding({ method: 'GET', path: '/api/tasks' }, { working_set: true, fields: 'list' })
    expect(list.path).toBe('/api/tasks?working_set=true&fields=list')
    expect(list.body).toBeUndefined()
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

  it('task_list rejects an unknown filter and an out-of-range limit before any transport', async () => {
    const unknown = await executeOp('task_list', { working_set: true, nope: 1 })
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.message).toContain('Invalid arguments for task_list')

    // MAX_QUERY_LIMIT is 200 — the schema, not the route, is the first gate.
    const tooMany = await executeOp('task_list', { limit: 500 })
    expect(tooMany.ok).toBe(false)
    if (!tooMany.ok) expect(tooMany.message).toMatch(/Invalid arguments for task_list.*limit/)
  })

  it('the api passthrough refuses non-/api/ paths', async () => {
    const r = await executeOp('api', { method: 'GET', path: '/etc/passwd' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toContain('/api/')
  })

  it('validates task_update phase against the WHOLE lifecycle — no caller distinction', async () => {
    // The human-vs-AI gate is deliberately gone: both write every phase,
    // COMPLETE included. Only the phase VALUE is still checked, and it is
    // derived from PHASE_ORDER so a rename can't drift out of the schema.
    for (const phase of PHASE_ORDER) {
      const r = await executeOp('task_update', { id: 'x', phase })
      // Reaches transport (no local policy rejection) — the id is fake, so the
      // only possible failure is a server/transport error, never a phase error.
      if (!r.ok) expect(r.message).not.toContain('Invalid arguments')
    }

    // The DELETED phases and a nonsense value must all fail the enum.
    // ('WAIT' joined that list on 2026-08-18 — a blocked task is just TODO.)
    for (const phase of ['HUMAN_VERIFIED', 'POST_WORK_COMPLETED', 'AWAIT_HUMAN_ACTION', 'WAIT', 'NOT_A_PHASE']) {
      const r = await executeOp('task_update', { id: 'x', phase })
      expect(r.ok, `${phase} must be rejected`).toBe(false)
      if (!r.ok) expect(r.message).toContain('Invalid arguments')
    }
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
      // Mirror Layer.match (router/lib/layer.js): a PATH-LESS mount
      // (`router.use(child)`, e.g. the human-inbox router) takes the
      // `this.slash` fast path — ANY path matches and none of it is consumed —
      // without ever consulting matchers[0]. Probing the matcher alone made
      // every route inside such a child read as unbound.
      let rest = probePath
      if (!(layer as { slash?: boolean }).slash) {
        const hit = matcher?.(probePath)
        if (!hit) continue
        rest = probePath.slice(hit.path.length) || '/'
        if (!rest.startsWith('/')) rest = `/${rest}`
      }
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
  // Mirror the executor: a bind path that starts with /api/ is server-root
  // absolute (task_list → GET /api/tasks); everything else is /api/v1-relative.
  const prefix = bindPath.startsWith('/api/') ? '' : '/api/v1'
  return `${prefix}${bindPath.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_, name: string) => {
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
    await fs.mkdir(path.join(BUILTIN_SKILLS_DIR, 'walnut-self-knowledge'), { recursive: true })
    await fs.copyFile(
      path.resolve('src/data/skills/walnut-self-knowledge/SKILL.md'),
      path.join(BUILTIN_SKILLS_DIR, 'walnut-self-knowledge', 'SKILL.md'),
    )
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

  // Replaces the old caller-policy test: the human-vs-AI gate is gone, so the
  // contract to pin is the opposite one — every caller drives the FULL
  // lifecycle through the ops surface, COMPLETE included, and can move a task
  // back out of COMPLETE. (The terminal-phase guard survives only for the
  // background session machine, which does not run through here.)
  it('a phase write drives the whole lifecycle, COMPLETE included', async () => {
    const addr = server.address()
    if (!addr || typeof addr === 'string') throw new Error('no port')
    const base = `http://127.0.0.1:${addr.port}`
    const created = await executeOp('task_create', { title: 'lifecycle probe' }, { apiBase: base })
    expect(created.ok).toBe(true)
    const id = ((created as { result?: { task?: { id?: string } } }).result?.task?.id) ?? ''
    expect(id).toBeTruthy()

    const phaseOf = async (): Promise<string | undefined> => {
      const detail = await executeOp('task_get', { id }, { apiBase: base })
      expect(detail.ok).toBe(true)
      return detail.ok ? (detail.result as { task?: { phase?: string } }).task?.phase : undefined
    }

    // The v1 PATCH used to reject phase=COMPLETE outright ("non-COMPLETE task
    // phase"); it must now accept it like any other phase.
    expect((await executeOp('task_update', { id, phase: 'COMPLETE' }, { apiBase: base })).ok).toBe(true)
    expect(await phaseOf()).toBe('COMPLETE')

    // …and back out again — nothing is one-way and nothing is reserved.
    expect((await executeOp('task_update', { id, phase: 'IN_PROGRESS' }, { apiBase: base })).ok).toBe(true)
    expect(await phaseOf()).toBe('IN_PROGRESS')

    expect((await executeOp('task_complete', { id }, { apiBase: base })).ok).toBe(true)
    expect(await phaseOf()).toBe('COMPLETE')
  })

  it('reads a shipped skill by directory name', async () => {
    const addr = server.address()
    if (!addr || typeof addr === 'string') throw new Error('no port')
    const result = await executeOp(
      'skill_read',
      { dirName: 'walnut-self-knowledge' },
      { apiBase: `http://127.0.0.1:${addr.port}` },
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect((result.result as { skill?: { content?: string } }).skill?.content)
        .toContain('# Walnut self-knowledge')
    }
  })

  it('resolves task prefixes inside pin and tier routes without a detail round-trip', async () => {
    const addr = server.address()
    if (!addr || typeof addr === 'string') throw new Error('no port')
    const base = `http://127.0.0.1:${addr.port}`
    const created = await executeOp('task_create', { title: 'focus op probe' }, { apiBase: base })
    expect(created.ok).toBe(true)
    const id = ((created as { result?: { task?: { id?: string } } }).result?.task?.id) ?? ''
    const prefix = id.slice(0, -1)

    expect((await executeOp('task_pin_set', { id: prefix, pinned: true }, { apiBase: base })).ok).toBe(true)
    const tier = await executeOp('task_focus_tier_set', { id: prefix, tier: 'focus' }, { apiBase: base })
    expect(tier.ok).toBe(true)
    if (tier.ok) expect((tier.result as { focus_tasks?: string[] }).focus_tasks).toContain(id)
    expect((await executeOp('task_pin_set', { id: prefix, pinned: false }, { apiBase: base })).ok).toBe(true)
  })

  // The notes ops an agent actually strings together (2026-09-01 session): find
  // a note, read it by whichever field the search gave, change one line, and be
  // told what to do when the write is refused.
  it('notes: create → read by path OR id → partial edit → conflict guidance', async () => {
    const addr = server.address()
    if (!addr || typeof addr === 'string') throw new Error('no port')
    const base = `http://127.0.0.1:${addr.port}`
    const notePath = 'ops-probe/Edit probe'

    const created = await executeOp(
      'note_write',
      { path: notePath, content: '# Edit probe\n\n- one\n- two\n' },
      { apiBase: base },
    )
    expect(created.ok, created.ok ? '' : created.message).toBe(true)

    // A6-adjacent: creating over an existing note used to say only "Note
    // already exists", which reads as a dead end instead of a missing argument.
    const dup = await executeOp('note_write', { path: notePath, content: 'x' }, { apiBase: base })
    expect(dup.ok).toBe(false)
    if (!dup.ok) {
      expect(dup.message).toContain('note exists')
      expect(dup.message).toContain('expectedHash from note_read')
    }

    const read = await executeOp('note_read', { path: notePath }, { apiBase: base })
    expect(read.ok, read.ok ? '' : read.message).toBe(true)
    const first = read.ok ? (read.result as { content: string; contentHash: string }) : null
    expect(first?.content).toContain('- one')

    // Read by the frontmatter id the create stamped (what note_search returns).
    const stampedId = /^id:\s*(\S+)/m.exec(first?.content ?? '')?.[1] ?? ''
    expect(stampedId, 'create stamps a frontmatter id').toMatch(/^n_/)
    const { reconcileNoteNow } = await import('../../src/core/notes-indexer.js')
    await reconcileNoteNow(`${notePath}.md`)
    const byId = await executeOp('note_read', { id: stampedId }, { apiBase: base })
    expect(byId.ok, byId.ok ? '' : byId.message).toBe(true)
    if (byId.ok) expect((byId.result as { path: string }).path).toBe(`${notePath}.md`)

    // A5: partial edit, no whole body on the wire.
    const edited = await executeOp(
      'note_edit',
      { path: notePath, old_str: '- two', new_str: '- two (done)', expectedHash: first?.contentHash },
      { apiBase: base },
    )
    expect(edited.ok, edited.ok ? '' : edited.message).toBe(true)
    if (edited.ok) expect((edited.result as { replacements: number }).replacements).toBe(1)

    const after = await executeOp('note_read', { path: notePath }, { apiBase: base })
    if (after.ok) {
      const body = (after.result as { content: string }).content
      expect(body).toContain('- two (done)')
      expect(body).toContain('- one')
    }

    // The stale hash is now wrong: the edit must refuse and say what to do.
    const stale = await executeOp(
      'note_edit',
      { path: notePath, old_str: '- one', new_str: '- ONE', expectedHash: first?.contentHash },
      { apiBase: base },
    )
    expect(stale.ok).toBe(false)
    if (!stale.ok) {
      expect(stale.message).toContain('changed since you read it')
      expect(stale.message).toContain('note_read')
    }

    // A missing / ambiguous old_str names the case instead of writing garbage.
    const missing = await executeOp(
      'note_edit',
      { path: notePath, old_str: 'text that is not there', new_str: 'x' },
      { apiBase: base },
    )
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.message).toContain('old_str not found')

    const twice = await executeOp('note_edit', { path: notePath, old_str: '-', new_str: '*' }, { apiBase: base })
    expect(twice.ok).toBe(false)
    if (!twice.ok) expect(twice.message).toMatch(/appears \d+ times/)

    const all = await executeOp(
      'note_edit',
      { path: notePath, old_str: '- ', new_str: '* ', replace_all: true },
      { apiBase: base },
    )
    expect(all.ok, all.ok ? '' : all.message).toBe(true)
    if (all.ok) expect((all.result as { replacements: number }).replacements).toBeGreaterThan(1)

    // Neither path nor id is a usage error, not a mystery 400.
    const neither = await executeOp('note_edit', { old_str: 'a', new_str: 'b' }, { apiBase: base })
    expect(neither.ok).toBe(false)
    if (!neither.ok) expect(neither.message).toContain('pass path')
  })

  it('note_attach saves an image beside the note and returns its vault path', async () => {
    const addr = server.address()
    if (!addr || typeof addr === 'string') throw new Error('no port')
    const base = `http://127.0.0.1:${addr.port}`
    const notePath = 'ops-probe/Attach probe'
    expect((await executeOp('note_write', { path: notePath, content: '# Attach probe\n' }, { apiBase: base })).ok)
      .toBe(true)

    // 1x1 transparent PNG.
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
    const attached = await executeOp(
      'note_attach',
      { notePath, data: png, mediaType: 'image/png' },
      { apiBase: base },
    )
    expect(attached.ok, attached.ok ? '' : attached.message).toBe(true)
    if (attached.ok) {
      const r = attached.result as { ok: boolean; path: string; name: string }
      expect(r.ok).toBe(true)
      expect(r.path).toContain('ops-probe/_attachment/')
      expect(r.name).toMatch(/\.png$/)
    }

    const bad = await executeOp(
      'note_attach',
      { notePath, data: png, mediaType: 'image/tiff' },
      { apiBase: base },
    )
    expect(bad.ok).toBe(false)
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
