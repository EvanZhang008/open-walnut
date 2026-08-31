import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs/promises'
import net from 'node:net'
import { expect, test, type Page } from '@playwright/test'

/**
 * The Time plugin App — the ONLY Time UI. It began as a port of the console's Time
 * Tracking section; that section has been deleted, so this App is the surface and the
 * server side (/api/time/*, the heartbeat capture) is the data plane it reads.
 *
 * Everything here runs against the fixture's OWN server
 * (tests/e2e/browser/time-app-server.ts), because the shared :3457 fixture installs
 * no plugins on purpose. That fixture links the example plugin into a throwaway data
 * home and seeds one dense day, so this spec exercises the real install path: the
 * host discovers the plugin, serves its web module, and its entry row appears where
 * the App asked for it.
 *
 * What it pins, beyond "it renders":
 *
 *   1. Placement: the App declares `placement: 'settings'`, so there is NO Sidebar row
 *      and there IS a Settings → Plugins row, which is what the test clicks. The Command
 *      Palette entry survives the move, and disabling the plugin takes the row away.
 *      The declaration is only a DEFAULT: the user can move the row either way from
 *      the plugin's own row in Settings → Plugins, live and durably.
 *   2. Its tabs are real URLs (a reload on /timeline comes back on the timeline, not on
 *      tab one).
 *   3. The Overview answers three questions AT ONCE (your time, agent time, the 7-day
 *      daily average) and switches days the way the Timeline does. The old
 *      Today/Yesterday/Last-7-days pills are gone, and their absence is asserted: a
 *      canned range could not answer "what about Tuesday?", which is most of what
 *      anyone asks a time report.
 *   4. Attention is SERIAL: no two segments of the tape may overlap vertically. That
 *      is the whole reason these views were rebuilt, so it is asserted, not eyeballed.
 *   5. The three views agree about the day, and agents appear in the swimlanes only.
 *   6. The Apps tab splits the day into Outside / In Walnut and never sums them into a
 *      number nobody spent; a browser's sites nest under it; and while the setting is
 *      off the tab is an invitation with one button, not an empty report.
 */

const SCREENSHOT_DIR = '/tmp/action-cards-time'
/** The Overview's own shots, taken at a laptop canvas so a human can read them. */
const OVERVIEW_SHOT_DIR = '/tmp/walnut-time-overview'
/** The Apps tab's own shots, same laptop canvas. */
const APPS_SHOT_DIR = '/tmp/walnut-time-apps'

interface Fixture {
  port: number
  home: string
  date: string
  taskIds: string[]
  previousDate: string
  /** One day before the seeded outside day: sampled nothing, on purpose. */
  outsideEmptyDate: string
  /** Two days before: a browser was used and no site came back (missing grant). */
  outsideHintDate: string
}

let child: ChildProcessWithoutNullStreams | null = null
let fixture: Fixture | null = null
let output = ''

test.setTimeout(240_000)
test.describe.configure({ mode: 'serial' })
test.use({ viewport: { width: 1680, height: 1040 } })

async function reservePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Could not reserve a Time App fixture port')
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return address.port
}

/** The fixture prints one machine-readable line once it is serving. */
function waitForReady(): Promise<Fixture> {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(
      () => reject(new Error(`Time App fixture did not start\n${output.slice(-8000)}`)),
      180_000,
    )
    const check = () => {
      const match = /TIME_APP_READY (\{.*\})/.exec(output)
      if (!match) return false
      clearTimeout(deadline)
      resolve(JSON.parse(match[1]!) as Fixture)
      return true
    }
    const timer = setInterval(() => {
      if (check()) clearInterval(timer)
      else if (child?.exitCode !== null && child?.exitCode !== undefined) {
        clearInterval(timer)
        clearTimeout(deadline)
        reject(new Error(`Time App fixture exited early (${child.exitCode})\n${output.slice(-8000)}`))
      }
    }, 250)
  })
}

async function shoot(page: Page, name: string, dir = SCREENSHOT_DIR): Promise<void> {
  // Viewport, not fullPage: the App renders inside the host's own scroll container, so
  // fullPage returns the same pixels and only doubles the bytes.
  await page.screenshot({ path: `${dir}/${name}.png` })
}

async function expandSidebar(page: Page): Promise<void> {
  await expect(page.locator('.sidebar')).toBeVisible({ timeout: 60_000 })
  if (await page.locator('.sidebar.collapsed').count()) {
    await page.locator('.sidebar-collapse-btn').click()
    await expect(page.locator('.sidebar.collapsed')).toHaveCount(0)
  }
}

async function openSettings(page: Page): Promise<void> {
  await expandSidebar(page)
  await page.getByTestId('sidebar-core-app-settings').click()
  await expect(page).toHaveURL(/\/settings$/)
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible({ timeout: 30_000 })
}

/** The app, opened the way a user opens it: Settings → Plugins → Time. */
async function openTimeApp(page: Page): Promise<void> {
  await page.goto(`http://127.0.0.1:${fixture!.port}/`)
  await page.waitForLoadState('domcontentloaded')
  await openSettings(page)
  const row = page.getByTestId('settings-nav-app-walnut-time:main')
  await expect(row).toBeVisible({ timeout: 60_000 })
  await row.click()
  await expect(page).toHaveURL(/\/apps\/walnut-time~main/)
  await expect(page.getByTestId('time-app')).toBeVisible({ timeout: 60_000 })
}

