import type { StoredBodyFormat } from './bodies.js'
import type {
  Disposable,
  MailAccount,
  MailAddress,
  MailAttachmentMeta,
  MailEnvelope,
  MailboxRole,
  ProviderErrorCode,
} from './types.js'
import crypto from 'node:crypto'
import type { PluginRouteRequest } from '../../core/plugins/plugin-route-adapter.js'

/**
 * The vocabulary every layer above `store.ts` shares: the shapes routes answer with, the
 * deadline every provider call runs under, and the small pure functions that derive a value
 * from an envelope.
 *
 * It exists so `service.ts`, `retention.ts`, `sync.ts`, `accounts.ts` and `routes.ts` can all
 * name the same DTO without importing each other. Nothing here holds state or does I/O, so a
 * test can reach for one function without standing up a database.
 */

/** One provider call. Long enough for a cold IMAP connect, short enough to answer a browser. */
export const PROVIDER_DEADLINE_MS = 15_000

/** Newest inbox bodies pulled ahead of a read, per tick. */
export const BODY_PREFETCH_LIMIT = 20

export interface MailMessageDto {
  messageId: string
  accountId: string
  mailboxId: string
  rfcMessageId: string
  from: MailAddress
  to: MailAddress[]
  /**
   * The other two recipient questions a reader and a reply both need.
   *
   * Both were in the stored payload from the first slice and neither reached the DTO, so the
   * console's reader showed a mail addressed to eight people as if it were addressed to one, and
   * `mail_read` had a commented-out `Cc:` line waiting for exactly this. Optional rather than
   * defaulted to `[]` because the cache holds rows written before the field existed, and "the
   * message had no Cc" and "this row predates the field" are different facts.
   */
  cc?: MailAddress[]
  replyTo?: MailAddress[]
  subject: string
  snippet: string
  /** Epoch milliseconds. The header string rides `sentAtHeader`, never wall time. */
  sentAt: number
  sentAtHeader?: string
  receivedAt?: number
  flags: string[]
  attachments: MailAttachmentMeta[]
  hasBody: boolean
  /** Set when the provider will never hand this body over (over the cap, gone from the server). */
  bodyError?: ProviderErrorCode
  threadId?: string
  /**
   * The task this message was turned into, when it was.
   *
   * DERIVED on every read from the plugin's own ledger, never stored on the message row: the task
   * can be deleted, renamed or reopened by anything in Walnut, and a copy here would be a second
   * truth that goes stale silently. Absent means nobody has made a task from this message yet.
   */
  taskId?: string
}

export interface MailAccountDto extends MailAccount {
  unread: number
  /**
   * Unread in the INBOX-role mailboxes only, which is what a sidebar badge means.
   *
   * `unread` is every mailbox summed, Spam and Trash included, and a badge built from that
   * number tells the human they have 400 unread mails when 398 of them are spam they will never
   * open. Both are kept: the total is still the honest cache statistic.
   */
  unreadInbox: number
  /**
   * What THIS account can do, when its provider answers that question per account.
   *
   * The provider-level block is a union or an intersection, and for IMAP it is genuinely wrong for
   * one of the two accounts behind it: reading needs a host and a password, sending needs SMTP
   * settings the human may never have filled in. The console showed a Send button per PROVIDER, so
   * an account with no SMTP offered one that could only ever fail. Absent means the provider has no
   * per-account answer and the provider-level block is the truth.
   */
  capabilities?: { send: boolean }
}

export interface MailboxDto {
  accountId: string
  mailboxId: string
  name: string
  role: MailboxRole
  unread: number
  total: number
  lastSyncAt?: number
}

export interface MailBodyDto {
  format: StoredBodyFormat
  text?: string
  html?: string
  bytes: number
  truncated: boolean
}

/**
 * The draft state machine, exactly as `docs/design/mail-chat-base.md` draws it.
 *
 * `failed` versus `unknown` is the distinction the whole send path is built around: `failed`
 * means the transport rejected the message BEFORE it accepted any data, so a manual retry is
 * safe, and `unknown` means the outcome is genuinely unknowable (the socket died after DATA,
 * our own deadline fired) so only a human looking at the Sent folder can resolve it. SMTP has
 * no dedupe, so guessing wrong sends the mail twice.
 */
export type DraftState =
  | 'composing'
  | 'pending_approval'
  | 'approved'
  | 'sending'
  | 'sent'
  | 'failed'
  | 'unknown'
  | 'discarded'

