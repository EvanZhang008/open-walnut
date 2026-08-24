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
 *      and there IS a Settings → Manage row, which is what the test clicks. The Command
 *      Palette entry survives the move, and disabling the plugin takes the row away.
 *      The declaration is only a DEFAULT: the user can move the row either way from
 *      Settings → Apps, live and durably, and Restore defaults gives it back.
 *   2. Its tabs are real URLs (a reload on /timeline comes back on the timeline, not on
 *      tab one).
 *   3. Attention is SERIAL: no two segments of the tape may overlap vertically. That
 *      is the whole reason these views were rebuilt, so it is asserted, not eyeballed.
 *   4. The three views agree about the day, and agents appear in the swimlanes only.
 */

const SCREENSHOT_DIR = '/tmp/action-cards-time'

interface Fixture {
  port: number
  home: string
  date: string
  taskIds: string[]
  previousDate: string
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

async function shoot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `${SCREENSHOT_DIR}/${name}.png` })
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

/** The app, opened the way a user opens it: Settings → Manage → Time. */
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

/** Walk the day nav back if the fixture had to seed yesterday. */
async function landOnSeededDay(page: Page): Promise<void> {
  if (fixture!.date !== localToday()) await page.getByTestId('time-app-prev').click()
}

/**
 * Same problem one tab over. The reports default to the Today range, but the fixture
 * seeds YESTERDAY whenever the run starts within its span of local midnight
 * (`seedAnchor`, time-app-server.ts) — so between midnight and ~02:40 the report is
 * honestly empty and every assertion below it reads as a rendering bug. Pick the range
 * that actually contains the seeded day instead of trusting the wall clock.
 */
async function landOnSeededRange(page: Page): Promise<void> {
  if (fixture!.date === localToday()) return
  await page.getByTestId('time-app-range-yesterday').click()
}

test.beforeAll(async () => {
  // A hook does NOT inherit the file's test timeout: it gets the config default (30s),
  // and booting a server plus Vite takes longer than that whenever the machine is busy.
  test.setTimeout(240_000)
  await fs.mkdir(SCREENSHOT_DIR, { recursive: true })
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

test('the App declares its own surface: a Settings → Manage row, no Sidebar row', async ({ page }) => {
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

  // And it IS in the Manage group, beside Agents and Skills, as a real link.
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

  // Tab one is the report, and the page is a page: the reports have a filter bar.
  await expect(page.getByTestId('time-app-view-mine')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('time-app-project-filter')).toBeVisible()
  await landOnSeededRange(page)
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

  expect(pageErrors, 'the plugin App must not throw in the browser').toEqual([])
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
  await page.getByTestId('settings-nav-apps').click()

  const managerRow = page.getByTestId('app-manager-row-walnut-time:main')
  await expect(managerRow).toBeVisible({ timeout: 60_000 })
  // Where it starts: what the App declared, plus the two rules that follow from it —
  // the row is labelled as living in Settings, and a settings row is not a pin.
  await expect(managerRow).toHaveAttribute('data-app-placement', 'settings')
  await expect(managerRow).toContainText('row in Settings → Manage')
  await expect(managerRow.getByRole('button', { name: 'Unpin Time' })).toHaveCount(0)
  const move = page.getByTestId('app-manager-placement-walnut-time:main')
  await expect(move).toHaveText('Move to Sidebar')
  await shoot(page, 'apps-manager-placement-control')

  // A Core App is not the user's to move: the registry pins it to the Sidebar, so the
  // control that cannot be honoured is not offered.
  await expect(page.getByTestId('app-manager-placement-core:home')).toHaveCount(0)

  await move.click()

  // Live, with no reload: the declared placement was only a default.
  await expect(managerRow).toHaveAttribute('data-app-placement', 'sidebar')
  await expect(managerRow).not.toContainText('row in Settings → Manage')
  await expect(page.getByTestId('settings-nav-app-walnut-time:main')).toHaveCount(0)
  await expect(page.getByTestId('sidebar-app-walnut-time:main')).toBeVisible({ timeout: 30_000 })
  // Back on the Sidebar, pinning means something again, so the control returns.
  await expect(managerRow.getByRole('button', { name: 'Unpin Time' })).toBeVisible()
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

  // Restore defaults is the way back to following the App's own choice.
  await openSettings(page)
  await page.getByTestId('settings-nav-apps').click()
  await page.getByRole('button', { name: 'Restore defaults' }).click()
  await expect(page.getByTestId('app-manager-row-walnut-time:main'))
    .toHaveAttribute('data-app-placement', 'settings')
  await expect(page.getByTestId('sidebar-app-walnut-time:main')).toHaveCount(0)
  await expect(page.getByTestId('settings-nav-app-walnut-time:main')).toBeVisible({ timeout: 30_000 })

  // An override is NOT browser-local. App preferences ride the ui-prefs mirror
  // (config/share/ui-prefs.json) so a move follows you to your phone — which also
  // means a fresh browser context inherits it, and leaving one set here walked
  // straight into the next test. So assert the mirror, not just the DOM: the reload
  // flushes the pending write on pagehide, and Restore defaults has to have reached
  // the server for real.
  await page.reload()
  await expect.poll(async () => {
    const res = await page.request.get(`http://127.0.0.1:${fixture!.port}/api/ui-prefs`)
    if (!res.ok()) return 'unreachable'
    const body = await res.json() as { prefs?: Record<string, { v: string | null }> }
    const stored = body.prefs?.['open-walnut-app-preferences-v1']?.v
    if (!stored) return 'clear'
    try {
      const parsed = JSON.parse(stored) as { placement?: Record<string, string> }
      return Object.keys(parsed.placement ?? {}).length > 0 ? 'still-overridden' : 'clear'
    } catch {
      return 'unparsable'
    }
  }, { timeout: 30_000, intervals: [500, 1_000] }).toBe('clear')

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

  // One registry, so the App manager forgets it in the same beat as the nav row.
  await page.getByTestId('settings-nav-apps').click()
  await expect(page.getByTestId('app-manager-row-walnut-time:main')).toHaveCount(0)
})
