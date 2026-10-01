/**
 * The background re-sort (spec 5.8): 500-row batches in rowid order, the event loop yielded between
 * batches, resumable after an interruption (`sort_rev IS NOT ?`), one runner that restarts under a
 * newer revision, and progress events. 3,000 real-shaped rows in a real worker-thread database.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PluginDatabaseClient } from '../../src/core/plugins/plugin-storage.js'
import { MAIL_MIGRATIONS, MailDatabase } from '../../src/integrations/mail/db.js'
import { MailSortEngine } from '../../src/integrations/mail/sort-engine.js'
import { MailSortRecompute, RECOMPUTE_BATCH } from '../../src/integrations/mail/sort-recompute.js'
import type { ScanRow, Verdict } from '../../src/integrations/mail/sort-store.js'
import { MailStore } from '../../src/integrations/mail/store.js'

const ROWS = 3_000
const MARINA = 'imap:marina'
const FERRY = 'outlook:ferry'

let dir: string
let client: PluginDatabaseClient
let db: MailDatabase
let store: MailStore

function payloadFor(i: number): { from: string; payload: Record<string, unknown> } {
  const me = { name: 'Harbour, Robin', address: '' }
  switch (i % 6) {
    case 0: return { from: '', payload: { from: { address: '', name: 'Brand Tide to Shore' } } }
    case 1: return { from: '', payload: { from: { address: '', name: 'Pier, Dana' }, ...(i % 12 === 1 ? { to: [me] } : {}) } }
    case 2: return { from: 'noreply-oncall-notifications@page.example.invalid', payload: { from: { address: 'noreply-oncall-notifications@page.example.invalid' } } }
    case 3: return { from: 'hello@em.shop.example.invalid', payload: { from: { address: 'hello@em.shop.example.invalid' }, to: [{ address: 'robin@marina.example.invalid' }] } }
    case 4: return { from: 'carol.pier@friend.example.invalid', payload: { from: { address: 'carol.pier@friend.example.invalid', name: 'Carol Pier' }, to: [{ address: 'crew@marina.example.invalid' }] } }
    default: return { from: '', payload: { from: { address: '', name: 'payroll' } } }
  }
}

async function resetRows(): Promise<void> {
  await client.run('DELETE FROM messages')
  const rows = Array.from({ length: ROWS }, (_, i) => {
    const account = i % 2 === 0 ? MARINA : FERRY
    const shape = payloadFor(i)
    return [account, `INBOX:${i}`, `<r${i}@example.invalid>`, 'INBOX', shape.from, `Subject ${i}`, 1_700_000_000_000 + i, JSON.stringify(shape.payload), i % 4 === 0 ? 0 : 1]
  })
  // One statement for all rows (json_each), so the fixture itself costs one round trip.
  await client.run(
    'INSERT INTO messages (account_id, message_id, rfc_message_id, mailbox_id, from_addr, subject, sent_at, payload, seen, flags_json, updated_at)'
    + " SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]'),"
    + " json_extract(value, '$[4]'), json_extract(value, '$[5]'), json_extract(value, '$[6]'), json_extract(value, '$[7]'),"
    + " json_extract(value, '$[8]'), '[]', 0 FROM json_each(?)",
    [JSON.stringify(rows)],
  )
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-sort-recompute-'))
  client = new PluginDatabaseClient(path.join(dir, 'plugin.sqlite'))
  await client.migrate(MAIL_MIGRATIONS)
  await client.run("INSERT INTO accounts (account_id, provider_id, display_name, address) VALUES (?, 'imap', 'Harbour, Robin', 'robin@marina.example.invalid')", [MARINA])
  await client.run("INSERT INTO accounts (account_id, provider_id, display_name, address) VALUES (?, 'outlook', 'Harbour, Robin', '')", [FERRY])
  for (const account of [MARINA, FERRY]) {
    await client.run("INSERT INTO mailboxes (account_id, mailbox_id, name, role) VALUES (?, 'INBOX', 'Inbox', 'inbox')", [account])
  }
  db = new MailDatabase({ storage: { database: client } } as unknown as ConstructorParameters<typeof MailDatabase>[0])
  store = new MailStore(db)
})

afterAll(async () => {
  await db?.dispose()
  fs.rmSync(dir, { recursive: true, force: true })
})

beforeEach(async () => {
  await resetRows()
})

async function pending(rev: string): Promise<number> {
  return store.sort.countPending(rev)
}

describe('the engine backfill', () => {
  it('sorts all 3,000 rows in 500-row batches, yielding: no batch holds the event loop 50 ms', async () => {
    const progress: Array<{ done: number; total: number }> = []
    let sorted = 0
    const events = {
      sortProgress: (event: { done: number; total: number }) => { progress.push(event) },
      sorted: () => { sorted += 1 },
      groupsChanged: () => undefined,
      rulesChanged: () => undefined,
    }
    const engine = new MailSortEngine({ store, dataDir: dir, watch: false, events: events as never })
    // The synchronous half of each batch, measured directly (classification is the only JS that runs
    // between two awaits), plus the event loop delay as the process saw it.
    const verdictOf = engine.verdictOf.bind(engine)
    const batchMs: number[] = []
    let batchStart = 0
    let inBatch = 0
    engine.verdictOf = (row: ScanRow): Verdict => {
      if (inBatch === 0) batchStart = performance.now()
      const verdict = verdictOf(row)
      inBatch += 1
      if (inBatch === RECOMPUTE_BATCH) { batchMs.push(performance.now() - batchStart); inBatch = 0 }
      return verdict
    }
    const delay = monitorEventLoopDelay({ resolution: 10 })
    delay.enable()
    await engine.start()
    await engine.idle()
    delay.disable()
    engine.dispose()
    expect(await pending(engine.rulesRev)).toBe(0)
    expect(batchMs).toHaveLength(ROWS / RECOMPUTE_BATCH)
    expect(Math.max(...batchMs)).toBeLessThan(50)
    // Loose on purpose: this machine may be busy; the direct measure above is the real bound.
    expect(delay.max / 1e6).toBeLessThan(250)
    expect(progress.map((one) => one.done)).toEqual([500, 1000, 1500, 2000, 2500, 3000])
    expect(progress.every((one) => one.total === ROWS)).toBe(true)
    expect(sorted).toBe(1)
  })

  it('the counts invariant holds after the backfill: every row is in exactly one group', async () => {
    const engine = new MailSortEngine({ store, dataDir: dir, watch: false })
    await engine.start()
    await engine.idle()
    engine.dispose()
    const counts = await store.sort.groupCounts([{ accountId: MARINA, mailboxId: 'INBOX' }, { accountId: FERRY, mailboxId: 'INBOX' }])
    expect(counts.reduce((sum, row) => sum + row.total, 0)).toBe(ROWS)
    const byGroup = new Map<string, number>()
    for (const row of counts) byGroup.set(row.grp, (byGroup.get(row.grp) ?? 0) + row.total)
    // No model here: the built-ins keep people's mail in Important, and every other mail goes to
    // its sender's own group.
    expect(Object.fromEntries(byGroup)).toEqual({
      important: 500,
      's:name:brand tide to shore': 500,
      's:noreply-oncall-notifications@page.example.invalid': 500,
      's:hello@em.shop.example.invalid': 500,
      's:carol.pier@friend.example.invalid': 500,
      's:name:payroll': 500,
    })
  })
})

describe('the runner', () => {
  const rows = () => ({ pendingRows: store.sort.pendingRows.bind(store.sort), countPending: store.sort.countPending.bind(store.sort), applyVerdicts: store.sort.applyVerdicts.bind(store.sort) })

  it('resumes where an interrupted run stopped (sort_rev IS NOT ?, rowid order)', async () => {
    let seen = 0
    const first = new MailSortRecompute({
      store: rows(),
      verdictOf: (row) => ({ rowid: row.rowid, group: 'important', reason: 'test', rev: 'rev-a', senderKey: 'k' }),
      yieldNow: async () => { seen += 1; if (seen === 2) first.dispose() },
    })
    await first.start('rev-a')
    expect(await pending('rev-a')).toBe(ROWS - 2 * RECOMPUTE_BATCH)
    const visited: number[] = []
    const second = new MailSortRecompute({
      store: rows(),
      verdictOf: (row) => { visited.push(row.rowid); return { rowid: row.rowid, group: 'important', reason: 'test', rev: 'rev-a', senderKey: 'k' } },
    })
    await second.start('rev-a')
    expect(await pending('rev-a')).toBe(0)
    expect(visited).toHaveLength(ROWS - 2 * RECOMPUTE_BATCH)
    expect([...visited].sort((a, b) => a - b)).toEqual(visited)
  })

  it('one runner: a newer revision mid-run restarts from the first row under that revision', async () => {
    let rev = 'rev-a'
    let batches = 0
    const sortedRevs: string[] = []
    const runner: MailSortRecompute = new MailSortRecompute({
      store: rows(),
      verdictOf: (row) => ({ rowid: row.rowid, group: 'notifications', reason: 'test', rev, senderKey: 'k' }),
      events: { sortProgress: () => undefined, sorted: (value) => { sortedRevs.push(value) }, groupsChanged: () => undefined },
      yieldNow: async () => {
        batches += 1
        if (batches === 1) { rev = 'rev-b'; void runner.start('rev-b') }
      },
    })
    const a = runner.start('rev-a')
    const b = runner.start('rev-a')
    expect(a).toBe(b)
    await runner.idle()
    expect(await pending('rev-b')).toBe(0)
    expect(sortedRevs).toEqual(['rev-b'])
    expect(runner.progress()).toBeUndefined()
  })

  it('nothing pending means no progress events and no sorted event', async () => {
    const engine = new MailSortEngine({ store, dataDir: dir, watch: false })
    await engine.start()
    await engine.idle()
    let events = 0
    const again = new MailSortRecompute({
      store: rows(),
      verdictOf: engine.verdictOf.bind(engine),
      events: { sortProgress: () => { events += 1 }, sorted: () => { events += 1 }, groupsChanged: () => undefined },
    })
    await again.start(engine.rulesRev)
    engine.dispose()
    expect(events).toBe(0)
  })
})
