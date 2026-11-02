/**
 * RATCHET: SessionPanel decides some things from the phone layout at the moment
 * something happens (a view opening). A window that later crosses into or out of
 * the phone layout keeps that decision unless it is made again: a Board opened at
 * 1280px kept its chat beside it at 520px, where a phone shows the view or the chat,
 * never both (2026-10-31, board-kanban-round4 screens).
 *
 * Every isPhoneLayout() read in the panel is listed with how a layout change reaches
 * it; a new one fails until it is listed.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = readFileSync(join(__dirname, '../../web/src/components/sessions/SessionPanel.tsx'), 'utf8')

/** Each read, by its line, and how a layout change re-decides it. */
const READS: Record<string, string> = {
  "if (isPhoneLayout() || (view === 'inbox' && window.innerWidth < SPLIT_MIN_WIDTH)) {":
    'applyOpenCollapse: the phoneWidth effect calls it again for the open view',
  'if (next) { if (!isPhoneLayout()) enterFullscreen(); applyOpenCollapse(next); } else { collapseChat(false); }':
    'opening a view (toggleView): the phoneWidth effect enters full screen when the window widens',
  'if (isFullscreen || !splitOpen || isPhoneLayout()) return;':
    'a view closes outside full screen except on a phone: the phoneWidth effect keeps a widened view full screen',
}

describe('ratchet: a phone-layout decision follows the window', () => {
  it('every isPhoneLayout() read in SessionPanel is listed', () => {
    const found = SRC.split('\n').map((l) => l.trim()).filter((l) => l.includes('isPhoneLayout()') && !l.startsWith('//'))
    expect([...new Set(found)].sort()).toEqual(Object.keys(READS).sort())
  })

  // Full screen is one state of the tab: a panel that is not the one holding it closes its view instead.
  it('a layout change re-runs what opening a view decided', () => {
    expect(SRC).toMatch(/const phoneWidth = usePhoneLayout\(\);[\s\S]{0,1200}if \(wasPhoneWidth\.current === phoneWidth\) return;[\s\S]{0,300}if \(!phoneWidth && !isFullscreen\) \{[\s\S]{0,300}if \(fullscreenOwner\(\) !== null\) \{ setActiveView\(null\); setFileViewTarget\(null\); return; \}\s*enterFullscreen\(\);\s*\}\s*applyOpenCollapse\(activeView\);/)
  })
})
