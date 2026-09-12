/**
 * The file a mail PROVIDER plugin imports.
 *
 * In repo, that is a relative `import type` from this path; once the contract ships on npm it
 * becomes a sibling types package (P3). Either way it is types only at the provider's end:
 * the runtime handle comes from `walnut.services.require('mail:base')`, so a provider never
 * imports the base's code.
 *
 * A provider plugin looks like this, and the last line is not optional:
 *
 *   export function activate(walnut) {
 *     const base = walnut.services.require('mail:base')
 *     return base.registerProvider(spec)   // returned = owned by the loader
 *   }
 *
 * Ownership is the provider's, by design: returning the Disposable from `activate` (or disposing
 * it yourself) is what makes "turn the provider off and its provider row disappears" true, and it
 * happens the moment the plugin goes rather than a bus tick later.
 *
 * The base ALSO records who called, from the host's synchronous `walnut.services.caller()`, and
 * drops that owner's rows when the plugin leaves a live state. That is a safety net for the one
 * case a provider cannot cover itself, an `activate` that throws after `registerProvider`
 * returned, and it is not a substitute for the line above.
 */
import type { MailAccountDto } from './contract.js'
import type { MailAccountChangedEvent, MailEvents } from './events.js'
import type { MailProviderRegistry } from './provider-registry.js'
import type { MailSync, TickReport } from './sync.js'
import type { Disposable, MailProviderSpec, MailProviderSummary } from './types.js'

export type { MailAccountChangedEvent } from './events.js'

/**
 * The one shape check for an email address, shared rather than re-invented per file.
 *
 * A provider needs it because a HEADER is whatever the sender typed: `Reply-To:
 * undisclosed-recipients:;` is a real header, and a provider that passes it through as an address
 * makes Reply fail at the draft route with a 400 in a place the human cannot see.
 */
export { ADDRESS_SHAPE } from './agent-format.js'

export type {
  AccountSetupField,
  AccountSetupFieldKind,
  AccountSetupPreset,
  AccountSetupSpec,
  Disposable,
  MailAccount,
  MailAccountState,
  MailAddress,
  MailAttachmentMeta,
  MailBody,
  MailCapabilities,
  MailEnvelope,
  MailPollRequest,
  MailPollResult,
  MailProviderSpec,
  MailProviderSummary,
  MailSendResult,
  MailWatchHint,
  Mailbox,
  MailboxRole,
  OutgoingMail,
  ProviderError,
  ProviderErrorCode,
  ProviderHealth,
  ProviderHealthState,
} from './types.js'

