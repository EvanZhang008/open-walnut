/**
 * Which Walnut a server socket speaks for, and which socket a session's relayed
 * `walnut` call may go to (the daemon's gateway).
 *
 * 2026-11-10: a host shared by two people's Walnuts. The owner's link to it dropped
 * three times in ten minutes, and each time the gateway's "any trusted client that
 * never identified itself" fallback sent the owner's sessions' calls to the OTHER
 * person's Walnut: its bulk socket, which opens beside its main socket and never
 * names a Walnut. The calls stayed there until the link came back; reads answered
 * "No task found", and a write that did not name an id would have landed in the
 * wrong Walnut.
 *
 * The rules, for every call:
 * - A socket speaks for the Walnut it is bound to (`leader.configure`, `host.slice`),
 *   else for the Walnut of a bound socket of the same server run (a server names its
 *   run in the hello of each of its sockets, the bulk channel's included), else for
 *   no Walnut it has said.
 * - A call whose Walnut is known goes only to a socket of that Walnut. A socket of
 *   another Walnut never takes it. A socket that names none takes it only when that
 *   Walnut never identified itself on this host (an older server that binds nothing):
 *   once it has, a socket that names none is never it. With no socket of its Walnut,
 *   the call is answered here, waits for one, or fails with `hub_unreachable`
 *   (nothing was sent, so it is safe to run again); it never falls back.
 * - A call whose Walnut is not known goes only to a socket that names no Walnut (the
 *   old rule for older servers): never to a socket that speaks for one.
 * - A socket whose hello named a run moments ago and that nothing bound yet (a new
 *   server between its hello and its `leader.configure`) is nobody's target until it
 *   binds or the grace runs out (`pending`), for a call whose Walnut is known.
 * - A result for a call whose Walnut is known is taken only from a socket of that
 *   Walnut (`mayAnswer`).
 *
 * How the daemon twins get it: daemon-standalone.ts imports createGatewayIdentity;
 * daemon-source.ts inlines `createGatewayIdentity.toString()` through
 * `__CREATE_GATEWAY_IDENTITY__`. So the factory body references NOTHING at module scope.
 */

/** One server socket as the pick sees it: bound home, server run. */
export interface GatewaySocketFacts<S> {
  socket: S
  /** The Walnut it is bound to, if any. */
  bound?: string
  /** The server run its hello named, if any. */
  run?: string
  /**
   * Its hello named a run and said its server binds (`binds`) moments ago, and nothing
   * has bound it yet: a new server's socket before its `leader.configure`. It is no Walnut's target and, for a call of
   * a known Walnut, not a socket that names none either, so an older Walnut's session
   * call never reaches it in that window.
   */
  pending?: boolean
}

export interface GatewayPick<S> {
  target: S | null
  /** Sockets of another Walnut that were passed over. */
  otherWalnut: number
  /** Sockets that name no Walnut and were passed over because the call's Walnut is pinned. */
  unidentified: number
}

export interface GatewayIdentity {
  /** A socket of server run `run` was bound to `home`: every socket of that run speaks for it. */
  noteRun(run: unknown, home: unknown): void
  /** The Walnut a socket speaks for (its own binding, else its run's), or undefined. */
  walnutOf(bound: string | undefined, run: string | undefined): string | undefined
  /** Some socket of a run bound to `home` was seen by this daemon. */
  knowsHome(home: string): boolean
  /**
   * The socket a call for `home` goes to, among `candidates` (server sockets that may
   * take a relay now, in connect order). `pinned`: `home`'s Walnut identifies itself on
   * this host, so a socket that names none is never it. `allowUnidentified`: the
   * caller's other rules let a socket that names none take an unpinned call.
   */
  pick<S>(candidates: Array<GatewaySocketFacts<S>>, home: string | undefined, opts: { pinned: boolean; allowUnidentified: boolean }): GatewayPick<S>
  /** Whether a result from a socket (its binding and run) may answer a call for `home`. */
  mayAnswer(bound: string | undefined, run: string | undefined, home: string | undefined, pinned: boolean): boolean
  /** Two names of one Walnut (its dir however its slashes are written). */
  sameWalnut(a: string | undefined, b: string | undefined): boolean
  /** The one Walnut these sockets speak for, when they all speak for the same one (none pending or nameless). */
  soleWalnut<S>(candidates: Array<GatewaySocketFacts<S>>): string | undefined
  /**
   * The Walnut a call from outside any session (a terminal, a trigger script) is for, or
   * undefined when nothing says which. `held`: the Walnuts whose copy this host holds;
   * `fresh`: those a server of which was bound here lately or whose copy is recent. A
   * copy nothing refreshed for weeks (a test run's, a Walnut gone from this host) never
   * makes the call nobody's (2026-11-12: five test copies from October beside the real
   * one made every trigger script's call wait 90 s and fail "no server connected").
   * Two fresh copies stay nobody's: which server is connected says nothing about whose
   * script calls, and a call sent to the other person's Walnut is worse than a refusal.
   */
  externalOwner<S>(held: string[], fresh: string[], candidates: Array<GatewaySocketFacts<S>>): string | undefined
}

