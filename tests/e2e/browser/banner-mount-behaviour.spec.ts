/**
 * How the attention card behaves around the notification panel (banner
 * placement slice, 4.1, 4.2, 5.2, 5.3, 5.5): the card stays in the task panel
 * on every section (the panel holds no card, its System section lists each
 * host once), keyboard order in System and focus after the card leaves,
 * clicks inside System never close the panel, the list keeps its scroll, the
 * card never starts a task drag, the card waits while the pointer is over
 * what would move, the Errors group heading and its Shown in System link, and
 * the System rail count.
 * Host frames and local health are routed client-side; page.goto only loads
 * the app, every other step is a real click, key or pointer move.
 *
 * Run: PW_TEST_PORT=35961 PW_IGNORE_LOAD=1 npx playwright test banner-mount-behaviour --project=chromium --workers=1
 *      PW_WEBKIT=1 PW_TEST_PORT=35961 PW_IGNORE_LOAD=1 npx playwright test banner-mount-behaviour --project=webkit --workers=1
 */
import fs from 'node:fs'
import { test, expect, type Page } from '@playwright/test'
import { banner, connected, failed, outdated, resetServerHostFixture, row } from './host-problems-helpers'
import { openBell, panelBanner } from './host-problems-fixture-helpers'
import {
  BP_SHOTS, bpSetup, closePanel, expectHomeCardStill, expectTasksCard, hostErrorRecord, markHomeCard, maxCards, openSystemHosts,
  panelMount, pickRail, railButton, systemBadge, systemHostRow, systemHosts,
} from './banner-placement-helpers'

test.describe.configure({ timeout: 90_000 })

test.beforeAll(async ({ request }) => {
  fs.mkdirSync(BP_SHOTS, { recursive: true })
  await resetServerHostFixture(request)
})

// A health or feed fetch still in flight when the page closes must not fail the test.
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: 'ignoreErrors' }) })

const activeDescr = (page: Page): Promise<string> => page.evaluate(() => {
  const a = document.activeElement as HTMLElement | null
  if (!a) return 'none'
  return `${a.tagName.toLowerCase()}|${a.className}|${a.getAttribute('aria-label') ?? a.textContent?.trim().slice(0, 40) ?? ''}`
})

const inCard = (page: Page, sel: string): Promise<boolean> =>
  page.evaluate((s) => !!document.activeElement?.closest(s), sel)

