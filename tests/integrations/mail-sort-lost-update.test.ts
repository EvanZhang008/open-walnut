/**
 * A sort verdict computed before a yield is written only while the row still has what it was
 * computed from. The re-sort gives the event loop back inside a batch (mail-sort-slices.test.ts),
 * and an ingest page writes its rows one await at a time; meanwhile the labeler, ingest or a hint
 * may write the same row. An unconditional write then puts the older verdict over the newer one and
 * stamps it with the current revision, so nothing ever sorts that row again.
 *
 * Real worker-thread database. Each race forces the order in which the other writer finishes first
 * (its write is awaited before the stale one goes out); without the conditional write these fail.
 * The last block is a ratchet over the source: every statement that writes a verdict is listed with
 * why it cannot lose an update.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ts from 'typescript'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PluginDatabaseClient } from '../../src/core/plugins/plugin-storage.js'
import { MailBodyStore } from '../../src/integrations/mail/bodies.js'
import { MAIL_MIGRATIONS, MailDatabase } from '../../src/integrations/mail/db.js'
import { MailProviderRegistry } from '../../src/integrations/mail/provider-registry.js'
import { MailService, type MailServiceSortHook } from '../../src/integrations/mail/service.js'
import { MailSortEngine } from '../../src/integrations/mail/sort-engine.js'
import { MailSortRecompute, SLICE_MS } from '../../src/integrations/mail/sort-recompute.js'
import { basisOf, type ScanRow, type Verdict, type VerdictBasis } from '../../src/integrations/mail/sort-store.js'
import { MailStore } from '../../src/integrations/mail/store.js'
import type { MailEnvelope } from '../../src/integrations/mail/types.js'

const ACCOUNT = 'imap:marina'
const ROWS = 200

let dir: string
let client: PluginDatabaseClient
let db: MailDatabase
let store: MailStore

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-sort-lost-update-'))
  client = new PluginDatabaseClient(path.join(dir, 'plugin.sqlite'))
  await client.migrate(MAIL_MIGRATIONS)
  await client.run("INSERT INTO accounts (account_id, provider_id, display_name, address) VALUES (?, 'imap', 'Harbour, Robin', 'robin@marina.example.invalid')", [ACCOUNT])
  await client.run("INSERT INTO mailboxes (account_id, mailbox_id, name, role) VALUES (?, 'INBOX', 'Inbox', 'inbox')", [ACCOUNT])
  db = new MailDatabase({ storage: { database: client } } as unknown as ConstructorParameters<typeof MailDatabase>[0])
  store = new MailStore(db)
})

afterAll(async () => {
  await db?.dispose()
  fs.rmSync(dir, { recursive: true, force: true })
})

beforeEach(async () => {
  await client.run('DELETE FROM messages')
  await client.run('DELETE FROM mail_sort_hints')
  const rows = Array.from({ length: ROWS }, (_, i) => [`INBOX:${i}`, `<r${i}@marina.example.invalid>`, `pier${i}@dock.example.invalid`, `Subject ${i}`, 1_700_000_000_000 + i, `hash-${i}`])
  await client.run(
    'INSERT INTO messages (account_id, message_id, rfc_message_id, mailbox_id, from_addr, subject, sent_at, payload, seen, flags_json, updated_at, envelope_hash)'
    + " SELECT ?, json_extract(value, '$[0]'), json_extract(value, '$[1]'), 'INBOX', json_extract(value, '$[2]'), json_extract(value, '$[3]'),"
    + " json_extract(value, '$[4]'), '{}', 0, '[]', 0, json_extract(value, '$[5]') FROM json_each(?)",
    [ACCOUNT, JSON.stringify(rows)],
  )
})

function busy(ms: number): void {
  const end = performance.now() + ms
  while (performance.now() < end) { /* a slow rule set */ }
}

/** A verdict that reads the two inputs the races change: the model's label and `seen`. */
function verdictFrom(row: ScanRow): Verdict {
  const group = row.ai_label ? `g:${row.ai_label.toLowerCase()}` : Number(row.seen) === 1 ? 'seen' : 'important'
  return { rowid: row.rowid, group, reason: 'test', rev: 'rev-a', senderKey: 'k', label: group, basis: basisOf(row) }
}

