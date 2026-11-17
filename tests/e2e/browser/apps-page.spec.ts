import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import net from 'node:net'
import { expect, test, type Page } from '@playwright/test'
import { bunRuntime } from '../../helpers/bun-runtime.js'
import { backToApps, openApp, openBuiltinDetail, openPluginDetail } from './apps-store-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'

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
 *   5. The old Settings deep link (`/settings#plugin-store`) forwards here, and Settings has
 *      no Plugins group and no Apps link.
 *   5b. A plugin's own settings panels (`walnut.ui.settings`) are on its page here, under
 *      Settings, never in Settings; an old `/settings#<plugin>:<panel>` link opens that
 *      panel here, even when the panel registers after the page opened.
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

/**
 * Waits until the fixture server holds the page's own Apps preferences. The page mirrors them
 * to ui-prefs after an 800 ms debounce (ui-prefs-sync.ts), and a test that ends on a switch
 * click closes its page before that write leaves: the next test's page then boots from the
 * older value (here, Tasks still off the sidebar). A test that ends on a preference change
 * calls this last.
 */
async function serverHoldsAppPreferences(page: Page): Promise<void> {
  const key = 'open-walnut-app-preferences-v1'
  await expect.poll(async () => {
    const local = await page.evaluate((k) => localStorage.getItem(k), key)
    const res = await page.request.get(`http://127.0.0.1:${fixture!.port}/api/ui-prefs`)
    const body = await res.json() as { prefs?: Record<string, { v?: string | null }> }
    return body.prefs?.[key]?.v === local
  }, { timeout: 15_000 }).toBe(true)
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
  // The next tests start from Tasks and Org on the sidebar, so the last switch must reach the server.
  await serverHoldsAppPreferences(page)
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

test('the page groups plugins by where they come from: built in, each source, this computer; built-in apps last', async ({ page }) => {
  await home(page)
  await openApps(page)
  const builtin = page.getByTestId('apps-source-builtin')
  await expect(builtin).toBeVisible({ timeout: 30_000 })
  await expect(builtin.locator('.apps-section-title')).toContainText('Built-in plugins')
  // A plugin that ships with Walnut is in Built-in plugins, and nothing else is: walnut-time is
  // linked from a folder (the author way), so it is on this computer.
  expect(await builtin.locator('.apps-card').count()).toBeGreaterThan(0)
  await expect(page.getByTestId('apps-source-local').getByTestId('plugin-card-walnut-time')).toBeVisible()
  await expect(builtin.getByTestId('plugin-card-walnut-time')).toHaveCount(0)
  for (const id of ['sigma', 'tau', 'alpha', 'kappa']) {
    await expect(page.getByTestId(`plugin-card-${id}`), id).toBeVisible()
    await expect(builtin.getByTestId(`plugin-card-${id}`), id).toHaveCount(0)
  }
  // Every card carries its icon tile.
  const cards = page.locator('[data-testid^="apps-source-"] .apps-card')
  expect(await cards.count()).toBeGreaterThan(3)
  expect(await page.locator('[data-testid^="apps-source-"] .apps-card .plugin-icon').count()).toBe(await cards.count())
  // In document order: built in, the sources and this computer, Get more, Make your own, then the built-in apps.
  const order = await page.evaluate(() => Array.from(document.querySelectorAll('[data-testid="apps-page"] .apps-section'))
    .map((el) => el.getAttribute('data-testid') ?? ''))
  expect(order[0]).toBe('apps-source-builtin')
  expect(order.slice(-3)).toEqual(['apps-get-more', 'apps-make', 'apps-builtin'])
  for (const id of order.slice(1, -3)) expect(id).toMatch(/^apps-source-/)
  // The separate Sources list is gone: a source's verbs live on its own section's head.
  await expect(page.getByTestId('plugin-store-sources')).toHaveCount(0)
  // Chips read All, the plugin categories, Get more, then the built-in apps.
  const chips = await page.locator('.apps-chips button').evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')))
  expect(chips[0]).toBe('apps-chip-all')
  expect(chips.slice(-2)).toEqual(['apps-chip-get', 'apps-chip-builtin'])

  // Turning a plugin off keeps its card where it was (it reads Off there).
  const sigmaSection = page.locator('[data-testid^="apps-source-"]', { has: page.getByTestId('plugin-card-sigma') })
  const sigmaSectionId = await sigmaSection.getAttribute('data-testid')
  await openPluginDetail(page, 'sigma')
  const sigmaSwitch = page.locator('#plugin-toggle-sigma')
  await sigmaSwitch.click()
  await expect(page.getByTestId('plugin-row-sigma')).toHaveAttribute('data-plugin-status', 'disabled', { timeout: 30_000 })
  await backToApps(page)
  await expect(page.getByTestId('plugin-card-open-sigma')).toHaveCount(0, { timeout: 30_000 })
  await expect(page.getByTestId(sigmaSectionId!).getByTestId('plugin-card-sigma')).toBeVisible()
  await expect(page.getByTestId('plugin-card-sigma-status')).toHaveText('Off')
  await openPluginDetail(page, 'sigma')
  await sigmaSwitch.click()
  await expect(page.getByTestId('plugin-row-sigma')).not.toHaveAttribute('data-plugin-status', 'disabled', { timeout: 30_000 })
  await backToApps(page)
  await expect(page.getByTestId(sigmaSectionId!).getByTestId('plugin-card-sigma')).toBeVisible()
})

test('a category chip narrows the plugins and stays picked; a search with no match says so and Clear restores', async ({ page }) => {
  // The chip it keeps stays in this page's storage, never on the shared server's prefs.
  await isolateUiPrefs(page)
  await home(page)
  await openApps(page)
  const kinds = page.locator('[data-testid^="apps-source-"]')
  const cards = page.locator('[data-testid^="apps-source-"] .apps-card')
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
  // The chip stays picked: another page and back, then a reload (utils/view-memory.ts).
  await page.getByTestId('sidebar-core-app-settings').click()
  await expect(page.getByTestId('apps-page')).toHaveCount(0)
  await page.getByTestId('sidebar-core-app-apps').click()
  await expect(page.getByTestId('apps-builtin')).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId('apps-chip-builtin')).toHaveAttribute('aria-pressed', 'true')
  await page.reload()
  await expect(page.getByTestId('apps-chip-builtin')).toHaveAttribute('aria-pressed', 'true', { timeout: 30_000 })
  await expect(page.getByTestId('apps-builtin')).toBeVisible()
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

  // Settings has no Plugins group and no Apps link: Apps is its own sidebar entry.
  await page.getByTestId('sidebar-core-app-settings').click()
  await expect(page.getByTestId('settings-nav-general')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('settings-nav-plugin-store')).toHaveCount(0)
  await expect(page.locator('.settings-nav-group[data-group="plugins"]')).toHaveCount(0)
  await expect(page.locator('.settings-nav a[href^="/apps"]')).toHaveCount(0)
  await page.getByTestId('sidebar-core-app-apps').click()
  await expect(page).toHaveURL(/\/apps$/)
  await expect(page.getByTestId('apps-page')).toBeVisible({ timeout: 30_000 })
})

