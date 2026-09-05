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
}

export interface MailAccountDto extends MailAccount {
  unread: number
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
