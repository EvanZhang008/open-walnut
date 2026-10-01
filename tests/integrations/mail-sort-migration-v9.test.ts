/**
 * Migrations v9 to v11 on a database that already holds v8 rows (C40, C59), and v10 on one that
 * already holds v9's fixed buckets. v11 only adds two tables (group lines, the archive move ledger).
 *
 * v9 adds four columns, two indexes and the hints table; v10 adds the model's columns and the
 * renames table. Neither backfills (a 25k-row JSON parse does not belong in the call that opens the
 * database). The background recompute then has to reach EVERY row: the bug this guards against is
 * `sort_rev <> ?`, which is NULL for every migrated row, selects nothing, and leaves all mail
 * "Sorting\u2026" forever. v9's bucket names are not group ids any more: v10 puts them back to NULL
 * (shown in Important) so none of them draws as a group that cannot be opened.
 *
 * Re-ingesting an unchanged envelope stays a no-op down to `updated_at`: none of the new columns
 * or headers feed `envelopeHashOf`.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PluginDatabaseClient } from '../../src/core/plugins/plugin-storage.js'
import { MailBodyStore } from '../../src/integrations/mail/bodies.js'
import { envelopeHashOf } from '../../src/integrations/mail/contract.js'
import { MAIL_MIGRATIONS, MailDatabase } from '../../src/integrations/mail/db.js'
import { MailProviderRegistry } from '../../src/integrations/mail/provider-registry.js'
import { MailService } from '../../src/integrations/mail/service.js'
import { MailSortEngine } from '../../src/integrations/mail/sort-engine.js'
import { MailStore } from '../../src/integrations/mail/store.js'
import type { MailEnvelope } from '../../src/integrations/mail/types.js'

const ACCOUNT = 'imap:marina'
const ROWS = 1_200
const T0 = Date.UTC(2026, 8, 1)

/** Real shapes, invented names: people, name-only rows, marketing, notices, lists, no recipients. */
function envelopeFor(i: number): MailEnvelope {
  const me = { address: 'robin@marina.example.invalid', name: 'Harbour, Robin' }
  const shapes: Array<Partial<MailEnvelope>> = [
    { from: { address: 'carol.pier@friend.example.invalid', name: 'Carol Pier' }, to: [me] },
    { from: { address: '', name: 'Pier, Dana' } },
    { from: { address: '', name: 'Brand Tide to Shore' } },
    { from: { address: 'hello@em.shop.example.invalid' }, to: [me] },
    { from: { address: 'issues@tickets.example.invalid' }, to: [{ address: 'crew@marina.example.invalid' }] },
    { from: { address: 'carol.pier@friend.example.invalid' }, to: [{ name: 'crew-leads', address: '' }, { address: 'dock-team@' }] },
    { from: { address: 'tidewear@shop.example.invalid' }, to: [me], listUnsubscribe: { oneClick: true, https: ['https://shop.example.invalid/u'] } },
    { from: { address: '', name: 'payroll' } },
  ]
  const shape = shapes[i % shapes.length]!
  return {
    messageId: `INBOX:1:${i + 1}`,
    rfcMessageId: `<m${i}@marina.example.invalid>`,
    mailboxId: 'INBOX',
    from: shape.from!,
    ...(shape.to ? { to: shape.to } : {}),
    subject: `Subject ${i}`,
    sentAt: T0 + i * 60_000,
    flags: i % 3 === 0 ? [] : ['\\Seen'],
    ...(shape.listUnsubscribe ? { listUnsubscribe: shape.listUnsubscribe } : {}),
  }
}

let dir: string
let client: PluginDatabaseClient
let db: MailDatabase
let store: MailStore
let engine: MailSortEngine
const envelopes = Array.from({ length: ROWS }, (_, i) => envelopeFor(i))

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-sort-v9-'))
  client = new PluginDatabaseClient(path.join(dir, 'plugin.sqlite'))
  expect(await client.migrate(MAIL_MIGRATIONS.filter((one) => one.version <= 8))).toBe(8)
  await client.run("INSERT INTO accounts (account_id, provider_id, display_name, address) VALUES (?, 'imap', 'Harbour, Robin', 'robin@marina.example.invalid')", [ACCOUNT])
  await client.run("INSERT INTO mailboxes (account_id, mailbox_id, name, role, unread, total) VALUES (?, 'INBOX', 'Inbox', 'inbox', 400, 1200)", [ACCOUNT])
  await client.run("INSERT INTO mailboxes (account_id, mailbox_id, name, role) VALUES (?, 'Sent', 'Sent', 'sent')", [ACCOUNT])
  for (const envelope of envelopes) {
    const flags = JSON.stringify(envelope.flags ?? [])
    await client.run(
      'INSERT INTO messages (account_id, message_id, rfc_message_id, mailbox_id, from_addr, subject, sent_at, flags_json,'
      + ' attachments_json, payload, updated_at, envelope_hash, seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [ACCOUNT, envelope.messageId, envelope.rfcMessageId, envelope.mailboxId, envelope.from.address, envelope.subject,
        envelope.sentAt, flags, '[]',
        JSON.stringify({ from: envelope.from, ...(envelope.to ? { to: envelope.to } : {}), ...(envelope.listUnsubscribe ? { listUnsubscribe: envelope.listUnsubscribe } : {}) }),
        1234, envelopeHashOf(envelope), flags.includes('Seen') ? 1 : 0],
    )
  }
  db = new MailDatabase({ storage: { database: client } } as unknown as ConstructorParameters<typeof MailDatabase>[0])
  store = new MailStore(db)
})

