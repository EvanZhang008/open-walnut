/**
 * Walnut Health items a server raises about its hosts: one record per condition (its dedupKey),
 * counted again when it happens again, recovered by its recoveryKey. They carry no `needsYou`,
 * so audienceOf (audience.ts) keeps them in Walnut Health: never a toast or a bell row.
 *
 * The one writer of these items (tests/core/notifications/notice-audience.test.ts lists it).
 * Nothing here throws: a failed write is a log line.
 */

import { log } from '../../logging/index.js'
import type { NewNotification } from './store.js'

/** The name a person reads for a host: its label in Settings, else its key. */
export async function hostLabel(hostKey: string): Promise<string> {
  try {
    const { getConfig } = await import('../config-manager.js')
    return (await getConfig()).hosts?.[hostKey]?.label?.trim() || hostKey
  } catch {
    return hostKey
  }
}

/** Raise (or count again) one item. False when it could not be written. */
export async function raiseHealthItem(item: NewNotification, source: string): Promise<boolean> {
  try {
    const [{ upsertNotification }, { bus }] = await Promise.all([import('./store.js'), import('../event-bus.js')])
    const { record, outcome } = await upsertNotification(item)
    if (outcome !== 'suppressed') bus.emit(outcome === 'inserted' ? 'notification:new' : 'notification:updated', record, ['web-ui'], { source })
    return true
  } catch (err) {
    log.session.warn(`${source}: the Walnut Health item could not be written`, { host: item.host, error: err instanceof Error ? err.message : String(err) })
    return false
  }
}

/** The condition is over: its items recover. False when the store could not be read. */
export async function recoverHealthItems(keys: string[], source: string): Promise<boolean> {
  try {
    const [{ recoverNotifications }, { bus }] = await Promise.all([import('./store.js'), import('../event-bus.js')])
    const { recovered } = await recoverNotifications(keys)
    for (const record of recovered) bus.emit('notification:updated', record, ['web-ui'], { source })
    return true
  } catch (err) {
    log.session.warn(`${source}: the Walnut Health item could not be recovered`, { keys, error: err instanceof Error ? err.message : String(err) })
    return false
  }
}

/**
 * Conditions that each raise one item and recover it (keyed by the item's recoveryKey). Writes
 * of one key go one at a time, in the order they came: a quick recovery never lands before the
 * failure it recovers. What was told is kept per process; after a restart the first recovery
 * reads the store once.
 */
export function healthConditions(source: string) {
  const told = new Map<string, 'raised' | 'clear'>()
  const queues = new Map<string, Promise<void>>()
  function inTurn(key: string, step: () => Promise<void>): Promise<void> {
    const next = (queues.get(key) ?? Promise.resolve()).then(step)
    queues.set(key, next)
    void next.finally(() => { if (queues.get(key) === next) queues.delete(key) })
    return next
  }
  return {
    /** Raise (or count again) the condition's item. */
    raise(key: string, item: () => Promise<NewNotification>): Promise<void> {
      return inTurn(key, async () => { if (await raiseHealthItem(await item(), source)) told.set(key, 'raised') })
    },
    /** The condition is over: its item, if any, recovers. */
    recover(key: string): Promise<void> {
      return inTurn(key, async () => {
        if (told.get(key) === 'clear') return
        if (await recoverHealthItems([key], source)) told.set(key, 'clear')
      })
    },
    /** What this process told for the key (undefined: nothing yet). */
    toldOf: (key: string) => told.get(key),
    /** Tests only. */
    reset(): void { told.clear(); queues.clear() },
  }
}
