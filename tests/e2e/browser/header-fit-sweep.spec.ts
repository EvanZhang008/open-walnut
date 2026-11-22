/**
 * The header rule, swept on the page (components/common/HeaderFit.tsx). 2026-11-21, the user on
 * the Org list at about 220 px: "ui is shit now what the fuck?" ("New router", "Org chart" and
 * the gear squeezed the title "Org" to one clipped letter).
 *
 * Every header row on each page (header-fit-check.ts finds them on the live page, so a header
 * added later is checked too) at 1512, 1280, 1024 and 390 px, and the Org list at its narrowest
 * divider width: no two parts cover each other, nothing runs past the header, and the title
 * keeps its readable width. Then the Org list's own steps: words, icons, the More menu.
 */
import { expect, test, type Page } from '@playwright/test'
import { loadHome } from './draft-helpers'
import { openTaskSession } from './agent-text-entry-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'
import { findHeaderProblems, HEADER_TITLE_MIN_PX } from './header-fit-check'

test.describe.configure({ mode: 'serial' })
test.setTimeout(240_000)

const LIST_KEY = 'open-walnut-org-list-w'
// Home's task panel keeps one width beside sessions and one of its own on an empty row (MainPage's
// todoPanel / todoAlone); the empty row grows to a readable list unless the width was dragged.
const TODO_KEYS = ['open-walnut-todo-width', 'open-walnut-todo-width-alone']
const setTodoWidth = (page: Page, px: number | null) => page.evaluate(({ keys, pct }) => {
  for (const k of keys) {
    if (pct === null) { localStorage.removeItem(k); localStorage.removeItem(`${k}:dragged`) }
    else { localStorage.setItem(k, String(pct)); localStorage.setItem(`${k}:dragged`, '1') }
  }
}, { keys: TODO_KEYS, pct: px === null ? null : (px / 1280) * 100 })
const frames = (page: Page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
const problems = async (page: Page) => { await frames(page); return page.evaluate(findHeaderProblems, HEADER_TITLE_MIN_PX) }

async function openOrg(page: Page): Promise<void> {
  await page.getByTestId('sidebar-org').click()
  await expect(page.getByTestId('org-page')).toBeVisible()
  await expect(page.locator('.org-list-head')).toBeVisible()
}

async function sidebarTo(page: Page, href: string): Promise<void> {
  await page.locator(`a.sidebar-link[href="${href}"]`).first().click()
  await page.waitForURL((u) => u.pathname.startsWith(href))
  await page.waitForTimeout(800)
}

test('every header on Home, Org and Settings fits at 1512, 1280, 1024 and phone width', async ({ page }) => {
  await isolateUiPrefs(page)
  for (const width of [1512, 1280, 1024, 390]) {
    await page.setViewportSize({ width, height: width < 500 ? 844 : 900 })
    await loadHome(page)
    const at: Record<string, unknown> = {}
    at[`${width} home`] = await problems(page)
    if (width >= 500) {
      await openOrg(page)
      at[`${width} org`] = await problems(page)
      await sidebarTo(page, '/settings')
      at[`${width} settings`] = await problems(page)
    }
    for (const [where, found] of Object.entries(at)) expect(found, where).toEqual([])
  }
})

// Every page the sidebar links to (read from the page, so a page added later is swept too), each
// at every width: the header rows of Apps, Calendar, Notes, Tasks, Agents and the rest.
test('every page in the sidebar: its headers fit at 1512, 1280, 1024 and phone width', async ({ page }) => {
  await isolateUiPrefs(page)
  await page.setViewportSize({ width: 1512, height: 900 })
  await loadHome(page)
  const hrefs = [...new Set(await page.locator('a.sidebar-link[href^="/"]').evaluateAll(
    (els) => els.map((a) => a.getAttribute('href') ?? '').filter((h) => h && h !== '/')))]
  expect(hrefs.length, 'the sidebar links its pages').toBeGreaterThan(3)
  const found: Record<string, unknown> = {}
  for (const href of hrefs) {
    await page.setViewportSize({ width: 1512, height: 900 })
    await sidebarTo(page, href)
    for (const width of [1512, 1280, 1024, 390]) {
      await page.setViewportSize({ width, height: width < 500 ? 844 : 900 })
      // The phone layout is its own shell: load it at phone width, as a phone does.
      if (width < 500) { await page.reload(); await page.locator('.phone-topbar').first().waitFor(); await page.waitForTimeout(800) }
      await page.waitForTimeout(150)
      const at = await problems(page)
      if (at.length) found[`${width} ${href}`] = at
    }
  }
  expect(found).toEqual({})
})

// The whole page narrowed, not only one divider (2026-11-22, the text-fit audit): the Scratchpad takes
// its own column at every width, so at 1024 the Org page is about 568 px beside it; and Home holds
// three columns (Scratchpad, Quick question, a session).
test('the page narrowed by the Scratchpad: the Org list and Home in three columns', async ({ page }) => {
  await isolateUiPrefs(page)
  const scratch = page.getByTestId('sidebar-toggle-scratchpad')
  for (const width of [1024, 1280]) {
    await page.setViewportSize({ width, height: 800 })
    await loadHome(page)
    await scratch.click()
    await openOrg(page)
    for (const px of [0, 212, 200]) {
      if (px) await page.locator('.org-list').evaluate((el, w) => { (el as HTMLElement).style.width = `${w}px` }, px)
      expect(await problems(page), `${width} Org beside the Scratchpad, list ${px || 'default'}`).toEqual([])
      await expect(page.locator('.org-list-head .org-name-edit')).toHaveText(/\S/)
    }
    await scratch.click()
  }
  await page.setViewportSize({ width: 1512, height: 900 })
  await loadHome(page)
  // A session column (the fixture task test-server.ts gives a stopped session).
  await openTaskSession(page, 'Outline fixture task', 'pw-task-pins', 'pw-pins-session')
  await page.getByRole('button', { name: 'Quick question' }).first().click()
  await scratch.click()
  for (const width of [1512, 1280, 1024]) {
    await page.setViewportSize({ width, height: 900 })
    await frames(page)
    expect(await problems(page), `${width} Home with the Scratchpad, Quick question and a session`).toEqual([])
  }
  await scratch.click()
})

test('the Org list header: the Org chart icon and the gear; the title always reads', async ({ page }) => {
  await isolateUiPrefs(page)
  await page.setViewportSize({ width: 1512, height: 900 })
  await loadHome(page)
  await openOrg(page)
  const head = page.locator('.org-list-head')
  const setList = async (px: number) => {
    await page.locator('.org-list').evaluate((el, w) => { (el as HTMLElement).style.width = `${w}px` }, px)
    await frames(page)
  }
  // 2026-11-21, the user: "org chart need to be an icon with hover over" and "no new
  // router,put it sin the router section".
  await expect(head.getByTestId('org-new-router')).toHaveCount(0)
  await expect(page.getByTestId('org-routers-head').getByTestId('org-new-router')).toBeVisible()
  // 200 px is the narrowest the divider allows.
  for (const px of [480, 300, 260, 220, 200, 240, 300, 480]) {
    await setList(px)
    const found = await problems(page)
    expect(found, `list ${px}px`).toEqual([])
    // Org chart is its icon alone, with its name on hover and for a screen reader.
    const chart = head.getByTestId('org-open-chart')
    await expect(chart, `list ${px}px shows Org chart`).toBeVisible()
    await expect(chart.locator('[data-fit-label]')).toHaveCount(0)
    await expect(chart).toHaveAttribute('aria-label', 'Org chart')
    await expect(chart).toHaveAttribute('title', /^Org chart/)
  }
  // The narrowest the divider allows: icons, the title whole.
  await page.evaluate((k) => localStorage.setItem(k, String((200 / innerWidth) * 100)), LIST_KEY)
  await page.reload()
  // The Org page is a view, not a URL: a reload may land on Home.
  if (!(await head.isVisible({ timeout: 3000 }).catch(() => false))) await openOrg(page)
  await expect(head).toBeVisible()
  expect(await problems(page), 'list at its narrowest divider width').toEqual([])
  await expect(head.locator('.org-name-edit')).toHaveText(/\S/)
  // The name's own text is whole (the rename button's hover fill bleeds 3 px past the heading
  // by design, so the heading's own scroll width says nothing). The fold settles in a frame or two.
  await expect.poll(() => head.locator('.org-name-edit').evaluate((el) => {
    const r = document.createRange(); r.selectNodeContents(el)
    return el.scrollWidth > el.clientWidth + 1 || r.getBoundingClientRect().width > el.getBoundingClientRect().width
  })).toBe(false)

  await page.evaluate((k) => localStorage.removeItem(k), LIST_KEY)
})

// A toggle put away into More still says whether it is on (the Tasks page's filter chips).
test('a toggle in the More menu reads on or off', async ({ page }) => {
  await isolateUiPrefs(page)
  await page.setViewportSize({ width: 1280, height: 900 })
  await loadHome(page)
  await sidebarTo(page, '/tasks')
  const bar = page.locator('.tp-toolbar')
  await bar.evaluate((el) => { (el as HTMLElement).style.width = '440px' })
  const more = page.getByTestId('tp-toolbar-more')
  await expect(more).toBeVisible()
  expect(await problems(page), 'the Tasks toolbar at 440 px').toEqual([])
  await more.click()
  const menu = page.locator('.header-fit-more-menu')
  const toggles = menu.getByRole('menuitemcheckbox')
  await expect(toggles.first()).toBeVisible()
  const pressed = await bar.locator('[data-fit-button][aria-pressed]:not([data-fit-keep])').evaluateAll(
    (els) => els.map((e) => [e.getAttribute('aria-label') || e.getAttribute('title') || (e.textContent ?? '').trim(), e.getAttribute('aria-pressed')]))
  for (const [name, on] of pressed) await expect(menu.getByRole('menuitemcheckbox', { name: name ?? '' }), name ?? '').toHaveAttribute('aria-checked', on ?? 'false')
  await page.keyboard.press('Escape')
})

test('the task panel at its narrowest: New task and Board go into More, which works by keyboard', async ({ page }) => {
  await isolateUiPrefs(page)
  await page.setViewportSize({ width: 1280, height: 900 })
  await loadHome(page)
  await setTodoWidth(page, 224)
  await page.reload()
  const more = page.getByTestId('todo-panel-more')
  await expect(more).toBeVisible()
  await expect(page.locator('.new-launcher-btn')).toBeHidden()
  expect(await problems(page), 'task panel at 224 px').toEqual([])
  await more.click()
  const menu = page.locator('.header-fit-more-menu')
  await expect(menu.getByRole('menuitem', { name: 'New task' })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: /board/i })).toBeVisible()
  // One Escape closes the menu only, and focus is back on More.
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(more).toBeFocused()
  // Wider, the buttons are back on the row and More is gone.
  await setTodoWidth(page, 400)
  await page.reload()
  await expect(page.locator('.new-launcher-btn')).toBeVisible()
  await expect(more).toBeHidden()
  await setTodoWidth(page, null)
})