afterAll(async () => {
  engine?.dispose()
  await db?.dispose()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('migrations v9 and v10', () => {
  it('add the columns, both indexes, the hints and renames tables, and backfill nothing', async () => {
    const latest = MAIL_MIGRATIONS[MAIL_MIGRATIONS.length - 1]!.version
    expect(latest).toBe(11)
    expect(await client.migrate(MAIL_MIGRATIONS)).toBe(11)
    const columns = (await client.all<{ name: string }>('PRAGMA table_info(messages)')).map((row) => row.name)
    expect(columns).toEqual(expect.arrayContaining([
      'sort_group', 'sort_reason', 'sort_rev', 'sender_key', 'ai_label', 'ai_important', 'ai_why', 'ai_rev', 'sort_label',
    ]))
    const indexes = (await client.all<{ name: string }>('PRAGMA index_list(messages)')).map((row) => row.name)
    expect(indexes).toEqual(expect.arrayContaining(['messages_by_group', 'messages_by_group_sender']))
    const tables = await client.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('mail_sort_hints', 'mail_sort_labels') ORDER BY name")
    expect(tables.map((row) => row.name)).toEqual(['mail_sort_hints', 'mail_sort_labels'])
    const nulls = await client.get<{ n: number }>('SELECT COUNT(*) AS n FROM messages WHERE sort_rev IS NULL AND sort_group IS NULL')
    expect(nulls?.n).toBe(ROWS)
    // v11: the group lines and the "keep out of the inbox" move ledger, both empty.
    const v11 = await client.all<{ name: string }>("SELECT name FROM sqlite_master WHERE name IN ('mail_group_summaries', 'mail_filter_moves', 'mail_filter_moves_by_status') ORDER BY name")
    expect(v11.map((row) => row.name)).toEqual(['mail_filter_moves', 'mail_filter_moves_by_status', 'mail_group_summaries'])
    const moveColumns = (await client.all<{ name: string }>('PRAGMA table_info(mail_filter_moves)')).map((row) => row.name)
    expect(moveColumns).toEqual(expect.arrayContaining(['status', 'attempts', 'moves', 'reason', 'at']))
    expect(await client.get('SELECT COUNT(*) AS n FROM mail_filter_moves')).toEqual({ n: 0 })
  })

  it('a NULL group reads as Important before the backfill (nothing hidden)', async () => {
    const page = await store.listMessages({ accountId: ACCOUNT, mailboxId: 'INBOX', limit: 200, group: 'important' })
    expect(page).toHaveLength(200)
  })

  it('the background recompute reaches EVERY row, with sort_rev = rulesRev (never `<> ?`)', async () => {
    engine = new MailSortEngine({ store, dataDir: dir, watch: false, canMarkRead: () => true })
    await engine.start()
    await engine.idle()
    const rev = engine.rulesRev
    expect(rev).toMatch(/^[0-9a-f]{12}$/)
    const missing = await client.get<{ n: number }>('SELECT COUNT(*) AS n FROM messages WHERE sort_group IS NULL OR sort_rev IS NOT ?', [rev])
    expect(missing?.n).toBe(0)
    const groups = await client.all<{ g: string; n: number }>('SELECT sort_group AS g, COUNT(*) AS n FROM messages GROUP BY g ORDER BY g')
    // No model in this test: people's mail stays in Important, every other mail is its sender's group.
    expect(Object.fromEntries(groups.map((row) => [row.g, row.n]))).toEqual({
      important: 300,
      's:carol.pier@friend.example.invalid': 150,
      's:hello@em.shop.example.invalid': 150,
      's:issues@tickets.example.invalid': 150,
      's:name:brand tide to shore': 150,
      's:name:payroll': 150,
      's:tidewear@shop.example.invalid': 150,
    })
    const keys = await client.get<{ n: number }>('SELECT COUNT(*) AS n FROM messages WHERE sender_key IS NULL')
    expect(keys?.n).toBe(0)
  })
})

describe('ingest after v10', () => {
  function service(): MailService {
    return new MailService({
      store,
      bodies: new MailBodyStore(dir),
      providers: new MailProviderRegistry(() => undefined),
      sort: engine,
    })
  }

  it('re-ingesting unchanged envelopes is a no-op: envelope_hash, updated_at and verdicts all unchanged', async () => {
    const before = await client.all<Record<string, unknown>>('SELECT message_id, envelope_hash, updated_at, sort_group, sort_rev FROM messages ORDER BY rowid')
    const result = await service().ingestPage(ACCOUNT, envelopes.slice(0, 300))
    expect(result).toMatchObject({ added: 0, updated: 0 })
    const after = await client.all<Record<string, unknown>>('SELECT message_id, envelope_hash, updated_at, sort_group, sort_rev FROM messages ORDER BY rowid')
    expect(after).toEqual(before)
  })

  it('the envelope hash ignores list headers, bulk headers and every sort field', () => {
    const plain = envelopeFor(3)
    expect(envelopeHashOf({
      ...plain,
      listUnsubscribe: { oneClick: true, https: ['https://em.shop.example.invalid/u'], listId: 'x.example.invalid' },
      bulkHeaders: { precedence: 'bulk', autoSubmitted: 'auto-generated' },
    })).toBe(envelopeHashOf(plain))
  })

  it('a NEW mail is classified in the same statement that writes it (no recompute needed)', async () => {
    const fresh: MailEnvelope = {
      ...envelopeFor(4), messageId: 'INBOX:1:99999', rfcMessageId: '<fresh@marina.example.invalid>', sentAt: T0 + 10_000_000,
    }
    const result = await service().ingestPage(ACCOUNT, [fresh])
    expect(result.added).toBe(1)
    expect(result.importantAdded ?? 0).toBe(0)
    expect(result.sortedPairs).toEqual([{ accountId: ACCOUNT, mailboxId: 'INBOX' }])
    const row = await client.get<{ sort_group: string; sort_rev: string; sender_key: string; sort_reason: string }>(
      'SELECT sort_group, sort_rev, sender_key, sort_reason FROM messages WHERE message_id = ?', ['INBOX:1:99999'],
    )
    expect(row).toEqual({
      sort_group: 's:issues@tickets.example.invalid', sort_rev: engine.rulesRev, sender_key: 'issues@tickets.example.invalid', sort_reason: 'builtin:transactional',
    })
  })

  it('a new Important mail counts toward importantAdded with its headline', async () => {
    const person: MailEnvelope = { ...envelopeFor(0), messageId: 'INBOX:1:99998', rfcMessageId: '<p@marina.example.invalid>', sentAt: T0 + 10_000_001 }
    const result = await service().ingestPage(ACCOUNT, [person])
    expect(result.importantAdded).toBe(1)
    expect(result.importantHeadlines).toEqual([{ from: 'carol.pier@friend.example.invalid', subject: 'Subject 0' }])
  })
})

describe('v10 over v9 buckets', () => {
  it("puts v9's fixed buckets back to NULL and keeps Important, in the migration itself", async () => {
    const other = new PluginDatabaseClient(path.join(dir, 'v9.sqlite'))
    try {
      expect(await other.migrate(MAIL_MIGRATIONS.filter((one) => one.version <= 9))).toBe(9)
      const buckets = ['important', 'notifications', 'promotions', 'group-mail', 'unsorted', 'important', null]
      for (const [i, bucket] of buckets.entries()) {
        await other.run(
          "INSERT INTO messages (account_id, message_id, rfc_message_id, mailbox_id, from_addr, subject, sent_at, flags_json, payload, updated_at, sort_group, sort_rev)"
          + " VALUES (?, ?, ?, 'INBOX', '', ?, ?, '[]', '{}', 0, ?, 'v9-rev')",
          [ACCOUNT, `INBOX:9:${i}`, `<v9-${i}@marina.example.invalid>`, `Subject ${i}`, T0 + i, bucket],
        )
      }
      expect(await other.migrate(MAIL_MIGRATIONS)).toBe(11)
      const rows = await other.all<{ g: string | null }>('SELECT sort_group AS g FROM messages ORDER BY rowid')
      expect(rows.map((row) => row.g)).toEqual(['important', null, null, null, null, 'important', null])
      // The revision stays: the new rules revision differs anyway, so the recompute reaches them.
      const revs = await other.get<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE sort_rev = 'v9-rev'")
      expect(revs?.n).toBe(buckets.length)
    } finally {
      await other.dispose()
    }
  })
})

describe('NULL-safe predicates in the new code (C59)', () => {
  const files = [
    'sort-store.ts', 'sort-recompute.ts', 'sort-engine.ts', 'routes-sort.ts', 'routes-sort-rules.ts', 'store.ts', 'service.ts',
  ].map((name) => new URL(`../../src/integrations/mail/${name}`, import.meta.url))

  it('never compares sort_rev with <> or !=', () => {
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8')
      expect(text, String(file)).not.toMatch(/sort_rev\s*(<>|!=)/)
    }
  })
  it('every Important equality also admits NULL', () => {
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8')
      for (const match of text.matchAll(/sort_group = 'important'/g)) {
        expect(text.slice(match.index!, match.index! + 60), String(file)).toMatch(/OR (\$\{a\})?sort_group IS NULL/)
      }
    }
  })
})
