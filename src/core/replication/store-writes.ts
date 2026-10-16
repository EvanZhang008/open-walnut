/**
 * "A store wrote" signals for the copy kinds whose writers emit no bus event
 * (docs/plan/walnut-replica-servers-impl.md, WP5). The routines engine tells its
 * changes to the server's onEvent hook, which goes to the browser sockets only,
 * and the conversation routes call broadcastEvent the same way, so a kind
 * watching the bus heard nothing. The one write point of each store calls
 * noteStoreWrite instead: cron/store.ts persist() (every routine and status
 * write, from REST, the agent's tools, a trigger report or a run) and
 * core/conversations.ts writeIndex() (every list change). A leaf module: no imports.
 */

export type WatchedStore = 'routines' | 'conversations'

const listeners = new Map<WatchedStore, Set<() => void>>()

/** The store's file was written. Never throws: a listener's failure is its own. */
export function noteStoreWrite(store: WatchedStore): void {
  const set = listeners.get(store)
  if (!set) return
  for (const fn of [...set]) {
    try { fn() } catch { /* a copy round is best effort */ }
  }
}

/** Calls `fn` after each write of `store`. Returns the stop. */
export function onStoreWrite(store: WatchedStore, fn: () => void): () => void {
  let set = listeners.get(store)
  if (!set) listeners.set(store, (set = new Set()))
  const own = () => fn()
  set.add(own)
  return () => { set!.delete(own) }
}
