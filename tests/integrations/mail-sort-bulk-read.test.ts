/**
 * Bulk read (spec 6.2, C14 C15 C17 C18 C19 C76 C91): the in-memory job runner against fake providers,
 * and the `POST /groups/read` + `/bulk/:jobId/*` routes against a fake router, store and engine.
 *
 * What is pinned: the job touches exactly the list resolved at POST time; `markReadMany` in 200-id
 * calls where the provider has it, `markRead` two at a time where it does not; Stop lets in-flight
 * calls finish and starts nothing else; Undo marks back only what this job changed, once, inside ten
 * minutes; Retry reruns only what failed; the 409s (recomputing, stale, in-flight) change nothing.
 */
import { describe, expect, it } from 'vitest'
import {
  BULK_CHANGED_IDS_MAX, MailBulkRead, RECOMPUTING_MESSAGE, STALE_MESSAGE, UNDO_EXPIRED_MESSAGE, type BulkItem,
} from '../../src/integrations/mail/sort-bulk-read.js'
import { registerMailSortWriteRoutes } from '../../src/integrations/mail/routes-sort-write.js'

const MARINA = 'marina:robin@marina.example.invalid'
const FERRY = 'ferry:robin.harbour@ferry.example.invalid'

function items(accountId: string, count: number, from = 1): BulkItem[] {
  return Array.from({ length: count }, (_, i) => ({ accountId, mailboxId: 'INBOX', messageId: `INBOX:1:${from + i}` }))
}

/** A mail server in memory: `seen` per id, a call log, and ids that refuse. */
function fakeServer(options: { bulk?: Set<string>; failing?: Set<string>; delayMs?: number } = {}) {
  const seen = new Set<string>()
  const log: Array<{ via: 'one' | 'many'; accountId: string; ids: string[]; read: boolean }> = []
  let inFlight = 0
  let maxInFlight = 0
  const key = (accountId: string, id: string) => `${accountId}|${id}`
  const apply = (accountId: string, id: string, read: boolean) => {
    if (read) seen.add(key(accountId, id))
    else seen.delete(key(accountId, id))
  }
  return {
    seen, log, key,
    get maxInFlight() { return maxInFlight },
    hasBulk: (accountId: string) => options.bulk?.has(accountId) ?? false,
    markMany: async (accountId: string, ids: string[], read: boolean) => {
      log.push({ via: 'many', accountId, ids: [...ids], read })
      return ids.map((messageId) => {
        if (options.failing?.has(messageId)) return { messageId, ok: false, reason: 'refused by the fixture' }
        apply(accountId, messageId, read)
        return { messageId, ok: true }
      })
    },
    markOne: async (accountId: string, messageId: string, read: boolean) => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      log.push({ via: 'one', accountId, ids: [messageId], read })
      await new Promise((resolve) => setTimeout(resolve, options.delayMs ?? 1))
      inFlight -= 1
      if (options.failing?.has(messageId)) throw new Error('refused by the fixture')
      apply(accountId, messageId, read)
    },
  }
}

function runner(server: ReturnType<typeof fakeServer>, extra: { now?: () => number } = {}) {
  const progress: unknown[] = []
  const done: Array<{ jobId: string; changedCount: number; failedCount: number; changedIds?: unknown[]; stopped?: boolean }> = []
  const changedPairs: unknown[] = []
  const bulk = new MailBulkRead({
    hasBulk: server.hasBulk, markMany: server.markMany, markOne: server.markOne,
    events: { bulkProgress: (event) => progress.push(event), bulkDone: (event) => done.push(event) },
    groupsChanged: (pairs) => changedPairs.push(...pairs),
    ...(extra.now ? { now: extra.now } : {}),
  })
  return { bulk, progress, done, changedPairs }
}

