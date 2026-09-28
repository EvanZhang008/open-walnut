/**
 * Where the attention card mounts (slice spec 2 and 4.4): the task panel on
 * Home, the notification panel's System section on any route (the bell lands
 * there only when no in-page card covers the problem), the slot and the draft
 * column only while the task panel is hidden, and never two cards at once.
 * Host frames and local health are routed client-side; page.goto only loads
 * the app, every other step is a real click or key.
 *
 * WebKit-only checks (BP-C2, BP-C56) skip themselves outside WebKit: run the
 * file with PW_WEBKIT=1 --project=webkit as well.
 *
 * Run: PW_TEST_PORT=35994 PW_IGNORE_LOAD=1 npx playwright test banner-placement-mounts --project=chromium --workers=1
 *      PW_WEBKIT=1 PW_TEST_PORT=35994 PW_IGNORE_LOAD=1 npx playwright test banner-placement-mounts --project=webkit --workers=1
 */
import fs from 'node:fs'
import { test, expect } from '@playwright/test'
import {
  anyBanner, banner, connected, hideTaskPanel, outdated, resetServerHostFixture, showTaskPanel,
} from './host-problems-helpers'
import { openBell, panelBanner, slotBanner, tasksBanner } from './host-problems-fixture-helpers'
import { openDraft } from './draft-helpers'
import {
  BP_SHOTS, FIXTURE_ORDER, bellDot, bpSetup, cardRow, closePanel, countInFirstFrameAfterClick, expectTasksCard, goRail, hostsOf,
  maxCards, openPanelCard, panelMount, pickRail, railButton, reserve, settingsDot, systemBadge, toolbarHide, triples, type CloseWay,
} from './banner-placement-helpers'

test.describe.configure({ timeout: 90_000 })

test.beforeAll(async ({ request }) => {
  fs.mkdirSync(BP_SHOTS, { recursive: true })
  await resetServerHostFixture(request)
})

test.describe('the task panel is the Home mount', () => {
  test('BP-C1: default Home: exactly one card, in the task panel after the toolbar and before the list; none in the slot', async ({ page }) => {
    await bpSetup(page)
    await expectTasksCard(page)
    await expect(page.locator('.main-page-chat [data-testid="attention-banner"]')).toHaveCount(0)
    const order = await banner(page).evaluate((card) => {
      const panel = card.closest('.todo-panel')!
      const toolbar = panel.querySelector('.todo-panel-toolbar')!
      const list = panel.querySelector('.todo-panel-list')
      const tabs = panel.querySelector('.todo-section-tabs-list')
      const after = (a: Element, b: Element | null) => !b || !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
      return { afterToolbar: after(toolbar, card), beforeList: after(card, list), beforeTabs: after(card, tabs), hasList: !!list }
    })
    expect(order).toEqual({ afterToolbar: true, beforeList: true, beforeTabs: true, hasList: true })
    await banner(page).screenshot({ path: `${BP_SHOTS}/c1-tasks-card.png` })
  })

  test('BP-C2: WebKit 980x800, chat hidden, no session column: the card is on the first screen of the task panel', async ({ page, browserName }) => {
    test.skip(browserName !== 'webkit', 'WebKit only: the Mac app engine')
    await page.setViewportSize({ width: 980, height: 800 })
    await bpSetup(page, { before: async (p) => { await p.addInitScript(() => localStorage.setItem('open-walnut-home-chat-visible', 'false')) } })
    await expectTasksCard(page)
    await expect(page.locator('.main-page-session-column')).toHaveCount(0)
    const box = (await banner(page).boundingBox())!
    expect(box.y).toBeLessThan(200)
    await expect(banner(page)).toBeInViewport()
    await page.screenshot({ path: `${BP_SHOTS}/c2-webkit-980x800.png` })
  })

  test('BP-C3: a healthy host and a claude_outdated host take no row in the task panel or the notification panel', async ({ page }) => {
    await bpSetup(page)
    await expectTasksCard(page)
    for (const host of ['devbox', 'buildbox']) await expect(banner(page).locator(`li.hpb-row[data-host="${host}"]`)).toHaveCount(0)
    const card = await openPanelCard(page)
    await expect.poll(() => hostsOf(card)).toEqual(FIXTURE_ORDER)
    for (const host of ['devbox', 'buildbox']) await expect(card.locator(`li.hpb-row[data-host="${host}"]`)).toHaveCount(0)
  })

  test('BP-C4: the task panel rows equal the notification panel rows equal the model order', async ({ page }) => {
    await bpSetup(page)
    await expectTasksCard(page)
    const inTasks = await triples(banner(page))
    expect(inTasks.map((t) => t.split('|')[0])).toEqual(FIXTURE_ORDER)
    expect(inTasks.slice(0, 3).every((t) => t.split('|')[1] === 'connect')).toBe(true)
    expect(inTasks[3]).toBe('signbox|readiness|claude_not_logged_in')
    const card = await openPanelCard(page)
    expect(await triples(card)).toEqual(inTasks)
  })
})

