/**
 * Host problems in the folder picker (spec section 4) and the Settings host row
 * head (5.1), driven by the SERVER's host fixture (src/core/hosts/host-fixture.ts
 * through POST /api/test/host-fixture): the frames are the real buildHostStatus,
 * a fixture host lists folders through the MockDaemon (its tree comes from the
 * fixture file, `/srv/data` answers EACCES), and no ssh is ever dialed.
 *
 *   C20  a host removed in Settings loses its tab live; its history moves to Removed hosts
 *   C26  a folder the host cannot list: listing headline, Show details, Retry re-lists only
 *   C30  a bare word with 40 history hits: up to 8 rows (as many as fit, at 900 and 720 tall) + Show N more, HOME FOLDERS in view
 *   C31  Show N more expands in place: highlight on the first row it hid, no jump to the top
 *   C55  Check again on the readiness note: Checking..., then the ready line
 *   C73  All tab: a problem host's history rows wear its dot, a healthy host's none
 *   C88  opening the picker never prewarms a host that failed for good (auth, certificate)
 *   C39 / C84  twelve hosts: tabs cap at 10em, long names ellipsize, one title per tab
 *   C32  Settings at 1280px: the alias never truncates, the hostname does (title = full)
 *   C42  an alias-only Settings row follows the store's frames for its dot
 *
 * In file order with --workers=1, next to the other host-problems specs (they
 * share the server fixture). page.goto only loads the app; everything after is a real click.
 *
 * Run: PW_TEST_PORT=35995 npx playwright test host-problems-picker --project=chromium --workers=1
 *      PW_WEBKIT=1 PW_TEST_PORT=35995 npx playwright test host-problems-picker --project=webkit --workers=1
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import { draftCwdPill, openDraft } from './draft-helpers'
import { Hosts, connected, failed, hostFixture, resetServerHostFixture } from './host-problems-helpers'

// In order, one worker; a failure does not skip the rest (each group sets its own fixture).
test.describe.configure({ mode: 'default' })

const SHOTS = '/tmp/walnut-host-problems-slice/picker'
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const fixtureFile = (name: string): { hosts: Record<string, { label: string } & Record<string, unknown>> } & Record<string, unknown> =>
  JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'))

const picker = (page: Page): Locator => page.locator('.session-path-selector')
const hostTab = (page: Page, host: string): Locator => picker(page).locator(`.sps-host-tab[data-host="${host}"]`)
const input = (page: Page): Locator => picker(page).locator('.sps-search-input')
const list = (page: Page): Locator => picker(page).locator('.sps-path-list')
const note = (page: Page, host: string): Locator => list(page).locator(`.sps-host-note[data-host="${host}"]`)

interface Counters { connect: Record<string, number>; check: Record<string, number>; listDirs: Record<string, number> }
async function counters(request: APIRequestContext): Promise<Counters> {
  const res = await request.get('/api/test/host-fixture/counters')
  expect(res.ok()).toBe(true)
  return await res.json() as Counters
}

async function loadHome(page: Page): Promise<void> {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 30_000 })
}

/** Open a draft and its folder picker; the host tabs have landed when this returns. */
async function openPicker(page: Page, waitHost = 'devbox'): Promise<Locator> {
  const panel = await openDraft(page)
  await draftCwdPill(panel).click()
  await expect(picker(page)).toBeVisible({ timeout: 10_000 })
  await expect(hostTab(page, waitHost)).toBeAttached({ timeout: 20_000 })
  return panel
}

/** A session-history row the working-dirs answer gains (the server's own rows stay). */
const hist = (cwd: string, host: string | null, hostLabel: string | undefined, count: number) => ({
  cwd, host, ...(hostLabel ? { hostLabel } : {}), project: '', count,
  lastUsed: new Date(Date.now() - 3_600_000).toISOString(),
})
/**
 * The history is exactly these rows. The fixture server is shared by every spec
 * in a run, and the draft specs start real sessions on the fixture hosts: their
 * folders (`~/work/api` on Build box) would otherwise join these rows and move
 * every count.
 */
async function addHistory(page: Page, rows: ReturnType<typeof hist>[]): Promise<void> {
  await page.route('**/api/sessions/working-dirs', async (route) => {
    const res = await route.fetch()
    const body = await res.json() as { dirs: unknown[] }
    body.dirs = [...rows]
    await route.fulfill({ response: res, json: body })
  })
}

