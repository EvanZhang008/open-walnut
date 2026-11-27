// What a notice's × closed stays closed until its words change (web/src/utils/notice-dismiss.ts).
import { beforeEach, describe, expect, it } from 'vitest'
import { parseHTML } from 'linkedom'
import { createElement as h, act } from '../../web/node_modules/react/index.js'
import { createRoot } from '../../web/node_modules/react-dom/client.js'
import {
  NOTICE_DISMISS_KEY, NOTICE_DISMISS_MAX, NOTICE_DISMISS_TOTAL, cappedKeys, clearNoticeScope, dismissNotice, isNoticeDismissed, noticeText,
  pruneNoticeScope, resetNoticeDismissCache, useLineClose, useNoticeDismiss,
} from '../../web/src/utils/notice-dismiss'

class MemStorage {
  private m = new Map<string, string>()
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null }
  setItem(k: string, v: string) { this.m.set(k, String(v)) }
  removeItem(k: string) { this.m.delete(k) }
  clear() { this.m.clear() }
}

beforeEach(() => {
  ;(globalThis as { localStorage?: unknown }).localStorage = new MemStorage()
  ;(globalThis as { window?: unknown }).window ??= { addEventListener() {}, removeEventListener() {} }
  resetNoticeDismissCache()
})

describe('notice dismissals', () => {
  it('a closed notice stays closed for the same words, and new words show again', () => {
    dismissNotice('session-error:s1', 'Host unreachable')
    expect(isNoticeDismissed('session-error:s1', 'Host unreachable')).toBe(true)
    expect(isNoticeDismissed('session-error:s1', 'Rate limited')).toBe(false)
    expect(isNoticeDismissed('session-error:s2', 'Host unreachable')).toBe(false)
  })

  it('is kept on disk under the synced key, and read back by a new window', () => {
    dismissNotice('away-line', 'mac-away')
    expect(JSON.parse(localStorage.getItem(NOTICE_DISMISS_KEY)!)).toEqual(['away-line|mac-away'])
    expect(NOTICE_DISMISS_KEY.startsWith('open-walnut-')).toBe(true)
    resetNoticeDismissCache()
    expect(isNoticeDismissed('away-line', 'mac-away')).toBe(true)
  })

  it('a scope whose trouble cleared forgets what was closed, so it shows when it comes back', () => {
    dismissNotice('host-down:s1', 'box-a')
    dismissNotice('host-down:s10', 'box-a')
    clearNoticeScope('host-down:s1')
    expect(isNoticeDismissed('host-down:s1', 'box-a')).toBe(false)
    expect(isNoticeDismissed('host-down:s10', 'box-a'), 'only that scope, not one sharing its prefix').toBe(true)
  })

  it('caps each scope family on its own: many request closes never push out a state notice\'s close', () => {
    dismissNotice('session-error:s1', 'Host unreachable')
    for (let i = 0; i < NOTICE_DISMISS_MAX + 50; i++) dismissNotice(`approval-corner`, `req-${i}`)
    for (let i = 0; i < NOTICE_DISMISS_MAX + 50; i++) dismissNotice(`chat-interrupt:turn-${i}`, 'x')
    expect(isNoticeDismissed('session-error:s1', 'Host unreachable')).toBe(true)
    expect(isNoticeDismissed('approval-corner', 'req-0')).toBe(false)
    expect(isNoticeDismissed('approval-corner', `req-${NOTICE_DISMISS_MAX + 49}`)).toBe(true)
    expect(isNoticeDismissed('chat-interrupt:turn-0', 'x')).toBe(false)
    const list = JSON.parse(localStorage.getItem(NOTICE_DISMISS_KEY)!) as string[]
    expect(list.filter((k) => k.startsWith('approval-corner|'))).toHaveLength(NOTICE_DISMISS_MAX)
    expect(list.filter((k) => k.startsWith('chat-interrupt:'))).toHaveLength(NOTICE_DISMISS_MAX)
    // The whole list has its own bound too, the newest kept.
    const many = Array.from({ length: NOTICE_DISMISS_TOTAL + 10 }, (_, i) => `f${i}:s|${i}`)
    const capped = cappedKeys(many)
    expect(capped).toHaveLength(NOTICE_DISMISS_TOTAL)
    expect(capped.at(-1)).toBe(many.at(-1))
  })

  it('drops a scope\'s closes for signatures no longer kept (requests no longer waiting)', () => {
    dismissNotice('approval-corner', 'a')
    dismissNotice('approval-corner', 'b')
    dismissNotice('approval-corner-x', 'a')
    pruneNoticeScope('approval-corner', new Set(['b']))
    expect(isNoticeDismissed('approval-corner', 'a')).toBe(false)
    expect(isNoticeDismissed('approval-corner', 'b')).toBe(true)
    expect(isNoticeDismissed('approval-corner-x', 'a'), 'only that scope').toBe(true)
  })

  it('keeps the newest keys under the cap, and closing again moves a key to the newest end', () => {
    for (let i = 0; i < NOTICE_DISMISS_MAX + 5; i++) dismissNotice('n', String(i))
    expect(isNoticeDismissed('n', '0')).toBe(false)
    expect(isNoticeDismissed('n', String(NOTICE_DISMISS_MAX + 4))).toBe(true)
    dismissNotice('n', '10')
    const list = JSON.parse(localStorage.getItem(NOTICE_DISMISS_KEY)!) as string[]
    expect(list.at(-1)).toBe('n|10')
    expect(list.filter((k) => k === 'n|10')).toHaveLength(1)
  })

  it('reads a broken stored value as nothing closed', () => {
    localStorage.setItem(NOTICE_DISMISS_KEY, '{not json')
    resetNoticeDismissCache()
    expect(isNoticeDismissed('a', 'b')).toBe(false)
  })

  it('takes a notice\'s words from its content for a signature', () => {
    // An element's shape as React builds it: { props: { children } }.
    const node = { props: { children: ['Host ', { props: { children: 'box-a' } }, ' is down ', 3] } }
    expect(noticeText(node)).toBe('Host box-a is down 3')
    expect(noticeText([null, false, 'x'])).toBe('x')
  })
})

