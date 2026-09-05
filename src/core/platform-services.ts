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
 * Nothing is published here yet. The first caller is the calendar source extraction.
 */
import {
  CORE_SERVICE_OWNER,
  publishOwnedService,
  removeOwnedServices,
  type ServiceApi,
} from './plugins/service-registry.js'
import type { Disposable } from './plugins/disposable.js'

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
