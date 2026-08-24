import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs/promises'
import net from 'node:net'
import { expect, test, type Page } from '@playwright/test'

/**
 * The Time plugin App — the same three day views as the console's Time Tracking
 * section, but shipped as a first-party plugin and given a whole page.
 *
 * Everything here runs against the fixture's OWN server
 * (tests/e2e/browser/time-app-server.ts), because the shared :3457 fixture installs
 * no plugins on purpose. That fixture links the example plugin into a throwaway data
 * home and seeds one dense day, so this spec exercises the real install path: the
 * host discovers the plugin, serves its web module, and the Sidebar grows a real
 * entry the test clicks.
 *
 * What it pins, beyond "it renders":
 *
 *   1. The App is reached by CLICKING the Sidebar entry, and its tabs are real URLs
 *      (a reload on /timeline comes back on the timeline, not on tab one).
 *   2. Attention is SERIAL: no two segments of the tape may overlap vertically. That
 *      is the whole reason these views were rebuilt, so it is asserted, not eyeballed.
 *   3. The three views agree about the day, and agents appear in the swimlanes only.
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

/** The app, opened the way a user opens it. */
async function openTimeApp(page: Page): Promise<void> {
  await page.goto(`http://127.0.0.1:${fixture!.port}/`)
  await page.waitForLoadState('domcontentloaded')
  await expandSidebar(page)
  await page.getByTestId('sidebar-app-walnut-time:main').click()
  await expect(page).toHaveURL(/\/apps\/walnut-time~main/)
  await expect(page.getByTestId('time-app')).toBeVisible({ timeout: 60_000 })
}

/** Walk the day nav back if the fixture had to seed yesterday. */
async function landOnSeededDay(page: Page): Promise<void> {
  const today = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const local = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`
  if (fixture!.date !== local) await page.getByTestId('time-app-prev').click()
}

test.beforeAll(async () => {
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

test('the plugin App is in the Sidebar and its tabs are real URLs', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  await openTimeApp(page)

  // Tab one is the report, and the page is a page: the reports have a filter bar.
  await expect(page.getByTestId('time-app-view-mine')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('time-app-project-filter')).toBeVisible()
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

  // The view choice is remembered across a reload, like the console's copy.
  await page.reload()
  await expect(page.getByTestId('time-app-lanes')).toBeVisible({ timeout: 60_000 })

  expect(pageErrors, 'the plugin App must not throw in the browser').toEqual([])
})
