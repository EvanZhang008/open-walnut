/**
 * The card's buttons and the System section's host rows (slice spec 5.1, 5.3,
 * 2.1): Open Settings in a System row leaves the panel first, Retry there keeps
 * it open, one attempt is shared by the Home card and System, the Needs Action
 * landing carries no card (the Errors badge counts the problem hosts, All
 * leads with them and System lists them), and the success sentence drops its
 * check mark in the card.
 * Host frames and local health are routed client-side; the Settings checks
 * (BP-C20, BP-C66) use the server's host fixture so Settings lists the hosts.
 *
 * Run: PW_TEST_PORT=35994 PW_IGNORE_LOAD=1 npx playwright test banner-placement-actions --project=chromium --workers=1
 *      PW_WEBKIT=1 PW_TEST_PORT=35994 PW_IGNORE_LOAD=1 npx playwright test banner-placement-actions --project=webkit --workers=1
 */
import fs from 'node:fs'
import path from 'node:path'
import { test, expect } from '@playwright/test'
import { hostReadySentence } from '../../../src/core/hosts/host-problem'
import {
  anyBanner, banner, connected, failed, isolatePrefs, resetServerHostFixture, routeHealth, row, signedOut, storedKeys,
} from './host-problems-helpers'
import { hostRow, loadApp, loadFixture, openBell, panelBanner } from './host-problems-fixture-helpers'
import {
  BP_SHOTS, askRecord, bpSetup, closePanel, errorsBadge, expectTasksCard, healthyGitSync, hostsOf, openProblems, openRow,
  openSystemHosts, panelMount, pickRail, problemHosts, problemRow, problemRowHosts, railButton, systemBadge, systemHostLine,
  systemHostRow, systemHosts, systemListHosts, systemRowHosts,
} from './banner-placement-helpers'

test.describe.configure({ timeout: 90_000 })

test.beforeAll(async ({ request }) => {
  fs.mkdirSync(BP_SHOTS, { recursive: true })
  await resetServerHostFixture(request)
})
test.afterAll(async ({ request }) => { await resetServerHostFixture(request) })

const five = () => [
  failed('keybox', 'Key box', 'auth'), failed('netbox', 'Net box', 'unreachable'), failed('proxybox', 'Proxy box', 'proxy'),
  failed('lanbox', 'Lan box', 'unreachable'), signedOut('signbox', 'Sign box'),
]

