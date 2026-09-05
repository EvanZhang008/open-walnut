import type { PluginRouteRequest } from '../../core/plugins/plugin-route-adapter.js'
import type { WalnutServerPluginApi } from '../../core/plugins/server-api.js'
import type { MailAccounts } from './accounts.js'
import { MailServiceError, providerErrorCode, reasonOf } from './contract.js'
import type { MailProviderRegistry } from './provider-registry.js'
import type { MailService } from './service.js'
import type { MailStore } from './store.js'
import type { MailSync } from './sync.js'

/**
 * The plugin's own HTTP surface, mounted by the host at `/api/plugins/mail/*`.
 *
 * There is deliberately NO `/api/mail` alias. Mail has no existing client to keep working,
 * which is the opposite of calendar's situation, so the plugin path is the only path and
 * nothing has to be deleted later.
 *
 * Contracts every handler here keeps:
 *
 * - A cache read can be slow, so it can never be unbounded: `MailDatabase` carries a
 *   deadline and a stuck worker becomes a 503 `db_unavailable`. A route that hangs pins one
 *   of the browser's six connections and turns into an app-wide stall. Every PROVIDER call is
 *   behind its own deadline for the same reason (see `callProvider`).
 * - On a cloud replica the whole base steps aside with 503 `primary_only`. Two boxes polling
 *   one mailbox double-write and double the provider's load. This is the PLUGIN's decision,
 *   read from `walnut.replica`; core has no rule about mail routes.
 * - HTML bodies are returned RAW, exactly as they arrived. Sanitizing here would leave the
 *   console rendering whatever this file guessed was safe; the sanitizer belongs next to the
 *   renderer, which is the only code that knows what its own DOM does with the result. Treat
 *   every string in a body as hostile input: it is written by whoever sent the mail.
 *
 * Routes, and the shapes they answer with:
 *
 * GET    /providers                                   -> { providers: MailProviderSummary[] }
 *        (id, label, capabilities, setupFields: the add-an-account form, as data)
 * GET    /accounts                                    -> { accounts: MailAccountDto[] }
 * POST   /accounts        { providerId, values }       -> 201 { account: MailAccount }
 * DELETE /accounts/:accountId                          -> { ok: true, messages }
 * GET    /mailboxes?account=                           -> { mailboxes: MailboxDto[] }
 * GET    /messages?account=&mailbox=&limit=&before=    -> { messages: MailMessageDto[], nextBefore? }
 * GET    /messages/:accountId/:messageId               -> { message, body, bodyError? }
 * POST   /messages/:accountId/:messageId/read { read } -> { ok: true, message } | 409 unsupported
 * GET    /search?account=&q=&limit=                    -> { messages, source: 'provider'|'cache' }
 * POST   /refresh         { accountId? }               -> { ok: true, completed, ...counts }
 * GET    /health                                       -> { ok, providers, accounts, db, polling, lastTickAt, replica }
 */

const PRIMARY_ONLY = {
  status: 503,
  json: {
    error: 'primary_only',
    message: 'Mail runs on the primary box only: a replica polling the same mailbox would double every fetch and every write.',
  },
} as const

/** A refresh is a user action, so it answers fast rather than truthfully-but-eventually. */
const REFRESH_DEADLINE_MS = 8_000

/**
 * Every other route that can reach a provider or delete in bulk gets the same treatment.
 *
 * The arithmetic is the reason: a cache read can wait 5s for the worker, a provider call 15s, and
 * the writes after it more still, so an unbounded body read is ~25s of one browser connection.
 * Six of those and the whole app looks broken. The read degrades to the envelope plus a
 * `bodyError`; the purge answers 202 and finishes on the next tick's sweep.
 */
const READ_DEADLINE_MS = 8_000
const PURGE_DEADLINE_MS = 8_000

/**
 * Race `work` against a clock, without letting the loser leak.
 *
 * The abandoned promise is deliberately NOT cancelled: a body fetch that arrives late still
 * writes itself to disk, so the next read is served locally. It just does not hold the response.
 */
function withBudget<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([
    work,
    new Promise<undefined>((resolve) => {
      const timer = setTimeout(() => resolve(undefined), ms)
      timer.unref?.()
    }),
  ])
}

const DEFAULT_PAGE = 50
const MAX_PAGE = 200

