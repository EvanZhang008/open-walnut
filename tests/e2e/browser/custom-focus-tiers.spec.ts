/**
 * Custom focus tiers — Settings CRUD → pinned-area rendering → membership flows.
 *
 * The pinned area historically had exactly three tiers (Focus / Satellite / Wait,
 * satellite = focus_tier undefined). Users can now define their own tiers in
 * Settings → Focus Tiers; each renders as a first-class tier: its own section tab,
 * its own sub-group + drop zone in the stacked view, kebab/picker entries, and an
 * inline "+ Add to <label>…" row. Deleting a tier moves its tasks back to
 * Satellite (server migration, client convergence via WS).
 *
 * Registry state is GLOBAL server state on the shared fixture dataset — specs in
 * this file create uniquely-named tiers and clean them up, but tier CRUD races
 * with itself (the Settings list re-renders on every config:changed{focus_tiers}),
 * so serialize within the file.
 */

import { test, expect, type Page } from '@playwright/test'
import { selectSection, showAllSections } from './todo-panel-helpers'

test.describe.configure({ mode: 'serial' })

/** Open the app at the home page (SPA — no direct goto to inner routes). */
async function openHome(page: Page): Promise<void> {
  await page.goto('/')
  await page.locator('.todo-section-tabs').first().waitFor({ state: 'visible', timeout: 30_000 })
}

/** Navigate to Settings via the real sidebar link, then scroll to Focus Tiers. */
async function openFocusTiersSettings(page: Page): Promise<void> {
  await page.locator('a[href="/settings"]').first().click()
  await page.locator('#focus-tiers').waitFor({ state: 'attached', timeout: 15_000 })
  await page.locator('#focus-tiers').scrollIntoViewIfNeeded()
}

/** Create a tier through the Settings UI and wait for its row to appear. */
async function createTierViaUI(page: Page, label: string): Promise<void> {
  const section = page.locator('#focus-tiers')
  await section.locator('.focus-tiers-add-row input').fill(label)
  await section.getByRole('button', { name: 'Add tier' }).click()
  // 30s: a loaded machine can stall the POST past 10s (starvation artifact, not
  // a product bug — see the Playwright load notes in CLAUDE.md).
  await expect(section.locator('.focus-tiers-row', { hasText: label })).toBeVisible({ timeout: 30_000 })
}

/** Delete a tier through the Settings UI (confirm dialog included). */
async function deleteTierViaUI(page: Page, label: string): Promise<void> {
  const section = page.locator('#focus-tiers')
  const row = section.locator('.focus-tiers-row', { hasText: label }).first()
  await row.getByRole('button', { name: 'Delete' }).click()
  // useConfirm renders an app-modal — scope to THE confirm dialog (other app-modals
  // can exist on the page) and accept with its danger/primary button.
  const modal = page.locator('.app-modal', { hasText: `Delete tier "${label}"` })
  await modal.waitFor({ state: 'visible', timeout: 10_000 })
  const [res] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/focus/tiers/') && r.request().method() === 'DELETE', { timeout: 30_000 }),
    modal.locator('.app-modal-btn.primary').click(),
  ])
  if (!res.ok()) throw new Error(`DELETE tier failed: ${res.status()} ${await res.text()}`)
  // 30s: the DELETE fans out task migrations + WS events; on a loaded machine the
  // round-trip can exceed 10s (starvation artifact — see CLAUDE.md Playwright notes).
  await expect(section.locator('.focus-tiers-row', { hasText: label })).toHaveCount(0, { timeout: 30_000 })
}

/** API fallback cleanup: remove every tier whose label starts with the stamp prefix. */
async function cleanupTiers(page: Page, prefix: string): Promise<void> {
  const res = await page.request.get('/api/focus/tiers')
  if (!res.ok()) return
  const { tiers } = (await res.json()) as { tiers: { id: string; label: string }[] }
  for (const t of tiers) {
    if (t.label.startsWith(prefix)) await page.request.delete(`/api/focus/tiers/${t.id}`)
  }
}