test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: 'ignoreErrors' }) })

test.describe('the picker against the default host fixture', () => {
  test.beforeEach(async ({ request }) => {
    await resetServerHostFixture(request)
    await hostFixture(request, { action: 'load', fixture: 'host-problems' })
  })
  test.afterAll(async ({ request }) => { await resetServerHostFixture(request) })

  test('C20: removing Net box drops its tab without a reload; its history moves under Removed hosts', async ({ page, request }) => {
    await addHistory(page, [hist('/home/alice/work/net-tools', 'netbox', 'Net box', 9)])
    await loadHome(page)
    await openPicker(page)
    await expect(hostTab(page, 'netbox')).toBeVisible()
    const netRow = list(page).locator('.sps-path-item', { hasText: 'net-tools' })
    await expect(netRow).toBeVisible()

    await hostFixture(request, { action: 'remove-host', host: 'netbox' })
    await expect(hostTab(page, 'netbox')).toHaveCount(0, { timeout: 2_000 })
    // The row left All (a removed host cannot start) and lives under Removed hosts.
    await expect(netRow).toHaveCount(0)
    const removed = hostTab(page, '__removed__')
    await expect(removed).toHaveText('Removed hosts')
    await removed.click()
    await expect(list(page).locator('.sps-host-note-removed')).toHaveText('This host is no longer in Settings.')
    await expect(netRow).toBeVisible()
    await picker(page).screenshot({ path: `${SHOTS}/c20-removed-hosts-${test.info().project.name}.png` })
  })

  test('C26: a folder Dev box cannot list says so, Show details folds the cause, Retry lists again without a connect', async ({ page, request }) => {
    const devboxLists: string[] = []
    const connects: string[] = []
    page.on('request', (r) => {
      const u = new URL(r.url())
      if (u.pathname === '/api/sessions/list-dirs' && u.searchParams.get('host') === 'devbox') devboxLists.push(u.searchParams.get('prefix') ?? '')
      if (/^\/api\/hosts\/[^/]+\/connect$/.test(u.pathname)) connects.push(u.pathname)
    })
    await loadHome(page)
    await openPicker(page)
    await hostTab(page, 'devbox').click()
    await input(page).fill('/srv/data/')

    const n = note(page, 'devbox')
    await expect(n).toHaveAttribute('data-type', 'listing', { timeout: 15_000 })
    await expect(n.locator('.hft-headline')).toHaveText('Could not list /srv/data on Dev box')
    await expect(n.locator('.hft-details')).toHaveText('Show details')
    await expect(n.locator('.hft-details')).toHaveAttribute('aria-expanded', 'false')
    await n.locator('.hft-details').click()
    await expect(n.locator('.hft-details')).toHaveAttribute('aria-expanded', 'true')
    await expect(n.locator('pre.hft-summary')).toContainText('EACCES')
    expect(await picker(page).innerText()).not.toContain('Could not connect to Dev box')

    const before = await counters(request)
    const mark = devboxLists.length
    // Hold the re-list: the note stays where it is and says it is retrying.
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => { release = resolve })
    await page.route('**/api/sessions/list-dirs**', async (route) => {
      if (new URL(route.request().url()).searchParams.get('host') === 'devbox') await held
      await route.fallback()
    })
    await n.getByRole('button', { name: 'Retry' }).click()
    await expect.poll(() => devboxLists.length).toBeGreaterThan(mark)
    await expect(n.getByRole('button', { name: 'Retrying...' })).toBeDisabled()
    await expect(n.locator('.hft-headline')).toHaveText('Could not list /srv/data on Dev box')
    release()
    await expect(n.getByRole('button', { name: 'Retry', exact: true })).toBeEnabled()
    for (const p of devboxLists.slice(mark)) expect(p).toBe('/srv/data/')
    await expect(n.locator('.hft-headline')).toHaveText('Could not list /srv/data on Dev box')
    await page.waitForTimeout(500)
    expect(connects).toEqual([])
    expect((await counters(request)).connect.devbox ?? 0).toBe(before.connect.devbox ?? 0)
    await n.screenshot({ path: `${SHOTS}/c26-listing-${test.info().project.name}.png` })
  })

  // The cap is min(8, rows that fit above the HOME FOLDERS header), floor 3: at
  // 1280x900 the list (about 430px) holds all 8; at 1280x720 (about 250px) 8 rows
  // + the more row + the header do not fit, so fewer rows show and the header stays in view.
  for (const { height, expectRows } of [{ height: 900, expectRows: 8 }, { height: 720, expectRows: null }] as const) {
    test(`C30 / C31 at 1280x${height}: 40 history hits cap at ${expectRows ?? 'the rows that fit'} + Show N more, HOME FOLDERS in view without scrolling, the expand keeps its place`, async ({ page }) => {
      const rows = Array.from({ length: 40 }, (_, i) =>
        hist(`/home/alice/src/worker-${String(i + 1).padStart(2, '0')}`, 'devbox', 'Dev box', 200 - i))
      await addHistory(page, rows)
      await page.setViewportSize({ width: 1280, height })
      await loadHome(page)
      await openPicker(page)
      await hostTab(page, 'devbox').click()
      await input(page).fill('work')

      const history = list(page).locator('[data-section-id="history"]')
      const more = history.locator('.sps-more-row')
      const home = list(page).locator('[data-section-id="home:devbox"]')
      const shownRows = history.locator('.sps-path-item:not(.sps-more-row)')
      await expect(home.locator('.sps-path-item', { hasText: '~/work' })).toBeVisible({ timeout: 15_000 })
      await expect(more).toBeVisible()
      if (expectRows !== null) await expect(shownRows).toHaveCount(expectRows)
      const shown = await shownRows.count()
      expect(shown).toBeGreaterThanOrEqual(3)
      expect(shown).toBeLessThanOrEqual(8)
      // The short window really is short: fewer than 8 rows fit there.
      if (height === 720) expect(shown).toBeLessThan(8)
      await expect(more).toHaveText(`Show ${40 - shown} more`)
      await expect(more).toHaveAttribute('role', 'option')
      // HOME FOLDERS is on screen without any scrolling.
      const geo = await list(page).evaluate((el) => {
        const label = el.querySelector('[data-section-id="home:devbox"] .sps-section-label')!.getBoundingClientRect()
        const box = el.getBoundingClientRect()
        return { scrollTop: el.scrollTop, top: label.top, bottom: label.bottom, listTop: box.top, listBottom: box.top + el.clientHeight, scrollable: el.scrollHeight > el.clientHeight }
      })
      expect(geo.scrollTop).toBe(0)
      expect(geo.top).toBeGreaterThanOrEqual(geo.listTop)
      expect(geo.bottom).toBeLessThanOrEqual(geo.listBottom)
      await picker(page).screenshot({ path: `${SHOTS}/c30-history-cap-${height}-${test.info().project.name}.png` })

      // Scroll a little first, so "the list did not jump back to the top" is observable.
      if (geo.scrollable) {
        await list(page).hover()
        await page.mouse.wheel(0, 40)
        await expect.poll(() => list(page).evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
      }
      const scrolledTo = await list(page).evaluate((el) => el.scrollTop)
      await more.click()
      await expect(history.locator('.sps-path-item')).toHaveCount(40)
      await expect(more).toHaveCount(0)
      // The highlight sits on the row that took the more row's place (the first one it hid).
      const active = list(page).locator('.sps-path-item.active')
      await expect(active).toHaveCount(1)
      await expect(active).toContainText(`worker-${String(shown + 1).padStart(2, '0')}`)
      expect(await list(page).evaluate((el) => el.scrollTop)).toBeGreaterThanOrEqual(scrolledTo)

      // A changed input folds the group again ('wor' still finds ~/work below it).
      await input(page).fill('wor')
      await expect(more).toHaveText(`Show ${40 - shown} more`)
      await expect(shownRows).toHaveCount(shown)
    })
  }

  test('C55: Check again on the Build box note reads Checking..., the fixture clears the problem mid-check, then the ready line', async ({ page, request }) => {
    await loadHome(page)
    await openPicker(page)
    await hostTab(page, 'buildbox').click()
    const n = note(page, 'buildbox')
    await expect(n).toHaveAttribute('data-type', 'readiness')

    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => { release = resolve })
    await page.route('**/api/hosts/buildbox/check', async (route) => { await held; await route.continue() })
    await n.getByRole('button', { name: 'Check again' }).click()
    const checking = n.getByRole('button', { name: 'Checking...' })
    await expect(checking).toBeVisible()
    await expect(checking).toBeDisabled()
    await hostFixture(request, { action: 'set-check-result', host: 'buildbox' })
    release()

    await expect(n).toHaveAttribute('data-type', 'ready')
    await expect(n).toHaveText(/^✓ Build box is ready \(Claude Code .+\)$/)
    await expect(hostTab(page, 'buildbox').locator('.sps-host-dot')).toHaveAttribute('data-kind', 'connected')
    // The ready line holds for 3s, then the note row is gone.
    await expect(n).toHaveCount(0, { timeout: 6_000 })
  })

  test('C73: in All, Build box history rows wear the warn dot beside the host tag, Dev box rows none', async ({ page }) => {
    await addHistory(page, [
      hist('/home/alice/work/api', 'buildbox', 'Build box', 12),
      hist('/home/alice/work/web', 'devbox', 'Dev box', 11),
      hist('/home/alice/work/keys', 'keybox', 'Key box', 10),
    ])
    await loadHome(page)
    await openPicker(page)
    await expect(picker(page).locator('.sps-host-tab.active')).toHaveText('All')

    const rowOn = (label: string): Locator => list(page).locator('.sps-path-item', { has: page.locator('.sps-path-host-tag', { hasText: label }) })
    const buildRow = rowOn('Build box')
    await expect(buildRow).toHaveCount(1)
    const dot = buildRow.locator('.sps-path-meta > .sps-host-dot')
    await expect(dot).toHaveAttribute('data-kind', 'warn')
    // The dot sits right before the host tag, and the tag's tooltip is the dot's sentence.
    expect(await dot.evaluate((el) => el.nextElementSibling?.classList.contains('sps-path-host-tag'))).toBe(true)
    expect(await buildRow.locator('.sps-path-host-tag').getAttribute('title')).toMatch(/^Build box: Claude Code on Build box is 2\.1\.220/)
    await expect(rowOn('Dev box').locator('.sps-host-dot')).toHaveCount(0)
    await expect(rowOn('Key box').locator('.sps-host-dot')).toHaveAttribute('data-kind', 'failed')
    await list(page).screenshot({ path: `${SHOTS}/c73-row-dots-${test.info().project.name}.png` })
  })

  test('C88: opening the picker three times never prewarms Key box (auth) or Cert box (certificate); Net box still is', async ({ page, request }) => {
    const listed: string[] = []
    page.on('request', (r) => {
      const u = new URL(r.url())
      const host = u.searchParams.get('host')
      if (u.pathname === '/api/sessions/list-dirs' && host) listed.push(host)
    })
    await loadHome(page)
    const panel = await openDraft(page)
    for (let i = 0; i < 3; i++) {
      await draftCwdPill(panel).click()
      await expect(picker(page)).toBeVisible({ timeout: 10_000 })
      await expect(hostTab(page, 'keybox')).toBeAttached({ timeout: 20_000 })
      await expect.poll(() => listed.includes('netbox')).toBe(true)
      await input(page).press('Escape')
      await expect(picker(page)).toHaveCount(0)
    }
    expect(listed.filter((h) => h === 'keybox' || h === 'certbox')).toEqual([])
    const c = await counters(request)
    expect(c.listDirs.keybox ?? 0).toBe(0)
    expect(c.listDirs.certbox ?? 0).toBe(0)
    expect(c.connect.keybox ?? 0).toBe(0)
    expect(c.connect.certbox ?? 0).toBe(0)
    expect(c.listDirs.netbox ?? 0).toBeGreaterThanOrEqual(1)
  })
})

