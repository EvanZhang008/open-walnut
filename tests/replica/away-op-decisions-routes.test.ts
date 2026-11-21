/**
 * Ratchet: a `host` row of the decision table (src/replica/away-op-decisions.ts) with no `by`
 * names an op that a host's follower really answers. The route table alone cannot tell: a route
 * it calls a read can refuse in its own handler on every follower (`leaderOnly`, `vault_not_here`,
 * a 503), and tools.list and walnut_status would then promise an op that never answers here.
 *
 * The real startServer boots as a host replica with `host-local-calls` (as
 * route-table-coverage.test.ts boots it), the leader away, and every GET such an op reaches
 * (its binding and the literal paths its handler calls, tests/replica/away-op-routes.ts) is
 * called as this host's own call (the in-process self-call credential and a session id). A
 * route answers unless it refuses as a follower: 503, or a code that says the leader holds it.
 * A not-found or a bad request for the probe's made-up ids is an answer (the route ran).
 * An op whose answered routes include a write (journaled by its row) is not probed, nor one only
 * a session on the Mac may run (localHostGateway: the executor refuses it before any route, on
 * the leader too; its why must say so).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'
import { useHostReplicaEnv, type HostReplicaEnv } from '../helpers/replica-host-env.js'
import { listOps } from '../../src/ops/index.js'
import { AWAY_OP_DECISIONS } from '../../src/replica/away-op-decisions.js'
import { routesOf, tableAnswers } from './away-op-routes.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-replica-op-routes'))

/** Answers that mean "only the leader has this", whatever the status. */
const REFUSAL_CODES = new Set(['needs_leader', 'leader_only', 'vault_not_here', 'secrets_need_mac', 'not_supported_cloud', 'not_running', 'unavailable'])
/** The probe's replica holds no copies yet: a route that reads one answers `copy_unreadable`, which a replica with its copies does not. */
const NO_COPY_YET = 'copy_unreadable'
const SID = 'aaaaaaaa-1111-4111-8111-00000000c4c4'

let env: HostReplicaEnv | null = null
let stopServer: (() => Promise<void>) | null = null
let root = ''
let token = ''
let savedCaps: string | undefined

beforeAll(async () => {
  const c = await import('../../src/constants.js')
  env = useHostReplicaEnv(c.WALNUT_HOME)
  savedCaps = process.env.WALNUT_CAPABILITIES
  process.env.WALNUT_CAPABILITIES = 'host-local-calls'
  const role = await import('../../src/core/server-role.js')
  role._resetServerRoleForTesting()
  expect(role.isHostReplica()).toBe(true)
  const server = await import('../../src/web/server.js')
  await server.startServer({ port: 0, dev: true })
  stopServer = server.stopServer
  const self = await import('../../src/lib/self-api-root.js')
  root = self.getSelfApiRoot() ?? ''
  token = self.getSelfCallToken() ?? ''
  expect(root).not.toBe('')
  expect(token).not.toBe('')
}, 120_000)

afterAll(async () => {
  try { await stopServer?.() } catch { /* already down */ }
  env?.restore()
  if (savedCaps === undefined) delete process.env.WALNUT_CAPABILITIES
  else process.env.WALNUT_CAPABILITIES = savedCaps
  ;(await import('../../src/core/server-role.js'))._resetServerRoleForTesting()
}, 60_000)

/** One GET as this host's own call: whether the follower answered it, and what it said. */
async function probe(p: string): Promise<{ answered: boolean; said: string }> {
  const url = `${root.replace(/\/$/, '')}${p}`.replace(/\/:[A-Za-z_]+\+?/g, '/probe')
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 10_000)
  try {
    const r = await fetch(url, { headers: { authorization: `Bearer ${token}`, 'x-walnut-caller-sid': SID, connection: 'close' }, signal: ctl.signal })
    const text = await r.text()
    let code = ''
    let why = ''
    try {
      const b = JSON.parse(text) as { code?: unknown; status?: unknown; why?: unknown; error?: unknown }
      const e = b.error && typeof b.error === 'object' ? b.error as { code?: unknown; why?: unknown } : null
      const pick = (...v: unknown[]) => (v.find((x) => typeof x === 'string' && x) as string | undefined) ?? ''
      code = pick(b.code, e?.code, typeof b.error === 'string' && /^[a-z_]+$/.test(b.error) ? b.error : undefined, b.status)
      why = pick(b.why, e?.why)
    } catch { /* not json */ }
    const refused = why !== NO_COPY_YET && (r.status === 501 || r.status === 503 || REFUSAL_CODES.has(code))
    return { answered: !refused, said: `${r.status}${code ? ` ${code}` : ''}${why ? ` (${why})` : ''}` }
  } catch (err) {
    // A route that runs past the probe's wait ran: it is not a refusal.
    return { answered: true, said: err instanceof Error ? err.name : String(err) }
  } finally {
    clearTimeout(timer)
  }
}

describe('a `host` row names an op the follower answers, not one every follower refuses', () => {
  it('each such op has a GET this host\'s own call gets an answer from', async () => {
    const wrong: string[] = []
    let probed = 0
    for (const op of listOps({ includeDeprecated: true })) {
      const d = AWAY_OP_DECISIONS[op.name]
      if (!d || d.answer !== 'host' || d.by) continue
      // Refused for any session off the Mac by the executor, leader or follower (localHostGateway): its why says so.
      if (op.tags.localHostGateway) { if (!/localHostGateway/.test(d.why)) wrong.push(`${op.name}: localHostGateway, its why must say a session off the Mac is refused`); continue }
      // A path the handler builds with an expression the route pattern cannot read is left out.
      const answered = routesOf(op).filter(([m, p]) => !p.includes('$') && tableAnswers(m, p))
      if (!answered.length || answered.some(([m]) => m !== 'GET')) continue
      const said: string[] = []
      let ok = false
      for (const [, p] of answered) {
        probed++
        const r = await probe(p)
        said.push(`GET ${p}: ${r.said}`)
        if (r.answered) { ok = true; break }
      }
      if (!ok) wrong.push(`${op.name}: host, but every follower refuses it (${said.join('; ')}): mark it leader with that reason`)
    }
    expect(probed).toBeGreaterThan(30)
    expect(wrong).toEqual([])
  }, 300_000)
})
