/**
 * The plugin-on-plugin seam: one plugin publishes a method bag under `<pluginId>:<name>`,
 * and a plugin that DECLARED that publisher as a manifest dependency gets a handle to it.
 *
 * Module-global with owner scoping, like every other plugin-contributed slot (commands,
 * skills, ws methods, ops). Entries leave through the `own()` Disposable on a clean
 * teardown and through `removeServicesOf` when a dispose threw partway.
 *
 * Five rules this file encodes, each of which is load-bearing:
 *
 * - SYNC ONLY. There is no awaitable `get`, and there must never be one: the topological
 *   load order already guarantees a declared dependency is `active` before the dependent's
 *   activate runs, so waiting would only ever wait for something that cannot arrive, which
 *   is a deadlock generator dressed up as a convenience.
 * - The handle is per KEY, not per instance, and it resolves at CALL time. A consumer that
 *   grabbed a handle (or destructured a method out of it) during activate keeps working
 *   across a republish or a reload of the publisher, which is what makes a single-plugin
 *   reload a single-node operation instead of a coordinated restart.
 * - An absent entry throws, loudly. A service that quietly answers `undefined` after its
 *   publisher was turned off produces a bug report about the CONSUMER.
 * - A published api is a plain method bag. A class instance, an EventEmitter or a Promise
 *   carries identity and state that the consumer cannot re-resolve, which is precisely
 *   what the per-key handle above depends on being able to do.
 * - `core` is the host's owner and nobody else's. The plugin-facing doors refuse it, and
 *   `validateManifest` refuses a plugin claiming the id, because a `core:` key is the one
 *   thing every plugin may use with no declaration at all.
 */
import { OwnedRegistry, type OwnedRegistryChange } from './owned-registry.js'
import { validatePluginId } from './ids.js'
import type { Disposable } from './disposable.js'
import { bus } from '../event-bus.js'

/** Every published service is a bag of functions and nothing else. */
export type ServiceApi = Record<string, (...args: any[]) => unknown>

export interface ServiceEntry {
  key: string
  pluginId: string
  api: ServiceApi
}

export type ServiceChangeAction = 'published' | 'replaced' | 'removed'

export interface ServiceChange {
  key: string
  pluginId: string
  action: ServiceChangeAction
}

/** Owner (and key prefix) of a capability the host itself publishes. */
export const CORE_SERVICE_OWNER = 'core'

export const SERVICE_CHANGED_EVENT = 'plugin:service-changed'

/**
 * A service name is a local id, so it stays in the shape a key can be split on: no `:`
 * (that is the host's namespace separator) and nothing a log line or a config key would
 * have to escape.
 */
const SERVICE_NAME = /^[a-z0-9][a-z0-9_-]*$/

const services = new OwnedRegistry<ServiceEntry>()

/**
 * Every registry mutation becomes one bus event, including the ones no caller made
 * directly: a Disposable firing during plugin teardown, and an owner sweep. Wiring the
 * emit here rather than at the call sites is what makes "removed" impossible to forget.
 */
services.subscribe((change: OwnedRegistryChange) => {
  for (const event of busEventsFor(change)) {
    bus.emit(SERVICE_CHANGED_EVENT, event, ['web-ui'], { source: 'plugin-services' })
  }
})

function busEventsFor(change: OwnedRegistryChange): ServiceChange[] {
  switch (change.type) {
    case 'registered':
      return [{ key: change.key, pluginId: change.owner, action: 'published' }]
    case 'replaced':
      return [{ key: change.key, pluginId: change.owner, action: 'replaced' }]
    case 'removed':
      return [{ key: change.key, pluginId: change.owner, action: 'removed' }]
    case 'owner-removed':
      return change.keys.map((key) => ({ key, pluginId: change.owner, action: 'removed' as const }))
    // `cleared` is the test-only reset. It has no owner, and announcing a teardown of the
    // whole registry to subscribers that are themselves about to be rebuilt is noise.
    default:
      return []
  }
}

export function serviceKey(pluginId: string, name: string): string {
  validatePluginId(pluginId)
  if (typeof name !== 'string' || !SERVICE_NAME.test(name)) {
    throw new Error(
      `Invalid service name: ${JSON.stringify(name)} (allowed: ${SERVICE_NAME.source}, and a service name may not contain ":")`,
    )
  }
  return `${pluginId}:${name}`
}

/** The plugin half of a key, for both the access rule and the unavailable message. */
export function servicePublisherOf(key: string): string {
  const separator = typeof key === 'string' ? key.indexOf(':') : -1
  if (separator <= 0) {
    throw new Error(`Invalid service key: ${JSON.stringify(key)} (expected "<pluginId>:<name>")`)
  }
  const pluginId = key.slice(0, separator)
  validatePluginId(pluginId)
  if (!SERVICE_NAME.test(key.slice(separator + 1))) {
    throw new Error(`Invalid service key: ${JSON.stringify(key)} (expected "<pluginId>:<name>")`)
  }
  return pluginId
}

