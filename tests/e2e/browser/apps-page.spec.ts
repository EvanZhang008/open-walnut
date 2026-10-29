import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import net from 'node:net'
import { expect, test, type Page } from '@playwright/test'
import { bunRuntime } from '../../helpers/bun-runtime.js'
import { backToApps, openBuiltinDetail, openPluginDetail } from './apps-store-helpers'

/**
 * The Apps page (/apps): every built-in app, every plugin and its Apps, and where to
 * get or make more, in one place the sidebar points at. It is a store: one card each,
 * and a card opens a detail page that holds the switch.
 *
 * What it pins, through real clicks from the sidebar:
 *
 *   1. The sidebar's Apps entry opens it and is the active entry there, but NOT on a
 *      plugin App's own page (/apps/<plugin>~<app>), which lives under the same prefix.
 *   2. A built-in card's switch (and the same one on its detail page) takes it off the
 *      rail and puts it back: Tasks off removes the sidebar's Tasks entry, a reload keeps
 *      it off, on brings it back. Org is a rail item rather than a registry app, and its
 *      switch works the same way.
 *   3. Home, Apps and Settings can never leave the rail, so their cards and pages show a
 *      lock and no control.
 *   4. The page opens on the plugins, those with a screen first, then those that run in
 *      the background; Built in comes last. A category chip narrows the plugins; the search
 *      box says when nothing matches, and Clear search brings everything back.
 *   5. The old Settings deep link (`/settings#plugin-store`) forwards here.
 *   6. Make your own: Build it waits for a description, and the by-hand route shows the
 *      command that works today (from a clone; the plugin tools are not on npm yet).
 *
 * Runs on the plugin store fixture (tests/e2e/browser/plugin-store-server.ts): it has
 * installed plugins in more than one category and a plugin App (walnut-time), which the
 * shared :3457 fixture keeps out on purpose. Its data is a throwaway copy, so the switch
 * changes here never reach another spec.
 */

interface Fixture { port: number; home: string }

let child: ChildProcessWithoutNullStreams | null = null
let fixture: Fixture | null = null
let output = ''

test.setTimeout(240_000)
test.describe.configure({ mode: 'serial' })
test.use({ viewport: { width: 1280, height: 900 } })

const TIME_APP = 'walnut-time:main'

async function reservePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Could not reserve an apps-page fixture port')
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return address.port
}

test.beforeAll(async ({ browser }) => {
  // A hook does not inherit the file's timeout, and a server plus Vite boots slowly on a busy machine.
  test.setTimeout(420_000)
  const port = await reservePort()
  child = spawn(bunRuntime(), ['tests/e2e/browser/plugin-store-server.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, PW_PLUGIN_STORE_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => { output = `${output}${String(chunk)}`.slice(-20_000) })
  child.stderr.on('data', (chunk) => { output = `${output}${String(chunk)}`.slice(-20_000) })
  fixture = await new Promise<Fixture>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`fixture did not start\n${output.slice(-8000)}`)), 180_000)
    const timer = setInterval(() => {
      const match = /PLUGIN_STORE_READY (\{.*\})/.exec(output)
      if (match) {
        clearInterval(timer)
        clearTimeout(deadline)
        resolve(JSON.parse(match[1]!) as Fixture)
      } else if (child?.exitCode !== null && child?.exitCode !== undefined) {
        clearInterval(timer)
        clearTimeout(deadline)
        reject(new Error(`fixture exited early (${child.exitCode})\n${output.slice(-8000)}`))
      }
    }, 250)
  })
  // A cold Vite compiles the whole SPA on the first visit, which on a busy machine outlasts a
  // per-test budget. Pay it once here, so each test times only what it tests.
  const warm = await browser.newPage()
  await warm.goto(`http://127.0.0.1:${fixture.port}/`)
  await expect(warm.getByTestId('sidebar-core-app-home')).toBeVisible({ timeout: 180_000 })
  await warm.close()
})

