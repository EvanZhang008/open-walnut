/**
 * "Keep out of the Inbox" end to end below the routes: a real database, the real sort engine and
 * ingest path, and the mover (mail-filter-moves.ts) against two in-test providers, one that can move
 * mail to an archive and one that cannot. The clock is the test's, so the retry schedule is exact.
 *
 * What it pins:
 * - only mail that ARRIVES after the rule existed is moved on arrival; older mail the new rule
 *   re-sorts stays where it is (the card moves that on request);
 * - a moved mail leaves the inbox cache (row and body), and the folder's unread count follows;
 * - a failure is retried twice (1 min, 5 min) and then kept as failed, the mail still in the inbox;
 *   a failed one is not asked again for an hour;
 * - an account that cannot archive fails at once, without a call;
 * - a mail that comes BACK to the inbox is moved again, no sooner than 10 minutes after the last
 *   move and at most five times (a server that ignores the move cannot loop the mover);
 * - a move still waiting when its rule goes (Undo) is dropped, never made, batch by batch;
 * - a move whose rule no longer DECIDES that mail (an edit narrowed it) is dropped, never made;
 * - when the sort engine cannot say (`ruleTarget` undefined or a throw, `stillDecides` a throw) the
 *   rows wait a minute, neither moved nor dropped;
 * - a filter's folder goes to `moveMany`, and an account that cannot file fails at once.
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PluginDatabaseClient } from '../../src/core/plugins/plugin-storage.js'
import { MailBodyStore } from '../../src/integrations/mail/bodies.js'
import { MAIL_MIGRATIONS, MailDatabase } from '../../src/integrations/mail/db.js'
import { CANNOT_ARCHIVE, CANNOT_FILE, MOVE_ATTEMPTS, MailFilterMover, type FilterMoverDeps } from '../../src/integrations/mail/mail-filter-moves.js'
import { MailProviderRegistry } from '../../src/integrations/mail/provider-registry.js'
import { MailService } from '../../src/integrations/mail/service.js'
import { FILTER_SINCE_META_KEY, MailSortEngine } from '../../src/integrations/mail/sort-engine.js'
import { RULES_FILE_NAME } from '../../src/integrations/mail/sort-rules-file.js'
import { MailStore } from '../../src/integrations/mail/store.js'
import { MAX_MOVES, REMOVE_AFTER_MS, REQUEUE_FAILED_AFTER_MS } from '../../src/integrations/mail/store-moves.js'
import type { MailEnvelope, MailProviderSpec } from '../../src/integrations/mail/types.js'

const MARINA = 'fx:marina'
const FERRY = 'plain:ferry'
const SHOP = 'news@shop.example.invalid'
const T0 = Date.UTC(2026, 8, 20, 9, 0, 0)
const MINUTE = 60_000

interface Rig {
  dir: string
  client: PluginDatabaseClient
  db: MailDatabase
  store: MailStore
  engine: MailSortEngine
  service: MailService
  mover: MailFilterMover
  clock: { now: number }
  archived: string[][]
  /** What the archiving provider answers per message (default: moved). */
  answer: (messageId: string) => { ok: boolean; reason?: string }
  settled: Array<{ accountId: string; moved: number; failed: number; messageIds: string[] }>
  /** Rule ids the test has taken away (Undo) since the rig was built. */
  removed: Set<string>
}

let rig: Rig

function spec(id: string, archive: boolean, onArchive?: (ids: string[]) => Array<{ messageId: string; ok: boolean; reason?: string }>): MailProviderSpec {
  return {
    id,
    label: id,
    capabilities: {
      search: false, watch: false, drafts: false, markRead: true, flags: false, threads: false,
      send: false, sendAsReply: false, bodies: 'text', attachments: 'none', ...(archive ? { archive: true } : {}),
    },
    setup: { fields: [], submit: async () => { throw new Error('no setup') } },
    listAccounts: async () => [],
    health: async () => ({ state: 'ok', checkedAt: Date.now() }),
    listMailboxes: async () => [],
    poll: async () => ({ messages: [], cursor: 'c0', more: false }),
    getBody: async () => ({ format: 'text', text: '', bytes: 0 }),
    send: async () => { throw new Error('cannot send') },
    ...(onArchive ? { archiveMany: async (_account: string, ids: string[]) => onArchive(ids) } : {}),
  } as MailProviderSpec
}