function localToday(): string {
  const today = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`
}

function shiftDate(date: string, deltaDays: number): string {
  const [y, m, d] = date.split('-').map((p) => parseInt(p, 10))
  const anchor = new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1, 12, 0, 0, 0)
  anchor.setDate(anchor.getDate() + deltaDays)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${anchor.getFullYear()}-${pad(anchor.getMonth() + 1)}-${pad(anchor.getDate())}`
}

/**
 * What the day nav prints for a date. Computed here on purpose: asserting the label
 * merely CHANGED would pass on an off-by-one step, and "which day am I looking at" is
 * the whole point of the control.
 */
function navLabel(date: string): string {
  const [y, m, d] = date.split('-').map((p) => parseInt(p, 10))
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1)
    .toLocaleDateString('en', { weekday: 'short', month: 'short', day: 'numeric' })
}

/** What the week scope prints for one end of its range. */
function rangeLabel(date: string): string {
  const [y, m, d] = date.split('-').map((p) => parseInt(p, 10))
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1).toLocaleDateString('en', { month: 'short', day: 'numeric' })
}

/** "2h 05m" / "42m" / "30s" → minutes, so two scopes can be compared. */
function toMinutes(text: string): number {
  const hours = /(\d+)h/.exec(text)
  const minutes = /(\d+)m/.exec(text)
  const seconds = /^(\d+)s$/.exec(text)
  return (hours ? Number(hours[1]) * 60 : 0)
    + (minutes ? Number(minutes[1]) : 0)
    + (seconds ? Number(seconds[1]) / 60 : 0)
}

/** Walk the day nav back if the fixture had to seed yesterday. */
async function landOnSeededDay(page: Page): Promise<void> {
  if (fixture!.date !== localToday()) await page.getByTestId('time-app-prev').click()
}

/**
 * Same problem one tab over. The reports default to today, but the fixture seeds
 * YESTERDAY whenever the run starts within its span of local midnight (`seedAnchor`,
 * time-app-server.ts) — so between midnight and ~02:40 the report is honestly empty and
 * every assertion below it reads as a rendering bug. Walk the scope nav to the seeded
 * day instead of trusting the wall clock.
 */
async function landOnSeededScope(page: Page): Promise<void> {
  if (fixture!.date === localToday()) return
  await page.getByTestId('time-app-scope-prev').click()
}

/** The duration a stat card is showing, e.g. "4h 12m". */
async function statValue(page: Page, testId: string): Promise<string> {
  return (await page.getByTestId(testId).locator('.wt-stat-value').innerText()).trim()
}

/**
 * The Apps tab has its OWN day nav (a day is its own question there), so it opens on
 * today and has to be walked back the same way the timeline is.
 */
async function landOnSeededAppsDay(page: Page): Promise<void> {
  if (fixture!.date !== localToday()) await page.getByTestId('time-app-apps-prev').click()
  await expect(page.getByTestId('time-app-apps-date')).toContainText(navLabel(fixture!.date))
}

/** Open the Apps tab by clicking it, and wait for the day it answers with. */
async function openAppsTab(page: Page): Promise<void> {
  await page.getByTestId('time-app-tab-apps').click()
  await expect(page).toHaveURL(/\/apps\/walnut-time~main\/apps$/)
  await expect(page.getByTestId('time-app-apps')).toBeVisible({ timeout: 30_000 })
}

test.beforeAll(async () => {
  // A hook does NOT inherit the file's test timeout: it gets the config default (30s),
  // and booting a server plus Vite takes longer than that whenever the machine is busy.
  test.setTimeout(240_000)
  await fs.mkdir(SCREENSHOT_DIR, { recursive: true })
  await fs.mkdir(OVERVIEW_SHOT_DIR, { recursive: true })
  await fs.mkdir(APPS_SHOT_DIR, { recursive: true })
  const port = await reservePort()
  child = spawn('./node_modules/.bin/tsx', ['tests/e2e/browser/time-app-server.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, PW_TIME_APP_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => { output = `${output}${String(chunk)}`.slice(-20_000) })
  child.stderr.on('data', (chunk) => { output = `${output}${String(chunk)}`.slice(-20_000) })
  fixture = await waitForReady()
})

test.afterAll(async () => {
  if (!child || child.exitCode !== null) return
  const stopped = new Promise<void>((resolve) => child?.once('exit', () => resolve()))
  child.kill('SIGTERM')
  const graceful = await Promise.race([
    stopped.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 20_000)),
  ])
  if (!graceful) child.kill('SIGKILL')
})