test.describe('the notification panel holds no card', () => {
  test('C6 bell spot: a click where the bell is, with System open, closes the panel; the Home card never left', async ({ page }) => {
    await bpSetup(page)
    await expectTasksCard(page)
    const place = await markHomeCard(page)
    await openSystemHosts(page)
    // The panel's full-window backdrop sits over the bell: the second click lands on it and closes the panel.
    const box = (await page.locator('.sidebar-notification-btn').boundingBox())!
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await expect(page.locator('.notification-panel')).toHaveCount(0)
    await expectHomeCardStill(page, place, 'after the bell spot')
  })

  test('C25: in System, Tab from the All rail button lands on the first problem row\'s first control; Shift+Tab goes back; Tab past the list stays in the panel', async ({ page, browserName }) => {
    // WebKit on macOS moves Tab through buttons with Option held (the Safari default).
    const TAB = browserName === 'webkit' ? 'Alt+Tab' : 'Tab'
    const LIST = '.notification-panel [data-testid="nfc-remote-hosts"]'
    await bpSetup(page)
    await expectTasksCard(page)
    const hosts = await openSystemHosts(page)
    // Tab order: header, the rail (Needs Action ... All), then the section. The list is in
    // Settings order: Dev box and Build box are plain lines, Sign box is the first problem row.
    const first = systemHostRow(page, 'signbox').locator('.hpb-actions button').first()
    await railButton(page, 'All').focus()
    await page.keyboard.press(TAB)
    await expect(first, await activeDescr(page)).toBeFocused()
    await page.keyboard.press(browserName === 'webkit' ? 'Alt+Shift+Tab' : 'Shift+Tab')
    await expect(railButton(page, 'All')).toBeFocused()
    await page.keyboard.press(TAB)
    const inside = await hosts.evaluate((el) => el.querySelectorAll('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])').length)
    for (let i = 0; i < inside + 5 && await inCard(page, LIST); i++) await page.keyboard.press(TAB)
    const after = await page.evaluate((sel) => {
      const a = document.activeElement
      return { inPanel: !!a?.closest('.notification-panel'), inList: !!a?.closest(sel), body: a === document.body }
    }, LIST)
    expect(after, await activeDescr(page)).toEqual({ inPanel: true, inList: false, body: false })
  })

  test('C27: clicks on a System row\'s text and on the Remote hosts label keep the panel open; Escape with focus in a row closes it', async ({ page }) => {
    await bpSetup(page, { local: 'sign-in' })
    await expectTasksCard(page)
    const hosts = await openSystemHosts(page)
    await hosts.locator('.notification-card-label').click()
    await expect(page.locator('.notification-panel')).toHaveCount(1)
    await systemHostRow(page, 'keybox').locator('.hft-headline').click()
    await expect(page.locator('.notification-panel')).toHaveCount(1)
    await systemHostRow(page, 'keybox').getByTestId('hpb-retry').focus()
    expect(await inCard(page, '.notification-panel li.hpb-row[data-host="keybox"]')).toBe(true)
    await page.keyboard.press('Escape')
    await expect(page.locator('.notification-panel')).toHaveCount(0)
    await expect(banner(page)).toHaveCount(1)
  })

  test('C36: no section holds a card: the Home card never moves or remounts while the panel is open on any section; a second System click keeps the same list', async ({ page }) => {
    await bpSetup(page, { probe: true })
    await expectTasksCard(page)
    const place = await markHomeCard(page)
    await openSystemHosts(page)
    await systemHosts(page).evaluate((el) => { el.setAttribute('data-bp-mark', 'kept') })
    // Picking System again is no change: the list is not remounted.
    await railButton(page, 'System').click()
    await expect(systemHosts(page)).toHaveAttribute('data-bp-mark', 'kept')
    for (const label of ['Needs Action', 'Inbox', 'Errors', 'Automation', 'System', 'All']) {
      await pickRail(page, label)
      await expect(panelMount(page), label).toHaveCount(0)
      await expect(panelBanner(page), label).toHaveCount(0)
      await expectHomeCardStill(page, place, label)
    }
    await closePanel(page, 'escape')
    await expectHomeCardStill(page, place, 'after Escape')
    expect(await maxCards(page)).toBe(1)
  })
})

const TAB_BAR_KEY = 'walnut-todo-quick-views-visible'
/** Mark the first visible list row under the card (a task, else a project or tier row) and return its selector. */
async function firstRow(page: Page): Promise<string> {
  const ok = await page.evaluate(() => {
    const panel = document.querySelector('.todo-panel')!
    const mount = panel.querySelector('.ab-mount')
    const shown = (e: Element) => { const r = e.getBoundingClientRect(); return r.height > 0 && r.width > 0 && r.top < window.innerHeight }
    const below = (e: Element) => !mount || (!mount.contains(e) && !!(mount.compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING))
    const toolbar = panel.querySelector('.todo-panel-toolbar')
    const cands = [...panel.querySelectorAll('[data-task-id], button')].filter((e) => !toolbar?.contains(e))
    const el = cands.find((e) => shown(e) && below(e))
    el?.setAttribute('data-bp-row', '1')
    return !!el
  })
  expect(ok, 'a visible list row').toBe(true)
  return '.todo-panel [data-bp-row="1"]'
}
const topOf = async (page: Page, sel: string): Promise<number> =>
  page.locator(sel).first().evaluate((el) => Math.round(el.getBoundingClientRect().top * 10) / 10)