/** The 12-host fixture with two names too long for a tab. */
function manyHostsFile(): Record<string, unknown> {
  const file = fixtureFile('host-problems-many')
  file.hosts.box03.label = 'Box 03 on the shared release farm'
  file.hosts.box09.label = 'Box 09 in the overnight test lab'
  return file
}

test.describe('twelve hosts', () => {
  let labels: Record<string, string> = {}
  test.beforeAll(async ({ request }) => {
    await resetServerHostFixture(request)
    const file = manyHostsFile() as { hosts: Record<string, { label: string }> }
    labels = Object.fromEntries(Object.entries(file.hosts).map(([k, v]) => [k, v.label]))
    await hostFixture(request, { action: 'load', file })
  })
  test.afterAll(async ({ request }) => { await resetServerHostFixture(request) })

  test('C39 / C84: every tab caps at 10em, long names end in an ellipsis, one title per tab, the selected tab is scrolled into view', async ({ page }) => {
    await loadHome(page)
    const panel = await openPicker(page, 'box12')
    const tabs = picker(page).locator('.sps-host-tab[data-host^="box"]')
    await expect(tabs).toHaveCount(12)
    // Each dot says its own host's state (08 outdated, 09 signed out, 10 to 12 failed).
    const kinds: Record<string, string> = { box08: 'warn', box09: 'warn', box10: 'failed', box11: 'failed', box12: 'failed' }
    for (const host of Object.keys(labels)) {
      await expect(hostTab(page, host).locator('.sps-host-dot')).toHaveAttribute('data-kind', kinds[host] ?? 'connected')
    }

    const facts = await tabs.evaluateAll((els) => els.map((el) => {
      const label = el.querySelector('.sps-host-tab-label') as HTMLElement
      const dot = el.querySelector('.sps-host-dot')
      const cs = getComputedStyle(label)
      return {
        host: el.getAttribute('data-host')!, width: el.getBoundingClientRect().width, em: parseFloat(getComputedStyle(el).fontSize),
        top: Math.round(el.getBoundingClientRect().top), text: label.textContent ?? '',
        overflows: label.scrollWidth > label.clientWidth, textOverflow: cs.textOverflow, overflowX: cs.overflowX, whiteSpace: cs.whiteSpace,
        title: el.getAttribute('title'), dotTitle: dot?.getAttribute('title') ?? null, dotLabel: dot?.getAttribute('aria-label') ?? null,
        tabLabel: el.getAttribute('aria-label'), dotHidden: dot?.getAttribute('aria-hidden') ?? null,
      }
    }))
    for (const f of facts) {
      expect(f.width, `${f.host} tab width`).toBeLessThanOrEqual(10 * f.em + 0.5)
      expect(f.text).toBe(labels[f.host])
      expect(f.dotTitle, `${f.host} dot has no title`).toBeNull()
      // One accessible name, the tab's own: the dot inside is decorative (no second '{L}: ...').
      expect(f.title, `${f.host} title`).toBe(f.tabLabel)
      expect(f.dotLabel, `${f.host} dot has no label of its own`).toBeNull()
      expect(f.dotHidden).toBe('true')
      expect(f.title!.startsWith(`${labels[f.host]}: `)).toBe(true)
      expect(f.textOverflow).toBe('ellipsis')
      expect(f.overflowX).toBe('hidden')
      expect(f.whiteSpace).toBe('nowrap')
    }
    // The long names really are cut; the short ones are not. One row, never wrapped.
    const byHost = new Map(facts.map((f) => [f.host, f]))
    expect(byHost.get('box03')!.overflows).toBe(true)
    expect(byHost.get('box09')!.overflows).toBe(true)
    expect(byHost.get('box01')!.overflows).toBe(false)
    expect(new Set(facts.map((f) => f.top)).size).toBe(1)
    await hostTab(page, 'box03').screenshot({ path: `${SHOTS}/c84-tab-ellipsis-${test.info().project.name}.png` })

    // Pick a folder on Box 09 (far right), then reopen: its tab is selected and in view.
    await hostTab(page, 'box09').click()
    await expect(hostTab(page, 'box09')).toHaveClass(/active/)
    await input(page).fill('~/work/')
    await expect(list(page).locator('.sps-path-item.sps-live', { hasText: 'api' })).toBeVisible({ timeout: 15_000 })
    await input(page).press('Shift+Enter')
    await expect(picker(page)).toHaveCount(0)
    await draftCwdPill(panel).click()
    await expect(hostTab(page, 'box09')).toHaveClass(/active/)
    const strip = picker(page).locator('.sps-host-filter')
    await expect.poll(() => strip.evaluate((el) => {
      const s = el.getBoundingClientRect()
      const t = el.querySelector('.sps-host-tab.active')!.getBoundingClientRect()
      return t.left >= s.left - 0.5 && t.right <= s.right + 0.5
    })).toBe(true)
    // It had to scroll to get there (the tab sits past the strip's first screen).
    const where = await strip.evaluate((el) => ({ scrollLeft: el.scrollLeft, tabLeft: (el.querySelector('.sps-host-tab.active') as HTMLElement).offsetLeft, width: el.clientWidth }))
    expect(where.tabLeft).toBeGreaterThan(where.width / 2)
    expect(where.scrollLeft).toBeGreaterThan(0)
    await strip.screenshot({ path: `${SHOTS}/c84-selected-in-view-${test.info().project.name}.png` })
  })
})

