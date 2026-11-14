/**
 * Every chat page keeps the reader's place in whichever box shows it
 * (2026-11-09, the user: "when click from main chat and then it jump to bottom
 * while open a another pannel", "it shoudl alwys remmebret the location").
 *
 * The class: a timeline box that shows a page (a mount, another page, the other
 * view) and lands it somewhere the reader did not leave it: the initial-load
 * bottom pin, a forced load scroll, a stack landing measured in another box.
 * Unit rules of reading-place.ts, then source ratchets: the one owner runs in
 * the one timeline every box renders, every forced load scroll stands down for a
 * kept place, and the stack landing defers to it. The behavior is walked in
 * WebKit by tests/e2e/browser/session-reading-place.spec.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { clearPlacesForTest, getPlace, placeKeyOf, setPlace, wantedTop, type ReadingPlace } from '@/components/sessions/reading-place'

const WEB = path.resolve(__dirname, '../../web/src')
const read = (rel: string) => fs.readFileSync(path.join(WEB, rel), 'utf8')

function sources(dir: string): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sources(full))
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push({ file: path.relative(WEB, full), text: fs.readFileSync(full, 'utf8') })
  }
  return out
}

const place = (over: Partial<ReadingPlace> = {}): ReadingPlace => ({
  rows: [{ id: 'm1', top: -300, height: 1200 }, { id: 'm2', top: 900, height: 400 }], width: 1200, atBottom: false, at: 0, ...over,
})

describe('reading place rules', () => {
  beforeEach(() => {
    clearPlacesForTest()
    const mem = new Map<string, string>()
    ;(globalThis as { localStorage?: Storage }).localStorage = {
      getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v) },
      removeItem: (k: string) => { mem.delete(k) }, clear: () => mem.clear(), key: () => null, length: 0,
    } as Storage
  })

  it('the same width keeps the row at the same px', () => {
    expect(wantedTop({ id: 'a', top: -300, height: 1200 }, 1200, 1201, 1200)).toBe(-300)
    expect(wantedTop({ id: 'a', top: 140, height: 400 }, 1200, 1200, 400)).toBe(140)
  })

  it('another width keeps the share of a row that started above the edge, and the px of one below it', () => {
    // Narrower: the row rewrapped to 1800px tall, a quarter of it still above the edge.
    expect(wantedTop({ id: 'a', top: -300, height: 1200 }, 1200, 700, 1800)).toBe(-450)
    expect(wantedTop({ id: 'a', top: 140, height: 400 }, 1200, 700, 640)).toBe(140)
  })

  it('a page keeps one place per session, Main shared by both views', () => {
    setPlace('s1', '', place())
    setPlace('s1', 'q1', place({ atBottom: true }))
    expect(getPlace('s1', '')?.rows[0].id).toBe('m1')
    expect(getPlace('s1', 'q1')?.atBottom).toBe(true)
    expect(getPlace('s2', '')).toBeUndefined()
    // Conversation Mode shows the main conversation: its place is Main's.
    expect(placeKeyOf(false, 'q1')).toBe('')
    expect(placeKeyOf(true, 'q1')).toBe('q1')
  })

  it('the device keeps the newest 30 sessions on disk, so a restart lands there too', () => {
    vi.useFakeTimers()
    try {
      for (let i = 0; i < 32; i++) { setPlace(`s${i}`, '', place()); vi.advanceTimersByTime(500) }
      expect(localStorage.getItem('walnut:reading-place.v1:s0')).toBeNull()
      expect(localStorage.getItem('walnut:reading-place.v1:s1')).toBeNull()
      expect(JSON.parse(localStorage.getItem('walnut:reading-place.v1:s31')!)['']?.rows[0].id).toBe('m1')
      expect(JSON.parse(localStorage.getItem('walnut:reading-place.v1:index')!)).toHaveLength(30)
      // A fresh tab (nothing in memory) reads it back.
      clearPlacesForTest()
      expect(getPlace('s31', '')?.rows[0].id).toBe('m1')
    } finally { vi.useRealTimers() }
  })

  it('a session keeps at most 40 pages, the oldest written dropped first', () => {
    for (let i = 0; i < 45; i++) setPlace('s1', `q${i}`, place())
    expect(getPlace('s1', 'q0')).toBeUndefined()
    expect(getPlace('s1', 'q44')).toBeDefined()
  })
})

describe('one owner of the reading place', () => {
  const history = read('components/sessions/SessionChatHistory.tsx')

  it('every page box is the one timeline that runs it', () => {
    expect(history).toMatch(/useReadingPlace\(\{/)
    // A page's timeline is SessionChatHistory wherever it is drawn; a second
    // timeline component would need its own place keeping.
    const scrollBoxes = sources(WEB).filter((s) => /className=\{?["'`][^"'`]*\bsession-history\b(?!-)/.test(s.text)).map((s) => s.file)
    const NOT_A_PAGE: Record<string, string> = {
      'components/notes/NotesSessionChat.tsx': 'the empty box shown before a note chat has a session, no rows to keep',
    }
    expect(scrollBoxes.filter((f) => !NOT_A_PAGE[f])).toEqual(['components/sessions/SessionChatHistory.tsx'])
  })

  it('no forced load scroll and no bottom pin lands a page with a kept place', () => {
    // Every forced initial-load scroll asks the one gate.
    const forced = history.split('\n').filter((l) => l.includes('!initialLoadDone.current') && /force/i.test(l))
    expect(forced.length).toBeGreaterThanOrEqual(3)
    for (const line of forced) expect(line, line.trim()).toContain('landingOwnedRef.current()')
    // The question-page flag is read only through that gate.
    const direct = history.split('\n').filter((l) => /onQuestionPageRef\.current\b/.test(l) && !/onQuestionPageRef\.current = /.test(l))
    expect(direct.map((l) => l.trim())).toEqual([
      'const landingOwnedRef = useRef(() => onQuestionPageRef.current || readingPlace.held.current);',
      'if (onQuestionPageRef.current) { stop(); return; }',
    ])
    // The bottom pin stops once a stack landing put the box at a passage (Tree Mode's split
    // half lands on the passage asked about), and skips its frames while a kept place holds.
    expect(history).toMatch(/if \(onQuestionPageRef\.current\) \{ stop\(\); return; \}\n[^\n]*\n[^\n]*\n\s*if \(landingOwnedFor\.current === sessionId\) \{ stop\(\); return; \}\n[^\n]*\n[^\n]*\n\s*if \(readingPlace\.held\.current\) \{ raf = requestAnimationFrame\(pin\); return; \}/)
  })

  it('hidden timelines pause pending restores and stop initial pins before held-place gates', () => {
    const hook = read('components/sessions/useReadingPlace.ts')
    expect(hook).toContain('if (!shownRef.current || !p || !el) return;')
    expect(hook).toContain('pending.current.until = Math.max(pending.current.until, performance.now() + PENDING_MS);')
    expect(hook).toContain('recordOwed.current ||= recordTimer.current !== undefined && dirty.current && !moved.current;')
    expect(hook).toContain('if (recordOwed.current && dirty.current && !moved.current) record();')
    const pin = history.slice(history.indexOf('const pin = () => {'))
    expect(pin.indexOf('!routeShownRef.current || Date.now() - started > 15_000')).toBeLessThan(pin.indexOf('readingPlace.held.current'))
  })

  it('the stack landing defers to a kept place', () => {
    expect(history).toMatch(/useThreadLanding\(\{[\s\S]*?placeAt: readingPlace\.placeAt, keepPlace: readingPlace\.keep, adoptPlace: readingPlace\.adopt, placeHeld: placeHeldFn/)
    const landing = read('hooks/useThreadLanding.ts')
    expect(landing).toContain('if (reenabled && (placeAt?.(stack.currentKey) !== undefined || argsRef.current.placeHeld?.())) return;')
    expect(landing).toContain('if (keptAt !== undefined && !ownPop) {')
    // The page a box leaves is kept as the box shows it, before its rows swap.
    expect(landing).toMatch(/setCapture\(\(from, to, pending\) => \{[\s\S]{0,120}keepPlace\?\.\(from\)/)
  })
})