async function writeRules(dir: string, skipInbox = true): Promise<void> {
  await fsp.writeFile(path.join(dir, RULES_FILE_NAME), [
    'version: 1',
    'groups:',
    '  - Shop news',
    'rules:',
    '  - id: r-shop',
    `    when: { from: "${SHOP}" }`,
    '    then: Shop news',
    ...(skipInbox ? ['    skipInbox: true'] : []),
    '',
  ].join('\n'))
}

function mail(n: number, at: number, extra: Partial<MailEnvelope> = {}): MailEnvelope {
  return {
    messageId: `INBOX:1:${n}`,
    rfcMessageId: `<m${n}@shop.example.invalid>`,
    mailboxId: 'INBOX',
    from: { address: SHOP, name: 'Shop' },
    to: [{ address: 'robin@marina.example.invalid' }],
    subject: `Offer ${n}`,
    sentAt: at,
    receivedAt: at,
    flags: [],
    ...extra,
  }
}

async function rowIds(account = MARINA): Promise<string[]> {
  return (await rig.client.all<{ message_id: string }>('SELECT message_id FROM messages WHERE account_id = ? ORDER BY message_id', [account]))
    .map((row) => row.message_id)
}

async function ledger(messageId: string, account = MARINA) {
  return rig.client.get<{ status: string; attempts: number; moves: number; at: number; reason: string | null }>(
    'SELECT status, attempts, moves, at, reason FROM mail_filter_moves WHERE account_id = ? AND message_id = ?', [account, messageId],
  )
}

beforeEach(async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mail-filter-moves-'))
  const client = new PluginDatabaseClient(path.join(dir, 'plugin.sqlite'))
  await client.migrate(MAIL_MIGRATIONS)
  for (const [account, provider] of [[MARINA, 'fx'], [FERRY, 'plain']] as const) {
    await client.run('INSERT INTO accounts (account_id, provider_id, display_name, address) VALUES (?, ?, ?, ?)', [account, provider, 'Robin', `robin@${provider}.example.invalid`])
    await client.run("INSERT INTO mailboxes (account_id, mailbox_id, name, role, unread, total) VALUES (?, 'INBOX', 'Inbox', 'inbox', 0, 0)", [account])
    await client.run("INSERT INTO mailboxes (account_id, mailbox_id, name, role) VALUES (?, 'Sent', 'Sent', 'sent')", [account])
  }
  const db = new MailDatabase({ storage: { database: client } } as unknown as ConstructorParameters<typeof MailDatabase>[0])
  const store = new MailStore(db)
  const bodies = new MailBodyStore(dir)
  const clock = { now: T0 }
  const archived: string[][] = []
  const settled: Rig['settled'] = []
  const providers = new MailProviderRegistry(() => undefined)
  providers.register(spec('fx', true, (ids) => {
    archived.push(ids)
    // Read at call time, so a test can change the answer after the rig is built.
    return ids.map((messageId) => ({ messageId, ...rig.answer(messageId) }))
  }), 'test')
  providers.register(spec('plain', false), 'test')
  await writeRules(dir)
  const engine = new MailSortEngine({ store, dataDir: dir, watch: false, canMarkRead: () => true, now: () => clock.now })
  const mover = new MailFilterMover({
    store, bodies, providers,
    groupsChanged: () => undefined,
    onSettled: (event) => settled.push(event),
    ruleLive: async (ruleId) => !rig.removed.has(ruleId) && engine.isFilterRule(ruleId),
    // The test runs the mover itself; a scheduled run never fires on its own.
    timeout: () => ({ dispose: () => undefined }),
    now: () => clock.now,
  })
  const service = new MailService({ store, bodies, providers, sort: engine, filters: mover })
  engine.setMoveSink((requests) => { void mover.queue(requests) })
  await engine.start()
  await engine.idle()
  rig = { dir, client, db, store, engine, service, mover, clock, archived, settled, answer: () => ({ ok: true }), removed: new Set() }
})

