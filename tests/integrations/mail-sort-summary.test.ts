/**
 * The morning digest in grouped mode (spec 9.3, C11 C93): "3 need you, a middle dot, 19 sorted into groups", the
 * Important unread listed one by one, one line per group, every number the cached one. With grouping
 * off the letter is exactly today's.
 */
import { describe, expect, it } from 'vitest'
import { MailDigest, renderDigest, renderGroupedDigest } from '../../src/integrations/mail/digest.js'

const MARINA = 'marina:robin@marina.example.invalid'
const FERRY = 'ferry:robin.harbour@ferry.example.invalid'
const NOW = 1_790_000_000_000
// The middle dot of the spec's headline, as an escape (non-ASCII test data stays escaped).
const DOT = '\u00b7'

function row(accountId: string, n: number, group: string | null, sender: string, subject: string) {
  return {
    rowid: n, account_id: accountId, message_id: `INBOX:1:${n}`, mailbox_id: 'INBOX', from_addr: '', subject,
    sent_at: NOW - n * 60_000, payload: JSON.stringify({ from: { name: sender, address: '' } }), sort_group: group,
  }
}

function digestWith(grouped: boolean) {
  const letters: Array<{ subject: string; markdown?: string; text?: string }> = []
  const rows = new Map<string, ReturnType<typeof row>[]>([
    [MARINA, [
      row(MARINA, 1, 'important', 'Carol Pier', 'Lunch on the quay Thursday?'),
      row(MARINA, 2, 'u:build-results', 'Build Robot', 'Build 301 passed'),
      row(MARINA, 3, null, 'Jo Quay', 'Re: slip 14 paperwork'),
      row(MARINA, 4, 'u:shopping', 'Shop Deals', 'Your weekend picks are here'),
    ]],
    [FERRY, [row(FERRY, 5, 'important', 'Pier, Dana', 'Can you cover the late crossing?'), row(FERRY, 6, 's:name:change desk', 'Change Desk', '[Action Required] Change 5500')]],
  ])
  const counts = [
    { account_id: MARINA, grp: 'important', total: 9, unread: 2 },
    { account_id: MARINA, grp: 'u:build-results', total: 40, unread: 11 },
    { account_id: MARINA, grp: 'u:shopping', total: 20, unread: 6 },
    { account_id: FERRY, grp: 'important', total: 5, unread: 1 },
    { account_id: FERRY, grp: 's:name:change desk', total: 30, unread: 2 },
  ]
  // The group rows: unread only, each with the label its mail stored (the model's words, or the sender).
  const unreadGroups = [
    { account_id: MARINA, grp: 'u:build-results', label: 'Build results', unread: 11 },
    { account_id: MARINA, grp: 'u:shopping', label: 'Shopping', unread: 6 },
    { account_id: FERRY, grp: 's:name:change desk', label: 'Change Desk', unread: 2 },
  ]
  const digest = new MailDigest({
    store: {
      tasks: { getMeta: async () => undefined, setMeta: async () => {}, unreadInboxMessages: async (accountId: string) => rows.get(accountId) ?? [] },
      unreadByAccount: async () => new Map([[MARINA, { total: 19, inbox: 19 }], [FERRY, { total: 3, inbox: 3 }]]),
      mailboxesByRole: async () => [{ account_id: MARINA, mailbox_id: 'INBOX' }, { account_id: FERRY, mailbox_id: 'INBOX' }],
      sort: { groupCounts: async () => counts, unreadGroups: async () => unreadGroups },
    } as never,
    events: { digestSent: () => {} } as never,
    letters: { send: async (input) => { letters.push(input); return { letterId: `letter-${letters.length}` } } },
    accounts: async () => [
      { accountId: MARINA, displayName: 'Marina', address: 'robin@marina.example.invalid', unreadInbox: 19 },
      { accountId: FERRY, displayName: 'Ferry', address: 'robin.harbour@ferry.example.invalid', unreadInbox: 3 },
    ] as never,
    config: { get: async () => ({}) as never },
    log: { debug: () => {}, info: () => {}, warn: () => {} },
    now: () => NOW,
    sort: {
      groupedOn: () => grouped,
      // A rename wins over the stored label, as the engine's labelOf does.
      labelOf: (id: string, stored?: string) => (id === 'u:shopping' ? 'Deals & shops' : stored ?? id),
    } as never,
  })
  return { digest, letters }
}

describe('renderGroupedDigest', () => {
  it('headlines need-you and sorted counts and gives each group one line', () => {
    const rendered = renderGroupedDigest(
      [{ accountId: MARINA, label: 'Marina', unread: 3, items: [{ sender: 'Carol Pier', subject: 'Lunch?', sentAt: NOW - 60_000 }] }],
      [{ label: 'Build results', unread: 11 }, { label: 'Deals & shops', unread: 8 }],
      NOW,
    )
    expect(rendered.subject).toBe(`Mail digest: 3 need you ${DOT} 19 sorted into groups`)
    expect(rendered.text).toBe(`3 need you ${DOT} 19 sorted into groups.`)
    expect(rendered.markdown).toContain('- **Carol Pier**: Lunch?')
    expect(rendered.markdown).toContain('- Build results: 11 unread')
    expect(rendered.markdown).toContain('- Deals &amp; shops: 8 unread')
    expect(rendered.unread).toBe(22)
  })

  it('says so when nothing needs the person but mail was sorted', () => {
    const rendered = renderGroupedDigest([], [{ label: 'Build results', unread: 4 }], NOW)
    expect(rendered.subject).toBe(`Mail digest: 0 need you ${DOT} 4 sorted into groups`)
    expect(rendered.markdown).toContain('Nothing needs you.')
  })
})

describe('MailDigest with grouping on and off (C93)', () => {
  it('grouped: lists only Important unread one by one, and one line per group', async () => {
    const { digest, letters } = digestWith(true)
    const result = await digest.sendNow()
    expect(result.letterId).toBe('letter-1')
    const letter = letters[0]!
    expect(letter.subject).toBe(`Mail digest: 3 need you ${DOT} 19 sorted into groups`)
    expect(letter.markdown).toContain('Carol Pier')
    expect(letter.markdown).toContain('Jo Quay')
    expect(letter.markdown).toContain('Pier, Dana')
    // Mail in a group is counted on its group's line, never listed one by one.
    expect(letter.markdown).not.toContain('Build 301 passed')
    expect(letter.markdown).not.toContain('Your weekend picks')
    expect(letter.markdown).not.toContain('Change 5500')
    const lines = letter.markdown!.split('\n').filter((line) => /^- [^*]/.test(line))
    expect(lines).toEqual(['- Build results: 11 unread', '- Deals &amp; shops: 6 unread', '- Change Desk: 2 unread'])
  })

  it('off: the letter is today\'s (provider counts, every unread row listed)', async () => {
    const { digest, letters } = digestWith(false)
    await digest.sendNow()
    const letter = letters[0]!
    expect(letter.subject).toBe('Mail digest: 22 unread across 2 accounts')
    expect(letter.markdown).toContain('Build Robot')
    expect(letter.markdown).not.toContain('sorted into groups')
    expect(renderDigest([], NOW).subject).toBe('Mail digest: 0 unread across 0 accounts')
  })
})