test.afterAll(async () => {
  if (!child) return
  child.kill('SIGTERM')
  await new Promise((resolve) => setTimeout(resolve, 2000))
  if (child.exitCode === null) child.kill('SIGKILL')
})

async function home(page: Page): Promise<void> {
  await page.goto(`http://127.0.0.1:${fixture!.port}/`)
  await page.waitForLoadState('domcontentloaded')
  await expect(page.locator('.sidebar')).toBeVisible({ timeout: 60_000 })
  if (await page.locator('.sidebar.collapsed').count()) {
    await page.locator('.sidebar-collapse-btn').click()
    await expect(page.locator('.sidebar.collapsed')).toHaveCount(0)
  }
}

/** The Apps page, the way a user opens it: the sidebar's Apps entry. */
async function openApps(page: Page): Promise<void> {
  await page.getByTestId('sidebar-core-app-apps').click()
  await expect(page).toHaveURL(/\/apps$/)
  await expect(page.getByTestId('apps-page')).toBeVisible({ timeout: 60_000 })
  // The plugin list has answered (its chips and counts come from the registry).
  await expect(page.locator('[data-testid^="plugin-card-"]').first()).toBeVisible({ timeout: 60_000 })
}

test('the sidebar opens Apps, and its entry is active there but not on a plugin App page', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await home(page)
  const appsEntry = page.getByTestId('sidebar-core-app-apps')
  // Apps sits above Settings on the rail.
  const [appsBox, settingsBox] = [await appsEntry.boundingBox(), await page.getByTestId('sidebar-core-app-settings').boundingBox()]
  expect(appsBox!.y).toBeLessThan(settingsBox!.y)
  await expect(appsEntry).not.toHaveClass(/\bactive\b/)

  await openApps(page)
  await expect(appsEntry).toHaveClass(/\bactive\b/)
  await expect(page.getByRole('heading', { level: 1, name: 'Apps' })).toBeVisible()

  // A plugin App's page lives under /apps/ too, and is not the Apps page. The card's
  // Open goes straight there.
  const open = page.getByTestId('plugin-card-open-walnut-time')
  await expect(open).toBeVisible({ timeout: 30_000 })
  await open.click()
  await expect(page).toHaveURL(/\/apps\/walnut-time~main/)
  await expect(page.getByTestId('apps-page')).toHaveCount(0)
  await expect(appsEntry).not.toHaveClass(/\bactive\b/)

  // And back to Apps from the same entry.
  await openApps(page)
  await expect(appsEntry).toHaveClass(/\bactive\b/)

  // The plugin's own page lists its App, with Open, and is still the Apps page.
  await openPluginDetail(page, 'walnut-time')
  await expect(appsEntry).toHaveClass(/\bactive\b/)
  await expect(page.getByTestId(`apps-app-${TIME_APP}`)).toBeVisible({ timeout: 30_000 })
  await page.getByTestId(`apps-app-open-${TIME_APP}`).click()
  await expect(page).toHaveURL(/\/apps\/walnut-time~main/)
  await expect(page.getByTestId('apps-page')).toHaveCount(0)
  await expect(appsEntry).not.toHaveClass(/\bactive\b/)
  expect(pageErrors).toEqual([])
})

