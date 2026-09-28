/**
 * Where the attention card mounts (slice spec 2 and 4.4): the task panel on
 * Home, the slot and the draft column only while the task panel is hidden,
 * never the notification panel (its System section lists each host once, a
 * problem host as its card row; the bell lands there only when no in-page
 * card covers the problem), and never two cards at once.
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
  anyBanner, banner, connected, hideTaskPanel, outdated, resetServerHostFixture, row, showTaskPanel,
} from './host-problems-helpers'
import { openBell, panelBanner, slotBanner, tasksBanner } from './host-problems-fixture-helpers'
import { openDraft } from './draft-helpers'
import {
  BP_SHOTS, FIXTURE_ORDER, bellDot, bpSetup, closePanel, countInFirstFrameAfterClick, expectHomeCardStill, expectTasksCard, goRail,
  hostsOf, markHomeCard, maxCards, openSystemHosts, panelMount, pickRail, railButton, settingsDot, systemBadge, systemHostLine,
  systemHostRow, systemHosts, systemListHosts, systemRowHosts, toolbarHide, triples, type CloseWay,
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

  test('BP-C3: a healthy host and a claude_outdated host take no row in the task panel; in System they are plain status lines', async ({ page }) => {
    await bpSetup(page)
    await expectTasksCard(page)
    for (const host of ['devbox', 'buildbox']) await expect(banner(page).locator(`li.hpb-row[data-host="${host}"]`)).toHaveCount(0)
    await openSystemHosts(page)
    // Settings order in System: the problem hosts are rows, the other two are lines.
    await expect.poll(() => systemRowHosts(page)).toEqual(['signbox', 'keybox', 'certbox', 'netbox'])
    for (const host of ['devbox', 'buildbox']) {
      await expect(systemHostRow(page, host), host).toHaveCount(0)
      await expect(systemHostLine(page, host), host).toBeVisible()
      await expect(systemHostLine(page, host).locator('button'), host).toHaveCount(0)
    }
  })

  test('BP-C4: the task panel rows are in the model order; System gives each of those hosts the same row (type and kind), in Settings order', async ({ page }) => {
    await bpSetup(page)
    await expectTasksCard(page)
    const inTasks = await triples(banner(page))
    expect(inTasks.map((t) => t.split('|')[0])).toEqual(FIXTURE_ORDER)
    expect(inTasks.slice(0, 3).every((t) => t.split('|')[1] === 'connect')).toBe(true)
    expect(inTasks[3]).toBe('signbox|readiness|claude_not_logged_in')
    const hosts = await openSystemHosts(page)
    const inSystem = await triples(hosts)
    expect(inSystem.map((t) => t.split('|')[0])).toEqual(['signbox', 'keybox', 'certbox', 'netbox'])
    expect([...inSystem].sort()).toEqual([...inTasks].sort())
  })
})

test.describe('the notification panel never takes the card', () => {
  test('BP-C5: the bell on Home, then System: no card or mount in the panel; System\'s first block is Remote hosts, each host once; the Home card stays, same node, same place', async ({ page }) => {
    await bpSetup(page)
    await expectTasksCard(page)
    const place = await markHomeCard(page)
    const hosts = await openSystemHosts(page)
    await expect(panelMount(page)).toHaveCount(0)
    await expect(panelBanner(page)).toHaveCount(0)
    const first = await hosts.evaluate((el) => {
      const detail = el.closest('.nfc-detail')!
      return detail.querySelector('.notification-card') === el
    })
    expect(first, 'Remote hosts is the first System block (this machine is fine)').toBe(true)
    const listed = await systemListHosts(page)
    expect(listed).toEqual(['devbox', 'buildbox', 'signbox', 'keybox', 'certbox', 'netbox'])
    expect(new Set(listed).size).toBe(listed.length)
    await expectHomeCardStill(page, place, 'System open')
    await page.screenshot({ path: `${BP_SHOTS}/c5-system-hosts.png` })
  })

  test('BP-C6: Escape, the backdrop, Close and the bell again each close the panel; the Home card never left: same node, same rows', async ({ page }) => {
    await bpSetup(page)
    await expectTasksCard(page)
    const inTasks = await triples(banner(page))
    const place = await markHomeCard(page)
    for (const how of ['escape', 'backdrop', 'close', 'bell'] as CloseWay[]) {
      await openSystemHosts(page)
      await closePanel(page, how)
      await expectHomeCardStill(page, place, `after ${how}`)
      expect(await triples(banner(page)), `after ${how}`).toEqual(inTasks)
    }
  })

  test('BP-C7: task panel toggles, panel opens and a trip to /notes never put two cards on the page', async ({ page }) => {
    await bpSetup(page, { probe: true })
    await expectTasksCard(page)
    for (let i = 0; i < 3; i++) { await hideTaskPanel(page); await showTaskPanel(page) }
    await expect(banner(page)).toHaveCount(1)
    for (let i = 0; i < 3; i++) { await openSystemHosts(page); await closePanel(page, 'escape') }
    await goRail(page, 'notes')
    await goRail(page, 'home')
    await expect(banner(page)).toHaveCount(1, { timeout: 20_000 })
    // Exactly one: the probe saw the card, and never a second one.
    expect(await maxCards(page)).toBe(1)
  })

  test('BP-C8: on /notes no card on the page, the rail Settings dot and the bell dot lit; the bell opens on System, where each problem host has the card\'s row', async ({ page }) => {
    await bpSetup(page)
    await expectTasksCard(page)
    const inTasks = await triples(banner(page))
    await goRail(page, 'notes')
    await expect(page.locator('[data-testid="attention-banner"]:visible')).toHaveCount(0)
    await expect(settingsDot(page)).toHaveAttribute('data-kind', 'warn')
    await expect(bellDot(page)).toHaveCount(1)
    await openBell(page)
    await expect(railButton(page, 'System')).toHaveAttribute('aria-current', 'true')
    await expect(panelBanner(page)).toHaveCount(0)
    await expect(systemHosts(page)).toBeVisible()
    expect([...await triples(systemHosts(page))].sort()).toEqual([...inTasks].sort())
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
  test('BP-C33: all healthy and this machine fine: no card, the toolbar meets the next element; the panel has none either, and System lists both hosts as plain lines', async ({ page }) => {
    await bpSetup(page, { hosts: [connected('devbox', 'Dev box'), outdated('buildbox', 'Build box')] })
    await page.waitForTimeout(1500)
    await expect(anyBanner(page)).toHaveCount(0)
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
    await expect(systemHostLine(page, 'devbox')).toBeVisible()
    await expect(systemHostLine(page, 'buildbox')).toBeVisible()
    await expect(systemHosts(page).locator('li.hpb-row')).toHaveCount(0)
    await expect(systemBadge(page)).toHaveCount(0)
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

  test('BP-C56: the first frame after the bell, System, All, System and Close: the task card every time, never a panel card', async ({ page }) => {
    await bpSetup(page, { probe: true })
    await expectTasksCard(page)
    const TASKS = '.todo-panel [data-testid="attention-banner"][data-mount="tasks"]'
    const PANEL = '.notification-panel [data-testid="attention-banner"]'
    expect(await countInFirstFrameAfterClick(page, page.locator('.sidebar-notification-btn'), TASKS)).toBe(1)
    await expect(railButton(page, 'All')).toHaveAttribute('aria-current', 'true')
    expect(await countInFirstFrameAfterClick(page, railButton(page, 'System'), TASKS)).toBe(1)
    await expect(panelBanner(page)).toHaveCount(0)
    expect(await countInFirstFrameAfterClick(page, railButton(page, 'All'), TASKS)).toBe(1)
    expect(await countInFirstFrameAfterClick(page, railButton(page, 'System'), PANEL)).toBe(0)
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
        for (let i = 0; i < 3; i++) { await openSystemHosts(page); await closePanel(page, 'escape') }
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

test.describe('the System section lists the hosts; the card stays on Home', () => {
  test('BP-C69: Home with the task card: the bell opens on All with no card or mount in the panel; the task card stays', async ({ page }) => {
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
    expect(await hostsOf(banner(page))).toEqual(FIXTURE_ORDER)
    const after = (await banner(page).boundingBox())!
    expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(1)
    expect(Math.abs(after.height - before.height)).toBeLessThanOrEqual(1)
    await page.screenshot({ path: `${BP_SHOTS}/c69-bell-lands-on-all.png` })
  })

  test('BP-C70: System, All, System, All: exactly one card at every step, always the Home card (same node, same place); System lists the problem hosts each time', async ({ page }) => {
    await bpSetup(page, { probe: true })
    await expectTasksCard(page)
    const place = await markHomeCard(page)
    await openBell(page)
    await expect(railButton(page, 'All')).toHaveAttribute('aria-current', 'true')
    for (const label of ['System', 'All', 'System', 'All', 'System'] as const) {
      await pickRail(page, label)
      await expect(panelMount(page), label).toHaveCount(0)
      await expectHomeCardStill(page, place, label)
      await expect.poll(() => hostsOf(banner(page)), label).toEqual(FIXTURE_ORDER)
      if (label === 'System') await expect.poll(() => systemRowHosts(page), label).toEqual(['signbox', 'keybox', 'certbox', 'netbox'])
    }
    await closePanel(page, 'escape')
    await expectHomeCardStill(page, place, 'after Escape')
    // The probe watched every mutation: never a second card, not even for one frame.
    expect(await maxCards(page)).toBe(1)
  })

  test('BP-C71: on /notes the bell opens on System with each problem host\'s row; the System badge counts the problem hosts, a Home card dismissal included', async ({ page }) => {
    // bpSetup routes git sync healthy and this machine ready, so the badge counts hosts only.
    await bpSetup(page)
    await expectTasksCard(page)
    await goRail(page, 'notes')
    await openBell(page)
    await expect(railButton(page, 'System')).toHaveAttribute('aria-current', 'true')
    await expect(panelBanner(page)).toHaveCount(0)
    await expect(anyBanner(page)).toHaveCount(0)
    await expect.poll(() => systemRowHosts(page)).toEqual(['signbox', 'keybox', 'certbox', 'netbox'])
    // keybox, certbox, netbox, signbox; the healthy devbox and the merely outdated buildbox never count.
    await expect(systemBadge(page)).toHaveText(String(FIXTURE_ORDER.length))
    await page.locator('.notification-panel').screenshot({ path: `${BP_SHOTS}/c71-notes-system-badge.png` })
    // The badge follows what the System pane lists, and the list ignores dismissals.
    await closePanel(page, 'escape')
    await goRail(page, 'home')
    await expect(banner(page)).toHaveCount(1, { timeout: 20_000 })
    await row(page, 'netbox').getByRole('button', { name: 'Dismiss Net box' }).click()
    await expect(row(page, 'netbox')).toHaveCount(0)
    await goRail(page, 'notes')
    await openBell(page)
    await pickRail(page, 'System')
    await expect(systemHostRow(page, 'netbox')).toBeVisible()
    await expect(systemBadge(page)).toHaveText(String(FIXTURE_ORDER.length))
  })
})