/** The task panel's list scroller: the first scrollable box under the card. */
async function listScroller(page: Page): Promise<string> {
  return page.evaluate(() => {
    const panel = document.querySelector('.todo-panel')!
    const all = Array.from(panel.querySelectorAll<HTMLElement>('*'))
    const el = all.find((e) => !e.closest('.ab-mount') && /(auto|scroll)/.test(getComputedStyle(e).overflowY) && e.scrollHeight - e.clientHeight > 50)
    if (!el) return ''
    el.setAttribute('data-bp-scroller', '1')
    return '[data-bp-scroller="1"]'
  })
}

test.describe('the task panel mount', () => {
  test('C26: Enter on the last row x focuses Undo, then the selected section tab once the undo row folds; Enter there changes nothing', async ({ page }) => {
    await page.addInitScript((k) => localStorage.setItem(k, 'true'), TAB_BAR_KEY)
    await bpSetup(page, { hosts: [connected('devbox', 'Dev box'), failed('netbox', 'Net box', 'unreachable')] })
    await expectTasksCard(page, ['netbox'])
    await expect(page.locator('.todo-section-tabs-list [role="tab"][aria-selected="true"]')).toHaveCount(1)
    const tasksBefore = await page.locator('.todo-panel [data-task-id]').count()
    await banner(page).getByRole('button', { name: 'Dismiss Net box' }).focus()
    await page.keyboard.press('Enter')
    await expect(banner(page).getByRole('button', { name: 'Undo' })).toBeFocused()
    await page.mouse.move(1000, 600)
    await expect.poll(() => page.evaluate(() => document.activeElement?.matches('.todo-section-tabs-list [role="tab"][aria-selected="true"]') ?? false), { timeout: 15_000 }).toBe(true)
    await page.keyboard.press('Enter')
    await page.waitForTimeout(300)
    await expect(page.locator('[role="menu"]')).toHaveCount(0)
    expect(await page.locator('.todo-panel [data-task-id]').count()).toBe(tasksBefore)
  })

  test('C65: with the tab bar off, focus lands on the mount itself, and Tab goes on into the list, never onto a tier plus, chip or AI lane button', async ({ page }) => {
    await page.addInitScript((k) => localStorage.setItem(k, 'false'), TAB_BAR_KEY)
    await bpSetup(page, { hosts: [connected('devbox', 'Dev box'), failed('netbox', 'Net box', 'unreachable')] })
    await expectTasksCard(page, ['netbox'])
    await expect(page.locator('.todo-section-tabs-list')).toHaveCount(0)
    await banner(page).getByRole('button', { name: 'Dismiss Net box' }).focus()
    await page.keyboard.press('Enter')
    await expect(banner(page).getByRole('button', { name: 'Undo' })).toBeFocused()
    await page.mouse.move(1000, 600)
    await expect.poll(() => page.evaluate(() => document.activeElement?.matches('.todo-panel > .ab-mount') ?? false), { timeout: 15_000 }).toBe(true)
    await expect(page.locator('.todo-panel > .ab-mount')).toHaveAttribute('aria-label', 'Task panel')
    await page.keyboard.press('Tab')
    const landed = await activeDescr(page)
    expect(await page.evaluate(() => !!document.activeElement?.closest('.todo-panel'))).toBe(true)
    expect(landed).not.toMatch(/tier-plus|filter-chip|agent-search/)
  })
})

