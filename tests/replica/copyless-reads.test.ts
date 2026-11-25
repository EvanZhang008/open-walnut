/**
 * A host's Walnut service that keeps no copy (WALNUT_COPIES=none) answers, while the leader is
 * away, only the reads whose rows are its slice's or its own (src/replica/copyless-reads.ts); the
 * dispatcher answers every other away read `needs_leader {why:'no_copy'}` at once.
 *
 * Ratchet over every op the follower answers away (src/replica/away-op-decisions.ts, enumerated
 * from the registry): each op whose routes include an away read is named below as answered from
 * the slice or as no_copy, and the route table's paths agree. A new op with an away read fails
 * here until it is decided (the copyless design page's read table).
 */
import http from 'node:http'
import type net from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { listOps } from '../../src/ops/index.js'
import { AWAY_OP_DECISIONS } from '../../src/replica/away-op-decisions.js'
import { classify, isRead } from '../../src/replica/route-table.js'
import { readsWithoutCopy } from '../../src/replica/copyless-reads.js'
import { createDispatcher, type DispatchDeps } from '../../src/replica/dispatch.js'
import { NO_COPY_MESSAGE } from '../../src/core/replication/needs-leader.js'
import { NEEDS_LEADER_REASONS } from '../../web/src/api/leader-presence.js'
import { COPIES_ENV, keepsCopies, keepsNoCopy } from '../../src/core/replication/kinds/gate.js'
import { _resetServerRoleForTesting } from '../../src/core/server-role.js'
import { awayOf, buildsPaths, routesOf } from './away-op-routes.js'

/** Answered from the slice (or from this server's own records), as today's daemon answers its reads. */
const FROM_SLICE = [
  'task_get', 'task_list', 'task_get_bulk', 'task_sessions', 'task_history', 'session_list', 'request_get',
  'open_items', 'walnut_status', 'trigger_list', 'op_result', 'transfer_get', 'task_dir',
  // A write whose first read is the caller (`/me`): that read answers, the write journals.
  'agent_memory_write',
]
/** No copy of their rows here: the leader keeps them. `search` is the one the leader may still turn into a slice read. */
const NO_COPY: Record<string, string> = {
  search: 'the leader\'s hybrid search; a slice answer needs a second keyword engine (listed for the leader as costly)',
  memory_read: 'the memory copy is not sent to a host that keeps no copy',
  note_search: 'the notes copy is not sent there',
  skill_read: 'the skills copy is not sent there',
  agent_memory_read: 'a node\'s memory folder is the leader\'s',
  brief_read: 'a Brief is the leader\'s (its path is built after the caller read)',
  agent_skill_read: 'a node\'s skills are the leader\'s',
  app_state: 'the person\'s app state is the leader\'s',
  tag_display_list: 'tag display settings are the leader\'s',
  folder_list: 'folders are not in the slice',
  thread_get: 'threads are the leader\'s',
  project_list: 'projects are the leader\'s', project_metadata_get: 'projects are the leader\'s',
  status_check: 'the org is the leader\'s', org_get: 'the org is the leader\'s', topic_list: 'topics are the leader\'s', topic_read: 'topics are the leader\'s',
  triage_rule_list: 'triage rules are the leader\'s', trigger_templates: 'templates are the leader\'s', plugin_settings: 'the config is the leader\'s',
  health_status: 'kept on the leader', health_sleep: 'kept on the leader', health_daily: 'kept on the leader', health_series: 'kept on the leader',
  health_samples: 'kept on the leader', health_recordings: 'kept on the leader', places_status: 'kept on the leader', places_visits: 'kept on the leader',
  time_timeline: 'kept on the leader', mcp_servers: 'the config is the leader\'s', mcp_tools: 'the config is the leader\'s',
  host_profile_get: 'the fleet is the leader\'s', browser_status: 'the browser is the leader\'s', workspace_providers: 'the config is the leader\'s',
  hint_list: 'hints are the leader\'s', feature_node_connections: 'the org is the leader\'s',
}

/** A read a handler makes through a path the route helper cannot read out of its source (a template with quotes in it). */
const BUILT_READS: Record<string, string> = { brief_read: '/api/v1/tasks/x/brief' }

/** Each op the follower answers away and the away reads its routes make (a local row is answered before the away rule). */
function awayReads(): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const op of listOps({ includeDeprecated: true })) {
    const d = AWAY_OP_DECISIONS[op.name]
    if (!d || d.answer === 'leader') continue
    // A handler's template tail (`${q}`) is no part of the path.
    const reads = routesOf(op).map(([m, p]) => [m, p.replace(/\$\{.*$/, '')] as const)
      .filter(([m, p]) => isRead(m) && awayOf(m, p) === 'read' && classify(m, p).cls !== 'local').map(([, p]) => p)
    if (BUILT_READS[op.name]) reads.push(BUILT_READS[op.name]!)
    if (reads.length) out.set(op.name, reads)
  }
  return out
}

