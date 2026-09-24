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
import type { MailDigest } from './digest.js'
import type { MailDrafts } from './drafts.js'
import type { MailMessageTasks } from './message-tasks.js'
import type { MailProviderRegistry } from './provider-registry.js'
import { registerMailWriteRoutes } from './routes-write.js'
import { messageScopeValues, parseMessageScope } from './scope.js'
import type { MailSends } from './sends.js'
import type { MailService } from './service.js'
import type { MailStore } from './store.js'
import type { MailSync } from './sync.js'
import type { MailUnsubscribe } from './unsubscribe.js'

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
 * POST   /mailboxes/fetch { accountId, mailboxId }      -> { ok, fetched, added, updated, reason? }
 *        (one folder, now, for a folder the sweep has not reached) | 202 { running: true }
 * GET    /messages?account=&mailbox=&limit=&before=&fresh=  -> { messages, nextBefore?, checking? }
 *        (`checking`: folders whose unread check outlived the page; each settles as `unread-reconciled`)
 *        &unread=1                                        (unread only, over the whole mailbox)
 *        &scope=role:inbox|role:sent|role:drafts           (ONE list across every account holding
 *                                                          that role; refuses `account` alongside it,
 *                                                          and 400s on any other scope value)
 * GET    /messages/:accountId/:messageId               -> { message, body, bodyError? }
 * POST   /messages/:accountId/:messageId/read { read } -> { ok: true, message } | 409 unsupported
 * POST   /messages/:accountId/:messageId/task {...}    -> 201 { taskId, created: true }
 *        { title?, project?, note? }                      | 200 { taskId, created: false }
 * POST   /messages/:a/:m/unsubscribe { method?, confirm? } (in routes-write.ts: it makes network
 *                                                          egress, and one rung sends mail)
 * GET    /search?account=&q=&limit=                    -> { messages, source: 'provider'|'cache' }
 * POST   /digest/send-now                              -> { letterId | null, unread, accounts }
 * POST   /refresh         { accountId? }               -> { ok: true, completed, ...counts }
 * GET    /health                                       -> { ok, providers, accounts, db, polling, lastTickAt, replica }
 *
 * The write path (drafts, the approval ledger, sending) is in routes-write.ts and is registered
 * from here, so the mount point and the ordering rules stay in one place.
 */

/** A refresh is a user action, so it answers fast rather than truthfully-but-eventually. */
const REFRESH_DEADLINE_MS = 8_000

/**
 * One folder, fetched because somebody opened it. A shade over the sync's own 9s budget, so the
 * usual outcome is the loop's own answer rather than this clock beating it to a 202 every time.
 */
const FOLDER_FETCH_DEADLINE_MS = 10_000

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

/**
 * Making a task, and building a digest, get their own budgets.
 *
 * The task route is a WRITE and is idempotent by construction (the ledger answers the second ask
 * with the same id), so when it runs out of budget the honest answer is 202: the task may well
 * exist, and asking again is safe and returns it. The digest is a read plus one letter write.
 */
const TASK_DEADLINE_MS = 10_000
const DIGEST_DEADLINE_MS = 8_000

/**
 * The accounts list is the most-polled route here, so it gets the tightest budget.
 *
 * Under the per-account capability deadline (2s, see `MailService.sendCapabilityOf`) plus room for the
 * cache read, and deliberately well inside the few seconds a human waits for a sidebar badge.
 */