function errorReply(walnut: WalnutServerPluginApi, error: unknown) {
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

function firstQuery(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function intQuery(value: string | string[] | undefined, fallback: number, max: number): number {
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
function segmentsAfter(request: PluginRouteRequest, marker: string): string[] {
  const pathname = request.path.split('?')[0] ?? ''
  const at = pathname.indexOf(marker)
  if (at < 0) return []
  return pathname.slice(at + marker.length).split('/').filter(Boolean).map((segment) => {
    try { return decodeURIComponent(segment) }
    catch { return segment }
  })
}

async function readBody(request: PluginRouteRequest): Promise<Record<string, unknown> | null> {
  try {
    const body = await request.json<Record<string, unknown> | null>()
    return body && typeof body === 'object' ? body : {}
  } catch {
    return null
  }
}

export function registerMailRoutes(
  walnut: WalnutServerPluginApi,
  deps: {
    store: MailStore
    service: MailService
    accounts: MailAccounts
    providers: MailProviderRegistry
    sync: MailSync
  },
): void {
  const { store, service, accounts, providers, sync } = deps
  const primaryOnly = (): boolean => walnut.replica

  walnut.http.route('get', '/providers', () => {
    if (primaryOnly()) return PRIMARY_ONLY
    return { json: { providers: providers.list() } }
  })

  walnut.http.route('get', '/accounts', async () => {
    if (primaryOnly()) return PRIMARY_ONLY
    try {
      return { json: { accounts: await service.listAccounts() } }
    } catch (error) {
      return errorReply(walnut, error)
    }
  })

  walnut.http.route('post', '/accounts', async (request) => {
    if (primaryOnly()) return PRIMARY_ONLY
    const body = await readBody(request)
    if (!body) return { status: 400, json: { error: 'invalid', message: 'body must be JSON' } }
    const providerId = typeof body.providerId === 'string' ? body.providerId : ''
    const values = body.values
    if (!providerId || !values || typeof values !== 'object' || Array.isArray(values)) {
      return { status: 400, json: { error: 'invalid', message: 'providerId and values are required' } }
    }
    try {
      // `values` goes straight to the provider and is not persisted, not logged and not echoed
      // back: the provider owns its config and its secret, so a credential lives in one place.
      const account = await accounts.setup(providerId, values as Record<string, string>)
      return { status: 201, json: { account } }
    } catch (error) {
      return errorReply(walnut, error)
    }
  })

  walnut.http.route('delete', '/accounts/:accountId', async (request) => {
    if (primaryOnly()) return PRIMARY_ONLY
    const [accountId] = segmentsAfter(request, '/accounts/')
    if (!accountId) return { status: 400, json: { error: 'invalid', message: 'an account id is required' } }
    try {
      // The mirror and the mailboxes go first inside `remove`, so the account is gone from every
      // read the moment this returns even when the message sweep needs another tick.
      const removed = await accounts.remove(accountId, Date.now() + PURGE_DEADLINE_MS)
      if (!removed.complete) return { status: 202, json: { ok: true, ...removed } }
      return { json: { ok: true, ...removed } }
    } catch (error) {
      return errorReply(walnut, error)
    }
  })

  walnut.http.route('get', '/mailboxes', async (request) => {
    if (primaryOnly()) return PRIMARY_ONLY
    const account = firstQuery(request.query.account)
    if (!account) return { status: 400, json: { error: 'invalid', message: 'account is required' } }
    try {
      return { json: { mailboxes: await service.listMailboxes(account) } }
    } catch (error) {
      return errorReply(walnut, error)
    }
  })

  // Registered before the collection route so the more specific path is matched first.
  walnut.http.route('post', '/messages/:accountId/:messageId/read', async (request) => {
    if (primaryOnly()) return PRIMARY_ONLY
    const [accountId, messageId] = segmentsAfter(request, '/messages/')
    if (!accountId || !messageId) {
      return { status: 400, json: { error: 'invalid', message: 'an account id and a message id are required' } }
    }
    const body = await readBody(request)
    // A body that did not parse is not consent to change anything: it used to fall through to
    // `read = true`, so a malformed request marked the message read.
    if (body === null) return { status: 400, json: { error: 'invalid', message: 'body must be JSON' } }
    const read = body.read === undefined ? true : body.read === true
    try {
      return { json: { ok: true, message: await service.markRead(accountId, messageId, read) } }
    } catch (error) {
      return errorReply(walnut, error)
    }
  })

  walnut.http.route('get', '/messages/:accountId/:messageId', async (request) => {
    if (primaryOnly()) return PRIMARY_ONLY
    const [accountId, messageId] = segmentsAfter(request, '/messages/')
    if (!accountId || !messageId) {
      return { status: 400, json: { error: 'invalid', message: 'an account id and a message id are required' } }
    }
    // `?retry=1` is the only way a refused body is asked for again. Without it a message over
    // the cap, or one the server no longer has, would be re-downloaded on every single open.
    const retry = firstQuery(request.query.retry) === '1'
    try {
      // `body.html` is RAW. The console sanitizes it; see the file comment.
      //
      // Deliberately NO deadline handed to the read: the response is what has a budget, not the
      // fetch. The fetch keeps its own provider deadline, so the bytes it eventually gets are
      // written to disk and the user's second open is local. Bounding the read here as well would
      // abandon those bytes without making anything faster, since nothing this process does can
      // cancel the command the mail server is already answering.
      const answered = await withBudget(
        service.readMessage(accountId, messageId, { retry }),
        READ_DEADLINE_MS,
      )
      if (answered) return { json: answered }
      // The envelope is real data the caller asked for, and is answered now rather than never.
      return {
        json: {
          message: await service.readEnvelope(accountId, messageId),
          body: null,
          bodyError: 'unreachable',
        },
      }
    } catch (error) {
      return errorReply(walnut, error)
    }
  })

  walnut.http.route('get', '/messages', async (request) => {
    if (primaryOnly()) return PRIMARY_ONLY
    const before = Number(firstQuery(request.query.before))
    try {
      return {
        json: await service.listMessages({
          ...(firstQuery(request.query.account) ? { accountId: firstQuery(request.query.account)! } : {}),
          ...(firstQuery(request.query.mailbox) ? { mailboxId: firstQuery(request.query.mailbox)! } : {}),
          limit: intQuery(request.query.limit, DEFAULT_PAGE, MAX_PAGE),
          ...(Number.isFinite(before) && before > 0 ? { before } : {}),
        }),
      }
    } catch (error) {
      return errorReply(walnut, error)
    }
  })

  walnut.http.route('get', '/search', async (request) => {
    if (primaryOnly()) return PRIMARY_ONLY
    const q = (firstQuery(request.query.q) ?? '').trim()
    if (!q) return { status: 400, json: { error: 'invalid', message: 'q is required' } }
    try {
      return {
        json: await service.search({
          ...(firstQuery(request.query.account) ? { accountId: firstQuery(request.query.account)! } : {}),
          q,
          limit: intQuery(request.query.limit, DEFAULT_PAGE, MAX_PAGE),
        }),
      }
    } catch (error) {
      return errorReply(walnut, error)
    }
  })

  walnut.http.route('post', '/refresh', async (request) => {
    if (primaryOnly()) return PRIMARY_ONLY
    const body = await readBody(request)
    const accountId = typeof body?.accountId === 'string' ? body.accountId : undefined
    // Bounded on purpose: a refresh of a big mailbox can take the whole tick budget, and a
    // request that waits that long has already cost the browser one of its six connections.
    // 202 means "it is running", which is the truth, and the events say when it landed.
    try {
      const report = await withBudget(sync.refresh(accountId), REFRESH_DEADLINE_MS)
      if (!report) return { status: 202, json: { ok: true, completed: false } }
      return { json: { ok: true, completed: true, ...report } }
    } catch (error) {
      // A tick reaches the database, so this can fail with `db_unavailable`, which every other
      // route answers as a 503. Without the try it escaped as an unexplained 500.
      return errorReply(walnut, error)
    }
  })

  walnut.http.route('get', '/health', async () => {
    if (primaryOnly()) return PRIMARY_ONLY
    // `countOrNull` swallows its own failure into `undefined`, but the deadline machinery around
    // it can still reject, and health is the one route that must never answer with a stack.
    const accountCount = await store.countOrNull('SELECT COUNT(*) AS n FROM accounts')
      .catch(() => undefined)
    return {
      json: {
        // Reaching this line IS the answer `ok` reports: the plugin is up and serving. The
        // cache's own truth rides `db`, so a broken cache stays diagnosable instead of
        // collapsing into one false boolean that says nothing about which half failed.
        ok: true,
        providers: providers.size,
        accounts: accountCount ?? 0,
        db: store.status,
        polling: sync.polling,
        lastTickAt: sync.lastTick,
        replica: walnut.replica,
      },
    }
  })
}
