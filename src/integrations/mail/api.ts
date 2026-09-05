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

export type {
  AccountSetupField,
  AccountSetupFieldKind,
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
 */
export const MAIL_BASE_API_VERSION = '1.2.0'

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
}

export function createMailBaseApi(deps: {
  providers: MailProviderRegistry
  events: MailEvents
  sync: MailSync
  accounts: () => Promise<MailAccountDto[]>
  /** The host's current-caller reader, injected so the registry stays host-free. */
  caller: () => string | undefined
}): MailBaseApi {
  // A plain object of closures, never a class instance: the host refuses a published service
  // with a prototype, because a consumer holding a per-key handle could not re-resolve it.
  return {
    // `caller()` is read HERE, synchronously inside the method body, which is the only place
    // it means anything: after the first await the caller may be anybody.
    registerProvider: (spec) => deps.providers.register(spec, deps.caller() ?? 'unknown'),
    listProviders: () => deps.providers.list(),
    version: () => MAIL_BASE_API_VERSION,
    listAccounts: () => deps.accounts(),
    refresh: (accountId) => deps.sync.refresh(accountId),
    onAccountsChanged: (handler) => deps.events.onAccountsChanged(handler),
  }
}