const ACCOUNTS_DEADLINE_MS = 2_500

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
    messageTasks: MailMessageTasks
    digest: MailDigest
    unsubscribe: MailUnsubscribe
  },
): void {
  const {
    store, service, accounts, providers, sync, drafts, approvals, sends, messageTasks, digest,
    unsubscribe,
  } = deps
  const primaryOnly = (): boolean => walnut.replica

  walnut.http.route('get', '/providers', () => {
    if (primaryOnly()) return PRIMARY_ONLY
    return { json: { providers: providers.list() } }
  })

  /**
   * The accounts list, which every open tab polls.
   *
   * Bounded, and the degraded answer is the same list WITHOUT `capabilities`. The full shape asks
   * each provider what that one account can do, so a wedged mail server used to be able to hold this
   * request open: N accounts, no route budget, and the console's badge, the agent surface gate and
   * the digest all waiting behind it. `capabilities` absent is a shape the console already handles
   * (it falls back to the provider-level block), which is what makes it a safe thing to drop.
   */
  walnut.http.route('get', '/accounts', async () => {
    if (primaryOnly()) return PRIMARY_ONLY
    try {
      const answered = await withBudget(service.listAccounts(), ACCOUNTS_DEADLINE_MS, ({ error }) => {
        if (error) walnut.log.warn('mail account list failed after the route answered', {
          error: String(error).slice(0, 200),
        })
      })
      if (answered) return { json: { accounts: answered } }
      return { json: { accounts: await service.listAccounts({ capabilities: false }) } }
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

  // Also before the collection route, and before `/read` cannot matter: the two suffixes differ.
  walnut.http.route('post', '/messages/:accountId/:messageId/task', async (request) => {
    if (primaryOnly()) return PRIMARY_ONLY
    const [accountId, messageId] = segmentsAfter(request, '/messages/')
    if (!accountId || !messageId) {
      return { status: 400, json: { error: 'invalid', message: 'an account id and a message id are required' } }
    }
    const body = await readBody(request)
    if (body === null) return { status: 400, json: { error: 'invalid', message: 'body must be JSON' } }
    const title = typeof body.title === 'string' ? body.title : undefined
    const project = typeof body.project === 'string' ? body.project : undefined
    try {
      const answered = await withBudget(
        messageTasks.link({
          accountId,
          messageId,
          ...(title ? { title } : {}),
          ...(project !== undefined ? { project } : {}),
          ...(body.note === true ? { note: true } : {}),
        }),
        TASK_DEADLINE_MS,
        // The work keeps running and still writes its ledger row, so this is reported and not lost.
        ({ error }) => {
          if (error) walnut.log.warn('mail task creation failed after the route answered', {
            accountId, error: String(error).slice(0, 200),
          })
        },
      )
      if (!answered) {
        return {
          status: 202,
          json: {
            ok: true,
            pending: true,
            message: 'The task is still being created. Asking again returns it rather than making a second one.',
          },
        }
      }
      // 201 only when something was created. A second press is a 200 with the same id, which is
      // what lets a double click, a retry and an agent re-reading its transcript all be safe.
      return { status: answered.created ? 201 : 200, json: answered }
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
    // `unread=1` narrows the MAILBOX in SQL, not the page in the browser. Exactly `'1'` turns it on,
    // so `unread=0`, `unread=false` and a missing parameter are all the same unfiltered request:
    // anything truthier would make a typo silently hide most of somebody's mail.
    const unread = firstQuery(request.query.unread) === '1'
    const account = firstQuery(request.query.account)
    // Both refusals are 400 on purpose. This route with neither `account` nor `mailbox` answers with
    // EVERY account and EVERY folder, so a mistyped scope value would quietly serve spam and trash as
    // somebody's unified inbox, and a request carrying both would have to guess which one the caller
    // meant. See scope.ts.
    const scope = parseMessageScope(firstQuery(request.query.scope))
    if (scope === 'invalid') {
      return {
        status: 400,
        json: {
          error: 'invalid',
          message: `scope must be one of ${messageScopeValues().join(', ')}`,
        },
      }
    }
    if (scope && account) {
      return {
        status: 400,
        json: { error: 'invalid', message: 'scope covers every account; do not also pass account' },
      }
    }
    try {
      return {
        json: await service.listMessages({
          ...(account ? { accountId: account } : {}),
          ...(firstQuery(request.query.mailbox) ? { mailboxId: firstQuery(request.query.mailbox)! } : {}),
          limit: intQuery(request.query.limit, DEFAULT_PAGE, MAX_PAGE),
          ...(unread ? { unread: true } : {}),
          ...(before ? { before } : {}),
          ...(scope ? { scope: scope.role } : {}),
          // Exactly `'1'`, like `unread`: a human pressed Refresh, so the page's unread check skips the
          // shared one-minute clock. Nothing else it does changes.
          ...(firstQuery(request.query.fresh) === '1' ? { fresh: true } : {}),
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

  /**
   * "Fetch the folder I just opened", from the console.
   *
   * The background sweep reaches every folder eventually and a click cannot wait for eventually: an
   * account with 67 folders takes several sweeps ten minutes apart to come around, so a folder that
   * has never been fetched showed its true size (which the mailbox list knows) next to an empty
   * message list. Answering it needs no new knowledge, only a way to say "this one, now".
   *
   * 202 when the fetch outran its budget, exactly like `/refresh`: the work carries on in the loop
   * and the sync event tells the console when rows land, so nothing is lost and no connection is
   * held open waiting for a big folder's first page.
   */
  walnut.http.route('post', '/mailboxes/fetch', async (request) => {
    if (primaryOnly()) return PRIMARY_ONLY
    const body = await readBody(request)
    const accountId = typeof body?.accountId === 'string' ? body.accountId : ''
    const mailboxId = typeof body?.mailboxId === 'string' ? body.mailboxId : ''
    if (!accountId || !mailboxId) {
      return { status: 400, json: { error: 'invalid', message: 'accountId and mailboxId are required' } }
    }
    try {
      const report = await withBudget(sync.refreshMailbox(accountId, mailboxId), FOLDER_FETCH_DEADLINE_MS)
      if (!report) return { status: 202, json: { ok: true, fetched: false, running: true } }
      return { json: { ok: true, ...report } }
    } catch (error) {
      return errorReply(walnut, error)
    }
  })

  /**
   * "Send the digest now", from the console's menu.
   *
   * It does NOT mark the day (see `MailDigest.sendNow`), so the scheduled one still goes out. Zero
   * unread answers `letterId: null` rather than sending a letter that says there is no news.
   */
  walnut.http.route('post', '/digest/send-now', async () => {
    if (primaryOnly()) return PRIMARY_ONLY
    try {
      const answered = await withBudget(
        digest.sendNow(Date.now() + DIGEST_DEADLINE_MS),
        DIGEST_DEADLINE_MS,
        ({ error }) => {
          if (error) walnut.log.warn('mail digest failed after the route answered', {
            error: String(error).slice(0, 200),
          })
        },
      )
      if (!answered) return { status: 202, json: { ok: true, pending: true } }
      return { json: answered }
    } catch (error) {
      return errorReply(walnut, error)
    }
  })

  registerMailWriteRoutes(walnut, { service, drafts, approvals, sends, unsubscribe })

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