export function createGatewayIdentity(): GatewayIdentity {
  // A server run is one server process; a few hundred is far more than a host sees between daemon restarts.
  const RUNS_MAX = 256
  const runHomes = new Map<string, string>()
  // One Walnut whatever slashes its dir is written with (served-walnuts-core.ts keyFor).
  const norm = (home: string | undefined): string | undefined =>
    (home ? home.replace(/\/+/g, '/').replace(/(.)\/$/, '$1') : undefined)

  function noteRun(run: unknown, home: unknown): void {
    if (typeof run !== 'string' || !run || typeof home !== 'string' || !home) return
    runHomes.delete(run)
    runHomes.set(run, home)
    while (runHomes.size > RUNS_MAX) {
      const first = runHomes.keys().next()
      if (first.done) break
      runHomes.delete(first.value)
    }
  }

  function walnutOf(bound: string | undefined, run: string | undefined): string | undefined {
    if (bound) return bound
    return run ? runHomes.get(run) : undefined
  }

  function knowsHome(home: string): boolean {
    if (!home) return false
    const want = norm(home)
    for (const h of runHomes.values()) if (norm(h) === want) return true
    return false
  }

  function pick<S>(candidates: Array<GatewaySocketFacts<S>>, rawHome: string | undefined, opts: { pinned: boolean; allowUnidentified: boolean }): GatewayPick<S> {
    const home = norm(rawHome)
    let bound: S | null = null
    let linked: S | null = null
    let unidentified: S | null = null
    let unidentifiedCount = 0
    let otherWalnut = 0
    for (const c of candidates) {
      const walnut = walnutOf(c.bound, c.run)
      // Held back only from a Walnut's call: a call no Walnut owns takes it as before (an
      // older server that names its run and never binds).
      if (!walnut && c.pending && home) { unidentifiedCount += 1; continue }
      if (!walnut) {
        unidentifiedCount += 1
        if (unidentified === null) unidentified = c.socket
        continue
      }
      if (home && norm(walnut) === home) {
        // The newest bound socket wins (a redial replaces the one before), as before.
        if (norm(c.bound) === home) bound = c.socket
        else if (linked === null) linked = c.socket
        continue
      }
      otherWalnut += 1
    }
    if (!home) return { target: unidentified, otherWalnut, unidentified: 0 }
    if (bound !== null || linked !== null) return { target: bound !== null ? bound : linked, otherWalnut, unidentified: 0 }
    if (!opts.pinned && opts.allowUnidentified) return { target: unidentified, otherWalnut, unidentified: unidentified === null ? unidentifiedCount : 0 }
    return { target: null, otherWalnut, unidentified: unidentifiedCount }
  }

  function mayAnswer(bound: string | undefined, run: string | undefined, rawHome: string | undefined, pinned: boolean): boolean {
    const home = norm(rawHome)
    // A call no Walnut owns went to a socket that named none; its server may have bound
    // since and answer on its main socket: any server's answer, as before.
    if (!home) return true
    const walnut = walnutOf(bound, run)
    if (walnut !== undefined) return norm(walnut) === home
    // A socket that names no Walnut answers only a Walnut that never named itself here.
    return !pinned
  }

  function soleWalnut<S>(candidates: Array<GatewaySocketFacts<S>>): string | undefined {
    let one: string | undefined
    for (const c of candidates) {
      const walnut = walnutOf(c.bound, c.run)
      if (!walnut) return undefined
      if (one !== undefined && norm(one) !== norm(walnut)) return undefined
      if (one === undefined) one = walnut
    }
    return one
  }

  const sameWalnut = (a: string | undefined, b: string | undefined): boolean => !!a && !!b && norm(a) === norm(b)

  function externalOwner<S>(held: string[], fresh: string[], candidates: Array<GatewaySocketFacts<S>>): string | undefined {
    if (held.length === 1) return held[0]
    // No copy here: the Walnut every connected server speaks for, when there is just one.
    if (held.length === 0) return soleWalnut(candidates)
    return fresh.length === 1 ? fresh[0] : undefined
  }

  return { noteRun, walnutOf, knowsHome, pick, mayAnswer, sameWalnut, soleWalnut, externalOwner }
}
