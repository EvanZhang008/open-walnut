/**
 * `core:mail-calendar-credentials`: how a mail account's saved password reaches the calendar,
 * and nothing else.
 *
 * A mail account set up once (IMAP: an address, a server, an app password) can bring its
 * calendar too, over CalDAV, with the same password. The password lives in the mail plugin's
 * own secret store, and plugin secret stores are per plugin on purpose. The calendar cannot
 * declare the mail plugin a dependency either: a calendar must not stop working because mail
 * is off. So the host brokers one narrow exchange, the way it brokers the EventKit door:
 *
 * - only the IMAP plugin may `provide` the credentials of `imap:` accounts;
 * - only the calendar plugin may ask for `credentials(accountId)`, one account at a time;
 * - the answer is that account's address, login name, server names and password, nothing
 *   else (no account list, no other secret);
 * - the calendar may write one thing back, the account's calendar server (`caldav_url`), and
 *   only when the person picked it in the account's row ("Use this server").
 *
 * Who calls is read from the service registry (`currentServiceCaller`) on the first line of
 * each method, as that value is only set during the synchronous part of a call.
 */
import { currentServiceCaller } from '../plugins/service-registry.js'
import type { Disposable } from '../plugins/disposable.js'

export interface MailCalendarCredentials {
  accountId: string
  address: string
  /** The login name, when it is not the address. */
  username?: string
  password: string
  /** Where the account's servers are; `caldav` when the account names its calendar server. */
  hosts: { imap?: string; smtp?: string; caldav?: string }
}

export interface MailCalendarCredentialProvider {
  credentials(accountId: string): Promise<MailCalendarCredentials | undefined>
  /** Save the account's calendar server; false when there is no such account. */
  setCalendarServer?(accountId: string, url: string): Promise<boolean>
}

export interface CoreMailCalendarCredentialsApi {
  /** Register the credentials of one account kind (`imap`). Only that kind's plugin may. */
  provide(kind: string, provider: MailCalendarCredentialProvider): Disposable
  /** One account's credentials, for the calendar plugin only; undefined when there are none. */
  credentials(accountId: string): Promise<MailCalendarCredentials | undefined>
  /** Save one account's calendar server (https, or this machine), for the calendar plugin only. */
  setCalendarServer(accountId: string, url: string): Promise<boolean>
}

/** Account kind → the one plugin that may provide its credentials. */
const PROVIDER_OF: Readonly<Record<string, string>> = { imap: 'mail-imap' }
const READER = 'calendar'

function kindOf(accountId: string): string {
  const colon = accountId.indexOf(':')
  return colon > 0 ? accountId.slice(0, colon) : ''
}

export function createMailCalendarCredentials(): CoreMailCalendarCredentialsApi {
  const providers = new Map<string, MailCalendarCredentialProvider>()
  return {
    provide(kind, provider) {
      const caller = currentServiceCaller()
      if (!PROVIDER_OF[kind] || caller !== PROVIDER_OF[kind]) {
        throw new Error(`Only the ${PROVIDER_OF[kind] ?? 'matching'} plugin may provide ${kind} mail credentials for calendars`)
      }
      providers.set(kind, provider)
      return {
        dispose: () => {
          if (providers.get(kind) === provider) providers.delete(kind)
        },
      }
    },
    async credentials(accountId) {
      const caller = currentServiceCaller()
      if (caller !== READER) throw new Error('Only the calendar plugin may read mail credentials for calendars')
      if (typeof accountId !== 'string') return undefined
      const provider = providers.get(kindOf(accountId))
      if (!provider) return undefined
      const found = await provider.credentials(accountId)
      if (!found || found.accountId !== accountId || !found.password) return undefined
      // Only these fields cross, whatever the provider handed back.
      return {
        accountId: found.accountId,
        address: found.address,
        ...(found.username ? { username: found.username } : {}),
        password: found.password,
        hosts: {
          ...(found.hosts.imap ? { imap: found.hosts.imap } : {}),
          ...(found.hosts.smtp ? { smtp: found.hosts.smtp } : {}),
          ...(found.hosts.caldav ? { caldav: found.hosts.caldav } : {}),
        },
      }
    },
    async setCalendarServer(accountId, url) {
      const caller = currentServiceCaller()
      if (caller !== READER) throw new Error('Only the calendar plugin may set a mail account\'s calendar server')
      if (typeof accountId !== 'string' || typeof url !== 'string') return false
      let parsed: URL
      try {
        parsed = new URL(url)
      } catch {
        return false
      }
      // https, or a server on this machine (as the calendar itself allows).
      const local = parsed.protocol === 'http:' && /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/.test(parsed.hostname)
      if ((parsed.protocol !== 'https:' && !local) || parsed.username || parsed.password) return false
      const provider = providers.get(kindOf(accountId))
      if (!provider?.setCalendarServer) return false
      return provider.setCalendarServer(accountId, parsed.toString())
    },
  }
}