test('the App declares its own surface: a Settings → Plugins row, no Sidebar row', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  await page.goto(`http://127.0.0.1:${fixture!.port}/`)
  await page.waitForLoadState('domcontentloaded')
  await expandSidebar(page)

  // `placement: 'settings'` means exactly this: nothing in the Sidebar, ever.
  await expect(page.getByTestId('sidebar-core-app-home')).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId('sidebar-app-walnut-time:main')).toHaveCount(0)

  // The palette entry is placement-blind — moving the row must not cost the App its
  // keyboard route, which is the promise the contract makes to the author.
  await page.getByTestId('sidebar-core-app-home').click()
  const composer = page.locator('.main-page-chat .chat-input-textarea')
  await composer.click()
  // Typed, not filled: the palette opens from the caret position, and a programmatic
  // fill can leave the caret at 0, where there is no slash to detect.
  await composer.pressSequentially('/app:walnut-time', { delay: 15 })
  await expect(page.locator('.command-palette-item', { hasText: 'app:walnut-time:main' }))
    .toBeVisible({ timeout: 15_000 })
  await page.keyboard.press('Escape')
  await composer.fill('')

  // And it IS in the Plugins group, below Agents and Memory, as a real link.
  await openSettings(page)
  const row = page.getByTestId('settings-nav-app-walnut-time:main')
  await expect(row).toBeVisible({ timeout: 60_000 })
  await expect(row).toHaveText('Time')
  await expect(row).toHaveAttribute('href', '/apps/walnut-time~main')
  await expect(row).toHaveAttribute('data-app-kind', 'native')
  const [rowBox, agentsBox, memoryBox] = await Promise.all([
    row.boundingBox(),
    page.getByTestId('settings-nav-agents').boundingBox(),
    page.getByTestId('settings-nav-memory').boundingBox(),
  ])
  expect(rowBox!.y).toBeGreaterThan(agentsBox!.y)
  expect(rowBox!.y).toBeGreaterThan(memoryBox!.y)
  await shoot(page, 'views-app-settings-nav')

  // This App is the ONLY Time UI now: the console's duplicate `time` section is gone,
  // so Configure must not offer a second door to the same numbers. `timeline` is NOT
  // that door — it is the screen-activity Life Tracker, which nothing else exposes.
  await expect(page.getByTestId('settings-nav-time')).toHaveCount(0)
  await expect(page.locator('.settings-nav-item', { hasText: 'Time Tracking' })).toHaveCount(0)
  await expect(page.getByTestId('settings-nav-timeline')).toHaveText('Timeline')
  await shoot(page, 'configure-group-no-time')

  await row.click()
  await expect(page).toHaveURL(/\/apps\/walnut-time~main$/)
  await expect(page.getByTestId('time-app')).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId('app-host-native')).toBeVisible()
  // Loaded, not loading: the shot is evidence, and "Refreshing…" over three empty
  // cards says nothing about whether the App works.
  await expect(page.getByTestId('time-app-trend').locator('.wt-trend-day')).toHaveCount(7, { timeout: 30_000 })
  await shoot(page, 'views-app-settings-page')

  expect(pageErrors, 'the plugin App must not throw in the browser').toEqual([])
})

test('the plugin App page holds the reports and its tabs are real URLs', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  await openTimeApp(page)

  // Tab one is the Overview, and the page is a page: it has a scope bar and filters.
  await expect(page.getByTestId('time-app-view-mine')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('time-app-project-filter')).toBeVisible()
  await landOnSeededScope(page)
  await expect(page.getByTestId('time-app-group-focus')).toBeVisible()
  await expect(page.getByTestId('time-app-trend').locator('.wt-trend-day')).toHaveCount(7)
  await shoot(page, 'views-app-my-time')

  // Agents is its own tab with its own caption — never a row inside My time.
  await page.getByTestId('time-app-tab-agents').click()
  await expect(page).toHaveURL(/\/apps\/walnut-time~main\/agents$/)
  await expect(page.getByTestId('time-app-agent-caption')).toContainText('not yours')
  await expect(page.getByTestId('time-app-group-agents')).toBeVisible()
  await shoot(page, 'views-app-agents')

  // A deep link is the tab: reload on /timeline and the timeline is what comes back.
  await page.getByTestId('time-app-tab-timeline').click()
  await expect(page).toHaveURL(/\/apps\/walnut-time~main\/timeline$/)
  await expect(page.getByTestId('time-app-timeline')).toBeVisible({ timeout: 30_000 })
  await page.reload()
  await expect(page.getByTestId('time-app-timeline')).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId('time-app')).toHaveAttribute('data-tab', 'timeline')

  // An old `/time` bookmark still has to land somewhere real. The route it used to
  // redirect to (`/settings#time`) was deleted with the duplicate section, which left
  // the bookmark opening a Settings page that has no Time row on it at all — a
  // dead-end answer to a question with a real destination. `goto` on purpose: a
  // bookmark IS a cold URL load, and no click in the UI can produce this one.
  await page.goto(`http://127.0.0.1:${fixture!.port}/time`)
  await expect(page).toHaveURL(/\/apps\/walnut-time~main$/)
  await expect(page.getByTestId('time-app')).toBeVisible({ timeout: 60_000 })

  expect(pageErrors, 'the plugin App must not throw in the browser').toEqual([])
})