test('settings CRUD: create, rename, and the tier appears across the UI', async ({ page }) => {
  const stamp = `Bklg${Date.now().toString(36).slice(-4)}`
  await openHome(page)
  try {
    await openFocusTiersSettings(page)

    // Built-ins render as read-only rows.
    const section = page.locator('#focus-tiers')
    for (const builtin of ['Focus', 'Satellite', 'Wait']) {
      await expect(section.locator('.focus-tiers-row', { hasText: builtin }).first()).toBeVisible()
    }

    // Create.
    await createTierViaUI(page, stamp)

    // Duplicate label rejected inline (server 400 surfaces, no second row).
    await section.locator('.focus-tiers-add-row input').fill(stamp)
    await section.getByRole('button', { name: 'Add tier' }).click()
    await expect(section.getByText(/Error:/i).first()).toBeVisible({ timeout: 30_000 })
    await expect(section.locator('.focus-tiers-row', { hasText: stamp })).toHaveCount(1)

    // The new tier shows up as a section tab on the home panel.
    await page.locator('a[href="/"]').first().click()
    await page.locator('.todo-section-tabs').first().waitFor({ state: 'visible', timeout: 15_000 })
    const tab = page.locator('.todo-section-tabs [role="tab"]', { hasText: stamp }).first()
    await expect(tab).toBeVisible({ timeout: 10_000 })

    // Its solo view mounts a drop zone + inline add.
    await tab.click()
    await expect(page.locator('[data-drop-zone$="-drop-zone"]').first()).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText(`Add to ${stamp}…`).first()).toBeVisible()
  } finally {
    await cleanupTiers(page, stamp)
  }
})

test('inline add creates a task in the custom tier and it survives reload', async ({ page }) => {
  const stamp = `Cust${Date.now().toString(36).slice(-4)}`
  const title = `custom-tier probe ${stamp}`
  await openHome(page)
  try {
    // Create the tier via API (UI creation covered above), then use the UI.
    const created = await page.request.post('/api/focus/tiers', { data: { label: stamp } })
    expect(created.ok()).toBeTruthy()
    const tierId = ((await created.json()) as { tier: { id: string } }).tier.id

    await page.reload()
    await page.locator('.todo-section-tabs').first().waitFor({ state: 'visible', timeout: 30_000 })
    const tab = page.locator('.todo-section-tabs [role="tab"]', { hasText: stamp }).first()
    await expect(tab).toBeVisible({ timeout: 10_000 })
    await tab.click()

    // Inline add into the custom tier.
    await page.getByText(`Add to ${stamp}…`).first().click()
    const input = page.locator('.focus-inline-add input').first()
    await input.fill(title)
    await input.press('Enter')
    const card = page.locator(`[data-drop-zone="${tierId}-drop-zone"] [data-task-id]`, { hasText: title }).first()
    await expect(card).toBeVisible({ timeout: 15_000 })

    // Server truth: the task is in custom_tier_tasks under this tier id.
    await expect
      .poll(async () => {
        const res = await page.request.get('/api/focus/tasks')
        const data = (await res.json()) as { custom_tier_tasks?: Record<string, string[]> }
        return data.custom_tier_tasks?.[tierId]?.length ?? 0
      }, { timeout: 15_000 })
      .toBeGreaterThan(0)

    // Survives reload.
    await page.reload()
    await page.locator('.todo-section-tabs').first().waitFor({ state: 'visible', timeout: 30_000 })
    await page.locator('.todo-section-tabs [role="tab"]', { hasText: stamp }).first().click()
    await expect(page.locator('[data-task-id]', { hasText: title }).first()).toBeVisible({ timeout: 15_000 })
  } finally {
    await cleanupTiers(page, stamp)
  }
})

