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
 * A known service behind a provider: the values a person would otherwise have to look up.
 *
 * The provider already knows that Gmail is `imap.gmail.com:993` over TLS, so a form that makes
 * the human find that out is a form that keeps a fact it holds to itself. A preset is DATA for
 * exactly that reason: the console fills fields it does not understand, and a provider plugin can
 * add a service without a console change.
 *
 * `match` is address domains, lowercase and without an `@`, so typing the address is enough to
 * pick the preset. `values` are field names from the same spec's `fields`, and a preset may
 * name a subset: it fills the servers and never the credential.
 *
 * Fill as FEW fields as the answer needs. A value another field already implies is a value that can
 * end up contradicting it, because the human may change either one afterwards: the IMAP provider's
 * presets deliberately name no port, since `submit` derives it from the encryption choice, and a
 * preset that filled 993 could be submitted as 993 with STARTTLS by anybody who switched the
 * encryption after the fill. Prefer deriving in `submit` over filling in a preset.
 */
export interface AccountSetupPreset {
  id: string
  label: string
  /** Address domains this preset is for, lowercase, no `@`. Absent = pick it by hand only. */
  match?: string[]
  /** `field.name` -> value. Only names that exist in `fields`. */
  values: Record<string, string>
  /** One sentence for the human, shown with the credential field. */
  help?: string
  /** The provider's own public page for that credential. Opened in a new tab. */
  helpUrl?: string
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
  /** Optional. A provider with one service, or with servers it discovers, declares none. */
  presets?: AccountSetupPreset[]
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
  /**
   * The `Reply-To` header, when the message carried one.
   *
   * Kept as its own field rather than folded into `from`, because the two answer different
   * questions: `from` is who wrote it, `replyTo` is where the sender asked answers to go. A reply
   * aimed at `from` when a `Reply-To` was set goes to a mailbox nobody reads, which for a mailing
   * list or a ticket system means the answer is simply lost.
   */
  replyTo?: MailAddress[]
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
  /** The markdown source, which is ALSO the `text/plain` alternative the transport sends. */
  bodyMarkdown: string
  /**
   * The `text/html` alternative, already rendered and already sanitized by the base.
   *
   * A provider sends it as-is and must not re-render or re-clean it: the base is the one layer
   * that knows what the markdown meant, and two sanitizers disagreeing is how a mail loses half
   * its formatting. Absent means send text only.
   */
  bodyHtml?: string
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
  /**
   * For a SEND only: how far the transport got before it failed. The single most important
   * field a mail provider reports, because it decides whether a retry is safe.
   *
   * - `'before-data'`: the message was refused before any of it was accepted (a rejected
   *   login, a refused connection, every recipient rejected in the envelope). Nothing was
   *   sent, so the base marks the send `failed` and a human may retry it.
   * - `'after-data'`: the transport had begun accepting the message when it failed, or our
   *   own deadline fired with the outcome unknown. SMTP has no dedupe, so the base marks the
   *   send `unknown` and NEVER retries: only the human, looking at the Sent folder, can say.
   * - `'unknown'` or absent: treated as `'after-data'`. The unsafe reading is the correct
   *   default, because the cost of guessing wrong the other way is a duplicate mail.
   */
  stage?: 'before-data' | 'after-data' | 'unknown'
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
  /**
   * `'both'` when the message carried a plain-text part AND an HTML part, which is what most
   * real mail looks like. The base derives its own stored format from which halves actually
   * arrived, so this is a statement of intent rather than the last word.
   */
  format: 'text' | 'html' | 'both'
  text?: string
  /** RAW, exactly as it arrived. The console sanitizes; a provider must not pre-clean it. */
  html?: string
  bytes: number
  /**
   * Attachment metadata, when the parse produced better information than the envelope's
   * BODYSTRUCTURE did. The base reads attachments from the ENVELOPE, because that is free at
   * poll time; this field exists so a provider whose transport only reveals them here has
   * somewhere to put them. Never the attachment CONTENT: v1 does not cache that at all.
   */
  attachments?: MailAttachmentMeta[]
  /**
   * Addresses the LISTING could not name, only.
   *
   * A conversation-shaped transport lists a thread's participants as display-name strings with no
   * address at all, and only a read of the thread returns a real `from`. Without somewhere to put
   * it the stored envelope keeps an empty address forever, so cache search never matches the sender
   * and a reply has nothing to prefill.
   *
   * GAP FILL, never a correction: the base fills only a field that is still empty, so a body that
   * names a different sender than the listing did can never overwrite it, and a body that also
   * cannot name one can never erase what a later poll learns. Every address is shape-checked
   * before it is stored and a bad one is dropped. A provider whose listing already carries
   * addresses should leave all four unset.
   */
  from?: MailAddress
  to?: MailAddress[]
  cc?: MailAddress[]
  replyTo?: MailAddress[]
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
  /**
   * The SHAPE of the bodies this provider returns, as a string only this provider gives meaning to.
   *
   * Change it when a fix alters what `getBody` returns for a message the base has ALREADY fetched:
   * a helper that mis-decoded every charset, a parser that dropped the plain-text half. The base
   * caches a body on disk and serves it forever, which is right for bytes that cannot change, so
   * without this the messages fetched before such a fix stay broken in the cache and no read path
   * ever asks for them again.
   *
   * A revision the base has not seen makes it drop every body it cached from this provider's
   * accounts, ONCE. Envelopes are untouched, and each body is fetched again the next time that
   * message is opened. Undefined means never, which is the right answer for a provider whose
   * decoding has not changed.
   */
  bodyRevision?: string
  /**
   * The capabilities of ONE account, when they differ from the provider's own.
   *
   * Optional, and the base prefers it whenever it exists. IMAP is why it does: reading needs
   * a host and a password, sending needs SMTP settings the human may never have filled in, so
   * two accounts behind the same provider genuinely disagree about `send`. A static block
   * would have to claim the union (and offer a Send button that always fails) or the
   * intersection (and hide it from the account that can).
   *
   * Keep it CHEAP: the base calls it on the send path, so it must not open a connection.
   */
  accountCapabilities?(accountId: string): Promise<MailCapabilities> | MailCapabilities
  setup: AccountSetupSpec
  listAccounts(): Promise<MailAccount[]>
  health(accountId: string): Promise<ProviderHealth>
  listMailboxes(accountId: string): Promise<Mailbox[]>
  poll(accountId: string, request: MailPollRequest): Promise<MailPollResult>
  /**
   * The body bytes.
   *
   * `sizeHint` is the size the poll already reported for this message, when the base has one. A
   * provider SHOULD refuse an over-cap message from the hint before issuing any fetch: without
   * it a transport can only discover the size after downloading up to the cap, which is the exact
   * cost the cap exists to avoid. Treat it as advisory, never as authoritative.
   */
  getBody(accountId: string, messageId: string, sizeHint?: number): Promise<MailBody>
  search?(accountId: string, query: string, limit: number): Promise<MailEnvelope[]>
  watch?(accountId: string, onHint: (hint: MailWatchHint) => void): Disposable
  markRead?(accountId: string, messageId: string, read: boolean): Promise<void>
  setFlag?(accountId: string, messageId: string, flag: string, value: boolean): Promise<void>
  /**
   * Forget this account: drop its config block, delete its secret, close its connection.
   *
   * Optional, and the base does not wait on it being reliable. When the human deletes an
   * account, the base removes its own mirror and cache whatever happens here, because a
   * cached account nobody can route is worse than a provider that still holds a config block.
   * Implement it, though: without it the provider's `listAccounts` keeps offering an account
   * the user deleted.
   */
  removeAccount?(accountId: string): Promise<void>
  send(
    accountId: string,
    mail: OutgoingMail,
    options: { idempotencyKey: string },
  ): Promise<MailSendResult>
  saveDraft?(accountId: string, mail: OutgoingMail): Promise<void>
}

/**
 * One row of `GET /api/plugins/mail/providers`, and of `MailBaseApi.listProviders()`.
 *
 * `setupFields` is the provider's `setup.fields` verbatim, and it is here because the console
 * renders the add-an-account form from data alone: without the fields on this row the console
 * would have to know each provider's form, which is exactly the coupling the declarative setup
 * spec removes. It carries no `submit` and no secret, only what a form needs to draw itself.
 */
export interface MailProviderSummary {
  id: string
  label: string
  capabilities: MailCapabilities
  setupFields: AccountSetupField[]
  /**
   * The provider's `setup.presets`, when it declared any.
   *
   * Flat and named for its half of the spec, like `setupFields`, rather than nested under a
   * `setup` object: this row already shipped, and every reader of it (the console, the browser
   * specs, a third-party viewer) would have to change to read a renamed field for no gain.
   * ABSENT when the provider declares none, which is what lets the console tell "this provider
   * has no known services" apart from "this provider has an empty list".
   */
  setupPresets?: AccountSetupPreset[]
}