describe('MailBulkRead: the job runner', () => {
  it('uses markReadMany in 200-id calls when the provider has it', async () => {
    const server = fakeServer({ bulk: new Set([MARINA]) })
    const { bulk, done } = runner(server)
    const job = bulk.start({ key: 'k', kind: 'read', items: items(MARINA, 450) })
    await bulk.idle()
    expect(server.log.map((call) => [call.via, call.ids.length])).toEqual([['many', 200], ['many', 200], ['many', 50]])
    expect(bulk.view(job)).toMatchObject({ state: 'done', kind: 'read', total: 450, done: 450, changedCount: 450, undoable: true })
    expect(done[0]!.changedIds).toHaveLength(450)
  })

  it('walks markRead two at a time when the provider has no bulk call (the Outlook shape)', async () => {
    const server = fakeServer({ delayMs: 3 })
    const { bulk } = runner(server)
    bulk.start({ key: 'k', kind: 'read', items: items(FERRY, 30) })
    await bulk.idle()
    expect(server.log.every((call) => call.via === 'one')).toBe(true)
    expect(server.log).toHaveLength(30)
    expect(server.maxInFlight).toBe(2)
  })

  it('records per-message failures and Retry reruns ONLY those (C17)', async () => {
    const failing = new Set(items(FERRY, 24, 600).map((one) => one.messageId))
    const server = fakeServer({ failing })
    const { bulk } = runner(server)
    const job = bulk.start({ key: 'k', kind: 'read', items: items(FERRY, 1_200) })
    await bulk.idle()
    const view = bulk.view(job)
    expect(view.changedCount).toBe(1_176)
    expect(view.failed.map((one) => one.messageId).sort()).toEqual([...failing].sort())
    failing.clear()
    server.log.length = 0
    const retried = bulk.retry(job.id)
    if (!('job' in retried)) throw new Error('retry refused')
    await bulk.idle()
    expect(server.log.map((call) => call.ids[0]).sort()).toEqual(items(FERRY, 24, 600).map((one) => one.messageId).sort())
    expect(bulk.view(retried.job)).toMatchObject({ changedCount: 24, failed: [] })
    expect(bulk.retry(retried.job.id)).toEqual({ error: 'nothing-to-retry' })
  })

  it('Undo marks back only what this job changed, once (C15)', async () => {
    const server = fakeServer({ bulk: new Set([MARINA]), failing: new Set(['INBOX:1:3']) })
    const { bulk } = runner(server)
    // INBOX:1:9 was read before the job and is not in its list: Undo must leave it read.
    server.seen.add(server.key(MARINA, 'INBOX:1:9'))
    const job = bulk.start({ key: 'k', kind: 'read', items: items(MARINA, 5) })
    await bulk.idle()
    const undo = bulk.undo(job.id)
    if (!('job' in undo)) throw new Error('undo refused')
    expect(undo.job.kind).toBe('unread')
    await bulk.idle()
    expect(undo.job.items.map((one) => one.messageId)).toEqual(['INBOX:1:1', 'INBOX:1:2', 'INBOX:1:4', 'INBOX:1:5'])
    expect(server.seen.has(server.key(MARINA, 'INBOX:1:9'))).toBe(true)
    expect([...server.seen]).toEqual([server.key(MARINA, 'INBOX:1:9')])
    expect(bulk.undo(job.id)).toEqual({ error: 'undone' })
    expect(bulk.view(undo.job).undoable).toBe(false)
  })

  it('Undo expires after ten minutes', async () => {
    let now = 1_000_000
    const server = fakeServer({ bulk: new Set([MARINA]) })
    const { bulk } = runner(server, { now: () => now })
    const job = bulk.start({ key: 'k', kind: 'read', items: items(MARINA, 3) })
    await bulk.idle()
    now += 10 * 60_000 + 1
    expect(bulk.undo(job.id)).toEqual({ error: 'expired' })
    expect(bulk.undo('bulk-unknown')).toEqual({ error: 'unknown-job' })
  })

  it('Stop lets the in-flight calls finish and starts nothing else (C76)', async () => {
    const server = fakeServer({ delayMs: 20 })
    const { bulk, done } = runner(server)
    const job = bulk.start({ key: 'k', kind: 'read', items: items(FERRY, 100) })
    await new Promise((resolve) => setTimeout(resolve, 50))
    const before = server.log.length
    bulk.stop(job.id)
    await bulk.idle()
    expect(server.log.length - before).toBeLessThanOrEqual(2)
    expect(bulk.view(job)).toMatchObject({ state: 'done', stopped: true })
    expect(done[0]!.stopped).toBe(true)
    expect(bulk.view(job).changedCount).toBe(server.log.length)
    expect(bulk.view(job).undoable).toBe(true)
  })

  it('bulk-done carries changedIds up to 500 and none beyond (the console refetches instead)', async () => {
    const server = fakeServer({ bulk: new Set([MARINA]) })
    const { bulk, done, changedPairs } = runner(server)
    bulk.start({ key: 'a', kind: 'read', items: items(MARINA, BULK_CHANGED_IDS_MAX) })
    bulk.start({ key: 'b', kind: 'read', items: items(MARINA, BULK_CHANGED_IDS_MAX + 1, 1_000) })
    await bulk.idle()
    expect(done.find((one) => one.changedCount === 500)!.changedIds).toHaveLength(500)
    expect(done.find((one) => one.changedCount === 501)!.changedIds).toBeUndefined()
    expect(changedPairs).toContainEqual({ accountId: MARINA, mailboxId: 'INBOX' })
  })
})

