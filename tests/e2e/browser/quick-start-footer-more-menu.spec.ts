import { test, expect, type Page } from '@playwright/test'
import {
  bootDecisions, draftCwdPill, draftDecisionChip, isoDay, openDraft, typeAndSettle,
} from './draft-helpers'

/** Flip `ui.show_priority` on the fixture server (merging the rest of `ui`), the
 *  same way task-filters.spec.ts does. GET /api/config wraps the file under
 *  `config`; the merge keeps sibling keys alive. */
async function setShowPriority(page: Page, on: boolean): Promise<void> {
  const body = (await (await page.request.get('/api/config')).json()) as { config?: { ui?: Record<string, unknown> } }
  const res = await page.request.put('/api/config', { data: { ui: { ...(body.config?.ui ?? {}), show_priority: on } } })
  if (!res.ok()) throw new Error(`config write failed: ${res.status()} ${await res.text()}`)
}

test('Quick Start footer keeps primary controls visible and opens task settings upward', async ({ page }) => {
  // No pin-tier seeding: the tier is no longer sticky (and no longer mirrored to
  // the shared fixture's ui-prefs), so every launcher opens on Focus whatever
  // any other spec picked. That is what makes the assertion below stable.
  await page.goto('/')

  // The launcher is reached through a DRAFT session column now: "+" grows the
  // column, its cwd pill opens this same picker (unchanged `.sps-*` markup).
  const panel = await openDraft(page)
  await panel.locator('.draft-composer-bar .session-action-chip').first().click()

  const selector = page.locator('.session-path-selector')
  await expect(selector).toBeVisible({ timeout: 10_000 })

  const footer = selector.locator('.sps-meta-footer')
  await expect(footer.getByRole('combobox', { name: 'Session model' })).toBeVisible()
  await expect(footer.getByRole('group', { name: 'Coding agent engine' })).toBeVisible()
  // The pin tier is a per-launch decision — it stays in the PRIMARY row, and a
  // fresh launcher defaults to Focus (DEFAULT_META). The draft's own More menu edits
  // the same meta; a tier picked in either place owns the tier.
  const tiers = footer.getByRole('group', { name: 'Pin new task to tier' })
  await expect(tiers).toBeVisible()
  await expect(tiers.getByRole('button', { name: 'Focus' })).toHaveAttribute('aria-pressed', 'true')

  await expect(footer.getByTitle('Start this task marked unread')).toHaveCount(0)
  await expect(footer.getByText('Priority', { exact: true })).toHaveCount(0)

  const more = footer.getByRole('button', { name: /More/ })
  await more.click()

  // PAGE-scoped: the More popover pops out of its host (portalled to <body>,
  // fixed own width, placed at the button by useMenuPlacement) — it is no
  // longer a footer descendant.
  const popover = page.getByRole('dialog', { name: 'More task settings' })
  await expect(popover).toBeVisible()
  // The retired star toggle is gone from the menu entirely (pin + focus tier is
  // the working set now).
  await expect(popover.getByTitle('Star this task')).toHaveCount(0)
  await expect(popover.getByTitle('Start this task marked unread')).toBeVisible()
  // C42: the toggle says the same words as the draft menu's row.
  await expect(popover.getByTitle('Start this task marked unread')).toHaveText(/Start unread/)
  await expect(popover.getByText('Mark unread', { exact: true })).toHaveCount(0)
  // Priority is hidden site-wide by default (Settings → Tasks → Show task
  // priority, `ui.show_priority`), so the menu draws no Priority row either —
  // a control for a value the user cannot see anywhere else would be a trap.
  // (The "comes back when on" half is the second test below.)
  await expect(popover.getByText('Priority', { exact: true })).toHaveCount(0)
  // The task dates trio lives here too (start leads; end/due ghost when empty) —
  // the launch IS a task create, so the Quick Task form's dates exist on it.
  await expect(popover.locator('.sps-meta-dates .dp-trigger')).toHaveCount(3)
  // Pin moved OUT of the menu — it must not be duplicated there.
  await expect(popover.getByRole('group', { name: 'Pin new task to tier' })).toHaveCount(0)

  await page.screenshot({ path: '/tmp/quick-start-footer/more-open.png' })

  // Toggling a menu-owned field flips the "More · N" changed-from-default badge.
  // (This used to click the star toggle; unread is the remaining boolean there.)
  const before = await more.textContent()
  await popover.getByTitle('Start this task marked unread').click()
  await expect(more).toHaveClass(/active/)
  await expect(more).not.toHaveText(before ?? '')

  await page.keyboard.press('Escape')
  await expect(popover).toHaveCount(0)
  await expect(selector).toBeVisible()
})

test('the More menu draws the Priority row once ui.show_priority is on', async ({ page }) => {
  // Same footer, opposite setting: the row is gated, not gone. Restored in
  // `finally` because the fixture server is shared by every spec in the run.
  await setShowPriority(page, true)
  try {
    await page.goto('/')
    const panel = await openDraft(page)
    await panel.locator('.draft-composer-bar .session-action-chip').first().click()
    const footer = page.locator('.session-path-selector .sps-meta-footer')
    await expect(footer).toBeVisible({ timeout: 10_000 })
    await footer.getByRole('button', { name: /More/ }).click()
    const popover = page.getByRole('dialog', { name: 'More task settings' })
    await expect(popover).toBeVisible()
    await expect(popover.getByText('Priority', { exact: true })).toBeVisible()
    await expect(popover.locator('.sps-meta-priority-options .badge')).toHaveCount(4)
  } finally {
    await setShowPriority(page, false)
  }
})

test('More · N counts only what the user set here, never a date Walnut decided', async ({ page }) => {
  // C65: the parse writes an AI due (a ✦ chip on the draft); the footer's badge must
  // not call that "your change". Then a real toggle here counts as one.
  const mock = await bootDecisions(page, { due_date: isoDay(3) })
  const panel = await openDraft(page)
  await typeAndSettle(page, mock, 'send the marina invoice by friday')
  await expect(draftDecisionChip(panel, 'dueDate').locator('.draft-ai-badge')).toHaveCount(1)

  await draftCwdPill(panel).click()
  const footer = page.locator('.session-path-selector .sps-meta-footer')
  await expect(footer).toBeVisible({ timeout: 10_000 })
  const more = footer.getByRole('button', { name: /More/ })
  await expect(more).not.toHaveClass(/active/)
  await expect(more.locator('.sps-meta-more-badge')).toHaveCount(0)
  await more.click()
  const popover = page.getByRole('dialog', { name: 'More task settings' })
  await expect(popover).toBeVisible()
  await popover.getByTitle('Start this task marked unread').click()
  await expect(more.locator('.sps-meta-more-badge')).toHaveText('· 1')
  await page.keyboard.press('Escape')
  await expect(popover).toHaveCount(0)
})