async function groupOf(rowid: number): Promise<{ sort_group: string | null; sort_rev: string | null } | undefined> {
  return client.get('SELECT sort_group, sort_rev FROM messages WHERE rowid = ?', [rowid])
}

async function rowidOf(messageId: string): Promise<number> {
  const row = await client.get<{ rowid: number }>('SELECT rowid FROM messages WHERE message_id = ?', [messageId])
  return row!.rowid
}

describe('the background re-sort', () => {
  it('a write during an in-batch yield is not overwritten, and a row changed under it is sorted again', async () => {
    const labeled = await rowidOf('INBOX:150')
    const read = await rowidOf('INBOX:160')
    let computed = 0
    let computedAtWrite = -1
    let writer: Promise<void> = Promise.resolve()
    const writes: number[] = []
    const runner = new MailSortRecompute({
      store: {
        pendingRows: store.sort.pendingRows.bind(store.sort),
        countPending: store.sort.countPending.bind(store.sort),
        applyVerdicts: async (verdicts) => {
          await writer
          writes.push(verdicts.length)
          return store.sort.applyVerdicts(verdicts)
        },
      },
      verdictOf: (row) => {
        computed += 1
        if (computed === 1) {
          // Runs in the slice yield this row's cost forces: the labeler answers for a later row of
          // the same batch and sorts it, and another client marks a third row read.
          setImmediate(() => {
            computedAtWrite = computed
            writer = (async () => {
              await store.sort.applyAiVerdicts([{ rowid: labeled, label: 'Tide Notes', important: false, why: 'w', rev: 'ai-1' }])
              const [fresh] = await store.sort.rowsByRowids([labeled])
              await store.sort.applyVerdicts([verdictFrom(fresh!)])
              await client.run('UPDATE messages SET seen = 1 WHERE rowid = ?', [read])
            })()
          })
          busy(SLICE_MS + 5)
        }
        return verdictFrom(row)
      },
    })
    await runner.start('rev-a')
    // The other writer ran inside the batch (after its first row, before its last).
    expect(computedAtWrite).toBe(1)
    expect(await groupOf(labeled)).toEqual({ sort_group: 'g:tide notes', sort_rev: 'rev-a' })
    // Skipped in the first pass, then sorted again from what it is now.
    expect(await groupOf(read)).toEqual({ sort_group: 'seen', sort_rev: 'rev-a' })
    expect(writes).toEqual([ROWS, 1])
    expect(await store.sort.countPending('rev-a')).toBe(0)
  })
})

describe('the verdict basis', () => {
  // How another writer changes each input a verdict is computed from.
  const CHANGE: Record<keyof VerdictBasis, (rowid: number, messageId: string) => Promise<unknown>> = {
    envelopeHash: (rowid) => client.run("UPDATE messages SET envelope_hash = 'moved' WHERE rowid = ?", [rowid]),
    seen: (rowid) => client.run('UPDATE messages SET seen = 1 WHERE rowid = ?', [rowid]),
    mailboxId: (rowid) => client.run("UPDATE messages SET mailbox_id = 'Archive' WHERE rowid = ?", [rowid]),
    fromAddr: (rowid) => client.run("UPDATE messages SET from_addr = 'crew@dock.example.invalid' WHERE rowid = ?", [rowid]),
    bodyRef: (rowid) => client.run("UPDATE messages SET body_ref = 'body-1' WHERE rowid = ?", [rowid]),
    aiRev: (rowid) => client.run("UPDATE messages SET ai_rev = 'ai-2' WHERE rowid = ?", [rowid]),
    aiLabel: (rowid) => client.run("UPDATE messages SET ai_label = 'Tide Notes' WHERE rowid = ?", [rowid]),
    aiImportant: (rowid) => client.run('UPDATE messages SET ai_important = 1 WHERE rowid = ?', [rowid]),
    gmailCategory: (_rowid, messageId) => client.run("INSERT INTO mail_sort_hints (account_id, mailbox_id, message_id, gmail_category) VALUES (?, 'INBOX', ?, 'promotions')", [ACCOUNT, messageId]),
    listHeadersJson: (_rowid, messageId) => client.run("INSERT INTO mail_sort_hints (account_id, mailbox_id, message_id, list_headers_json) VALUES (?, 'INBOX', ?, '{}')", [ACCOUNT, messageId]),
  }

  it('every input in the basis, changed after the read, keeps the verdict out and reports the row', async () => {
    const [sample] = await store.sort.rowsByRowids([await rowidOf('INBOX:0')])
    // A new basis field needs its change here, so the condition it adds is proven to hold.
    expect(Object.keys(basisOf(sample!)).sort()).toEqual(Object.keys(CHANGE).sort())
    for (const [k, [field, change]] of Object.entries(CHANGE).entries()) {
      const messageId = `INBOX:${k + 1}`
      const rowid = await rowidOf(messageId)
      const [row] = await store.sort.rowsByRowids([rowid])
      const verdict = verdictFrom(row!)
      await change(rowid, messageId)
      const written = await store.sort.applyVerdicts([verdict])
      expect({ field, ...written }).toEqual({ field, changes: 0, stale: [rowid] })
      expect(await groupOf(rowid)).toEqual({ sort_group: null, sort_rev: null })
    }
    // Nothing changed: written, nothing stale.
    const [row] = await store.sort.rowsByRowids([await rowidOf('INBOX:50')])
    expect(await store.sort.applyVerdicts([verdictFrom(row!)])).toEqual({ changes: 1, stale: [] })
  })
})

