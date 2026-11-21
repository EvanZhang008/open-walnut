/**
 * Ratchet: an op the decision table marks `leader` (src/replica/away-op-decisions.ts) is the
 * follower's final answer while the leader is away, never handed back to the daemon's own offline
 * code (follower-gateway-core.ts FALLS_BACK). The real startServer boots as a host replica with
 * `host-local-calls`, the leader away, and each such op runs through local-calls.ts as this host's
 * own session call: the capability router, the executor, this replica's own routes. Its answer must
 * be a refusal that is not a hand-back: a `needs_leader` marked `detail.final`, or another code.
 * A new op marked `leader` passes only if it does the same; an op whose made-up arguments its
 * schema refuses (bad_request) names the arguments the probe must send (ARGS).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createMockConstants } from '../helpers/mock-constants.js'
import { useHostReplicaEnv, type HostReplicaEnv } from '../helpers/replica-host-env.js'
import { listOps } from '../../src/ops/index.js'
import { AWAY_OP_DECISIONS } from '../../src/replica/away-op-decisions.js'
import { AWAY_NOT_FINAL, awayReply, createLocalCalls } from '../../src/replica/local-calls.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-replica-away-final'))

/** A session id per call: one caller's write brake (throttled) never stands in for an op's answer. */
const sidOf = (n: number) => `aaaaaaaa-1111-4111-8111-${String(n).padStart(12, '0')}`
/** The codes the daemon takes a session's call back on (follower-gateway-core.ts FALLS_BACK). */
const FALLS_BACK = ['needs_leader', 'unsupported_replica', 'unsupported_version']
/** Arguments the probe cannot make up from an op's schema: its write form, where the bare one only lists. */
const ARGS: Record<string, Record<string, unknown>> = {
  org_duty_set: { task_id: 'probe-task', duty: 'reflection', on: true },
}
/** Ids of Walnut's own shapes, for a string field with a pattern: the first one it matches. */
const PATTERNED = ['qm-probe', 'rq-abcdef', 'th-abcdef', 'tm-abcdef', 'tp-abcdef123456', 'sa-abcdef', 'xg-probe', 'a'.repeat(64)]

type Schema = { type?: string | string[]; enum?: unknown[]; const?: unknown; anyOf?: Schema[]; oneOf?: Schema[]; items?: Schema; minItems?: number; properties?: Record<string, Schema>; required?: string[]; minimum?: number; minLength?: number; pattern?: string }

/** A value the schema takes, made up (null: none it can make). */
function sample(s: Schema, key: string): unknown {
  if (s.const !== undefined) return s.const
  if (s.enum?.length) return s.enum[0]
  const alt = s.anyOf ?? s.oneOf
  if (alt?.length) return sample(alt.find((a) => a.type !== 'null') ?? alt[0]!, key)
  const type = Array.isArray(s.type) ? s.type.find((t) => t !== 'null') : s.type
  if (type === 'string' && s.pattern) return PATTERNED.find((v) => new RegExp(s.pattern!).test(v)) ?? `probe-${key}`
  if (type === 'string') return `probe-${key}`.padEnd(s.minLength ?? 0, 'x')
  if (type === 'number' || type === 'integer') return Math.max(1, s.minimum ?? 1)
  if (type === 'boolean') return false
  if (type === 'array') return s.minItems ? [sample(s.items ?? {}, key)] : []
  if (type === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of s.required ?? []) out[k] = sample(s.properties?.[k] ?? {}, k)
    return out
  }
  return `probe-${key}`
}

function argsOf(op: ReturnType<typeof listOps>[number]): Record<string, unknown> {
  if (ARGS[op.name]) return ARGS[op.name]!
  const schema = z.toJSONSchema(z.object(op.input), { target: 'draft-7', io: 'input' }) as Schema
  return sample(schema, op.name) as Record<string, unknown>
}

let env: HostReplicaEnv | null = null
let stopServer: (() => Promise<void>) | null = null
let savedCaps: string | undefined

beforeAll(async () => {
  const c = await import('../../src/constants.js')
  env = useHostReplicaEnv(c.WALNUT_HOME)
  savedCaps = process.env.WALNUT_CAPABILITIES
  process.env.WALNUT_CAPABILITIES = 'host-local-calls'
  const role = await import('../../src/core/server-role.js')
  role._resetServerRoleForTesting()
  expect(role.isHostReplica()).toBe(true)
  expect(role.leaderAnswers()).toBe(false)
  const server = await import('../../src/web/server.js')
  await server.startServer({ port: 0, dev: true })
  stopServer = server.stopServer
}, 120_000)