test.describe('the notification panel takes the card while its System section shows', () => {
  test('BP-C5: the bell on Home, then System: one card, the first block of the System section above its pane cards; the task panel keeps a same-height reserve', async ({ page }) => {
    await bpSetup(page)
    await expectTasksCard(page)
    const before = (await banner(page).boundingBox())!.height
    const card = await openPanelCard(page)
    await expect(card).toHaveAttribute('data-mount', 'notifications')
    const place = await card.evaluate((el) => {
      const panel = el.closest('.notification-panel')!
      const mount = el.closest('.ab-mount')!
      const detail = panel.querySelector('.nfc-detail')!
      const pane = detail.querySelector('.notification-card')
      const follows = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
      return {
        inDetail: detail.contains(el), firstBlock: detail.firstElementChild === mount, abovePane: !!pane && follows(mount, pane),
        paneBelow: !!pane && pane.getBoundingClientRect().top >= el.getBoundingClientRect().bottom - 1,
        betweenHeaderAndBody: mount.parentElement === panel,
      }
    })
    expect(place).toEqual({ inDetail: true, firstBlock: true, abovePane: true, paneBelow: true, betweenHeaderAndBody: false })
    await expect(page.locator('.notification-panel > .ab-mount')).toHaveCount(0)
    await expect(page.locator('.todo-panel [data-testid="attention-banner"]')).toHaveCount(0)
    await expect(page.locator('.todo-panel .ab-mount-reserve')).toHaveCount(1)
    const held = (await page.locator('.todo-panel .ab-mount-reserve').boundingBox())!.height
    expect(Math.abs(held - before)).toBeLessThanOrEqual(1)
    await page.screenshot({ path: `${BP_SHOTS}/c5-panel-card.png` })
  })

  test('BP-C6: Escape, the backdrop, Close and the bell again each bring the card back to the task panel, same rows, no reserve', async ({ page }) => {
    await bpSetup(page)
    await expectTasksCard(page)
    const inTasks = await triples(banner(page))
    for (const how of ['escape', 'backdrop', 'close', 'bell'] as CloseWay[]) {
      await openPanelCard(page)
      await closePanel(page, how)
      await expect(banner(page), `after ${how}`).toHaveCount(1)
      await expect(anyBanner(page)).toHaveCount(1)
      expect(await triples(banner(page)), `after ${how}`).toEqual(inTasks)
      await expect(reserve(page), `after ${how}`).toHaveCount(0)
    }
  })

  test('BP-C7: task panel toggles, panel opens and a trip to /notes never put two cards on the page', async ({ page }) => {
    await bpSetup(page, { probe: true })
    await expectTasksCard(page)
    for (let i = 0; i < 3; i++) { await hideTaskPanel(page); await showTaskPanel(page) }
    await expect(banner(page)).toHaveCount(1)
    for (let i = 0; i < 3; i++) { await openPanelCard(page); await closePanel(page, 'escape') }
    await goRail(page, 'notes')
    await goRail(page, 'home')
    await expect(banner(page)).toHaveCount(1, { timeout: 20_000 })
    // Exactly one: the probe saw the card, and never a second one.
    expect(await maxCards(page)).toBe(1)
  })

  test('BP-C8: on /notes no card on the page, the rail Settings dot and the bell dot lit; the bell opens on System with the same rows', async ({ page }) => {
    await bpSetup(page)
    await expectTasksCard(page)
    const inTasks = await triples(banner(page))
    await goRail(page, 'notes')
    await expect(page.locator('[data-testid="attention-banner"]:visible')).toHaveCount(0)
    await expect(settingsDot(page)).toHaveAttribute('data-kind', 'warn')
    await expect(bellDot(page)).toHaveCount(1)
    await openBell(page)
    await expect(railButton(page, 'System')).toHaveAttribute('aria-current', 'true')
    await expect(panelBanner(page)).toHaveCount(1)
    expect(await triples(panelBanner(page))).toEqual(inTasks)
    await page.screenshot({ path: `${BP_SHOTS}/c8-notes-panel.png` })
  })
})