test.describe('Settings host row head', () => {
  test.beforeAll(async ({ request }) => { await resetServerHostFixture(request) })
  test.afterAll(async ({ request }) => { await resetServerHostFixture(request) })

  test('C32: at 1280px a 10-character alias is never cut; the long hostname is, with the full name as its title', async ({ page, request }) => {
    const hostname = 'devcloud01.build-runners.eu-central-1.compute.internal.example.com'
    const file = fixtureFile('host-problems')
    file.hosts = { devcloud01: { label: 'Dev cloud', hostname, phase: 'connected', claude: { version: '2.1.281', auth: 'ok', installMethod: 'native' } } }
    await hostFixture(request, { action: 'load', file })
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto('/settings')
    await page.getByTestId('settings-nav-remote-hosts').click()
    const row = page.locator('#rh-host-devcloud01')
    await expect(row).toBeVisible({ timeout: 20_000 })
    const alias = row.locator('.rh-host-alias')
    const host = row.locator('.rh-host-hostname')
    await expect(row.locator('.rh-host-name')).toHaveText('Dev cloud')
    await expect(alias).toHaveText('devcloud01')
    await expect(host).toHaveAttribute('title', hostname)
    const m = await row.evaluate((el) => {
      const a = el.querySelector('.rh-host-alias') as HTMLElement
      const h = el.querySelector('.rh-host-hostname') as HTMLElement
      const cell = (el.querySelector('.settings-addons-inline') as HTMLElement).getBoundingClientRect()
      return {
        aliasScroll: a.scrollWidth, aliasClient: a.clientWidth, aliasRight: a.getBoundingClientRect().right, cellRight: cell.right,
        hostScroll: h.scrollWidth, hostClient: h.clientWidth, hostOverflow: getComputedStyle(h).textOverflow,
      }
    })
    expect(m.aliasScroll).toBeLessThanOrEqual(m.aliasClient)
    expect(m.aliasRight).toBeLessThanOrEqual(m.cellRight + 0.5)
    expect(m.hostScroll).toBeGreaterThan(m.hostClient)
    expect(m.hostOverflow).toBe('ellipsis')
    await row.screenshot({ path: `${SHOTS}/c32-row-head-${test.info().project.name}.png` })
    await page.unrouteAll({ behavior: 'ignoreErrors' })
  })

  test('C42: an alias-only row (no hostname yet) follows the store frames for its dot', async ({ page }) => {
    const hosts = new Hosts(page)
    await hosts.install([])
    await page.goto('/settings')
    await page.getByTestId('settings-nav-remote-hosts').click()
    await page.waitForFunction(() => {
      const ws = (window as unknown as { __hpWs?: WebSocket }).__hpWs
      return !!ws && ws.readyState === WebSocket.OPEN
    }, null, { timeout: 20_000 })
    await page.getByTestId('remote-hosts-add').first().click()
    const aliasInput = page.locator('input[id^="rh-alias-"]').last()
    await aliasInput.fill('draftbox')
    const dot = page.locator('.rh-status[data-host="draftbox"] .sps-host-dot')
    await expect(dot).toHaveAttribute('data-kind', 'unknown')
    await hosts.push(connected('draftbox', 'Draft box'))
    await expect(dot).toHaveAttribute('data-kind', 'connected')
    await hosts.push(failed('draftbox', 'Draft box', 'auth'))
    await expect(dot).toHaveAttribute('data-kind', 'failed')
    await expect(page.locator('.rh-status[data-host="draftbox"]')).toContainText('Not connected')
  })
})