afterAll(async () => {
  try { await stopServer?.() } catch { /* already down */ }
  env?.restore()
  if (savedCaps === undefined) delete process.env.WALNUT_CAPABILITIES
  else process.env.WALNUT_CAPABILITIES = savedCaps
  ;(await import('../../src/core/server-role.js'))._resetServerRoleForTesting()
}, 60_000)

/** One away call of `name` from a session on this host, through local-calls: its gateway-result. */
function callHere(relayId: number, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const handle = createLocalCalls({
      request: async (cmd, params) => { if (cmd === 'gateway-result') resolve(params); return { ok: true } },
      hostKey: 'devbox',
      capabilities: () => ['caller-proof-v1'],
      leaderAnswers: () => false,
      localTasks: async () => ({ tasks: new Set<string>(), sessions: new Set<string>() }) as never,
    })
    handle({ ev: 'gateway-request', relayId, instanceId: 'away-final', capability: 'tools.call', callerSid: sidOf(relayId), payload: { name, args }, answerInMs: 20_000 })
  })
}

describe('an op marked leader is the follower\'s final answer away', () => {
  it('every one answers a refusal the daemon never takes back to its own offline code', async () => {
    const wrong: string[] = []
    let probed = 0
    let finals = 0
    const codes: Record<string, number> = {}
    for (const op of listOps({ includeDeprecated: true })) {
      if (AWAY_OP_DECISIONS[op.name]?.answer !== 'leader') continue
      probed++
      const r = await callHere(1000 + probed, op.name, argsOf(op))
      const code = typeof r.errorCode === 'string' ? r.errorCode : ''
      const detail = (r.detail && typeof r.detail === 'object' ? r.detail : {}) as { final?: unknown; why?: unknown }
      codes[code || 'ok'] = (codes[code || 'ok'] ?? 0) + 1
      if (code === 'needs_leader' && detail.final === true) finals++
      const said = `${code || 'ok'}: ${String(r.error ?? '').slice(0, 160)}`
      if (!code) wrong.push(`${op.name}: answered here (${JSON.stringify(r.result).slice(0, 120)}), so its row is not leader`)
      // A refusal of the arguments says nothing of the op's away answer; the executor's refusal of an
      // op a session off the Mac may not run (localHostGateway) is its final answer, here as on the leader.
      else if (code === 'bad_request' && /Invalid arguments for/.test(String(r.error))) wrong.push(`${op.name}: the probe's arguments were refused (${said}): add them to ARGS`)
      else if (FALLS_BACK.includes(code) && detail.final !== true) wrong.push(`${op.name}: handed back to the daemon (${said})`)
    }
    expect(probed).toBeGreaterThan(80)
    expect(wrong).toEqual([])
    // Most refuse with the route's own needs_leader, now final; no brake stood in for an answer.
    expect(finals).toBeGreaterThan(60)
    expect(codes.throttled ?? 0, JSON.stringify(codes)).toBe(0)
  }, 300_000)
})

describe('awayReply', () => {
  it('marks an away needs_leader final, keeps the refusals meant for elsewhere and every other answer as they are', () => {
    expect(awayReply({ relayId: 1, errorCode: 'needs_leader', error: 'x', detail: { retryAfterMs: 5000 } }))
      .toEqual({ relayId: 1, errorCode: 'needs_leader', error: 'x', detail: { retryAfterMs: 5000, final: true } })
    expect(awayReply({ relayId: 1, errorCode: 'needs_leader', error: 'x' }).detail).toEqual({ final: true })
    for (const why of Object.keys(AWAY_NOT_FINAL)) {
      const r = { relayId: 1, errorCode: 'needs_leader', error: 'x', detail: { why } }
      expect(awayReply(r)).toBe(r)
    }
    const ok = { relayId: 1, result: { done: 1 } }
    expect(awayReply(ok)).toBe(ok)
    const busy = { relayId: 1, errorCode: 'throttled', error: 'x', detail: { retryAfterMs: 1000 } }
    expect(awayReply(busy)).toBe(busy)
  })
})