test('the Overview answers both clocks at once and switches days like the timeline', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  // Narrower than the file default: the four cards and the paired trend have to hold up
  // on a laptop canvas, and this is the shot a human reviews.
  await page.setViewportSize({ width: 1280, height: 1000 })

  await openTimeApp(page)
  await expect(page.getByTestId('time-app-view-mine')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('time-app-trend').locator('.wt-trend-day')).toHaveCount(7, { timeout: 30_000 })

  // The canned ranges are GONE. They could not answer "what about Tuesday?", so the
  // scope is the Timeline's own gesture plus a length toggle.
  await expect(page.getByTestId('time-app-range-today')).toHaveCount(0)
  await expect(page.getByTestId('time-app-range-yesterday')).toHaveCount(0)
  await expect(page.getByTestId('time-app-range-7d')).toHaveCount(0)
  for (const id of ['time-app-scope-prev', 'time-app-scope-next', 'time-app-scope-date',
    'time-app-scope-today', 'time-app-scope-day', 'time-app-scope-week']) {
    await expect(page.getByTestId(id), id).toBeVisible()
  }

  // ‹ steps one real day back, and Today comes straight back to it.
  const label = page.getByTestId('time-app-scope-date')
  const today = localToday()
  await expect(label).toContainText(navLabel(today))
  await page.getByTestId('time-app-scope-prev').click()
  await expect(label).toContainText(navLabel(shiftDate(today, -1)))
  await page.getByTestId('time-app-scope-today').click()
  await expect(label).toContainText(navLabel(today))

  await landOnSeededScope(page)
  const scopedDay = fixture!.date

  // BOTH clocks on one screen, each its own number: agents run in parallel, so the two
  // are never summed, and neither may be missing from the answer.
  const humanText = await statValue(page, 'time-app-stat-human')
  const agentText = await statValue(page, 'time-app-stat-agent')
  expect(toMinutes(humanText), `your time on ${scopedDay} (${humanText})`).toBeGreaterThan(0)
  expect(toMinutes(agentText), `agent runtime on ${scopedDay} (${agentText})`).toBeGreaterThan(0)
  // The 7-day average carries the agent lane as a subline, never folded into its value.
  const average = page.getByTestId('time-app-stat-average')
  await expect(average).toContainText('Daily average, last 7 days')
  await expect(average.locator('.wt-stat-sub')).toContainText('Agents')
  expect(toMinutes(await statValue(page, 'time-app-stat-average'))).toBeGreaterThan(0)
  await expect(page.getByTestId('time-app-stat-focus')).toBeVisible()
  // The iPhone slice rides the Your-time card as a HUMAN-toned subline (the agent hue
  // would invert the two-clocks rule on the one card labelled "Your time"), and only
  // on the unfiltered view: it is day-level data that cannot follow the task filters.
  const humanSub = page.getByTestId('time-app-stat-human').locator('.wt-stat-sub')
  await expect(humanSub).toContainText('iPhone 6m')
  await expect(humanSub).toHaveClass(/wt-stat-sub-human/)
  await page.getByTestId('time-app-kind-session').click()
  await expect(humanSub).toHaveCount(0)
  await page.getByTestId('time-app-kind-all').click()
  await expect(humanSub).toContainText('iPhone')
  // Above the fold is the claim being made: all four numbers on one screen.
  await shoot(page, 'overview-day', OVERVIEW_SHOT_DIR)

  // The week scope is a real widening: its label is the range, and it can only hold
  // MORE of your time than the day inside it.
  await page.getByTestId('time-app-scope-week').click()
  await expect(label).toContainText(`${rangeLabel(shiftDate(scopedDay, -6))} to ${rangeLabel(scopedDay)}`)
  expect(toMinutes(await statValue(page, 'time-app-stat-human')))
    .toBeGreaterThanOrEqual(toMinutes(humanText))
  await shoot(page, 'overview-week', OVERVIEW_SHOT_DIR)

  // A trend bar is a day selector: clicking one reads that day, which is a day scope.
  const seededBar = page.locator(`[data-testid="time-app-trend-day"][data-date="${scopedDay}"]`)
  await expect(seededBar).toBeVisible()
  await seededBar.click()
  await expect(label).toContainText(navLabel(scopedDay))
  await expect(seededBar).toHaveClass(/is-selected/)
  await expect(page.getByTestId('time-app-scope-day')).toHaveClass(/is-active/)
  // Two bars per day, one per lane, so the day the fixture seeded has both drawn.
  await expect(seededBar.locator('.wt-trend-bar-human')).toHaveCount(1)
  await expect(seededBar.locator('.wt-trend-bar-agent')).toHaveCount(1)

  // The agent list is a pointer, not the report: five rows at most, and a way over to
  // the tab that owns the question. The fixture seeds exactly one agent run.
  const agentsTop = page.getByTestId('time-app-agents-top')
  await expect(agentsTop.locator('.wt-bar-row')).toHaveCount(1)
  await page.getByTestId('time-app-open-agents').click()
  await expect(page).toHaveURL(/\/apps\/walnut-time~main\/agents$/)
  await expect(page.getByTestId('time-app-view-agents')).toBeVisible()
  // One scope for both report tabs: the day survives the hop, or the link would answer
  // a different question than the card it was clicked from.
  await expect(page.getByTestId('time-app-scope-date')).toContainText(navLabel(scopedDay))
  await shoot(page, 'overview-agents-tab', OVERVIEW_SHOT_DIR)

  expect(pageErrors, 'the plugin App must not throw in the browser').toEqual([])
})

