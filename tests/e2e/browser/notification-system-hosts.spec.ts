/**
 * What is broken right now leads the notification panel, and System lists
 * every host once. All and the all-errors view open with the problems block:
 * this machine's Claude Code notice while it shows, then the Remote hosts
 * problem card with each host the Home card has a row for, as that row (dense:
 * the same headline, primary button and Show details, and no x), in the card's
 * order, with the feed errors the host caused right under it. The System
 * section's Remote hosts block names every configured host once: a problem
 * host as the same row, every other host a plain status line. The panel never
 * renders the attention card, on any section.
 * Host frames and local health are routed client-side (host-problems-helpers.ts);
 * NSH-a (server) and NSH-d use the server's host fixture, so the health and
 * Settings list the hosts from the server's own config.
 *
 * Run: PW_TEST_PORT=3495 PW_IGNORE_LOAD=1 npx playwright test notification-system-hosts --project=chromium --workers=1
 *      PW_WEBKIT=1 PW_TEST_PORT=3495 PW_IGNORE_LOAD=1 npx playwright test notification-system-hosts --project=webkit --workers=1
 */
import fs from 'node:fs'
import { test, expect, type Locator } from '@playwright/test'
import { HINTS, anyBanner, banner, connected, failed, isolatePrefs, resetServerHostFixture, routeHealth, row } from './host-problems-helpers'
import { hostRow, loadApp, loadFixture, openBell, panelBanner } from './host-problems-fixture-helpers'
import {
  FIXTURE_ORDER, bpSetup, closePanel, errorsBadge, expectTasksCard, goRail, healthyGitSync, hostErrorRecord, maxCards, openProblems,
  openRow, openSystemHosts, panelLocalCard, panelMount, pickRail, problemCards, problemHosts, problemRow, problemRowHosts, railButton,
  systemBadge, systemHostLine, systemHostRow, systemHosts, systemListHosts, systemRowHosts,
} from './banner-placement-helpers'

const SHOTS = '/tmp/walnut-nfc-system/shots'
const SECTIONS = ['Needs Action', 'Inbox', 'Errors', 'Automation', 'System', 'All']
/** The Settings order of fixtureHosts(), which is the System list's order. */
const LISTED = ['devbox', 'buildbox', 'signbox', 'keybox', 'certbox', 'netbox']
const PROBLEM_ROWS = ['signbox', 'keybox', 'certbox', 'netbox']

test.describe.configure({ timeout: 90_000 })
test.beforeAll(async ({ request }) => {
  fs.mkdirSync(SHOTS, { recursive: true })
  await resetServerHostFixture(request)
})
test.afterAll(async ({ request }) => { await resetServerHostFixture(request) })
// A health or feed fetch still in flight when the page closes must not fail the test.
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: 'ignoreErrors' }) })

/** What a person reads on a row: its headline, its buttons, its toggles, and its form. */
const words = (r: Locator) => r.evaluate((el) => ({
  headline: (el.querySelector('.hft-headline, .hpb-headline')?.textContent ?? '').trim(),
  buttons: Array.from(el.querySelectorAll('.hpb-actions button')).map((b) => (b.textContent ?? '').trim()),
  details: Array.from(el.querySelectorAll('.hft-details')).map((b) => (b.textContent ?? '').trim()),
  dense: el.classList.contains('hpb-dense'),
  open: el.classList.contains('hpb-open'),
}))

test.describe('each host once, no card in the panel (a)', () => {
  test('NSH-a: System lists each host exactly once, and no section of the panel renders an attention card', async ({ page }) => {
    await bpSetup(page, { probe: true })
    await expectTasksCard(page)
    await openBell(page)
    for (const label of SECTIONS) {
      await pickRail(page, label)
      await expect(page.locator('.notification-panel [data-testid="attention-banner"]'), label).toHaveCount(0)
      await expect(panelMount(page), label).toHaveCount(0)
    }
    await pickRail(page, 'System')
    await expect.poll(() => systemListHosts(page)).toEqual(LISTED)
    // One entry per host in the whole panel: no second list, no card rows.
    for (const host of LISTED) await expect(page.locator(`.notification-panel li[data-host="${host}"]`), host).toHaveCount(1)
    expect(await systemRowHosts(page)).toEqual(PROBLEM_ROWS)
    // The page only ever held the Home card.
    expect(await maxCards(page)).toBe(1)
  })

  test('NSH-a (server fixture): the Remote hosts block names each configured host exactly once; still no card on any section', async ({ page, request }) => {
    await isolatePrefs(page)
    await healthyGitSync(page)
    await routeHealth(page)
    await loadFixture(request, 'host-problems')
    await loadApp(page)
    await expect(banner(page)).toHaveCount(1, { timeout: 20_000 })
    await openSystemHosts(page)
    await expect.poll(() => systemRowHosts(page), { timeout: 20_000 }).toEqual(PROBLEM_ROWS)
    const listed = await systemListHosts(page)
    for (const host of LISTED) expect(listed.filter((h) => h === host), host).toHaveLength(1)
    expect(new Set(listed).size).toBe(listed.length)
    for (const label of SECTIONS) {
      await pickRail(page, label)
      await expect(panelBanner(page), label).toHaveCount(0)
    }
  })
})

