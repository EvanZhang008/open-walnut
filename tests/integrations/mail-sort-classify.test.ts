/**
 * The inbox classifier, pure: features (spec 5.1, 5.2), sender kind (5.3), the eight built-ins
 * (5.4), user rule conditions (5.5) and the why line (8.4).
 *
 * There are no built-in groups (design v2): a built-in only answers Important or Not important, the
 * fallback for mail the model has not labeled. A rule naming any other group sends mail to `u:<slug>`.
 *
 * Every fixture name and address is invented (`example.invalid`). The shapes, though, are the
 * real ones measured on a real cache: Outlook-shaped rows with no sender address and only display
 * names, recipients that are names without addresses, group aliases ending in `@`, and rows with
 * no recipients at all (which must never count as "not addressed to me").
 */
import { describe, expect, it } from 'vitest'
import {
  BUILTIN_REV, BUILTIN_RULES, classify, compileRules, globTest, groupIdForName, slugOf, whyOf,
} from '../../src/integrations/mail/sort-classify.js'
import { addressedToMeOf, featuresOf, identityOf, onlyCcOf, type AccountIdentity } from '../../src/integrations/mail/sort-features.js'
import { disambiguateLabels, senderKey, senderKindOf, senderLabel } from '../../src/integrations/mail/sort-sender.js'
import type { MessagePayload } from '../../src/integrations/mail/service-dto.js'
import { builtinSummaries, summarizeRule } from '../../src/integrations/mail/sort-rule-summary.js'
import type { Rule, SortFeatures } from '../../src/integrations/mail/sort-types.js'

const MARINA = 'imap:marina'
const FERRY = 'outlook:ferry'
/** IMAP-shaped account: every row has addresses, Cc is reported apart from To. */
const marinaMe = identityOf({ address: 'Robin@marina.example.invalid', displayName: 'Harbour, Robin' }, true)
/** Outlook-shaped account: To and Cc merged, senders often name-only. */
const ferryMe = identityOf({ address: 'robin@ferry.example.invalid', displayName: 'Harbour, Robin' }, false)

interface Shape {
  account?: string
  from?: string
  name?: string
  to?: MessagePayload['to']
  cc?: MessagePayload['cc']
  subject?: string
  listUnsubscribe?: MessagePayload['listUnsubscribe']
  bulkHeaders?: MessagePayload['bulkHeaders']
  gmailCategory?: 'promotions' | 'social'
  correspondents?: string[]
  rfc?: string
}

function features(shape: Shape): SortFeatures {
  const account = shape.account ?? MARINA
  const me: AccountIdentity = account === FERRY ? ferryMe : marinaMe
  const payload: MessagePayload = {
    from: { address: shape.from ?? '', ...(shape.name ? { name: shape.name } : {}) },
    ...(shape.to ? { to: shape.to } : {}),
    ...(shape.cc ? { cc: shape.cc } : {}),
    ...(shape.listUnsubscribe ? { listUnsubscribe: shape.listUnsubscribe } : {}),
    ...(shape.bulkHeaders ? { bulkHeaders: shape.bulkHeaders } : {}),
  }
  return featuresOf(
    { account_id: account, rfc_message_id: shape.rfc ?? '<m1@example.invalid>', from_addr: shape.from ?? '', subject: shape.subject ?? 'Hello' },
    payload,
    shape.gmailCategory ? { gmailCategory: shape.gmailCategory } : undefined,
    me,
    shape.correspondents ? new Set(shape.correspondents) : undefined,
  )
}

const toMe = [{ address: 'robin@marina.example.invalid' }]
const toMeByName = [{ name: 'Harbour, Robin', address: '' }]

function groupOf(shape: Shape, rules: Rule[] = []): { group: string; reason: string } {
  const result = classify(features(shape), compileRules(rules))
  return { group: result.group, reason: result.reason }
}