export type SendState = 'approved' | 'sending' | 'sent' | 'failed' | 'unknown'

export type DraftOrigin = 'console' | 'agent'

export type ApprovalKind = 'letter' | 'console'

export interface DraftDto {
  draftId: string
  accountId: string
  to: MailAddress[]
  cc: MailAddress[]
  bcc: MailAddress[]
  subject: string
  bodyMarkdown: string
  /** The RFC `Message-ID` this draft replies to, when it is a reply. */
  inReplyTo?: string
  references?: string[]
  revision: number
  state: DraftState
  origin: DraftOrigin
  createdBySession?: string
  /** The outstanding approval letter, while there is one. */
  letterId?: string
  createdAt: number
  updatedAt: number
  error?: string
}

export interface SendDto {
  sendId: string
  draftId: string
  accountId: string
  revision: number
  /** `<draftId>:<revision>`, UNIQUE. One approved revision can produce ONE send row. */
  idempotencyKey: string
  approvalKind: ApprovalKind
  /** The letter id for a letter approval, the device/route for a console one. */
  approvalRef: string
  state: SendState
  providerMessageId?: string
  error?: string
  attemptedAt?: number
  settledAt?: number
}

/**
 * One `provider.send`. Longer than the read deadline on purpose: an SMTP handshake plus DATA
 * against a slow server legitimately takes tens of seconds, and a deadline shorter than the
 * transport's own would manufacture `unknown` outcomes nobody can resolve.
 */
export const SEND_DEADLINE_MS = 30_000

/**
 * How long a row may sit in `sending` before the reaper calls it `unknown`.
 *
 * A row stays `sending` only if the process died mid-attempt, since every ordinary outcome
 * settles it. Five minutes is comfortably past the send deadline, so the reaper can never
 * race an attempt that is still legitimately running.
 */
export const SEND_STUCK_MS = 5 * 60_000

export interface IngestResult {
  added: number
  updated: number
  headlines: Array<{ from: string; subject: string }>
}

export interface RetentionLimits {
  retentionDays: number
  maxRowsPerAccount: number
  bodyCacheMb: number
}

export interface RetentionResult {
  messagesDeleted: number
  bodiesDropped: number
  /** True when the sweep gave its budget back before finishing. */
  incomplete: boolean
}

export class MailServiceError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message)
    this.name = 'MailServiceError'
  }
}

/** The provider half of an account id. Ids split on the FIRST separator only. */
export function providerIdOf(accountId: string): string {
  const at = accountId.indexOf(':')
  return at > 0 ? accountId.slice(0, at) : accountId
}

/** A thrown `ProviderError`, when that is what it is. Anything else is not guessed at. */
export function providerErrorCode(error: unknown): ProviderErrorCode | undefined {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && [
    'auth', 'rate-limit', 'not-found', 'unsupported', 'invalid', 'unreachable', 'too-large',
  ].includes(code) ? code as ProviderErrorCode : undefined
}

export function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Run a provider call under a deadline.
 *
 * The timeout is reported as `unreachable`, which is the honest answer: a provider that has
 * not replied in fifteen seconds is unreachable as far as this process can tell, and calling
 * it anything else would send the user to fix the wrong thing.
 */
export function callProvider<T>(
  what: string,
  work: () => Promise<T>,
  ms = PROVIDER_DEADLINE_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error(`the mail provider did not answer ${what} within ${ms}ms`) as Error & { code: string }
      error.code = 'unreachable'
      reject(error)
    }, Math.max(1, ms))
    timer.unref?.()
    let settled = false
    const finish = (fn: () => void) => { if (settled) return; settled = true; clearTimeout(timer); fn() }
    try {
      work().then(
        (value) => finish(() => resolve(value)),
        (error) => finish(() => reject(error)),
      )
    } catch (error) {
      finish(() => reject(error))
    }
  })
}

/**
 * The thread a message belongs to, derived from the headers the cache already stores.
 *
 * There is deliberately no thread method on the provider contract: the first entry of
 * `References` (falling back to `In-Reply-To`, then the message's own id) is a stable root for
 * every provider, so the thread view works identically whatever the transport is.
 */
export function threadIdOf(envelope: MailEnvelope): string {
  return envelope.references?.[0] || envelope.inReplyTo || envelope.rfcMessageId || envelope.messageId
}

