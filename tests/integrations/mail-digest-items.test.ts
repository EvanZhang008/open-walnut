import { describe, expect, it } from 'vitest'
import { digestItemFromRow, digestLetterItem, EMAIL_SUMMARY_UNAVAILABLE } from '../../src/integrations/mail/digest-items.js'
import { DIGEST_MAX_BYTES, renderDigest, renderGroupedDigest, type DigestAccountBlock } from '../../src/integrations/mail/digest.js'
import { validateNewItems } from '../../src/core/human-inbox/item-schema.js'
import type { MessageRow } from '../../src/integrations/mail/store.js'
import type { MailAccountDto } from '../../src/integrations/mail/contract.js'

const NOW = Date.UTC(2026, 9, 22, 12)
const account = { accountId: 'cache-a', displayName: 'Fixture mailbox', address: 'reader@example.invalid' } as MailAccountDto
function row(overrides: Partial<MessageRow> = {}): MessageRow {
  return { account_id: 'cache-a', message_id: 'message-1', subject: 'Shared subject', from_addr: 'source@example.invalid',
    sent_at: NOW - 1000, updated_at: NOW - 500, flags_json: '[]', snippet: 'Preview is not a summary',
    payload: JSON.stringify({ from: { name: 'Fixture sender', address: 'source@example.invalid' }, summary: 'Stored cache summary' }),
    ...overrides } as MessageRow
}
function block(n: number, count: number, length = 20): DigestAccountBlock {
  return { accountId: `cache-${n}`, label: `Fixture ${n}`, unread: count + 10,
    items: Array.from({ length: count }, (_, index) => digestItemFromRow(row({ account_id: `cache-${n}`,
      message_id: `message-${index}`, subject: `${index} ${'\\'.repeat(length)}` }), account)) }
}
const bullets = (markdown: string) => markdown.split('\n').filter(line => line.startsWith('- **'))

describe('digest source-bound items', () => {
  it('preserves exact identity, stored summary, display and actual cache observation time', () => {
    const item = digestLetterItem(digestItemFromRow(row(), account))!
    expect(item.source).toEqual({ kind: 'mail', account: 'cache-a', message: 'message-1' })
    expect(item.summary).toBe('Stored cache summary')
    expect(item.display).toEqual({ sender: { name: 'Fixture sender', address: 'source@example.invalid' },
      sentAt: new Date(NOW - 1000).toISOString(), accountLabel: 'Fixture mailbox', accountHint: 'reader@example.invalid' })
    expect(item.readObservation).toEqual({ read: false, observedAt: new Date(NOW - 500).toISOString() })
    expect(item.actions.map(action => action.kind === 'op' && action.intent)).toEqual(['mark_read', 'find_task', 'create_task'])
    for (const action of item.actions) expect(Object.keys(action).sort()).toEqual(['id', 'intent', 'kind'])
    expect(validateNewItems([item])).toEqual([item])
  })
  it('uses pair identity, not display, subject or cross-account provider message strings', () => {
    const first = digestLetterItem(digestItemFromRow(row(), account))!
    const same = digestLetterItem(digestItemFromRow(row({ subject: 'Renamed', payload: null }), account))!
    const otherMessage = digestLetterItem(digestItemFromRow(row({ message_id: 'message-2' }), account))!
    const otherAccount = digestLetterItem(digestItemFromRow(row({ account_id: 'cache-b' }), account))!
    expect(first.id).toBe(same.id)
    expect(first.actions).toEqual(same.actions)
    expect(new Set([first.id, otherMessage.id, otherAccount.id]).size).toBe(3)
  })
  it('never invents summary, display metadata or a read observation from missing data', () => {
    const item = digestLetterItem(digestItemFromRow(row({ from_addr: '', sent_at: 0, payload: '{broken', flags_json: null }),
      { ...account, displayName: '', address: '' }))!
    expect(item.summary).toBe(EMAIL_SUMMARY_UNAVAILABLE)
    expect(item.summary).not.toContain('Preview')
    expect(item.display).toEqual({})
    expect(item.readObservation).toBeUndefined()
    expect(digestLetterItem(digestItemFromRow(row({ flags_json: '[1]', updated_at: NOW }), account))?.readObservation).toBeUndefined()
  })
  it('strips controls and clips authored values without modifying source identifiers', () => {
    const bidi = String.fromCharCode(0x202e)
    const item = digestLetterItem(digestItemFromRow(row({ subject: `a${bidi}b\n` + 'x'.repeat(3000),
      payload: JSON.stringify({ from: { name: `Fixture${String.fromCharCode(0)}${bidi} sender` }, summary: 'Safe\u0001\nsummary' }) }), account))!
    expect(item.subject).not.toContain(bidi)
    expect(item.subject).not.toContain('\n')
    expect(item.subject.length).toBeLessThanOrEqual(1000)
    expect(item.summary).toBe('Safe summary')
    expect(item.display?.sender?.name).toBe('Fixture sender')
    expect(digestLetterItem({ sender: '', subject: 'No identity', sentAt: 0 })).toBeUndefined()
    expect(digestLetterItem({ sender: '', subject: 'Bad identity', sentAt: 0, account: 'a\n', message: 'm' })).toBeUndefined()
  })
})

// Body and executable entries must be truncated at the same boundary.
describe('digest item rendering bounds', () => {
  it('keeps 15 and 30 rows in order without making group actions', () => {
    for (const count of [15, 30]) {
      const blocks = [block(0, count)]
      for (const digest of [renderDigest(blocks, NOW), renderGroupedDigest(blocks, [{ label: 'Fixture notices', unread: 300 }], NOW)]) {
        expect(digest.items).toHaveLength(count)
        expect(bullets(digest.markdown)).toHaveLength(count)
        expect(validateNewItems(digest.items)).toEqual(digest.items)
        expect(digest.markdown).toContain('Mailbox snapshot at')
        expect(digest.items.map(item => item.source.message)).toEqual(blocks[0].items.map(item => item.message))
      }
    }
  })
  it('caps bytes and executable entries alongside the listed original messages', () => {
    const large = [block(0, 50, 1000), block(1, 50, 1000), block(2, 50, 1000)]
    for (const digest of [renderDigest(large, NOW), renderGroupedDigest(large, [{ label: 'x'.repeat(200), unread: 2 }], NOW)]) {
      expect(Buffer.byteLength(digest.markdown)).toBeLessThanOrEqual(DIGEST_MAX_BYTES)
      expect(digest.items.length).toBeGreaterThan(0)
      expect(digest.items.length).toBeLessThan(150)
      expect(digest.items).toHaveLength(bullets(digest.markdown).length)
      expect(validateNewItems(digest.items)).toEqual(digest.items)
    }
    const capped = renderDigest(Array.from({ length: 6 }, (_, n) => block(n, 50, 1)), NOW)
    expect(capped.items.length).toBeLessThanOrEqual(100)
    expect(capped.items).toHaveLength(bullets(capped.markdown).length)
  })
  it('keeps missing-source content read-only and does not guess identity', () => {
    const digest = renderDigest([{ accountId: 'fixture', label: 'Fixture', unread: 1,
      items: [{ sender: 'Fixture sender', subject: 'Read-only email', sentAt: NOW }] }], NOW)
    expect(digest.items).toEqual([])
    expect(digest.markdown).toContain('source identity missing')
  })
})