test.describe('fallback mounts while the task panel is hidden', () => {
  test('BP-C13: the toolbar Hide task panel moves the card to the slot; the rail toggle brings it back', async ({ page }) => {
    await bpSetup(page)
    await expectTasksCard(page)
    await toolbarHide(page).click()
    await expect(slotBanner(page)).toHaveCount(1)
    await expect(slotBanner(page)).toHaveAttribute('data-mount', 'slot')
    await expect(anyBanner(page)).toHaveCount(1)
    await showTaskPanel(page)
    await expect(tasksBanner(page)).toHaveCount(1)
    await expect(slotBanner(page)).toHaveCount(0)
    await expect(anyBanner(page)).toHaveCount(1)
  })

  test('BP-C14: task panel and chat hidden with a draft open: the compact card in the draft column, no title, no local section', async ({ page }) => {
    await bpSetup(page, { local: 'sign-in', before: async (p) => { await p.addInitScript(() => localStorage.setItem('open-walnut-home-chat-visible', 'false')) } })
    const draft = await openDraft(page)
    await hideTaskPanel(page)
    const compact = draft.locator('[data-testid="attention-banner"][data-mount="draft"]')
    await expect(compact).toHaveCount(1, { timeout: 10_000 })
    await expect(compact).toHaveClass(/attention-banner-compact/)
    await expect(compact.locator('.setup-banner-title')).toHaveCount(0)
    await expect(compact.locator('[data-testid="setup-banner-sign-in"]')).toHaveCount(0)
    await expect(anyBanner(page)).toHaveCount(1)
    await draft.screenshot({ path: `${BP_SHOTS}/c14-draft-compact.png` })
  })
})

test.describe('empty, and the first frame after a move', () => {
  test('BP-C33: all healthy and this machine fine: no card, no reserve, the toolbar meets the next element; the panel and its System section have none either', async ({ page }) => {
    await bpSetup(page, { hosts: [connected('devbox', 'Dev box'), outdated('buildbox', 'Build box')] })
    await page.waitForTimeout(1500)
    await expect(anyBanner(page)).toHaveCount(0)
    await expect(reserve(page)).toHaveCount(0)
    const gap = await page.locator('.todo-panel-toolbar').evaluate((tb) => {
      const next = tb.nextElementSibling as HTMLElement | null
      if (!next) return 0
      return next.getBoundingClientRect().top - tb.getBoundingClientRect().bottom
    })
    expect(Math.abs(gap)).toBeLessThanOrEqual(1)
    await openBell(page)
    // Nothing to say: the bell lands on All, and System holds no card either.
    await expect(railButton(page, 'All')).toHaveAttribute('aria-current', 'true')
    await expect(page.locator('.notification-panel [data-testid="attention-banner"]')).toHaveCount(0)
    await pickRail(page, 'System')
    await expect(page.locator('.notification-panel [data-testid="attention-banner"]')).toHaveCount(0)
    await expect(systemBadge(page)).toHaveCount(0)
    await expect(reserve(page)).toHaveCount(0)
  })

  test('BP-C44: in the first frame after Hide task panel no card is left inside the task panel', async ({ page }) => {
    await bpSetup(page)
    await expectTasksCard(page)
    expect(await countInFirstFrameAfterClick(page, toolbarHide(page), '.todo-panel [data-testid="attention-banner"]')).toBe(0)
    await showTaskPanel(page)
    await expect(tasksBanner(page)).toHaveCount(1)
    // The rail toggle too.
    expect(await countInFirstFrameAfterClick(page, page.locator('.sidebar-home-panels .app-task-panel-toggle'), '.todo-panel [data-testid="attention-banner"]')).toBe(0)
  })

  test('BP-C56: the first frame after the bell keeps the task card; after System the panel card; after All and after Close the task card again', async ({ page }) => {
    await bpSetup(page, { probe: true })
    await expectTasksCard(page)
    const TASKS = '.todo-panel [data-testid="attention-banner"][data-mount="tasks"]'
    const PANEL = '.notification-panel [data-testid="attention-banner"]'
    expect(await countInFirstFrameAfterClick(page, page.locator('.sidebar-notification-btn'), TASKS)).toBe(1)
    await expect(railButton(page, 'All')).toHaveAttribute('aria-current', 'true')
    expect(await countInFirstFrameAfterClick(page, railButton(page, 'System'), PANEL)).toBe(1)
    expect(await countInFirstFrameAfterClick(page, railButton(page, 'All'), TASKS)).toBe(1)
    expect(await countInFirstFrameAfterClick(page, railButton(page, 'System'), PANEL)).toBe(1)
    expect(await countInFirstFrameAfterClick(page, page.locator('.notification-panel .notification-panel-close'), TASKS)).toBe(1)
    expect(await maxCards(page)).toBe(1)
  })

  test('BP-C56 WebKit: five fresh runs of the BP-C7 moves never hold two cards at once', async ({ browser, browserName }) => {
    test.skip(browserName !== 'webkit', 'WebKit only: the Mac app engine')
    test.setTimeout(300_000)
    for (let run = 0; run < 5; run++) {
      const ctx = await browser.newContext()
      const page = await ctx.newPage()
      try {
        await bpSetup(page, { probe: true })
        await expectTasksCard(page)
        for (let i = 0; i < 3; i++) { await hideTaskPanel(page); await showTaskPanel(page) }
        for (let i = 0; i < 3; i++) { await openPanelCard(page); await closePanel(page, 'escape') }
        await goRail(page, 'notes')
        await goRail(page, 'home')
        await expect(banner(page)).toHaveCount(1, { timeout: 20_000 })
        expect(await maxCards(page), `run ${run + 1}`).toBe(1)
      } finally {
        await ctx.close()
      }
    }
  })
})

