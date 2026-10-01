/**
 * Rule preview (spec 6.4, C68 C69): matches, moves, samples, shadows and the recipients coverage,
 * computed over a real worker-thread database classified by the real engine.
 *
 * The shadow case is the one from the spec: a day-one rule "Change Desk with Action Required goes to
 * Important", then a day-five correction "everything from Change Desk goes to Notifications". Inserted
 * above the old rule it takes those mails over (a shadow of 20); inserted below it, it does not.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PluginDatabaseClient } from '../../src/core/plugins/plugin-storage.js'
import { MAIL_MIGRATIONS, MailDatabase } from '../../src/integrations/mail/db.js'
import { MailSortEngine } from '../../src/integrations/mail/sort-engine.js'
import { previewMany, withCandidate } from '../../src/integrations/mail/sort-preview.js'
import { MailStore } from '../../src/integrations/mail/store.js'

const FERRY = 'ferry:robin.harbour@ferry.example.invalid'
const MARINA = 'marina:robin@marina.example.invalid'
const PAIRS = [{ accountId: FERRY, mailboxId: 'INBOX' }, { accountId: MARINA, mailboxId: 'INBOX' }]
const NOW = 1_790_000_000_000

let dir: string
let client: PluginDatabaseClient
let db: MailDatabase
let store: MailStore
let engine: MailSortEngine

/** Ferry-shaped rows: 20 Change Desk "Action Required" (2 with recipients), 3 other Change Desk, fillers. */
function rows(): unknown[][] {
  const out: unknown[][] = []
  const me = { name: 'Harbour, Robin' }
  const push = (account: string, i: number, from: string, name: string, subject: string, extra: Record<string, unknown> = {}) => {
    out.push([account, `INBOX:31:${i}`, `<r${i}@fixture.example.invalid>`, 'INBOX', from, subject, NOW - i * 60_000,
      JSON.stringify({ from: { address: from, name }, ...extra }), i % 3 === 0 ? 1 : 0])
  }
  for (let i = 0; i < 20; i += 1) {
    const to = i === 0 ? { to: [me] } : i === 1 ? { to: [{ name: 'crew-leads' }, { address: 'dock-team@' }] } : {}
    push(FERRY, 100 + i, '', 'Change Desk', `[Action Required] Change ${5500 + i} needs your approval`, to)
  }
  for (let i = 0; i < 3; i += 1) push(FERRY, 200 + i, '', 'Change Desk', `Change window ${i} closed`)
  for (let i = 0; i < 400; i += 1) push(FERRY, 1_000 + i, '', i % 2 ? 'Pier, Dana' : 'Brand Tide to Shore', `Note ${i}`)
  for (let i = 0; i < 400; i += 1) push(MARINA, 5_000 + i, 'noreply@builds.example.invalid', 'Build Robot', `Build ${i} passed`, { to: [{ address: 'robin@marina.example.invalid' }] })
  return out
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-sort-shadows-'))
  client = new PluginDatabaseClient(path.join(dir, 'plugin.sqlite'))
  await client.migrate(MAIL_MIGRATIONS)
  await client.run("INSERT INTO accounts (account_id, provider_id, display_name, address) VALUES (?, 'ferry', 'Harbour, Robin', '')", [FERRY])
  await client.run("INSERT INTO accounts (account_id, provider_id, display_name, address) VALUES (?, 'imap', 'Harbour, Robin', 'robin@marina.example.invalid')", [MARINA])
  for (const account of [FERRY, MARINA]) await client.run("INSERT INTO mailboxes (account_id, mailbox_id, name, role) VALUES (?, 'INBOX', 'Inbox', 'inbox')", [account])
  await client.run(
    'INSERT INTO messages (account_id, message_id, rfc_message_id, mailbox_id, from_addr, subject, sent_at, payload, seen, flags_json, updated_at)'
    + " SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]'),"
    + " json_extract(value, '$[4]'), json_extract(value, '$[5]'), json_extract(value, '$[6]'), json_extract(value, '$[7]'),"
    + " json_extract(value, '$[8]'), '[]', 0 FROM json_each(?)",
    [JSON.stringify(rows())],
  )
  db = new MailDatabase({ storage: { database: client } } as unknown as ConstructorParameters<typeof MailDatabase>[0])
  store = new MailStore(db)
  engine = new MailSortEngine({ store, dataDir: dir, watch: false })
  await engine.start()
  await engine.idle()
  const saved = await engine.saveRules({
    groups: [],
    rules: [{ id: 'r-00aa11', when: { from: 'Change Desk', subject: 'Action Required', account: FERRY }, then: 'Important', source: 'learned' }],
  }, engine.fileRev)
  expect(saved.ok).toBe(true)
  await engine.idle()
}, 60_000)