/**
 * The contract version of `mail:base`, independent of the plugin's manifest version.
 *
 * 1.1.0 in slice 1: `listAccounts`, `refresh` and `onAccountsChanged` were added and nothing
 * existing changed shape, which is exactly what a minor bump means. It has to MOVE when methods
 * arrive, or `version()` is a number no provider can gate on.
 *
 * 1.2.0 is the send path. No METHOD changed, but three things a provider can gate on did, all
 * additive: `MailProviderSpec.accountCapabilities` (per-account `send`), `OutgoingMail.bodyHtml`
 * (the base renders the html half now, so a provider must not), and `ProviderError.stage` (how far
 * a failed send got, which is the field that decides whether a retry is allowed).
 *
 * 1.3.0 is the DTO gaining fields, which is the other kind of thing a provider gates on: an
 * envelope may now carry `replyTo`, `MailMessageDto` carries `cc`, `replyTo` and `taskId`, and
 * `MailAccountDto` carries a per-account `capabilities.send`. All additive, all optional.
 *
 * 1.4.0 adds `AccountSetupSpec.presets` (known services, so the console can fill the server
 * fields from an address domain) and carries them to the console as `MailProviderSummary.setupPresets`.
 * Additive and optional: a provider that declares none renders exactly the form it did before.
 *
 * 1.5.0 lets `MailBody` carry `from`, `to`, `cc` and `replyTo`, for a transport whose LISTING
 * cannot name an address and only a body fetch can. The base treats them as gap fill only: an
 * address the envelope already had is never overwritten. Additive and optional.
 *
 * 1.6.0 is ADOPTION: the base finally calls `listAccounts()`. A provider that renders no setup
 * fields is swept right after it registers, so an ambient mailbox (no password to type, the helper
 * already knows the account) is simply there instead of waiting for a human to fill in a form about
 * their own address. `adoptAccounts(providerId?)` is the same sweep on demand, and it is what a
 * provider that discovers its accounts LATE (after its own async probe, or one that does have a
 * setup form as well) calls to be mirrored without a setup POST. Adoption never touches an account
 * the mirror already has, and a setup POST is still how a credentialed account is added.
 *
 * 1.7.0 is `MailProviderSpec.bodyRevision`, the one thing a provider could not say: that what
 * `getBody` returns for a message the base has ALREADY fetched has changed. A revision the base has
 * not seen retires every body it cached from that provider's accounts, once, envelopes untouched,
 * and each one is fetched again the next time it is opened. Additive and optional: a provider that
 * declares none sweeps nothing, ever.
 *
 * 1.8.0 is `MailProviderSpec.identityRevision`, the heavier sibling: what a `messageId` MEANS has
 * changed, so every row cached under the old handles is a ghost no poll will ever match again. A
 * revision the base has not seen drops every cached message of that provider's accounts and forgets
 * every mailbox cursor, once, and the next poll lists each mailbox again from the top. Same shape as
 * 1.7.0 otherwise: additive, optional, per provider, recorded only after the sweep finishes.
 */
export const MAIL_BASE_API_VERSION = '1.8.0'

/**
 * The method bag published as `mail:base`.
 *
 * Every version of this type only ADDS methods, which is what lets a provider written against
 * the slice-0 shape keep working: the four read methods below arrived in slice 1 and no
 * existing signature changed. Check `version()` before calling something new.
 *
 * A type alias, NOT an interface: `services.publish` takes the host's
 * `Record<string, (...args) => unknown>`, and TypeScript gives an implicit index signature to
 * an object type alias but never to an interface. Declaring this as an interface compiles
 * everywhere except the one line that publishes it.
 */
export type MailBaseApi = {
  /**
   * Attach a provider. Own the returned Disposable (see the file comment).
   *
   * The base also records WHICH plugin called this, from the host's synchronous
   * `walnut.services.caller()`, and drops the registration if that plugin leaves a live state.
   * So an `activate` that throws after this line no longer strands a row that blocks every
   * retry with the duplicate-id refusal. Returning the Disposable is still the contract: it is
   * what makes a clean teardown immediate rather than lifecycle-event shaped.
   */
  registerProvider(spec: MailProviderSpec): Disposable
  listProviders(): MailProviderSummary[]
  version(): string
  /** The mirrored accounts, with health and an unread count. Never any secret value. */
  listAccounts(): Promise<MailAccountDto[]>
  /** Poll now: one account, or every account when the id is omitted. */
  refresh(accountId?: string): Promise<TickReport>
  /** Told when an account is added, changed or removed. Owned by the caller. */
  onAccountsChanged(handler: (event: MailAccountChangedEvent) => void): Disposable
  /**
   * Mirror the accounts `listAccounts()` reports and return the ids that were new (1.6.0).
   *
   * For a provider that discovers its accounts after its own probe, or that has a setup form and
   * ambient accounts as well: a provider with no setup fields is swept automatically when it
   * registers and does not need this. An account the mirror already has is never touched, so
   * calling it repeatedly is safe, and it never rejects: what it could not reach is logged.
   */
  adoptAccounts(providerId?: string): Promise<string[]>
}

