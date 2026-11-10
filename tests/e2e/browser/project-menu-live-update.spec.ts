/**
 * A project's right-click menu stays open while live updates change the list above what it shows.
 *
 * Every Home navigation project header is sticky (home-navigation.css). Since 1a91f2a69 a menu on a
 * sticky control closed on any scroll of the pane holding it, and a task added or removed above the
 * visible rows makes the browser's scroll anchoring shift the pane's scrollTop to keep the view where
 * it was: a scroll event that moved nothing on screen, which then took the menu down under the hand
 * (2026-11-10: home-navigation.spec.ts's Sort row and group-menu-settings.spec.ts's Project row on a
 * shared CI fixture, where other specs add and remove tasks all the time). The churn below is what
 * those specs did to it: in other projects above the header, and in the header's own project above
 * its visible rows (which moves the project's block but not the rows on screen). The menu must ride
 * both out, and a person's own wheel over the list must still close it.
 *
 * WebKit has no CSS scroll anchoring, but the Home list holds its rows by hand in both engines
 * (useScrollAnchor), so a live update scrolls the pane in WebKit too (each case checks it did).
 */
import { test, expect, type Page } from '@playwright/test'
import { isolateUiPrefs, listProjectHeader, openListProject } from './todo-panel-helpers'
import { presetPanelDesign } from './status-section-helpers'
import { openHome } from './home-navigation-helpers'

const made: string[] = []
let tag = ''

async function make(page: Page, title: string, project: string): Promise<string> {
  // Unpinned from the start, so it lands in its project's list at once.
  const res = await page.request.post('/api/tasks', { data: { title: `${title} ${tag}`, project, source: 'local', pinned: false } })
  expect(res.ok()).toBe(true)
  const id = (await res.json()).task.id as string
  made.push(id)
  return id
}

test.beforeEach(async ({ page }) => {
  tag = `${test.info().project.name}-${test.info().repeatEachIndex}-${Date.now()}`
  made.length = 0
})

test.afterEach(async ({ request }) => {
  for (const id of made) await request.delete(`/api/tasks/${id}?force=true`).catch(() => undefined)
})

/**
 * A project of 24 rows on a short window, opened, its list scrolled by `past` px relative to the
 * header (negative: the header sits that far below the pane's top; positive: scrolled past it, so it
 * sticks with its rows going under it), and its right-click menu open and settled.
 *
 * A second project of this spec's own, opened right below it, keeps the list's end well below the
 * view. Without it the project could be the last one, the pane scrolled to its end, and a project
 * another spec removes on the shared fixture (CI runs two workers on one) shortened the list under
 * the scroll position: the browser clamps it, every row on screen moves down, and the menu closes
 * as it must for content that moved (2026-11-10: the second case failed 1 run in 3 that way).
 */
async function openMenuOnScrolledProject(page: Page, baseURL: string, project: string, past: number) {
  await page.setViewportSize({ width: 1280, height: 640 })
  // Listed by name, so "<project> tail" comes right after it.
  const tail = `${project} tail`
  await Promise.all([
    ...Array.from({ length: 24 }, (_, i) => make(page, `row ${i}`, project)),
    ...Array.from({ length: 24 }, (_, i) => make(page, `tail ${i}`, tail)),
  ])
  await isolateUiPrefs(page)
  await presetPanelDesign(page, 'project')
  await openHome(page, baseURL)
  await openListProject(page, tail)
  await openListProject(page, project)
  const header = listProjectHeader(page, project)
  const scrolled = await header.evaluate((el, by) => {
    const pane = el.closest('.home-navigation-scroll') as HTMLElement
    pane.scrollTop += el.getBoundingClientRect().top - pane.getBoundingClientRect().top + by
    return { top: pane.scrollTop, room: pane.scrollHeight - pane.clientHeight - pane.scrollTop }
  }, past)
  expect(scrolled.top).toBeGreaterThan(0)
  // Far from the end: a removal anywhere cannot make the browser clamp the scroll position.
  expect(scrolled.room).toBeGreaterThan(400)
  await frames(page)
  // Count the scrolls of the list pane the churn causes: without one, a case proves nothing.
  await page.evaluate(() => {
    const w = window as unknown as { __paneScrolls: number }
    w.__paneScrolls = 0
    document.querySelector('.home-navigation-scroll')?.addEventListener('scroll', () => { w.__paneScrolls++ })
  })
  await header.click({ button: 'right' })
  const menu = page.getByTestId('project-ctx-menu')
  await expect(menu).toBeVisible()
  await frames(page)
  return { header, menu }
}

