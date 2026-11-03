/**
 * When the caller of this request stops waiting for its answer (epoch ms, this
 * server's clock), so work that holds an answer can let go in time.
 *
 * 2026-11-03: a session on another host called host_exec on the Mac. Its call
 * crossed the host's gateway, which gives up at 20 s (gateway-core.ts
 * GATEWAY_HUB_TIMEOUT_MS), and came back `hub_timeout` at exactly 20 s, with no
 * job id, although host_exec holds a relayed answer for 14 s. The 14 s ran from
 * the start of host_exec; the way in (the relay frame, the op executor's loopback
 * call, the route) and the way back were not counted, and at load ~150 they took
 * the other 6 s. Now the relay notes when the request reached this server, the op
 * executor's self-call carries it as a header, and the route runs its work in this
 * scope, so a hold measures against the caller's real deadline.
 *
 * The header only ever SHORTENS a hold: a caller that sends a wrong one only cuts
 * its own answer short. Values outside a sane window are ignored.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

export const ANSWER_BY_HEADER = 'x-walnut-answer-by'

/** A deadline further out than this is no deadline worth honouring (the longest hold is 10 min). */
const MAX_AHEAD_MS = 15 * 60_000
/** One already this far gone is a stale or a wrong clock, not a caller still waiting. */
const MAX_BEHIND_MS = 60_000

/**
 * A deadline and whether the call it belongs to is still being answered. AsyncLocalStorage hands
 * the store to everything created inside the scope, a socket or a timer that lives on after the
 * call included (a link dialled inside a relayed call carries it into every later relay of that
 * host): `live` ends with the call, so such leftovers see no deadline (the test-run scope,
 * src/core/test-run.ts, does the same).
 */
interface Scope { at: number; live: () => boolean }

const ambient = new AsyncLocalStorage<Scope>()

function liveScope(): Scope | undefined {
  const scope = ambient.getStore()
  return scope && scope.live() ? scope : undefined
}

/**
 * Run `fn` with the caller's deadline `at` (no scope when undefined), for as long as `fn` runs (to
 * its promise's end). Inside a live scope the earlier deadline holds, unless `fresh`: a request that
 * arrives on its own (a gateway relay, an HTTP request) is answered by its own deadline only. A link
 * dialled inside call A runs every later relay of that host in A's context, and while A still runs
 * its deadline would cut B's answer short (2026-11-03 review).
 */
export function withAnswerBy<T>(at: number | undefined, fn: () => T, opts: { fresh?: boolean } = {}): T {
  if (at === undefined || !Number.isFinite(at)) return opts.fresh ? ambient.exit(fn) : fn()
  const outer = opts.fresh ? undefined : liveScope()
  let open = true
  const scope: Scope = { at: outer ? Math.min(outer.at, at) : at, live: () => open }
  let out: T
  try {
    out = ambient.run(scope, fn)
  } catch (err) {
    open = false
    throw err
  }
  if (out instanceof Promise) return out.finally(() => { open = false }) as T
  open = false
  return out
}

/** The deadline of the call this code runs for, or undefined (none, or that call was answered). */
export function ambientAnswerBy(): number | undefined {
  return liveScope()?.at
}

/** A header value as a deadline, or undefined when it is missing or not a sane one. */
export function parseAnswerBy(raw: unknown, now = Date.now()): number | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw
  if (typeof value !== 'string' || !/^\d{10,16}$/.test(value.trim())) return undefined
  const at = Number(value.trim())
  return at >= now - MAX_BEHIND_MS && at <= now + MAX_AHEAD_MS ? at : undefined
}

/** The header a self-call carries, so the route it reaches knows the deadline too. */
export function answerByHeader(): Record<string, string> {
  const at = ambientAnswerBy()
  return at !== undefined ? { [ANSWER_BY_HEADER]: String(Math.floor(at)) } : {}
}
