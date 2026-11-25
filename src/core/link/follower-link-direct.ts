/**
 * The follower Link of a host's one Walnut service (follower-link.ts has the one for a server
 * that dials its daemon's socket). The service holds the daemon runtime in its own process, so
 * this link calls it: no socket, no `follower.hello`, no JSON on the way, no poll over a wire.
 *
 *   request(cmd)    the follower's own commands (`follower.op`, `follower.send`, ...) are a table to
 *                   the runtime's follower seat (FOLLOWER_CALLS): the same functions the daemon's
 *                   `follower.*` handlers call, in the same command lane and under the same drain
 *                   admission. Any other command (a read, `follower.gateway`, `follower.trigger.deliver`,
 *                   `hello`) goes through the seat's in-process client, which the daemon holds as the
 *                   follower's socket: its owner scope, its allow-list and its events are a socket's.
 *   answers         the frame a socket would have carried: `{ ok: true, ...result }`, or
 *                   `{ ...extra, ok: false, error }` with the same `errorKind` (leader_answers,
 *                   needs_leader, journal_unwritable, ...), so write-port.ts, dispatch.ts and the
 *                   away-* files keep their retry rules. A call the drain refuses or a handler that
 *                   throws is the frame handleCommand sends for it. A request that never reached
 *                   the runtime (no link, a parameter named like a frame key, a frame over the
 *                   cap: daemon-link.ts preflightFrame) rejects marked `notSent`; a call that
 *                   outlives its timeout rejects `<cmd> timed out`, as the socket's does.
 *   a drain         a call the runtime's drain refuses (a `service.update` or `service.handover`
 *                   pauses it up to its 45 s cap, and an update that fails resumes it) is sent again
 *                   every second inside the caller's timeout, as the socket link does
 *                   (daemon-link.ts swapResender): a host write in that window waits, it does not
 *                   fail with a 409 no client retries. A swap that goes through ends this process.
 *   view / state    `seat.view(home)` is the leader's view the daemon would answer `follower.status`
 *                   with; the link is `following` once the runtime knows this Walnut (the hello's
 *                   rule), and seats itself then.
 *   the seat        every poll asks the seat whose seat its client holds (`seatedAs`): one another
 *                   follower took (or a closed client) is taken back at once, and the calls name
 *                   the home the seat holds now, the Walnut's first home there after a declared
 *                   move (review A3b S56-L3, L5: the link stayed `following` on a seat it had lost,
 *                   and kept calling with the home it started with).
 */
import type { Duplex } from 'node:stream'
import { createStreamEndpoint, type StreamEndpoint } from '../../lib/link-stream.js'
import { followerViewOf, notSent, preflightFrame, swapResender, type DaemonLinkState, type FollowerView } from '../../host-server/daemon-link.js'
import type { DaemonClient, FollowerSeat } from '../../providers/daemon-runtime-types.js'
import { createLinkEvents, type LinkDoor, type LinkPeerRole, type LinkState } from './link.js'
import type { FollowerLink, FollowerLinkWiring } from './follower-link.js'

export interface DirectFollowerLinkOptions extends FollowerLinkWiring {
  /** The runtime's follower seat once the runtime runs in this process, else null (asked again). */
  seat: () => FollowerSeat | null
  /**
   * One presence (a service without a copy, replica/front.ts): `view()` asks the seat itself, at most
   * every LIVE_VIEW_MS, so this server's "is the leader away" is the runtime's at that moment, not
   * one poll old (the gateway then never hands it a call it still refuses as `leader_answers`).
   */
  liveView?: boolean
}

type Params = Record<string, unknown>
/** A follower answer as the entry returns it, or a plain result a socket sends with `ok: true`. */
type Called = { ok: true; result: Params } | { ok: false; error: string; extra?: Params } | Params | null

/** The follower's own commands: name to the seat's function (the daemon's cmdFollower* handlers call the same ones). */
export const FOLLOWER_CALLS: Record<string, { answer: boolean; call: (seat: FollowerSeat, home: string, cmd: Params) => Called | Promise<Called> }> = {
  'follower.status': { answer: false, call: (seat, home) => seat.view(home) },
  'follower.sessions': { answer: false, call: (seat, home) => seat.sessions(home) },
  'follower.slice': { answer: false, call: (seat, home) => seat.slice(home) },
  'follower.triggers': { answer: false, call: (seat, home, cmd) => seat.triggers(home, cmd) },
  'follower.pending': { answer: false, call: (seat, home, cmd) => seat.pending(home, cmd) },
  'follower.send': { answer: true, call: (seat, home, cmd) => seat.send(home, cmd) },
  'follower.permission': { answer: true, call: (seat, home, cmd) => seat.permission(home, cmd) },
  'follower.peer': { answer: true, call: (seat, home, cmd) => seat.peer(home, cmd) },
  'follower.op': { answer: true, call: (seat, home, cmd) => seat.op(home, cmd) },
  'follower.trigger.test': { answer: true, call: (seat, home, cmd) => seat.triggerTest(home, cmd) },
  'follower.start': { answer: true, call: (seat, home, cmd) => seat.start(home, cmd) },
}

