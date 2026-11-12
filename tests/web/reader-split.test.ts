/**
 * The chat's reading split (web/src/components/sessions/reader-split.tsx): the
 * reading pane keeps the text the reader was on and never follows the tail. Unit
 * rules of its place and record, then source ratchets: the pane's timeline is the
 * passive reader that never follows, and every way in goes through the panel's
 * reader api (null wherever the split is not offered, the experiment off included).
 * The behavior is walked by tests/e2e/browser/session-reader-split.spec.ts.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { readerPlaceFrom } from '@/components/sessions/reader-split'
import { clampReaderShare, isPanelView } from '@/components/sessions/panel-view'
import { readerPlaceKey } from '@/components/sessions/reading-place'
import { EXPERIMENTAL_FEATURES } from '../../src/core/experimental'

const WEB = path.resolve(__dirname, '../../web/src')
const read = (rel: string) => fs.readFileSync(path.join(WEB, rel), 'utf8')

interface FakeEl {
  isConnected: boolean; clientHeight: number; clientWidth: number; scrollHeight: number; scrollTop: number
  dataset: Record<string, string>; parentElement: FakeEl | null; top: number; height: number
  getBoundingClientRect: () => { top: number; bottom: number; height: number; left: number; right: number }
  querySelectorAll: (sel: string) => FakeEl[]
  closest: (sel: string) => FakeEl | null
}

function el(top: number, height: number, id?: string, parent: FakeEl | null = null): FakeEl {
  const self: FakeEl = {
    isConnected: true, clientHeight: height, clientWidth: 600, scrollHeight: 5000, scrollTop: 1000,
    dataset: id ? { messageId: id } : {}, parentElement: parent, top, height,
    getBoundingClientRect: () => ({ top: self.top, bottom: self.top + self.height, height: self.height, left: 0, right: 600 }),
    querySelectorAll: () => [],
    closest: (sel) => {
      if (sel !== '[data-message-id]') return null
      for (let at: FakeEl | null = self; at; at = at.parentElement) if (at.dataset.messageId) return at
      return null
    },
  }
  return self
}

/** A box at y=100, 500 tall, with three rows: one started above the edge, two on screen. */
function scene() {
  const box = el(100, 500)
  const rows = [el(40, 200, 'a', box), el(240, 300, 'b', box), el(540, 300, 'c', box)]
  box.querySelectorAll = () => rows
  return { box, rows }
}

describe('reading split: the pane\'s place', () => {
  it('what the reader sees now, never "at the bottom"', () => {
    const { box } = scene()
    box.scrollTop = 4500 // at the end: the pane must still hold this text
    const p = readerPlaceFrom(box as unknown as HTMLElement)!
    expect(p.atBottom).toBe(false)
    expect(p.rows.map((r) => [r.id, r.top])).toEqual([['a', -60], ['b', 140], ['c', 440]])
  })

  it('a message lands near the top; one started above the edge keeps its line there', () => {
    const { box, rows } = scene()
    const below = readerPlaceFrom(box as unknown as HTMLElement, rows[2] as unknown as Element)!
    expect(below.rows).toEqual([{ id: 'c', top: 8, height: 300 }])
    expect(below.atBottom).toBe(false)
    const above = readerPlaceFrom(box as unknown as HTMLElement, rows[0] as unknown as Element)!
    expect(above.rows).toEqual([{ id: 'a', top: -60, height: 200 }])
  })

  it('an element inside a message lands its message, not itself', () => {
    const { box, rows } = scene()
    const footer = el(800, 20, undefined, rows[2])
    expect(readerPlaceFrom(box as unknown as HTMLElement, footer as unknown as Element)!.rows[0].id).toBe('c')
  })

  it('a part with no id of its own moves the rows on screen together', () => {
    const { box } = scene()
    const part = el(400, 120) // no message row around it
    const p = readerPlaceFrom(box as unknown as HTMLElement, part as unknown as Element)!
    // The part sat 300px down; everything moves up 292px so it lands at 8.
    expect(p.rows.map((r) => [r.id, r.top])).toEqual([['a', -352], ['b', -152], ['c', 148]])
  })

  it('the pane keeps its own place per page, apart from the chat\'s', () => {
    expect(readerPlaceKey('', true)).toBe('@reader')
    expect(readerPlaceKey('6.1', true)).toBe('6.1@reader')
    expect(readerPlaceKey('6.1', false)).toBe('6.1')
  })
})

describe('reading split: the panel\'s record', () => {
  it('kept per place, read back only in a shape this build knows', () => {
    expect(isPanelView({ view: null, reader: { on: true } })).toBe(true)
    expect(isPanelView({ view: null, reader: { on: true, orient: 'side', share: 0.4 } })).toBe(true)
    expect(isPanelView({ view: null, reader: { on: true, orient: 'diagonal' } })).toBe(false)
    expect(isPanelView({ view: null, reader: { on: 'yes' } })).toBe(false)
  })

  it('each pane keeps room to read', () => {
    expect(clampReaderShare(undefined)).toBe(0.5)
    expect(clampReaderShare(0.05)).toBe(0.2)
    expect(clampReaderShare(0.95)).toBe(0.8)
    expect(clampReaderShare(Number.NaN)).toBe(0.5)
  })

  it('ships off by default behind its experiment', () => {
    const f = EXPERIMENTAL_FEATURES.find((x) => x.id === 'chat_reading_split')
    expect(f?.default).toBe(false)
  })
})