describe('addressedToMe (spec 5.2)', () => {
  it('matches the account address, case-insensitively', () => {
    expect(addressedToMeOf([{ address: 'ROBIN@marina.example.invalid' }], undefined, marinaMe)).toBe(true)
  })
  it('matches a display-name-only recipient against the account display name', () => {
    expect(addressedToMeOf(toMeByName, undefined, ferryMe)).toBe(true)
    expect(addressedToMeOf([{ name: '  harbour,   ROBIN ', address: '' }], undefined, ferryMe)).toBe(true)
  })
  it('matches a display name that arrived in the address slot', () => {
    expect(addressedToMeOf([{ address: 'Harbour, Robin' }], undefined, ferryMe)).toBe(true)
  })
  it('is unknown when the row has no recipients at all (never false)', () => {
    expect(addressedToMeOf(undefined, undefined, ferryMe)).toBe('unknown')
    expect(addressedToMeOf([], [], ferryMe)).toBe('unknown')
  })
  it('is false for mail sent only to group aliases (a bare name and one ending in @)', () => {
    expect(addressedToMeOf([{ name: 'crew-leads', address: '' }, { address: 'dock-team@' }], undefined, ferryMe)).toBe(false)
  })
  it('is unknown when the account has no identity at all', () => {
    expect(addressedToMeOf(toMe, undefined, identityOf({}, true))).toBe('unknown')
  })
  it('counts Cc recipients too', () => {
    expect(addressedToMeOf([{ address: 'crew@marina.example.invalid' }], toMe, marinaMe)).toBe(true)
  })
})

describe('onlyCc', () => {
  it('is true when I am in Cc and not in To (provider separates them)', () => {
    expect(onlyCcOf([{ address: 'crew@marina.example.invalid' }], toMe, marinaMe)).toBe(true)
  })
  it('is false when I am in To', () => {
    expect(onlyCcOf(toMe, toMe, marinaMe)).toBe(false)
  })
  it('is false with no Cc list on a provider that reports Cc separately', () => {
    expect(onlyCcOf([{ address: 'crew@marina.example.invalid' }], undefined, marinaMe)).toBe(false)
  })
  it('is unknown where To and Cc are merged (Outlook shape)', () => {
    expect(onlyCcOf(toMeByName, undefined, ferryMe)).toBe('unknown')
  })
  it('is unknown with no recipients', () => {
    expect(onlyCcOf(undefined, undefined, marinaMe)).toBe('unknown')
  })
})