export function envelopeHashOf(envelope: MailEnvelope): string {
  return crypto.createHash('sha1').update(JSON.stringify([
    envelope.rfcMessageId, envelope.mailboxId, envelope.from, envelope.to, envelope.subject,
    envelope.sentAt, envelope.receivedAt ?? null, [...(envelope.flags ?? [])].sort(),
    envelope.attachments ?? [], envelope.sentAtHeader ?? null,
  ])).digest('hex')
}

/**
 * An FTS5 MATCH expression for a human's search box.
 *
 * Every token is quoted, so `from:` , `a AND b`, a bare `*` and an unbalanced quote are all
 * data rather than syntax. An unquoted user string reaches SQLite as a query language and a
 * stray character answers with a 500 instead of no results.
 */
export function ftsMatchFor(query: string): string {
  const tokens = query.match(/[\p{L}\p{N}_]+/gu) ?? []
  return tokens.map((token) => `"${token}"`).join(' ')
}

/** Where a message page stopped: the full sort key, not just the timestamp. */
export interface MessagePageCursor {
  sentAt: number
  messageId: string
}

/** The separator inside the encoded cursor: a NUL can never occur in a message id. */
const CURSOR_SEPARATOR = '\u0000'

/**
 * The page cursor as ONE opaque string.
 *
 * Opaque on purpose. The old cursor was a bare `sent_at` number, which is what let the paging
 * bug exist at all: a client could see it, reason about it, and the server could only ever
 * compare on that one field. Handing back a token nobody parses means the sort key can grow
 * another field later without a client change, and it keeps a caller from inventing a position
 * the server never issued.
 */
export function encodeMessageCursor(cursor: MessagePageCursor): string {
  return Buffer.from(`${cursor.sentAt}${CURSOR_SEPARATOR}${cursor.messageId}`, 'utf8').toString('base64url')
}

/**
 * Read a cursor, accepting the bare-number form ONE more release.
 *
 * A console tab that was open across the deploy still holds a numeric `nextBefore`, and
 * answering it with a 400 would break paging in the one window nobody can redeploy: the
 * browser they already have open. A bare number pages as it always did (timestamp only), which
 * can still skip a tie, and that is strictly better than an error.
 */
export function decodeMessageCursor(raw: string | undefined): MessagePageCursor | undefined {
  if (!raw) return undefined
  const legacy = Number(raw)
  if (Number.isFinite(legacy) && legacy > 0 && /^\d+$/.test(raw)) {
    // The EMPTY string, so the tie half of the comparison (`message_id < ''`) is never true and the
    // predicate reduces to exactly `sent_at < ?`: the legacy form keeps its old "strictly older,
    // ties dropped" meaning, which is what the tab that holds this number already saw.
    //
    // A high sentinel was the obvious idea and is wrong twice over. `\uFFFF` is not above every id
    // SQLite can hold ('\u{1F600}' < char(65535) is 0, because the comparison is over UTF-8 bytes),
    // and even where it did sort high it made the legacy cursor mean "at or before", which re-served
    // the whole tie group the caller had just been given.
    return { sentAt: legacy, messageId: '' }
  }
  let decoded: string
  try { decoded = Buffer.from(raw, 'base64url').toString('utf8') }
  catch { return undefined }
  const at = decoded.indexOf(CURSOR_SEPARATOR)
  if (at <= 0) return undefined
  const sentAt = Number(decoded.slice(0, at))
  const messageId = decoded.slice(at + 1)
  if (!Number.isFinite(sentAt) || !messageId) return undefined
  return { sentAt, messageId }
}

export interface MailSyncLimits extends RetentionLimits {
  pollIntervalSeconds: number
}

export const DEFAULT_LIMITS: MailSyncLimits = {
  pollIntervalSeconds: 120,
  retentionDays: 180,
  maxRowsPerAccount: 50_000,
  bodyCacheMb: 512,
}

/** Just the host surface the loop touches, so a test can hand it a small fake. */
export interface MailSyncHost {
  readonly replica: boolean
  readonly log: {
    debug(message: string, meta?: Record<string, unknown>): void
    info(message: string, meta?: Record<string, unknown>): void
    warn(message: string, meta?: Record<string, unknown>): void
  }
  readonly config: {
    get<T extends Record<string, unknown>>(): Promise<T>
    onChange(handler: (config: Record<string, unknown>) => void | Promise<void>): Disposable
  }
  readonly timers: {
    interval(handler: () => void | Promise<void>, intervalMs: number): Disposable
    timeout(handler: () => void | Promise<void>, delayMs: number): Disposable
  }
  readonly notifications: {
    error(notice: { title: string; body?: string; dedupKey: string }): Promise<void>
    recover(): Promise<void>
  }
}