type PanelHooks = { pluginUiRegistry: { registerSettings: (id: string, name: string, v: { id: string; label: string; component: unknown }) => { dispose(): void } } }
type PanelWindow = Window & { __walnutSettingsTestHooks?: PanelHooks; __panelDisposers?: Array<{ dispose(): void }> }

/** Two panels for walnut-time, as a plugin's web part registers them (dev-only hook). */
async function registerTimePanels(page: Page): Promise<void> {
  await page.waitForFunction(() => !!(window as PanelWindow).__walnutSettingsTestHooks, undefined, { timeout: 60_000 })
  await page.evaluate(() => {
    const w = window as PanelWindow
    const text = (label: string) => () => label
    const hooks = w.__walnutSettingsTestHooks!.pluginUiRegistry
    w.__panelDisposers = [
      hooks.registerSettings('walnut-time', 'Time', { id: 'account', label: 'Account', component: text('Signed in as fixture@example.invalid') }),
      hooks.registerSettings('walnut-time', 'Time', { id: 'tracking', label: 'Tracking', component: text('Tracks the focused window') }),
    ]
  })
}

test("a plugin's settings panels are on its page in Apps, and an old Settings link opens them there", async ({ page }) => {
  await home(page)
  await openApps(page)
  await openPluginDetail(page, 'walnut-time')
  await registerTimePanels(page)
  const group = page.getByTestId('plugin-settings-walnut-time')
  await expect(group).toBeVisible()
  await expect(group.getByTestId('plugin-panel-walnut-time:account')).toContainText('Signed in as fixture@example.invalid')
  // Two panels: each one wears its own label.
  await expect(group.locator('.plugin-settings-panel-title')).toHaveText(['Account', 'Tracking'])

  // Settings has no row for either panel.
  await page.getByTestId('sidebar-core-app-settings').click()
  await expect(page.getByTestId('settings-nav-general')).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('[data-testid^="settings-nav-walnut-time"]')).toHaveCount(0)
  await expect(page.locator('.settings-nav-group[data-group="plugins"]')).toHaveCount(0)

  // An old bookmark to one panel: the page opens on the plugin, and the panel, registered
  // only after the page loaded (a plugin's web part starts late), is scrolled to and flashed.
  // A fresh document (a bookmark opened cold), not a hash change on the open Settings page.
  await page.goto('about:blank')
  await page.goto(`http://127.0.0.1:${fixture!.port}/settings#walnut-time:tracking`)
  await expect(page).toHaveURL(/\/apps\?plugin=walnut-time&panel=tracking$/, { timeout: 60_000 })
  await expect(page.getByTestId('plugin-detail')).toHaveAttribute('data-plugin-id', 'walnut-time', { timeout: 60_000 })
  await registerTimePanels(page)
  const tracking = page.getByTestId('plugin-panel-walnut-time:tracking')
  await expect(tracking).toHaveClass(/settings-anchor-flash-strong/, { timeout: 10_000 })
  await expect(tracking).toBeInViewport()
  await expect(page.getByTestId('sidebar-core-app-apps')).toHaveClass(/\bactive\b/)
})