test('the Apps tab answers for the screen time Walnut never sees', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  // The laptop canvas: this is the shot a human reviews, and the nested site rows have
  // to survive a 1280px-wide page.
  await page.setViewportSize({ width: 1280, height: 1000 })

  await openTimeApp(page)
  await openAppsTab(page)
  await expect(page.getByTestId('time-app')).toHaveAttribute('data-tab', 'apps')

  // Its own day question, so the shared scope bar is not on this tab at all: two day
  // switchers on one screen would disagree the first time one of them moved.
  await expect(page.getByTestId('time-app-scope-date')).toHaveCount(0)
  await expect(page.getByTestId('time-app-project-filter')).toHaveCount(0)
  for (const id of ['time-app-apps-prev', 'time-app-apps-next', 'time-app-apps-date', 'time-app-apps-today']) {
    await expect(page.getByTestId(id), id).toBeVisible()
  }

  await landOnSeededAppsDay(page)
  await expect(page.getByTestId('time-app-apps-list')).toBeVisible({ timeout: 30_000 })

  // The split is the whole point of the tab: the outside number is the one the other
  // three tabs cannot produce, and the two parts add up to the total rather than being
  // three independent readings of it.
  const outside = page.getByTestId('time-app-apps-outside')
  await expect(outside).toContainText('Outside Walnut')
  await expect(page.getByTestId('time-app-apps-inside')).toContainText('In Walnut')
  const outsideMin = toMinutes(await statValue(page, 'time-app-apps-outside'))
  const insideMin = toMinutes(await statValue(page, 'time-app-apps-inside'))
  const totalMin = toMinutes(await statValue(page, 'time-app-apps-total'))
  expect(insideMin, 'Walnut time on the seeded day').toBeGreaterThan(0)
  expect(outsideMin, 'outside time on the seeded day').toBeGreaterThan(insideMin)
  // One minute of slack: each card rounds its own value independently.
  expect(Math.abs(outsideMin + insideMin - totalMin), `${outsideMin} + ${insideMin} vs ${totalMin}`)
    .toBeLessThanOrEqual(1)

  // The collector is deliberately NOT running in a test (it is a compiled macOS helper
  // that watches the real screen), so the tab has to say the setting is on while the
  // sampler is not.
  await expect(page.getByTestId('time-app-apps-idle')).toContainText('Tracker is starting')

  // Longest first, and it is the ranking the server sent rather than DOM order luck.
  const rows = page.getByTestId('time-app-apps-row')
  await expect.poll(() => rows.count(), { timeout: 30_000 }).toBeGreaterThan(3)
  const rowMinutes = await rows.evaluateAll((nodes) => nodes.map((node) => ({
    app: (node as HTMLElement).dataset.app ?? '',
    value: node.querySelector('.wt-bar-value')?.textContent?.trim() ?? '',
  })))
  const ranked = rowMinutes.map((row) => toMinutes(row.value))
  for (let i = 1; i < ranked.length; i += 1) {
    expect(ranked[i], `row ${i} (${rowMinutes[i]!.app}) vs row ${i - 1}`).toBeLessThanOrEqual(ranked[i - 1]!)
  }
  expect(rowMinutes.map((row) => row.app)).toContain('Google Chrome')

  // Exactly one row is ENTIRELY Walnut time. The browser that spent part of its day on
  // a Walnut page is not that row: its Walnut share is already inside `In Walnut`, and
  // chipping it would claim the whole browser.
  await expect(page.getByTestId('time-app-apps-chip')).toHaveCount(1)
  const walnutRow = page.locator('[data-testid="time-app-apps-row"]', {
    has: page.getByTestId('time-app-apps-chip'),
  })
  await expect(walnutRow).toHaveAttribute('data-app', 'Walnut')

  // A browser breaks down by site, nested under its own row and scaled inside it. The
  // tail folds: ten hosts, eight drawn, the rest behind one expander.
  const chromeRow = page.locator('[data-testid="time-app-apps-row"][data-app="Google Chrome"]')
  const sites = chromeRow.locator('.wt-ap-site')
  await expect(sites).toHaveCount(8)
  await expect(chromeRow.locator('[data-host="localhost"]')).toBeVisible()
  await expect(chromeRow.locator('[data-host="github.com"]')).toBeVisible()
  const more = chromeRow.getByTestId('time-app-apps-more')
  await expect(more).toHaveText('+2 more')
  await more.click()
  await expect(sites).toHaveCount(10)
  await expect(more).toHaveText('Fewer sites')
  await shoot(page, 'apps-day', APPS_SHOT_DIR)

  // ‹ steps to a real day that sampled nothing, and the tab says which day that was
  // instead of drawing an empty chart.
  await page.getByTestId('time-app-apps-prev').click()
  await expect(page.getByTestId('time-app-apps-date')).toContainText(navLabel(fixture!.outsideEmptyDate))
  await expect(page.getByTestId('time-app-apps-empty')).toContainText('Nothing sampled')
  await expect(page.getByTestId('time-app-apps-empty')).toContainText(navLabel(fixture!.outsideEmptyDate))
  await expect(page.getByTestId('time-app-apps-list')).toHaveCount(0)
  await shoot(page, 'apps-empty-day', APPS_SHOT_DIR)

  // ‹ again: a day a browser was used and not one site came back. That is a missing
  // macOS grant, not a browser that visited nowhere, so the tab explains the grant.
  await page.getByTestId('time-app-apps-prev').click()
  await expect(page.getByTestId('time-app-apps-date')).toContainText(navLabel(fixture!.outsideHintDate))
  const hint = page.getByTestId('time-app-apps-automation')
  await expect(hint).toBeVisible()
  await expect(hint).toContainText('Automation')
  await expect(page.getByTestId('time-app-apps-row').first()).toBeVisible()
  await expect(page.getByTestId('time-app-apps-sites')).toHaveCount(0)
  await shoot(page, 'apps-automation-hint', APPS_SHOT_DIR)

  // Today comes straight back, the same gesture the other day navs make.
  await page.getByTestId('time-app-apps-today').click()
  await expect(page.getByTestId('time-app-apps-date')).toContainText(navLabel(localToday()))

  // A deep link is the tab, exactly like the timeline's.
  await page.reload()
  await expect(page.getByTestId('time-app-apps')).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId('time-app')).toHaveAttribute('data-tab', 'apps')

  expect(pageErrors, 'the Apps tab must not throw in the browser').toEqual([])
})

