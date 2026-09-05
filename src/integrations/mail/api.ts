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
 * Ownership is the provider's, by design. The service handle carries no caller identity, so
 * the base cannot know which plugin called it and cannot sweep on that plugin's teardown.
 * Returning the Disposable from `activate` (or disposing it yourself) is what makes "turn the
 * provider off and its provider row disappears" true.
 */
import type { MailProviderRegistry } from './provider-registry.js'
import type { Disposable, MailProviderSpec, MailProviderSummary } from './types.js'

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

/** The contract version of `mail:base`, independent of the plugin's manifest version. */
export const MAIL_BASE_API_VERSION = '1.0.0'

/**
 * The method bag published as `mail:base`.
 *
 * Deliberately tiny in slice 0: registration, a read of what is registered, and a version to
 * branch on. Slice 1 grows it (accounts, mailboxes, cache reads) and a provider written
 * against this shape keeps working, because every addition is a new method.
 *
 * A type alias, NOT an interface: `services.publish` takes the host's
 * `Record<string, (...args) => unknown>`, and TypeScript gives an implicit index signature to
 * an object type alias but never to an interface. Declaring this as an interface compiles
 * everywhere except the one line that publishes it.
 */
export type MailBaseApi = {
  /** Attach a provider. Own the returned Disposable (see the file comment). */
  registerProvider(spec: MailProviderSpec): Disposable
  listProviders(): MailProviderSummary[]
  version(): string
}

export function createMailBaseApi(providers: MailProviderRegistry): MailBaseApi {
  // A plain object of closures, never a class instance: the host refuses a published service
  // with a prototype, because a consumer holding a per-key handle could not re-resolve it.
  return {
    registerProvider: (spec) => providers.register(spec),
    listProviders: () => providers.list(),
    version: () => MAIL_BASE_API_VERSION,
  }
}
