/**
 * The session ⋮ menu, grouped by object (2026-10-27, the user's pick of three
 * designs; it had grown to 27 rows). First level: the task's frequent rows (Task
 * detail, Status, Pin to, with the strip's Columns row on top), two task groups (Dates,
 * Move & transfer), three session groups (Views, with the Inbox tab first; Copy & open;
 * Debug: Raw input & output and the debug snapshot), Restart and Terminate, then
 * Session info (Created, Updated, Host). 2026-11-02: the task half is TaskMenuRows, the
 * same rows as the task list's menu (Snooze until and Watch first, Move & transfer, Team). Each group opens its rows in place, like Status.
 * 2026-10-30, the user: "why it is missing so many things": the panel count row, the task's
 * source row (now in Move & transfer) and the Created / Updated / Host rows (the Session
 * info group) came back.
 * 2026-11-02, the user's pick of ten designs (design 2, revised): Open (the header's views and
 * what Views held), Window and the Columns switch lead; Pin to, Dates and a plugin's fields are
 * each their own group; one Session group holds Copy & open, Debug, Restart, Terminate and
 * Session info (with the time it took).
 */
import fs from 'node:fs/promises'
import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import { openKebabGroup, type KebabGroupId } from './kebab-group-helpers'
import { holdPanelCountLock } from './panel-count-lock'

const SHOTS = '/tmp/task-pin-first-level/session-kebab-groups'
// A local session that keeps its task in the fixture (one per engine, so two engines
// never share a row); pw-normal-session boots with its task link cleared.
const sidFor = (browserName: string) => `pw-background-bar-${browserName}`

test.setTimeout(150_000)
test.describe.configure({ mode: 'serial' })
// The first test presses Auto in the Columns row and puts the fixture's count back: the count is
// one value the whole fixture shares, so hold it while this file runs.
holdPanelCountLock('file')