/*
 * AFTER the populated test, and never the other way round: it turns the setting off,
 * and turning it back ON through the API would start the real collector (a Swift
 * compile plus a process that watches the screen), which a browser test must never do.
 */
test('with tracking off the Apps tab is an invitation, not an empty report', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.setViewportSize({ width: 1280, height: 1000 })

  // The same call the tab's own Pause button makes. Explicit `enabled`, so it is
  // idempotent: a flip would depend on what the previous test left behind.
  const off = await page.request.post(`http://127.0.0.1:${fixture!.port}/api/time/apps/toggle`, {
    data: { enabled: false },
  })
  expect(off.ok(), await off.text()).toBe(true)
  expect((await off.json()) as { enabled: boolean }).toMatchObject({ enabled: false })

  await openTimeApp(page)
  await openAppsTab(page)

  const invite = page.getByTestId('time-app-apps-invite')
  await expect(invite).toBeVisible({ timeout: 30_000 })
  await expect(invite).toContainText('See where the rest of your screen time went')
  // What it would collect is on the page BEFORE the button, not behind it.
  await expect(invite).toContainText('every few seconds')
  await expect(invite).toContainText('leaves this Mac')
  await expect(invite).toContainText('once per browser')

  // Present and enabled, and NOT clicked: enabling for real compiles the macOS helper
  // and starts sampling the machine running this test.
  const enable = page.getByTestId('time-app-apps-enable')
  await expect(enable).toBeVisible()
  await expect(enable).toBeEnabled()

  // No numbers while it is off: a zeroed split strip would read as a day spent nowhere.
  // And no day nav either — there is no day question until something is being sampled.
  await expect(page.getByTestId('time-app-apps-date')).toHaveCount(0)
  await expect(page.getByTestId('time-app-apps-outside')).toHaveCount(0)
  await expect(page.getByTestId('time-app-apps-list')).toHaveCount(0)
  await expect(page.getByTestId('time-app-apps-pause')).toHaveCount(0)
  await shoot(page, 'apps-disabled', APPS_SHOT_DIR)

  expect(pageErrors, 'the disabled Apps tab must not throw in the browser').toEqual([])
})