test('a built-in card switch takes it off the sidebar, a reload keeps it off, and on brings it back', async ({ page }) => {
  await home(page)
  await openApps(page)
  const tasksCard = page.getByTestId('apps-builtin-tasks')
  const cardSwitch = page.getByTestId('apps-builtin-card-toggle-tasks')
  const tasksSwitch = page.getByTestId('apps-builtin-toggle-tasks')
  const tasksEntry = page.getByTestId('sidebar-core-app-tasks')
  await expect(tasksCard).toHaveAttribute('data-shown', 'true')
  await expect(page.getByTestId('apps-builtin-tasks-status')).toHaveText('On the sidebar')
  await expect(tasksEntry).toBeVisible()
  // The switch is on the card itself; on the sidebar there is no Open (the sidebar opens it).
  await expect(cardSwitch).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('apps-builtin-card-open-tasks')).toHaveCount(0)

  // Off from the card: gone from the sidebar at once, the card stays on the grid (no detail page).
  await cardSwitch.click()
  await expect(cardSwitch).toHaveAttribute('aria-checked', 'false')
  await expect(tasksEntry).toHaveCount(0)
  await expect(page.getByTestId('builtin-detail')).toHaveCount(0)
  await expect(tasksCard).toHaveAttribute('data-shown', 'false')
  await expect(page.getByTestId('apps-builtin-tasks-status')).toHaveText('Only in Apps')
  // Off the sidebar, the card is the way in: it gets Open.
  await expect(page.getByTestId('apps-builtin-card-open-tasks')).toBeVisible()

  // A reload keeps the choice, and the card's detail page agrees.
  await page.reload()
  await expect(page.getByTestId('apps-page')).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId('apps-builtin-tasks')).toHaveAttribute('data-shown', 'false', { timeout: 30_000 })
  await expect(page.getByTestId('sidebar-core-app-apps')).toBeVisible()
  await expect(tasksEntry).toHaveCount(0)

  // On, from its page this time: back on the sidebar, and the card follows.
  await openBuiltinDetail(page, 'tasks')
  await expect(tasksSwitch).toHaveAttribute('aria-checked', 'false')
  await tasksSwitch.click()
  await expect(tasksSwitch).toHaveAttribute('aria-checked', 'true')
  await expect(tasksEntry).toBeVisible({ timeout: 15_000 })
  await backToApps(page)
  await expect(page.getByTestId('apps-builtin-tasks')).toHaveAttribute('data-shown', 'true')
  await expect(cardSwitch).toHaveAttribute('aria-checked', 'true')

  // Org is a rail item, not a registry app; its card switch does the same, twice over.
  const orgEntry = page.getByTestId('sidebar-org')
  const orgSwitch = page.getByTestId('apps-builtin-card-toggle-org')
  await expect(orgEntry).toBeVisible()
  for (let round = 0; round < 2; round += 1) {
    await orgSwitch.click()
    await expect(orgEntry).toHaveCount(0)
    await expect(page.getByTestId('apps-builtin-org')).toHaveAttribute('data-shown', 'false')
    await orgSwitch.click()
    await expect(orgEntry).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('apps-builtin-org')).toHaveAttribute('data-shown', 'true')
  }
})

test('Home, Apps and Settings always stay on the sidebar: a lock, never a switch', async ({ page }) => {
  await home(page)
  await openApps(page)
  for (const id of ['home', 'apps', 'settings']) {
    const card = page.getByTestId(`apps-builtin-${id}`)
    await expect(card, id).toBeVisible()
    await expect(card, id).toHaveAttribute('data-shown', 'true')
    await expect(page.getByTestId(`apps-builtin-${id}-status`), id).toHaveText('Always on the sidebar')
    await expect(card.locator('.apps-card-lock'), id).toHaveCount(1)
    // Nothing on the card that looks pressable: no switch, no Open.
    await expect(card.locator('[role="switch"]'), id).toHaveCount(0)
    await expect(card.locator('.apps-card-open'), id).toHaveCount(0)
    await openBuiltinDetail(page, id)
    const detail = page.getByTestId('builtin-detail')
    await expect(page.getByTestId(`apps-builtin-toggle-${id}`), id).toHaveCount(0)
    await expect(detail.locator('[role="switch"]'), id).toHaveCount(0)
    await expect(detail.getByRole('img', { name: /always stays on the sidebar/ }), id).toBeVisible()
    await backToApps(page)
  }
  // Every other built-in has one on its card and one on its page.
  for (const id of ['tasks', 'routines', 'notes', 'org']) {
    await expect(page.getByTestId(`apps-builtin-${id}`).locator('[role="switch"]'), id).toHaveCount(1)
    await expect(page.getByTestId(`apps-builtin-card-toggle-${id}`), id).toHaveAttribute('aria-label', /^Show .+ on the sidebar$/)
    await openBuiltinDetail(page, id)
    await expect(page.getByTestId(`apps-builtin-toggle-${id}`), id).toHaveCount(1)
    await backToApps(page)
  }
})