test("a plugin panel that throws stays inside its own box; the rest of the plugin's page works", async ({ page }) => {
  await home(page)
  await openApps(page)
  await openPluginDetail(page, 'walnut-time')
  await page.waitForFunction(() => !!(window as PanelWindow).__walnutSettingsTestHooks, undefined, { timeout: 60_000 })
  await page.evaluate(() => {
    const w = window as PanelWindow
    const boom = () => { throw new Error('fixture panel crash') }
    w.__panelDisposers = [w.__walnutSettingsTestHooks!.pluginUiRegistry.registerSettings('walnut-time', 'Time', { id: 'broken', label: 'Broken', component: boom })]
  })
  const panel = page.getByTestId('plugin-panel-walnut-time:broken')
  await expect(panel.locator('.plugin-error-boundary')).toContainText('Time failed to render')
  await expect(page.getByTestId('plugin-about-walnut-time')).toBeVisible()
  await expect(page.getByTestId('plugin-row-walnut-time')).toBeVisible()
  await page.evaluate(() => (window as PanelWindow).__panelDisposers?.forEach((d) => d.dispose()))
  await expect(panel).toHaveCount(0)
})

/**
 * Experiment apps_stay_open (src/core/experimental.ts, off by default). With it on, an App
 * opened from any way in keeps a row under the Sidebar's Open group until the person closes
 * it; leaving for another page never closes it. The Apps page leads with Pinned and Recently
 * used, a closed App stays recent, and a reload keeps all three. With it off the rail and the
 * page are what they were, and the stored state is still there when it is turned on again.
 * The Time App declares `placement: 'settings'`, so it has no Sidebar row of its own.
 */
async function setAppsStayOpen(page: Page, on: boolean): Promise<void> {
  const res = await page.request.put(`http://127.0.0.1:${fixture!.port}/api/config`, { data: { experimental: { apps_stay_open: on } } })
  expect(res.ok()).toBe(true)
}