test.describe('the card in the task panel, the rows in System', () => {
  test('BP-C19: local sign-in plus hosts in the task panel: local section first, the Remote hosts subhead, the sign-in title', async ({ page }) => {
    await bpSetup(page, { local: 'sign-in' })
    await expectTasksCard(page)
    await expect(banner(page).locator('.setup-banner-title').first()).toHaveText('Sign in to Claude Code')
    await expect(banner(page).locator('.hpb-subhead')).toHaveText('Remote hosts')
    const localFirst = await banner(page).evaluate((el) => {
      const local = el.querySelector('[data-testid="setup-banner-sign-in"]')
      const hosts = el.querySelector('[data-testid="host-problems"]')
      return !!local && !!hosts && !!(local.compareDocumentPosition(hosts) & Node.DOCUMENT_POSITION_FOLLOWING)
    })
    expect(localFirst).toBe(true)
    await banner(page).screenshot({ path: `${BP_SHOTS}/c19-local-plus-hosts.png` })
  })

  test('BP-C20: Open Settings in a System row closes the panel and lands on the host row; no card on the page after', async ({ page, request }) => {
    await loadFixture(request, 'host-problems')
    await isolatePrefs(page)
    await healthyGitSync(page)
    await routeHealth(page)
    await loadApp(page)
    await expect(banner(page)).toHaveCount(1, { timeout: 20_000 })
    await openSystemHosts(page)
    await openRow(systemHostRow(page, 'keybox'))
    await systemHostRow(page, 'keybox').getByTestId('hpb-open-settings').click()
    await expect(page.locator('.notification-panel')).toHaveCount(0)
    await expect(page).toHaveURL(/\/settings#rh-host-keybox$/)
    await expect(hostRow(page, 'keybox')).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('[data-testid="attention-banner"]:visible')).toHaveCount(0)
  })

  test('BP-C21: five problems: the Home card caps at 3 rows and "and 2 more"; All\'s problems and System list all five once each, with no "more" link', async ({ page }) => {
    await bpSetup(page, { hosts: five() })
    await expect(banner(page)).toHaveCount(1, { timeout: 20_000 })
    await expect(banner(page).locator('li.hpb-row[data-host]')).toHaveCount(3)
    await expect(banner(page).locator('.hpb-more')).toHaveText('and 2 more')
    // All (the landing): no cap either, in the card's order (connect failures, then the sign-in).
    await openBell(page)
    await expect.poll(() => problemRowHosts(page), { timeout: 20_000 }).toEqual(['keybox', 'netbox', 'proxybox', 'lanbox', 'signbox'])
    await expect(problemHosts(page).locator('.hpb-more')).toHaveCount(0)
    await closePanel(page, 'escape')
    await openSystemHosts(page)
    // A status list has no cap: every host, in the order given, each once.
    await expect.poll(() => systemListHosts(page)).toEqual(['keybox', 'netbox', 'proxybox', 'lanbox', 'signbox'])
    expect(await systemRowHosts(page)).toEqual(['keybox', 'netbox', 'proxybox', 'lanbox', 'signbox'])
    await expect(systemHosts(page).locator('.hpb-more')).toHaveCount(0)
  })

  test('BP-C22: Retry in a System row keeps the panel open and holds the row height while it tries; the host then reads Connected there, and the Home card says it is ready', async ({ page }) => {
    const h = await bpSetup(page, { hosts: [failed('netbox', 'Net box', 'unreachable'), signedOut('signbox', 'Sign box')] })
    await expect(banner(page)).toHaveCount(1, { timeout: 20_000 })
    h.connectDelayMs = 1500
    h.connectAnswer = (host) => connected(host, 'Net box')
    await openSystemHosts(page)
    const target = systemHostRow(page, 'netbox')
    const before = (await target.boundingBox())!.height
    await target.getByTestId('hpb-retry').click()
    await expect(target).toContainText('Connecting to Net box...')
    expect(Math.abs((await target.boundingBox())!.height - before)).toBeLessThanOrEqual(1)
    await expect(page.locator('.notification-panel')).toBeVisible()
    // A healthy host is a plain line in the status list; the success sentence is the card's.
    await expect(systemHostLine(page, 'netbox').locator('.nfc-daemon-status')).toHaveText('Connected', { timeout: 10_000 })
    await expect(target).toHaveCount(0)
    await expect(row(page, 'netbox')).toContainText('Net box is ready')
    await expect(page.locator('.notification-panel')).toBeVisible()
  })

  test('BP-C23: Retry in the task panel card: the new attempt\'s failure, then Tried again just now: same result', async ({ page }) => {
    const h = await bpSetup(page, { hosts: [failed('netbox', 'Net box', 'unreachable'), signedOut('signbox', 'Sign box')] })
    await expect(row(page, 'netbox')).toBeVisible({ timeout: 20_000 })
    h.connectAnswer = (host) => failed(host, 'Net box', 'timeout')
    await row(page, 'netbox').getByTestId('hpb-retry').click()
    await expect(row(page, 'netbox').locator('.hft-headline')).toHaveText('Connecting to Net box timed out', { timeout: 10_000 })
    await row(page, 'netbox').getByTestId('hpb-retry').click()
    await expect(row(page, 'netbox').getByTestId('hpb-receipt')).toHaveText('Tried again just now: same result', { timeout: 10_000 })
    await expect(row(page, 'netbox').getByTestId('hpb-receipt')).toHaveCount(0, { timeout: 8_000 })
  })
})