describe('in a page', () => {
  const dom = parseHTML('<!DOCTYPE html><html><head></head><body></body></html>')
  const mount = async (node: unknown) => {
    const g = globalThis as unknown as Record<string, unknown>
    g.window = dom.window
    g.document = dom.document
    g.IS_REACT_ACT_ENVIRONMENT = true
    const root = createRoot(dom.document.createElement('div'))
    await act(async () => { root.render(node) })
    return root
  }

  it('listens to other windows once for the page, however many notices read the store', async () => {
    const added: string[] = []
    const removed: string[] = []
    const w = dom.window as unknown as { addEventListener: (t: string) => void; removeEventListener: (t: string) => void }
    const [add, remove] = [w.addEventListener, w.removeEventListener]
    w.addEventListener = function (this: unknown, t: string, ...rest: unknown[]) { if (t === 'storage') added.push(t); return (add as (...a: unknown[]) => void).call(this, t, ...rest) }
    w.removeEventListener = function (this: unknown, t: string, ...rest: unknown[]) { if (t === 'storage') removed.push(t); return (remove as (...a: unknown[]) => void).call(this, t, ...rest) }
    let seen = 0
    const Reader = ({ n }: { n: number }) => { const d = useNoticeDismiss(`chat-interrupt:t${n}`, 'x'); if (d.hidden) seen++; return null }
    try {
      const root = await mount(h('div', null, ...Array.from({ length: 20 }, (_, n) => h(Reader, { key: n, n }))))
      expect(added).toHaveLength(1)
      // A close written by another window reaches every reader through that one listener.
      localStorage.setItem(NOTICE_DISMISS_KEY, JSON.stringify(['chat-interrupt:t3|x']))
      seen = 0
      await act(async () => { dom.window.dispatchEvent(Object.assign(new dom.window.Event('storage'), { key: NOTICE_DISMISS_KEY })) })
      expect(seen).toBe(1)
      await act(async () => { root.unmount() })
      expect(removed).toHaveLength(1)
    } finally {
      w.addEventListener = add
      w.removeEventListener = remove
    }
  })

  it('a closed line shows again when its words change, and when the same words come back later', async () => {
    let line: { shown: boolean; close: () => void } = { shown: false, close: () => {} }
    const Line = ({ v }: { v: string | null }) => { line = useLineClose(v); return null }
    const root = await mount(h(Line, { v: 'Saved' }))
    expect(line.shown).toBe(true)
    await act(async () => { line.close() })
    expect(line.shown).toBe(false)
    await act(async () => { root.render(h(Line, { v: 'Saved again' })) })
    expect(line.shown, 'new words show in the render that brings them').toBe(true)
    await act(async () => { root.render(h(Line, { v: 'Saved' })) })
    expect(line.shown).toBe(true)
    await act(async () => { root.unmount() })
  })
})

describe('forgetting the closes of answered requests', () => {
  it('drops only the named signatures of the scope', async () => {
    const { forgetNotices } = await import('../../web/src/utils/notice-dismiss')
    dismissNotice('approval-corner', 'a')
    dismissNotice('approval-corner', 'b')
    dismissNotice('other', 'a')
    forgetNotices('approval-corner', ['a'])
    expect(isNoticeDismissed('approval-corner', 'a')).toBe(false)
    expect(isNoticeDismissed('approval-corner', 'b')).toBe(true)
    expect(isNoticeDismissed('other', 'a')).toBe(true)
  })
})
