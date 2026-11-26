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

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p))
    else if (/\.tsx?$/.test(name) && !name.endsWith('.d.ts')) out.push(p)
  }
  return out
}

/** Code that scrolls something sideways but is no strip of choices, each with why. A strip of
 *  choices (tabs, segments, a menu's row of picks, a panel's sections) uses utils/strip-edges.ts. */
const OWN_SIDEWAYS_SCROLL: Record<string, string> = {
  'utils/strip-edges.ts': 'the shared strip hook itself',
  'utils/page-find-geometry.ts': 'brings a find match into view in any scroller',
  'utils/overlay-exit.ts': 'puts back the scroll an overlay saved',
  'utils/code-block-actions.ts': 'keeps a code block and its line rail scrolled together',
  'pages/hold-strip-animation.ts': 'puts back scroll positions after an animation',
  'pages/useHomeKeyboard.ts': 'brings a board column into view',
  'components/sessions/SessionChatHistory.tsx': 'brings a thread card into view',
  'components/sessions/ThreadCommentCard.tsx': 'brings a comment card into view',
  'components/sessions/DraftWhereColumns.tsx': 'a column browser that shows its newest column',
  'components/sessions/path-selector/GhostTextInput.tsx': 'keeps a text overlay under its input',
  'components/dock/FocusDock.tsx': 'brings a task card of the dock into view',
  'components/common/PdfFind.tsx': 'brings a PDF page into view',
  'components/common/PdfPreview.tsx': 'zooms a PDF around a point',
  'components/board/kanban/BoardKanban.tsx': 'brings a board column or card into view',
  'components/board/kanban/KanbanAddTask.tsx': 'brings the add-task form into view',
  'components/tasks/HomeBoardSheet.tsx': 'brings a board card into view',
  'components/tasks/useInlineTitleEdit.ts': 'shows the start of a title being edited',
}

/** A line that scrolls an element sideways. */
const SIDEWAYS = /\.scrollLeft\s*[-+]?=(?!=)|scrollIntoView\([^)]*inline|scroll(To|By)\(\{[^}]*left/

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
    for (const f of ['components/controls/Tabs.tsx', 'components/settings/inputs/SegmentedControl.tsx', 'components/common/NotificationPanel.tsx', 'components/tasks/PinShortcutChoices.tsx']) {
      expect(readFileSync(join(root, f), 'utf8'), f).toMatch(/useStripEdges\(/)
    }
    const pc = readFileSync(join(root, 'components/settings/sections/cloud/PhonesCloudTabs.tsx'), 'utf8')
    expect(pc).not.toMatch(/data-more=/)
  })

  // 2026-11-26: the terminal tabs, the Home bar and the notes tabs each kept their own
  // scroll-into-view (and the terminal its own fade) beside the shared one, and the bell panel's
  // sections and a menu's Pin to row, built by hand, scrolled without saying so.
  it('nothing else scrolls a strip sideways or marks its edges itself', () => {
    const hits: string[] = []
    for (const f of sourceFiles(WEB_SRC)) {
      const rel = relative(WEB_SRC, f)
      const src = readFileSync(f, 'utf8')
      for (const [i, line] of src.split('\n').entries()) {
        if (!OWN_SIDEWAYS_SCROLL[rel] && SIDEWAYS.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim()}`)
        if (rel !== 'utils/strip-edges.ts' && /data-strip-more|fade-(left|right)\b/.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim()}`)
      }
    }
    expect(hits).toEqual([])
  })

  it('every exempt file still scrolls sideways (a stale exemption is removed)', () => {
    for (const rel of Object.keys(OWN_SIDEWAYS_SCROLL)) {
      expect(readFileSync(join(WEB_SRC, rel), 'utf8'), rel).toMatch(SIDEWAYS)
    }
  })
})