afterEach(async () => {
  rig.engine.setMoveSink(null)
  rig.mover.dispose()
  rig.engine.dispose()
  await rig.db.dispose().catch(() => undefined)
  await fsp.rm(rig.dir, { recursive: true, force: true })
})

describe('arrival', () => {
  it('moves only mail that arrived after the rule existed; the row leaves the cache and the count follows', async () => {
    await rig.service.ingestPage(MARINA, [mail(1, T0 - 60 * MINUTE), mail(2, T0 + MINUTE)])
    const unread = async () => (await rig.client.get<{ unread: number }>(
      "SELECT unread FROM mailboxes WHERE account_id = ? AND mailbox_id = 'INBOX'", [MARINA],
    ))!.unread
    const before = await unread()
    await rig.mover.runNow()

    expect(rig.archived).toEqual([['INBOX:1:2']])
    expect(await rowIds()).toEqual(['INBOX:1:1'])
    expect(await ledger('INBOX:1:2')).toMatchObject({ status: 'moved', attempts: 0, moves: 1 })
    expect(await ledger('INBOX:1:1')).toBeUndefined()
    expect(await unread()).toBe(Math.max(0, before - 1))
    expect(rig.settled).toEqual([{ accountId: MARINA, moved: 1, failed: 0, messageIds: ['INBOX:1:2'] }])
    expect(await rig.store.moves.countsByRule()).toEqual(new Map([['r-shop', { moved: 1, failed: 0, queued: 0 }]]))
  })

  it('a rule without skipInbox, or mail outside the inbox, is never moved', async () => {
    await writeRules(rig.dir, false)
    await rig.engine.reloadRules()
    await rig.engine.idle()
    await rig.service.ingestPage(MARINA, [mail(3, T0 + MINUTE)])
    await rig.service.ingestPage(MARINA, [mail(4, T0 + MINUTE, { messageId: 'Sent:1:4', mailboxId: 'Sent' })])
    await rig.mover.runNow()
    expect(rig.archived).toEqual([])
    expect(await rig.client.get('SELECT COUNT(*) AS n FROM mail_filter_moves')).toEqual({ n: 0 })
  })

  it('the rule start time survives a restart: mail from before it is still not moved', async () => {
    // Written in the background when the rules load.
    let since: string | undefined
    for (let n = 0; n < 50 && !since; n += 1) {
      since = await rig.store.tasks.getMeta(FILTER_SINCE_META_KEY)
      if (!since) await new Promise((resolve) => setTimeout(resolve, 20))
    }
    expect(JSON.parse(since!)).toEqual({ 'r-shop': T0 })
    rig.clock.now = T0 + 5 * 24 * 60 * MINUTE
    const again = new MailSortEngine({ store: rig.store, dataDir: rig.dir, watch: false, canMarkRead: () => true, now: () => rig.clock.now })
    try {
      await again.start()
      expect(again.moveOutRule('rule:r-shop', true, T0 - 1)).toBeUndefined()
      expect(again.moveOutRule('rule:r-shop', true, T0)).toBe('r-shop')
      expect(again.moveOutRule('rule:r-shop', false, T0 + 1)).toBeUndefined()
      expect(again.isFilterRule('r-shop')).toBe(true)
      expect(again.isFilterRule('r-none')).toBe(false)
    } finally {
      again.dispose()
    }
  })
})