test.describe('a System row is the Home card row (b)', () => {
  test('NSH-b: a problem row in System has the Home card row\'s headline, primary button and Show details; Show details there reveals the hint and Open Settings; a healthy line has no toggle', async ({ page, browserName }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await bpSetup(page)
    await expectTasksCard(page)
    const home: Record<string, Awaited<ReturnType<typeof words>>> = {}
    for (const host of FIXTURE_ORDER) home[host] = await words(row(page, host))
    await openSystemHosts(page)
    for (const host of FIXTURE_ORDER) {
      const mine = await words(systemHostRow(page, host))
      expect(mine, host).toEqual(home[host])
      // Dense and folded, as on the card: the headline, ONE primary button, then Show details.
      expect(mine, host).toMatchObject({ dense: true, open: false, details: ['Show details'] })
      expect(mine.buttons, host).toHaveLength(1)
    }
    await page.mouse.move(2, 2)
    await page.locator('.notification-panel').screenshot({ path: `${SHOTS}/system-collapsed-${browserName}.png` })
    // Show details in System: the hint and Open Settings. One flag per row id, so the card's row opens too.
    const key = systemHostRow(page, 'keybox')
    await key.getByRole('button', { name: 'Show details' }).click()
    await expect(key).toHaveClass(/hpb-open/)
    await expect(key.locator('.hft-hint')).toHaveText(HINTS.auth)
    await expect(key.getByTestId('hpb-open-settings')).toBeVisible()
    await expect(row(page, 'keybox')).toHaveClass(/hpb-open/)
    expect(await words(key)).toEqual(await words(row(page, 'keybox')))
    await page.mouse.move(2, 2)
    await page.locator('.notification-panel').screenshot({ path: `${SHOTS}/system-row-expanded-${browserName}.png` })
    // A readiness row opens onto the rest of its message and Open Settings.
    const sign = systemHostRow(page, 'signbox')
    await sign.getByRole('button', { name: 'Show details' }).click()
    await expect(sign.locator('.hpb-rest')).toBeVisible()
    await expect(sign.getByTestId('hpb-open-settings')).toBeVisible()
    await expect(sign.getByRole('button', { name: 'Hide details' })).toBeVisible()
    // Healthy and merely outdated hosts: a plain line, no button, no toggle.
    for (const host of ['devbox', 'buildbox']) {
      await expect(systemHostLine(page, host), host).toBeVisible()
      await expect(systemHostLine(page, host).locator('button, .hft-details'), host).toHaveCount(0)
    }
  })

  test('NSH-g: neither All\'s problem rows nor System have an x or Dismiss all, folded or open; only the Claude Code card in All keeps its own x, and System holds no Claude Code card', async ({ page }) => {
    await bpSetup(page, { local: 'sign-in' })
    await expectTasksCard(page)
    const detail = page.locator('.notification-panel .nfc-detail')
    const noDismiss = async (list: Locator, when: string) => {
      await expect(page.locator('.notification-panel').getByRole('button', { name: 'Dismiss all' }), when).toHaveCount(0)
      await expect(page.locator('.notification-panel').locator('.hpb-x, .ab-dismiss-all'), when).toHaveCount(0)
      await expect(list.getByRole('button', { name: /^Dismiss / }), when).toHaveCount(0)
    }
    // All (the landing): the problem rows, folded, then open.
    await openProblems(page)
    await noDismiss(problemHosts(page), 'All, folded')
    for (const host of FIXTURE_ORDER) await openRow(problemRow(page, host))
    await noDismiss(problemHosts(page), 'All, open')
    await expect(detail.getByRole('button', { name: /^Dismiss / })).toHaveCount(1)
    await expect(panelLocalCard(page).getByRole('button', { name: 'Dismiss Claude Code notice' })).toBeVisible()
    // System: the same rows (open, one flag per row id), no x, and no Claude Code card at all.
    await pickRail(page, 'System')
    for (const host of PROBLEM_ROWS) await expect(systemHostRow(page, host), host).toHaveClass(/hpb-open/)
    await noDismiss(systemHosts(page), 'System, open')
    await expect(panelLocalCard(page)).toHaveCount(0)
    await expect(detail.getByRole('button', { name: /^Dismiss / })).toHaveCount(0)
  })
})