test('an opened App stays on the Sidebar until closed, and the Apps page finds it again', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await setAppsStayOpen(page, true)
  try {
    await home(page)
    const openGroup = page.getByTestId('sidebar-open-apps')
    const openRow = page.getByTestId(`sidebar-open-app-${TIME_APP}`)
    const openLink = openRow.getByTestId(`sidebar-app-${TIME_APP}`)
    const recentTile = page.getByTestId(`apps-quick-recent-${TIME_APP}`)
    const pinnedTile = page.getByTestId(`apps-quick-pinned-${TIME_APP}`)
    const appsEntry = page.getByTestId('sidebar-core-app-apps')
    await expect(openGroup).toHaveCount(0)

    // Opened from its card: a row under Open, the active one.
    await openApps(page)
    await expect(page.getByTestId('apps-recent')).toHaveCount(0)
    await page.getByTestId('plugin-card-open-walnut-time').click()
    await expect(page).toHaveURL(/\/apps\/walnut-time~main/)
    await expect(openLink).toHaveClass(/\bactive\b/)
    await expect(appsEntry).not.toHaveClass(/\bactive\b/)

    // Going elsewhere never closes it.
    await page.getByTestId('sidebar-core-app-home').click()
    await expect(openRow).toBeVisible()
    await expect(openLink).not.toHaveClass(/\bactive\b/)
    await page.getByTestId('sidebar-core-app-settings').click()
    await expect(openRow).toBeVisible()
    // On the Apps page the Apps entry is the active one (longest path match), and the App is recent.
    await openApps(page)
    await expect(appsEntry).toHaveClass(/\bactive\b/)
    await expect(openLink).not.toHaveClass(/\bactive\b/)
    await expect(recentTile).toBeVisible()

    // A reload keeps the row. Pin moves the tile to Pinned, and a reload keeps that too.
    await page.reload()
    await expect(openRow).toBeVisible({ timeout: 60_000 })
    await page.getByTestId(`apps-quick-pin-${TIME_APP}`).click()
    await expect(pinnedTile).toBeVisible()
    await expect(recentTile).toHaveCount(0)
    await page.reload()
    await expect(pinnedTile).toBeVisible({ timeout: 60_000 })

    // Closing the App on screen takes its row away and leaves for the Apps page, where it is still pinned.
    await openLink.click()
    await expect(page).toHaveURL(/\/apps\/walnut-time~main/)
    await openRow.hover()
    await page.getByTestId(`sidebar-open-app-close-${TIME_APP}`).click()
    await expect(openRow).toHaveCount(0)
    await expect(page).toHaveURL(/\/apps$/)
    await expect(pinnedTile).toBeVisible()
    await page.reload()
    await expect(page.getByTestId('apps-page')).toBeVisible({ timeout: 60_000 })
    await expect(openGroup).toHaveCount(0)

    // Opened again from Pinned: the row is back. Unpinned, it is under Recently used.
    await pinnedTile.getByRole('button', { name: 'Open Time' }).click()
    await expect(page).toHaveURL(/\/apps\/walnut-time~main/)
    await expect(openRow).toBeVisible()
    await openApps(page)
    await page.getByTestId(`apps-quick-pin-${TIME_APP}`).click()
    await expect(pinnedTile).toHaveCount(0)
    await expect(recentTile).toBeVisible()

    // The row's menu closes it too, from another page: the page stays where it is.
    await page.getByTestId('sidebar-core-app-home').click()
    await openLink.click({ button: 'right' })
    const menu = page.getByTestId('sidebar-app-ctx-menu')
    await expect(menu.getByRole('menuitem', { name: 'Keep on sidebar' })).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: 'Move up' })).toHaveCount(0)
    await menu.getByRole('menuitem', { name: 'Close' }).click()
    await expect(openRow).toHaveCount(0)
    await expect(page).toHaveURL(/\/$/)

    // Off: the rail and the page are as before; on again, what was stored is back.
    await page.getByTestId('sidebar-core-app-apps').click()
    await page.getByTestId('plugin-card-open-walnut-time').click()
    await expect(openRow).toBeVisible()
    await setAppsStayOpen(page, false)
    await page.reload()
    await expect(page.locator('.sidebar')).toBeVisible({ timeout: 60_000 })
    await expect(page.getByTestId('app-host-native')).toBeVisible({ timeout: 60_000 })
    await expect(openGroup).toHaveCount(0)
    await openApps(page)
    await expect(page.getByTestId('apps-recent')).toHaveCount(0)
    await expect(page.getByTestId('apps-pinned')).toHaveCount(0)
    await expect(page.getByTestId('sidebar-core-app-tasks')).toBeVisible()
    await setAppsStayOpen(page, true)
    await page.reload()
    await expect(openRow).toBeVisible({ timeout: 60_000 })
    await expect(recentTile).toBeVisible()
    expect(pageErrors).toEqual([])
  } finally {
    await setAppsStayOpen(page, false)
  }
})

/**
 * The system rule for every app (web/src/apps/preferences.ts resolveAppActivity): one the person
 * opened keeps a Sidebar row after they leave it, a hidden one too, since hidden only keeps an
 * App out of what Walnut offers unasked. The person's own Hide closes it at once. Then EVERY App
 * the fixture has installed is opened from its card and left for Home; one with no row fails.
 */