test.describe('one attempt, one state, whichever mount shows it', () => {
  test('BP-C48: a Retry started in the task panel is the same pending attempt in the panel (All\'s problem row, where the bell lands); one connect request in all', async ({ page }) => {
    const h = await bpSetup(page, { hosts: [failed('netbox', 'Net box', 'unreachable'), failed('keybox', 'Key box', 'auth'), signedOut('signbox', 'Sign box')] })
    await expect(row(page, 'netbox')).toBeVisible({ timeout: 20_000 })
    h.connectDelayMs = 2000
    h.connectAnswer = (host) => failed(host, 'Net box', 'unreachable')
    await row(page, 'netbox').getByTestId('hpb-retry').click()
    await page.waitForTimeout(300)
    await openProblems(page)
    await expect(problemRow(page, 'netbox')).toContainText('Connecting to Net box...')
    await expect(problemRow(page, 'netbox').getByTestId('hpb-retry')).toBeDisabled()
    await closePanel(page, 'escape')
    await expect(row(page, 'netbox')).toContainText('Connecting to Net box...')
    await expect(row(page, 'netbox').getByTestId('hpb-receipt')).toHaveText('Tried again just now: same result', { timeout: 10_000 })
    expect(h.connects.get('netbox')).toBe(1)
    // Expanded and folded rows keep their state and order across a panel open; System
    // shares the card's flag by row id, so it shows the same rows open and folded.
    const r2 = row(page, 'keybox')
    await r2.getByRole('button', { name: 'Show details' }).click()
    const r1Hide = row(page, 'netbox').getByRole('button', { name: 'Hide details' })
    if (await r1Hide.count()) await r1Hide.click()
    const order = await hostsOf(banner(page))
    await openSystemHosts(page)
    await expect(systemHostRow(page, 'keybox')).toHaveClass(/hpb-open/)
    await expect(systemHostRow(page, 'netbox')).not.toHaveClass(/hpb-open/)
    await closePanel(page, 'escape')
    expect(await hostsOf(banner(page))).toEqual(order)
    await expect(r2.getByRole('button', { name: 'Hide details' })).toBeVisible()
    await expect(row(page, 'netbox').getByRole('button', { name: 'Show details' })).toBeVisible()
  })

  test('BP-C52: a double click on the last row x opens no menu and changes no task; the undo row stays and Undo was not hit', async ({ page }) => {
    await bpSetup(page, { hosts: [failed('netbox', 'Net box', 'unreachable'), signedOut('signbox', 'Sign box')], allTasks: true })
    await expect(row(page, 'signbox')).toBeVisible({ timeout: 20_000 })
    const tasksState = () => page.locator('.todo-panel .todo-panel-item').evaluateAll((els) =>
      els.map((e) => `${e.getAttribute('data-task-id')}|${e.className}`))
    const before = await tasksState()
    await row(page, 'signbox').getByRole('button', { name: 'Dismiss Sign box' }).dblclick()
    await page.waitForTimeout(300)
    await expect(page.locator('[role="menu"]:visible')).toHaveCount(0)
    await expect(page.locator('.view-dropdown-menu:visible, .tier-plus-menu:visible')).toHaveCount(0)
    await expect(banner(page).locator('li', { hasText: 'Hidden until it changes.' })).toHaveCount(1)
    expect(await storedKeys(page)).toContain('signbox|claude_not_logged_in|2.1.280')
    expect(await tasksState()).toEqual(before)
  })
})

