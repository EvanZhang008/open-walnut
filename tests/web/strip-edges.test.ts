/**
 * utils/strip-edges.ts: which edges of a sideways-scrolling choice strip have more past them, and
 * how far to scroll so the picked item shows. TabList and SegmentedControl use it, so every strip
 * marks its edges the same way (Phones & Cloud kept its own copy until 2026-11-26).
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { PICK_MARGIN, scrollToShow, stripMore } from '../../web/src/utils/strip-edges'

const WEB_SRC = join(__dirname, '..', '..', 'web', 'src')

function tsxFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...tsxFiles(p))
    else if (name.endsWith('.tsx')) out.push(p)
  }
  return out
}

/** Files that render a strip but scroll sideways for another element (not one of the strip's items). */
const OWN_SIDEWAYS_SCROLL: Record<string, string> = {
  'components/sessions/SessionChatHistory.tsx': 'brings a thread card into view, not a strip item',
  'components/chat/MentionPalette.tsx': "its data-more marks the mention list's own bottom, which scrolls down",
}

describe('strip edges', () => {
  it('names the sides with more past them', () => {
    expect(stripMore({ scrollLeft: 0, clientWidth: 300, scrollWidth: 300 })).toBe('')
    expect(stripMore({ scrollLeft: 0, clientWidth: 300, scrollWidth: 500 })).toBe('right')
    expect(stripMore({ scrollLeft: 200, clientWidth: 300, scrollWidth: 500 })).toBe('left')
    expect(stripMore({ scrollLeft: 100, clientWidth: 300, scrollWidth: 500 })).toBe('left right')
  })

  it('brings the pick clear of the 36 px edge fade, and stops at either end', () => {
    expect(PICK_MARGIN).toBeGreaterThan(36)
    const strip = { scrollLeft: 0, clientWidth: 300, scrollWidth: 600 }
    // Already clear of both fades.
    expect(scrollToShow(strip, 60, 80)).toBeNull()
    // Inside the right fade though not cut: moved clear of it.
    expect(scrollToShow(strip, 200, 80)).toBe(200 + 80 + PICK_MARGIN - 300)
    // Past the left edge: moved clear of the left fade.
    expect(scrollToShow({ ...strip, scrollLeft: 200 }, 220, 80)).toBe(220 - PICK_MARGIN)
    // The first and the last items: the strip stops at its end, where no fade is drawn.
    expect(scrollToShow({ ...strip, scrollLeft: 50 }, 5, 80)).toBe(0)
    expect(scrollToShow(strip, 520, 80)).toBe(300)
    expect(scrollToShow({ ...strip, scrollLeft: 300 }, 520, 80)).toBeNull()
  })

  it('both shared strips use it, and no screen keeps its own copy', () => {
    const root = join(__dirname, '..', '..', 'web', 'src')
    for (const f of ['components/controls/Tabs.tsx', 'components/settings/inputs/SegmentedControl.tsx']) {
      expect(readFileSync(join(root, f), 'utf8'), f).toMatch(/useStripEdges\(/)
    }
    const pc = readFileSync(join(root, 'components/settings/sections/cloud/PhonesCloudTabs.tsx'), 'utf8')
    expect(pc).not.toMatch(/data-more=/)
  })

  // 2026-11-26 review: the terminal tabs, the Home bar and the notes tabs each kept their own
  // scroll-into-view (and the terminal its own fade) beside the shared one, two writers on one strip.
  it('no screen that renders a strip scrolls it sideways or fades it itself', () => {
    const hits: string[] = []
    for (const f of tsxFiles(WEB_SRC)) {
      const src = readFileSync(f, 'utf8')
      if (!/<(TabList|SegmentedControl)\b/.test(src)) continue
      const rel = relative(WEB_SRC, f)
      if (OWN_SIDEWAYS_SCROLL[rel]) continue
      for (const [i, line] of src.split('\n').entries()) {
        if (/scrollIntoView\([^)]*inline|\.scrollLeft\s*=[^=]|fade-(left|right)|data-more/.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim()}`)
      }
    }
    expect(hits).toEqual([])
  })
})