/**
 * A published api must be a plain object whose own enumerable values are all functions.
 *
 * The prototype check is the one that matters: a class instance, an EventEmitter and a
 * Promise all pass "object with function properties" while carrying identity a consumer
 * holding a per-key handle can never re-resolve.
 */
function assertMethodBag(key: string, api: unknown): asserts api is ServiceApi {
  const rule = 'a service api must be a plain object whose own enumerable properties are all functions'
  if (typeof api !== 'object' || api === null || Array.isArray(api)) {
    throw new Error(`Service "${key}" cannot be published: ${rule} (got ${api === null ? 'null' : Array.isArray(api) ? 'an array' : typeof api})`)
  }
  const prototype = Object.getPrototypeOf(api)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(
      `Service "${key}" cannot be published: ${rule}, and this one has a prototype (${prototype?.constructor?.name ?? 'unknown'}): pass a bag of methods that close over your state instead`,
    )
  }
  for (const [name, value] of Object.entries(api)) {
    if (typeof value !== 'function') {
      throw new Error(`Service "${key}" cannot be published: ${rule}, but "${name}" is ${typeof value}`)
    }
  }
  // An object with `then` is a thenable, so `await handle` would try to RESOLVE the
  // service instead of handing it over, and a consumer would silently get the wrong value.
  if (Object.prototype.hasOwnProperty.call(api, 'then')) {
    throw new Error(`Service "${key}" cannot be published: a service api may not have a method named "then", which would make the handle a thenable`)
  }
}

/**
 * Publish `api` as `<pluginId>:<name>`, replacing this plugin's earlier value for the same
 * name. The returned Disposable withdraws exactly the value it installed, so the handle
 * from a replaced publish is already a no-op.
 *
 * The PLUGIN door: `core` is refused here, because the whole point of a `core:` key is that
 * no manifest dependency gates it. A plugin that could claim the owner could publish a key
 * every other plugin trusts unconditionally, and its teardown sweep would take the host's
 * services with it.
 */
export function publishService(pluginId: string, name: string, api: unknown): Disposable {
  if (pluginId === CORE_SERVICE_OWNER) {
    throw new Error(`Plugin id "${CORE_SERVICE_OWNER}" is reserved: only the host publishes ${CORE_SERVICE_OWNER}:* services`)
  }
  return publishOwnedService(pluginId, name, api)
}

/** The HOST door. Never handed to a plugin: `platform-services.ts` is its only caller. */
export function publishOwnedService(owner: string, name: string, api: unknown): Disposable {
  const key = serviceKey(owner, name)
  assertMethodBag(key, api)
  return services.replace(owner, key, { key, pluginId: owner, api })
}

export function getServiceEntry(key: string): ServiceEntry | undefined {
  return services.get(key)
}

export function listServiceKeys(): string[] {
  return services.entries().map((entry) => entry.key).sort()
}

/**
 * Withdraw everything one plugin published. Mirrors the other owned slots' sweeps.
 *
 * The PLUGIN door again: `core` is not a plugin, so a loader sweep can never reach the
 * host's services. Silent rather than thrown, because the caller is a teardown loop over
 * whatever ids the manager held and a throw there would abort the rest of the shutdown.
 */
export function removeServicesOf(pluginId: string): number {
  if (pluginId === CORE_SERVICE_OWNER) return 0
  return services.removeOwner(pluginId)
}

/** The HOST door for withdrawal. `platform-services.ts` is its only caller. */
export function removeOwnedServices(owner: string): number {
  return services.removeOwner(owner)
}

/** Test-only reset — production withdrawal goes through the per-plugin Disposable. */
export function resetServicesForTesting(): void {
  services.clear()
}

/** Lifecycle states whose wire name does not read as a sentence. */
const PLAIN_STATE: Record<string, string> = {
  'needs-dependency': 'waiting on its own dependencies',
  'needs-config': 'not configured',
  quarantined: 'quarantined after repeated activation failures',
  unsupported: 'not supported by this Walnut version',
}

function describeUnavailable(key: string, publisherId: string, state?: string): string {
  // A RUNNING publisher that has no such key means the consumer asked for a name nobody
  // publishes, which is a different bug from "the publisher is down" and must not be
  // reported as `"alpha" is active`.
  if (state === 'active' || state === 'activating') {
    return `Service "${key}" is unavailable: "${publisherId}" is running but has not published "${key.slice(key.indexOf(':') + 1)}"`
  }
  return `Service "${key}" is unavailable: "${publisherId}" is ${(state && PLAIN_STATE[state]) ?? state ?? 'not running'}`
}