const CALL_TIMEOUT_MS = 5_000
/** A live view is read again after this long (liveView). */
const LIVE_VIEW_MS = 200
/** Asked again this often while the runtime or the Walnut is not there yet (the socket link's first redial). */
const RETRY_MS = 1_000

/** The frame a socket carries for a follower call's result (sendOk, sendError, sendFollowerAnswer). */
function frameOf(answer: boolean, called: Called): Params {
  if (answer) {
    const a = called as { ok: boolean; result?: Params; error?: string; extra?: Params }
    return a.ok ? { ok: true, ...a.result } : { ...a.extra, ok: false, error: a.error }
  }
  return { ok: true, ...(called as Params) }
}

/** The copied params as a client request takes them (the frame's `cmd` is the request's own). */
function withoutCmd(sent: Params): Params {
  const { cmd: _cmd, ...rest } = sent
  return rest
}

export function createDirectFollowerLink(opts: DirectFollowerLinkOptions): FollowerLink {
  const now = opts.now ?? Date.now
  const pollMs = opts.pollMs ?? 3_000
  const events = createLinkEvents()
  let state: DaemonLinkState = 'connecting'
  let error: string | null = null
  let last: { view: FollowerView; at: number } | null = null
  let heardAt: number | null = null
  let client: DaemonClient | null = null
  let streams: StreamEndpoint | null = null
  let caps: readonly string[] | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = true
  /** The last view read was refused (the runtime paused for a swap): the next one that answers wakes the resends. */
  let viewRefused = false
  const swaps = swapResender(now, () => state === 'following' && !!client)

  function setState(next: DaemonLinkState, why?: string): void {
    if (why !== undefined) error = why
    if (next === state) return
    state = next
    opts.log(next === 'following' ? 'info' : 'warn', 'host server: daemon link', { state: next, direct: true, ...(why ? { why } : {}) })
    events.emit('state', next)
  }

  function again(ms: number): void {
    if (stopped) return
    // One poll chain: a close while a poll is armed must not start a second one.
    if (timer) clearTimeout(timer)
    timer = setTimeout(tick, ms)
    timer.unref?.()
  }

  function drop(): void {
    streams?.closeAll('the link to the daemon closed')
    streams = null
    const old = client
    client = null
    if (old) { try { old.close() } catch { /* closed */ } }
  }

  /** The runtime's follower seat takes this server as its Walnut's follower (the hello, in process). */
  function seatIn(seat: FollowerSeat): void {
    const extra = (() => { try { return opts.helloExtra?.() ?? {} } catch { return {} } })()
    const c = seat.attach(opts.home, {
      answersLocal: opts.answersLocal === true, deliversTriggers: opts.deliversTriggers === true, answersOnline: opts.answersOnline?.() === true,
      callSocket: extra.callSocket,
    }, (frame) => {
      heardAt = now()
      if (streams?.handle(frame)) return
      if (typeof frame.ev === 'string') { try { opts.onEvent?.(frame) } catch { /* a listener never breaks the link */ } }
    }, () => {
      if (client !== c) return
      drop()
      setState('no-daemon', 'the daemon closed the link')
      again(RETRY_MS)
    })
    client = c
    streams = createStreamEndpoint({
      send: (frame) => {
        if (client !== c) throw new Error('the link to the daemon is down')
        c.send(frame)
      },
      accept: opts.accept,
      openTimeoutMs: opts.openTimeoutMs,
    })
    setState('following', '')
    error = null
    swaps.answered()
    void c.request('hello').then((m) => {
      if (client === c && m.ok === true && Array.isArray(m.capabilities)) caps = m.capabilities.filter((x): x is string => typeof x === 'string')
    }, () => { /* the next link asks again */ })
  }

  /** The home the seat holds for this server now (after a declared move, the Walnut's first home there), else the one it started with. */
  function homeOf(seat: FollowerSeat, c: DaemonClient | null): string {
    return (c ? seat.seatedAs(c) : null) ?? opts.home
  }

  function tick(): void {
    timer = null
    if (stopped) return
    const seat = opts.seat()
    if (!seat) {
      setState('no-daemon', 'the daemon runtime is not running in this process yet')
      return again(RETRY_MS)
    }
    // Another follower took the seat (a socket's hello with this Walnut's token): take it back.
    if (client && seat.seatedAs(client) === null) {
      opts.log('warn', 'host server: daemon link lost its follower seat; seated again', { direct: true })
      drop()
    }
    let said: Params | null
    try { said = seat.view(homeOf(seat, client)) as Params | null } catch {
      // Paused or closing for a swap: what is known stays, the next poll asks again.
      viewRefused = true
      return again(pollMs)
    }
    // The runtime answers again (a paused swap resumed): requests waiting it out try now.
    if (viewRefused) { viewRefused = false; swaps.answered() }
    const view = said ? followerViewOf(said) : null
    if (!view || view.walnutId !== opts.walnutId) {
      setState('unknown-walnut', 'this host does not know that Walnut yet: its leader has not connected here')
      return again(RETRY_MS)
    }
    if (!client) seatIn(seat)
    last = { view, at: now() }
    heardAt = last.at
    events.emit('view', view)
    again(pollMs)
  }

  /** One command: the table for the follower's own, the seat's client for the rest. */
  async function ask(cmd: string, params: Params, timeoutMs: number): Promise<Params> {
    const seat = opts.seat()
    const c = client
    if (state !== 'following' || !seat || !c) throw notSent(new Error('not linked to the daemon'))
    // What a socket would deliver, checked as the socket link checks it: a copy, so the runtime keeps
    // nothing the caller may still change (both paths get the copy).
    const sent = JSON.parse(preflightFrame(cmd, params, 0)) as Params
    delete sent.id
    const row = FOLLOWER_CALLS[cmd]
    const work: Promise<Params> = row
      ? (async () => {
        try {
          const called = await row.call(seat, homeOf(seat, c), sent)
          if (cmd === 'follower.status' && !called) return { ok: false, error: 'this host does not know that Walnut yet: its leader has not connected here', errorKind: 'unknown_walnut' }
          return frameOf(row.answer, called)
        } catch (err) {
          // handleCommand's reply for a handler the drain refused or that threw.
          return { ok: false, error: `internal daemon error handling ${cmd}: ${err instanceof Error ? err.message : String(err)}` }
        }
      })()
      : c.request(cmd, withoutCmd(sent)).then((reply) => (reply.ok === false && reply.error === 'client closed' ? { ok: false, error: 'closed' } : reply))
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([work, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error(`${cmd} timed out`)), timeoutMs) })])
    } finally { clearTimeout(timeout) }
  }

  return {
    peer: { host: opts.host, walnutId: opts.walnutId },
    state: (): LinkState => (state === 'following' ? 'up' : 'down'),
    heard: () => (heardAt === null ? Infinity : Math.max(0, now() - heardAt)),
    request: (cmd, params = {}, timeoutMs) => swaps.request(cmd, (budget) => ask(cmd, params, budget), timeoutMs ?? CALL_TIMEOUT_MS),
    on: (event, cb) => events.on(event, cb),
    openStream: (to: LinkPeerRole, door: LinkDoor): Promise<Duplex> => {
      if (to === 'follower') return Promise.reject(new Error('a follower opens streams to the primary or the companion'))
      if (state !== 'following' || !streams) return Promise.reject(new Error('not linked to the daemon'))
      return streams.open(to, door ? { purpose: door } : {})
    },
    start: () => {
      stopped = false
      if (!timer) { timer = setTimeout(tick, 0); timer.unref?.() }
    },
    stop: () => {
      stopped = true
      if (timer) { clearTimeout(timer); timer = null }
      drop()
    },
    view: () => {
      if (opts.liveView && state === 'following' && client && (!last || now() - last.at >= LIVE_VIEW_MS)) {
        const seat = opts.seat()
        try {
          const said = seat ? seat.view(homeOf(seat, client)) as Params | null : null
          const view = said ? followerViewOf(said) : null
          if (view && view.walnutId === opts.walnutId) last = { view, at: now() }
        } catch { /* paused for a swap: the last view stands */ }
      }
      return last
    },
    linkState: () => state,
    lastError: () => error,
    report: (body) => {
      if (state !== 'following' || !client) return
      try { client.send({ cmd: 'follower.report', report: body }) } catch { /* the next one */ }
    },
    capabilities: () => caps,
  }
}