describe('senderKind (spec 5.3)', () => {
  const kind = (fromAddr: string, fromName = '', extra: Partial<Parameters<typeof senderKindOf>[0]> = {}) =>
    senderKindOf({ fromAddr, fromName, ...extra })

  it('0: the provider category wins over everything', () => {
    expect(kind('carol.pier@friend.example.invalid', '', { gmailCategory: 'promotions' })).toBe('bulk')
    expect(kind('carol.pier@friend.example.invalid', '', { gmailCategory: 'social' })).toBe('transactional')
  })
  it('1a: marketing local parts (prefix words included)', () => {
    for (const local of ['hello', 'news', 'newsletter', 'newsletter-weekly', 'marketing', 'promo', 'promotions', 'offers', 'deals', 'info', 'digest', 'updates']) {
      expect(kind(`${local}@shop.example.invalid`)).toBe('bulk')
    }
  })
  it('1b: automated-notice local parts, and any local part containing noreply', () => {
    for (const local of ['no-reply', 'noreply', 'no.reply', 'donotreply', 'do-not-reply', 'do_not_reply', 'notifications',
      'notification', 'notify', 'alerts', 'alert', 'mailer-daemon', 'postmaster', 'bounces', 'issues', 'tickets',
      'statements', 'receipts', 'orders', 'calendar', 'invites', 'security', 'support', 'help', 'service', 'team',
      'admin', 'account', 'accounts', 'survey', 'feedback', 'noreply-oncall-notifications']) {
      expect(kind(`${local}@example.invalid`)).toBe('transactional')
    }
  })
  it('1a comes before 1b, and 1b before a marketing subdomain', () => {
    expect(kind('news@notifications.shop.example.invalid')).toBe('bulk')
    expect(kind('noreply@em.shop.example.invalid')).toBe('transactional')
  })
  it('2: marketing and notice subdomains, only as the first of three or more labels', () => {
    for (const sub of ['digital', 'email', 'e', 'em', 'mail', 'mkt', 'news', 'info', 'hello', 'mailer', 'reply', 'bounce']) {
      expect(kind(`tidewear@${sub}.shop.example.invalid`)).toBe('bulk')
    }
    expect(kind('tidewear@notifications.shop.example.invalid')).toBe('transactional')
    expect(kind('tidewear@alerts.shop.example.invalid')).toBe('transactional')
    expect(kind('carol@mail-host.invalid')).toBe('unknown')
    expect(kind('carol@mail.invalid')).toBe('unknown')
  })
  it('3: Precedence bulk/list/junk and Auto-Submitted beat a person-shaped address', () => {
    expect(kind('carol.pier@friend.example.invalid', '', { precedence: 'bulk' })).toBe('bulk')
    expect(kind('carol.pier@friend.example.invalid', '', { precedence: 'LIST' })).toBe('bulk')
    expect(kind('carol.pier@friend.example.invalid', '', { precedence: 'junk' })).toBe('bulk')
    expect(kind('carol.pier@friend.example.invalid', '', { autoSubmitted: 'auto-generated' })).toBe('transactional')
    expect(kind('carol.pier@friend.example.invalid', '', { autoSubmitted: 'no' })).toBe('person')
  })
  it('4: display-name-only senders', () => {
    expect(kind('', 'Weekly Newsletter')).toBe('bulk')
    expect(kind('', 'Harbour Deals')).toBe('bulk')
    expect(kind('', 'payroll')).toBe('transactional')
    expect(kind('', 'Survey Desk')).toBe('transactional')
    expect(kind('', 'System Alerts')).toBe('transactional')
    expect(kind('', 'Ferry Notifications')).toBe('transactional')
    expect(kind('', 'Do Not Reply')).toBe('transactional')
    expect(kind('', 'Brand Tide to Shore')).toBe('unknown')
    expect(kind('', 'Change Desk')).toBe('unknown')
    expect(kind('', 'Robin Harbour')).toBe('unknown')
  })
  it('4 does not apply when the row has an address', () => {
    expect(kind('tidewear@shop.example.invalid', 'payroll')).toBe('unknown')
  })
  it('5: a `Last, First` display name is a person, Unicode included', () => {
    expect(kind('', 'Pier, Dana')).toBe('person')
    expect(kind('', 'Harbour, Robin')).toBe('person')
    expect(kind('', '\u00d8st, \u00c5se')).toBe('person')
    expect(kind('', 'Van Pier, Dana Lee')).toBe('person')
    expect(kind('', 'pier, dana')).toBe('unknown')
  })
  it('6: a first.last local part is a person; one word is not decided', () => {
    expect(kind('carol.pier@friend.example.invalid')).toBe('person')
    expect(kind('carol_pier@friend.example.invalid')).toBe('person')
    expect(kind('carol-m-pier@friend.example.invalid')).toBe('person')
    expect(kind('a.b.c.d@friend.example.invalid')).toBe('unknown')
    expect(kind('carol2.pier@friend.example.invalid')).toBe('unknown')
    expect(kind('carol@friend.example.invalid')).toBe('unknown')
    expect(kind('harbourclub@club.example.invalid')).toBe('unknown')
  })
})

