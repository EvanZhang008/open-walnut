// What some cards' × does (2026-11-27, the user's rule: every card or notice in front of him has a
// visible close): an approval's × never answers it, and a crashed region's × folds its error, keeping Retry.
import { beforeEach, describe, expect, it } from 'vitest'
import { createElement } from '../../web/node_modules/react/index.js'
import { renderToStaticMarkup } from '../../web/node_modules/react-dom/server.node.js'
import { resetNoticeDismissCache } from '../../web/src/utils/notice-dismiss'
import { closeInCorner, closedInCorner, forgetClosedInCorner, shownInCorner } from '../../web/src/components/approvals/ApprovalPrompts'
import { RegionErrorBoundary } from '../../web/src/components/common/RegionErrorBoundary'

class MemStorage {
  private m = new Map<string, string>()
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null }
  setItem(k: string, v: string) { this.m.set(k, String(v)) }
  removeItem(k: string) { this.m.delete(k) }
  clear() { this.m.clear() }
}

beforeEach(() => {
  ;(globalThis as { localStorage?: unknown }).localStorage = new MemStorage()
  resetNoticeDismissCache()
})

describe("an approval card's × in the corner", () => {
  const a = { id: 'ap-1' }
  const b = { id: 'ap-2' }
  const c = { id: 'ap-3' }

  it('hides every request waiting then, and answers none of them', () => {
    expect(shownInCorner([a, b])).toEqual([a, b])
    closeInCorner([a, b])
    expect(shownInCorner([a, b])).toEqual([])
    expect(closedInCorner('ap-1')).toBe(true)
    // One of them answered elsewhere: the rest stay off the corner.
    expect(shownInCorner([b])).toEqual([])
  })

  it('comes back, whole, when a new request comes', () => {
    closeInCorner([a, b])
    // The corner shows the first that came, with every one still waiting in its count.
    expect(shownInCorner([a, b, c])).toEqual([a, b, c])
  })

  it('forgets only the closes of requests this window saw go, never one another window just made', () => {
    forgetClosedInCorner(['ap-1'])
    closeInCorner([a])
    // Another window, with a newer list, closed ap-2 that this window has not seen yet.
    closeInCorner([b])
    forgetClosedInCorner(['ap-1'])
    expect(closedInCorner('ap-2')).toBe(true)
    // ap-1 was answered: this window saw it waiting, and now its close goes.
    forgetClosedInCorner([])
    expect(closedInCorner('ap-1')).toBe(false)
    expect(closedInCorner('ap-2')).toBe(true)
  })

  it('is kept where every window reads it', () => {
    closeInCorner([a])
    resetNoticeDismissCache()
    expect(closedInCorner('ap-1')).toBe(true)
    expect(closedInCorner('ap-2')).toBe(false)
  })
})

type Boundary = InstanceType<typeof RegionErrorBoundary>

/** A boundary that has caught `error`, with setState applied in place (no DOM in this run). */
function crashed(props: Partial<Boundary['props']>): Boundary {
  const b = new RegionErrorBoundary({ region: 'composer', children: null, ...props } as Boundary['props'])
  b.state = { ...b.state, ...RegionErrorBoundary.getDerivedStateFromError(new Error('boom')) }
  b.setState = ((patch: Partial<Boundary['state']>) => { b.state = { ...b.state, ...patch } }) as Boundary['setState']
  return b
}
const html = (b: Boundary) => { const out = b.render(); return out ? renderToStaticMarkup(out) : '' }
const close = (b: Boundary) => (b as unknown as { close: () => void }).close()

describe("a crashed region's ×", () => {
  it('a small region folds its error to one line that keeps Retry, never an empty region', () => {
    const b = crashed({ compact: true })
    expect(html(b)).toContain('region-error-close')
    expect(html(b)).toContain('Retry')
    close(b)
    // The composer's crash card is the only way back to the composer: folded, Retry stays.
    expect(html(b)).toContain('data-folded="true"')
    expect(html(b)).toContain('>Retry</button>')
    expect(html(b)).toContain('The message box: error')
    expect(html(b)).not.toContain('region-error-close')
    // A new crash shows in full again.
    b.state = { ...b.state, ...RegionErrorBoundary.getDerivedStateFromError(new Error('again')) }
    expect(html(b)).toContain('region-error-close')
  })

  it("a whole panel's error closes only through its owner's close", () => {
    expect(html(crashed({ region: 'session-panel' }))).not.toContain('region-error-close')
    let closed = 0
    const b = crashed({ region: 'session-panel', onClose: () => { closed += 1 } })
    expect(html(b)).toContain('aria-label="Close"')
    close(b)
    expect(closed).toBe(1)
    // The owner decides what goes: the boundary itself keeps showing until then.
    expect(html(b)).toContain('region-error')
  })
})
