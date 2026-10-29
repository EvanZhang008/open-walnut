/**
 * The session ⋮ menu, grouped by object (2026-10-27, the user's pick of three
 * designs; it had grown to 27 rows). First level: the task's frequent rows (Task
 * detail, Status, Pin to), two task groups (Dates, Move & team), three session groups
 * (Views, with the Inbox tab first; Copy & open; Debug: Raw input & output and the debug
 * snapshot), then Restart and Terminate. Each
 * group opens its rows in place, like Status. The panel count left the menu (it is the
 * whole strip's setting, in the Display menu and Settings), and so did the "Local"
 * source row (a sync that failed or is pending still shows).
 */
import fs from 'node:fs/promises'
import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test'

const SHOTS = '/tmp/session-kebab-groups'
// A local session that keeps its task in the fixture (one per engine, so two engines
// never share a row); pw-normal-session boots with its task link cleared.
const sidFor = (browserName: string) => `pw-background-bar-${browserName}`

test.setTimeout(150_000)
test.describe.configure({ mode: 'serial' })

async function openColumn(page: Page, SID: string): Promise<Locator> {
  await page.addInitScript((id) => {
    try {
      sessionStorage.setItem('open-walnut-home-session-columns', JSON.stringify([{ id, locked: false }]))
    } catch { /* ignore */ }
  }, SID)
  await page.goto('/')
  const panel = page.locator(`.main-page-session-column .session-panel[data-session-id="${SID}"]`)
  // The first spec of a run meets a cold dev server that is still compiling the app.
  await expect(panel).toBeVisible({ timeout: 90_000 })
  return panel
}

async function openMenu(page: Page, panel: Locator): Promise<Locator> {
  const kebab = panel.locator('.session-panel-header .task-kebab-btn')
  await expect(kebab).toBeVisible({ timeout: 20_000 })
  await kebab.click()
  const menu = page.locator('.task-kebab-menu')
  await expect(menu).toBeVisible()
  // The task half arrives with the task fetch.
  await expect(menu.getByTestId('kebab-group-dates')).toBeVisible({ timeout: 60_000 })
  await menu.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)))
  return menu
}

/** The rows a user sees with every group closed, top to bottom, as one line each. */
async function firstLevel(menu: Locator): Promise<string[]> {
  return menu.evaluate((root) => {
    const out: string[] = []
    const walk = (el: Element) => {
      for (const child of Array.from(el.children)) {
        const c = child as HTMLElement
        if (c.offsetParent === null && getComputedStyle(c).position !== 'fixed') continue
        if (c.matches('.task-kebab-divider')) continue
        if (c.matches('.task-kebab-item, .task-kebab-tier, .task-kebab-section-label, .task-kebab-group-toggle, .task-kebab-status-toggle')) {
          out.push(c.innerText.replace(/\s+/g, ' ').trim())
          continue
        }
        walk(c)
      }
    }
    walk(root)
    return out
  })
}

const group = (menu: Locator, id: string) => menu.getByTestId(id)
async function openGroup(menu: Locator, id: string): Promise<Locator> {
  const g = group(menu, id)
  await g.locator('.task-kebab-group-toggle').click()
  await expect(g.locator('.task-kebab-group-toggle')).toHaveAttribute('aria-expanded', 'true')
  return g.locator('.task-kebab-group-body')
}

async function shoot(page: Page, menu: Locator, name: string) {
  await fs.mkdir(SHOTS, { recursive: true })
  const box = (await menu.boundingBox())!
  await page.screenshot({
    path: `${SHOTS}/${test.info().project.name}-${name}.png`, scale: 'css',
    clip: { x: Math.max(0, box.x - 8), y: Math.max(0, box.y - 8), width: Math.min(box.width + 16, 1280), height: box.height + 16 },
  })
}

test.use({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 })

test('the first level holds the frequent rows and five groups; nothing else', async ({ page, browserName }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  const panel = await openColumn(page, sidFor(browserName))
  const menu = await openMenu(page, panel)
  const rows = await firstLevel(menu)
  const at = (re: RegExp) => rows.findIndex((r) => re.test(r))
  const order = [/^Task detail$/, /^Status: /, /^(Pin to|Pinned)/, /^Dates/, /^Move & team/, /^Session$/i, /^Views/, /^Copy & open/, /^Debug/, /^Restart/, /^Terminate/]
  const seen = order.map(at)
  expect(seen.every((i) => i >= 0), `first level: ${rows.join(' | ')}`).toBe(true)
  expect([...seen].sort((a, b) => a - b), `order: ${rows.join(' | ')}`).toEqual(seen)
  // Gone from the first level: the strip's panel count, the "Local" source row, the
  // copy rows, the views and the read-only times.
  for (const gone of [/^Panels/, /^Inbox/, /^Local$/, /^Copy session ID/, /^Copy resume/, /^Copy folder/, /^Open in VS Code/, /^Code$/, /^Notes$/, /^Msgs/, /^Usage/, /^Created/, /^Capture debug/, /^Raw input/]) {
    expect(rows.some((r) => gone.test(r)), `${gone} is not on the first level: ${rows.join(' | ')}`).toBe(false)
  }
  // The closed rows say what they hold.
  await expect(group(menu, 'kebab-group-dates').locator('.task-kebab-group-hint')).toHaveText(/start|due/)
  await expect(group(menu, 'session-kebab-views').locator('.task-kebab-group-hint')).toHaveText('inbox · code · web · notes')
  await shoot(page, menu, '1-first-level')
  expect(errors).toEqual([])
})

