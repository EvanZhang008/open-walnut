/**
 * A project's right-click menu stays open while live updates change the list above it.
 *
 * Every Home navigation project header is sticky (home-navigation.css). Since 1a91f2a69 a menu on a
 * sticky control closed on any scroll of the pane holding it, and a task added or removed above the
 * header makes the browser's scroll anchoring shift the pane's scrollTop to keep the view where it
 * was: a scroll event that moved nothing under the menu, which then vanished under the hand
 * (2026-11-10: home-navigation.spec.ts's Sort row and group-menu-settings.spec.ts's Project row on a
 * shared CI fixture, where other specs add and remove tasks all the time). The churn below is what
 * those specs did to it; the menu must ride it out, and the header must not have moved.
 */
import { test, expect } from '@playwright/test'
import { isolateUiPrefs, listProjectHeader, openListProject } from './todo-panel-helpers'
import { presetPanelDesign } from './status-section-helpers'
import { openHome } from './home-navigation-helpers'

test('the project menu stays open while tasks come and go above its header', async ({ page, baseURL, browserName }) => {
  // WebKit has no CSS scroll anchoring: a live update above never scrolls the pane there, so the
  // failure this pins cannot happen and the churn proves nothing (the pane-scroll check below).
  test.skip(browserName === 'webkit', 'no scroll anchoring in WebKit')
  const tag = `${test.info().project.name}-${test.info().repeatEachIndex}-${Date.now()}`
  const project = `Live menu ${tag}`
  const made: string[] = []
  const make = async (title: string, inProject: string) => {
    const res = await page.request.post('/api/tasks', { data: { title: `${title} ${tag}`, project: inProject, source: 'local' } })
    expect(res.ok()).toBe(true)
    const id = (await res.json()).task.id as string
    made.push(id)
    return id
  }
  try {
    // Enough rows that the list scrolls, so the header can sit near its top with projects above it
    // (projects are listed by name: the churn's "0 …" project lands above this one).
    await page.setViewportSize({ width: 1280, height: 640 })
    const ids = await Promise.all(Array.from({ length: 24 }, (_, i) => make(`row ${i}`, project)))
    for (const id of ids) await page.request.delete(`/api/focus/tasks/${id}`)
    await isolateUiPrefs(page)
    await presetPanelDesign(page, 'project')
    await openHome(page, baseURL!)
    await openListProject(page, project)
    const header = listProjectHeader(page, project)

    // The list scrolled so the header sits near its top with rows above it, the way a person
    // reaches a project down the list: only a scrolled pane is shifted by scroll anchoring.
    const scrolled = await header.evaluate((el) => {
      const pane = el.closest('.home-navigation-scroll') as HTMLElement
      pane.scrollTop += el.getBoundingClientRect().top - pane.getBoundingClientRect().top - 120
      return pane.scrollTop
    })
    expect(scrolled).toBeGreaterThan(0)
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))))
    // Count the scrolls of the list pane the churn causes: without one, this proves nothing.
    await page.evaluate(() => {
      const w = window as unknown as { __paneScrolls: number }
      w.__paneScrolls = 0
      document.querySelector('.home-navigation-scroll')?.addEventListener('scroll', () => { w.__paneScrolls++ })
    })
    await header.click({ button: 'right' })
    const menu = page.getByTestId('project-ctx-menu')
    await expect(menu).toBeVisible()
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))))
    const before = await header.boundingBox()

    // Tasks added and removed above the header: in the Inbox and in a project of their own.
    const other = `0 Live churn ${tag}`
    for (let round = 0; round < 8; round++) {
      for (const where of ['', other]) {
        const id = await make(`churn ${round}`, where)
        if (round % 2 === 1) await page.request.delete(`/api/tasks/${id}?force=true`)
      }
      await page.waitForTimeout(250)
    }
    await expect.poll(() => page.evaluate(() => (window as unknown as { __paneScrolls: number }).__paneScrolls)).toBeGreaterThan(0)
    await expect(menu).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: /^Sort/ })).toBeVisible()
    const after = await header.boundingBox()
    expect(Math.abs(after!.y - before!.y)).toBeLessThanOrEqual(1)
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
  } finally {
    for (const id of made) await page.request.delete(`/api/tasks/${id}?force=true`).catch(() => undefined)
  }
})