test.describe('the task panel mount holds the list still', () => {
  test('C35: while searching the card stays under the toolbar, the AI lane under the card, and scrolling the results moves neither', async ({ page }) => {
    await bpSetup(page)
    await expectTasksCard(page)
    await page.locator('.todo-panel .todo-search-input').fill('a')
    const lane = page.getByTestId('agent-search-panel')
    const card = banner(page)
    const tb = (await page.locator('.todo-panel-toolbar').boundingBox())!
    const cb = (await card.boundingBox())!
    expect(cb.y).toBeGreaterThanOrEqual(tb.y + tb.height - 1)
    const laneShown = await lane.isVisible().catch(() => false)
    const laneTop = laneShown ? (await lane.boundingBox())!.y : 0
    if (laneShown) expect(laneTop).toBeGreaterThanOrEqual(cb.y + cb.height - 1)
    const scroller = await listScroller(page)
    if (scroller) await page.locator(scroller).evaluate((el) => { el.scrollTop = 200 })
    await page.waitForTimeout(150)
    expect(Math.abs((await card.boundingBox())!.y - cb.y)).toBeLessThanOrEqual(1)
    if (laneShown) expect(Math.abs((await lane.boundingBox())!.y - laneTop)).toBeLessThanOrEqual(1)
  })

  test('C37: the list keeps its scroll through opening the panel, System and All, and closing it', async ({ page }) => {
    // The fixture list is short: a low window gives it a real scroll range (400px when it has one).
    // 420, not 480: the card now ends on a whole row (N3-18), so it is shorter and the list longer.
    await page.setViewportSize({ width: 1280, height: 420 })
    await bpSetup(page)
    await expectTasksCard(page)
    const scroller = await listScroller(page)
    expect(scroller, 'a scrollable task list').not.toBe('')
    const target = await page.locator(scroller).evaluate((el) => { el.scrollTop = 400; return el.scrollTop })
    expect(target).toBeGreaterThanOrEqual(60)
    await openSystemHosts(page)
    expect(Math.abs(await page.locator(scroller).evaluate((el) => el.scrollTop) - target)).toBeLessThanOrEqual(1)
    // The card never leaves the task panel: the list keeps its scroll on every section.
    await pickRail(page, 'All')
    await expect(banner(page)).toHaveCount(1)
    expect(Math.abs(await page.locator(scroller).evaluate((el) => el.scrollTop) - target)).toBeLessThanOrEqual(1)
    await pickRail(page, 'System')
    await closePanel(page, 'escape')
    await expect(banner(page)).toHaveCount(1)
    expect(Math.abs(await page.locator(scroller).evaluate((el) => el.scrollTop) - target)).toBeLessThanOrEqual(1)
  })

  test('C38: a press and a 40px move on the card never starts a task drag and moves no task', async ({ page }) => {
    await bpSetup(page)
    await expectTasksCard(page)
    await page.evaluate(() => {
      const w = window as unknown as { __bpDrag: boolean }
      w.__bpDrag = false
      const panel = document.querySelector('.todo-panel')!
      new MutationObserver(() => { if (panel.classList.contains('is-task-dragging') || document.querySelector('.drag-overlay-item')) w.__bpDrag = true })
        .observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] })
    })
    const order = () => page.locator('.todo-panel [data-task-id]').evaluateAll((els) => els.map((e) => e.getAttribute('data-task-id')))
    const before = await order()
    const text = banner(page).locator('li.hpb-row[data-host] .hpb-headline, li.hpb-row[data-host]').first()
    const box = (await text.boundingBox())!
    await page.mouse.move(box.x + 30, box.y + 8)
    await page.mouse.down()
    for (let i = 1; i <= 8; i++) await page.mouse.move(box.x + 30, box.y + 8 + i * 5)
    await page.mouse.up()
    await page.waitForTimeout(300)
    expect(await page.evaluate(() => (window as unknown as { __bpDrag: boolean }).__bpDrag)).toBe(false)
    expect(await order()).toEqual(before)
  })

  test('C46: a wide task panel does not move under the panel\'s System section (the card stays, same node, same height)', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 })
    await bpSetup(page)
    await expectTasksCard(page)
    const handle = page.locator('.todo-resize-handle')
    const hb = (await handle.boundingBox())!
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2)
    await page.mouse.down()
    await page.mouse.move(hb.x + 400, hb.y + hb.height / 2, { steps: 10 })
    await page.mouse.up()
    await page.mouse.move(1500, 850)
    // The card re-lays out for the new width (and waits while the pointer was on the handle): let it settle.
    let cardH = 0
    let same = 0
    await expect.poll(async () => {
      const h = (await banner(page).boundingBox())!.height
      same = h === cardH ? same + 1 : 0
      cardH = h
      return same
    }, { intervals: [400], timeout: 20_000 }).toBeGreaterThanOrEqual(3)
    const rowSel = await firstRow(page)
    const before = await topOf(page, rowSel)
    const place = await markHomeCard(page)
    expect(Math.abs(place.height - cardH)).toBeLessThanOrEqual(1)
    await openSystemHosts(page)
    await expectHomeCardStill(page, place, 'System open')
    expect(Math.abs(await topOf(page, rowSel) - before)).toBeLessThanOrEqual(1)
    await page.screenshot({ path: `${BP_SHOTS}/p3-c46-wide-panel-system.png` })
  })
})