test('a subtitle gives way before the title loses a letter (the shared CSS, any header)', async ({ page }) => {
  await isolateUiPrefs(page)
  await page.setViewportSize({ width: 1280, height: 900 })
  await loadHome(page)
  await openOrg(page) // loads header-fit.css
  // A row built like the Threads pane bar: a short title, a long subtitle, a button on the right.
  await page.evaluate(() => {
    const row = document.createElement('div')
    row.id = 'hf-probe'
    row.setAttribute('data-fit-header', '')
    row.style.cssText = 'position:fixed;left:0;top:0;gap:8px;padding:8px 12px;background:#fff;z-index:99999;font:13px system-ui'
    row.innerHTML = '<span data-fit-title="" style="font-weight:600">Threads</span>'
      + '<span data-fit-sub="">Your requests to this task, one per subject</span>'
      + '<div data-fit-actions="" style="margin-left:auto"><button type="button" class="btn btn-ghost">Turn off</button></div>'
    document.body.appendChild(row)
  })
  const row = page.locator('#hf-probe')
  for (const px of [520, 400, 330, 300, 260, 230, 200]) {
    await row.evaluate((el, w) => { (el as HTMLElement).style.width = `${w}px` }, px)
    await frames(page)
    const m = await row.evaluate((el) => {
      const t = el.querySelector('[data-fit-title]') as HTMLElement
      const s = el.querySelector('[data-fit-sub]') as HTMLElement
      return { titleCut: t.scrollWidth > t.clientWidth, subPx: s.getBoundingClientRect().width }
    })
    if (m.subPx >= 1) expect(m.titleCut, `row ${px}px: title cut while the subtitle shows ${Math.round(m.subPx)}px`).toBe(false)
  }
  await row.evaluate((el) => el.remove())
})
