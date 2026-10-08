/**
 * When a missing web root is worth an error card.
 *
 * The server checks its primary static root once a minute (server.ts). It used to
 * raise the 'web-assets' error card the first time index.html was missing. On the
 * cloud companion that happens on EVERY deploy: the deploy rebuilds dist in place
 * under the running server (vite empties dist/web/static first) and restarts it a
 * minute or two later, while the durable mirror keeps serving the build the open
 * windows run. Nothing a user could see was broken, and the card came up three
 * times in four days (2026-10-04 to 10-08).
 *
 * So a gap the mirror covers is a warning, and becomes the card only when it
 * lasts past `graceMs` (a deploy that wiped the assets and then failed) or the
 * mirror stops covering it. A gap with no mirror copy of the running build is
 * the card at once, as before: that is the 2026-09-02 outage, `/` and every
 * chunk answering 404.
 *
 * Pure (fs work is in the callbacks), so a test drives it with its own clock.
 */

export type StaticRootEvent =
  /** The primary is gone and the mirror is serving the running build. */
  | { kind: 'covered' }
  /** The primary is gone and that is now an error (raise the card). */
  | { kind: 'broken'; missingForMs: number; mirrorCovers: boolean }
  /** The primary is back (settle the card). */
  | { kind: 'servable' }

export interface StaticRootWatchOptions {
  /** Whether the primary root's index.html is there. */
  check: () => boolean
  /** Whether the mirror holds the build the running server's windows load. */
  mirrorCovers: () => boolean
  report: (event: StaticRootEvent) => void
  /** The state at boot (the server logs a missing root at startup itself). */
  initialOk: boolean
  graceMs?: number
  now?: () => number
}

/** A covered gap longer than this is no deploy's rebuild. */
export const STATIC_ROOT_GRACE_MS = 5 * 60_000

export interface StaticRootWatch {
  tick: () => void
  ok: () => boolean
}

export function createStaticRootWatch(opts: StaticRootWatchOptions): StaticRootWatch {
  const graceMs = opts.graceMs ?? STATIC_ROOT_GRACE_MS
  const now = opts.now ?? Date.now
  let ok = opts.initialOk
  // When the current gap began, and whether it has been reported as broken. A
  // boot without assets was already reported as an error by the server.
  let missingSince = ok ? 0 : now()
  let carded = !ok
  return {
    ok: () => ok,
    tick() {
      const servable = opts.check()
      if (servable) {
        if (ok) return
        ok = true
        carded = false
        opts.report({ kind: 'servable' })
        return
      }
      if (ok) {
        ok = false
        missingSince = now()
        if (opts.mirrorCovers()) {
          opts.report({ kind: 'covered' })
        } else {
          carded = true
          opts.report({ kind: 'broken', missingForMs: 0, mirrorCovers: false })
        }
        return
      }
      if (carded) return
      const missingForMs = now() - missingSince
      const mirrorCovers = opts.mirrorCovers()
      if (missingForMs < graceMs && mirrorCovers) return
      carded = true
      opts.report({ kind: 'broken', missingForMs, mirrorCovers })
    },
  }
}