describe('built-in rules (spec 5.4)', () => {
  it('has eight built-ins, in order, at revision 3', () => {
    expect(BUILTIN_REV).toBe(3)
    expect(BUILTIN_RULES.map((rule) => rule.id)).toEqual([
      'b-correspondent', 'b-bulk', 'b-transactional', 'b-list', 'b-group-alias', 'b-direct', 'b-person', 'b-unknown',
    ])
  })
  it('b-correspondent needs addressedToMe=true', () => {
    const who = ['tidewear@shop.example.invalid']
    expect(groupOf({ from: who[0], to: toMe, correspondents: who })).toEqual({ group: 'important', reason: 'builtin:correspondent' })
    expect(groupOf({ from: who[0], correspondents: who })).toEqual({ group: 'not-important', reason: 'builtin:unsure' })
  })
  it('b-transactional beats b-list (a statement with List-Unsubscribe is a notice)', () => {
    expect(groupOf({ from: 'statements@bank.example.invalid', to: toMe, listUnsubscribe: { oneClick: true, https: ['https://bank.example.invalid/u'] } }))
      .toEqual({ group: 'not-important', reason: 'builtin:transactional' })
  })
  it('b-list catches an unplaced sender that carries list headers', () => {
    expect(groupOf({ from: 'tidewear@shop.example.invalid', listUnsubscribe: { oneClick: false, listId: 'Tide.List.example.invalid' } }))
      .toEqual({ group: 'not-important', reason: 'builtin:list' })
    expect(groupOf({ from: 'tidewear@shop.example.invalid', listUnsubscribe: { oneClick: false, mailto: ['u@shop.example.invalid'] } }).reason)
      .toBe('builtin:list')
  })
  it('b-group-alias, b-direct and b-person split people by what the recipients say', () => {
    expect(groupOf({ from: 'carol.pier@friend.example.invalid', to: [{ address: 'crew@marina.example.invalid' }] }))
      .toEqual({ group: 'not-important', reason: 'builtin:group-alias' })
    expect(groupOf({ from: 'carol.pier@friend.example.invalid', to: toMe })).toEqual({ group: 'important', reason: 'builtin:direct' })
    expect(groupOf({ from: 'carol.pier@friend.example.invalid' })).toEqual({ group: 'important', reason: 'builtin:person' })
  })
  it('an unknown sender is never Important, whatever the recipients, and is said to be unsure', () => {
    expect(groupOf({ from: 'carol@friend.example.invalid', to: toMe })).toEqual({ group: 'not-important', reason: 'builtin:unsure' })
    expect(groupOf({ from: 'carol@friend.example.invalid', to: [{ address: 'crew@marina.example.invalid' }] }).reason).toBe('builtin:unsure')
    expect(groupOf({ account: FERRY, name: 'Brand Tide to Shore' }).reason).toBe('builtin:unsure')
  })
  it('a row with no recipients is never taken for group mail (C8)', () => {
    for (const shape of [{ account: FERRY, name: 'Pier, Dana' }, { from: 'carol.pier@friend.example.invalid' }, { account: FERRY, name: 'Change Desk' }]) {
      expect(groupOf(shape).reason).not.toBe('builtin:group-alias')
    }
  })
})