describe('an ingest page', () => {
  const envelope: MailEnvelope = {
    messageId: 'INBOX:1:900', rfcMessageId: '<tide@marina.example.invalid>', mailboxId: 'INBOX',
    from: { address: 'news@tide.example.invalid', name: 'Tide News' }, to: [{ address: 'robin@marina.example.invalid' }],
    subject: 'Tide tables for the week', sentAt: 1_700_100_000_000, flags: [],
  }

  async function setup(): Promise<{ engine: MailSortEngine; service: MailService; reclassified: string[][]; during: { run?: () => Promise<void> } }> {
    const engine = new MailSortEngine({ store, dataDir: dir, watch: false })
    await engine.start()
    await engine.idle()
    const reclassified: string[][] = []
    const during: { run?: () => Promise<void> } = {}
    const hook: MailServiceSortHook = {
      prepareIngest: async (accountId, envelopes) => {
        const sortOf = await engine.prepareIngest(accountId, envelopes)
        // Between the page's read and its row's write: the labeler answers and sorts the row.
        await during.run?.()
        return sortOf
      },
      sortDtoOf: (row) => engine.sortDtoOf(row),
      notifyGroupsChanged: (pairs) => engine.notifyGroupsChanged(pairs),
      reclassify: async (accountId, ids) => { reclassified.push([...ids]); return engine.reclassify(accountId, ids) },
    }
    const service = new MailService({ store, bodies: new MailBodyStore(dir), providers: new MailProviderRegistry(() => undefined), sort: hook })
    await service.ingestPage(ACCOUNT, [envelope])
    return { engine, service, reclassified, during }
  }

  it("does not put a verdict read before the labeler's answer over the one written after it", async () => {
    const { engine, service, reclassified, during } = await setup()
    const rowid = await rowidOf(envelope.messageId)
    expect((await client.get<{ sort_reason: string }>('SELECT sort_reason FROM messages WHERE rowid = ?', [rowid]))?.sort_reason).not.toBe('ai')
    during.run = async () => {
      await store.sort.applyAiVerdicts([{ rowid, label: 'Tide Notes', important: false, why: 'w', rev: 'ai-1' }])
      await engine.reclassify(ACCOUNT, [envelope.messageId])
    }
    // Another client flagged the mail: a new envelope, still unread.
    await service.ingestPage(ACCOUNT, [{ ...envelope, flags: ['\\Flagged'] }])
    const row = await client.get<Record<string, unknown>>('SELECT sort_group, sort_reason, sort_rev, sort_label, flags_json FROM messages WHERE rowid = ?', [rowid])
    expect(row).toEqual({
      sort_group: engine.idForLabel('Tide Notes'), sort_reason: 'ai', sort_rev: engine.rulesRev, sort_label: 'Tide Notes', flags_json: '["\\\\Flagged"]',
    })
    // The page's own verdict was kept out, and the row sorted again from what it is now.
    expect(reclassified.at(-1)).toEqual([envelope.messageId])
    engine.dispose()
  })

  it('writes its verdict in the same statement when nothing moved, and sorts nothing again', async () => {
    const { engine, service, reclassified } = await setup()
    await service.ingestPage(ACCOUNT, [{ ...envelope, flags: ['\\Flagged'] }])
    const row = await client.get<Record<string, unknown>>('SELECT sort_rev, flags_json FROM messages WHERE message_id = ?', [envelope.messageId])
    expect(row).toEqual({ sort_rev: engine.rulesRev, flags_json: '["\\\\Flagged"]' })
    expect(reclassified).toEqual([])
    engine.dispose()
  })
})