async function openColumn(page: Page, SID: string): Promise<Locator> {
  await page.addInitScript((id) => {
    try {
      sessionStorage.setItem('open-walnut-home-session-columns', JSON.stringify([{ id, locked: false }]))
    } catch { /* ignore */ }
  }, SID)
  await page.evaluate((url) => { location.assign(url) }, `http://localhost:${process.env.PW_TEST_PORT ?? 3457}/`)
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
  await menu.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished.catch(() => undefined))))
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
        if (c.matches('.task-kebab-item, .task-kebab-tier, .task-pin-shortcuts, .task-kebab-panels, .task-kebab-section-label, .task-kebab-group-toggle, .task-kebab-status-toggle')) {
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
const openGroup = (menu: Locator, id: KebabGroupId) => openKebabGroup(menu, id)

async function shoot(page: Page, menu: Locator, name: string) {
  await fs.mkdir(SHOTS, { recursive: true })
  const box = (await menu.boundingBox())!
  await page.screenshot({
    path: `${SHOTS}/${test.info().project.name}-${name}.png`, scale: 'css',
    clip: { x: Math.max(0, box.x - 8), y: Math.max(0, box.y - 8), width: Math.min(box.width + 16, 1280), height: box.height + 16 },
  })
}

test.use({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 })

test('the first level holds the frequent rows and the groups; nothing else', async ({ page, browserName }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  const panel = await openColumn(page, sidFor(browserName))
  let menu = await openMenu(page, panel)
  const rows = await firstLevel(menu)
  const at = (re: RegExp) => rows.findIndex((r) => re.test(r))
  const order = [/^Locate task$/, /^Open/, /^Window/, /^Columns/, /^Snooze until/, /^Watch$/, /^Details$/, /^Status: /, /^Pin to/, /^Dates/, /^Move & transfer/, /^Team/, /^Delete$/, /^Session/]
  const seen = order.map(at)
  expect(seen.every((i) => i >= 0), `first level: ${rows.join(' | ')}`).toBe(true)
  expect([...seen].sort((a, b) => a - b), `order: ${rows.join(' | ')}`).toEqual(seen)
  // Locate leads the menu as a row of its own (2026-11-09: the header's crosshair moved here).
  // Inside a group, not on the first level: the views, the window moves, the pin tiers, the
  // "Local" source row, the copy rows, Restart / Terminate and the read-only times.
  for (const gone of [/^Changed/, /^Files$/, /^Inbox/, /^Code$/, /^Notes$/, /^Msgs/, /^Usage/, /^Find on Home/, /^Open in new tab/, /^Full screen/,
    /^Focus$/, /^Local$/, /^Copy session ID/, /^Copy resume/, /^Copy folder/, /^Open in VS Code/, /^Created/, /^Capture debug/, /^Raw input/, /^Restart/, /^Terminate/, /^Session info/]) {
    expect(rows.some((r) => gone.test(r)), `${gone} is not on the first level: ${rows.join(' | ')}`).toBe(false)
  }
  // The closed rows say what they hold.
  await expect(group(menu, 'kebab-group-dates').locator('.task-kebab-group-hint')).toHaveText(/start|due/)
  await expect(menu.getByTestId('kebab-pin-focus')).toBeVisible()
  await expect(menu.getByTestId('kebab-pin-satellite')).toBeVisible()
  await expect(group(menu, 'kebab-group-pin').locator('.task-kebab-group-toggle')).toHaveCount(0)
  await expect(group(menu, 'session-kebab-open').locator('.task-kebab-group-hint')).toHaveText(/^changed · files .*inbox · code/)
  await expect(group(menu, 'session-kebab-session').locator('.task-kebab-group-hint')).toHaveText('copy · debug · restart · info')
  // The strip's panel count stays on the first level as the Columns row (the Display menu
  // calls the same setting "Session columns"), a segmented switch with Settings' choices.
  await expect(menu.getByTestId('kebab-panels').locator('.task-kebab-panels-label')).toHaveText('Columns')
  const opts = menu.getByTestId('kebab-panels').locator('.task-kebab-panels-opt')
  expect(await opts.evaluateAll((els) => els.map((e) => e.getAttribute('data-value')))).toEqual(['1', '2', '3', '4', '5', 'Auto'])
  const pressedAt = (await opts.evaluateAll((els) => els.map((e) => e.getAttribute('aria-pressed')))).indexOf('true')
  expect(pressedAt).toBeGreaterThanOrEqual(0)
  const original = (await opts.nth(pressedAt).getAttribute('data-value'))!
  // Each choice reads as its number, never as bars to count (2026-11-04); Auto also says
  // what it gives in this window, pressed or not (muted when not), so the track keeps one
  // width whichever choice is pressed.
  await expect(opts.nth(5)).toHaveText(/^Auto \([1-5]\)$/)
  const texts = await opts.allInnerTexts()
  expect(texts.slice(0, 5)).toEqual(['1', '2', '3', '4', '5'])
  const trackWidth = async () => (await menu.getByTestId('kebab-panels').locator('.task-kebab-panels-track').boundingBox())!.width
  const widthBefore = await trackWidth()
  // Unselected choices are as quiet as the other rows' grey hints; only the pressed one is
  // accent and semibold.
  const look = await opts.evaluateAll((els) => {
    const probe = (v: string) => {
      const s = document.createElement('span')
      s.style.color = v
      document.body.appendChild(s)
      const c = getComputedStyle(s).color
      s.remove()
      return c
    }
    return {
      secondary: probe('var(--fg-secondary)'), accent: probe('var(--accent)'),
      opts: els.map((e) => ({ color: getComputedStyle(e).color, weight: getComputedStyle(e).fontWeight })),
    }
  })
  look.opts.forEach((o, i) => expect(o, `option ${i}`).toEqual(i === pressedAt
    ? { color: look.accent, weight: '500' } : { color: look.secondary, weight: '500' }))
  // The row is as tall as the menu's other rows, and its track ends on the column of the
  // other rows' chevrons.
  const panelsBox = (await menu.getByTestId('kebab-panels').boundingBox())!
  const openBox = (await group(menu, 'session-kebab-open').locator('.task-kebab-group-toggle').boundingBox())!
  expect(Math.abs(panelsBox.height - openBox.height), `Columns ${panelsBox.height}px, Open ${openBox.height}px`).toBeLessThanOrEqual(1)
  const trackBox = (await menu.locator('.task-kebab-panels-track').boundingBox())!
  const caretBox = (await group(menu, 'session-kebab-open').locator('.task-kebab-status-caret').first().boundingBox())!
  const trackRight = trackBox.x + trackBox.width
  const caretRight = caretBox.x + caretBox.width
  expect(Math.abs(trackRight - caretRight), `track right ${trackRight}, chevron right ${caretRight}`).toBeLessThanOrEqual(1)
  // The fresh state: a menu opened by a click, before any key, shows no focus ring.
  await expect(menu.locator('.task-kebab-panels-opt:focus-visible')).toHaveCount(0)
  await shoot(page, menu, '1-first-level')

  // Left and Right move between the choices.
  await opts.nth(1).focus()
  await page.keyboard.press('ArrowRight')
  await expect(opts.nth(2)).toBeFocused()
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowLeft')
  await expect(opts.nth(0)).toBeFocused()
  await expect(menu).toBeVisible()
  // The ring on an unselected option ("4", or "3" when 4 is the pressed one), reached with
  // the arrows from the pressed one, so it is seen apart from the chip. A user reaches the
  // track with Tab (a click on an option closes the menu), and only a keyboard focus draws
  // the ring, so the walk starts with Shift+Tab, Tab, not a script focus.
  const target = pressedAt === 3 ? 2 : 3
  if (browserName === 'webkit') {
    // Safari's Tab skips buttons unless Full Keyboard Access is enabled; Option+Tab reaches them.
    await page.keyboard.press('Alt+Shift+Tab')
    await page.keyboard.press('Alt+Tab')
  } else {
    await page.keyboard.press('Shift+Tab')
    await page.keyboard.press('Tab')
  }
  await expect(opts.nth(0)).toBeFocused()
  for (let i = 0; i < pressedAt; i++) await page.keyboard.press('ArrowRight')
  await expect(opts.nth(pressedAt)).toBeFocused()
  for (let i = 0; i < Math.abs(target - pressedAt); i++) await page.keyboard.press(target > pressedAt ? 'ArrowRight' : 'ArrowLeft')
  await expect(opts.nth(target)).toBeFocused()
  await expect(opts.nth(target)).toHaveAttribute('aria-pressed', 'false')
  await expect(menu.locator('.task-kebab-panels-opt:focus-visible')).toHaveCount(1)
  // Focus on a choice that is not pressed is an accent underline under its words, never a
  // box, so it can not read as a second pressed chip.
  const ring = await opts.nth(target).evaluate((el) => {
    const cs = getComputedStyle(el)
    return { outline: cs.outlineStyle, line: cs.textDecorationLine, thickness: cs.textDecorationThickness }
  })
  expect(ring).toEqual({ outline: 'none', line: 'underline', thickness: '2px' })
  await shoot(page, menu, '1b-panels-keyboard-focus')
  await opts.nth(5).hover()
  await shoot(page, menu, '1c-panels-hover-auto')
  await page.mouse.move(0, 0)
  await expect(menu.getByTestId('kebab-panels').locator('.task-kebab-panels-opt[aria-pressed="true"]')).toHaveCount(1)

  // Auto pressed: its cell says how many panels Auto gives at this window width.
  if (original !== 'Auto') {
    await opts.nth(5).click()
    await expect(menu).toBeHidden()
    menu = await openMenu(page, panel)
  }
  await expect(opts.nth(5)).toHaveAttribute('aria-pressed', 'true')
  await expect(opts.nth(5)).toHaveText(/^Auto \([1-5]\)$/)
  // Pressing Auto moves nothing: the track is as wide as it was with a number pressed.
  if (original !== 'Auto') expect(Math.abs((await trackWidth()) - widthBefore)).toBeLessThanOrEqual(1)
  await page.mouse.move(0, 0)
  await shoot(page, menu, '1d-panels-auto-pressed')
  // Put the fixture's choice back for the tests after this one.
  if (original !== 'Auto') {
    await menu.locator(`.task-kebab-panels-opt[data-value="${original}"]`).click()
    await expect(menu).toBeHidden()
  }
  expect(errors).toEqual([])
})

test('each group opens its rows in place, and the menu reopens with every group closed', async ({ page, browserName }) => {
  const panel = await openColumn(page, sidFor(browserName))
  let menu = await openMenu(page, panel)

  const views = await openGroup(menu, 'session-kebab-open')
  await expect(views.locator('.task-kebab-item')).toContainText(['Changed', 'Files', 'Inbox', 'Code', 'Web preview', 'Notes', 'Msgs', 'Usage & Budget'])
  const win = await openGroup(menu, 'session-kebab-window')
  await expect(win.locator('.task-kebab-item')).toContainText(['Open in new tab', 'Full screen'])
  const pin = await openGroup(menu, 'kebab-group-pin')
  await expect(pin.locator('.task-kebab-tier-options [data-testid^="kebab-pin-"]')).toContainText(['Focus', 'Satellite'])
  const copy = await openGroup(menu, 'session-kebab-copy-open')
  await expect(copy.locator('.task-kebab-item')).toContainText(['Open in VS Code', 'Copy folder path', 'Copy session ID', 'Copy resume command'])
  await expect(copy.getByTestId('session-kebab-meta')).toHaveCount(0)
  const details = await openGroup(menu, 'session-kebab-details')
  await expect(details.locator('.task-kebab-meta-label')).toHaveText(['Created', 'Updated', 'Host'])
  await expect(details.locator('.task-kebab-meta-value').first()).toHaveText(/^(just now|\d+(m|h|d|w|mo|y) ago)$/)
  const debug = await openGroup(menu, 'session-kebab-debug')
  await expect(debug.locator('.task-kebab-item')).toHaveText(['Raw input & output', 'Capture debug snapshot'])
  const session = group(menu, 'session-kebab-session').locator('> .task-kebab-group-body')
  await expect(session.locator('> .task-kebab-item')).toContainText(['Restart', 'Terminate'])
  const dates = await openGroup(menu, 'kebab-group-dates')
  await expect(dates.locator('.task-kebab-date-toggle')).toContainText(['Start', 'Due'])
  const move = await openGroup(menu, 'kebab-group-move')
  await expect(move.locator('.task-kebab-project-label')).toHaveText('Project')
  // Where the task comes from is back: a local task says Local, a synced one names its service.
  await expect(move.locator('[data-testid="kebab-source-row"], [data-testid="kebab-source-link"]')).toHaveCount(1)
  // A group's rows carry no section dividers of their own.
  for (const body of [views, win, copy, details, debug, dates, move]) {
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
  const views = await openGroup(menu, 'session-kebab-open')
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
test('Inbox lives in Open: a letter counts on the closed row, and the row opens the tab', async ({ page, request, browserName }) => {
  const sid = sidFor(browserName)
  await sendLetter(request, sid, `PW kebab inbox ${browserName} ${Date.now()}`)
  const panel = await openColumn(page, sid)
  const menu = await openMenu(page, panel)
  const toggle = group(menu, 'session-kebab-open').locator('.task-kebab-group-toggle')
  // Closed, the Open row carries the letter count the Inbox row used to show.
  await expect(toggle.locator('.session-action-chip-count').first()).toHaveText(/^[1-9]/, { timeout: 20_000 })
  await shoot(page, menu, '5-views-inbox-count')
  const views = await openGroup(menu, 'session-kebab-open')
  // Open, the count moves to the Inbox row, which leads the group's second half.
  await expect(toggle.locator('.session-action-chip-count')).toHaveCount(0)
  const inbox = views.locator('.task-kebab-item').filter({ hasText: /^Inbox/ })
  await expect(inbox).toHaveText(/^Inbox\s*[1-9]/)
  await shoot(page, menu, '6-views-open-inbox')
  await inbox.click()
  await expect(menu).toHaveCount(0)
  await expect(panel.locator('.session-inbox-pane')).toBeVisible({ timeout: 20_000 })
})
