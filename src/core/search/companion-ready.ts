/**
 * Whether the cloud companion answers search from its copy of the primary's
 * index (core/replication/search-replica-store.ts sets it). Its own module so
 * the search path reads one boolean without loading the index chain.
 */

let ready = false
let asOf: number | null = null

/** The copy is on, open, and was complete at least once: search it. */
export function companionSearchReady(): boolean {
  return ready
}

/** When the copy last matched the primary's index (ms epoch), or null. */
export function companionSearchAsOf(): number | null {
  return asOf
}

export function setCompanionSearchReady(value: boolean, syncedAt: number | null): void {
  ready = value
  asOf = syncedAt
}
