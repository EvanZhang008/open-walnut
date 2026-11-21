/**
 * The op catalogs a host's daemon holds for its sessions' Walnut MCP servers
 * (tools-list-held-v1).
 *
 * 2026-11-14: after a 6.5 h outage a host reconnected and about 20 sessions started at
 * once. Each one's `walnut mcp-server` asks for `tools.list {schemas: true}`, and the
 * server answered each with the whole catalog (about 130 KB gzipped): 2.6 MB of
 * `gateway-result` went up the session link in 10 s, and the relay on the SSH path ended
 * it. The same 130 KB also went up on every session start, every day.
 *
 * So the daemon keeps the catalogs it was sent, by the hash the server names in each
 * (`catalogHash`), at most MAX per Walnut, least recently used out first. A relayed
 * `tools.list {schemas: true}` names the hashes held for its Walnut (`have`); a server
 * that finds the caller's catalog among them answers `{sameAs: <hash>}`, and the caller
 * gets the held catalog. A `sameAs` this daemon no longer holds is asked for again
 * without `have`, once; a caller is never handed a `sameAs`.
 *
 * A cold daemon (just started, or a server whose catalog changed) asks for one catalog per
 * Walnut at a time: while that first ask is out and nothing is held, the next schemas lists
 * wait for it (at most WAIT_MS) and then go naming what it brought, so 20 sessions starting
 * at once cost one full catalog, not twenty. Holds are capped across all Walnuts too (a test
 * server's random home is never named again).
 *
 * A server's catalog differs per caller (its area's ops, what the gateway refuses on
 * this host), which is why it is held by hash and not by host or session.
 *
 * A full catalog that arrives after its relay timed out is still held (`timedOut`, `late`).
 * 2026-11-21: the answer to a host whose session link is slow rides the bulk channel's paced
 * connection (about 14 KB/s), so a 136 KB catalog took longer than the relay's 20 s. Each one
 * came late, was dropped as stale and never held, so every session's next ask (its MCP server
 * retries each minute) brought the whole catalog again: about 40 an hour on one host, a paced
 * pipe always full, its connection cut by the SSH relay every few minutes, and every answer in
 * it lost ("gateway-result send failed"). Held once it lands, the next ask is a hash.
 *
 * Compatibility: an older server ignores `have` and answers in full with no hash, so
 * nothing is held and every caller gets its answer as before; an older daemon never
 * sends `have`, so the server always answers in full.
 *
 * How the daemon twins get it: daemon-standalone.ts imports createHeldCatalogs;
 * daemon-source.ts inlines `createHeldCatalogs.toString()` through
 * `__CREATE_HELD_CATALOGS__`. So the factory body references NOTHING at module scope.
 */

export type HeldCatalogSettle =
  /** Hand this result to the caller. */
  | { result: Record<string, unknown> }
  /** The server named a catalog this daemon no longer holds: relay this payload (no `have`) as a new call. */
  | { again: Record<string, unknown> }
  /** The server named a catalog though it was asked without `have`: an error for the caller. */
  | { error: string }

