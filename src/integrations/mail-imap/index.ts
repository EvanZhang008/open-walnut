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
import type { CoreMailCalendarCredentialsApi } from '../../core/calendar/mail-credentials.js'

/**
 * Hand one account's password to the calendar (and only to it), so a mail account set up once
 * can bring its calendar too. The host's broker checks who provides and who reads
 * (src/core/calendar/mail-credentials.ts). Never fatal: mail works the same without it.
 */
function provideCalendarCredentials(walnut: WalnutServerPluginApi, store: ImapAccountStore): Disposable {
  try {
    const broker = walnut.services.get<CoreMailCalendarCredentialsApi>('core:mail-calendar-credentials')
    return broker.provide('imap', {
      async credentials(accountId) {
        const entry = await store.entry(accountId)
        const password = entry ? await store.password(accountId) : undefined
        if (!entry || !password) return undefined
        return {
          accountId: entry.accountId,
          address: entry.settings.address,
          password,
          hosts: {
            imap: entry.settings.host,
            ...(entry.smtp ? { smtp: entry.smtp.host } : {}),
            ...(entry.caldavUrl ? { caldav: entry.caldavUrl } : {}),
          },
        }
      },
      async account(accountId) {
        const entry = await store.entry(accountId)
        if (!entry) return undefined
        return { accountId: entry.accountId, address: entry.settings.address, hosts: { imap: entry.settings.host, ...(entry.smtp ? { smtp: entry.smtp.host } : {}) } }
      },
      setCalendarServer: (accountId, url) => store.setCalendarServer(accountId, url),
    })
  } catch (error: unknown) {
    walnut.log.warn('mail accounts cannot bring their calendars on this Walnut', { error: String(error).slice(0, 200) })
    return { dispose: () => undefined }
  }
}

export function activate(walnut: WalnutServerPluginApi): Disposable {
  const store = new ImapAccountStore(walnut)
  const pool = new ImapPool({
    settings: (accountId) => store.settings(accountId),
    password: (accountId) => store.password(accountId),
    log: walnut.log,
  })

  const base = walnut.services.require<MailBaseApi>('mail:base')
  const registration = base.registerProvider(createImapProvider({ store, pool, log: walnut.log }))
  const calendarCredentials = provideCalendarCredentials(walnut, store)

  // Nothing after this line may throw: everything above it is already registered, and the
  // Disposable returned below is what the loader owns.
  return {
    dispose: async () => {
      calendarCredentials.dispose()
      registration.dispose()
      // Sockets close with the plugin. A connection left open would keep an IDLE session and a
      // TCP socket alive against a server the user just turned this plugin off for.
      await pool.disposeAll()
    },
  }
}