// The routes, against a fake router.

type Handler = (request: { path: string; query: Record<string, string>; json: () => Promise<unknown> }) => Promise<{ status?: number; json?: any }>

function harness(options: { recomputing?: boolean; rulesRev?: string; rows?: Array<{ rowid: number; account_id: string; mailbox_id: string; message_id: string }>; readOnly?: Set<string> } = {}) {
  const routes = new Map<string, Handler>()
  const server = fakeServer({ bulk: new Set([MARINA]) })
  const selections: unknown[][] = []
  const walnut = {
    replica: false,
    http: { route: (method: string, path: string, handler: Handler) => routes.set(`${method.toUpperCase()} ${path}`, handler) },
    log: { info: () => {}, warn: () => {}, debug: () => {} },
  }
  const deps = {
    walnut,
    store: {
      mailboxesByRole: async () => [{ account_id: MARINA, mailbox_id: 'INBOX' }, { account_id: FERRY, mailbox_id: 'INBOX' }],
      sort: { selectBulkRead: async (...args: unknown[]) => { selections.push(args); return options.rows ?? [] } },
    },
    sort: {
      ready: async () => {},
      recomputing: () => (options.recomputing ? { done: 1, total: 9 } : undefined),
      rulesRev: options.rulesRev ?? 'rev-1',
      canMarkRead: (accountId: string) => !(options.readOnly?.has(accountId)),
      notifyGroupsChanged: () => {},
    },
    service: {
      provider: (accountId: string) => ({ capabilities: { markRead: true }, ...(accountId === MARINA ? { markReadMany: () => {} } : {}) }),
      markReadMany: server.markMany,
      markRead: server.markOne,
    },
    events: { bulkProgress: () => {}, bulkDone: () => {}, unsubBatch: () => {} },
    unsubscribe: { run: async () => ({ status: 'done', method: 'one-click', at: 0, message: 'ok' }) },
    providers: {},
  }
  const handles = registerMailSortWriteRoutes(walnut as never, deps as never)
  const call = (method: string, pattern: string, path: string, body?: unknown) => routes.get(`${method} ${pattern}`)!({
    path: `/api/plugins/mail${path}`, query: {}, json: async () => body ?? null,
  })
  return { routes, call, server, selections, bulk: handles.bulk }
}

const readBody = (extra: Record<string, unknown> = {}) => ({
  scope: { role: 'inbox' }, group: 'u:notices', watermark: { at: 5_000, seq: 40 }, rulesRev: 'rev-1', ...extra,
})