export interface HeldCatalogs {
  /** The payload a relay to the server carries: a schemas tools.list names what is held for `home`. */
  ask(home: string | undefined, capability: string, payload: Record<string, unknown>): Record<string, unknown>
  /** What a server's result to a relay of `payload` (as asked) means for its caller. */
  settle(home: string | undefined, capability: string, payload: Record<string, unknown>, result: Record<string, unknown>): HeldCatalogSettle
  /**
   * Called before a relay goes: true when it must wait, because a first ask of this Walnut's
   * catalog is out and nothing is held yet; `resume` runs when that ask ends (or after WAIT_MS).
   * False: send it now (with ask()).
   */
  wait(home: string | undefined, capability: string, payload: Record<string, unknown>, resume: () => void): boolean
  /** A relay of `payload` ended without a result (an error answer): what waited on it goes. */
  failed(home: string | undefined, capability: string, payload: Record<string, unknown>): void
  /** The hashes held for `home`, oldest use first. */
  held(home: string | undefined): string[]
  /** Relay `relayId` of `payload` ended unanswered (timed out): a full catalog it brings later is still held. */
  timedOut(relayId: number, home: string | undefined, capability: string, payload: Record<string, unknown>, pinned?: boolean): void
  /**
   * A result for relay `relayId` that nobody waits for any more: held when it is a full catalog
   * for a schemas list that timed out within LATE_MS and `mayHold(home)` says its sender may
   * answer that Walnut's relays (`pinned` as the relay was when it went). True when it was held.
   * A result that is not held leaves the ask in place for the right sender's.
   */
  late(relayId: number, result: Record<string, unknown> | undefined, mayHold: (home: string | undefined, pinned: boolean) => boolean): boolean
}