describe('the fixture table (spec 14.1), as pure features', () => {
  const oneClick = { oneClick: true, https: ['https://em.shop.example.invalid/u'] }
  const rows: Array<[string, Shape, string, string]> = [
    ['no-reply review tool, To me, [Action Required]', { from: 'no-reply@review.example.invalid', to: toMe, subject: '[Action Required] Review 42' }, 'not-important', 'builtin:transactional'],
    ['pager address', { from: 'noreply-oncall-notifications@page.example.invalid', to: toMe }, 'not-important', 'builtin:transactional'],
    ['ticket system', { from: 'issues@tickets.example.invalid' }, 'not-important', 'builtin:transactional'],
    ['code host notifications@', { from: 'notifications@code.example.invalid', to: toMe }, 'not-important', 'builtin:transactional'],
    ['hello@ on a marketing subdomain, one-click', { from: 'hello@em.shop.example.invalid', to: toMe, listUnsubscribe: oneClick }, 'not-important', 'builtin:bulk'],
    ['mailto List-Unsubscribe + List-Id', { from: 'tidings@lists.example.invalid', listUnsubscribe: { oneClick: false, mailto: ['leave@lists.example.invalid'], listId: 'tidings.lists.example.invalid' } }, 'not-important', 'builtin:list'],
    ['link-only List-Unsubscribe', { from: 'harbourmaster@club.example.invalid', listUnsubscribe: { oneClick: false, https: ['https://club.example.invalid/leave'] } }, 'not-important', 'builtin:list'],
    ['Precedence: bulk, person-shaped address', { from: 'dana.pier@friend.example.invalid', to: toMe, bulkHeaders: { precedence: 'bulk' } }, 'not-important', 'builtin:bulk'],
    ['Auto-Submitted, person-shaped address', { from: 'dana.pier@friend.example.invalid', to: toMe, bulkHeaders: { autoSubmitted: 'auto-generated' } }, 'not-important', 'builtin:transactional'],
    ['a person writing to me', { from: 'carol.pier@friend.example.invalid', to: toMe }, 'important', 'builtin:direct'],
    ['a person writing to a group alias', { from: 'carol.pier@friend.example.invalid', to: [{ address: 'crew@marina.example.invalid' }] }, 'not-important', 'builtin:group-alias'],
    ['a person, me only in Cc', { from: 'carol.pier@friend.example.invalid', to: [{ address: 'crew@marina.example.invalid' }], cc: toMe }, 'important', 'builtin:direct'],
    ['someone I have written to', { from: 'tidewear@shop.example.invalid', to: toMe, correspondents: ['tidewear@shop.example.invalid'] }, 'important', 'builtin:correspondent'],
    ['ferry: name-only payroll', { account: FERRY, name: 'payroll' }, 'not-important', 'builtin:transactional'],
    ['ferry: name-only organisation', { account: FERRY, name: 'Brand Tide to Shore' }, 'not-important', 'builtin:unsure'],
    ['ferry: Last, First to my display name', { account: FERRY, name: 'Pier, Dana', to: toMeByName }, 'important', 'builtin:direct'],
    ['ferry: out-of-office to two aliases', { account: FERRY, name: 'Pier, Dana', to: [{ name: 'crew-leads', address: '' }, { address: 'dock-team@' }] }, 'not-important', 'builtin:group-alias'],
    ['ferry: Last, First with no recipients (old row)', { account: FERRY, name: 'Pier, Dana' }, 'important', 'builtin:person'],
    ['ferry: Survey Desk', { account: FERRY, name: 'Survey Desk' }, 'not-important', 'builtin:transactional'],
    ['news@ (marketing local), To me, no list headers', { from: 'news@shop.example.invalid', to: toMe }, 'not-important', 'builtin:bulk'],
    ['offers@ on e. subdomain', { from: 'offers@e.shop.example.invalid', to: toMe }, 'not-important', 'builtin:bulk'],
    ['statements@ with one-click', { from: 'statements@bank.example.invalid', to: toMe, listUnsubscribe: oneClick }, 'not-important', 'builtin:transactional'],
    ['brand word, To me, provider says promotions', { from: 'tidewear@shop.example.invalid', to: toMe, gmailCategory: 'promotions' }, 'not-important', 'builtin:bulk'],
    ['brand word, To me, no category', { from: 'harbourclub@club.example.invalid', to: toMe }, 'not-important', 'builtin:unsure'],
    ['single-word local part, To me', { from: 'carol@friend.example.invalid', to: toMe }, 'not-important', 'builtin:unsure'],
    ['news@lists before its headers are fetched', { from: 'news@lists.example.invalid', to: toMe }, 'not-important', 'builtin:bulk'],
  ]
  it.each(rows)('%s', (_name, shape, group, reason) => {
    expect(groupOf(shape)).toEqual({ group, reason })
  })
  it('the why line matches each built-in reason', () => {
    expect(whyOf('builtin:direct')).toBe('To you directly')
    expect(whyOf('builtin:person')).toBe('From a person')
    expect(whyOf('builtin:group-alias')).toBe('Sent to a group, not to you')
    expect(whyOf('builtin:bulk')).toBe('Marketing sender')
    expect(whyOf('builtin:transactional')).toBe('Automated notice')
    expect(whyOf('builtin:list')).toBe('Mailing list')
    expect(whyOf('builtin:correspondent')).toBe('You have written to this sender')
    expect(whyOf('builtin:unsure')).toBe("Walnut can't tell who sent this")
    expect(whyOf(null)).toBe('Sorting\u2026')
    expect(whyOf('ai:pending')).toBe('Sorting\u2026')
    expect(whyOf('ai', undefined, 'Automated ticket status change')).toBe('Automated ticket status change')
    expect(whyOf('ai')).toBe('Sorted by Walnut')
  })
})