describe('failure and retry', () => {
  it('retries at 1 and 5 minutes, then keeps it as failed; the mail stays in the inbox', async () => {
    rig.answer = () => ({ ok: false, reason: 'The server said no.' })
    await rig.service.ingestPage(MARINA, [mail(5, T0 + MINUTE)])
    await rig.mover.runNow()
    expect(await ledger('INBOX:1:5')).toMatchObject({ status: 'queued', attempts: 1, at: T0 + MINUTE, reason: 'The server said no.' })

    await rig.mover.runNow()
    expect(rig.archived).toHaveLength(1)

    rig.clock.now = T0 + MINUTE
    await rig.mover.runNow()
    expect(await ledger('INBOX:1:5')).toMatchObject({ status: 'queued', attempts: 2, at: T0 + 6 * MINUTE })

    rig.clock.now = T0 + 6 * MINUTE
    await rig.mover.runNow()
    expect(await ledger('INBOX:1:5')).toMatchObject({ status: 'failed', attempts: MOVE_ATTEMPTS })
    expect(rig.archived).toHaveLength(3)
    expect(await rowIds()).toEqual(['INBOX:1:5'])
    expect(rig.settled.at(-1)).toMatchObject({ moved: 0, failed: 1 })

    const request = [{ accountId: MARINA, messageId: 'INBOX:1:5', mailboxId: 'INBOX', ruleId: 'r-shop' }]
    expect(await rig.mover.queue(request)).toBe(0)
    rig.clock.now = T0 + 6 * MINUTE + REQUEUE_FAILED_AFTER_MS + 1
    expect(await rig.mover.queue(request)).toBe(1)
    expect(await ledger('INBOX:1:5')).toMatchObject({ status: 'queued', attempts: 0 })
  })

  it('a provider that throws fails every message of the batch, and the next batch still runs', async () => {
    rig.answer = () => { throw new Error('connection reset') }
    await rig.service.ingestPage(MARINA, [mail(6, T0 + MINUTE), mail(7, T0 + MINUTE)])
    await rig.mover.runNow()
    expect(await ledger('INBOX:1:6')).toMatchObject({ status: 'queued', attempts: 1, reason: 'connection reset' })
    expect(await ledger('INBOX:1:7')).toMatchObject({ status: 'queued', attempts: 1 })
    rig.answer = () => ({ ok: true })
    rig.clock.now = T0 + MINUTE
    await rig.mover.runNow()
    expect(await rowIds()).toEqual([])
  })

  it('an account that cannot archive fails at once, without a call', async () => {
    expect(rig.mover.canArchive(FERRY)).toBe(false)
    expect(rig.mover.canArchive(MARINA)).toBe(true)
    await rig.service.ingestPage(FERRY, [mail(8, T0 + MINUTE)])
    await rig.mover.runNow()
    expect(await ledger('INBOX:1:8', FERRY)).toMatchObject({ status: 'failed', attempts: MOVE_ATTEMPTS, reason: CANNOT_ARCHIVE })
    expect(rig.archived).toEqual([])
    expect(await rowIds(FERRY)).toEqual(['INBOX:1:8'])
  })
})

describe('mail that comes back', () => {
  it('is moved again no sooner than 10 minutes after the last move, and at most five times', async () => {
    const back = mail(9, T0 + MINUTE)
    await rig.service.ingestPage(MARINA, [back])
    await rig.mover.runNow()
    expect(await ledger('INBOX:1:9')).toMatchObject({ status: 'moved', moves: 1 })

    for (let round = 2; round <= MAX_MOVES; round += 1) {
      // Back in the inbox a minute later (a reply re-filed the conversation): queued, not yet due.
      rig.clock.now += MINUTE
      const movedAt = (await ledger('INBOX:1:9'))!.at
      await rig.service.ingestPage(MARINA, [{ ...back, receivedAt: rig.clock.now, sentAt: rig.clock.now }])
      expect(await ledger('INBOX:1:9')).toMatchObject({ status: 'queued', at: movedAt + REMOVE_AFTER_MS })
      await rig.mover.runNow()
      expect(await rowIds()).toEqual(['INBOX:1:9'])
      rig.clock.now = movedAt + REMOVE_AFTER_MS
      await rig.mover.runNow()
      expect(await ledger('INBOX:1:9')).toMatchObject({ status: 'moved', moves: round })
      expect(await rowIds()).toEqual([])
    }

    rig.clock.now += REMOVE_AFTER_MS + MINUTE
    await rig.service.ingestPage(MARINA, [{ ...back, receivedAt: rig.clock.now, sentAt: rig.clock.now }])
    await rig.mover.runNow()
    // The sixth time it stays: whatever keeps putting it back wins, and the mover stops trying.
    expect(await ledger('INBOX:1:9')).toMatchObject({ status: 'moved', moves: MAX_MOVES })
    expect(await rowIds()).toEqual(['INBOX:1:9'])
    expect(rig.archived).toHaveLength(MAX_MOVES)
  })
})