/** Frames from now until the mount's height stops changing: [ms of first nonzero frame, ms of the last change]. */
async function enterTiming(page: Page): Promise<{ first: number; settled: number }> {
  return page.evaluate(() => new Promise<{ first: number; settled: number }>((resolve) => {
    const el = document.querySelector('.todo-panel > .ab-mount')!
    const t0 = performance.now()
    let first = -1
    let last = -1
    let lastH = el.getBoundingClientRect().height
    const tick = () => {
      const h = el.getBoundingClientRect().height
      const t = performance.now() - t0
      if (h > 0 && first < 0) first = t
      if (h !== lastH) { last = t; lastH = h }
      if (t > 1500) resolve({ first, settled: last })
      else requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }))
}

test.describe('the card waits for the pointer (5.5)', () => {
  for (const motion of ['no-preference', 'reduce'] as const) {
    test(`C51 (${motion}): a new problem waits while the pointer rests on the first task, then enters once it leaves`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: motion })
      const hosts = await bpSetup(page, { hosts: [connected('devbox', 'Dev box'), connected('netbox', 'Net box')] })
      await page.waitForTimeout(800)
      await expect(banner(page)).toHaveCount(0)
      const rowSel = await firstRow(page)
      const rb = (await page.locator(rowSel).boundingBox())!
      await page.mouse.move(rb.x + 20, rb.y + rb.height / 2)
      const before = await topOf(page, rowSel)
      await hosts.push(failed('netbox', 'Net box', 'unreachable'))
      await page.waitForTimeout(1500)
      expect(Math.abs(await topOf(page, rowSel) - before), 'the row under the pointer stays put').toBeLessThanOrEqual(1)
      const timing = enterTiming(page)
      await page.mouse.move(1000, 600)
      const { first, settled } = await timing
      await expect(banner(page)).toHaveCount(1)
      await expect(banner(page).locator('li.hpb-row[data-host="netbox"]')).toHaveCount(1)
      expect(first, 'the card entered after the pointer left').toBeGreaterThanOrEqual(0)
      if (motion === 'reduce') expect(settled - first, 'no grow under reduced motion').toBeLessThanOrEqual(40)
      else expect(settled - first, 'the grow takes at most 200ms').toBeLessThanOrEqual(220)
      expect(await topOf(page, rowSel)).toBeGreaterThan(before + 20)
    })
  }
})