test('the page opens on the plugins: with a screen, then in the background, and Built in last', async ({ page }) => {
  await home(page)
  await openApps(page)
  const ui = page.getByTestId('apps-kind-ui')
  const background = page.getByTestId('apps-kind-background')
  await expect(ui).toBeVisible({ timeout: 30_000 })
  await expect(background).toBeVisible()
  // A plugin with a web entry has a screen; one with none runs in the background.
  for (const id of ['walnut-time', 'sigma']) await expect(ui.getByTestId(`plugin-card-${id}`), id).toBeVisible()
  // tau's web entry fails to load, so no App of it is ever registered: only the server's
  // word (its manifest declares a web entry) puts it here.
  await expect(ui.getByTestId('plugin-card-tau')).toBeVisible()
  await expect(page.getByTestId('plugin-card-open-tau')).toHaveCount(0)
  for (const id of ['alpha', 'kappa']) await expect(background.getByTestId(`plugin-card-${id}`), id).toBeVisible()
  await expect(ui.getByTestId('plugin-card-alpha')).toHaveCount(0)
  await expect(background.getByTestId('plugin-card-walnut-time')).toHaveCount(0)
  // In document order: screen, background, Get more, Make your own, then Built in.
  const order = await page.evaluate(() => Array.from(document.querySelectorAll('[data-testid="apps-page"] .apps-section'))
    .map((el) => el.getAttribute('data-testid')))
  expect(order).toEqual(['apps-kind-ui', 'apps-kind-background', 'apps-get-more', 'apps-make', 'apps-builtin'])
  // Chips read All, the plugin groups, Get more, then Built in.
  const chips = await page.locator('.apps-chips button').evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')))
  expect(chips[0]).toBe('apps-chip-all')
  expect(chips.slice(-2)).toEqual(['apps-chip-get', 'apps-chip-builtin'])

  // Turning a plugin with a screen off keeps its card in that group (it reads Off there).
  await openPluginDetail(page, 'sigma')
  const sigmaSwitch = page.locator('#plugin-toggle-sigma')
  await sigmaSwitch.click()
  await expect(page.getByTestId('plugin-row-sigma')).toHaveAttribute('data-plugin-status', 'disabled', { timeout: 30_000 })
  await backToApps(page)
  // Its App is gone (no Open), so the group comes from the server, not from a live App.
  await expect(page.getByTestId('plugin-card-open-sigma')).toHaveCount(0, { timeout: 30_000 })
  await expect(ui.getByTestId('plugin-card-sigma')).toBeVisible()
  await expect(page.getByTestId('plugin-card-sigma-status')).toHaveText('Off')
  await openPluginDetail(page, 'sigma')
  await sigmaSwitch.click()
  await expect(page.getByTestId('plugin-row-sigma')).not.toHaveAttribute('data-plugin-status', 'disabled', { timeout: 30_000 })
  await backToApps(page)
  await expect(ui.getByTestId('plugin-card-sigma')).toBeVisible()
})