afterAll(async () => {
  engine?.dispose()
  await db?.dispose()
  fs.rmSync(dir, { recursive: true, force: true })
})

const everything = { when: { from: 'Change Desk', account: FERRY }, then: 'Notifications' }

describe('previewMany: shadows (C68)', () => {
  it('reports the earlier rule it overrides, with the number of mails it takes over', async () => {
    const [answer] = await previewMany({ sort: engine, store }, PAIRS, [everything])
    expect(answer!.matches).toBe(23)
    expect(answer!.shadows).toEqual([{ ruleId: 'r-00aa11', mails: 20, summary: expect.stringContaining('Change Desk') }])
  })

  it('reports no shadow when the new rule goes BELOW the earlier one ("Keep my earlier rule first")', async () => {
    const [answer] = await previewMany({ sort: engine, store }, PAIRS, [everything], { insertAt: 1 })
    expect(answer!.shadows).toEqual([])
    expect(answer!.matches).toBe(23)
  })

  it('splices the candidate at insertAt among the enabled rules', () => {
    const rules = engine.compiledRules()
    expect(withCandidate(rules, everything, 0).map((rule) => rule.id)).toEqual(['candidate', 'r-00aa11'])
    expect(withCandidate(rules, everything, 1).map((rule) => rule.id)).toEqual(['r-00aa11', 'candidate'])
  })
})

describe('previewMany: matches, moves, samples, recipients (C69)', () => {
  it('counts moves against the stored group and lists movers first, newest first, at most five', async () => {
    const [answer] = await previewMany({ sort: engine, store }, PAIRS, [everything])
    // The three plain Change Desk mails are in the sender's own group, the twenty Action Required ones
    // in Important: all move.
    expect(answer!.moves).toBe(23)
    expect(answer!.samples).toHaveLength(5)
    const at = answer!.samples.map((one) => one.at)
    expect([...at].sort((a, b) => b - a)).toEqual(at)
    expect(answer!.samples[0]).toMatchObject({ accountId: FERRY, sender: 'Change Desk', currentGroup: 'important' })
  })

  it('Not important moves nothing that is already out of Important', async () => {
    const [answer] = await previewMany({ sort: engine, store }, PAIRS, [{ when: { from: 'noreply@builds.example.invalid' }, then: 'Not important' }])
    expect(answer).toMatchObject({ matches: 400, moves: 0 })
    expect(answer!.samples.every((one) => one.currentGroup === 's:noreply@builds.example.invalid')).toBe(true)
  })

  it('Not important moves only the mail in Important, and still shadows the rule that put it there', async () => {
    const [answer] = await previewMany({ sort: engine, store }, PAIRS, [{ when: { from: 'Change Desk', account: FERRY }, then: 'Not important' }])
    expect(answer).toMatchObject({ matches: 23, moves: 20 })
    expect(answer!.shadows).toEqual([{ ruleId: 'r-00aa11', mails: 20, summary: expect.stringContaining('Change Desk') }])
  })

  it('a rule naming a renamed group resolves to that group, so mail already there does not move', async () => {
    const [before] = await previewMany({ sort: engine, store }, PAIRS, [{ when: { from: 'noreply@builds.example.invalid' }, then: 'CI runs' }])
    expect(before).toMatchObject({ matches: 400, moves: 400 })
    const renamed = await engine.renameGroup('s:noreply@builds.example.invalid', 'CI runs')
    expect(renamed.ok).toBe(true)
    const [after] = await previewMany({ sort: engine, store }, PAIRS, [{ when: { from: 'noreply@builds.example.invalid' }, then: 'CI runs' }])
    expect(after).toMatchObject({ matches: 400, moves: 0 })
  })

  it('says how many of the sender\'s mails carry recipients when the rule uses addressedToMe', async () => {
    const [answer] = await previewMany({ sort: engine, store }, PAIRS, [{ when: { from: 'Change Desk', account: FERRY, addressedToMe: false }, then: 'Notifications' }])
    expect(answer!.recipientsKnown).toEqual({ known: 2, of: 23 })
    expect(answer!.matches).toBe(1)
  })

  it('stops at its budget with partial: true, and yields the event loop between batches', async () => {
    let ticks = 0
    let running = true
    const spin = () => { ticks += 1; if (running) setImmediate(spin) }
    setImmediate(spin)
    const [full] = await previewMany({ sort: engine, store }, PAIRS, [everything], { batch: 100 })
    running = false
    expect(full!.partial).toBeUndefined()
    expect(ticks).toBeGreaterThan(3)
    const [cut] = await previewMany({ sort: engine, store }, PAIRS, [everything], { batch: 100, budgetMs: 0 })
    expect(cut!.partial).toBe(true)
    expect(cut!.matches).toBeLessThanOrEqual(23)
  })
})
