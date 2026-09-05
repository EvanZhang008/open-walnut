/**
 * Accounts: a pass-through to the provider, plus a mirror the rest of the base can rely on.
 *
 * The rule that shapes this whole file: the base NEVER persists the setup values. The console
 * renders the provider's declared fields, posts them here, and they go straight into
 * `provider.setup.submit(values)` and nowhere else. The provider writes its own config and its
 * own secret, so a password exists in exactly one place, and this module's only record of the
 * account is what `submit` handed back.
 *
 * Why mirror at all. Cached messages need a stable account row to hang off while the provider
 * plugin is disabled, reloading or broken, and the console needs to be able to show an account
 * that cannot currently be reached. The mirror is that row: an id, a display name, an address,
 * a state, and the last health reading. No credentials, ever.
 */
import { callProvider, MailServiceError, providerIdOf } from './contract.js'
import type { MailEvents } from './events.js'
import type { MailProviderRegistry } from './provider-registry.js'
import type { MailRetention } from './retention.js'
import type { MailStore } from './store.js'
import type { MailAccount, ProviderHealth } from './types.js'

/**
 * The backstop on `submit`, a little above the probe budget a provider sets for itself.
 *
 * The IMAP provider's own probe is ONE 15s deadline covering the connect and the LIST, so this
 * number is not what normally ends a slow setup. It exists for a provider that sets no budget at
 * all: without it, `POST /accounts` would hold a browser connection for as long as some third
 * party's socket felt like taking, and six of those is an app-wide stall.
 */
const SETUP_DEADLINE_MS = 18_000

export class MailAccounts {
  constructor(private readonly deps: {
    store: MailStore
    retention: MailRetention
    providers: MailProviderRegistry
    events: MailEvents
    /** Poll this account now. Fire and forget: setup must not wait for a backfill. */
    kick: (accountId: string) => void
    /** Drop the poll loop's memory of this account: its backoff, its park, its watch. */
    forget: (accountId: string) => Promise<void>
  }) {}

  /**
   * Hand the values to the provider and mirror what it returns.
   *
   * `values` is not logged, not stored and not echoed back. The one thing checked about the
   * result is the id shape: an account id is `<providerId>:<providerAccountId>`, and a
   * provider that returns anything else would produce rows nothing can ever route.
   */
  async setup(providerId: string, values: Record<string, string>): Promise<MailAccount> {
    const spec = this.deps.providers.get(providerId)
    if (!spec) {
      throw new MailServiceError('unknown_provider', `No mail provider "${providerId}" is registered.`, 404)
    }
    // Deliberately not wrapped in a try: the provider's own ProviderError carries the code
    // (`auth` / `unreachable`) and the plain-words message the console shows the user, and any
    // wrapper here would replace both with something generic.
    const account = await callProvider(
      'account setup',
      () => spec.setup.submit(values),
      SETUP_DEADLINE_MS,
    )
    if (!account?.accountId || providerIdOf(account.accountId) !== providerId) {
      throw new MailServiceError(
        'invalid_account',
        `Provider "${providerId}" returned the account id ${JSON.stringify(account?.accountId)},`
        + ` which must start with "${providerId}:" so the base can route it back to that provider.`,
        502,
      )
    }

    await this.mirror({ ...account, providerId })
    this.deps.events.accountChanged(account.accountId, 'added')
    this.deps.kick(account.accountId)
    return account
  }

  /** The account row, its mailboxes, its cached messages, its body files, and the provider's copy. */
  async remove(accountId: string, deadlineAt?: number): Promise<{ messages: number; complete: boolean }> {
    const existing = await this.deps.store.getAccount(accountId)
    if (!existing) {
      throw new MailServiceError('unknown_account', `No mail account "${accountId}".`, 404)
    }
    // FIRST, before any await that could let a tick in: the loop stops holding a backoff, a park
    // and a watch for an account that is going away, so a re-add starts clean instead of
    // inheriting `paused` from the account it replaced.
    await this.deps.forget(accountId)
    // The provider is told FIRST, but a provider that is gone or that refuses must not be able
    // to strand the mirror: the user asked for this account to go away, and a cache row nobody
    // can reach is worse than a provider that still holds a config block.
    const spec = this.deps.providers.get(providerIdOf(accountId))
    if (spec?.removeAccount) {
      try {
        await callProvider('account removal', () => spec.removeAccount!(accountId))
      } catch {
        /* reported by the provider's own logger; the mirror still goes */
      }
    }
    const purged = await this.deps.retention.purgeAccount(accountId, deadlineAt)
    this.deps.events.accountChanged(accountId, 'removed')
    return purged
  }

  /** Write (or refresh) the mirror row. Health is stored as given, including a failure. */
  async mirror(account: MailAccount & { health?: ProviderHealth }): Promise<void> {
    await this.deps.store.upsertAccount({
      accountId: account.accountId,
      providerId: account.providerId,
      displayName: account.displayName ?? '',
      address: account.address ?? '',
      state: account.state ?? 'active',
      healthJson: account.health ? JSON.stringify(account.health) : null,
      // The payload carries only what a MailAccount declares. A provider that returns extra
      // fields keeps them here rather than needing a migration, and none of them are secret:
      // `submit` already stored the credential in the provider's own secret store.
      payload: JSON.stringify({ ...account, health: undefined }),
    })
  }
}
