/**
 * A follower gateway (src/providers/follower-gateway-core.ts) on fake sockets, a fake clock and
 * hand-fired timers: the harness of tests/providers/follower-gateway-*.test.ts.
 */
import { createFollowerGateway, type FollowerGatewayResponse, type HandOff } from '../../src/providers/follower-gateway-core.js'

export interface Sock { name: string; answersLocal: boolean; answersOnline?: boolean; sent: Array<{ ev: string; data: Record<string, unknown> }>; broken?: boolean }

export function setup(o: { linked?: Sock | null } = {}) {
  const sock: Sock = { name: 'follower', answersLocal: true, sent: [] }
  /** The follower linked now (a test may unlink or relink it). */
  const link = { ws: o.linked === undefined ? sock : o.linked as Sock | null }
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = []
  const logs: Array<{ level: string; msg: string; data?: Record<string, unknown> }> = []
  let id = 100
  /** Whether the follower may write (the twin's followerMayWrite), and the clock. */
  const state = { mayWrite: true, now: 1_000, companion: false, stopping: false, companionLinked: true, held: null as FollowerGatewayResponse | null }
  /** Calls relayed to the companion (the twins' forwardToBackup), each with its answer to give. */
  const relayed: Array<{ call: HandOff; answer: (r: FollowerGatewayResponse) => void }> = []
  /** Calls the gateway asked to hold for the Mac (the twins' offlineHost.holdWrite). */
  const holds: HandOff[] = []
  const g = createFollowerGateway<Sock>({
    follower: () => (link.ws && link.ws.answersLocal ? link.ws : null),
    mayWrite: () => state.mayWrite,
    leaderElsewhere: () => state.companion,
    relayElsewhere: (c, answer) => { if (!state.companion || !state.companionLinked) return false; relayed.push({ call: c, answer }); return true },
    holdForLeader: (c) => { holds.push(c); return state.held },
    answersOnline: (ws) => ws.answersOnline === true,
    now: () => state.now,
    send: (ws, ev, data) => { if (ws.broken) return false; ws.sent.push({ ev, data }); return true },
    nextRelayId: () => ++id,
    instanceId: 'inst-1',
    attemptMs: (deadline) => deadline - state.now,
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t },
    clearTimer: (t) => { (t as { cleared: boolean }).cleared = true },
    log: (level, msg, data) => { logs.push({ level, msg, ...(data ? { data } : {}) }) },
    stopping: () => state.stopping,
  })
  // The timers set so far only: one a fired timer sets fires on the next call.
  const fire = () => { for (const t of [...timers]) if (!t.cleared) { t.cleared = true; t.fn() } }
  return { g, sock, link, timers, fire, state, logs, relayed, holds }
}

export const call = (over: Record<string, unknown> = {}) => ({ home: '/h', capability: 'tools.call', callerSid: 'sess-1', payload: { name: 'task_update', args: { id: 't1' } }, deadline: 31_000, ...over })