test.describe('landing, the named cap, and the success sentence', () => {
  test('BP-C62: two asks and four host problems: the bell lands on Needs Action with no card and no problems there; the Errors badge counts the four hosts, System\'s nothing; System lists them as dense card rows', async ({ page }) => {
    await bpSetup(page, {
      hosts: [failed('keybox', 'Key box', 'auth'), failed('netbox', 'Net box', 'unreachable'), failed('certbox', 'Cert box', 'cert_expired'), signedOut('signbox', 'Sign box')],
      feed: [askRecord(1), askRecord(2)],
    })
    await expect(banner(page)).toHaveCount(1, { timeout: 20_000 })
    await openBell(page)
    await expect(railButton(page, 'Needs Action')).toHaveAttribute('aria-current', 'true')
    // Needs Action is the asks alone: no card and no mount; the task panel keeps its card.
    await expect(page.locator('.notification-panel .nfc-perm-card')).toHaveCount(2)
    await expect(panelMount(page)).toHaveCount(0)
    await expect(panelBanner(page)).toHaveCount(0)
    await expect(banner(page)).toHaveCount(1)
    await expect(anyBanner(page)).toHaveCount(1)
    const panelBox = (await page.locator('.notification-panel').boundingBox())!
    const askTop = (await page.locator('.notification-panel .nfc-perm-card').first().boundingBox())!.y
    expect(askTop - panelBox.y).toBeLessThanOrEqual(panelBox.height * 0.6)
    // Needs Action is the asks alone: the problems lead All and Errors, not this section.
    await expect(problemHosts(page)).toHaveCount(0)
    // The hosts are errors: the Errors rail counts the four (no feed errors, this machine ready);
    // System (git sync healthy) counts nothing.
    await expect(errorsBadge(page)).toHaveText('4')
    await expect(systemBadge(page)).toHaveCount(0)
    await page.locator('.notification-panel').screenshot({ path: `${BP_SHOTS}/c62-needs-action-landing.png` })
    await pickRail(page, 'System')
    const hosts = systemHosts(page)
    await expect(hosts).toBeVisible()
    await expect(panelBanner(page)).toHaveCount(0)
    await expect(banner(page)).toHaveCount(1)
    await expect(hosts.locator('li.hpb-row[data-host]')).toHaveCount(4)
    await expect(systemBadge(page)).toHaveCount(0)
    await expect(errorsBadge(page)).toHaveText('4')
    // Never the one-line form in System (dense: headline, then the primary action).
    for (const r of await hosts.locator('li.hpb-row[data-host]').all()) {
      await expect(r).toHaveClass(/hpb-dense/)
      await expect(r).not.toHaveClass(/hpb-single/)
    }
    await expect(systemHostRow(page, 'keybox').getByTestId('hpb-retry')).toBeVisible()
    await page.locator('.notification-panel').screenshot({ path: `${BP_SHOTS}/c62-system-rows.png` })
  })

  test('BP-C66: "and 2 more" flashes exactly the two capped rows in Settings, once; a reload does not flash again', async ({ page, request }) => {
    const file = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'tests/e2e/browser/fixtures/host-problems.json'), 'utf-8')) as { hosts: Record<string, unknown> }
    file.hosts.lanbox = { label: 'Lan box', hostname: 'lan.example.com', phase: 'failed', error: 'ssh: connect to host lan.example.com port 22: No route to host' }
    await loadFixture(request, file)
    await isolatePrefs(page)
    await healthyGitSync(page)
    await routeHealth(page)
    await page.addInitScript(() => {
      const w = window as unknown as { __bpFlashed: string[] }
      w.__bpFlashed = []
      new MutationObserver((muts) => {
        for (const m of muts) {
          const el = m.target as HTMLElement
          if (el.id?.startsWith('rh-host-') && el.classList.contains('rh-row-flash')) w.__bpFlashed.push(el.id.slice('rh-host-'.length))
        }
      }).observe(document, { subtree: true, attributes: true, attributeFilter: ['class'] })
    })
    await loadApp(page)
    await expect(banner(page).locator('.hpb-more')).toHaveText('and 2 more', { timeout: 20_000 })
    const shown = await hostsOf(banner(page))
    await banner(page).locator('.hpb-more').click()
    await expect(page).toHaveURL(/\/settings#remote-hosts$/)
    await expect(hostRow(page, 'lanbox')).toBeVisible({ timeout: 20_000 })
    await page.waitForTimeout(2500)
    const flashed = await page.evaluate(() => [...new Set((window as unknown as { __bpFlashed: string[] }).__bpFlashed)].sort())
    expect(flashed).toEqual(['lanbox', 'signbox'])
    for (const host of shown) expect(flashed).not.toContain(host)
    await page.reload()
    await expect(hostRow(page, 'lanbox')).toBeVisible({ timeout: 20_000 })
    await page.waitForTimeout(2500)
    expect(await page.evaluate(() => (window as unknown as { __bpFlashed: string[] }).__bpFlashed)).toEqual([])
    await resetServerHostFixture(request)
  })

  test('BP-C67: after a Retry that works, the card\'s success sentence has no check mark and starts with the ok dot', async ({ page }) => {
    const h = await bpSetup(page, { hosts: [failed('netbox', 'Net box', 'unreachable'), signedOut('signbox', 'Sign box')] })
    await expect(row(page, 'netbox')).toBeVisible({ timeout: 20_000 })
    h.connectAnswer = (host) => connected(host, 'Net box')
    await row(page, 'netbox').getByTestId('hpb-retry').click()
    const original = hostReadySentence('Net box', '2.1.281')
    await expect(row(page, 'netbox')).toContainText(original.replace(/^\u2713 /, ''), { timeout: 10_000 })
    const text = await row(page, 'netbox').evaluate((el) => el.textContent ?? '')
    expect(text).not.toContain('\u2713')
    expect(text.trim()).toBe(original.replace(/^\u2713 /, ''))
    const dotFirst = await row(page, 'netbox').evaluate((el) => {
      const slot = el.querySelector('.hpb-dot')
      const dot = slot?.querySelector('[data-kind]')
      const firstChild = el.firstElementChild
      // The ok dot is the host's live dot reading connected (checking while the re-check answers).
      return !!dot && ['connected', 'checking', 'ok'].includes(dot.getAttribute('data-kind') ?? '') && firstChild === slot
    })
    expect(dotFirst).toBe(true)
    // Elsewhere the shared sentence keeps its check mark (the source of truth is unchanged).
    expect(original.startsWith('\u2713 ')).toBe(true)
    await expect(anyBanner(page)).toHaveCount(1)
  })
})