export function createMailBaseApi(deps: {
  providers: MailProviderRegistry
  events: MailEvents
  sync: MailSync
  accounts: () => Promise<MailAccountDto[]>
  /** The host's current-caller reader, injected so the registry stays host-free. */
  caller: () => string | undefined
  /** Mirror what a provider already knows about. Never rejects; it logs what it could not reach. */
  adopt: (providerId?: string) => Promise<string[]>
  /**
   * Reconcile `spec.bodyRevision`: drop the bodies this provider handed over before its own fix.
   *
   * Takes the revision rather than reading it back from the registry, so the value that was
   * declared at registration is the one that is acted on even if the registration went away in
   * between. Skipped entirely on a replica, where there is no cache to retire.
   */
  bodyRevision: (providerId: string, revision: string | undefined) => Promise<void>
  /**
   * Reconcile `spec.identityRevision`: drop every row this provider handed over under its old
   * handles and forget the cursors, so the next poll re-lists. Same calling shape as `bodyRevision`.
   */
  identityRevision: (providerId: string, revision: string | undefined) => Promise<void>
  /**
   * Run this after the current turn, on a timer the host owns.
   *
   * Injected rather than `setImmediate` so the loader cancels a pending sweep when it tears the
   * plugin down. A floating promise that opens the mail database after a teardown re-creates the
   * plugin's data directory behind the loader, which is the same reason activation arms its first
   * cache read on a host timer.
   */
  defer: (run: () => void) => void
}): MailBaseApi {
  // A plain object of closures, never a class instance: the host refuses a published service
  // with a prototype, because a consumer holding a per-key handle could not re-resolve it.
  return {
    // `caller()` is read HERE, synchronously inside the method body, which is the only place
    // it means anything: after the first await the caller may be anybody.
    registerProvider: (spec) => {
      const handle = deps.providers.register(spec, deps.caller() ?? 'unknown')
      // A provider that renders NO setup form has nothing to wait for a human about, so its
      // accounts are adopted the moment it attaches. One that declares fields is asking for
      // something only the person knows, and those accounts still arrive by setup POST; such a
      // provider opts in with one `adoptAccounts` call of its own.
      //
      // DEFERRED and never awaited: `registerProvider` is called inside a provider plugin's
      // activate, which has 20 seconds in total, and a slow `listAccounts` must not spend any of
      // it. The registration is looked up again inside the sweep, so an activate that throws
      // after this line adopts nothing at all.
      if ((spec?.setup?.fields?.length ?? 0) === 0) {
        deps.defer(() => {
          // `adopt` reports its own failures. The catch is only here so a future change to that
          // cannot turn a background sweep into an unhandled rejection.
          void deps.adopt(spec.id).catch(() => undefined)
        })
      }
      // A provider whose own fix changed what an already-fetched body looks like. Deferred like the
      // sweep above and for the same reason: it opens the cache, and a plugin has 20 seconds in
      // total to activate. Armed ONLY when a revision is declared, so the common case (a provider
      // whose decoding never changed) still opens no database on registration at all.
      if (spec?.bodyRevision !== undefined) {
        const revision = spec.bodyRevision
        deps.defer(() => {
          // The wiring logs its own failures; this catch only keeps a background sweep from
          // becoming an unhandled rejection.
          void deps.bodyRevision(spec.id, revision).catch(() => undefined)
        })
      }
      // A provider whose handles changed meaning. Deferred for the same reason; and it runs whether
      // or not a body revision also moved, because the two answer different questions (what a body
      // says vs. which row a handle names) and a provider may bump either alone.
      if (spec?.identityRevision !== undefined) {
        const revision = spec.identityRevision
        deps.defer(() => {
          void deps.identityRevision(spec.id, revision).catch(() => undefined)
        })
      }
      return handle
    },
    listProviders: () => deps.providers.list(),
    version: () => MAIL_BASE_API_VERSION,
    listAccounts: () => deps.accounts(),
    refresh: (accountId) => deps.sync.refresh(accountId),
    onAccountsChanged: (handler) => deps.events.onAccountsChanged(handler),
    adoptAccounts: (providerId) => deps.adopt(providerId),
  }
}