describe('which away reads a service with no copy answers', () => {
  it('every op with an away read is decided, and its routes agree with the decision', () => {
    const wrong: string[] = []
    for (const [name, paths] of awayReads()) {
      const here = paths.filter((p) => readsWithoutCopy(p))
      if (FROM_SLICE.includes(name)) { if (here.length !== paths.length) wrong.push(`${name}: answered from the slice, but ${paths.filter((p) => !readsWithoutCopy(p)).join(', ')} answers no_copy`) }
      else if (NO_COPY[name]) {
        // At least one read of the leader's data: a route that is no slice read, or a path the handler builds.
        const op = listOps({ includeDeprecated: true }).find((o) => o.name === name)!
        if (here.length === paths.length && !buildsPaths(op)) wrong.push(`${name}: no_copy, but every read it makes (${paths.join(', ')}) is a slice read`)
      }
      else wrong.push(`${name}: not decided (${paths.join(', ')}); add it to FROM_SLICE or NO_COPY`)
    }
    expect(wrong).toEqual([])
    const stale = [...FROM_SLICE, ...Object.keys(NO_COPY)].filter((n) => !awayReads().has(n))
    expect(stale, 'decided ops that make no away read any more').toEqual([])
  })

  it('the routes the write ops read first are slice reads: the caller, a task, a Board and its owner', () => {
    for (const p of ['/api/v1/me', '/api/v1/tasks/task-1', '/api/tasks/task-1', '/api/v1/tasks/task-1/board', '/api/v1/tasks/task-1/board/owner', '/api/v1/focus/tasks', '/api/v1/routines']) {
      expect(readsWithoutCopy(p), p).toBe(true)
    }
    for (const p of ['/api/v1/tasks/task-1/agent-memory', '/api/v1/tasks/meta/tag-display', '/api/tasks/groups', '/api/v1/search', '/api/v1/human-inbox', '/api/v1/notes/search', '/api/v1/me/app-state']) {
      expect(readsWithoutCopy(p), p).toBe(false)
    }
  })

  it('a route that names one task answers only for a task the slice holds (its id or the start of one)', () => {
    const slice = ['task-1', 'mwvabc-1234']
    const holds = (id: string) => slice.some((t) => t.startsWith(id))
    for (const p of ['/api/v1/tasks/task-1', '/api/tasks/mwvabc', '/api/v1/tasks/task-1/board/owner', '/api/sessions/task/task-1', '/api/v1/tasks/task-1/sessions']) {
      expect(readsWithoutCopy(p, holds), p).toBe(true)
    }
    for (const p of ['/api/v1/tasks/task-9', '/api/tasks/other', '/api/v1/tasks/task-9/board', '/api/sessions/task/task-9']) {
      expect(readsWithoutCopy(p, holds), p).toBe(false)
    }
    // A list or the caller is not one task: the slice answers it whatever it holds.
    expect(readsWithoutCopy('/api/v1/tasks', () => false)).toBe(true)
    expect(readsWithoutCopy('/api/v1/me', () => false)).toBe(true)
  })

  it('no_copy has words in the console\'s reasons', () => {
    expect(NEEDS_LEADER_REASONS.no_copy).toBeTruthy()
  })
})

describe('the spec\'s word that no copy is kept (kinds/gate.ts)', () => {
  const saved = { role: process.env.WALNUT_ROLE, copies: process.env[COPIES_ENV] }
  afterAll(() => {
    for (const [k, v] of [['WALNUT_ROLE', saved.role], [COPIES_ENV, saved.copies]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    _resetServerRoleForTesting()
  })
  it('a host replica program with WALNUT_COPIES=none keeps no copy of any kind; without it, every kind; anywhere else it says nothing', () => {
    process.env.WALNUT_ROLE = 'replica'
    process.env[COPIES_ENV] = 'none'
    _resetServerRoleForTesting()
    expect(keepsNoCopy()).toBe(true)
    expect(keepsCopies()).toBe(false)
    expect(keepsCopies('boards')).toBe(false)
    delete process.env[COPIES_ENV]
    expect(keepsNoCopy()).toBe(false)
    expect(keepsCopies('boards')).toBe(true)
    delete process.env.WALNUT_ROLE
    process.env[COPIES_ENV] = 'none'
    _resetServerRoleForTesting()
    expect(keepsNoCopy()).toBe(false)
  })
})

describe('through the dispatcher, the leader away, no copy kept', () => {
  const servers: http.Server[] = []
  let port = 0
  let routed = 0
  beforeAll(async () => {
    const deps: DispatchDeps = {
      route: () => ({ kind: 'alone', why: 'mac-away' }),
      asOf: () => 0,
      connect: async () => { throw new Error('the leader is away') },
      suspect: () => {},
      ownUpgrade: (_req, socket) => { socket.end('HTTP/1.1 418 x\r\n\r\n') },
      log: () => {},
      awayReadHere: (req) => readsWithoutCopy((req.url ?? '').split('?')[0] ?? ''),
    }
    const dispatcher = createDispatcher(deps)
    const server = http.createServer((req, res) => dispatcher.middleware(req, res, () => {
      routed++
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"task":{"id":"task-1"}}')
    }))
    servers.push(server)
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    port = (server.address() as net.AddressInfo).port
  })
  afterAll(async () => { await Promise.all(servers.map((s) => new Promise((r) => s.close(r)))) })

  async function get(p: string): Promise<{ status: number; body: { error?: { code?: string; why?: string; message?: string } }; ms: number }> {
    const t0 = Date.now()
    const r = await fetch(`http://127.0.0.1:${port}${p}`)
    return { status: r.status, body: await r.json() as never, ms: Date.now() - t0 }
  }

  it('a slice read runs its route; any other read answers no_copy at once, never reaching a route', async () => {
    const before = routed
    expect((await get('/api/v1/tasks/task-1?fields=note')).status).toBe(200)
    expect(routed).toBe(before + 1)
    for (const p of ['/api/v1/memory/global', '/api/v1/search?q=x', '/api/v1/human-inbox', '/api/v1/tasks/task-1/agent-memory']) {
      const r = await get(p)
      expect(r.status, p).toBe(503)
      expect(r.body.error).toMatchObject({ code: 'needs_leader', why: 'no_copy', message: NO_COPY_MESSAGE })
      expect(r.ms, p).toBeLessThan(1_000)
    }
    expect(routed).toBe(before + 1)
  })
})
