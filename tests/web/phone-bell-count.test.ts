/**
 * The two notification numbers. The phone bell says attentionBadgeCount, the
 * same number as the drawer's Notifications row (C55, N2-05: two bells showed
 * 1 and 6); answerableCount is the center's Needs Action section alone.
 */
import { describe, expect, it } from 'vitest'
import { answerableCount, attentionBadgeCount } from '../../web/src/contexts/notifications/notification-model'
import type { Notification } from '../../web/src/contexts/notifications/types'

function n(id: string, kind: Notification['kind'], extra: Partial<Notification> = {}): Notification {
  return { id, kind, severity: 'info', title: id, body: '', timestamp: 1, read: false, dedupKey: id, ...extra } as Notification
}

describe('answerableCount', () => {
  it('counts pending permission asks only', () => {
    const feed = [
      n('a1', 'permission', { requestId: 'r1', sessionId: 's1' }),
      n('a2', 'permission', { requestId: 'r2', sessionId: 's2', read: true }),
      n('done', 'permission', { requestId: 'r3', sessionId: 's3', resolved: 'allowed' } as Partial<Notification>),
      n('l1', 'letter'), n('l2', 'letter'), n('l3', 'letter'),
      n('e1', 'operation-error'),
    ]
    expect(answerableCount(feed)).toBe(2)
    // Both bells (bar and drawer) count letters too.
    expect(attentionBadgeCount(feed)).toBe(5)
  })

  it('is 0 when only letters wait (Needs Action is empty)', () => {
    expect(answerableCount([n('l1', 'letter'), n('l2', 'letter')])).toBe(0)
    expect(answerableCount([])).toBe(0)
  })
})