// ── route plumbing ──
//
// Small pure helpers every mail route uses, here rather than in one of the two route files so
// that neither has to import the other. A plugin route handler is handed a request shape and
// answers with `{ status?, json }`, so all of this is string and number work.

export const PRIMARY_ONLY = {
  status: 503,
  json: {
    error: 'primary_only',
    message: 'Mail runs on the primary box only: a replica polling the same mailbox would double every fetch and every write.',
  },
} as const

/**
 * Race `work` against a clock, without letting the loser leak.
 *
 * The abandoned promise is deliberately NOT cancelled: a body fetch that arrives late still writes
 * itself to disk, and an approved send settles its own ledger row whatever this route answered. It
 * just does not hold the response.
 *
 * `onLate` is not optional bookkeeping. A promise that loses the race still settles, and a
 * REJECTION with no handler left on it is an unhandled rejection, which on this server means a
 * process-level warning (and, with a strict runtime flag, an exit) for something that was merely
 * slow. So the loser always gets a handler attached, and what it reports goes to the log.
 */
export function withBudget<T>(
  work: Promise<T>,
  ms: number,
  onLate?: (outcome: { value?: T; error?: unknown }) => void,
): Promise<T | undefined> {
  return Promise.race([
    work,
    new Promise<undefined>((resolve) => {
      const timer = setTimeout(() => {
        // Attach the handler at the moment we stop waiting, not before: until then the race owns
        // the rejection and reporting it twice would double-log every genuine error.
        work.then(
          (value) => onLate?.({ value }),
          (error) => onLate?.({ error }),
        )
        resolve(undefined)
      }, ms)
      timer.unref?.()
    }),
  ])
}

/** Just the sink `errorReply` needs, so this file stays independent of the plugin api shape. */
export interface RouteErrorLog {
  error(message: string, meta?: Record<string, unknown>): void
}

export function errorReply(walnut: { log: RouteErrorLog }, error: unknown) {
  if (error instanceof MailServiceError) {
    return { status: error.status, json: { error: error.code, message: error.message } }
  }
  const code = providerErrorCode(error)
  if (code) {
    // The provider said what went wrong in its own words, and those words are what the console
    // shows the user, so they travel unedited.
    const status = code === 'auth' ? 401
      : code === 'not-found' ? 404
        : code === 'unsupported' ? 409
          : code === 'invalid' ? 400
            : code === 'rate-limit' ? 429
              : code === 'too-large' ? 413
                : 502
    return { status, json: { error: code, message: reasonOf(error) } }
  }
  if ((error as { code?: string } | null)?.code === 'db_unavailable') {
    return { status: 503, json: { error: 'db_unavailable', message: reasonOf(error) } }
  }
  walnut.log.error('mail route failed', { error: reasonOf(error).slice(0, 300) })
  return { status: 500, json: { error: 'internal', message: 'internal mail error' } }
}

export function firstQuery(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

export function intQuery(value: string | string[] | undefined, fallback: number, max: number): number {
  const raw = Number(firstQuery(value))
  if (!Number.isFinite(raw) || raw <= 0) return fallback
  return Math.min(Math.floor(raw), max)
}

/**
 * Path segments after `marker`, decoded.
 *
 * A plugin route handler is handed the path, not Express's `req.params`, and a mail message
 * handle is `<mailbox>:<uidvalidity>:<uid>` where the mailbox name may itself contain a colon
 * or a slash. So the caller percent-encodes each segment and this decodes it back; anything
 * that guessed at the separators would break on a mailbox called "Projects/2026".
 */
export function segmentsAfter(request: PluginRouteRequest, marker: string): string[] {
  const pathname = request.path.split('?')[0] ?? ''
  const at = pathname.indexOf(marker)
  if (at < 0) return []
  return pathname.slice(at + marker.length).split('/').filter(Boolean).map((segment) => {
    try { return decodeURIComponent(segment) }
    catch { return segment }
  })
}

export async function readBody(request: PluginRouteRequest): Promise<Record<string, unknown> | null> {
  try {
    const body = await request.json<Record<string, unknown> | null>()
    return body && typeof body === 'object' ? body : {}
  } catch {
    return null
  }
}