test('every App the person opened keeps a Sidebar row after they leave it, a hidden one too', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  // The Hide below is written to this tab only, never to the fixture's prefs another spec reads.
  await isolateUiPrefs(page)
  await setAppsStayOpen(page, true)
  try {
    await home(page)
    const openRow = page.getByTestId(`sidebar-open-app-${TIME_APP}`)
    const menu = page.getByTestId('sidebar-app-ctx-menu')

    // Kept on the Sidebar, then the person hides it from its own row while on it: gone at once.
    await openApps(page)
    await page.getByTestId('plugin-card-open-walnut-time').click()
    await expect(openRow).toBeVisible()
    await openRow.getByTestId(`sidebar-app-${TIME_APP}`).click({ button: 'right' })
    await menu.getByRole('menuitem', { name: 'Keep on sidebar' }).click()
    const ownRow = page.locator(`.sidebar-nav > [data-testid="sidebar-app-${TIME_APP}"]`)
    await expect(ownRow).toBeVisible()
    await ownRow.click({ button: 'right' })
    await menu.getByRole('menuitem', { name: 'Hide app' }).click()
    await expect(page.getByTestId(`sidebar-app-${TIME_APP}`)).toHaveCount(0)
    await expect(page).toHaveURL(/\/apps$/)
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('open-walnut-app-preferences-v1') ?? '{}'))
    expect(stored.hidden).toContain(TIME_APP)

    // Hidden, and opened again by the person: it keeps an Open row after they go Home.
    expect(await openApp(page, page.getByTestId('plugin-card-open-walnut-time'))).toBe('/apps/walnut-time~main')
    await page.getByTestId('sidebar-core-app-home').click()
    await expect(openRow).toBeVisible()
    await page.reload()
    await expect(openRow).toBeVisible({ timeout: 60_000 })

    // Every installed App with a screen, whatever it declared or the person chose before.
    await openApps(page)
    const cards = await page.locator('[data-testid^="plugin-card-open-"]').evaluateAll(
      (nodes) => nodes.map((node) => node.getAttribute('data-testid')!),
    )
    expect(cards.length).toBeGreaterThan(0)
    for (const card of cards) {
      await openApps(page)
      const appPath = await openApp(page, page.getByTestId(card))
      await page.getByTestId('sidebar-core-app-home').click()
      await expect(page).toHaveURL(/\/$/)
      // Its row links to the app's root or a place inside it, never to another app's page.
      const row = page.locator(`.sidebar-nav a[href="${appPath}"], .sidebar-nav a[href^="${appPath}/"], .sidebar-nav a[href^="${appPath}?"]`)
      await expect(row, `${card} keeps a Sidebar row`).toHaveCount(1)
    }
    expect(pageErrors).toEqual([])
  } finally {
    await setAppsStayOpen(page, false)
  }
})

/**
 * While open apps stay on the Sidebar, only the person pins an App: Rho asks for a Sidebar
 * row (`placement: 'sidebar'`, plugin-store-server.ts) and still has none until its switch is
 * turned on. Every installed App is checked: none sits in the pinned rows above the Open
 * group by itself, and each one opened lands under Open. With the experiment off, Rho's own
 * request gives it its row as before.
 */
