import type { WalnutServerPluginApi } from '../../core/plugins/server-api.js'
import type { MailAccounts } from './accounts.js'
import type { MailApprovals } from './approvals.js'
import {
  decodeMessageCursor,
  errorReply,
  firstQuery,
  intQuery,
  PRIMARY_ONLY,
  readBody,
  segmentsAfter,
  withBudget,
} from './contract.js'
import type { MailDrafts } from './drafts.js'
import type { MailProviderRegistry } from './provider-registry.js'
import { registerMailWriteRoutes } from './routes-write.js'
import type { MailSends } from './sends.js'
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
 *
 * The write path (drafts, the approval ledger, sending) is in routes-write.ts and is registered
 * from here, so the mount point and the ordering rules stay in one place.
 */

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

const DEFAULT_PAGE = 50
const MAX_PAGE = 200

/**
 * How long a console Send waits for the transport before it answers with what it knows.
 *
 * The ATTEMPT keeps the full 30s send deadline and settles its own row whatever happens here;
 * this only bounds the RESPONSE. A route that waited out a slow SMTP handshake would hold one of
 * the browser's six connections for half a minute, and the console learns the outcome from the
 * `send-settled` event or from `GET /sends` either way.
 */
const CONSOLE_SEND_DEADLINE_MS = 10_000

const DRAFT_LIST_LIMIT = 200

export function registerMailRoutes(
  walnut: WalnutServerPluginApi,
  deps: {
    store: MailStore
    service: MailService
    accounts: MailAccounts
    providers: MailProviderRegistry
    sync: MailSync
    drafts: MailDrafts
    approvals: MailApprovals
    sends: MailSends
  },
): void {
  const { store, service, accounts, providers, sync, drafts, approvals, sends } = deps
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
    // `before` is now the opaque token the previous page handed back, and it carries the WHOLE
    // sort key. The query name is unchanged, and a bare number (a console tab that was open
    // across the deploy) still pages the way it used to rather than answering with a 400.
    const before = decodeMessageCursor(firstQuery(request.query.before))
    try {
      return {
        json: await service.listMessages({
          ...(firstQuery(request.query.account) ? { accountId: firstQuery(request.query.account)! } : {}),
          ...(firstQuery(request.query.mailbox) ? { mailboxId: firstQuery(request.query.mailbox)! } : {}),
          limit: intQuery(request.query.limit, DEFAULT_PAGE, MAX_PAGE),
          ...(before ? { before } : {}),
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

  registerMailWriteRoutes(walnut, { service, drafts, approvals, sends })

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