test('all three timeline views hold up on the dense day', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  await openTimeApp(page)
  await page.getByTestId('time-app-tab-timeline').click()
  await expect(page.getByTestId('time-app-timeline')).toBeVisible({ timeout: 30_000 })
  await landOnSeededDay(page)

  // ══ VIEW A: the tape ══
  await page.getByTestId('time-app-view-tape').click()
  const segs = page.getByTestId('time-app-tape-seg')
  await expect.poll(() => segs.count(), { timeout: 30_000 }).toBeGreaterThan(4)

  // THE rule the rebuild exists for: attention is serial, so no two segments may
  // occupy the same pixels. A 2px floor can overdraw by under a pixel, so allow that.
  const boxes = await segs.evaluateAll((nodes) => nodes.map((node) => {
    const rect = (node as HTMLElement).getBoundingClientRect()
    return { top: rect.top, bottom: rect.bottom }
  }))
  const sorted = [...boxes].sort((a, b) => a.top - b.top)
  for (let i = 1; i < sorted.length; i += 1) {
    expect(sorted[i]!.top).toBeGreaterThanOrEqual(sorted[i - 1]!.bottom - 2.5)
  }

  // At least one segment is long enough to carry its own title.
  const labelled = await page.locator('[data-testid="time-app-tape-seg"] .wt-tp-seg-title').count()
  expect(labelled).toBeGreaterThan(0)

  // The ranked list is the tape's key, and hovering it lights the segment.
  const rank = page.getByTestId('time-app-tape-rank')
  await expect(rank).toBeVisible()
  const firstRow = rank.getByTestId('time-app-tape-rrow').first()
  const rowTaskId = await firstRow.getAttribute('data-time-task-id')
  await firstRow.hover()
  await expect(page.locator(`[data-testid="time-app-tape-seg"][data-time-task-id="${rowTaskId}"]`).first())
    .toHaveClass(/is-lit/)

  // Agents are not in this view at all: the toggle does not even exist here.
  await expect(page.getByTestId('time-app-agents-toggle')).toHaveCount(0)
  // Off the list first: the cross-highlight dims every other task, and a screenshot
  // taken mid-hover shows the dimmed state rather than the day.
  await page.mouse.move(8, 8)
  await shoot(page, 'views-app-tape')

  // ══ VIEW B: chapters ══
  await page.getByTestId('time-app-view-chapters').click()
  const cards = page.getByTestId('time-app-chapters-card')
  await expect.poll(() => cards.count(), { timeout: 30_000 }).toBeGreaterThan(1)
  await expect(page.getByTestId('time-app-chapters-comp').first()).toBeVisible()
  await expect(page.getByTestId('time-app-chapters-idle').first()).toBeVisible()
  await shoot(page, 'views-app-chapters')

  // Expanding a chapter reveals the same ribbon, zoomed over that chapter only.
  await cards.first().locator('.wt-tc-head').click()
  await expect(page.getByTestId('time-app-chapters-ribbon')).toBeVisible()
  await expect(page.getByTestId('time-app-chapters-detail').getByTestId('time-app-tape-seg').first())
    .toBeVisible()
  await shoot(page, 'views-app-chapters-expanded')

  // ══ VIEW C: swimlanes ══
  await page.getByTestId('time-app-view-lanes').click()
  await expect(page.getByTestId('time-app-lanes')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('time-app-lanes-row-task').first()).toBeVisible()
  // Nineteen tasks, six rows: the rest is ONE aggregated row, not nineteen.
  await expect(page.getByTestId('time-app-lanes-row-task')).toHaveCount(6)
  await expect(page.getByTestId('time-app-lanes-row-others')).toHaveCount(1)

  // The agent row exists only when the toggle says so.
  await expect(page.getByTestId('time-app-lanes-row-agent')).toHaveCount(0)
  const toggle = page.getByTestId('time-app-agents-toggle')
  await expect(toggle).toBeVisible()
  if (!(await toggle.isChecked())) await toggle.check()
  await expect(page.getByTestId('time-app-lanes-row-agent')).toHaveCount(1)
  await expect(page.getByTestId('time-app-agent-total')).not.toContainText('0s')
  await shoot(page, 'views-app-lanes')

  // ══ VIEW C: the merged "其他" row EXPANDS — the cap is a default, not a wall. ══
  await page.getByTestId('time-app-lanes-expand-others').click()
  // Nineteen seeded tasks plus the taskless iOS chat bucket: six named rows
  // plus fourteen unfolded children.
  await expect(page.getByTestId('time-app-lanes-row-task')).toHaveCount(20)
  await expect(page.getByTestId('time-app-lanes-expand-others')).toContainText('收起')
  await shoot(page, 'views-app-lanes-others-expanded')
  await page.getByTestId('time-app-lanes-expand-others').click()
  await expect(page.getByTestId('time-app-lanes-row-task')).toHaveCount(6)

  // ══ VIEW C: screen time (outside apps) rides the same chart, toggle-only. ══
  await expect(page.getByTestId('time-app-lanes-row-outside')).toHaveCount(0)
  const screenToggle = page.getByTestId('time-app-screen-toggle')
  await expect(screenToggle).toBeVisible()
  await screenToggle.check()
  // Eight seeded non-Walnut apps (Walnut + the localhost tab are excluded
  // server-side): six get their own slate row, the tail folds into one.
  await expect(page.getByTestId('time-app-lanes-row-outside')).toHaveCount(6, { timeout: 30_000 })
  await expect(page.getByTestId('time-app-lanes-row-outside-others')).toHaveCount(1)
  await expect(page.getByTestId('time-app-screen-total')).toContainText('Walnut 外')
  await shoot(page, 'views-app-lanes-screen')

  // …and that merged app row expands the same way the task one does.
  await page.getByTestId('time-app-lanes-expand-outside-others').click()
  await expect(page.getByTestId('time-app-lanes-row-outside')).toHaveCount(8)
  await shoot(page, 'views-app-lanes-screen-expanded')
  await page.getByTestId('time-app-lanes-expand-outside-others').click()
  await expect(page.getByTestId('time-app-lanes-row-outside')).toHaveCount(6)
  // Leave the pref off for the tests that follow (it is remembered in localStorage).
  await screenToggle.uncheck()
  await expect(page.getByTestId('time-app-lanes-row-outside')).toHaveCount(0)

  // The view choice is remembered across a reload (localStorage, the plugin's own
  // keys). The DAY is not remembered and resets to today, so walk back to the seeded
  // one first: on an empty day every view draws its empty state and this assertion
  // would fail for want of data rather than for want of the remembered view.
  await page.reload()
  await expect(page.getByTestId('time-app-timeline')).toBeVisible({ timeout: 60_000 })
  await landOnSeededDay(page)
  await expect(page.getByTestId('time-app-lanes')).toBeVisible({ timeout: 60_000 })

  expect(pageErrors, 'the plugin App must not throw in the browser').toEqual([])
})

