/**
 * The draft composer's no-run exit reads "◌ Save as todo".
 *
 * The pill is the text's other exit, so it sits right before the send arrow
 * (ChatInput `sendSlot`), not among the launch settings on the left (user,
 * 2026-10-03). This pins the geometry at the widths a real column reaches: the
 * whole label shows, the button stays inside its column, it never lands on the
 * mic/send cluster, and it shares the arrow's row, immediately to its left. It
 * also pins the send arrow as the ONE start affordance: no "Start ↵" twin.
 */

import { test, expect, type Locator, type Page } from '@playwright/test'
import { draftComposer, draftSend, homeColumns, loadHome, openDraft, seedColumns, setPanelMode } from './draft-helpers'

const SHOTS = process.env.DRAFT_SHOT_DIR ?? '/tmp/draft-save-as-todo'
const LABEL = 'Save as todo'

test.setTimeout(180_000)

/** Seeded, stopped sessions from test-server.ts: they squeeze the draft into a
 *  third, narrow column. */
const SIDS = ['pw-normal-session', 'pw-plan-session-completed'] as const

// Serial: the narrow case drives the app-wide `ui.session_panels` setting.
test.describe.configure({ mode: 'serial' })

/** What the pill shows at this width: the words, "Todo", or the glyph alone. */
type Tier = 'words' | 'short' | 'glyph'

async function expectLabelFits(page: Page, panel: Locator, shot: string, tier: Tier): Promise<void> {
  const later = panel.locator('.draft-later-btn')
  // The words are always the button's name (screen readers, the tooltip), even
  // in a tier that draws only the glyph.
  await expect(later).toHaveAttribute('aria-label', LABEL)
  await expect(later).toHaveAttribute('title', /Save as todo/)
  await expect(later).toBeDisabled()
  await draftComposer(page).fill(`save-as-todo label ${shot}`)
  await expect(later).toBeEnabled()
  const visible = await later.evaluate((btn) => {
    const shown = (sel: string) => {
      const el = btn.querySelector<HTMLElement>(sel)
      return !!el && getComputedStyle(el).display !== 'none'
    }
    // The query container is the controls row's content box.
    const row = btn.closest<HTMLElement>('.chat-input-controls')!
    const rowStyle = getComputedStyle(row)
    const container = Math.round(row.clientWidth - parseFloat(rowStyle.paddingLeft) - parseFloat(rowStyle.paddingRight))
    return { words: shown('.draft-later-words'), short: shown('.draft-later-short'), glyph: shown('.draft-later-glyph'), container }
  })
  const { container, ...shown } = visible
  expect(shown, `tier at ${shot} (controls row ${container}px)`).toEqual({ words: tier === 'words', short: tier === 'short', glyph: true })

  const geo = await panel.evaluate((root) => {
    const btn = root.querySelector('.draft-later-btn') as HTMLElement
    const b = btn.getBoundingClientRect()
    const input = root.querySelector('.session-panel-input')!.getBoundingClientRect()
    // The mic and the send arrow: the cluster the row must never cover.
    const cluster = [...root.querySelectorAll('.mic-btn-wrapper, .chat-send-btn-icon')]
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.width > 0)
    const overlaps = (r: DOMRect) => b.left < r.right && b.right > r.left && b.top < r.bottom && b.bottom > r.top
    const send = root.querySelector('.chat-send-btn-icon')!.getBoundingClientRect()
    const bMid = (b.top + b.bottom) / 2
    return {
      panel: Math.round(root.getBoundingClientRect().width),
      clipped: btn.scrollWidth > btn.clientWidth + 1,
      insideLeft: b.left >= input.left - 1,
      insideRight: b.right <= input.right + 1,
      clusterSize: cluster.length,
      hitsSend: cluster.some(overlaps),
      // Beside the arrow: same row (the button's middle falls inside the arrow's
      // height) and nothing between them (a few px of gap at most).
      sameRow: bMid > send.top && bMid < send.bottom,
      gapToSend: Math.round(send.left - b.right),
    }
  })
  expect(geo.clusterSize, 'mic + send found').toBeGreaterThan(0)
  expect(geo.clipped, `label clipped in a ${geo.panel}px column`).toBe(false)
  expect(geo.insideLeft && geo.insideRight, `button spills out of a ${geo.panel}px column`).toBe(true)
  expect(geo.hitsSend, `button covers the mic/send cluster in a ${geo.panel}px column`).toBe(false)
  expect(geo.sameRow, `button is not on the send arrow's row in a ${geo.panel}px column`).toBe(true)
  expect(geo.gapToSend, `button is ${geo.gapToSend}px left of the send arrow in a ${geo.panel}px column`).toBeGreaterThanOrEqual(0)
  expect(geo.gapToSend).toBeLessThanOrEqual(12)
  // One way to start: the arrow. A plain draft's arrow needs words; it has them now.
  await expect(panel.locator('.draft-start-btn')).toHaveCount(0)
  await expect(draftSend(panel)).toBeEnabled()
  await panel.locator('.session-panel-input').screenshot({ path: `${SHOTS}/composer-${shot}-${geo.panel}px.png` })
}

for (const width of [2400, 1280, 900]) {
  test(`the save-as-todo label fits a lone draft column (${width}px window)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await loadHome(page)
    await expectLabelFits(page, await openDraft(page), `${width}`, 'words')
  })
}

/** Two seeded columns plus the draft: the draft is the third, narrow column. */
async function openThirdColumnDraft(page: Page): Promise<Locator> {
  // Set the count BEFORE seeding columns (eviction is one-way).
  await setPanelMode(page, '2')
  await seedColumns(page, SIDS)
  await loadHome(page)
  await expect(homeColumns(page)).toHaveCount(2, { timeout: 25_000 })
  const panel = await openDraft(page)
  await expect(homeColumns(page)).toHaveCount(3, { timeout: 10_000 })
  return panel
}

test('a three-column 1280px window shows the short label', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await expectLabelFits(page, await openThirdColumnDraft(page), '1280-three-columns', 'short')
})

test('the narrowest column (third of three, 1100px window) shows the glyph alone', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 900 })
  await expectLabelFits(page, await openThirdColumnDraft(page), '1100-three-columns', 'glyph')
})