describe('real cache shapes (a)-(c), as pure features', () => {
  it('(a) name-only automated senders and org names are never Important', () => {
    for (const name of ['payroll', 'Brand A to Z', 'Harbour Club', 'Change Desk', 'Survey Desk']) {
      expect(groupOf({ account: FERRY, name }).group).not.toBe('important')
    }
  })
  it('(a) a colleague with no recipients stays Important; with only aliases is not important', () => {
    expect(groupOf({ account: FERRY, name: 'Last, First' }).group).toBe('important')
    expect(groupOf({ account: FERRY, name: 'Last, First', to: [{ name: 'dock-team', address: '' }, { address: 'crew-leads@' }] }))
      .toEqual({ group: 'not-important', reason: 'builtin:group-alias' })
  })
  it('(b) automated senders with addresses are automated notices', () => {
    for (const from of ['issues@tickets.example.invalid', 'noreply-oncall-notifications@paging.example.invalid', 'no-reply@review.example.invalid', 'alerts@cost.example.invalid']) {
      expect(groupOf({ from, to: toMe })).toEqual({ group: 'not-important', reason: 'builtin:transactional' })
    }
  })
  it('(c) Gmail bulk shapes: marketing subdomains and noreply-style locals', () => {
    for (const sub of ['digital', 'email', 'hello', 'news', 'info', 'e', 'em', 'mail', 'mkt']) {
      expect(groupOf({ from: `tide@${sub}.store.example.invalid`, to: toMe }).reason).toBe('builtin:bulk')
    }
    expect(groupOf({ from: 'tide@notifications.store.example.invalid', to: toMe }).reason).toBe('builtin:transactional')
    for (const local of ['no.reply', 'donotreply', 'noreply', 'calendar-notification', 'notifications']) {
      expect(groupOf({ from: `${local}@store.example.invalid`, to: toMe }).group).not.toBe('important')
    }
  })
})

describe('user and learned rules (spec 5.5)', () => {
  const rule = (when: Rule['when'], then: string, extra: Partial<Rule> = {}): Rule => ({ id: 'r-aaaaaa', when, then, source: 'user', ...extra })

  it('run before every built-in, first match wins', () => {
    const rules = [
      rule({ from: ['noreply-oncall-notifications@*', 'issues@*'] }, 'On-call & tickets', { id: 'r-111111' }),
      rule({ from: '@page.example.invalid' }, 'Notifications', { id: 'r-222222' }),
    ]
    expect(groupOf({ from: 'noreply-oncall-notifications@page.example.invalid' }, rules)).toEqual({ group: 'u:on-call-tickets', reason: 'rule:r-111111' })
    expect(groupOf({ from: 'issues@tickets.example.invalid' }, rules).group).toBe('u:on-call-tickets')
  })
  it('from: an @domain pattern matches the domain; a name pattern matches the display name', () => {
    expect(groupOf({ from: 'x@page.example.invalid' }, [rule({ from: '@page.example.invalid' }, 'Important')]).group).toBe('important')
    expect(groupOf({ from: 'x@sub.page.example.invalid' }, [rule({ from: '*@*.page.example.invalid' }, 'Important')]).group).toBe('important')
    expect(groupOf({ account: FERRY, name: 'payroll' }, [rule({ from: 'PAYROLL' }, 'Important')]).group).toBe('important')
    expect(groupOf({ account: FERRY, name: 'Brand  Tide to Shore' }, [rule({ from: 'brand tide*' }, 'Important')]).group).toBe('important')
    // A name pattern never matches the address, and an address pattern never matches a name-only row.
    expect(groupOf({ from: 'payroll@example.invalid' }, [rule({ from: 'payroll' }, 'Important')]).group).not.toBe('important')
    expect(groupOf({ account: FERRY, name: 'payroll' }, [rule({ from: 'payroll@*' }, 'Important')]).group).not.toBe('important')
  })
  it('subject: text contains (case-insensitive) or a safe regex on the first 300 characters', () => {
    const shape = { account: FERRY, name: 'Change Desk', subject: '[Action Required] window 14' }
    expect(groupOf(shape, [rule({ subject: 'action required' }, 'Important')]).group).toBe('important')
    expect(groupOf(shape, [rule({ subject: { re: 'window \\d+' } }, 'Important')]).group).toBe('important')
    const late = { ...shape, subject: `${'x'.repeat(310)}needle` }
    expect(groupOf(late, [rule({ subject: { re: 'needle' } }, 'Important')]).group).not.toBe('important')
    expect(groupOf(late, [rule({ subject: 'needle' }, 'Important')]).group).not.toBe('important')
  })
  it('listId matches only rows that carry one', () => {
    const rules = [rule({ listId: 'tidings.*' }, 'Important')]
    expect(groupOf({ from: 'a@lists.example.invalid', listUnsubscribe: { oneClick: false, listId: 'Tidings.Lists.example.invalid' } }, rules).group).toBe('important')
    expect(groupOf({ from: 'a@lists.example.invalid' }, rules).group).not.toBe('important')
  })
  it('addressedToMe only compares known values; unknown rows match neither', () => {
    const direct = [rule({ from: 'Change Desk', addressedToMe: true }, 'Important')]
    const group = [rule({ from: 'Change Desk', addressedToMe: false }, 'Ticket updates')]
    expect(groupOf({ account: FERRY, name: 'Change Desk', to: toMeByName }, direct).group).toBe('important')
    expect(groupOf({ account: FERRY, name: 'Change Desk', to: [{ name: 'crew-leads', address: '' }] }, group).group).toBe('u:ticket-updates')
    expect(groupOf({ account: FERRY, name: 'Change Desk' }, direct)).toEqual({ group: 'not-important', reason: 'builtin:unsure' })
    expect(groupOf({ account: FERRY, name: 'Change Desk' }, group)).toEqual({ group: 'not-important', reason: 'builtin:unsure' })
  })
  it('cc, sender (automated = bulk or transactional), account and message', () => {
    const ccRow = { from: 'carol.pier@friend.example.invalid', to: [{ address: 'crew@marina.example.invalid' }], cc: toMe }
    expect(groupOf(ccRow, [rule({ cc: true }, 'Group mail')]).group).toBe('u:group-mail')
    expect(groupOf({ account: FERRY, name: 'Pier, Dana', to: toMeByName }, [rule({ cc: true }, 'Group mail')]).group).toBe('important')
    expect(groupOf({ from: 'hello@em.shop.example.invalid' }, [rule({ sender: 'automated' }, 'Important')]).group).toBe('important')
    expect(groupOf({ from: 'issues@tickets.example.invalid' }, [rule({ sender: 'automated' }, 'Important')]).group).toBe('important')
    expect(groupOf({ from: 'carol.pier@friend.example.invalid' }, [rule({ sender: 'automated' }, 'Notifications')]).group).toBe('important')
    expect(groupOf({ account: FERRY, name: 'Brand Tide to Shore' }, [rule({ sender: 'unknown' }, 'Notifications')]).group).toBe('u:notifications')
    expect(groupOf({ from: 'carol@friend.example.invalid', rfc: '<only@example.invalid>' }, [rule({ message: '<only@example.invalid>' }, 'Important')]).group).toBe('important')
  })
  it('a display-name rule scoped to one account leaves the same name on another account alone (C89)', () => {
    const rules = [rule({ from: 'payroll', account: FERRY }, 'Important')]
    expect(groupOf({ account: FERRY, name: 'payroll' }, rules).group).toBe('important')
    expect(groupOf({ account: MARINA, name: 'payroll' }, rules).group).toBe('not-important')
  })
  it('a disabled rule is skipped', () => {
    expect(groupOf({ from: 'issues@tickets.example.invalid' }, [rule({ from: 'issues@*' }, 'Important', { enabled: false })]).group).toBe('not-important')
  })
  it('a rule without an id gets a stable derived id', () => {
    const noId: Rule = { when: { from: 'issues@*' }, then: 'Important', source: 'user' }
    const a = compileRules([noId])[0]!.id
    const b = compileRules([noId])[0]!.id
    expect(a).toMatch(/^r-[0-9a-f]{6}$/)
    expect(a).toBe(b)
  })
})