test('the user can move the row to the Sidebar and back, live and across a reload', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  await page.goto(`http://127.0.0.1:${fixture!.port}/`)
  await page.waitForLoadState('domcontentloaded')
  await openSettings(page)
  await page.getByTestId('settings-nav-plugin-store').click()

  // The app's controls live on the PLUGIN's row in the Plugins section — an app
  // is not a separate thing to manage on another panel.
  const appRow = page.getByTestId('plugin-app-row-walnut-time:main')
  await expect(appRow).toBeVisible({ timeout: 60_000 })
  // Where it starts: what the App declared.
  await expect(appRow).toContainText('In Settings')
  const move = page.getByTestId('plugin-app-placement-walnut-time:main')
  await expect(move).toHaveText('Move to Sidebar')
  await shoot(page, 'apps-manager-placement-control')

  // A Core App is not the user's to move: it is not a plugin, so it has no row
  // (and no placement control) here at all.
  await expect(page.getByTestId('plugin-app-placement-core:home')).toHaveCount(0)
  await expect(page.getByTestId('plugin-app-row-core:home')).toHaveCount(0)

  await move.click()

  // Live, with no reload: the declared placement was only a default.
  await expect(appRow).toContainText('In Sidebar')
  await expect(page.getByTestId('settings-nav-app-walnut-time:main')).toHaveCount(0)
  await expect(page.getByTestId('sidebar-app-walnut-time:main')).toBeVisible({ timeout: 30_000 })
  await expect(move).toHaveText('Move to Settings')
  await shoot(page, 'placement-moved-to-sidebar')

  // It survives a reload, and the App itself is unchanged by the move: same route,
  // same page, reached from its new row.
  await page.reload()
  await expandSidebar(page)
  const sidebarRow = page.getByTestId('sidebar-app-walnut-time:main')
  await expect(sidebarRow).toBeVisible({ timeout: 60_000 })
  await sidebarRow.click()
  await expect(page).toHaveURL(/\/apps\/walnut-time~main/)
  await expect(page.getByTestId('time-app')).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId('time-app-trend').locator('.wt-trend-day')).toHaveCount(7, { timeout: 30_000 })

  // The same button is the way back to the App's own choice.
  await openSettings(page)
  await page.getByTestId('settings-nav-plugin-store').click()
  await page.getByTestId('plugin-app-placement-walnut-time:main').click()
  await expect(page.getByTestId('plugin-app-row-walnut-time:main')).toContainText('In Settings')
  await expect(page.getByTestId('sidebar-app-walnut-time:main')).toHaveCount(0)
  await expect(page.getByTestId('settings-nav-app-walnut-time:main')).toBeVisible({ timeout: 30_000 })

  // An override is NOT browser-local. App preferences ride the ui-prefs mirror
  // (config/share/ui-prefs.json) so a move follows you to your phone. Assert the
  // mirror, not just the DOM: the reload flushes the pending write on pagehide,
  // and the move back has to have reached the server for real.
  await page.reload()
  await expect.poll(async () => {
    const res = await page.request.get(`http://127.0.0.1:${fixture!.port}/api/ui-prefs`)
    if (!res.ok()) return 'unreachable'
    const body = await res.json() as { prefs?: Record<string, { v: string | null }> }
    const stored = body.prefs?.['open-walnut-app-preferences-v1']?.v
    if (!stored) return 'missing'
    try {
      const parsed = JSON.parse(stored) as { placement?: Record<string, string> }
      return parsed.placement?.['walnut-time:main'] ?? 'missing'
    } catch {
      return 'unparsable'
    }
  }, { timeout: 30_000, intervals: [500, 1_000] }).toBe('settings')

  expect(pageErrors, 'moving a row must not throw in the browser').toEqual([])
})

/*
 * LAST on purpose: it disables the plugin, and the fixture server is shared by the
 * whole file, so nothing may run after it.
 */
test('disabling the plugin takes the Settings row away without a reload', async ({ page }) => {
  await page.goto(`http://127.0.0.1:${fixture!.port}/`)
  await page.waitForLoadState('domcontentloaded')
  await openSettings(page)
  await expect(page.getByTestId('settings-nav-app-walnut-time:main')).toBeVisible({ timeout: 60_000 })

  // No UI affordance disables a linked plugin today, so this is the same call the
  // author CLI and the Plugin Store make. The point is the BROWSER's reaction: the
  // row is owner-scoped, so the plugin:runtime-changed event alone removes it.
  const disabled = await page.request.post(
    `http://127.0.0.1:${fixture!.port}/api/plugin-runtime/walnut-time/disable`,
  )
  expect(disabled.ok(), await disabled.text()).toBe(true)

  await expect(page.getByTestId('settings-nav-app-walnut-time:main')).toHaveCount(0, { timeout: 60_000 })
  await expect(page.getByTestId('settings-nav-agents')).toBeVisible()
  await expect(page.getByTestId('sidebar-app-walnut-time:main')).toHaveCount(0)
  await shoot(page, 'views-app-settings-nav-disabled')

  // One registry, so the plugin's app row forgets it in the same beat as the nav row.
  await page.getByTestId('settings-nav-plugin-store').click()
  await expect(page.getByTestId('plugin-app-row-walnut-time:main')).toHaveCount(0)
})
