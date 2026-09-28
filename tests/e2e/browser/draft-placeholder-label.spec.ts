/**
 * The draft composer's no-run exit reads "◌ Create task placeholder without running".
 *
 * The label is long for a pill in a wrapping controls row, and the button never
 * shrinks (flex-shrink 0, nowrap), so this pins the geometry at the widths a real
 * column reaches: the whole label shows, the button stays inside its column, and it
 * never lands on the mic/send cluster.
 */

import { test, expect, type Locator, type Page } from '@playwright/test'
import { draftComposer, homeColumns, loadHome, openDraft, seedColumns, setPanelMode } from './draft-helpers'

const SHOTS = process.env.DRAFT_SHOT_DIR ?? '/tmp/draft-placeholder-label'
const LABEL = 'Create task placeholder without running'

test.setTimeout(180_000)

/** Seeded, stopped sessions from test-server.ts: they squeeze the draft into a
 *  third, narrow column. */
const SIDS = ['pw-normal-session', 'pw-plan-session-completed'] as const

// Serial: the narrow case drives the app-wide `ui.session_panels` setting.
test.describe.configure({ mode: 'serial' })

async function expectLabelFits(page: Page, panel: Locator, shot: string): Promise<void> {
  const later = panel.locator('.draft-later-btn')
  await expect(later).toContainText(LABEL)
  await expect(later).toBeDisabled()
  await draftComposer(page).fill(`placeholder label ${shot}`)
  await expect(later).toBeEnabled()

  const geo = await panel.evaluate((root) => {
    const btn = root.querySelector('.draft-later-btn') as HTMLElement
    const b = btn.getBoundingClientRect()
    const input = root.querySelector('.session-panel-input')!.getBoundingClientRect()
    // The mic and the send arrow: the cluster the row must never cover.
    const cluster = [...root.querySelectorAll('.mic-btn-wrapper, .chat-send-btn-icon')]
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.width > 0)
    const overlaps = (r: DOMRect) => b.left < r.right && b.right > r.left && b.top < r.bottom && b.bottom > r.top
    return {
      panel: Math.round(root.getBoundingClientRect().width),
      clipped: btn.scrollWidth > btn.clientWidth + 1,
      insideLeft: b.left >= input.left - 1,
      insideRight: b.right <= input.right + 1,
      clusterSize: cluster.length,
      hitsSend: cluster.some(overlaps),
    }
  })
  expect(geo.clusterSize, 'mic + send found').toBeGreaterThan(0)
  expect(geo.clipped, `label clipped in a ${geo.panel}px column`).toBe(false)
  expect(geo.insideLeft && geo.insideRight, `button spills out of a ${geo.panel}px column`).toBe(true)
  expect(geo.hitsSend, `button covers the mic/send cluster in a ${geo.panel}px column`).toBe(false)
  await panel.locator('.session-panel-input').screenshot({ path: `${SHOTS}/composer-${shot}-${geo.panel}px.png` })
}

for (const width of [2400, 1280, 900]) {
  test(`the placeholder label fits a lone draft column (${width}px window)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await loadHome(page)
    await expectLabelFits(page, await openDraft(page), `${width}`)
  })
}

test('the placeholder label fits the narrowest column (third of three, 1100px window)', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 900 })
  // Set the count BEFORE seeding columns (eviction is one-way).
  await setPanelMode(page, '2')
  await seedColumns(page, SIDS)
  await loadHome(page)
  await expect(homeColumns(page)).toHaveCount(2, { timeout: 25_000 })
  const panel = await openDraft(page)
  await expect(homeColumns(page)).toHaveCount(3, { timeout: 10_000 })
  await expectLabelFits(page, panel, '1100-three-columns')
})
