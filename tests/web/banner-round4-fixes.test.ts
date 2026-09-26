/**
 * Attention card, fixer round 4 (nitpick round 3 + verifier items), the pure parts:
 *   N3-1   an undo line keeps its row's height in every mount (no pointer rule)
 *   N3-2   Open Settings lands the row in the upper part of the pane
 *   N3-3   a short mount with both sections takes the fitted form
 *   N3-13  undo lines name what they hid
 *   N3-18  the host list ends on a whole row
 *   N3-8   rows scrolled above are counted
 *   C42    the notification panel's Tab trap drives every Tab (WebKit skips buttons)
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseHTML } from 'linkedom'
import { createElement, act } from '../../web/node_modules/react/index.js'
import { createRoot } from '../../web/node_modules/react-dom/client.js'

vi.mock('@/utils/log', () => ({ log: { info: () => {}, warn: () => {}, error: () => {} } }))

const { scrollMaxPx, fitsTight, FIT_CAP_PX, rowsAbove, rowsBelow, nextCompact } = await import('../../web/src/components/common/banner-scroll')
const { UndoLine, undoRowText, undoAllText, UNDO_ROW_TEXT, UNDO_ALL_TEXT } = await import('../../web/src/components/common/banner-undo')
const { landingScrollTop, LAND_FRACTION } = await import('../../web/src/utils/scroll-land')
const { nextTabStop } = await import('../../web/src/hooks/useDialogFocus')

describe('undo lines name what they hid (N3-13)', () => {
  it('one host: its label; several hosts in one row: how many', () => {
    expect(undoRowText(['Cert box'])).toBe('Cert box hidden until it changes.')
    expect(undoRowText(['Key box', 'Net box'])).toBe('2 hosts hidden until they change.')
    expect(undoRowText([])).toBe(UNDO_ROW_TEXT)
  })
  it('Dismiss all: how many hosts, or the one host by name', () => {
    expect(undoAllText(4)).toBe('4 hosts hidden until they change.')
    expect(undoAllText(1, 'Net box')).toBe('Net box hidden until it changes.')
    expect(undoAllText(0)).toBe(UNDO_ALL_TEXT)
  })
})

describe('the host list ends on a whole row (N3-18)', () => {
  const lines = [18, 46, 70, 98, 122, 150, 174, 202, 226, 254]
  const rows = [46, 98, 150, 202, 254]
  it('a headline line that fits where its buttons do not is not an end: the last whole row is', () => {
    // cap 300, rest 70: 230 for the list. Before N3-18 this ended at 226 (a headline with its Retry cut off).
    expect(scrollMaxPx(300, 70, 48, 254, lines, rows)).toBe(202)
  })
  it('the 1280x800 report: 147px of room shows two whole rows, not two and a half', () => {
    expect(scrollMaxPx(320, 173, 46, 201, [18, 46, 70, 98, 122, 150, 201], [46, 98, 150, 201])).toBe(98)
  })
  it('not even one whole row fits (an opened row taller than the room): a line boundary inside it', () => {
    expect(scrollMaxPx(200, 80, 40, 300, [18, 46, 90, 171, 300], [171, 300])).toBe(90)
  })
  it('without row bottoms (older callers) the line rule stands', () => {
    expect(scrollMaxPx(300, 70, 48, 254, lines)).toBe(226)
  })
})

describe('the fitted form (N3-3)', () => {
  it('only with both sections, and only under the fit cap', () => {
    // 980x600: cap 220 with the local sign-in and hosts: fitted.
    expect(fitsTight(220, true)).toBe(true)
    // 1280x800: cap 320: the regular two-line rows fit.
    expect(fitsTight(320, true)).toBe(false)
    // Hosts alone at 600px keep their two-line rows.
    expect(fitsTight(220, false)).toBe(false)
    expect(fitsTight(null, true)).toBe(false)
    expect(fitsTight(FIT_CAP_PX, true)).toBe(false)
  })
})

describe('one-line rows inside the fitted form (N3-3, N1)', () => {
  it('only when the room under the cap cannot hold the first row in its two-line form', () => {
    // 980x600: 51px of room, the first row 64px tall (its headline wraps): one-line rows.
    expect(nextCompact(false, 51, 64)).toBe(true)
    // 1280x600: 51px of room, a 46px first row: it stays two lines (N1: headline and a whole button).
    expect(nextCompact(false, 51, 46)).toBe(false)
  })
  it('leaves one-line rows only with 6px to spare, so a re-layout cannot flip it back and forth', () => {
    expect(nextCompact(true, 50, 46)).toBe(true)
    expect(nextCompact(true, 52, 46)).toBe(false)
  })
})

describe('scroll cues both ways (N3-8)', () => {
  it('rows scrolled above count like rows below: by their last line', () => {
    // The list's top at 200: rows ending at 100 and 160 are gone, one ending at 205 shows
    // less than a line (12px) so it counts as above too; one ending at 215 still shows its last line.
    expect(rowsAbove(200, [100, 160, 205, 260])).toBe(3)
    expect(rowsAbove(200, [215, 260])).toBe(0)
    expect(rowsBelow(350, [200, 260, 345])).toBe(1)
  })
})

describe('Open Settings lands in the upper part of the pane (N3-2)', () => {
  it('the row top ends at a fifth of the pane height', () => {
    // An 800px pane, the row 732px down, unscrolled: scroll so its top is at 160.
    expect(landingScrollTop(0, 732, 800, 5000)).toBe(732 - Math.round(800 * LAND_FRACTION))
    expect(landingScrollTop(0, 732, 800, 5000)).toBe(572)
  })
  it('never past either end of the scroll range', () => {
    expect(landingScrollTop(0, 50, 800, 5000)).toBe(0)
    expect(landingScrollTop(0, 900, 800, 300)).toBe(300)
  })
  it('late layout that pushed the row down is corrected from where the pane already is', () => {
    // Already scrolled 572 and the row now reads 268px down (content above it grew 108px): 108 more.
    expect(landingScrollTop(572, 268, 800, 5000)).toBe(680)
  })
})

describe('the notification panel Tab trap (C42, C25)', () => {
  const el = (name: string) => {
    const node = { name, compareDocumentPosition: (o: { order: number }) => (o.order > node.order ? 4 : 2), order: 0 }
    return node
  }
  const a = { ...el('a'), order: 1 }, b = { ...el('b'), order: 2 }, c = { ...el('c'), order: 3 }
  const stops = [a, b, c] as unknown as HTMLElement[]
  it('moves on every Tab, middle included (WebKit would skip the rail buttons)', () => {
    expect(nextTabStop(stops, stops[0], false)).toBe(stops[1])
    expect(nextTabStop(stops, stops[1], true)).toBe(stops[0])
  })
  it('wraps at both ends', () => {
    expect(nextTabStop(stops, stops[2], false)).toBe(stops[0])
    expect(nextTabStop(stops, stops[0], true)).toBe(stops[2])
  })
  it('from nowhere (focus lost): the first stop, or the last going back', () => {
    expect(nextTabStop(stops, null, false)).toBe(stops[0])
    expect(nextTabStop(stops, null, true)).toBe(stops[2])
    expect(nextTabStop([], null, false)).toBeNull()
  })
})

let doc: Document
let root: { render: (n: unknown) => void; unmount: () => void } | null = null
let host: HTMLElement
beforeAll(() => {
  const dom = parseHTML('<!DOCTYPE html><html><head></head><body></body></html>')
  const g = globalThis as unknown as Record<string, unknown>
  g.window = dom.window
  g.document = dom.document
  g.IS_REACT_ACT_ENVIRONMENT = true
  doc = dom.document as unknown as Document
})
beforeEach(() => {
  host = doc.createElement('div')
  doc.body.appendChild(host)
  root = createRoot(host)
})
afterEach(async () => {
  if (root) { await act(async () => { root!.unmount() }); root = null }
  doc.body.innerHTML = ''
})

describe('an undo line holds its row height in every mount (N3-1)', () => {
  const entry = (shownAt: number) => ({
    id: 'row:cred:cert_expired', kind: 'row' as const, index: 1, height: 46, shownAt, collapsing: false,
    text: 'Cert box hidden until it changes.', restore: () => {},
  })
  it('a line that moved in from another mount (old shownAt, pointer elsewhere) is still 46px tall and names its host', async () => {
    await act(async () => {
      root!.render(createElement('ul', null, createElement(UndoLine, { entry: entry(Date.now() - 2_000), text: UNDO_ROW_TEXT, onUndo: () => {} })))
    })
    const li = host.querySelector('[data-testid="hpb-undo-row"]') as HTMLElement
    expect(li.getAttribute('style') ?? '').toMatch(/min-height:\s*46px/)
    expect(li.querySelector('.hpb-undo-text')?.textContent).toBe('Cert box hidden until it changes.')
    // UndoLine has no pointer input any more: nothing can make the line grow when the pointer comes back.
    expect(Object.keys((UndoLine as unknown as { propTypes?: object }).propTypes ?? {})).not.toContain('hold')
  })
})
