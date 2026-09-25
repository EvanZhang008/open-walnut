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
  // Up front: Claude and Codex (plus engines used before, and the current pick);
  // every other engine waits in More (2026-09-25).
  const engines = footer.getByRole('group', { name: 'Coding agent engine' })
  await expect(engines).toBeVisible()
  // The folder's launch memory may hold an ACP engine (no model list): Claude
  // brings the model select, which travels with the engine.
  await engines.locator('.sps-engine-btn', { hasText: /^Claude$/ }).click()
  await expect(footer.getByRole('combobox', { name: 'Session model' })).toBeVisible()
  const more = footer.getByRole('button', { name: /More/ })
  // More appears once the catalog lists engines beyond the compiled-in pair.
  await expect(more).toBeVisible({ timeout: 15_000 })
  const upFront = await engines.locator('.sps-engine-btn').allTextContents()
  expect(upFront.slice(0, 2)).toEqual(['Claude', 'Codex'])
  // The pin tier is a per-launch decision — it stays in the PRIMARY row, and a
  // fresh launcher defaults to Focus (DEFAULT_META). The draft's own More menu edits
  // the same meta; a tier picked in either place owns the tier.
  const tiers = footer.getByRole('group', { name: 'Pin new task to tier' })
  await expect(tiers).toBeVisible()
  await expect(tiers.getByRole('button', { name: 'Focus' })).toHaveAttribute('aria-pressed', 'true')
  await expect(footer.getByText('Priority', { exact: true })).toHaveCount(0)

  await more.click()
  // PAGE-scoped: the More popover pops out of its host (portalled to <body>,
  // fixed own width, placed at the button by useMenuPlacement) — it is no
  // longer a footer descendant.
  const popover = page.getByRole('dialog', { name: 'More task settings' })
  await expect(popover).toBeVisible()
  const others = popover.getByRole('group', { name: 'Other coding agent engines' })
  const inMore = await others.locator('.sps-engine-btn').allTextContents()
  expect(inMore.length, 'the rest of the catalog').toBeGreaterThan(0)
  expect(inMore.filter((n) => upFront.includes(n)), 'no engine is in both places').toEqual([])
  expect(inMore).not.toContain('Claude')
  expect(inMore).not.toContain('Codex')
  // Not launch questions: no dates and no "Start unread" while none is set.
  await expect(popover.locator('.sps-meta-dates')).toHaveCount(0)
  await expect(popover.getByText('Start unread')).toHaveCount(0)
  // Priority is hidden site-wide by default (Settings → Tasks → Show task
  // priority, `ui.show_priority`), so the menu draws no Priority row either.
  await expect(popover.getByText('Priority', { exact: true })).toHaveCount(0)
  // Pin lives in the footer row, never duplicated here.
  await expect(popover.getByRole('group', { name: 'Pin new task to tier' })).toHaveCount(0)
  await page.screenshot({ path: '/tmp/quick-start-footer/more-open.png' })

  // Picking an engine from More brings it up front, lit; More no longer lists it.
  const firstEnabled = others.locator('.sps-engine-btn:not([disabled])').first()
  const name = (await firstEnabled.textContent())?.trim() ?? ''
  await firstEnabled.click()
  const picked = engines.locator('.sps-engine-btn', { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) })
  await expect(picked).toHaveClass(/active/)
  await expect(others.locator('.sps-engine-btn', { hasText: name })).toHaveCount(0)

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
  // Walnut's date keeps the dates row here; an End the user sets counts as one.
  await popover.locator('.sps-meta-dates .dp-trigger').nth(1).click()
  await page.locator(`.dp-popover .dp-pill[title="${isoDay(4)}"]`).click()
  await expect(more.locator('.sps-meta-more-badge')).toHaveText('· 1')
  await page.keyboard.press('Escape')
  await expect(popover).toHaveCount(0)
})

test('More that empties while open closes, and does not pop back open by itself', async ({ page }) => {
  // A catalog with ONE engine beyond Claude and Codex: picking it moves it up
  // front and leaves More with nothing to hold.
  const acp = {
    runtimeKind: 'acp', isDefault: false, localOnly: true,
    capabilities: { rewind: false, fork: false, modelCatalog: 'provider-advertised', modeControl: 'config-options', idProvisioning: 'provider-issued' },
    availability: { installed: true, version: null, reason: null },
  }
  await page.route('**/api/engines', (route) => route.fulfill({ json: { engines: [
    {
      id: 'claude', displayName: 'Claude', runtimeKind: 'native', isDefault: true, localOnly: false,
      capabilities: { rewind: true, fork: true, modelCatalog: 'static', modeControl: 'claude-modes', idProvisioning: 'preassigned' },
      availability: { installed: true, version: null, reason: null },
    },
    { ...acp, id: 'codex', displayName: 'Codex' },
    { ...acp, id: 'gemini', displayName: 'Gemini' },
  ] } }))
  await page.goto('/')
  const panel = await openDraft(page)
  await draftCwdPill(panel).click()
  const footer = page.locator('.session-path-selector .sps-meta-footer')
  await expect(footer).toBeVisible({ timeout: 10_000 })
  const engines = footer.getByRole('group', { name: 'Coding agent engine' })
  await engines.locator('.sps-engine-btn', { hasText: /^Claude$/ }).click()
  const more = footer.locator('.sps-meta-more-btn')
  await expect(more).toBeVisible({ timeout: 15_000 })
  await more.click()
  const popover = page.getByRole('dialog', { name: 'More task settings' })
  await popover.getByRole('group', { name: 'Other coding agent engines' }).locator('.sps-engine-btn', { hasText: 'Gemini' }).click()
  // Gemini is up front and lit; More has nothing left, so it and its menu go.
  await expect(engines.locator('.sps-engine-btn', { hasText: 'Gemini' })).toHaveClass(/active/)
  await expect(more).toHaveCount(0)
  await expect(popover).toHaveCount(0)
  // Back to Claude from the KEYBOARD (no mousedown, so no outside-click closer
  // can hide a stale open state): Gemini returns to More, which comes back CLOSED.
  await engines.locator('.sps-engine-btn', { hasText: /^Claude$/ }).focus()
  await page.keyboard.press('Enter')
  await expect(engines.locator('.sps-engine-btn', { hasText: /^Claude$/ })).toHaveClass(/active/)
  await expect(more).toBeVisible()
  await expect(more).toHaveAttribute('aria-expanded', 'false')
  await expect(popover).toHaveCount(0)
})