export class ServiceUnavailableError extends Error {
  readonly code = 'service-unavailable'

  constructor(readonly key: string, readonly publisherId: string, publisherState?: string) {
    super(describeUnavailable(key, publisherId, publisherState))
    this.name = 'ServiceUnavailableError'
  }
}

/** A lookup that throws must not be able to replace the honest error with its own. */
function safeState(publisherId: string, lookupState?: (pluginId: string) => string | undefined): string | undefined {
  try { return lookupState?.(publisherId) }
  catch { return undefined }
}

/**
 * Throw now if nothing publishes `key`. This is the whole difference between `require` and
 * `get`: a typo'd key fails during the consumer's activate, where the stack still names it,
 * instead of at the first call hours later.
 */
export function assertServiceAvailable(
  key: string,
  publisherId: string,
  lookupState?: (pluginId: string) => string | undefined,
): void {
  if (services.has(key)) return
  throw new ServiceUnavailableError(key, publisherId, safeState(publisherId, lookupState))
}

/**
 * Who publishes `key`, refused when the caller has no business asking.
 *
 * A declared dependency is what makes the load order a guarantee, so `get` without one
 * would work exactly until the day the directory read order changed. `core:` keys are
 * exempt because the host is not a plugin: what gates those is `engines.walnut`, checked
 * before any of this plugin's code was imported.
 */
export function resolveServiceAccess(
  consumerId: string,
  key: string,
  dependencies?: Record<string, string>,
): string {
  const publisherId = servicePublisherOf(key)
  if (publisherId === CORE_SERVICE_OWNER || publisherId === consumerId) return publisherId
  if (!dependencies || !Object.prototype.hasOwnProperty.call(dependencies, publisherId)) {
    throw new Error(
      `Plugin "${consumerId}" may not use service "${key}": "${consumerId}" must declare `
      + `dependencies.${publisherId} in its manifest before it can ask for "${publisherId}"'s services`,
    )
  }
  return publisherId
}

export interface ServiceHandleOptions {
  key: string
  publisherId: string
  /** Current lifecycle state of the publisher, so an unavailable service says WHY. */
  lookupState?: (pluginId: string) => string | undefined
}

/**
 * A live handle to `key`, resolved at CALL time.
 *
 * Reading a method hands back a wrapper that looks the entry up when it is invoked, so
 * `svc.greet(x)`, `const { greet } = svc; greet(x)` and a method stashed in a field all
 * reach whatever is published at that moment. Anything weaker makes "the next call reaches
 * the new instance" true for one spelling and false for the others.
 *
 * `has`/`ownKeys`/`getOwnPropertyDescriptor` describe the current api WITHOUT throwing, so
 * a debugger, a test reporter, `util.inspect` and a defensive `'greet' in svc` all keep
 * working after the publisher is gone. Throwing is reserved for a property READ and a call.
 *
 * Every mutating trap returns false. A `set` or `delete` is an obvious mistake, but
 * `defineProperty`/`preventExtensions` are the dangerous pair: letting `Object.freeze(svc)`
 * succeed against the empty target would permanently break the proxy invariants, and every
 * later `Object.keys(svc)` would throw a TypeError instead of answering.
 */
export function createServiceHandle<T = ServiceApi>(options: ServiceHandleOptions): T {
  const { key, publisherId, lookupState } = options
  const describe = (): ServiceApi => services.get(key)?.api ?? {}
  const current = (): ServiceApi => {
    const entry = services.get(key)
    if (!entry) throw new ServiceUnavailableError(key, publisherId, safeState(publisherId, lookupState))
    return entry.api
  }
  return new Proxy({} as ServiceApi, {
    get(_target, property) {
      if (typeof property === 'symbol') return undefined
      const value = current()[property]
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => {
        const api = current()
        const method = api[property]
        if (typeof method !== 'function') {
          throw new Error(`Service "${key}" no longer provides "${property}"`)
        }
        return method.apply(api, args)
      }
    },
    has(_target, property) {
      return typeof property === 'string' && property in describe()
    },
    ownKeys() {
      return Object.keys(describe())
    },
    getOwnPropertyDescriptor(_target, property) {
      if (typeof property === 'symbol') return undefined
      const api = describe()
      if (!Object.prototype.hasOwnProperty.call(api, property)) return undefined
      return { value: api[property], writable: false, enumerable: true, configurable: true }
    },
    set() {
      return false
    },
    deleteProperty() {
      return false
    },
    defineProperty() {
      return false
    },
    preventExtensions() {
      return false
    },
    setPrototypeOf() {
      return false
    },
    getPrototypeOf() {
      return Object.prototype
    },
  }) as T
}