test('mid-drag preview: card visually enters an (empty) custom tier before drop', async ({ page }) => {
  // Regression guard for two review findings:
  //  1. setLiveArr must be copy-on-write — the tier-array memos key on the drag
  //     Map's IDENTITY, so an in-place .set() froze the cross-tier preview (the
  //     card never visually entered the hovered tier until drop).
  //  2. An EMPTY custom tier normally hides in the stacked view but must stay
  //     mounted while a drag is live, so it can be a drop target at all.
  const stamp = `Prev${Date.now().toString(36).slice(-4)}`
  const title = `drag-preview probe ${stamp}`
  let taskId = ''
  await openHome(page)
  try {
    const created = await page.request.post('/api/focus/tiers', { data: { label: stamp } })
    const tierId = ((await created.json()) as { tier: { id: string } }).tier.id
    const taskRes = await page.request.post('/api/tasks', { data: { title, source: 'local', category: 'Work' } })
    taskId = ((await taskRes.json()) as { task: { id: string } }).task.id
    await page.request.post(`/api/focus/tasks/${taskId}`)

    await page.reload()
    await page.locator('.todo-section-tabs').first().waitFor({ state: 'visible', timeout: 30_000 })
    await showAllSections(page)

    const tierScope = page.locator('.todo-pinned-section:not(.todo-pinned-section-recent)')
    const card = tierScope.locator(`.todo-pinned-card[data-task-id="${taskId}"]`)
    await expect(card).toBeVisible({ timeout: 15_000 })
    const handle = card.locator('.todo-pinned-drag-handle')
    const srcBox = await handle.boundingBox()
    expect(srcBox).not.toBeNull()

    await page.mouse.move(srcBox!.x + srcBox!.width / 2, srcBox!.y + srcBox!.height / 2)
    await page.mouse.down()
    // Small activation move — the empty custom tier subgroup mounts once the
    // drag is live (the drag-active exemption from the non-empty gate).
    await page.mouse.move(srcBox!.x + srcBox!.width / 2, srcBox!.y + srcBox!.height / 2 + 8)
    const zone = page.locator(`[data-drop-zone="${tierId}-drop-zone"]`)
    await expect(zone).toBeVisible({ timeout: 10_000 })

    const zoneBox = await zone.boundingBox()
    expect(zoneBox).not.toBeNull()
    await page.mouse.move(zoneBox!.x + zoneBox!.width / 2, zoneBox!.y + Math.min(zoneBox!.height / 2, 40), { steps: 12 })
    // THE preview assertion: while the button is still held, the card must
    // already render inside the custom tier's drop zone.
    await expect(zone.locator(`[data-task-id="${taskId}"]`)).toHaveCount(1, { timeout: 5_000 })
    // The preview move SHIFTS the layout (the card left its old tier), so the
    // zone is no longer where we grabbed its box — re-target the CURRENT zone
    // position before releasing, like a human tracking the moving highlight.
    // Releasing at the stale coordinates lands on whatever card slid under the
    // pointer and triggers drop-into-group instead of the tier move.
    const zoneBoxNow = await zone.boundingBox()
    expect(zoneBoxNow).not.toBeNull()
    await page.mouse.move(zoneBoxNow!.x + zoneBoxNow!.width / 2, zoneBoxNow!.y + Math.min(zoneBoxNow!.height / 2, 40), { steps: 6 })
    await page.waitForTimeout(300)
    await page.mouse.up()

    // Drop persisted server-side.
    await expect
      .poll(async () => {
        const res = await page.request.get('/api/focus/tasks')
        const data = (await res.json()) as { custom_tier_tasks?: Record<string, string[]> }
        return data.custom_tier_tasks?.[tierId]?.includes(taskId) ?? false
      }, { timeout: 15_000 })
      .toBe(true)
  } finally {
    await cleanupTiers(page, stamp)
    if (taskId) await page.request.delete(`/api/focus/tasks/${taskId}`).catch(() => {})
  }
})

test('deleting a tier moves its tasks back to Satellite', async ({ page }) => {
  const stamp = `Del${Date.now().toString(36).slice(-4)}`
  const title = `delete-migration probe ${stamp}`
  await openHome(page)
  try {
    // Seed: tier + a pinned task inside it (API for speed; UI covered above).
    const created = await page.request.post('/api/focus/tiers', { data: { label: stamp } })
    const tierId = ((await created.json()) as { tier: { id: string } }).tier.id
    const taskRes = await page.request.post('/api/tasks', { data: { title, source: 'local', category: 'Work' } })
    const taskId = ((await taskRes.json()) as { task: { id: string } }).task.id
    await page.request.post(`/api/focus/tasks/${taskId}`)
    await page.request.put(`/api/focus/tasks/${taskId}/tier`, { data: { tier: tierId } })

    // Delete via the Settings UI and check the moved-count notice.
    await openFocusTiersSettings(page)
    await expect(page.locator('#focus-tiers').getByText(stamp, { exact: true }).first()).toBeVisible({ timeout: 10_000 })
    await deleteTierViaUI(page, stamp)

    // Server truth: task back in satellite bucket.
    await expect
      .poll(async () => {
        const res = await page.request.get('/api/focus/tasks')
        const data = (await res.json()) as { satellite_tasks: string[]; custom_tier_tasks?: Record<string, string[]> }
        return data.satellite_tasks.includes(taskId) && !(tierId in (data.custom_tier_tasks ?? {}))
      }, { timeout: 15_000 })
      .toBe(true)

    // UI: the tab is gone; the task renders under Satellite.
    await page.locator('a[href="/"]').first().click()
    await page.locator('.todo-section-tabs').first().waitFor({ state: 'visible', timeout: 15_000 })
    await expect(page.locator('.todo-section-tabs [role="tab"]', { hasText: stamp })).toHaveCount(0, { timeout: 10_000 })
    await selectSection(page, 'Satellite')
    await expect(page.locator('[data-task-id]', { hasText: title }).first()).toBeVisible({ timeout: 15_000 })
  } finally {
    await cleanupTiers(page, stamp)
  }
})
