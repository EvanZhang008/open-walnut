/**
 * The mail provider contract. Types only, no logic: this file is what a provider plugin
 * reads to know what it must implement, and it must stay importable with nothing behind it.
 *
 * Three rules the shapes here encode, each one load bearing:
 *
 * - Capabilities are DATA, not duck typing. The base reads `capabilities.search`, never
 *   `typeof provider.search`, so a provider can ship a method it has not finished and
 *   declare it off, and the console can hide a feature without asking the transport.
 * - Ids split on the FIRST separator only. `accountId` is `<providerId>:<providerAccountId>`
 *   and everything after that colon is opaque to the base, because mailbox names and message
 *   handles contain colons of their own.
 * - Dates are instants. `sentAt` is epoch milliseconds and `sentAtHeader` keeps the original
 *   header string; do not copy the calendar module's timezone-less wall-time convention.
 */

/** Structurally the host's Disposable, restated so this file needs no host import. */
export interface Disposable {
  dispose(): void | Promise<void>
}

export interface MailCapabilities {
  search: boolean
  watch: boolean
  drafts: boolean
  markRead: boolean
  flags: boolean
  threads: boolean
  send: boolean
  sendAsReply: boolean
  bodies: 'text' | 'html' | 'both'
  attachments: 'none' | 'metadata' | 'download'
}

export type AccountSetupFieldKind = 'text' | 'password' | 'select'

export interface AccountSetupField {
  name: string
  label: string
  kind: AccountSetupFieldKind
  help?: string
  required?: boolean
  placeholder?: string
  /** Only for `select`. */
  options?: Array<{ value: string; label: string }>
}

/**
 * What the console renders for "add an account", declared by the provider.
 *
 * `submit` receives the raw values and returns the account record. The base passes them
 * straight through and NEVER persists them: the provider owns its own config and secrets,
 * so a credential exists in exactly one place.
 */
export interface AccountSetupSpec {
  fields: AccountSetupField[]
  submit(values: Record<string, string>): Promise<MailAccount>
}

export type MailAccountState = 'active' | 'auth-required' | 'disabled'

export interface MailAccount {
  /** `<providerId>:<providerAccountId>`. */
  accountId: string
  providerId: string
  displayName: string
  address: string
  state: MailAccountState
  health?: ProviderHealth
}

export type MailboxRole = 'inbox' | 'sent' | 'drafts' | 'archive' | 'trash' | 'spam' | 'other'

export interface Mailbox {
  mailboxId: string
  name: string
  role: MailboxRole
  unread?: number
  total?: number
}

export interface MailAddress {
  name?: string
  address: string
}

export interface MailAttachmentMeta {
  id?: string
  filename?: string
  mimeType?: string
  bytes?: number
}

export interface MailEnvelope {
  /** The provider's fetch coordinate (IMAP: `mailbox:uidvalidity:uid`). Not durable. */
  messageId: string
  /** The RFC `Message-ID` header: the durable key that survives a folder move. */
  rfcMessageId: string
  mailboxId: string
  from: MailAddress
  to?: MailAddress[]
  cc?: MailAddress[]
  subject: string
  snippet?: string
  /** Epoch milliseconds. */
  sentAt: number
  /** The original `Date` header, kept verbatim. */
  sentAtHeader?: string
  receivedAt?: number
  flags?: string[]
  inReplyTo?: string
  references?: string[]
  attachments?: MailAttachmentMeta[]
  bodyBytes?: number
}

export interface OutgoingMail {
  to: MailAddress[]
  cc?: MailAddress[]
  bcc?: MailAddress[]
  subject: string
  bodyMarkdown: string
  inReplyTo?: string
  references?: string[]
}

export type ProviderHealthState = 'ok' | 'auth-required' | 'unreachable' | 'degraded'

export interface ProviderHealth {
  state: ProviderHealthState
  /** Epoch milliseconds. */
  checkedAt: number
  detail?: string
}

/**
 * The closed error union. A per-item failure (one unfetchable message) must never flip
 * account health; only an account-level failure does.
 */
export type ProviderErrorCode =
  | 'auth'
  | 'rate-limit'
  | 'not-found'
  | 'unsupported'
  | 'invalid'
  | 'unreachable'
  | 'too-large'

export interface ProviderError {
  code: ProviderErrorCode
  message: string
  retryAfterMs?: number
}

export interface MailPollRequest {
  mailbox: string
  cursor?: string
  limit: number
}

export interface MailPollResult {
  messages: MailEnvelope[]
  /** Opaque and provider owned. The base stores it per container and never parses it. */
  cursor: string
  more: boolean
  /** "Your cursor is void, resync this container" (an IMAP UIDVALIDITY change). */
  reset?: boolean
}

export interface MailBody {
  format: 'text' | 'html'
  text?: string
  html?: string
  bytes: number
}

export interface MailSendResult {
  providerMessageId?: string
  /** Epoch milliseconds. */
  acceptedAt: number
}

/** `watch` hands this back and does NO I/O: the callback flips a flag and kicks the poller. */
export interface MailWatchHint {
  mailbox: string
}

export interface MailProviderSpec {
  id: string
  label: string
  capabilities: MailCapabilities
  setup: AccountSetupSpec
  listAccounts(): Promise<MailAccount[]>
  health(accountId: string): Promise<ProviderHealth>
  listMailboxes(accountId: string): Promise<Mailbox[]>
  poll(accountId: string, request: MailPollRequest): Promise<MailPollResult>
  getBody(accountId: string, messageId: string): Promise<MailBody>
  search?(accountId: string, query: string, limit: number): Promise<MailEnvelope[]>
  watch?(accountId: string, onHint: (hint: MailWatchHint) => void): Disposable
  markRead?(accountId: string, messageId: string, read: boolean): Promise<void>
  setFlag?(accountId: string, messageId: string, flag: string, value: boolean): Promise<void>
  send(
    accountId: string,
    mail: OutgoingMail,
    options: { idempotencyKey: string },
  ): Promise<MailSendResult>
  saveDraft?(accountId: string, mail: OutgoingMail): Promise<void>
}

/** One row of `GET /api/plugins/mail/providers`, and of `MailBaseApi.listProviders()`. */
export interface MailProviderSummary {
  id: string
  label: string
  capabilities: MailCapabilities
}