test.describe('the System section owns the card, and only it', () => {
  test('BP-C69: Home with the task card: the bell opens on All with no card or mount in the panel; the task card stays, no reserve', async ({ page }) => {
    await bpSetup(page)
    await expectTasksCard(page)
    const before = (await banner(page).boundingBox())!
    await openBell(page)
    await expect(railButton(page, 'All')).toHaveAttribute('aria-current', 'true')
    // Not above the sections (the old place) and not anywhere else in the panel.
    await expect(page.locator('.notification-panel > .ab-mount')).toHaveCount(0)
    await expect(panelMount(page)).toHaveCount(0)
    await expect(panelBanner(page)).toHaveCount(0)
    await expect(tasksBanner(page)).toHaveCount(1)
    await expect(anyBanner(page)).toHaveCount(1)
    await expect(reserve(page)).toHaveCount(0)
    expect(await hostsOf(banner(page))).toEqual(FIXTURE_ORDER)
    const after = (await banner(page).boundingBox())!
    expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(1)
    expect(Math.abs(after.height - before.height)).toBeLessThanOrEqual(1)
    await page.screenshot({ path: `${BP_SHOTS}/c69-bell-lands-on-all.png` })
  })

  test('BP-C70: System, All, System, All: exactly one card at every step; the reserve comes with System and goes with All', async ({ page }) => {
    await bpSetup(page, { probe: true })
    await expectTasksCard(page)
    const cardH = (await banner(page).boundingBox())!.height
    await openBell(page)
    await expect(railButton(page, 'All')).toHaveAttribute('aria-current', 'true')
    for (const label of ['System', 'All', 'System', 'All', 'System'] as const) {
      await pickRail(page, label)
      await expect(anyBanner(page), label).toHaveCount(1)
      if (label === 'System') {
        await expect(panelBanner(page), label).toHaveCount(1)
        await expect(tasksBanner(page), label).toHaveCount(0)
        await expect(reserve(page), label).toHaveCount(1)
        expect(Math.abs((await reserve(page).boundingBox())!.height - cardH), label).toBeLessThanOrEqual(1)
        await expect.poll(() => hostsOf(panelBanner(page)), label).toEqual(FIXTURE_ORDER)
      } else {
        await expect(panelMount(page), label).toHaveCount(0)
        await expect(tasksBanner(page), label).toHaveCount(1)
        await expect(reserve(page), label).toHaveCount(0)
        await expect.poll(() => hostsOf(banner(page)), label).toEqual(FIXTURE_ORDER)
      }
    }
    await closePanel(page, 'escape')
    await expect(tasksBanner(page)).toHaveCount(1)
    await expect(reserve(page)).toHaveCount(0)
    // The probe watched every mutation: never a second card, not even for one frame.
    expect(await maxCards(page)).toBe(1)
  })

  test('BP-C71: on /notes the bell opens on System with the card; the System badge counts the problem hosts, a dismissed row included', async ({ page }) => {
    // bpSetup routes git sync healthy and this machine ready, so the badge counts hosts only.
    await bpSetup(page)
    await expectTasksCard(page)
    await goRail(page, 'notes')
    await openBell(page)
    await expect(railButton(page, 'System')).toHaveAttribute('aria-current', 'true')
    await expect(panelBanner(page)).toHaveCount(1)
    await expect(anyBanner(page)).toHaveCount(1)
    await expect.poll(() => hostsOf(panelBanner(page))).toEqual(FIXTURE_ORDER)
    // keybox, certbox, netbox, signbox; the healthy devbox and the merely outdated buildbox never count.
    await expect(systemBadge(page)).toHaveText(String(FIXTURE_ORDER.length))
    await page.locator('.notification-panel').screenshot({ path: `${BP_SHOTS}/c71-notes-system-badge.png` })
    // The badge follows what the System pane lists, so a card dismissal leaves it as is.
    await cardRow(panelBanner(page), 'netbox').getByRole('button', { name: 'Dismiss Net box' }).click()
    await expect(cardRow(panelBanner(page), 'netbox')).toHaveCount(0)
    await expect(systemBadge(page)).toHaveText(String(FIXTURE_ORDER.length))
  })
})
