/**
 * Watching belongs to the selected board tier, like every other status section, in both home
 * panel layouts (2026-11-11, the user: a watched task in Focus is Watching only inside Focus).
 * For every tier tab, built-in and custom, only that tier's watched task is drawn under Watching.
 */
import { test, expect } from './shortcut-test-fixture'
import { isolateUiPrefs, selectSection } from './todo-panel-helpers'
import { presetPanelDesign, statusSectionRows, type PanelDesign } from './status-section-helpers'

const made: string[] = []
const madeTiers: string[] = []
test.afterEach(async ({ request }) => {
  for (const id of made.splice(0)) await request.delete(`/api/tasks/${id}?force=true`)
  for (const id of madeTiers.splice(0)) await request.delete(`/api/focus/tiers/${id}`)
})

for (const design of ['status', 'project'] as PanelDesign[]) {
  test(`${design}: Watching follows the tier, its badge, and live tier changes`, async ({ page }) => {
    test.setTimeout(120_000)
    await isolateUiPrefs(page)
    await presetPanelDesign(page, design)
    await page.setViewportSize({ width: 1280, height: 800 })
    const label = `Watch tier ${design} ${Date.now()}`
    const made1 = await page.request.post('/api/focus/tiers', { data: { label } })
    expect(made1.ok(), await made1.text()).toBe(true)
    const custom = (await made1.json()).tier.id as string
    madeTiers.push(custom)
    const ids: Record<string, string> = {}
    for (const tier of ['focus', 'satellite', 'wait', custom, 'unpinned']) {
      const res = await page.request.post('/api/tasks', { data: { title: `Tier watch ${tier} ${Date.now()}`, source: 'local' } })
      expect(res.ok()).toBe(true)
      const id = (await res.json()).task.id as string
      ids[tier] = id
      made.push(id)
      if (tier !== 'unpinned') {
        expect((await page.request.post(`/api/focus/tasks/${id}`)).ok()).toBe(true)
        expect((await page.request.put(`/api/focus/tasks/${id}/tier`, { data: { tier } })).ok()).toBe(true)
      } else {
        expect((await page.request.delete(`/api/focus/tasks/${id}`)).ok()).toBe(true)
      }
      expect((await page.request.patch(`/api/tasks/${id}`, { data: { watched_at: new Date().toISOString() } })).ok()).toBe(true)
    }
    await page.goto('/')
    const watching = statusSectionRows(page, 'watching')
    const assertTier = async (name: 'Focus' | 'Satellite' | 'Parked' | 'custom', tier: string) => {
      if (name === 'custom') {
        const tab = page.locator('.todo-section-tabs [role="tab"]', { hasText: label }).first()
        await tab.click()
        await expect(tab).toHaveAttribute('aria-selected', 'true', { timeout: 30_000 })
      } else await selectSection(page, name)
      await expect(watching.locator(`[data-task-id="${ids[tier]}"]`)).toBeVisible()
      for (const [other, id] of Object.entries(ids)) {
        if (other !== tier) await expect(watching.locator(`[data-task-id="${id}"]`)).toHaveCount(0)
      }
    }
    await assertTier('Focus', 'focus')
    await assertTier('Satellite', 'satellite')
    await assertTier('Parked', 'wait')
    await assertTier('custom', custom)
    await assertTier('Focus', 'focus')
    const tab = page.locator('.todo-section-tab-focus')
    const countBefore = Number(await tab.locator('.todo-section-tab-count').textContent())
    expect((await page.request.put(`/api/focus/tasks/${ids.focus}/tier`, { data: { tier: 'satellite' } })).ok()).toBe(true)
    await expect(watching.locator(`[data-task-id="${ids.focus}"]`)).toHaveCount(0)
    const badge = tab.locator('.todo-section-tab-count')
    if (countBefore === 1) await expect(badge).toHaveCount(0)
    else await expect(badge).toHaveText(String(countBefore - 1))
    await selectSection(page, 'Satellite')
    for (const tier of ['focus', 'satellite']) await expect(watching.locator(`[data-task-id="${ids[tier]}"]`)).toBeVisible()
    await page.reload()
    for (const tier of ['focus', 'satellite']) await expect(watching.locator(`[data-task-id="${ids[tier]}"]`)).toBeVisible()
    await selectSection(page, 'All')
    for (const id of Object.values(ids)) await expect(watching.locator(`[data-task-id="${id}"]`)).toBeVisible()
  })
}
