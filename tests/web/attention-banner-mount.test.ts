/**
 * AttentionBannerMount's pure rules (banner placement slice, 2.3, 4.2, 5.5):
 *   reserve    only tasks -> notifications on Home keeps a box; any route change drops it (C5, C6, C68)
 *   hold       pointer below the task panel toolbar, a task drag, or the pointer over the panel body (C51)
 *   guard      a click right after a height change with an unmoved pointer is swallowed (5.5)
 *   health     the home page's health channel notifies once per change (the task panel prop stays stable)
 *   errors     a host cause names the host's label, the alias when unknown (C57)
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/utils/log', () => ({ log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }))

import {
  CLICK_GUARD_MS, CLICK_GUARD_PX, holdLayoutNow, nextReserve, publishBannerHealth, shouldSwallowClick, type GuardInput,
} from '../../web/src/components/common/banner-mount-hooks'
import { causeLabelOf, hostOfCauseKey, partitionErrorsByCause, setCauseHostLabelResolver } from '../../web/src/contexts/notifications/notification-model'
import type { Notification } from '../../web/src/contexts/notifications/types'

describe('nextReserve', () => {
  const at = (owner: 'tasks' | 'notifications' | 'slot' | 'draft' | 'none', pathname = '/') => ({ owner, pathname })

  it('keeps the card height when the panel borrows the card from the task panel on Home', () => {
    expect(nextReserve('tasks', at('tasks'), at('notifications'), 212)).toBe(212)
  })

  it('never makes a box when the card had no height (the empty state keeps zero)', () => {
    expect(nextReserve('tasks', at('tasks'), at('notifications'), 0)).toBeNull()
  })

  it('drops the box when the card comes back, and never keeps one on another route', () => {
    expect(nextReserve('tasks', at('notifications'), at('tasks'), 212)).toBeNull()
    expect(nextReserve('tasks', at('notifications'), at('none', '/settings'), 212)).toBeNull()
    expect(nextReserve('tasks', at('none', '/notes'), at('notifications', '/notes'), 212)).toBeNull()
    expect(nextReserve('tasks', at('tasks'), at('notifications', '/settings'), 212)).toBeNull()
  })

  it('only the task panel mount reserves (the slot hides under nothing)', () => {
    expect(nextReserve('slot', at('slot'), at('notifications'), 212)).toBeNull()
    expect(nextReserve('draft', at('draft'), at('notifications'), 212)).toBeNull()
    expect(nextReserve('tasks', at('slot'), at('notifications'), 212)).toBeNull()
  })
})

describe('shouldSwallowClick', () => {
  const base: GuardInput = {
    armedAt: 1_000, armedPointer: { x: 100, y: 300, at: 1_000 }, now: 1_100,
    click: { clientX: 100, clientY: 300, detail: 1 }, inCard: false, cardTop: 50,
  }

  it('swallows a click that lands where the pointer sat when something slid under it', () => {
    expect(shouldSwallowClick(base)).toBe(true)
    expect(shouldSwallowClick({ ...base, click: { clientX: 100 + CLICK_GUARD_PX, clientY: 300, detail: 1 } })).toBe(true)
  })

  it('lets a moved pointer, a late click, a keyboard click and a click in the card through', () => {
    expect(shouldSwallowClick({ ...base, click: { clientX: 110, clientY: 300, detail: 1 } })).toBe(false)
    expect(shouldSwallowClick({ ...base, now: base.armedAt + CLICK_GUARD_MS + 1 })).toBe(false)
    expect(shouldSwallowClick({ ...base, click: { ...base.click, detail: 0 } })).toBe(false)
    expect(shouldSwallowClick({ ...base, inCard: true })).toBe(false)
  })

  it('never touches what sits above the card (the toolbar did not move)', () => {
    expect(shouldSwallowClick({ ...base, cardTop: 320 })).toBe(false)
  })

  it('does nothing before the pointer was ever seen', () => {
    expect(shouldSwallowClick({ ...base, armedPointer: null })).toBe(false)
  })
})

// A minimal element double: holdLayoutNow only reads closest, classList,
// querySelector and getBoundingClientRect.
type Rect = { left: number; top: number; right: number; bottom: number }
const rect = (left: number, top: number, right: number, bottom: number): DOMRect =>
  ({ left, top, right, bottom, x: left, y: top, width: right - left, height: bottom - top, toJSON: () => ({}) }) as DOMRect
function fakeEl(r: Rect, opts: { classes?: string[]; children?: Record<string, unknown>; parents?: Record<string, unknown> } = {}): HTMLElement {
  return {
    getBoundingClientRect: () => rect(r.left, r.top, r.right, r.bottom),
    classList: { contains: (c: string) => (opts.classes ?? []).includes(c) },
    querySelector: (sel: string) => opts.children?.[sel] ?? null,
    closest: (sel: string) => opts.parents?.[sel] ?? null,
  } as unknown as HTMLElement
}

describe('holdLayoutNow', () => {
  const toolbar = fakeEl({ left: 0, top: 0, right: 360, bottom: 42 })
  const panel = (classes: string[] = []) => fakeEl({ left: 0, top: 0, right: 360, bottom: 800 }, { classes, children: { '.todo-panel-toolbar': toolbar } })
  const tasksMount = (p = panel()) => fakeEl({ left: 0, top: 42, right: 360, bottom: 42 }, { parents: { '.todo-panel': p } })
  const pt = (x: number, y: number) => ({ x, y, at: 0 })

  it('holds while the pointer is in the task panel below its toolbar', () => {
    expect(holdLayoutNow('tasks', tasksMount(), pt(100, 300), false)).toBe(true)
    expect(holdLayoutNow('tasks', tasksMount(), pt(100, 42), false)).toBe(true)
  })

  it('does not hold for the toolbar, outside the panel, a pointer that left the window, or no pointer yet', () => {
    expect(holdLayoutNow('tasks', tasksMount(), pt(100, 20), false)).toBe(false)
    expect(holdLayoutNow('tasks', tasksMount(), pt(500, 300), false)).toBe(false)
    expect(holdLayoutNow('tasks', tasksMount(), pt(100, 300), true)).toBe(false)
    expect(holdLayoutNow('tasks', tasksMount(), null, false)).toBe(false)
  })

  it('leaves the card area to the card itself (its own pointer-inside rule answers there)', () => {
    const mount = fakeEl({ left: 0, top: 42, right: 360, bottom: 250 }, { parents: { '.todo-panel': panel() } })
    expect(holdLayoutNow('tasks', mount, pt(100, 120), false)).toBe(false)
    expect(holdLayoutNow('tasks', mount, pt(100, 300), false)).toBe(true)
  })

  it('holds for the whole of a task drag, wherever the pointer is', () => {
    const dragging = tasksMount(panel(['is-task-dragging']))
    expect(holdLayoutNow('tasks', dragging, null, false)).toBe(true)
    expect(holdLayoutNow('tasks', dragging, pt(900, 900), true)).toBe(true)
  })

  it('holds in the notification panel only over the System section below the card', () => {
    // The rail is x 200..360; the section (detail) x 360..760 holds the card at its top.
    const detail = fakeEl({ left: 360, top: 60, right: 760, bottom: 800 })
    const mount = fakeEl({ left: 372, top: 72, right: 748, bottom: 280 }, { parents: { '.nfc-detail': detail } })
    expect(holdLayoutNow('notifications', mount, pt(500, 500), false)).toBe(true)
    // Over the card itself: its own rule answers (a Retry answers in place).
    expect(holdLayoutNow('notifications', mount, pt(500, 150), false)).toBe(false)
    // The rail and the header never move.
    expect(holdLayoutNow('notifications', mount, pt(250, 500), false)).toBe(false)
    expect(holdLayoutNow('notifications', mount, pt(500, 30), false)).toBe(false)
    expect(holdLayoutNow('notifications', mount, pt(500, 500), true)).toBe(false)
    expect(holdLayoutNow('notifications', mount, null, false)).toBe(false)
  })

  it('never holds the slot or draft mounts, or a mount outside its panel', () => {
    expect(holdLayoutNow('slot', tasksMount(), pt(100, 300), false)).toBe(false)
    expect(holdLayoutNow('draft', tasksMount(), pt(100, 300), false)).toBe(false)
    expect(holdLayoutNow('tasks', fakeEl({ left: 0, top: 0, right: 1, bottom: 1 }), pt(0, 0), false)).toBe(false)
    expect(holdLayoutNow('tasks', null, pt(0, 0), false)).toBe(false)
  })
})

describe('the home page health channel', () => {
  it('notifies once per change and keeps the same snapshot for the same answer', async () => {
    const { getBannerHealth, subscribeBannerHealth } = await import('../../web/src/components/common/banner-mount-hooks')
    const seen: unknown[] = []
    const stop = subscribeBannerHealth(() => seen.push(getBannerHealth()))
    const health = { claudeCliAvailable: true }
    publishBannerHealth(health, false)
    publishBannerHealth(health, false)
    expect(seen).toHaveLength(1)
    expect(getBannerHealth()).toEqual({ health, loading: false })
    publishBannerHealth(health, true)
    expect(seen).toHaveLength(2)
    stop()
    publishBannerHealth(undefined, true)
    expect(seen).toHaveLength(2)
  })
})

describe('Errors group heading for a host cause (C57)', () => {
  const err = (dedupKey: string, causeKey: string, t: number): Notification => ({
    id: dedupKey, dedupKey, kind: 'error', severity: 'error', title: 'Session start failed', message: 'x',
    timestamp: new Date(t).toISOString(), read: false, causeKey,
  } as unknown as Notification)

  it('names the host by its label, and by its alias when the store does not know it', () => {
    const labels: Record<string, string> = { devbox: 'Dev box' }
    expect(causeLabelOf('host:devbox', (a) => labels[a])).toBe("Can't reach Dev box")
    expect(causeLabelOf('host:netbox', (a) => labels[a])).toBe("Can't reach netbox")
    expect(causeLabelOf('host:devbox', () => '  ')).toBe("Can't reach devbox")
    expect(causeLabelOf('host:devbox', null)).toBe("Can't reach devbox")
  })

  it('uses the registered host store reader for the group label, and the alias without one', () => {
    const items = [err('a', 'host:devbox', 2_000), err('b', 'host:devbox', 1_000)]
    setCauseHostLabelResolver((a) => (a === 'devbox' ? 'Dev box' : undefined))
    try {
      expect(partitionErrorsByCause(items).causes.map((c) => c.label)).toEqual(["Can't reach Dev box"])
    } finally {
      setCauseHostLabelResolver(null)
    }
    expect(partitionErrorsByCause(items).causes.map((c) => c.label)).toEqual(["Can't reach devbox"])
  })

  it('reads the alias out of a host cause key, and nothing out of any other shape', () => {
    expect(hostOfCauseKey('host:devbox')).toBe('devbox')
    expect(hostOfCauseKey('host: ')).toBeNull()
    expect(hostOfCauseKey('route:/api/x')).toBeNull()
  })
})