describe('names, globs, keys and labels', () => {
  it('the two reserved names resolve case-insensitively; every other name slugs to u:<slug>', () => {
    expect(groupIdForName('IMPORTANT')).toBe('important')
    expect(groupIdForName('not Important')).toBe('not-important')
    expect(groupIdForName('notifications')).toBe('u:notifications')
    expect(groupIdForName('Newsletters & Promotions')).toBe('u:newsletters-promotions')
    expect(groupIdForName('group mail')).toBe('u:group-mail')
    expect(groupIdForName('On-call & tickets')).toBe('u:on-call-tickets')
    expect(slugOf('A&B')).toBe(slugOf('A B'))
    expect(slugOf('F\u00f6re & Efter')).toBe('f\u00f6re-efter')
  })
  it('globTest is anchored and escapes regex characters', () => {
    expect(globTest('a.b*')('a.bcd')).toBe(true)
    expect(globTest('a.b*')('axbcd')).toBe(false)
    expect(globTest('(x)')('(x)')).toBe(true)
  })
  it('sender keys: address, else name:, else unknown', () => {
    expect(senderKey('Carol.Pier@Friend.example.invalid', 'Carol')).toBe('carol.pier@friend.example.invalid')
    expect(senderKey('', '  Pier,  Dana ')).toBe('name:pier, dana')
    expect(senderKey('', '')).toBe('unknown')
  })
  it('labels: display name first; machine addresses read as brand (local)', () => {
    expect(senderLabel('no-reply@review.example.invalid', '')).toBe('review (no-reply)')
    expect(senderLabel('hello@em.shop.example.invalid', '')).toBe('shop (hello)')
    expect(senderLabel('carol.pier@friend.example.invalid', '')).toBe('carol.pier@friend.example.invalid')
    expect(senderLabel('', 'Pier, Dana')).toBe('Pier, Dana')
    expect(senderLabel('', '')).toBe('Unknown sender')
  })
  it('duplicate labels get the domain', () => {
    expect(disambiguateLabels([
      { key: 'support@a.example.invalid', label: 'Support' },
      { key: 'support@b.example.invalid', label: 'Support' },
      { key: 'name:crew', label: 'Crew' },
    ])).toEqual(['Support \u00b7 a.example.invalid', 'Support \u00b7 b.example.invalid', 'Crew'])
  })
  it('the why line for rules: source, note or summary, 60 characters', () => {
    expect(whyOf('rule:r-1', { source: 'user', note: 'Pages and tickets' })).toBe('Your rule: Pages and tickets')
    expect(whyOf('rule:r-1', { source: 'learned', summary: 'From issues@* \u2192 Important' })).toBe('You taught Walnut: From issues@* \u2192 Important')
    expect(whyOf('rule:r-1', { source: 'learned', note: 'x'.repeat(60) })).toBe(`You taught Walnut: ${'x'.repeat(60)}`)
    expect(whyOf('rule:r-1', { source: 'learned', note: 'x'.repeat(80) })).toBe(`You taught Walnut: ${'x'.repeat(60)}\u2026`)
    expect(whyOf('rule:gone')).toBe('Your rule')
  })
})

