/**
 * Late facts gathered into one go (docs/plan/one-service-every-host.md, phase 2; the plan's late
 * facts table): a leader that was away reads a host's facts back in bursts (256 records a frame),
 * spread over seconds. A subscriber that derives state from them (the user status) does it once
 * for the whole backlog, after the burst has gone quiet, never once per fact or per frame.
 *
 * Keys are gathered until no new one came for `quietMs`, or `maxMs` after the first one (a backlog
 * that never pauses still settles), then handed to `fire` once.
 */

export interface LateGather {
  add(key: string): void
  /** Fire now with what is gathered (tests, a settle). */
  flush(): void
  stop(): void
  readonly size: number
}

export function createLateGather(fire: (keys: Set<string>) => void, opts: { quietMs?: number; maxMs?: number } = {}): LateGather {
  const quietMs = opts.quietMs ?? 2_000
  const maxMs = opts.maxMs ?? 30_000
  let keys = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let firstAt = 0
  const flush = (): void => {
    if (timer) { clearTimeout(timer); timer = null }
    if (!keys.size) return
    const out = keys
    keys = new Set()
    fire(out)
  }
  return {
    add(key) {
      if (!key) return
      if (!keys.size) firstAt = Date.now()
      keys.add(key)
      if (timer) clearTimeout(timer)
      const wait = Math.max(0, Math.min(quietMs, firstAt + maxMs - Date.now()))
      timer = setTimeout(flush, wait)
      timer.unref?.()
    },
    flush,
    stop() {
      if (timer) clearTimeout(timer)
      timer = null
      keys = new Set()
    },
    get size() { return keys.size },
  }
}