test('no installed App is pinned on the Sidebar until the person pins it', async ({ page }) => {
  const RHO = 'rho:main'
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await isolateUiPrefs(page)
  await setAppsStayOpen(page, true)
  // The rows above the Open group: what is pinned there.
  const pinnedPluginRows = page.locator('.sidebar-nav > a[data-app-kind="native"], .sidebar-nav > a[data-app-kind="webview"]')
  try {
    await home(page)
    await expect(page.getByTestId('sidebar-core-app-home')).toBeVisible()
    await expect(pinnedPluginRows).toHaveCount(0)

    // Every installed App, opened and left: under Open, never pinned.
    await openApps(page)
    const cards = await page.locator('[data-testid^="plugin-card-open-"]').evaluateAll(
      (nodes) => nodes.map((node) => node.getAttribute('data-testid')!),
    )
    expect(cards).toContain('plugin-card-open-rho')
    for (const card of cards) {
      await openApps(page)
      await openApp(page, page.getByTestId(card))
      await page.getByTestId('sidebar-core-app-home').click()
      await expect(page).toHaveURL(/\/$/)
      await expect(pinnedPluginRows, `${card} is not pinned by opening it`).toHaveCount(0)
    }
    await expect(page.getByTestId(`sidebar-open-app-${RHO}`)).toBeVisible()

    // The person pins Rho with its switch: now it is pinned, and out of Open.
    await openApps(page)
    await openPluginDetail(page, 'rho')
    const toggle = page.getByTestId(`apps-app-toggle-${RHO}`)
    await expect(page.getByTestId(`apps-app-${RHO}`)).toHaveAttribute('data-shown', 'false')
    await toggle.click()
    await expect(page.getByTestId(`apps-app-${RHO}`)).toHaveAttribute('data-shown', 'true')
    await expect(page.locator(`.sidebar-nav > [data-testid="sidebar-app-${RHO}"]`)).toBeVisible()
    await expect(page.getByTestId(`sidebar-open-app-${RHO}`)).toHaveCount(0)
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('open-walnut-app-preferences-v1') ?? '{}'))
    expect(stored.placement[RHO]).toBe('sidebar')
    // Off again by the person: unpinned.
    await toggle.click()
    await expect(page.locator(`.sidebar-nav > [data-testid="sidebar-app-${RHO}"]`)).toHaveCount(0)

    // Experiment off: Rho's own request gives it its row, as before.
    await page.evaluate(() => localStorage.removeItem('open-walnut-app-preferences-v1'))
    await setAppsStayOpen(page, false)
    await page.reload()
    await expect(page.locator(`.sidebar-nav > [data-testid="sidebar-app-${RHO}"]`)).toBeVisible({ timeout: 60_000 })
    expect(pageErrors).toEqual([])
  } finally {
    await setAppsStayOpen(page, false)
  }
})

test('a corrupt or stale open-apps record never breaks the rail or the Apps page', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await setAppsStayOpen(page, true)
  try {
    // An App that is gone, a locked one and junk: none draws a row or a tile.
    await page.addInitScript(() => {
      if (sessionStorage.getItem('seeded-activity')) return
      sessionStorage.setItem('seeded-activity', '1')
      localStorage.setItem('walnut:app-activity-v1', JSON.stringify({ version: 1, open: ['gone:app', 'core:home', 7], recent: ['gone:app', 'core:settings'] }))
      localStorage.setItem('walnut:app-pins-v1', JSON.stringify({ version: 1, pinned: 'nope' }))
    })
    await home(page)
    await expect(page.getByTestId('sidebar-core-app-home')).toBeVisible()
    await expect(page.getByTestId('sidebar-open-apps')).toHaveCount(0)
    await openApps(page)
    await expect(page.getByTestId('apps-recent')).toHaveCount(0)
    await expect(page.getByTestId('apps-pinned')).toHaveCount(0)
    // A record that is not JSON at all reads as empty, and opening an App still works.
    await page.evaluate(() => localStorage.setItem('walnut:app-activity-v1', '{not json'))
    await page.reload()
    await expect(page.getByTestId('apps-page')).toBeVisible({ timeout: 60_000 })
    await page.getByTestId('plugin-card-open-walnut-time').click()
    await expect(page.getByTestId(`sidebar-open-app-${TIME_APP}`)).toBeVisible()
    expect(pageErrors).toEqual([])
  } finally {
    await setAppsStayOpen(page, false)
  }
})

test('an App can be pinned on the Apps page from its plugin page before it was ever opened', async ({ page }) => {
  await setAppsStayOpen(page, true)
  try {
    await home(page)
    await openApps(page)
    await expect(page.getByTestId('apps-pinned')).toHaveCount(0)
    await openPluginDetail(page, 'walnut-time')
    const pin = page.getByTestId(`apps-app-pin-${TIME_APP}`)
    await expect(pin).toHaveText('Pin on Apps')
    await pin.click()
    await expect(pin).toHaveText('Unpin from Apps')
    await backToApps(page)
    await expect(page.getByTestId(`apps-quick-pinned-${TIME_APP}`)).toBeVisible()
    // Pinning here never touches the Sidebar: the App still has no row of its own, and none under Open.
    await expect(page.getByTestId(`sidebar-app-${TIME_APP}`)).toHaveCount(0)
    await expect(page.getByTestId('sidebar-open-apps')).toHaveCount(0)
  } finally {
    await setAppsStayOpen(page, false)
  }
})
