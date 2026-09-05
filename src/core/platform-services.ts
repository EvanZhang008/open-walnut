/**
 * Core capabilities published into the plugin service registry as `core:<name>`.
 *
 * This is the door that lets a capability move between the host and a plugin without its
 * consumers noticing: a plugin asks for `core:calendar-source` and gets the same method
 * bag whether the host or, later, a capability plugin is behind it.
 *
 * A `core:` key needs no manifest dependency, because the host is not a plugin and a
 * plugin cannot declare a dependency on it. What gates these keys is `engines.walnut`,
 * already checked before any of the plugin's code was imported — so ADDING a core service
 * is a compatible change, and removing or reshaping one is a Walnut version bump.
 *
 * `core:calendar-source` is the first one, and it is the shape of the argument: the calendar
 * itself is a plugin now, but the signed EventKit helper carries the macOS calendar grant,
 * and a TCC identity cannot move into something the user can uninstall. Of its four methods
 * only `createSource` has a consumer today: `authStatus`, `requestAccess` and
 * `helperFallback` are published because they are the same door (core still calls those
 * three directly, from src/core/permissions/ and src/web/routes/permissions.ts), so a plugin
 * that later needs the grant state does not need a new core service to get it.
 */
import {
  CORE_SERVICE_OWNER,
  publishOwnedService,
  removeOwnedServices,
  type ServiceApi,
} from './plugins/service-registry.js'
import type { Disposable } from './plugins/disposable.js'
import {
  calendarAuthStatus,
  calendarHelperFallback,
  createEventKitSource,
  requestCalendarAccess,
} from './calendar/sources/eventkit.js'
import type { CalendarSource } from '../integrations/calendar/types.js'

/**
 * Publish a host capability as `core:<name>`. Same method-bag rule as a plugin's own.
 *
 * Goes through the registry's HOST door: the plugin-facing `publishService` refuses the
 * `core` owner outright, and no plugin may be named `core`, so this module is the only way
 * a `core:` key can exist.
 */
export function publishCoreService(name: string, api: ServiceApi): Disposable {
  return publishOwnedService(CORE_SERVICE_OWNER, name, api)
}

/** Withdraw every `core:` service. Server shutdown only; plugins keep their own. */
export function disposeCoreServices(): number {
  return removeOwnedServices(CORE_SERVICE_OWNER)
}

/**
 * `core:calendar-source` — the platform's calendar door.
 *
 * A method bag over the EventKit helper client. `createSource` is a FACTORY so a consumer
 * decides when the helper is first reached for (building it eagerly here would compile
 * Swift during boot), and the three permission calls are here rather than duplicated in the
 * plugin because the grant belongs to the host's signed binary.
 *
 * The api's type lives in this file, next to the publisher, which is the same rule a
 * capability plugin follows for its own `api.ts`.
 */
export interface CoreCalendarSourceApi {
  createSource(): CalendarSource
  authStatus(): Promise<'granted' | 'denied' | 'not-determined' | 'unknown'>
  requestAccess(): Promise<'granted' | 'denied' | 'unknown'>
  helperFallback(): { path: string; version: string } | null
}

export function publishCalendarSource(): Disposable {
  // `satisfies`, not an annotation: the registry's ServiceApi is an index signature, and
  // only an inferred object-literal type gets one implicitly. This still fails the build if
  // the bag drifts from CoreCalendarSourceApi.
  const api = {
    createSource: () => createEventKitSource(),
    authStatus: () => calendarAuthStatus(),
    requestAccess: () => requestCalendarAccess(),
    helperFallback: () => calendarHelperFallback(),
  } satisfies CoreCalendarSourceApi
  return publishCoreService('calendar-source', api)
}
