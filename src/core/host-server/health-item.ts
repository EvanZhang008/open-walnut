/**
 * A follower that did not start on a host is Walnut's to retry or fix, never the person's
 * (docs/reference/notice-audience.md): ONE Walnut Health item per host (`host-server:<host>`),
 * never a toast or a bell row (no needsYou). Its count rises with each try that fails again, so
 * Walnut Health looks into one that keeps failing. A start that goes through, a host turned
 * off or one that cannot run a follower (its view says why) recovers it.
 *
 * The host's sessions are not touched by any of it: the daemon keeps them whatever its server does.
 * Nothing here throws, and nothing waits for it (manager.ts calls it without waiting).
 */

import { log } from '../../logging/index.js'
import type { NewNotification } from '../notifications/store.js'

/** Last condition told per host this process; unknown after a restart (then a recovery reads the store once). */
const told = new Map<string, 'raised' | 'clear'>()

export function hostServerHealthKey(hostKey: string): string {
  return `host-server:${hostKey}`
}

export function hostServerHealthItem(hostKey: string, label: string, message: string, retries: boolean): NewNotification {
  return {
    kind: 'operation-error',
    severity: 'warning',
    title: `Walnut's server on ${label} did not start`,
    body: `${message} The sessions on ${label} keep running; ${retries ? 'Walnut tries again by itself.' : 'it is tried again on Retry or with a newer build.'}`,
    detail: `host server setup on ${hostKey}: ${message}`,
    dedupKey: hostServerHealthKey(hostKey),
    recoveryKey: hostServerHealthKey(hostKey),
    category: 'Sessions',
    host: hostKey,
  }
}

const source = { source: 'host-server' }

/** One write at a time per host, in the order they came: a quick recovery never lands before the failure it recovers. */
const queues = new Map<string, Promise<void>>()
function inTurn(hostKey: string, step: () => Promise<void>): Promise<void> {
  const next = (queues.get(hostKey) ?? Promise.resolve()).then(step)
  queues.set(hostKey, next)
  void next.finally(() => { if (queues.get(hostKey) === next) queues.delete(hostKey) })
  return next
}

/** The host's follower did not start: raise (or count again) its item. `retries`: Walnut tries again by itself. */
export function noteHostServerFailed(hostKey: string, message: string, retries: boolean): Promise<void> {
  return inTurn(hostKey, () => raise(hostKey, message, retries))
}

async function raise(hostKey: string, message: string, retries: boolean): Promise<void> {
  try {
    const [{ upsertNotification }, { bus }, { getConfig }] = await Promise.all([import('../notifications/store.js'), import('../event-bus.js'), import('../config-manager.js')])
    const label = (await getConfig()).hosts?.[hostKey]?.label?.trim() || hostKey
    const { record, outcome } = await upsertNotification(hostServerHealthItem(hostKey, label, message, retries))
    told.set(hostKey, 'raised')
    if (outcome !== 'suppressed') bus.emit(outcome === 'inserted' ? 'notification:new' : 'notification:updated', record, ['web-ui'], source)
  } catch (err) {
    log.session.warn('host server: the Walnut Health item could not be written', { host: hostKey, error: err instanceof Error ? err.message : String(err) })
  }
}

/** The host's follower runs, or none is meant to run: its item, if any, recovers. */
export function noteHostServerSettled(hostKey: string): Promise<void> {
  return inTurn(hostKey, () => recover(hostKey))
}

async function recover(hostKey: string): Promise<void> {
  if (told.get(hostKey) === 'clear') return
  try {
    const [{ recoverNotifications }, { bus }] = await Promise.all([import('../notifications/store.js'), import('../event-bus.js')])
    const { recovered } = await recoverNotifications([hostServerHealthKey(hostKey)])
    told.set(hostKey, 'clear')
    for (const record of recovered) bus.emit('notification:updated', record, ['web-ui'], source)
  } catch (err) {
    log.session.warn('host server: the Walnut Health item could not be recovered', { host: hostKey, error: err instanceof Error ? err.message : String(err) })
  }
}

/** Tests only. */
export function _resetHostServerHealthForTesting(): void {
  told.clear()
  queues.clear()
}
