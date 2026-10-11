/**
 * What a client may see of the config, and the one way to announce a config
 * change that carries it.
 *
 * `config:changed` reaches the `web-ui` subscriber, which sends it as it is to
 * every connected web client (src/web/server.ts), and every global subscriber
 * on this server. A config it carries is therefore an answer like
 * `GET /api/config`, and gets the same view, which that route uses too:
 * push device tokens masked and their claims dropped on every box, every secret
 * masked on a replica, where any paired device can read it. The server modules
 * that act on the event read the config from disk, never from the event.
 *
 * Two guards keep it that way:
 *  - tests/core/config-broadcast-ratchet.test.ts fails on any emit of
 *    `config:changed` that carries more than a `key` outside this file;
 *  - the WebSocket exit (broadcastEvent, src/web/ws/handler.ts) passes every
 *    `config:changed` frame through `configChangedForClients`, so a relay that
 *    re-emits an event under a computed name cannot carry a raw config out.
 */
import { CLOUD_MODE } from '../constants.js'
import { maskPushTokens, redactConfig } from './config-redact.js'
import { bus, EventNames, type EmitOptions } from './event-bus.js'

/** The config as a client may see it: the view `GET /api/config` answers with. */
export function configForClients<T>(config: T): T {
  return CLOUD_MODE ? redactConfig(config) as T : maskPushTokens(config)
}

/** A `config:changed` payload as a client may see it: its `config`, if any, in the client view. */
export function configChangedForClients(data: unknown): unknown {
  const config = (data as { config?: unknown } | null | undefined)?.config
  if (!config || typeof config !== 'object') return data
  return { ...(data as object), config: configForClients(config) }
}

/** Announce a config change with the config it left (whole, or the part that changed). */
export function emitConfigChanged(config: object, destinations: string[], options?: EmitOptions): void {
  bus.emit(EventNames.CONFIG_CHANGED, { config: configForClients(config) as Record<string, unknown> }, destinations, options)
}
