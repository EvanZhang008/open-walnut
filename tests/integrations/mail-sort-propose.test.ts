/**
 * Rule propose (spec 6.4, 6.5, C27 C28 C58 C69): local drafts for one correction, their numbers, and
 * the model step through an injected `RuleModel` (canned, invalid, down), over a real database.
 *
 * The complaint the direct / not-direct drafts exist for: Change Desk sends "Action Required" to a
 * group alias most days and to Robin himself now and then; only the second one matters. Outlook rows
 * mostly carry no recipients at all, so the draft is offered only where this mail's recipients are
 * known, and the card says how many of the sender's mails Walnut can judge.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PluginDatabaseClient } from '../../src/core/plugins/plugin-storage.js'
import { MAIL_MIGRATIONS, MailDatabase } from '../../src/integrations/mail/db.js'
import { MailSortEngine } from '../../src/integrations/mail/sort-engine.js'
import { previewMany } from '../../src/integrations/mail/sort-preview.js'
import { localDrafts, messageLabel, propose, senderWhen } from '../../src/integrations/mail/sort-propose.js'
import type { RuleModel } from '../../src/integrations/mail/sort-rule-model.js'
import { subjectFragment } from '../../src/integrations/mail/sort-subject-fragment.js'
import type { SortFeatures } from '../../src/integrations/mail/sort-types.js'
import { MailStore } from '../../src/integrations/mail/store.js'

const FERRY = 'ferry:robin.harbour@ferry.example.invalid'
const MARINA = 'marina:robin@marina.example.invalid'
const NOW = 1_790_000_000_000
const NEWEST = 'INBOX:31:100'
const ALIASED = 'INBOX:31:101'
const OLDEST = 'INBOX:31:119'

let dir: string
let client: PluginDatabaseClient
let db: MailDatabase
let store: MailStore
let engine: MailSortEngine

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-sort-propose-'))
  client = new PluginDatabaseClient(path.join(dir, 'plugin.sqlite'))
  await client.migrate(MAIL_MIGRATIONS)
  await client.run("INSERT INTO accounts (account_id, provider_id, display_name, address) VALUES (?, 'ferry', 'Harbour, Robin', '')", [FERRY])
  await client.run("INSERT INTO accounts (account_id, provider_id, display_name, address) VALUES (?, 'imap', 'Harbour, Robin', 'robin@marina.example.invalid')", [MARINA])
  for (const account of [FERRY, MARINA]) await client.run("INSERT INTO mailboxes (account_id, mailbox_id, name, role) VALUES (?, 'INBOX', 'Inbox', 'inbox')", [account])
  const rows: unknown[][] = []
  for (let i = 0; i < 20; i += 1) {
    const to = i === 0 ? { to: [{ name: 'Harbour, Robin' }] } : i === 1 ? { to: [{ name: 'crew-leads' }, { address: 'dock-team@' }] } : {}
    rows.push([FERRY, `INBOX:31:${100 + i}`, `<change-${5500 + i}@fixture.example.invalid>`, 'INBOX', '',
      `[Action Required] Change ${5500 + i} needs your approval`, NOW - i * 3_600_000, JSON.stringify({ from: { address: '', name: 'Change Desk' }, ...to }), 0])
  }
  rows.push([MARINA, 'INBOX:21:1', '<same-name@fixture.example.invalid>', 'INBOX', 'desk@change.example.invalid', 'A mail from a namesake', NOW,
    JSON.stringify({ from: { address: 'desk@change.example.invalid', name: 'Change Desk' }, to: [{ address: 'robin@marina.example.invalid' }] }), 0])
  await client.run(
    'INSERT INTO messages (account_id, message_id, rfc_message_id, mailbox_id, from_addr, subject, sent_at, payload, seen, flags_json, updated_at)'
    + " SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]'),"
    + " json_extract(value, '$[4]'), json_extract(value, '$[5]'), json_extract(value, '$[6]'), json_extract(value, '$[7]'),"
    + " json_extract(value, '$[8]'), '[]', 0 FROM json_each(?)",
    [JSON.stringify(rows)],
  )
  db = new MailDatabase({ storage: { database: client } } as unknown as ConstructorParameters<typeof MailDatabase>[0])
  store = new MailStore(db)
  engine = new MailSortEngine({ store, dataDir: dir, watch: false })
  await engine.start()
  await engine.idle()
}, 60_000)

afterAll(async () => {
  engine?.dispose()
  await db?.dispose()
  fs.rmSync(dir, { recursive: true, force: true })
})

const canned: RuleModel = async (input) => JSON.stringify({ when: { from: input.mail.fromAddr || input.mail.fromName, addressedToMe: false }, then: input.target })
const down: RuleModel = async () => { throw new Error('no provider configured') }
const invalid: RuleModel = async () => 'I would sort these by sender.'
const run = (messageId: string, extra: Partial<Parameters<typeof propose>[1]> = {}, ruleModel: RuleModel = down) =>
  propose({ store, sort: engine, ruleModel }, { accountId: FERRY, messageId, target: 'Notifications', scope: { role: 'inbox' }, ...extra })

describe('local drafts', () => {
  it('orders direct / not-direct (this mail first), then sender-subject, sender, message (C58)', async () => {
    const answer = await run(NEWEST)
    if ('notFound' in answer) throw new Error('missing row')
    expect(answer.drafts.map((one) => one.kind)).toEqual(['sender-direct', 'sender-not-direct', 'sender-subject', 'sender', 'message'])
    expect(answer.drafts[0]!.when).toEqual({ from: 'Change Desk', account: FERRY, addressedToMe: true })
    expect(answer.drafts[2]!.when).toEqual({ from: 'Change Desk', account: FERRY, subject: 'Action Required' })
    expect(answer.recipients).toEqual({ thisMail: 'known', known: 2, of: 20 })
    const aliased = await run(ALIASED)
    if ('notFound' in aliased) throw new Error('missing row')
    expect(aliased.drafts.slice(0, 2).map((one) => one.kind)).toEqual(['sender-not-direct', 'sender-direct'])
  })

  it('offers no recipient drafts for a mail whose recipients are unknown (the old Outlook row)', async () => {
    const answer = await run(OLDEST)
    if ('notFound' in answer) throw new Error('missing row')
    expect(answer.drafts.map((one) => one.kind)).toEqual(['sender-subject', 'sender', 'message'])
    expect(answer.recipients.thisMail).toBe('unknown')
  })

  it('a display-name condition names the account, so a namesake elsewhere is not caught', async () => {
    const answer = await run(NEWEST)
    if ('notFound' in answer) throw new Error('missing row')
    const sender = answer.drafts.find((one) => one.kind === 'sender')!
    expect(sender.when).toEqual({ from: 'Change Desk', account: FERRY })
    expect(sender.matches).toBe(20)
    expect(senderWhen({ fromAddr: 'desk@change.example.invalid', fromName: 'Change Desk', accountId: MARINA })).toEqual({ from: 'desk@change.example.invalid' })
  })

  it('the message draft carries a readable label and "Only this mail"', async () => {
    const answer = await run(NEWEST)
    if ('notFound' in answer) throw new Error('missing row')
    const message = answer.drafts.find((one) => one.kind === 'message')!
    expect(message.when).toEqual({ message: '<change-5500@fixture.example.invalid>' })
    expect(message.summary).toBe('Only this mail')
    expect(message.label).toMatch(/^Only the mail "\[Action Required\] Change 5500 needs your approval" from Change Desk, [A-Z][a-z]{2} \d{1,2}$/)
    expect(messageLabel('x'.repeat(80), 'Pier, Dana', NOW)).toContain(`"${'x'.repeat(60)}..."`)
  })

  it('every draft\'s numbers are the preview\'s numbers for the same condition', async () => {
    const answer = await run(NEWEST)
    if ('notFound' in answer) throw new Error('missing row')
    const previews = await previewMany({ sort: engine, store }, [{ accountId: FERRY, mailboxId: 'INBOX' }, { accountId: MARINA, mailboxId: 'INBOX' }],
      answer.drafts.map((one) => ({ when: one.when, then: one.then })))
    expect(answer.drafts.map((one) => [one.matches, one.moves])).toEqual(previews.map((one) => [one.matches, one.moves]))
  })

  it('writes nothing', async () => {
    const before = engine.fileRev
    await run(NEWEST, { note: 'sent to a group alias' }, canned)
    expect(engine.fileRev).toBe(before)
    expect(fs.existsSync(path.join(dir, 'sort-rules.yaml'))).toBe(false)
  })

  it('the subject fragment: tag text, or the longest run of words without numbers', () => {
    expect(subjectFragment('[Action Required] Change 5512 needs your approval')).toBe('Action Required')
    expect(subjectFragment('Re: Fwd: Ticket 8812 was assigned to you')).toBe('was assigned to you')
    expect(subjectFragment('Tidings Bulletin, issue 41')).toBe('Tidings Bulletin')
    expect(subjectFragment('Build 301 passed')).toBeUndefined()
    expect(localDrafts({ accountId: FERRY, rfcMessageId: '', fromAddr: '', fromName: '', subject: 'x', hasListUnsubscribe: false,
      addressedToMe: 'unknown', onlyCc: 'unknown', senderKind: 'unknown', correspondent: false } as SortFeatures, { subject: 'x', at: NOW, messageRfcId: '' })).toEqual([])
  })
})

describe('the model step', () => {
  it('canned: a from-your-note draft whose numbers equal the preview of the same condition (C27)', async () => {
    const answer = await run(ALIASED, { note: 'sent to a group alias' }, canned)
    if ('notFound' in answer) throw new Error('missing row')
    expect(answer.model.status).toBe('ok')
    expect(answer.model.draft!.when).toEqual({ from: 'Change Desk', addressedToMe: false })
    const [preview] = await previewMany({ sort: engine, store }, [{ accountId: FERRY, mailboxId: 'INBOX' }, { accountId: MARINA, mailboxId: 'INBOX' }],
      [{ when: { from: 'Change Desk', addressedToMe: false }, then: 'Notifications' }])
    expect(answer.model.draft!.matches).toBe(preview!.matches)
  })

  it('down, invalid, no note, and model:false keep the local drafts (C28)', async () => {
    for (const [model, status] of [[down, 'unavailable'], [invalid, 'invalid']] as const) {
      const answer = await run(NEWEST, { note: 'sent to a group alias' }, model)
      if ('notFound' in answer) throw new Error('missing row')
      expect(answer.model.status).toBe(status)
      expect(answer.drafts.length).toBe(5)
    }
    const quiet = await run(NEWEST, { note: '   ' }, canned)
    if ('notFound' in quiet) throw new Error('missing row')
    expect(quiet.model.status).toBe('skipped')
    const local = await run(NEWEST, { note: 'sent to a group alias', model: false }, canned)
    if ('notFound' in local) throw new Error('missing row')
    expect(local.model.status).toBe('skipped')
  })

  it('an unknown-recipients mail answers recipients-unknown when the model used addressedToMe (C30)', async () => {
    const answer = await run(OLDEST, { note: 'sent to a group alias' }, canned)
    if ('notFound' in answer) throw new Error('missing row')
    expect(answer.model).toEqual({ status: 'invalid', reason: 'recipients-unknown' })
  })

  it('answers notFound for a mail the cache does not hold', async () => {
    expect(await run('INBOX:31:999')).toEqual({ notFound: true })
  })
})

describe('account labels', () => {
  it('a display name two accounts share is told apart by the address; with no address the name stays', () => {
    // Both accounts are "Harbour, Robin": "Mail in Harbour, Robin can't be moved" would name both.
    expect(engine.accountLabel(MARINA)).toBe('robin@marina.example.invalid')
    expect(engine.accountLabel(FERRY)).toBe('Harbour, Robin')
    expect(engine.summarize({ when: { account: MARINA, from: 'desk@change.example.invalid' }, then: 'Notifications' }))
      .toContain('robin@marina.example.invalid')
  })
})

describe('folder rows', () => {
  it('a folder listed for an account that is gone writes no row; one that exists is updated', async () => {
    // A folder list in flight when the human deleted the account (mail-sync.test.ts drives the race).
    await store.upsertMailbox({ accountId: 'gone:robin@gone.example.invalid', mailboxId: 'Projects', name: 'Projects', role: 'other', unread: 2, total: 9 })
    expect(await client.all("SELECT mailbox_id FROM mailboxes WHERE account_id = 'gone:robin@gone.example.invalid'")).toEqual([])
    await store.upsertMailbox({ accountId: MARINA, mailboxId: 'INBOX', name: 'Inbox', role: 'inbox', unread: 4, total: 40 })
    expect(await client.all('SELECT unread, total FROM mailboxes WHERE account_id = ? AND mailbox_id = ?', [MARINA, 'INBOX'])).toEqual([{ unread: 4, total: 40 }])
  })
})