export function createHeldCatalogs(opts?: { max?: number; maxTotal?: number; waitMs?: number; lateMs?: number; now?: () => number }): HeldCatalogs {
  const max = opts && typeof opts.max === 'number' && opts.max > 0 ? opts.max : 8
  const maxTotal = opts && typeof opts.maxTotal === 'number' && opts.maxTotal > 0 ? opts.maxTotal : 16
  const waitMs = opts && typeof opts.waitMs === 'number' && opts.waitMs >= 0 ? opts.waitMs : 10_000
  // How long a timed-out schemas list waits for its late catalog (a paced upload behind others).
  const lateMs = opts && typeof opts.lateMs === 'number' && opts.lateMs > 0 ? opts.lateMs : 10 * 60_000
  const now = opts && typeof opts.now === 'function' ? opts.now : () => Date.now()
  // Timed-out schemas lists by relay id, oldest first, at most lateMax.
  const lateMax = 64
  const timedOutAsks = new Map<number, { home: string | undefined; capability: string; payload: Record<string, unknown>; pinned: boolean; at: number }>()
  // Walnut home ('' for a server that names none) -> hash -> catalog result, in use order.
  const homes = new Map<string, Map<string, Record<string, unknown>>>()
  // Every hold of every Walnut, in use order ("<home>\n<hash>"), for the cap across them.
  const order = new Map<string, true>()
  // A Walnut whose first ask is out with nothing held: what waits for it.
  const firstAsks = new Map<string, { waiters: Array<() => void>; timer: unknown }>()
  // Waiters let go with nothing held (the first ask failed or timed out) go at once, not one by one.
  const letGo = new Map<string, number>()
  const keyOf = (home: string | undefined): string => (typeof home === 'string' ? home : '')
  const isSchemasList = (capability: string, payload: Record<string, unknown>): boolean =>
    capability === 'tools.list' && !!payload && payload.schemas === true
  const withoutHave = (payload: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(payload)) if (k !== 'have') out[k] = payload[k]
    return out
  }

  const touch = (key: string, hash: string): void => {
    const k = key + '\n' + hash
    order.delete(k)
    order.set(k, true)
  }
  const drop = (key: string, hash: string): void => {
    order.delete(key + '\n' + hash)
    const held = homes.get(key)
    if (!held) return
    held.delete(hash)
    if (held.size === 0) homes.delete(key)
  }
  const release = (key: string): void => {
    const first = firstAsks.get(key)
    if (!first) return
    firstAsks.delete(key)
    clearTimeout(first.timer as ReturnType<typeof setTimeout>)
    if (first.waiters.length > 0) letGo.set(key, (letGo.get(key) || 0) + first.waiters.length)
    for (const resume of first.waiters) {
      try { resume() } catch { /* one waiter's failure is its own */ }
    }
  }

  function wait(home: string | undefined, capability: string, payload: Record<string, unknown>, resume: () => void): boolean {
    if (!isSchemasList(capability, payload)) return false
    const key = keyOf(home)
    const free = letGo.get(key) || 0
    if (free > 0) {
      if (free === 1) letGo.delete(key); else letGo.set(key, free - 1)
      return false
    }
    const held = homes.get(key)
    if (held && held.size > 0) return false
    const first = firstAsks.get(key)
    if (first) { first.waiters.push(resume); return true }
    const timer = setTimeout(() => release(key), waitMs)
    const t = timer as { unref?: () => void }
    if (typeof t.unref === 'function') t.unref()
    firstAsks.set(key, { waiters: [], timer })
    return false
  }

  function failed(home: string | undefined, capability: string, payload: Record<string, unknown>): void {
    if (isSchemasList(capability, payload)) release(keyOf(home))
  }

  function ask(home: string | undefined, capability: string, payload: Record<string, unknown>): Record<string, unknown> {
    if (!isSchemasList(capability, payload)) return payload
    // `have` is the daemon's word, never the caller's.
    const out = withoutHave(payload)
    const held = homes.get(keyOf(home))
    if (held && held.size > 0) out.have = Array.from(held.keys())
    return out
  }

  function settle(home: string | undefined, capability: string, payload: Record<string, unknown>, result: Record<string, unknown>): HeldCatalogSettle {
    if (!isSchemasList(capability, payload) || !result || typeof result !== 'object') return { result }
    const key = keyOf(home)
    const sameAs = result.sameAs
    if (typeof sameAs === 'string') {
      const held = homes.get(key)
      const got = held ? held.get(sameAs) : undefined
      if (held && got) {
        // Used now: last out.
        held.delete(sameAs)
        held.set(sameAs, got)
        touch(key, sameAs)
        release(key)
        return { result: got }
      }
      if (Array.isArray(payload.have)) return { again: withoutHave(payload) }
      release(key)
      return { error: 'the Walnut server named a tool catalog this host was never sent; try again' }
    }
    const hash = result.catalogHash
    if (typeof hash === 'string' && hash && Array.isArray(result.ops)) {
      let held = homes.get(key)
      if (!held) { held = new Map(); homes.set(key, held) }
      held.delete(hash)
      held.set(hash, result)
      touch(key, hash)
      while (held.size > max) drop(key, held.keys().next().value as string)
      while (order.size > maxTotal) {
        const oldest = order.keys().next().value as string
        const cut = oldest.lastIndexOf('\n')
        drop(oldest.slice(0, cut), oldest.slice(cut + 1))
      }
    }
    release(key)
    return { result }
  }

  function heldOf(home: string | undefined): string[] {
    const held = homes.get(keyOf(home))
    return held ? Array.from(held.keys()) : []
  }

  function timedOut(relayId: number, home: string | undefined, capability: string, payload: Record<string, unknown>, pinned?: boolean): void {
    if (!isSchemasList(capability, payload)) return
    const at = now()
    for (const [id, t] of timedOutAsks) {
      if (at - t.at < lateMs && timedOutAsks.size < lateMax) break
      timedOutAsks.delete(id)
    }
    timedOutAsks.set(relayId, { home, capability, payload, pinned: pinned === true, at })
  }

  function late(relayId: number, result: Record<string, unknown> | undefined, mayHold: (home: string | undefined, pinned: boolean) => boolean): boolean {
    const t = timedOutAsks.get(relayId)
    if (!t) return false
    if (now() - t.at >= lateMs) { timedOutAsks.delete(relayId); return false }
    // Only a full catalog is worth keeping: a late sameAs or error answers nobody.
    if (!result || typeof result !== 'object' || typeof result.catalogHash !== 'string' || !Array.isArray(result.ops)) return false
    // Another Walnut's server never uses up the ask its own Walnut's late answer is for.
    if (!mayHold(t.home, t.pinned)) return false
    timedOutAsks.delete(relayId)
    settle(t.home, t.capability, t.payload, result)
    return true
  }

  return { ask, settle, wait, failed, held: heldOf, timedOut, late }
}