const frames = (page: Page) => page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))))
const paneScrolls = (page: Page) => page.evaluate(() => (window as unknown as { __paneScrolls: number }).__paneScrolls)

/** Tasks added to each project, every other round removed. */
async function churn(page: Page, projects: string[]) {
  for (let round = 0; round < 8; round++) {
    for (const where of projects) {
      const id = await make(page, `churn ${round}`, where)
      if (round % 2 === 1) await page.request.delete(`/api/tasks/${id}?force=true`)
    }
    await page.waitForTimeout(250)
  }
}

test('the project menu stays open while tasks come and go in the projects above its header', async ({ page, baseURL }) => {
  // Projects are listed by name: "0 …" lands above this one.
  const { header, menu } = await openMenuOnScrolledProject(page, baseURL!, `Live menu ${tag}`, -120)
  const before = await header.boundingBox()
  await churn(page, ['', `0 Live churn ${tag}`])
  await expect.poll(() => paneScrolls(page)).toBeGreaterThan(0)
  await expect(menu).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: /^Sort/ })).toBeVisible()
  const after = await header.boundingBox()
  expect(Math.abs(after!.y - before!.y)).toBeLessThanOrEqual(1)
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
})

test('the project menu stays open while its own project grows above the rows on screen; a wheel still closes it', async ({ page, baseURL }) => {
  const project = `Live menu own ${tag}`
  // Scrolled well past the header: it sticks at the top, its first rows under it and out of sight.
  const { header, menu } = await openMenuOnScrolledProject(page, baseURL!, project, 300)
  const rowsOnScreen = () => page.locator('.home-navigation-scroll .todo-panel-item[data-task-id]').evaluateAll((rows) => {
    const r = (document.querySelector('.home-navigation-scroll') as HTMLElement).getBoundingClientRect()
    return rows.filter((row) => { const b = row.getBoundingClientRect(); return b.top >= r.top && b.bottom <= r.bottom })
      .map((row) => `${row.getAttribute('data-task-id')}@${Math.round(row.getBoundingClientRect().top)}`).slice(0, 6)
  })
  const shown = await rowsOnScreen()
  // Rows appear in the project above the ones on screen, out of sight under the stuck header, and
  // go again. Drawn by hand into the project's block, right under its header, so they land above
  // the rows on screen whatever the project's sort: scroll anchoring answers the block's growth by
  // shifting scrollTop and the project's block top with it, while the rows on screen stay put
  // (home-list-keeps-place.spec.ts adds real tasks there).
  //
  // Each change is made in an animation frame callback, after the frame's scroll events. The list's
  // scroll keeper answers a change made outside React from its ResizeObserver, after layout in the
  // same frame, so a change made by a plain script could land between a scroll the keeper had just
  // made (another spec's tasks going away above, on the shared fixture) and that scroll's event, and
  // the menu read the rows before the keeper put them back (2026-11-10: closed 1 run in 10 with two
  // workers). A change React renders is answered in its own commit, before any scroll event.
  for (let round = 0; round < 4; round++) {
    await header.evaluate((el, n) => new Promise<void>((done) => requestAnimationFrame(() => {
      const row = document.createElement('div')
      row.className = 'pw-staged-row'
      row.style.height = '56px'
      row.dataset.round = String(n)
      el.parentElement!.insertBefore(row, el.nextSibling)
      done()
    })), round)
    await page.waitForTimeout(250)
  }
  await header.evaluate((el) => new Promise<void>((done) => requestAnimationFrame(() => {
    el.parentElement!.querySelectorAll('.pw-staged-row')[0]?.remove()
    done()
  })))
  await page.waitForTimeout(250)
  await expect.poll(() => paneScrolls(page)).toBeGreaterThan(0)
  await expect(menu).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: /^Sort/ })).toBeVisible()
  // What the person looks at did not move: scroll anchoring kept it in place.
  expect(await rowsOnScreen()).toEqual(shown)
  await header.evaluate((el) => { el.parentElement!.querySelectorAll('.pw-staged-row').forEach((r) => r.remove()) })

  // A person's own scroll over the list still closes it: a wheel low on the list's left edge, clear
  // of the menu (it opens rightward from the click; a wheel over the menu scrolls the menu).
  const pane = (await page.locator('.home-navigation-scroll').boundingBox())!
  const box = (await menu.boundingBox())!
  const at = { x: pane.x + 24, y: pane.y + pane.height - 24 }
  expect(at.x < box.x || at.y > box.y + box.height).toBe(true)
  await page.mouse.move(at.x, at.y)
  await page.mouse.wheel(0, 240)
  await expect(menu).toHaveCount(0)
})

