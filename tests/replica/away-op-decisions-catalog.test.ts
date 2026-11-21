/**
 * What a host's follower tells its host's own callers about the ops while the leader is away,
 * from the decision table (src/replica/away-op-decisions.ts):
 *   - tools.list (core/peers/capability-router.ts) keeps the whole catalog and marks each op
 *     `away: host | held | leader`, with a hint; on the leader, and on a follower while the
 *     leader answers, the catalog is as before;
 *   - walnut_status (replica/away-reads.ts) adds `away`: the leader is away, what waits for it in
 *     this host's journal, and the ops answered here; only for this host's own call.
 * The daemon's own away catalog listed only the ops it answered (offline-host-core.ts tools.list).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Request, Response } from 'express'
import { handleGatewayCapability } from '../../src/core/peers/capability-router.js'
import { PeerThrottle } from '../../src/core/peers/peer-throttle.js'
import { EXTERNAL_CALLER_SID } from '../../src/providers/gateway-core.js'
import { _resetLeaderPresenceForTesting, _resetServerRoleForTesting, setLeaderPresence } from '../../src/core/server-role.js'
import { AWAY_OP_DECISIONS, opsAnsweredHere } from '../../src/replica/away-op-decisions.js'
import { awayReads } from '../../src/replica/away-reads.js'
import type { Overlay } from '../../src/replica/overlay.js'

const KEYS = ['WALNUT_ROLE', 'WALNUT_PLACEMENT', 'WALNUT_CAPABILITIES'] as const
let saved: Record<string, string | undefined> = {}

function asFollower(on: boolean): void {
  if (on) Object.assign(process.env, { WALNUT_ROLE: 'replica', WALNUT_PLACEMENT: 'host', WALNUT_CAPABILITIES: 'host-local-calls' })
  else for (const k of KEYS) delete process.env[k]
  _resetServerRoleForTesting()
  _resetLeaderPresenceForTesting()
}

beforeEach(() => { saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]])) })
afterEach(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
  _resetServerRoleForTesting()
  _resetLeaderPresenceForTesting()
})

async function catalog(): Promise<{ ops: Array<{ name: string; away?: string }>; hint?: string }> {
  const r = await handleGatewayCapability('tools.list', EXTERNAL_CALLER_SID, {}, 'devbox', { throttle: new PeerThrottle(), cloudMode: false })
  expect(r.ok).toBe(true)
  return (r.ok ? r.result : {}) as { ops: Array<{ name: string; away?: string }>; hint?: string }
}

describe('tools.list on a host\'s follower while the leader is away', () => {
  it('marks every op with what it gets here and says so in a hint; nothing is dropped', async () => {
    asFollower(false)
    const before = await catalog()
    expect(before.hint).toBeUndefined()
    expect(before.ops.every((o) => o.away === undefined)).toBe(true)
    asFollower(true)
    const away = await catalog()
    expect(away.ops.map((o) => o.name)).toEqual(before.ops.map((o) => o.name))
    for (const o of away.ops) expect(o.away, o.name).toBe(AWAY_OP_DECISIONS[o.name]?.answer ?? 'leader')
    expect(away.ops.find((o) => o.name === 'task_get')?.away).toBe('host')
    expect(away.ops.find((o) => o.name === 'host_exec')?.away).toBe('leader')
    expect(away.hint).toMatch(/Your Mac is away/)
    // The leader answers again: the catalog as before.
    setLeaderPresence(true, 'test')
    const back = await catalog()
    expect(back.hint).toBeUndefined()
    expect(back.ops.every((o) => o.away === undefined)).toBe(true)
  })
})

describe('walnut_status from this host\'s own call', () => {
  const overlay = {
    refresh: async () => {},
    entries: () => [{ state: 'pending' }, { state: 'pending' }, { state: 'awaiting' }],
  } as unknown as Overlay

  function status(headers: Record<string, string>): Promise<Record<string, unknown>> {
    const handler = awayReads({ overlay, answeredAway: () => true, refreshWaitMs: 100, hostKey: 'devbox' })
    return new Promise((resolve) => {
      const res = { statusCode: 200, headersSent: false, json(b: unknown) { resolve(b as Record<string, unknown>); return this } } as unknown as Response
      const req = { method: 'GET', path: '/v1/status', query: {}, get: (k: string) => headers[k.toLowerCase()] } as unknown as Request
      handler(req, res, () => { (res as unknown as { json(b: unknown): unknown }).json({ mode: 'REPLICA', cloud: false }) })
    })
  }

  it('says the leader is away, what waits for it, and what answers here', async () => {
    const b = await status({ 'x-walnut-caller-sid': 'aaaaaaaa-1111-4111-8111-000000000001' })
    expect(b).toMatchObject({ mode: 'REPLICA', away: { leader: 'away', host: 'devbox', queuedForLeader: 2 } })
    expect((b.away as { answersHere: string[] }).answersHere).toEqual(opsAnsweredHere())
    // A phone's or a browser's read keeps the status as it was.
    expect(await status({})).toEqual({ mode: 'REPLICA', cloud: false })
  })
})