test.describe('one attempt, Open Settings, cards under their host (c, d, e)', () => {
  test('NSH-c: Retry in a System row starts the attempt; the Home card shows the same attempt; one connect request answers both; a Home card Retry is the same attempt in All\'s problem row', async ({ page }) => {
    const h = await bpSetup(page, { hosts: [failed('netbox', 'Net box', 'unreachable'), failed('keybox', 'Key box', 'auth')] })
    await expectTasksCard(page, ['netbox', 'keybox'])
    h.connectDelayMs = 2000
    h.connectAnswer = (host) => failed(host, 'Net box', 'unreachable')
    await openSystemHosts(page)
    const sys = systemHostRow(page, 'netbox')
    await sys.getByTestId('hpb-retry').click()
    await expect(sys).toContainText('Connecting to Net box...')
    await expect(sys.getByTestId('hpb-retry')).toBeDisabled()
    // The Home card behind the panel reads the same attempt, before the server answers.
    await expect(row(page, 'netbox')).toContainText('Connecting to Net box...')
    await expect(row(page, 'netbox').getByTestId('hpb-retry')).toBeDisabled()
    await expect(sys.getByTestId('hpb-receipt')).toHaveText('Tried again just now: same result', { timeout: 10_000 })
    await expect(row(page, 'netbox').getByTestId('hpb-receipt')).toHaveText('Tried again just now: same result')
    expect(h.connects.get('netbox')).toBe(1)
    // The same the other way: a Retry on the Home card is the attempt of All's problem row
    // (where the bell lands) and of the System row.
    await closePanel(page, 'escape')
    await expect(row(page, 'netbox').getByTestId('hpb-receipt')).toHaveCount(0, { timeout: 10_000 })
    await row(page, 'netbox').getByTestId('hpb-retry').click()
    await openProblems(page)
    await expect(problemRow(page, 'netbox')).toContainText('Connecting to Net box...')
    await expect(problemRow(page, 'netbox').getByTestId('hpb-retry')).toBeDisabled()
    await expect(problemRow(page, 'netbox').getByTestId('hpb-receipt')).toHaveText('Tried again just now: same result', { timeout: 10_000 })
    await pickRail(page, 'System')
    await expect(systemHostRow(page, 'netbox').getByTestId('hpb-receipt')).toHaveText('Tried again just now: same result')
    expect(h.connects.get('netbox')).toBe(2)
  })

  test('NSH-d: Open Settings in All\'s problem row (a readiness problem) closes the panel, then lands on #rh-host-signbox', async ({ page, request }) => {
    await isolatePrefs(page)
    await healthyGitSync(page)
    await routeHealth(page)
    await loadFixture(request, 'host-problems')
    await loadApp(page)
    await expect(banner(page)).toHaveCount(1, { timeout: 20_000 })
    // The server's configured hosts: the four banner problems, in the card's order (the disabled host never).
    await openProblems(page)
    await expect.poll(() => problemRowHosts(page), { timeout: 20_000 }).toEqual(FIXTURE_ORDER)
    await openRow(problemRow(page, 'signbox'))
    await problemRow(page, 'signbox').getByTestId('hpb-open-settings').click()
    await expect(page.locator('.notification-panel')).toHaveCount(0)
    await expect(page).toHaveURL(/\/settings#rh-host-signbox$/)
    await expect(hostRow(page, 'signbox')).toBeVisible({ timeout: 20_000 })
    await expect(hostRow(page, 'signbox')).toBeInViewport()
  })

  test('NSH-e: in Errors a problem host\'s cards sit under its row, with no cause block of their own; once the host recovers its row leaves and the cards come back as a labelled cause block', async ({ page, browserName }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    const h = await bpSetup(page, {
      hosts: [connected('devbox', 'Dev box'), failed('certbox', 'Cert box', 'cert_expired'), failed('netbox', 'Net box', 'unreachable')],
      feed: [hostErrorRecord('certbox', 1), hostErrorRecord('certbox', 2), hostErrorRecord('certbox', 3)],
    })
    await expectTasksCard(page, ['certbox', 'netbox'])
    await openBell(page)
    // Three error cards and two problem hosts: the Errors badge counts each once.
    await expect(errorsBadge(page)).toHaveText('5')
    await expect(systemBadge(page)).toHaveCount(0)
    const panel = page.locator('.notification-panel')
    const cause = panel.locator('.nfc-cat-title[data-cause-key="host:certbox"]')
    const cards = problemCards(page, 'certbox')
    const expectUnderRow = async (where: string) => {
      await expect.poll(() => problemRowHosts(page), where).toEqual(['certbox', 'netbox'])
      await expect(cards, where).toBeVisible()
      // Right after Cert box's row, in the same list: one collapsed group, the newest card first.
      expect(await problemRow(page, 'certbox').evaluate((el) => el.nextElementSibling?.getAttribute('data-host-cards')), where).toBe('certbox')
      await expect(cards.locator('.notification-feed-group'), where).toHaveCount(1)
      await expect(cards.locator('.notification-feed-item'), where).toHaveCount(1)
      await expect(cards.locator('.notification-group-toggle'), where).toHaveText('Show 2 more')
      await expect(cards.locator('.nfc-chip-category'), where).toHaveText('Sessions')
      // No block names the same host again, and nothing points at System.
      await expect(cause, where).toHaveCount(0)
      await expect(panel.locator('.nfc-cat-shown, .nfc-cat-shown-link'), where).toHaveCount(0)
      await expect(panel.getByText('Shown in System'), where).toHaveCount(0)
      // Every card is in the panel once: none outside the host's group.
      await expect(panel.locator('.notification-feed-item'), where).toHaveCount(1)
      // A problem host without feed errors has no group under it.
      await expect(problemCards(page, 'netbox'), where).toHaveCount(0)
    }
    await expectUnderRow('All')
    await pickRail(page, 'Errors')
    await expectUnderRow('Errors')
    // Placed under the row: below its bottom edge and indented from its left edge.
    const rb = (await problemRow(page, 'certbox').boundingBox())!
    const cb = (await cards.boundingBox())!
    expect(cb.y).toBeGreaterThanOrEqual(rb.y + rb.height - 1)
    expect(cb.x).toBeGreaterThan(rb.x)
    await cards.getByRole('button', { name: 'Show 2 more' }).click()
    await expect(cards.locator('.notification-feed-item')).toHaveCount(3)
    await page.mouse.move(2, 2)
    await panel.screenshot({ path: `${SHOTS}/errors-cards-under-row-${browserName}.png` })
    // Recovered: its row leaves the problems, its cards return as a cause block named by its label.
    await h.push(connected('certbox', 'Cert box'))
    await expect(problemRow(page, 'certbox')).toHaveCount(0, { timeout: 10_000 })
    await expect(cards).toHaveCount(0)
    await expect(cause.locator('.nfc-cat-name')).toHaveText("Can't reach Cert box")
    const block = panel.locator('.nfc-cat-block', { has: page.locator('.nfc-cat-title[data-cause-key="host:certbox"]') })
    await expect(block.locator('.notification-feed-item').first()).toBeVisible()
    await expect(panel.locator('.nfc-cat-shown, .nfc-cat-shown-link')).toHaveCount(0)
    await expect.poll(() => problemRowHosts(page)).toEqual(['netbox'])
    await expect(errorsBadge(page)).toHaveText('4')
    await page.mouse.move(2, 2)
    await panel.screenshot({ path: `${SHOTS}/errors-recovered-cause-block-${browserName}.png` })
  })
})

test.describe('this machine\'s Claude Code leads the problems (f)', () => {
  test('NSH-f: the Claude Code card leads All and Errors only while the local notice shows, and counts once on the Errors badge; System never holds it', async ({ page, browserName }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    const h = await bpSetup(page, { hosts: [connected('devbox', 'Dev box'), failed('netbox', 'Net box', 'unreachable')], local: 'sign-in' })
    await expect(banner(page).locator('[data-testid="setup-banner-sign-in"]')).toBeVisible({ timeout: 20_000 })
    await openProblems(page)
    const local = panelLocalCard(page)
    const first = () => local.evaluate((el) => el.closest('.nfc-detail')?.querySelector('.notification-card') === el)
    await expect(local).toBeVisible()
    await expect(local).toHaveClass(/\bnotification-card\b/)
    await expect(local.locator('.notification-card-label')).toHaveText('Claude Code')
    await expect(local).toHaveAttribute('data-kind', 'sign-in')
    await expect(local).toContainText('not signed in')
    expect(await first(), 'the first block of All').toBe(true)
    // Then the host problems, in the same block.
    expect(await local.evaluate((el) => el.nextElementSibling?.getAttribute('data-testid'))).toBe('nfc-problem-hosts')
    // Net box and this machine: two.
    await expect(errorsBadge(page)).toHaveText('2')
    await expect(systemBadge(page)).toHaveCount(0)
    await page.mouse.move(2, 2)
    await page.locator('.notification-panel').screenshot({ path: `${SHOTS}/all-local-card-${browserName}.png` })
    // The all-errors view leads with it too.
    await pickRail(page, 'Errors')
    await expect(local).toBeVisible()
    expect(await first(), 'the first block of Errors').toBe(true)
    // System: the hosts only.
    await pickRail(page, 'System')
    await expect(systemHostRow(page, 'netbox')).toBeVisible()
    await expect(local).toHaveCount(0)
    await expect(railButton(page, 'System').locator('.nfc-rail-dot')).toHaveCount(0)
    await pickRail(page, 'All')
    // Signed in from a terminal: the card leaves with the notice; the host stays.
    await h.health!.set('ready')
    await expect(local).toHaveCount(0, { timeout: 10_000 })
    await expect(problemRow(page, 'netbox')).toBeVisible()
    await expect(errorsBadge(page)).toHaveText('1')
    // Signed out again: back at the top.
    await h.health!.set('sign-in')
    await expect(local).toBeVisible({ timeout: 10_000 })
    expect(await first()).toBe(true)
    await expect(errorsBadge(page)).toHaveText('2')
    // Too old for one model is never a notice: no card, no count.
    await h.health!.set('outdated')
    await expect(local).toHaveCount(0, { timeout: 10_000 })
    await expect(errorsBadge(page)).toHaveText('1')
  })
})

test.describe('the first view with no card on the page (h)', () => {
  test('NSH-h: on /notes the bell lands on All, whose Remote hosts problem card lists the problem hosts in the Home card\'s order and words; the Errors badge counts them, System\'s does not', async ({ page, browserName }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await bpSetup(page)
    await expectTasksCard(page)
    const home: Record<string, Awaited<ReturnType<typeof words>>> = {}
    for (const host of FIXTURE_ORDER) home[host] = await words(row(page, host))
    await goRail(page, 'notes')
    await expect(anyBanner(page)).toHaveCount(0)
    const hosts = await openProblems(page)
    // The problems lead the section, whole on the first screen: no click to see them.
    expect(await hosts.evaluate((el) => el.closest('.nfc-detail')?.querySelector('.notification-card') === el), 'the first block of All').toBe(true)
    await expect(hosts.locator(':scope > .notification-card-row .notification-card-label')).toHaveText('Remote hosts')
    await expect.poll(() => problemRowHosts(page)).toEqual(FIXTURE_ORDER)
    for (const host of FIXTURE_ORDER) {
      const mine = await words(problemRow(page, host))
      expect(mine, host).toEqual(home[host])
      expect(mine, host).toMatchObject({ dense: true, open: false, details: ['Show details'] })
      await expect(problemRow(page, host), host).toBeInViewport({ ratio: 1 })
    }
    // Only the problems: the healthy host and the merely outdated one are not in the block.
    for (const host of ['devbox', 'buildbox']) await expect(hosts.locator(`li[data-host="${host}"]`), host).toHaveCount(0)
    await expect(errorsBadge(page)).toHaveText(String(FIXTURE_ORDER.length))
    await expect(systemBadge(page)).toHaveCount(0)
    await expect(railButton(page, 'System').locator('.nfc-rail-dot')).toHaveCount(0)
    await page.mouse.move(2, 2)
    await page.locator('.notification-panel').screenshot({ path: `${SHOTS}/notes-bell-all-problems-${browserName}.png` })
  })
})