describe('every verdict write is conditional or cannot lose an update', () => {
  const MAIL = path.resolve(import.meta.dirname, '../../src/integrations/mail')
  // `file: enclosing function or constant` -> why it cannot put an older verdict over a newer one.
  const KNOWN: Record<string, string> = {
    'sort-store.ts: applyVerdicts': 'conditional: BASIS_HOLDS, the row as its verdict read it (re-sort, labeler, hints, rule saves)',
    'store.ts: updateMessage': 'conditional: INGEST_INPUTS_HOLD, the model answer and hints the page read; the envelope is its own',
    'store.ts: insertMessage': 'a new row: no stored verdict to lose',
    'db.ts: SCHEMA_V10': 'a migration: runs before any writer',
    'sort-store.ts: applyAiVerdicts': "the model's answer, not a sort verdict: the labeler is its one writer, and the re-sort after it is conditional",
  }
  const CONDITION: Record<string, string> = {
    'sort-store.ts: applyVerdicts': 'BASIS_HOLDS',
    'store.ts: updateMessage': 'INGEST_INPUTS_HOLD',
  }
  const WRITES = /\b(UPDATE messages|INSERT INTO messages)\b/
  const VERDICT_COLUMNS = /\b(sort_group|sort_rev|ai_label|ai_rev)\b/

  function owner(node: ts.Node): string {
    for (let at: ts.Node | undefined = node; at; at = at.parent) {
      if ((ts.isMethodDeclaration(at) || ts.isFunctionDeclaration(at)) && at.name) return at.name.getText()
      if (ts.isVariableDeclaration(at) && ts.isIdentifier(at.name) && ts.isSourceFile(at.parent.parent.parent)) return at.name.text
    }
    return '?'
  }

  it('lists each one with its reason, and the conditional ones still carry their condition', () => {
    const found = new Map<string, string>()
    for (const name of fs.readdirSync(MAIL).filter((one) => one.endsWith('.ts') && !one.endsWith('.d.ts'))) {
      const text = fs.readFileSync(path.join(MAIL, name), 'utf8')
      const file = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true)
      const visit = (node: ts.Node): void => {
        // A statement: a database call's SQL argument, or a top-level SQL constant (migrations).
        const sql = ts.isCallExpression(node) && ['run', 'all', 'get'].includes(ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : '')
          ? node.arguments[0]
          : ts.isVariableDeclaration(node) && ts.isSourceFile(node.parent.parent.parent) ? node.initializer : undefined
        if (sql && WRITES.test(sql.getText()) && VERDICT_COLUMNS.test(sql.getText().split(WRITES)[2] ?? '')) {
          const key = `${name}: ${owner(node)}`
          const method = (() => {
            for (let at: ts.Node | undefined = node; at; at = at.parent) if (ts.isMethodDeclaration(at)) return at.getText()
            return sql.getText()
          })()
          found.set(key, method)
        }
        ts.forEachChild(node, visit)
      }
      visit(file)
    }
    expect([...found.keys()].sort()).toEqual(Object.keys(KNOWN).sort())
    for (const [key, condition] of Object.entries(CONDITION)) expect(found.get(key), key).toContain(condition)
  })

  it('every caller of applyVerdicts reads which rows were stale', () => {
    const calls: string[] = []
    for (const name of fs.readdirSync(MAIL).filter((one) => one.endsWith('.ts'))) {
      const lines = fs.readFileSync(path.join(MAIL, name), 'utf8').split('\n')
      lines.forEach((line, n) => {
        if (/\.applyVerdicts\(/.test(line)) calls.push(`${name}: ${/\bstale\b/.test(lines.slice(n, n + 3).join('\n')) ? 'reads stale' : line.trim()}`)
      })
    }
    expect(calls.sort()).toEqual(['sort-engine.ts: reads stale', 'sort-recompute.ts: reads stale'])
  })
})