describe('a rule that goes while its moves wait', () => {
  it('drops the queued moves unmade, keeps what already moved, and moves nothing more', async () => {
    const early = Array.from({ length: 3 }, (_, i) => mail(20 + i, T0 + MINUTE))
    await rig.service.ingestPage(MARINA, early)
    await rig.mover.runNow()
    expect(rig.archived.flat()).toEqual(['INBOX:1:20', 'INBOX:1:21', 'INBOX:1:22'])

    // More of the group queued, then Undo before the mover reaches them.
    await rig.service.ingestPage(MARINA, [mail(30, T0 + MINUTE), mail(31, T0 + MINUTE)])
    expect(await ledger('INBOX:1:30')).toMatchObject({ status: 'queued' })
    await writeRules(rig.dir, false)
    await rig.engine.reloadRules()
    await rig.engine.idle()
    await rig.mover.runNow()

    expect(rig.archived.flat()).toEqual(['INBOX:1:20', 'INBOX:1:21', 'INBOX:1:22'])
    expect(await ledger('INBOX:1:30')).toBeUndefined()
    expect(await ledger('INBOX:1:31')).toBeUndefined()
    expect(await ledger('INBOX:1:20')).toMatchObject({ status: 'moved' })
    expect(await rowIds()).toEqual(['INBOX:1:30', 'INBOX:1:31'])
  })

  it('asks per batch, so a rule taken away between two batches stops the second', async () => {
    const many = Array.from({ length: 60 }, (_, i) => mail(100 + i, T0 + MINUTE))
    await rig.service.ingestPage(MARINA, many)
    // The first batch (50) is made; the Undo lands while it is on the wire.
    rig.answer = () => { rig.removed.add('r-shop'); return { ok: true } }
    await rig.mover.runNow()
    expect(rig.archived).toHaveLength(1)
    expect(rig.archived[0]).toHaveLength(50)
    expect(await rig.client.get("SELECT COUNT(*) AS n FROM mail_filter_moves WHERE status = 'queued'")).toEqual({ n: 0 })
    expect((await rowIds()).length).toBe(10)
  })
})

/**
 * The mover's own questions at move time, asked of deps the test controls. Mail is ingested through
 * the rig (so cached rows and queued moves are real); a second mover with these deps runs the ledger.
 */