test('each group opens its rows in place, and the menu reopens with every group closed', async ({ page, browserName }) => {
  const panel = await openColumn(page, sidFor(browserName))
  let menu = await openMenu(page, panel)

  const views = await openGroup(menu, 'session-kebab-views')
  await expect(views.locator('.task-kebab-item')).toContainText(['Inbox', 'Code', 'Web preview', 'Notes', 'Msgs', 'Usage & Budget'])
  const copy = await openGroup(menu, 'session-kebab-copy-open')
  await expect(copy.locator('.task-kebab-item')).toContainText(['Open in VS Code', 'Copy folder path', 'Copy session ID', 'Copy resume command'])
  const meta = copy.getByTestId('session-kebab-meta')
  await expect(meta).toHaveText(/^Created .+ · Updated .+ · \S+/)
  const debug = await openGroup(menu, 'session-kebab-debug')
  await expect(debug.locator('.task-kebab-item')).toHaveText(['Raw input & output', 'Capture debug snapshot'])
  const dates = await openGroup(menu, 'kebab-group-dates')
  await expect(dates.locator('.task-kebab-date-toggle')).toContainText(['Start / Snooze until', 'Due'])
  const move = await openGroup(menu, 'kebab-group-move')
  await expect(move.locator('.task-kebab-project-label')).toHaveText('Project')
  // A group's rows carry no section dividers of their own.
  for (const body of [views, copy, debug, dates, move]) {
    await expect(body.locator('.task-kebab-divider:visible')).toHaveCount(0)
  }
  // Every group open still fits the window: the menu scrolls instead of running off
  // it, and its last row (Terminate) can be scrolled into the menu's own box.
  const fit = await menu.evaluate((el) => {
    const r = el.getBoundingClientRect()
    el.scrollTop = el.scrollHeight
    const items = el.querySelectorAll('.task-kebab-item')
    const last = items[items.length - 1].getBoundingClientRect()
    return {
      top: r.top >= -0.5, bottom: r.bottom <= window.innerHeight + 0.5,
      lastInBox: last.top >= r.top - 0.5 && last.bottom <= r.bottom + 0.5,
    }
  })
  expect(fit).toEqual({ top: true, bottom: true, lastInBox: true })
  await menu.evaluate((el) => { el.scrollTop = 0 })
  await shoot(page, menu, '2-all-open')

  // Copying keeps the menu open long enough to say so, then closes it.
  if (browserName === 'chromium') await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await copy.getByText('Copy session ID', { exact: true }).click()
  await expect(copy.getByText('Copied!', { exact: true })).toBeVisible()
  if (browserName === 'chromium') expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(sidFor(browserName))
  await expect(page.locator('.task-kebab-menu')).toHaveCount(0)

  // Reopened: every group closed again.
  menu = await openMenu(page, panel)
  await expect(menu.locator('.task-kebab-group-toggle[aria-expanded="true"]')).toHaveCount(0)
  await expect(menu.locator('.task-kebab-group-body')).toHaveCount(0)
})

test('a row inside a group still does its job: Notes opens and closes the menu', async ({ page, browserName }) => {
  const panel = await openColumn(page, sidFor(browserName))
  const menu = await openMenu(page, panel)
  const views = await openGroup(menu, 'session-kebab-views')
  await views.getByText('Notes', { exact: true }).click()
  await expect(page.locator('.task-kebab-menu')).toHaveCount(0)
  await expect(panel.locator('.session-notes-body').first()).toBeVisible({ timeout: 15_000 })
})

test('Move & team: the project picker opens over the menu and the menu stays open', async ({ page, browserName }) => {
  const panel = await openColumn(page, sidFor(browserName))
  const menu = await openMenu(page, panel)
  const move = await openGroup(menu, 'kebab-group-move')
  await move.locator('.task-kebab-project-current').click()
  await expect(page.locator('.task-kebab-project-flyout')).toBeVisible()
  await expect(page.locator('.task-kebab-menu')).toBeVisible()
  // Escape closes the picker.
  await page.keyboard.press('Escape')
  await expect(page.locator('.task-kebab-project-flyout')).toHaveCount(0)
})

async function sendLetter(request: APIRequestContext, sid: string, subject: string): Promise<string> {
  const res = await request.post('/api/v1/human-inbox', {
    data: { subject, type: 'info', markdown: `${subject} body`, text: `${subject} body` },
    headers: { 'x-walnut-caller-sid': sid },
  })
  expect(res.status(), await res.text()).toBe(201)
  return ((await res.json()) as { id: string }).id
}

// Last in the file: the letter it sends stays on the session for the rest of the run.
test('Inbox lives in Views: a letter counts on the closed row, and the row opens the tab', async ({ page, request, browserName }) => {
  const sid = sidFor(browserName)
  await sendLetter(request, sid, `PW kebab inbox ${browserName} ${Date.now()}`)
  const panel = await openColumn(page, sid)
  const menu = await openMenu(page, panel)
  const toggle = group(menu, 'session-kebab-views').locator('.task-kebab-group-toggle')
  // Closed, the Views row carries the letter count the Inbox row used to show.
  await expect(toggle.locator('.session-action-chip-count').first()).toHaveText(/^[1-9]/, { timeout: 20_000 })
  await shoot(page, menu, '5-views-inbox-count')
  const views = await openGroup(menu, 'session-kebab-views')
  // Open, the count moves to the Inbox row, which leads the group.
  await expect(toggle.locator('.session-action-chip-count')).toHaveCount(0)
  const inbox = views.locator('.task-kebab-item').first()
  await expect(inbox).toHaveText(/^Inbox\s*[1-9]/)
  await shoot(page, menu, '6-views-open-inbox')
  await inbox.click()
  await expect(menu).toHaveCount(0)
  await expect(panel.locator('.session-inbox-pane')).toBeVisible({ timeout: 20_000 })
})
