/**
 * The grouping fixture reproduces the measured shapes (spec 14.1, C84), checked by the classifier
 * itself: every named row gets the built-in verdict the table says (the fallback for mail no model has
 * labeled), and the dense set holds the real proportions (within 3 points), the Outlook recipients
 * pattern (about 56% of the newest 100, almost none older), the prolific non-person names (names with
 * 3 or more mails cover about 90%), and at least 1,200 unread automated mails for the bulk cases.
 */
import { describe, expect, it, vi } from 'vitest'
import { BUILTIN_RULES, classify } from '../../src/integrations/mail/sort-classify.js'
import { correspondentKeysOf, featuresOf, identityOf } from '../../src/integrations/mail/sort-features.js'

type FixtureRow = {
  accountId: string; messageId: string; mailboxId: string; rfcMessageId: string; subject: string; sentAt: number; unread: boolean
  from: { name?: string; address?: string }; to?: Array<{ name?: string; address?: string }>; cc?: unknown[]
  listUnsubscribe?: unknown; bulkHeaders?: unknown; category?: 'promotions' | 'social'; kind?: string
}

async function load(env: Record<string, string>): Promise<{ set: any; dense: any }> {
  const saved = { PW_MAIL_GROUPS: process.env.PW_MAIL_GROUPS, PW_MAIL_GROUPS_DENSE: process.env.PW_MAIL_GROUPS_DENSE }
  Object.assign(process.env, env)
  // A fresh module and a fresh shared state per set (the state lives on globalThis by design).
  delete (globalThis as Record<symbol, unknown>)[Symbol.for('walnut.mailGroupsFixture')]
  vi.resetModules()
  try {
    const set = await import('../e2e/browser/fixtures/mail-fixture-provider/groups-set.mjs')
    const dense = await import('../e2e/browser/fixtures/mail-fixture-provider/groups-dense.mjs')
    set.groupsMessages()
    return { set, dense }
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

/** The verdict the real classifier gives one fixture row (built-in rules only). */
function verdictOf(set: any, row: FixtureRow, correspondents: Map<string, Set<string>>): { group: string; reason: string } {
  const account = row.accountId === set.MARINA ? { address: set.MARINA_ADDRESS, displayName: set.OWN_NAME } : { address: set.FERRY_ADDRESS, displayName: set.OWN_NAME }
  const payload = { from: row.from, ...(row.to ? { to: row.to } : {}), ...(row.cc ? { cc: row.cc } : {}),
    ...(row.listUnsubscribe ? { listUnsubscribe: row.listUnsubscribe } : {}), ...(row.bulkHeaders ? { bulkHeaders: row.bulkHeaders } : {}) }
  const features = featuresOf(
    { account_id: row.accountId, rfc_message_id: row.rfcMessageId, from_addr: (row.from.address ?? '').toLowerCase(), subject: row.subject },
    payload as never, row.category ? { gmailCategory: row.category } : undefined,
    identityOf(account, row.accountId === set.MARINA), correspondents.get(row.accountId),
  )
  const { group, reason } = classify(features, [])
  return { group, reason }
}

function correspondentsOf(set: any): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  for (const [accountId, rows] of set.groupsMessages() as Map<string, FixtureRow[]>) {
    const keys = new Set<string>()
    for (const row of rows.filter((one) => one.mailboxId === 'Sent')) for (const key of correspondentKeysOf({ to: row.to } as never)) keys.add(key)
    out.set(accountId, keys)
  }
  return out
}

const share = (part: number, whole: number) => (100 * part) / whole

describe('PW_MAIL_GROUPS: the named rows and the small set', () => {
  it('every row of the spec table gets its expected built-in verdict, and the table covers every built-in', async () => {
    const { set } = await load({ PW_MAIL_GROUPS: '1', PW_MAIL_GROUPS_DENSE: '0' })
    const correspondents = correspondentsOf(set)
    const all = [...set.groupsMessages().values()].flat() as FixtureRow[]
    const wrong: string[] = []
    for (const [messageId, want] of Object.entries(set.EXPECTED_BUILTIN as Record<string, string>)) {
      const row = all.find((one) => one.messageId === messageId && one.mailboxId === 'INBOX')!
      const got = verdictOf(set, row, correspondents)
      const group = (set.IMPORTANT_BUILTINS as string[]).includes(want) ? 'important' : 'not-important'
      if (got.reason !== `builtin:${want}` || got.group !== group) wrong.push(`${messageId}: ${got.group} ${got.reason} (want ${group} builtin:${want})`)
    }
    expect(wrong).toEqual([])
    const covered = new Set(Object.values(set.EXPECTED_BUILTIN as Record<string, string>))
    expect([...covered].sort()).toEqual(BUILTIN_RULES.map((one) => one.reason.replace(/^builtin:/, '')).sort())
  })

  it('has 150+ inbox rows, ferry without any sender address, unread on both sides, Unicode names', async () => {
    const { set } = await load({ PW_MAIL_GROUPS: '1', PW_MAIL_GROUPS_DENSE: '0' })
    const correspondents = correspondentsOf(set)
    const inbox = ([...set.groupsMessages().values()].flat() as FixtureRow[]).filter((one) => one.mailboxId === 'INBOX')
    expect(inbox.length).toBeGreaterThanOrEqual(150)
    expect(inbox.filter((one) => one.accountId === set.FERRY).every((one) => !one.from.address)).toBe(true)
    const unreadBy = new Map<string, number>()
    for (const row of inbox) {
      if (!row.unread) continue
      const { group } = verdictOf(set, row, correspondents)
      unreadBy.set(group, (unreadBy.get(group) ?? 0) + 1)
    }
    for (const group of ['important', 'not-important']) expect(unreadBy.get(group) ?? 0).toBeGreaterThan(0)
    expect(inbox.some((one) => /[^\x00-\x7f]/.test(one.from.name ?? ''))).toBe(true)
    const ferry = inbox.filter((one) => one.accountId === set.FERRY).sort((a, b) => b.sentAt - a.sentAt)
    expect(share(ferry.slice(0, 100).filter((one) => one.to).length, 100)).toBeCloseTo(56, -1)
    const changeDesk = ferry.filter((one) => one.from.name === set.CHANGE_DESK)
    expect(changeDesk).toHaveLength(20)
    expect(changeDesk.filter((one) => one.to).map((one) => one.messageId).sort()).toEqual([set.ROW.changeDirect, set.ROW.changeAlias].sort())
  })
})

describe('PW_MAIL_GROUPS_DENSE: the measured proportions (C84)', () => {
  it('ferry: 49 / 23 / 23 / 5 within 3 points, recipients only on the newest rows, names concentrated', async () => {
    const { set, dense } = await load({ PW_MAIL_GROUPS: '0', PW_MAIL_GROUPS_DENSE: '1' })
    const rows = (set.groupsMessages().get(set.FERRY) as FixtureRow[]).filter((one) => one.kind)
    expect(rows).toHaveLength(1_500)
    for (const [kind, want] of Object.entries(dense.FERRY_SHARES as Record<string, number>)) {
      expect(Math.abs(share(rows.filter((one) => one.kind === kind).length, rows.length) - want)).toBeLessThanOrEqual(3)
    }
    const all = (set.groupsMessages().get(set.FERRY) as FixtureRow[]).sort((a, b) => b.sentAt - a.sentAt)
    expect(Math.abs(share(all.slice(0, 100).filter((one) => one.to).length, 100) - 56)).toBeLessThanOrEqual(3)
    expect(share(all.slice(100).filter((one) => one.to).length, all.length - 100)).toBeLessThanOrEqual(2)
    const orgs = rows.filter((one) => one.kind === 'orgName')
    const perName = new Map<string, number>()
    for (const row of orgs) perName.set(row.from.name!, (perName.get(row.from.name!) ?? 0) + 1)
    const covered = orgs.filter((one) => perName.get(one.from.name!)! >= 3).length
    expect(Math.abs(share(covered, orgs.length) - 90)).toBeLessThanOrEqual(3)
    const top = [...perName.values()].sort((a, b) => b - a).slice(0, 3)
    expect(top.every((count) => count >= 150)).toBe(true)
  })

  it('marina: 49 / 16 / 22 / 12 within 3 points, 1.5% list headers, 90% To Robin', async () => {
    const { set, dense } = await load({ PW_MAIL_GROUPS: '0', PW_MAIL_GROUPS_DENSE: '1' })
    const rows = (set.groupsMessages().get(set.MARINA) as FixtureRow[]).filter((one) => one.kind)
    expect(rows).toHaveLength(1_500)
    for (const [kind, want] of Object.entries(dense.MARINA_SHARES as Record<string, number>)) {
      expect(Math.abs(share(rows.filter((one) => one.kind === kind).length, rows.length) - want)).toBeLessThanOrEqual(3)
    }
    expect(Math.abs(share(rows.filter((one) => one.listUnsubscribe).length, rows.length) - dense.MARINA_LIST_HEADER_SHARE)).toBeLessThanOrEqual(1)
    const toMe = rows.filter((one) => one.to?.some((entry) => entry.address === set.MARINA_ADDRESS)).length
    expect(Math.abs(share(toMe, rows.length) - dense.MARINA_TO_ME_SHARE)).toBeLessThanOrEqual(3)
    const brands = rows.filter((one) => one.kind === 'brandLocal')
    expect(Math.abs(share(brands.filter((one) => one.category === 'promotions').length, brands.length) - 33.3)).toBeLessThanOrEqual(3)
  })

  it('holds at least 1,200 unread automated mails across the two inboxes', async () => {
    const { set } = await load({ PW_MAIL_GROUPS: '0', PW_MAIL_GROUPS_DENSE: '1' })
    const correspondents = correspondentsOf(set)
    const inbox = ([...set.groupsMessages().values()].flat() as FixtureRow[]).filter((one) => one.mailboxId === 'INBOX')
    const automated = inbox.filter((one) => one.unread && verdictOf(set, one, correspondents).reason === 'builtin:transactional').length
    expect(automated).toBeGreaterThanOrEqual(1_200)
  })
})
