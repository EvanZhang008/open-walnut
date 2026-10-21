/**
 * The mail plugin's "New mail" trigger template (src/integrations/mail/trigger-template.ts)
 * against an in-memory stand-in for its cache.
 */
import { describe, it, expect } from 'vitest'
import { createMailTriggerTemplate } from '../../src/integrations/mail/trigger-template.js'
import type { MessageRow } from '../../src/integrations/mail/store.js'
import type { MailAccountDto } from '../../src/integrations/mail/contract.js'

const T0 = Date.parse('2026-10-21T08:00:00Z')

function row(over: Partial<MessageRow> & { message_id: string; account_id?: string; at: number }): MessageRow {
  const { at, ...rest } = over
  return {
    rowid: 1, account_id: 'imap:me', mailbox_id: 'INBOX', rfc_message_id: `<${over.message_id}>`, thread_id: null,
    from_addr: 'alice@example.com', subject: 'Hello', snippet: 'preview', sent_at: at, received_at: at,
    flags_json: null, attachments_json: null, body_ref: null, body_bytes: null, payload: null, updated_at: at,
    envelope_hash: null, body_error: null,
    ...rest,
  } as MessageRow
}

function setup(rows: MessageRow[]) {
  const accounts = [
    { accountId: 'imap:me', address: 'me@example.com', displayName: 'Me' },
    { accountId: 'imap:work', address: 'work@example.org', displayName: 'Work' },
  ] as MailAccountDto[]
  const listed: unknown[] = []
  const template = createMailTriggerTemplate({
    listAccounts: async () => accounts,
    store: {
      mailboxesByRole: async () => [
        { account_id: 'imap:me', mailbox_id: 'INBOX', unread: 0 },
        { account_id: 'imap:work', mailbox_id: 'INBOX', unread: 0 },
      ],
      listMessages: async (query) => {
        listed.push(query)
        const pairs = query.pairs ?? []
        return rows.filter((r) => pairs.some((p) => p.accountId === r.account_id && p.mailboxId === r.mailbox_id))
          .sort((a, b) => b.sent_at - a.sent_at)
      },
    },
  })
  return { template, listed }
}

