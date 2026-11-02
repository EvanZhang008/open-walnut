/**
 * Pushes a host's live frame (host:status) when its connection moves, from the server's
 * map of host rows. The map is refreshed on config:changed, but a row can be written
 * without one: the host network adds a machine's row when it joins, and discovered SSH
 * hosts come from ~/.ssh/config. A phase change for a host the map lacks reads the config
 * again instead of dropping the frame (2026-11-02: a machine that had just joined showed
 * "Reaching it ... Retrying" for 30 s after it connected, until a reload). A key the fresh
 * read lacks too (a `direct:<url>` pool entry) is not read again for a while.
 */

export interface HostFramePusherDeps<D> {
  /** The map as it stands now. */
  defs: () => Record<string, D>
  /** Read the config again into the map. */
  refresh: () => Promise<void>
  push: (host: string, def: D | undefined) => void
  now?: () => number
}

/** How long a key a fresh read did not have is not looked up again. */
export const MISSED_HOST_RECHECK_MS = 10_000

export function createHostFramePusher<D>(deps: HostFramePusherDeps<D>): { emit: (host: string) => void; configChanged: () => void } {
  const now = deps.now ?? Date.now
  const missed = new Map<string, number>()
  return {
    emit(host: string): void {
      if (!host || host === '__local__') return
      const def = deps.defs()[host]
      if (def) { deps.push(host, def); return }
      const at = missed.get(host)
      if (at !== undefined && now() - at < MISSED_HOST_RECHECK_MS) return
      missed.set(host, now())
      void deps.refresh().then(() => {
        const fresh = deps.defs()[host]
        if (!fresh) return
        missed.delete(host)
        deps.push(host, fresh)
      }, () => { /* config unreadable: the next phase change tries again */ })
    },
    configChanged(): void { missed.clear() },
  }
}