describe('asking the rule at move time', () => {
  interface Calls { archived: string[][]; filed: Array<{ ids: string[]; folder: string }> }

  function moverWith(deps: Partial<FilterMoverDeps>, options: { canFile?: boolean } = {}): { mover: MailFilterMover; calls: Calls; settled: Array<{ folder?: string; moved: number; failed: number }> } {
    const calls: Calls = { archived: [], filed: [] }
    const settled: Array<{ folder?: string; moved: number; failed: number }> = []
    const providers = new MailProviderRegistry(() => undefined)
    const base = spec('fx', true, (ids) => { calls.archived.push(ids); return ids.map((messageId) => ({ messageId, ok: true })) })
    providers.register({
      ...base,
      capabilities: { ...base.capabilities, ...(options.canFile === false ? {} : { move: true }) },
      ...(options.canFile === false ? {} : {
        moveMany: async (_account: string, ids: string[], folder: string) => {
          calls.filed.push({ ids, folder })
          return ids.map((messageId) => ({ messageId, ok: true }))
        },
      }),
    } as MailProviderSpec, 'test')
    const mover = new MailFilterMover({
      store: rig.store,
      bodies: new MailBodyStore(rig.dir),
      providers,
      groupsChanged: () => undefined,
      onSettled: (event) => settled.push({ moved: event.moved, failed: event.failed, ...(event.folder ? { folder: event.folder } : {}) }),
      timeout: () => ({ dispose: () => undefined }),
      now: () => rig.clock.now,
      ...deps,
    })
    movers.push(mover)
    return { mover, calls, settled }
  }

  const movers: MailFilterMover[] = []
  afterEach(() => { for (const one of movers.splice(0)) one.dispose() })

  it('stillDecides: only the mail the rule still decides moves; the rest leaves the ledger unmoved', async () => {
    await rig.service.ingestPage(MARINA, [mail(40, T0 + MINUTE), mail(41, T0 + MINUTE), mail(42, T0 + MINUTE)])
    const asked: Array<{ ruleId: string; accountId: string; ids: string[] }> = []
    const { mover, calls } = moverWith({
      ruleTarget: async () => ({}),
      stillDecides: async (ruleId, accountId, ids) => { asked.push({ ruleId, accountId, ids: [...ids].sort() }); return new Set(['INBOX:1:41']) },
    })
    await mover.runNow()
    expect(asked).toEqual([{ ruleId: 'r-shop', accountId: MARINA, ids: ['INBOX:1:40', 'INBOX:1:41', 'INBOX:1:42'] }])
    expect(calls.archived).toEqual([['INBOX:1:41']])
    expect(await ledger('INBOX:1:41')).toMatchObject({ status: 'moved' })
    expect(await ledger('INBOX:1:40')).toBeUndefined()
    expect(await ledger('INBOX:1:42')).toBeUndefined()
    expect(await rowIds()).toEqual(['INBOX:1:40', 'INBOX:1:42'])
  })

  it('with the real engine: a rule narrowed after its moves were queued moves only what it still takes', async () => {
    await rig.service.ingestPage(MARINA, [mail(51, T0 + MINUTE), mail(62, T0 + MINUTE)])
    expect(await ledger('INBOX:1:51')).toMatchObject({ status: 'queued' })
    expect(await ledger('INBOX:1:62')).toMatchObject({ status: 'queued' })
    // Same id, narrower condition: only "Offer 51" is the rule's now.
    await fsp.writeFile(path.join(rig.dir, RULES_FILE_NAME), [
      'version: 1', 'groups:', '  - Shop news', 'rules:', '  - id: r-shop',
      `    when: { from: "${SHOP}", subject: "Offer 51" }`, '    then: Shop news', '    skipInbox: true', '',
    ].join('\n'))
    await rig.engine.reloadRules()
    await rig.engine.idle()
    const { mover, calls } = moverWith({
      ruleTarget: async (ruleId) => rig.engine.filterTarget(ruleId),
      stillDecides: (ruleId, accountId, ids) => rig.engine.filterStillDecides(ruleId, accountId, ids),
    })
    await mover.runNow()
    expect(calls.archived).toEqual([['INBOX:1:51']])
    expect(await ledger('INBOX:1:62')).toBeUndefined()
    expect(await rowIds()).toEqual(['INBOX:1:62'])
  })

  it('stillDecides throws: the rows wait a minute, neither moved nor dropped, and move once it answers', async () => {
    await rig.service.ingestPage(MARINA, [mail(43, T0 + MINUTE)])
    let broken = true
    const { mover, calls } = moverWith({
      ruleTarget: async () => ({}),
      stillDecides: async (_rule, _account, ids) => { if (broken) throw new Error('rules not loaded'); return new Set(ids) },
    })
    await mover.runNow()
    expect(calls.archived).toEqual([])
    expect(await ledger('INBOX:1:43')).toMatchObject({ status: 'queued', attempts: 0, at: T0 + MINUTE })
    expect(await rowIds()).toEqual(['INBOX:1:43'])

    // Not due yet: nothing is asked or moved before the minute is up.
    await mover.runNow()
    expect(calls.archived).toEqual([])

    broken = false
    rig.clock.now = T0 + MINUTE
    await mover.runNow()
    expect(calls.archived).toEqual([['INBOX:1:43']])
    expect(await ledger('INBOX:1:43')).toMatchObject({ status: 'moved' })
  })

  for (const [label, answer] of [
    ['answers undefined (the engine could not start)', async () => undefined],
    ['throws', async () => { throw new Error('read failed') }],
  ] as const) {
    it(`ruleTarget ${label}: the rows wait a minute, never dropped`, async () => {
      await rig.service.ingestPage(MARINA, [mail(44, T0 + MINUTE), mail(45, T0 + MINUTE)])
      let asked = 0
      const { mover, calls } = moverWith({
        ruleTarget: answer as FilterMoverDeps['ruleTarget'],
        stillDecides: async (_rule, _account, ids) => { asked += 1; return new Set(ids) },
      })
      await mover.runNow()
      expect(calls.archived).toEqual([])
      expect(asked).toBe(0)
      for (const id of ['INBOX:1:44', 'INBOX:1:45']) {
        expect(await ledger(id)).toMatchObject({ status: 'queued', attempts: 0, at: T0 + MINUTE })
      }
      expect(await rowIds()).toEqual(['INBOX:1:44', 'INBOX:1:45'])
    })
  }

  it('ruleTarget null: the rule no longer keeps mail out, the rows are dropped without asking stillDecides', async () => {
    await rig.service.ingestPage(MARINA, [mail(46, T0 + MINUTE)])
    let asked = 0
    const { mover, calls } = moverWith({
      ruleTarget: async () => null,
      stillDecides: async (_rule, _account, ids) => { asked += 1; return new Set(ids) },
    })
    await mover.runNow()
    expect(asked).toBe(0)
    expect(calls.archived).toEqual([])
    expect(await ledger('INBOX:1:46')).toBeUndefined()
    expect(await rowIds()).toEqual(['INBOX:1:46'])
  })

  it("ruleTarget wins over ruleLive: a live rule the engine cannot answer for still waits", async () => {
    await rig.service.ingestPage(MARINA, [mail(47, T0 + MINUTE)])
    const { mover, calls } = moverWith({ ruleLive: async () => true, ruleTarget: async () => undefined })
    await mover.runNow()
    expect(calls.archived).toEqual([])
    expect(await ledger('INBOX:1:47')).toMatchObject({ status: 'queued', at: T0 + MINUTE })
  })

  it("a filter's folder goes to moveMany, read at move time", async () => {
    await rig.service.ingestPage(MARINA, [mail(48, T0 + MINUTE), mail(49, T0 + MINUTE)])
    const { mover, calls, settled } = moverWith({ ruleTarget: async () => ({ folder: 'Shop/Offers' }) })
    await mover.runNow()
    expect(calls.archived).toEqual([])
    expect(calls.filed).toEqual([{ ids: ['INBOX:1:48', 'INBOX:1:49'], folder: 'Shop/Offers' }])
    expect(settled).toEqual([{ moved: 2, failed: 0, folder: 'Shop/Offers' }])
    expect(await rowIds()).toEqual([])
  })

  it('an account that cannot file into a folder fails at once, without a call', async () => {
    await rig.service.ingestPage(MARINA, [mail(50, T0 + MINUTE)])
    const { mover, calls } = moverWith({ ruleTarget: async () => ({ folder: 'Shop/Offers' }) }, { canFile: false })
    expect(mover.canFile(MARINA)).toBe(false)
    expect(mover.canArchive(MARINA)).toBe(true)
    await mover.runNow()
    expect(calls.filed).toEqual([])
    expect(calls.archived).toEqual([])
    expect(await ledger('INBOX:1:50')).toMatchObject({ status: 'failed', attempts: MOVE_ATTEMPTS, reason: CANNOT_FILE })
    expect(await rowIds()).toEqual(['INBOX:1:50'])
  })
})