test('a category chip narrows the plugins; a search with no match says so and Clear restores', async ({ page }) => {
  await home(page)
  await openApps(page)
  const kinds = page.locator('[data-testid^="apps-kind-"]')
  const cards = page.locator('[data-testid^="apps-kind-"] .apps-card')
  await expect.poll(() => cards.count(), { timeout: 30_000 }).toBeGreaterThan(1)
  const total = await cards.count()
  // The fixture's plugins fall into more than one category, so narrowing is visible.
  const categoryChips = page.locator('.apps-chips button:not([data-testid="apps-chip-all"]):not([data-testid="apps-chip-builtin"]):not([data-testid="apps-chip-get"])')
  await expect.poll(() => categoryChips.count()).toBeGreaterThan(1)

  const chip = categoryChips.last()
  await chip.click()
  await expect(chip).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => cards.count()).toBeGreaterThan(0)
  expect(await cards.count()).toBeLessThan(total)
  await expect(page.getByTestId('apps-builtin')).toHaveCount(0)
  await expect(page.getByTestId('apps-get-more')).toHaveCount(0)
  await expect(page.getByTestId('apps-make')).toHaveCount(0)

  // Built in shows only the built-ins; All brings everything back.
  await page.getByTestId('apps-chip-builtin').click()
  await expect(page.getByTestId('apps-builtin')).toBeVisible()
  await expect(kinds).toHaveCount(0)
  await page.getByTestId('apps-chip-all').click()
  await expect(page.getByTestId('apps-chip-all')).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => cards.count()).toBe(total)
  await expect(page.getByTestId('apps-get-more')).toBeVisible()

  // Search: nothing matches, the page says so with a way back.
  const search = page.getByTestId('apps-search')
  await search.fill('zzq-no-such-app-anywhere')
  const empty = page.getByTestId('apps-no-match')
  await expect(empty).toBeVisible()
  await expect(empty).toContainText('Nothing matches')
  await expect(page.getByTestId('apps-builtin')).toHaveCount(0)
  await expect(kinds).toHaveCount(0)
  await empty.getByRole('button', { name: 'Clear search' }).click()
  await expect(search).toHaveValue('')
  await expect(empty).toHaveCount(0)
  await expect(page.getByTestId('apps-builtin')).toBeVisible()
  await expect.poll(() => cards.count()).toBe(total)
  await expect(page.getByTestId('apps-make')).toBeVisible()
})

test('Make your own: Build it waits for a description, and the by-hand command runs from a clone', async ({ page }) => {
  await home(page)
  await openApps(page)
  const card = page.getByTestId('apps-make-card')
  await card.scrollIntoViewIfNeeded()
  await expect(card).toBeVisible()
  const request = card.getByTestId('build-plugin-request')
  const start = card.getByTestId('build-plugin-start')
  await expect(request).toHaveValue('')
  await expect(start).toBeDisabled()
  await request.fill('   ')
  await expect(start).toBeDisabled()
  await request.fill('a weekly review page')
  await expect(start).toBeEnabled()
  await request.fill('')
  await expect(start).toBeDisabled()

  // The by-hand route is folded away until asked for.
  const manual = page.getByTestId('apps-make-manual')
  const command = page.getByTestId('apps-make-command')
  await expect(command).not.toBeVisible()
  await manual.locator('summary').click()
  await expect(command).toBeVisible()
  await expect(command).toContainText('bun packages/plugin-cli/dist/cli.js new my-plugin')
  await expect(command).not.toContainText('npx @open-walnut')
  await expect(page.getByTestId('build-plugin-guide')).toBeVisible()
})

test('the old Settings deep link to Plugins forwards to the Apps page', async ({ page }) => {
  // A cold deep link IS the thing under test (a notification, a bookmark, an old install link).
  await page.goto(`http://127.0.0.1:${fixture!.port}/settings#plugin-store`)
  await expect(page).toHaveURL(new RegExp(`^http://127\\.0\\.0\\.1:${fixture!.port}/apps$`), { timeout: 60_000 })
  await expect(page.getByTestId('apps-page')).toBeVisible({ timeout: 60_000 })
  await expect(page.locator('#plugin-store')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('sidebar-core-app-apps')).toHaveClass(/\bactive\b/)

  // Settings' Plugins group still leads here, as a link labelled Apps.
  await page.getByTestId('sidebar-core-app-settings').click()
  const link = page.getByTestId('settings-nav-plugin-store')
  await expect(link).toBeVisible({ timeout: 30_000 })
  await expect(link).toContainText('Apps')
  await link.click()
  await expect(page).toHaveURL(/\/apps$/)
  await expect(page.getByTestId('apps-page')).toBeVisible({ timeout: 30_000 })
})