describe('rule summaries (Settings, GET /rules, the propose drafts)', () => {
  const ctx = { accountLabel: (id: string) => (id === FERRY ? 'Ferry work' : id) }
  it('a sender list reads as one "or" sentence with its target', () => {
    expect(summarizeRule({ when: { from: ['noreply-oncall-notifications@*', 'issues@*'] }, then: 'On-call & tickets' }, ctx))
      .toBe('From noreply-oncall-notifications@* or issues@* \u2192 On-call & tickets')
  })
  it('an account condition shows the display name, never the id', () => {
    const text = summarizeRule({ when: { from: 'payroll', account: FERRY }, then: 'Notifications' }, ctx)
    expect(text).toBe('From payroll in Ferry work \u2192 Notifications')
    expect(text).not.toContain(FERRY)
  })
  it('recipients, Cc, subject and sender kind each add their phrase', () => {
    expect(summarizeRule({ when: { from: 'Change Desk', addressedToMe: true, subject: 'Action Required' }, then: 'Important' }, ctx))
      .toBe('From Change Desk with "Action Required" in the subject sent to you directly \u2192 Important')
    expect(summarizeRule({ when: { cc: true, sender: 'automated' }, then: 'Group mail' }, ctx))
      .toBe('Mail where you are only in Cc from an automated sender \u2192 Group mail')
  })
  it('a message rule shows its label, or a short id when it has none', () => {
    expect(summarizeRule({ when: { message: '<m1@example.invalid>' }, then: 'Important', label: 'Only the mail "Lease" from Pier, Dana, Sep 28' }))
      .toBe('Only the mail "Lease" from Pier, Dana, Sep 28 \u2192 Important')
    expect(summarizeRule({ when: { message: '<0123456789abcdef@example.invalid>' }, then: 'Important' }))
      .toBe('Only one mail (id <0123456789a) \u2192 Important')
  })
  it('lists the eight built-ins in order, each with its destination label', () => {
    const all = builtinSummaries()
    expect(all.map((one) => one.id)).toEqual(BUILTIN_RULES.map((rule) => rule.id))
    expect(all.map((one) => one.then)).toEqual([
      'Important', 'Not important', 'Not important', 'Not important',
      'Not important', 'Important', 'Important', 'Not important',
    ])
  })
})