describe('reading split: ratchets', () => {
  it('the pane\'s timeline is the passive reader and never follows the tail', () => {
    const pane = read('components/sessions/SessionReaderPane.tsx')
    expect(pane).toMatch(/<SessionChatHistory[^>]*readerPane/)
    const history = read('components/sessions/SessionChatHistory.tsx')
    expect(history).toMatch(/const isAtBottom = readerPane \? NEVER_AT_BOTTOM : ownAtBottom;/)
    expect(history).toMatch(/get current\(\) \{ return false; \}/)
    // Its place is its own (readerPlaceKey), and it draws none of the panel-wide chrome.
    expect(history).toMatch(/readerPlaceKey\(placeKeyOf\(stackMode, currentKey\), !!readerPane\)/)
    expect(history).toMatch(/const leftHalf = isSidePage\(treeHalf\) \|\| !!readerPane;/)
    // The panel's timeline publishes while the pane reads.
    expect(read('components/sessions/SessionPanel.tsx')).toMatch(/publishTimeline=\{treeGrid \|\| reader\.shown \? timelineShare : undefined\}/)
  })

  it('every way in reads the panel\'s reader api, which the experiment gates', () => {
    for (const file of ['components/sessions/MessageMetaRow.tsx', 'components/sessions/SessionMessage.tsx']) {
      expect(read(file), file).toMatch(/useSessionReader\(\)/)
    }
    const panel = read('components/sessions/SessionPanel.tsx')
    expect(panel).toMatch(/offered: readingSplitOn && /)
    expect(panel).toMatch(/reader\.api && !reader\.shown \? \{ onSendInSplit: sendInSplit \}/)
    // The pane itself offers no way in to itself.
    expect(read('components/sessions/SessionReaderPane.tsx')).toMatch(/<SessionReaderContext\.Provider value=\{null\}>/)
  })

  it('the pane never lets go of its place, and a new landing is written after the pane it replaces records', () => {
    const history = read('components/sessions/SessionChatHistory.tsx')
    expect(history).toMatch(/const releasePlace = readerPane \? NOOP_RELEASE : readingPlace\.release;/)
    expect(history).not.toMatch(/release: releasePlace/)
    const pane = read('components/sessions/SessionReaderPane.tsx')
    // The landing's writer sits before the keyed timeline (its layout effect runs first, after the old one unmounted).
    expect(pane).toMatch(/<ReaderLanding seq=\{p\.historyKey\} take=\{p\.takeLanding\} \/>\s*<SessionChatHistory key=\{p\.historyKey\}/)
    const split = read('components/sessions/useReaderSplit.ts')
    expect(split).not.toMatch(/keepReaderPlace\(sessionId, pageKey, place\)/)
    // A drag renders nothing per move and ends on every way a pointer can go.
    expect(split).not.toMatch(/setDragShare/)
    for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) expect(split).toContain(`'${ev}', end`)
  })

  it('Send in split opens the pane with the send itself, never before it', () => {
    const input = read('components/chat/ChatInput.tsx')
    expect(input).toMatch(/if \(inSplit\) onSendInSplit\?\.\(\);\n\s*dispatchSend\(/)
    const handler = input.slice(input.indexOf('const handleSendInSplit'), input.indexOf('const hasInput'))
    expect(handler).not.toMatch(/onSendInSplit\?\.\(\)/)
  })

  it('the pane starts below the panel\'s glass header, never under it', () => {
    const css = fs.readFileSync(path.join(WEB, 'styles/reader-split.css'), 'utf8')
    expect(css).toMatch(/\.has-reader > \.session-reader-pane,[\s\S]*?margin-top: var\(--sp-first-flow-top/)
    expect(css).toMatch(/\.is-reader-stack > \.session-panel-body \{\s*--sp-header-h: 0px;/)
  })

  it('the pane mounts only once the column\'s way is known (it lands on its place at mount)', () => {
    expect(read('components/sessions/useReaderSplit.ts')).toMatch(/const paneReady = shown && \(record\.orient !== 'side' \|\| colWidth > 0\);/)
    expect(read('components/sessions/SessionPanel.tsx')).toMatch(/\{reader\.paneReady && \(\s*<>\s*<IslandHostContext\.Provider value=\{islandHost\}>\s*<MessageAboutContext\.Provider[^>]*>\s*<SessionReaderPane/)
  })

  it('a page leaving writes the last place first (a reload runs no timer)', () => {
    const hook = read('components/sessions/useReadingPlace.ts')
    expect(hook).toMatch(/window\.addEventListener\('pagehide', leave\)/)
    expect(hook).toMatch(/window\.removeEventListener\('pagehide', leave\)/)
    expect(read('components/sessions/reading-place.ts')).toMatch(/export function flushPlaces\(\): void \{\n  for \(const sessionId of \[\.\.\.persistTimers\.keys\(\)\]\) writePlaces\(sessionId\);/)
  })

  it('a reader places a sent message where the publisher did, not where its own late mount would', () => {
    const history = read('components/sessions/SessionChatHistory.tsx')
    expect(history).toMatch(/blockIndexMap\.current\.set\(msg\.queueId, readTimeline\?\.sentAt\.get\(msg\.queueId\) \?\? blocks\.length\)/)
    expect(history).toMatch(/if \(publishTimeline\) \{\s*const sentAt = publishTimeline\.sentAt;/)
  })

  it('turning the split lands the pane again on what it showed (its width changes, its text rewraps)', () => {
    const split = read('components/sessions/useReaderSplit.ts')
    const fn = split.slice(split.indexOf('const setOrient = useCallback'), split.indexOf('const share = clampReaderShare'))
    expect(fn).toMatch(/readerPlaceFrom\(box\)/)
    expect(fn).toMatch(/landing\.current = \{ pageKey, place \};\s*setLand\(\(n\) => n \+ 1\);/)
  })

  it('never offered in Tree Mode (its pages are their own split)', () => {
    expect(read('components/sessions/SessionPanel.tsx')).toMatch(/offered: readingSplitOn && !treeMode && /)
  })
})
