import type { WalnutServerPluginApi } from '../../core/plugins/server-api.js'
import { createMailBaseApi } from './api.js'
import { openMailDatabase } from './db.js'
import { MailProviderRegistry, PROVIDERS_CHANGED_EVENT } from './provider-registry.js'
import { registerMailRoutes } from './routes.js'

/**
 * The Mail base, as a capability plugin.
 *
 * It owns the domain: the provider contract, the cache, the routes, and later the tools,
 * approvals and skill. The kernel keeps only the loader, the bus, storage primitives, the App
 * Registry, letters, auth and the server, and it never learns the word "mail".
 *
 * Slice 0 registers NO agent tool, on purpose. A zero-account install must leave the agent's
 * prompt byte-identical, so the tools arrive in P2-3 and only once an account exists; the
 * first account then pays exactly one prompt-cache miss.
 *
 * Activation only REGISTERS. Nothing here awaits I/O: a plugin has 20 seconds to activate,
 * and the database opens itself on first use (see db.ts).
 */

export function activate(walnut: WalnutServerPluginApi): { dispose(): Promise<void> } {
  const providers = new MailProviderRegistry((event) => {
    // The host namespaces this to `plugin:mail:providers-changed`.
    walnut.events.emit(PROVIDERS_CHANGED_EVENT, event)
  })

  const db = openMailDatabase(walnut)

  walnut.services.publish('base', createMailBaseApi(providers))
  registerMailRoutes(walnut, { db, providers })

  walnut.log.info('Mail base ready', { providers: providers.size })

  // The only teardown edge. `dispose` closes THIS instance, so a reload cannot have the old
  // activation's teardown close the new activation's database; a module-level `deactivate`
  // reaching for "the current one" could.
  return { dispose: () => db.dispose() }
}
