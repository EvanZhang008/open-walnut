/**
 * A host's setup that runs again by itself, later and later (manager.ts), one timer per host:
 *
 *   login   its own SSH login was refused (a sign-in that expired or was being renewed). Before,
 *           it waited for the next connect or Retry, so a renewal at the wrong second left the
 *           tunnel on this Mac for good (2026-11-03).
 *   failed  the start failed (no first report, a refused configure, a link that dropped):
 *           the view says why, and nothing else on the host waits for it.
 *   gate    a host on by default lacked memory or disk (eligibility.ts): looked at again.
 *
 * The count starts over when the kind changes, and when `clear` says the setup went through.
 */

export type TryLaterKind = 'login' | 'failed' | 'gate'

export const TRY_LATER_MS: Readonly<Record<TryLaterKind, readonly number[]>> = Object.freeze({
  login: [30_000, 60_000, 120_000, 300_000, 600_000],
  failed: [60_000, 300_000, 900_000, 1_800_000, 3_600_000],
  gate: [1_800_000],
})

export function inWords(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`
}

export function createTryLater(opts: {
  schedules?: Partial<Record<TryLaterKind, readonly number[]>>
  now(): number
  /** The timer fired: run the host's setup again (when it is still connected). */
  run(hostKey: string): void
}) {
  const waits = new Map<string, { kind: TryLaterKind; n: number; timer: ReturnType<typeof setTimeout> }>()
  const schedule = (kind: TryLaterKind) => opts.schedules?.[kind] ?? TRY_LATER_MS[kind]

  function clear(hostKey: string): void {
    const w = waits.get(hostKey)
    if (w) clearTimeout(w.timer)
    waits.delete(hostKey)
  }

  return {
    /** Run the host's setup again later; how long, and when. */
    later(hostKey: string, kind: TryLaterKind): { ms: number; at: number } {
      const was = waits.get(hostKey)
      if (was) clearTimeout(was.timer)
      const n = was && was.kind === kind ? was.n : 0
      const list = schedule(kind)
      const ms = list[Math.min(n, list.length - 1)]!
      const at = opts.now() + ms
      const timer = setTimeout(() => opts.run(hostKey), ms)
      timer.unref?.()
      waits.set(hostKey, { kind, n: n + 1, timer })
      return { ms, at }
    },
    /** What the host waits for now, if anything. */
    pending(hostKey: string): TryLaterKind | null {
      return waits.get(hostKey)?.kind ?? null
    },
    clear,
    clearAll(): void {
      for (const key of [...waits.keys()]) clear(key)
    },
  }
}