describe('POST /groups/read and the job routes', () => {
  it('registers every write route of the slice', () => {
    const { routes } = harness()
    expect([...routes.keys()].sort()).toEqual([
      'GET /bulk/:jobId', 'GET /groups/:groupId/unsubscribe-plan', 'GET /unsubscribe/batch/:batchId',
      'POST /bulk/:jobId/retry', 'POST /bulk/:jobId/stop', 'POST /bulk/:jobId/undo', 'POST /groups/archive', 'POST /groups/read',
      'POST /rules/preview', 'POST /rules/propose', 'POST /unsubscribe/batch', 'POST /unsubscribe/batch/:batchId/stop',
    ])
  })

  it('answers 409 recomputing with the verbatim sentence and selects nothing (C91)', async () => {
    const h = harness({ recomputing: true })
    const answer = await h.call('POST', '/groups/read', '/groups/read', readBody())
    expect(answer).toEqual({ status: 409, json: { error: 'recomputing', message: RECOMPUTING_MESSAGE } })
    expect(RECOMPUTING_MESSAGE).toBe('Groups are updating. Try again in a moment.')
    expect(h.selections).toHaveLength(0)
  })

  it('answers 409 stale when the rules changed after the button was drawn, and changes nothing (C18)', async () => {
    const h = harness({ rulesRev: 'rev-2' })
    const answer = await h.call('POST', '/groups/read', '/groups/read', readBody())
    expect(answer).toEqual({ status: 409, json: { error: 'stale', message: STALE_MESSAGE } })
    expect(STALE_MESSAGE).toBe('This group changed. Check the new count and try again.')
    expect(h.server.log).toHaveLength(0)
  })

  it('passes the watermark and sender to the selection, and skips read-only accounts (C14 C19)', async () => {
    const rows = [
      { rowid: 1, account_id: MARINA, mailbox_id: 'INBOX', message_id: 'INBOX:1:1' },
      { rowid: 2, account_id: FERRY, mailbox_id: 'INBOX', message_id: 'INBOX:1:2' },
    ]
    const h = harness({ rows, readOnly: new Set([FERRY]) })
    const answer = await h.call('POST', '/groups/read', '/groups/read', readBody({ sender: 'a:tidings@lists.example.invalid' }))
    expect(answer.status).toBe(202)
    expect(answer.json.total).toBe(1)
    expect(h.selections[0]!.slice(1)).toEqual(['u:notices', 'a:tidings@lists.example.invalid', { at: 5_000, seq: 40 }])
    await h.bulk.idle()
    expect(h.server.log.flatMap((one) => one.ids)).toEqual(['INBOX:1:1'])
  })

  it('refuses Important, a bare name, a missing watermark, and a second job on the same key (409 in-flight)', async () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({ rowid: i + 1, account_id: FERRY, mailbox_id: 'INBOX', message_id: `INBOX:1:${i + 1}` }))
    const h = harness({ rows })
    expect((await h.call('POST', '/groups/read', '/groups/read', readBody({ group: 'important' }))).status).toBe(400)
    // A name is not an id (the old fixed buckets were bare names): refused, never a silent empty job.
    expect((await h.call('POST', '/groups/read', '/groups/read', readBody({ group: 'notifications' }))).status).toBe(400)
    expect((await h.call('POST', '/groups/read', '/groups/read', readBody({ watermark: undefined }))).status).toBe(400)
    const first = await h.call('POST', '/groups/read', '/groups/read', readBody())
    const second = await h.call('POST', '/groups/read', '/groups/read', readBody())
    expect(second).toEqual({ status: 409, json: { error: 'in-flight', jobId: first.json.jobId } })
    await h.bulk.idle()
  })

  it('GET /bulk, undo once, 404 for an unknown job, and 410 with the verbatim sentence once expired', async () => {
    const rows = [{ rowid: 1, account_id: MARINA, mailbox_id: 'INBOX', message_id: 'INBOX:1:1' }]
    const h = harness({ rows })
    const started = await h.call('POST', '/groups/read', '/groups/read', readBody())
    await h.bulk.idle()
    const jobPath = `/bulk/${started.json.jobId}`
    const view = await h.call('GET', '/bulk/:jobId', jobPath)
    expect(view.json).toMatchObject({ state: 'done', kind: 'read', total: 1, done: 1, changedCount: 1, failed: [], undoable: true })
    const undo = await h.call('POST', '/bulk/:jobId/undo', `${jobPath}/undo`)
    expect(undo.status).toBe(202)
    await h.bulk.idle()
    expect((await h.call('POST', '/bulk/:jobId/undo', `${jobPath}/undo`)).json.error).toBe('undone')
    expect((await h.call('GET', '/bulk/:jobId', '/bulk/bulk-nope')).json).toMatchObject({ error: 'unknown-job' })
    const job = h.bulk.get(started.json.jobId)!
    const second = await h.call('POST', '/groups/read', '/groups/read', readBody({ group: 's:hello@em.shop.example.invalid' }))
    await h.bulk.idle()
    h.bulk.get(second.json.jobId)!.finishedAt = Date.now() - 11 * 60_000
    const expired = await h.call('POST', '/bulk/:jobId/undo', `/bulk/${second.json.jobId}/undo`)
    expect(expired).toEqual({ status: 410, json: { error: 'expired', message: UNDO_EXPIRED_MESSAGE } })
    expect(job.undone).toBe(true)
  })
})
