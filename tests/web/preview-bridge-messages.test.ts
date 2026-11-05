/**
 * The HTML preview's bridge carries only its named messages, each checked for its shape on
 * both sides (src/web/preview-bridge-script.ts for the page, preview-messages.ts for the console).
 * The page is untrusted: its own scripts can post anything the bridge posts.
 */
import { describe, it, expect } from 'vitest'
import { readFrameMsg } from '../../web/src/components/common/preview-messages'
import { PREVIEW_BRIDGE_JS } from '../../src/web/preview-bridge-script'

const m = (o: Record<string, unknown>) => ({ walnutPreview: 1, ...o })

// Node has no DOMRect: the console builds its rects with it.
if (typeof DOMRect === 'undefined') {
  ;(globalThis as Record<string, unknown>).DOMRect = class {
    constructor(public x = 0, public y = 0, public width = 0, public height = 0) {}
    get left() { return this.x }
    get top() { return this.y }
    get right() { return this.x + this.width }
    get bottom() { return this.y + this.height }
  }
}

describe('the console takes only the bridge\'s messages, of their shape', () => {
  it('takes each named message', () => {
    expect(readFrameMsg(m({ type: 'ready', href: 'http://x/a.html', top: 0 }))).toEqual({ type: 'ready', href: 'http://x/a.html', top: 0 })
    expect(readFrameMsg(m({ type: 'scroll', top: 10, rect: null }))?.type).toBe('scroll')
    expect(readFrameMsg(m({ type: 'selection', text: 'hi', rect: { left: 1, top: 2, width: 3, height: 4 }, x: 1, y: 2, v: 3, start: 0, end: 2 })))
      .toEqual({ type: 'selection', text: 'hi', rect: { left: 1, top: 2, width: 3, height: 4 }, x: 1, y: 2, v: 3, start: 0, end: 2 })
    expect(readFrameMsg(m({ type: 'text', v: 1, text: 'abc', over: false }))).toEqual({ type: 'text', v: 1, text: 'abc', over: false })
    expect(readFrameMsg(m({ type: 'link', href: '/x', handled: true }))).toEqual({ type: 'link', href: '/x', handled: true })
    expect(readFrameMsg(m({ type: 'press', href: '/x' }))).toEqual({ type: 'press', href: '/x' })
    expect(readFrameMsg(m({ type: 'link-menu', href: 'https://a.example/', x: 3, y: 4 }))?.type).toBe('link-menu')
    const rects = readFrameMsg(m({ type: 'rects', marks: [{ group: 'threads', id: 'm1', r: [[1, 2, 3, 4]], t: [], c: [0, 0, 10, 10] }] }))
    expect(rects?.type === 'rects' && rects.marks[0]!.r[0]!.right).toBe(4)
    expect(readFrameMsg(m({ type: 'click', hits: [{ group: 'comments', id: 'm2' }] }))).toEqual({ type: 'click', hits: [{ group: 'comments', id: 'm2' }] })
    expect(readFrameMsg(m({ type: 'find-result', count: 3, index: 1 }))).toEqual({ type: 'find-result', count: 3, index: 1 })
    for (const type of ['escape', 'user', 'find-key']) expect(readFrameMsg(m({ type }))).toEqual({ type })
  })

  it('drops anything else', () => {
    const bad: unknown[] = [
      null, 'ready', { type: 'ready', href: '/a', top: 0 }, // no marker
      m({ type: 'eval', code: 'x' }), m({ type: 'storage' }), m({}),
      m({ type: 'ready', href: 5, top: 0 }), m({ type: 'ready', href: 'x'.repeat(9000), top: 0 }),
      m({ type: 'scroll', top: Number.NaN, rect: null }), m({ type: 'scroll', top: 1, rect: { left: 'a' } }),
      m({ type: 'selection', text: 'x'.repeat(20_001), rect: null, x: 0, y: 0 }),
      m({ type: 'text', v: -1, text: '', over: false }), m({ type: 'text', v: 1.5, text: '', over: false }), m({ type: 'text', v: 1, text: 1, over: false }),
      m({ type: 'link', href: '/x', handled: 'yes' }),
      m({ type: 'rects', marks: [{ group: 'Threads!', id: 'm1', r: [] }] }), m({ type: 'rects', marks: [{ group: 'threads', id: 'm1', r: [[1, 2, 3]] }] }),
      m({ type: 'rects', marks: Array.from({ length: 201 }, (_, i) => ({ group: 'threads', id: `m${i}`, r: [] })) }),
      m({ type: 'click', hits: [{ group: 'threads', id: 'x'.repeat(65) }] }), m({ type: 'hover', hits: 'm1' }),
      m({ type: 'find-result', count: -1, index: 0 }),
    ]
    for (const b of bad) expect(readFrameMsg(b), JSON.stringify(b)?.slice(0, 80)).toBeNull()
  })
})

describe('the page\'s side', () => {
  it('parses, and cannot end the script element it rides in', () => {
    expect(() => new Function(PREVIEW_BRIDGE_JS)).not.toThrow()
    expect(PREVIEW_BRIDGE_JS).not.toMatch(/<\/script|<!--/i)
  })

  it('takes messages from its parent only, and only its named ones, each checked', () => {
    expect(PREVIEW_BRIDGE_JS).toContain("if (e.source !== P) return;")
    const handler = PREVIEW_BRIDGE_JS.slice(PREVIEW_BRIDGE_JS.indexOf("addEventListener('message'"))
    const types = [...handler.matchAll(/case '([a-z-]+)':/g)].map((x) => x[1]).sort()
    expect(types).toEqual(['clear-selection', 'find', 'find-close', 'find-nav', 'handled', 'marks', 'reveal', 'scroll-by', 'scroll-to', 'style'])
    // Nothing the console sends is ever run, written as markup, or navigated to.
    expect(PREVIEW_BRIDGE_JS).not.toMatch(/\beval\(|new Function|innerHTML|outerHTML|insertAdjacentHTML|document\.write|location\s*=|location\.href\s*=/)
  })
})