test.describe('the Errors group and the System rail', () => {
  test('C57: a host cause group is named by the host label with a "Shown in System" link that opens System on the host\'s row, open; a Home card dismissal keeps the link; the host recovering drops it, never the group', async ({ page }) => {
    const h = await bpSetup(page, {
      hosts: [connected('devbox', 'Dev box'), failed('certbox', 'Cert box', 'cert_expired')],
      feed: [hostErrorRecord('certbox', 1), hostErrorRecord('certbox', 2)],
    })
    await expectTasksCard(page, ['certbox'])
    await openBell(page)
    await pickRail(page, 'Errors')
    // No section holds the card; the Errors view points at the host's row in System.
    await expect(panelBanner(page)).toHaveCount(0)
    const title = page.locator('.notification-panel .nfc-cause-header .nfc-cat-title[data-cause-key="host:certbox"]')
    await expect(title.locator('.nfc-cat-name')).toHaveText("Can't reach Cert box")
    const link = title.locator('.nfc-cat-shown-link')
    await expect(link).toHaveText('Shown in System')
    await expect(link).toHaveJSProperty('tagName', 'BUTTON')
    await page.screenshot({ path: `${BP_SHOTS}/p3-c57-errors-group.png` })
    await link.click()
    await expect(railButton(page, 'System')).toHaveAttribute('aria-current', 'true')
    const r = systemHostRow(page, 'certbox')
    await expect(r).toBeVisible()
    await expect(r).toHaveClass(/hpb-open/)
    await expect(r.locator('.hft-hint')).toBeVisible()
    await expect(systemHosts(page).getByRole('button', { name: 'Dismiss Cert box' })).toHaveCount(0)
    await closePanel(page, 'escape')
    // The Home card's x hides the card row; the System list is a status list and keeps it.
    await row(page, 'certbox').getByRole('button', { name: 'Dismiss Cert box' }).click()
    await expect(row(page, 'certbox')).toHaveCount(0)
    await openBell(page)
    await pickRail(page, 'Errors')
    await expect(link).toHaveCount(1)
    await pickRail(page, 'System')
    await expect(systemHostRow(page, 'certbox')).toBeVisible()
    // Recovered: the list shows a plain Connected line, so the link goes; the group stays.
    await h.push(connected('certbox', 'Cert box'))
    await expect(systemHostRow(page, 'certbox')).toHaveCount(0, { timeout: 10_000 })
    await pickRail(page, 'Errors')
    await expect(title.locator('.nfc-cat-name')).toHaveText("Can't reach Cert box")
    await expect(title.locator('.nfc-cat-shown')).toHaveCount(0)
  })

  test('C58: an unreachable host counts 1 on the System rail (git sync healthy), before and after System opens; the pane card reads Remote hosts', async ({ page }) => {
    await bpSetup(page, { hosts: [connected('devbox', 'Dev box'), failed('netbox', 'Net box', 'unreachable')] })
    await expectTasksCard(page, ['netbox'])
    await openBell(page)
    const system = railButton(page, 'System')
    await expect(systemBadge(page)).toHaveText('1')
    await expect(system.locator('.nfc-rail-dot')).toHaveCount(0)
    await pickRail(page, 'System')
    await expect(systemBadge(page)).toHaveText('1')
    await expect(page.locator('.notification-panel .notification-card-label', { hasText: /^Remote hosts$/ })).toHaveCount(1)
  })

  test('C58: a claude_outdated host alone leaves the System rail without a count or a dot, and the pane still lists it', async ({ page }) => {
    await bpSetup(page, { hosts: [connected('devbox', 'Dev box'), outdated('buildbox', 'Build box')] })
    await page.waitForTimeout(800)
    // The pane lists the daemons system health reports (its own fetch when it opens): name both hosts.
    await page.route('**/api/system/health', async (route) => {
      const body = await (await route.fetch()).json() as Record<string, unknown>
      body.daemons = [{ host: 'devbox', label: 'Dev box', connected: true }, { host: 'buildbox', label: 'Build box', connected: true }]
      await route.fulfill({ json: body })
    })
    await openBell(page)
    const system = railButton(page, 'System')
    await expect(system).toBeVisible()
    await expect(system.locator('.nfc-rail-dot')).toHaveCount(0)
    await expect(systemBadge(page)).toHaveCount(0)
    await system.click()
    await expect(page.locator('.notification-panel').getByText('Build box').first()).toBeVisible()
    await expect(systemBadge(page)).toHaveCount(0)
  })
})