describe('mail trigger template', () => {
  it('first run records a cursor and stays quiet, so arming never replays the inbox', async () => {
    const { template, listed } = setup([row({ message_id: 'm1', at: T0 - 60_000 })])
    const r = await template.check({}, { state: null, now: new Date(T0).toISOString() })
    expect(r).toEqual({ fire: false, state: { armedAt: T0, since: {} } })
    expect(listed).toHaveLength(0)
  })

  it('fires on mail newer than the cursor, oldest first, with sender, subject and preview', async () => {
    const { template } = setup([
      row({ message_id: 'old', at: T0 - 3_600_000 }),
      row({ message_id: 'b', at: T0 + 120_000, subject: 'Second' }),
      row({ message_id: 'a', at: T0 + 60_000, subject: 'First', payload: JSON.stringify({ from: { name: 'Alice', address: 'alice@example.com' } }) }),
    ])
    const r = await template.check({}, { state: { armedAt: T0, since: {} }, now: new Date(T0 + 300_000).toISOString() })
    expect(r.fire).toBe(true)
    expect(r.items?.map((i) => i.id)).toEqual(['imap:me/a', 'imap:me/b'])
    expect(r.items?.[0]).toMatchObject({ title: 'Alice: First', from: 'alice@example.com', subject: 'First', preview: 'preview' })
    expect(r.state).toEqual({ armedAt: T0, since: { 'imap:me': T0 + 120_000 } })
  })

  it('never fires mail from before it was armed, also on the run right after', async () => {
    const { template } = setup([row({ message_id: 'before', at: T0 - 10 * 60_000 })])
    const r = await template.check({}, { state: { armedAt: T0, since: {} }, now: new Date(T0 + 300_000).toISOString() })
    expect(r.fire).toBe(false)
    // The first state shape (one number, set at arming) reads the same way.
    const old = await template.check({}, { state: { since: T0 }, now: new Date(T0 + 300_000).toISOString() })
    expect(old.fire).toBe(false)
  })

  it('looks a little behind the cursor (late arrivals) and lets the daemon drop repeats by id', async () => {
    const H = 3_600_000
    const { template } = setup([row({ message_id: 'late', at: T0 + H - 10 * 60_000 })])
    const r = await template.check({}, { state: { armedAt: T0, since: { 'imap:me': T0 + H } }, now: new Date(T0 + H).toISOString() })
    expect(r.items?.map((i) => i.id)).toEqual(['imap:me/late'])
    expect(r.state).toEqual({ armedAt: T0, since: { 'imap:me': T0 + H } })
  })

  it('keeps one cursor per account, so an account that syncs late still fires', async () => {
    const H = 3_600_000
    const { template } = setup([
      row({ message_id: 'w1', account_id: 'imap:work', at: T0 + H }),
      row({ message_id: 'm9', at: T0 + 2 * H }),
    ])
    const r = await template.check({}, { state: { armedAt: T0, since: { 'imap:me': T0 + 3 * H } }, now: new Date(T0 + 3 * H).toISOString() })
    expect(r.items?.map((i) => i.id)).toEqual(['imap:work/w1'])
    expect(r.state).toEqual({ armedAt: T0, since: { 'imap:me': T0 + 3 * H, 'imap:work': T0 + H } })
  })

  it('a date in the future counts as now, so it cannot push the cursor past real mail', async () => {
    const now = T0 + 60_000
    const { template } = setup([row({ message_id: 'future', at: T0 + 365 * 86_400_000 })])
    const r = await template.check({}, { state: { armedAt: T0, since: {} }, now: new Date(now).toISOString() })
    expect(r.items?.[0]).toMatchObject({ id: 'imap:me/future', at: new Date(now).toISOString() })
    expect(r.state).toEqual({ armedAt: T0, since: { 'imap:me': now } })
  })

  it('with more new mail than one fire carries, sends the oldest and leaves the cursor at the last one sent', async () => {
    const rows = Array.from({ length: 60 }, (_, i) => row({ message_id: `n${i}`, at: T0 + (i + 1) * 1000 }))
    const { template } = setup(rows)
    const r = await template.check({}, { state: { armedAt: T0, since: {} }, now: new Date(T0 + 120_000).toISOString() })
    expect(r.items).toHaveLength(50)
    expect(r.items?.[0]?.id).toBe('imap:me/n0')
    expect(r.items?.[49]?.id).toBe('imap:me/n49')
    expect(r.state).toEqual({ armedAt: T0, since: { 'imap:me': T0 + 50_000 } })
  })

  it('filters by sender, subject and account', async () => {
    const rows = [
      row({ message_id: 'x1', at: T0 + 1, from_addr: 'receipts@shop.example', subject: 'Your Invoice 42' }),
      row({ message_id: 'x2', at: T0 + 2, from_addr: 'news@shop.example', subject: 'Sale' }),
      row({ message_id: 'x3', at: T0 + 3, account_id: 'imap:work', from_addr: 'receipts@shop.example', subject: 'invoice' }),
    ]
    const { template } = setup(rows)
    const state = { armedAt: T0, since: {} }
    const now = new Date(T0 + 10).toISOString()
    const bySender = await template.check({ from: 'RECEIPTS@' }, { state, now })
    expect(bySender.items?.map((i) => i.id)).toEqual(['imap:me/x1', 'imap:work/x3'])
    const bySubject = await template.check({ subject: 'invoice' }, { state, now })
    expect(bySubject.items?.map((i) => i.id)).toEqual(['imap:me/x1', 'imap:work/x3'])
    const oneAccount = await template.check({ account: 'imap:work' }, { state, now })
    expect(oneAccount.items?.map((i) => i.id)).toEqual(['imap:work/x3'])
    const none = await template.check({ from: 'nobody' }, { state, now })
    expect(none.fire).toBe(false)
    expect(none.state).toEqual({ armedAt: T0, since: { 'imap:me': T0 + 2, 'imap:work': T0 + 3 } })
  })

  it('prepare resolves an account by address and refuses one that does not exist', async () => {
    const { template } = setup([])
    const ok = await template.prepare({ account: 'work@example.org', from: 'boss@' })
    expect(ok.params).toEqual({ account: 'imap:work', from: 'boss@' })
    expect(ok.label).toBe('New mail from "boss@" in the work@example.org inbox')
    expect(ok.description).toContain('with its sender, subject and preview')
    expect(ok.description).not.toMatch(/every \d/)
    await expect(template.prepare({ account: 'nobody@example.com' })).rejects.toThrow(/No mail account "nobody@example.com"/)
    const all = await template.prepare({})
    expect(all.label).toBe('New mail in the inbox')
  })

  it('lists accounts as the choices for the account param', async () => {
    const { template } = setup([])
    expect(await template.options('account', 'work')).toEqual([{ value: 'imap:work', label: 'work@example.org', hint: 'Work' }])
    expect(await template.options('from', '')).toEqual([])
  })
})
