/**
 * During a focus block nothing pops up outside Walnut's window, and when it ends ONE notice
 * says what waited (web/src/contexts/notifications/system-notice.ts). 2026-11-17, the user:
 * "why it even send me notification even I am in focus mode".
 *
 *  - quiet holds every notice outside the window, asks included (a permission ask still
 *    toasts inside the window while quiet allows it; that is notify()'s);
 *  - a state not heard from the server yet holds too (the page just loaded in a focus block);
 *  - the end of quiet raises the one item itself, or one summary for several, never one each;
 *  - an item whose reason is gone (an approval answered) is not in that reminder.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const q = vi.hoisted(() => ({
  state: { active: false, allowPermissions: true, holds: [] } as Record<string, unknown>,
  listener: null as null | ((s: Record<string, unknown>) => void),
}))

vi.mock('@/utils/log', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('@/contexts/notifications/quiet', () => ({
  currentQuiet: () => q.state,
  onQuietState: (fn: (s: Record<string, unknown>) => void) => { q.listener = fn; return () => undefined },
}))

const shown: Array<{ title: string; body?: string; tag?: string }> = []
class FakeNotification {
  static permission = 'granted'
  onclick: (() => void) | null = null
  constructor(title: string, opts: { body?: string; tag?: string } = {}) { shown.push({ title, ...opts }) }
  close(): void { /* closed */ }
}
;(globalThis as unknown as { Notification: unknown }).Notification = FakeNotification
;(globalThis as unknown as { window: unknown }).window = { focus: () => undefined, dispatchEvent: () => true }

const exit = await import('../../web/src/contexts/notifications/system-notice')

const FOCUS = { active: true, allowPermissions: true, holds: [{ source: 'plugin:walnut-rhythm', since: 1, reason: 'Focus block' }] }
const LOUD = { active: false, allowPermissions: true, holds: [] }

function end(state: Record<string, unknown> = LOUD): void {
  q.state = state
  q.listener?.(state)
}

beforeEach(() => {
  shown.length = 0
  end(LOUD)
  shown.length = 0
})

describe('a notice outside the window during quiet', () => {
  it('is held during a focus block, an ask included, and nothing pops up', () => {
    q.state = FOCUS
    expect(exit.postSystemNotice({ tag: 'approval-a1', title: 'Approve? Deploy web', requireInteraction: true })).toBe('held')
    expect(exit.postSystemNotice({ tag: 'q-1', title: 'Agent has a question' })).toBe('held')
    expect(shown).toEqual([])
  })

  it('is held while quiet is not known yet', () => {
    q.state = { ...LOUD, unknown: true }
    expect(exit.systemNoticeAllowed(q.state as never)).toBe(false)
    expect(exit.postSystemNotice({ tag: 'r-1', title: 'Reminder: stretch' })).toBe('held')
    expect(shown).toEqual([])
    end(LOUD)
    // Known and not quiet: the one held item shows as itself.
    expect(shown.map(s => s.title)).toEqual(['Reminder: stretch'])
  })

  it('the end of quiet raises ONE notice for several, and only once', () => {
    q.state = FOCUS
    exit.postSystemNotice({ tag: 'approval-a1', title: 'Approve? Deploy web' })
    exit.postSystemNotice({ tag: 'q-1', title: 'Agent has a question' })
    exit.postSystemNotice({ tag: 'r-1', title: 'Reminder: stretch' })
    exit.withdrawSystemNotice('r-1')
    end(LOUD)
    end(LOUD)
    expect(shown).toHaveLength(1)
    expect(shown[0]!.title).toBe('2 things waited for you')
    expect(shown[0]!.body).toContain('Approve? Deploy web')
    expect(shown[0]!.body).not.toContain('stretch')
    expect(exit.heldSystemNotices()).toEqual([])
  })

  it('held only while the state was unknown, each goes out as itself (no "waited" summary)', () => {
    q.state = { ...LOUD, unknown: true }
    exit.postSystemNotice({ tag: 'approval-a1', title: 'Approve? Deploy web' })
    exit.postSystemNotice({ tag: 'approval-a2', title: 'Approve? Publish docs' })
    end(LOUD)
    expect(shown.map(s => s.title)).toEqual(['Approve? Deploy web', 'Approve? Publish docs'])
  })

  it('posts at once when not quiet', () => {
    expect(exit.postSystemNotice({ tag: 'q-2', title: 'Agent has a question' })).toBe('shown')
    expect(shown.map(s => s.title)).toEqual(['Agent has a question'])
  })
})
