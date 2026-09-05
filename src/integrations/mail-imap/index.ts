/**
 * The IMAP provider plugin.
 *
 * It stands on the mail base, declares it as a manifest dependency, and attaches through the
 * base's published service. It never imports the base's code: the contract arrives as
 * `import type` from `../mail/api.js`, and the runtime handle comes from
 * `walnut.services.require('mail:base')`.
 *
 * The last line of `activate` is not decoration. Returning the base's Disposable is what hands
 * ownership of the registration to the loader, so turning this plugin off detaches its accounts
 * live. The base also records who registered (the host's `walnut.services.caller()`) and sweeps
 * the row if this plugin leaves a live state, which covers the one case the return cannot: an
 * activate that throws after `registerProvider` has already returned.
 */
import type { WalnutServerPluginApi } from '../../core/plugins/server-api.js'
import type { Disposable, MailBaseApi } from '../mail/api.js'
import { ImapPool } from './client.js'
import { ImapAccountStore } from './config.js'
import { createImapProvider } from './provider.js'

export function activate(walnut: WalnutServerPluginApi): Disposable {
  const store = new ImapAccountStore(walnut)
  const pool = new ImapPool({
    settings: (accountId) => store.settings(accountId),
    password: (accountId) => store.password(accountId),
    log: walnut.log,
  })

  const base = walnut.services.require<MailBaseApi>('mail:base')
  const registration = base.registerProvider(createImapProvider({ store, pool, log: walnut.log }))

  // Nothing after this line may throw: everything above it is already registered, and the
  // Disposable returned below is what the loader owns.
  return {
    dispose: async () => {
      registration.dispose()
      // Sockets close with the plugin. A connection left open would keep an IDLE session and a
      // TCP socket alive against a server the user just turned this plugin off for.
      await pool.disposeAll()
    },
  }
}
