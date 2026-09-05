/**
 * Calendar — a builtin capability plugin.
 *
 * It owns the cache, the refresh loop, the visibility rules, its config namespace, its
 * REST surface and its Personal AI tools. It does NOT own the platform door: the signed
 * EventKit helper carries the macOS calendar grant, and a TCC identity cannot move into a
 * plugin, so the source arrives through the host's `core:calendar-source` service.
 *
 * Turning this plugin off therefore turns the calendar off completely, routes included
 * (`/api/plugins/calendar/*` and its `/api/calendar` alias both stop answering), which is
 * the honest meaning of a capability living in a plugin.
 */
import type { WalnutServerPluginApi } from '../../core/plugins/server-api.js'
import type { CoreCalendarSourceApi } from '../../core/platform-services.js'
import type { PermissionGrantedEvent } from '../../core/event-types.js'
import type { Disposable } from '../../core/plugins/disposable.js'
import { registerCalendarRoutes } from './routes.js'
import {
  adoptCalendarService,
  getCalendarService,
  releaseCalendarService,
  setCalendarAnnouncer,
  type CalendarService,
} from './service.js'
import { createCalendarTools } from './tools.js'

/**
 * The Permission Doctor's grant event (payload: `PermissionGrantedEvent`, declared in
 * src/core/event-types.ts). src/web/routes/permissions.ts is the only emitter and this is the
 * only subscriber. The name is spelled out because `walnut.events.on` takes a plain string;
 * the PAYLOAD is typed, so the two ends cannot drift.
 */
const PERMISSION_GRANTED = 'permission:granted'

let live: CalendarService | null = null

function teardown(): void {
  if (!live) return
  const instance = live
  live = null
  setCalendarAnnouncer(null)
  releaseCalendarService(instance)
}

export async function activate(walnut: WalnutServerPluginApi): Promise<Disposable> {
  const source = walnut.services.require<CoreCalendarSourceApi>('core:calendar-source')

  // Installed before the service exists so even an update announced during init() rides
  // the HOST's bus. `walnut.events.emit` namespaces this to `plugin:calendar:updated`,
  // which core re-emits as the legacy `calendar:updated` (src/core/calendar-events-shim.ts).
  setCalendarAnnouncer((payload) => walnut.events.emit('updated', payload))

  // A factory, not a value: when a fixture already put a service in place, the EventKit
  // helper is never built (which on a developer's Mac would compile Swift and prompt).
  const service = adoptCalendarService(() => source.createSource())
  live = service

  for (const tool of createCalendarTools(getCalendarService)) {
    walnut.registry.tool({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.input_schema,
      execute: (input) => tool.execute(input),
    })
  }

  // Resolved per request, not captured: the route tests swap the service instance between
  // requests while the server stays up.
  registerCalendarRoutes(walnut, getCalendarService)

  // The user granting Calendar access mid-session used to be wired by the permissions
  // route reaching into the service directly. It goes through the bus now, so core keeps
  // no reference to a plugin's internals.
  walnut.events.on(PERMISSION_GRANTED, (event) => {
    if ((event.data as PermissionGrantedEvent | undefined)?.id !== 'calendar') return
    // Resolved per event, not captured: a fixture may have swapped the instance since
    // activate, and during teardown this throws rather than refreshing a released service.
    try {
      getCalendarService().refreshAll().catch((err: unknown) =>
        walnut.log.warn('post-grant refresh failed', { error: String(err).slice(0, 200) }),
      )
    } catch (err) {
      walnut.log.warn('post-grant refresh skipped', { error: String(err).slice(0, 200) })
    }
  })

  // Awaited so the poll is armed by the time activate resolves, but never fatal: a config
  // read that fails must not take the whole calendar surface down with it.
  try {
    await service.init()
  } catch (err) {
    walnut.log.warn('calendar service init failed', { error: String(err).slice(0, 200) })
  }

  // Returned as well as exported below: an activation that blows its deadline is abandoned
  // rather than deactivated, and this Disposable is what still stops the loop in that case.
  return { dispose: teardown }
}

export function deactivate(): void {
  teardown()
}
