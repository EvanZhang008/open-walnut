import { bunRuntime } from '../../helpers/bun-runtime.js'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs/promises'
import net from 'node:net'
import { expect, test } from './shortcut-test-fixture'
import { type Page } from '@playwright/test'
import { backToApps, openPartDetail, openPluginDetail } from './apps-store-helpers'

/**
 * The plugin store on the Apps page (/apps), reached from the sidebar's Apps entry. The
 * page is a store: one card per plugin, and each card opens a detail page that holds the
 * switch, the settings, the parts, where the code comes from and Remove.
 *
 * What it pins:
 *
 *   1. The store lists what is actually on this machine (walnut-time, linked) AND
 *      catalog entries that are not (the fixture's git overlay entry): one surface,
 *      two lists. The grid holds cards only: no rows, no switches, no inline forms.
 *   2. The ON/OFF switch is real: turning walnut-time off takes its App off its detail
 *      page, its card's Open and the sidebar LIVE, and turning it back on brings them
 *      back. Before this section there was no UI that could do it at all (the old spec
 *      next door had to POST the disable route by hand, and said so).
 *   3. OFF PERSISTS. The switch writes `plugins.walnut-time.enabled: false` to
 *      config.yaml, so a plugin cannot come back by itself after a restart: asserted
 *      against the file, because that is where the promise lives.
 *   4. Installing still requires the explicit trust acknowledgement. The free-form form
 *      opens from "Add from a git or npm link" and its Add stays disabled until the box
 *      is ticked; a catalog entry's own Install stays disabled until its own trust switch
 *      is on, and that trust is never sticky. A curated listing is not consent.
 *   5. Dependencies are visible and reversible. `beta` and `delta` both run on `alpha`:
 *      turning alpha off is REFUSED until a confirmation names them, cancel changes
 *      nothing, and the cascade parks both ("needs another plugin") without ever writing
 *      an off-switch for them: asserted against config.yaml, because that is the
 *      difference between "waiting for alpha" and "the user turned it off". Each blocked
 *      plugin carries its OWN action (test ids are keyed by row and dependency, so two
 *      plugins waiting on the same one stay separately clickable), and using one of them
 *      brings both dependents back with no page reload.
 *   6. Installing a dependency ASKS. `epsilon` (from a source clone) waits on `zeta`,
 *      which only the catalog can supply: its button opens a consent list naming the exact
 *      source URL, and nothing is installed until a second, explicit yes. A curated
 *      catalog file is a suggestion, not permission to run someone's code.
 *   7. A bundled plugin (in the store folder that ships with Walnut) lists under Get more
 *      and is NOT loaded; one Install loads it live and writes `enabled: true`; Remove
 *      takes it back to Get more, returns to the grid and deletes its whole config key.
 *      Twice, because the second Install is the one that proves Remove really forgot it.
 *   8. A plugin whose App draws its own settings (`settingsIn: 'app'`) has one home for
 *      them: its detail page sends you to the App, which lives under Settings because it
 *      asked for no placement, and a save there lands in config.yaml. When the App never
 *      registered, the same page falls back to the form.
 *   9. A part (`kappa-tools`, whose id extends `kappa`) has no card: its parent's card
 *      names it, its parent's page lists it with its own switch, and its settings live on
 *      its own page, which says whose part it is. Back goes where you came from.
 *
 * Runs against its own server (tests/e2e/browser/plugin-store-server.ts) because the
 * shared :3457 fixture installs no plugins by design.
 */

const SCREENSHOT_DIR = '/tmp/settings-redesign'

interface Fixture {
  port: number
  home: string
  overlayEntryId: string
  requiresEntryId: string
  dependencySourceSlug: string
  dependencySourceUrl: string
  bundledEntryId: string
  partParentId: string
  partId: string
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
  if (!address || typeof address === 'string') throw new Error('Could not reserve a plugin-store fixture port')
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return address.port
}

/** The fixture prints one machine-readable line once it is serving. */
function waitForReady(): Promise<Fixture> {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(
      () => reject(new Error(`Plugin store fixture did not start\n${output.slice(-8000)}`)),
      180_000,
    )
    const check = () => {
      const match = /PLUGIN_STORE_READY (\{.*\})/.exec(output)
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
        reject(new Error(`Plugin store fixture exited early (${child.exitCode})\n${output.slice(-8000)}`))
      }
    }, 250)
  })
}

/** Shoots what is on screen: the open detail page, else the card grid (hidden under a detail page). */
async function shoot(page: Page, name: string): Promise<void> {
  const detail = page.getByTestId('plugin-detail')
  const target = (await detail.count()) > 0 ? detail : page.locator('#plugin-store')
  await target.screenshot({ path: `${SCREENSHOT_DIR}/${name}.png` })
}

async function expandSidebar(page: Page): Promise<void> {
  await expect(page.locator('.sidebar')).toBeVisible({ timeout: 60_000 })
  if (await page.locator('.sidebar.collapsed').count()) {
    await page.locator('.sidebar-collapse-btn').click()
    await expect(page.locator('.sidebar.collapsed')).toHaveCount(0)
  }
}

/** The Apps page, opened the way a user opens it: the sidebar's Apps entry. */
async function openPlugins(page: Page): Promise<void> {
  await page.goto(`http://127.0.0.1:${fixture!.port}/`)
  await page.waitForLoadState('domcontentloaded')
  await expandSidebar(page)
  await page.getByTestId('sidebar-core-app-apps').click()
  await expect(page.getByTestId('apps-page')).toBeVisible({ timeout: 60_000 })
  await expect(page.locator('#plugin-store')).toBeVisible({ timeout: 30_000 })
}

/** What config.yaml says about a plugin: the durable half of the switch. */
async function configPlugins(): Promise<Record<string, { enabled?: unknown }>> {
  const raw = await fs.readFile(`${fixture!.home}/config.yaml`, 'utf-8')
  // The fixture writes JSON (valid YAML) and the server rewrites it as YAML, so read
  // the flag with a shape-agnostic probe rather than assuming either syntax.
  const yaml = await import('js-yaml')
  const doc = yaml.load(raw) as { plugins?: Record<string, { enabled?: unknown }> }
  return doc.plugins ?? {}
}

async function configEnabled(pluginId: string): Promise<unknown> {
  return (await configPlugins())[pluginId]?.enabled
}

/** Which plugins config.yaml has an opinion about at all. A blocked dependent must NOT
 *  appear here: an off-switch on disk would leave it lying down after its dependency
 *  came back. */
async function configPluginKeys(): Promise<string[]> {
  return Object.keys(await configPlugins()).sort()
}

/** The sources config.yaml knows about. Installing a dependency adds one here, so this is
 *  how "the panel only ASKED" is proved rather than assumed. */
async function configSourceUrls(): Promise<string[]> {
  const raw = await fs.readFile(`${fixture!.home}/config.yaml`, 'utf-8')
  const yaml = await import('js-yaml')
  const doc = yaml.load(raw) as { plugin_sources?: Array<{ url?: string; spec?: string }> }
  return (doc.plugin_sources ?? []).map((source) => source.url ?? source.spec ?? '')
}

test.beforeAll(async () => {
  // A hook does NOT inherit the file's test timeout: it gets the config default (30s),
  // and booting a server plus Vite takes longer than that whenever the machine is busy.
  test.setTimeout(240_000)
  await fs.mkdir(SCREENSHOT_DIR, { recursive: true })
  const port = await reservePort()
  child = spawn(bunRuntime(), ['tests/e2e/browser/plugin-store-server.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, PW_PLUGIN_STORE_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => { output = `${output}${String(chunk)}`.slice(-20_000) })
  child.stderr.on('data', (chunk) => { output = `${output}${String(chunk)}`.slice(-20_000) })
  fixture = await waitForReady()
})

test.afterAll(async () => {
  if (!child) return
  child.kill('SIGTERM')
  await new Promise((resolve) => setTimeout(resolve, 2000))
  if (child.exitCode === null) child.kill('SIGKILL')
})

test('lists what is installed and what the catalog offers, in one section', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  await openPlugins(page)
  const grid = page.locator('#plugin-store')

  // Installed: the linked plugin, on. The switch lives on its page, not on the card.
  const timeCard = page.getByTestId('plugin-card-walnut-time')
  await expect(timeCard).toBeVisible({ timeout: 30_000 })
  await expect(timeCard).toHaveAttribute('data-plugin-status', 'active')
  await expect(page.getByTestId('plugin-store-installed').getByTestId('plugin-card-walnut-time')).toHaveCount(1)

  // The grid is cards only: no rows, no switches, no Configure, no inline form, no App tiles.
  await expect(grid.locator('[data-testid^="plugin-row-"]')).toHaveCount(0)
  await expect(grid.locator('[data-testid^="plugin-configure-"]')).toHaveCount(0)
  await expect(grid.locator('[data-testid^="plugin-config-"]')).toHaveCount(0)
  await expect(grid.locator('[id^="plugin-toggle-"]')).toHaveCount(0)
  await expect(page.getByTestId('apps-plugin-app-tiles')).toHaveCount(0)

  // Its page: the switch says "on" (no On tag), and what it adds is listed under About.
  await openPluginDetail(page, 'walnut-time')
  await expect(page.locator('#plugin-toggle-walnut-time')).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('plugin-about-walnut-time').locator('.apps-about-adds')).toContainText(/app/i)
  await backToApps(page)

  // Available: a catalog entry that is NOT on this machine.
  const available = page.getByTestId('plugin-store-available')
  await expect(available).toBeVisible()
  const fixtureCard = page.getByTestId(`plugin-card-${fixture!.overlayEntryId}`)
  await expect(fixtureCard).toHaveAttribute('data-plugin-status', 'available')
  // Not installed is said by the group it sits in, and by Get on the card.
  await expect(available.getByTestId(`plugin-card-${fixture!.overlayEntryId}`)).toHaveCount(1)
  await expect(page.getByTestId(`plugin-card-${fixture!.overlayEntryId}-status`)).toHaveText('Get')
  await openPluginDetail(page, fixture!.overlayEntryId)
  await expect(page.getByTestId(`plugin-install-${fixture!.overlayEntryId}`)).toHaveText('Install')
  await backToApps(page)

  // Builtin sync plugins ship with Walnut and need credentials, so they are honest
  // about it rather than showing a switch that would refuse to flip.
  const jira = page.getByTestId('plugin-card-jira')
  if (await jira.count()) {
    await expect(jira).toHaveAttribute('data-plugin-status', 'needs-config')
    await expect(page.getByTestId('plugin-card-jira-status')).toHaveText('Needs setup')
    // The grid never carries its form, open or closed.
    await expect(page.getByTestId('plugin-config-jira')).toHaveCount(0)
    await expect(page.getByTestId('plugin-configure-jira')).toHaveCount(0)

    await openPluginDetail(page, 'jira')
    const head = page.getByTestId('plugin-row-jira')
    await expect(head).toHaveAttribute('data-plugin-status', 'needs-config')
    await expect(head.locator('[role="switch"]')).toHaveCount(0)
    await expect(head).toContainText('Needs setup')
    await expect(head).toContainText(/Needs setup: base URL/)

    // Its page offers the thing that CAN help. A needs-config plugin is not in the
    // registry, so its schema has to come from the loader's set-aside list; without
    // that the plugins most in need of configuring had no form at all. On its own page
    // the form is simply there (no Configure, no Done), and it leads, before About.
    await expect(page.getByTestId('plugin-configure-jira')).toHaveCount(0)
    const form = page.getByTestId('plugin-config-jira')
    await expect(form).toBeVisible({ timeout: 30_000 })
    await expect(form.locator('#plugin-jira-base_url')).toBeVisible()
    const settingsTop = (await page.getByTestId('plugin-settings-jira').boundingBox())!.y
    const aboutTop = (await page.getByTestId('plugin-about-jira').boundingBox())!.y
    expect(settingsTop, 'a plugin that needs setup leads with its settings').toBeLessThan(aboutTop)
    await shoot(page, 'store-1680-configure-detail')
    await backToApps(page)
    await expect(page.getByTestId('plugin-config-jira')).toHaveCount(0)
  }

  await shoot(page, 'store-1680-lists')
  expect(pageErrors, 'rendering the store must not throw').toEqual([])
})

test('installing still requires the trust acknowledgement, catalog entries included', async ({ page }) => {
  await openPlugins(page)

  const store = page.locator('#plugin-store')
  const urlField = store.locator('#plugin-source-url')
  const addButton = store.getByRole('button', { name: 'Add', exact: true })
  const trust = store.getByTestId('plugin-trust-confirm')

  // The free-form install is folded away until asked for.
  await expect(urlField).toHaveCount(0)
  await expect(trust).toHaveCount(0)
  await page.getByTestId('apps-add-from-link').click()
  await expect(urlField).toBeVisible({ timeout: 30_000 })

  // Nothing typed: nothing to add.
  await expect(urlField).toHaveValue('')
  await expect(addButton).toBeDisabled()

  // A source typed in fills the URL and NOTHING else.
  await urlField.fill('https://example.invalid/store-fixture-plugin.git')
  await expect(trust).not.toBeChecked()
  await expect(addButton).toBeDisabled()

  // Only the explicit acknowledgement enables it.
  await trust.check()
  await expect(addButton).toBeEnabled()

  // The sentence a person has to READ must not be shouted. `.form-group label`
  // uppercases every label, which caught this one too.
  await expect(store.locator('.plugin-trust-label')).toHaveCSS('text-transform', 'none')
  await shoot(page, 'store-1680-install-trust')

  // And unticking takes the ability away again.
  await trust.uncheck()
  await expect(addButton).toBeDisabled()
  // The url is a draft the server keeps; leave none behind for the next test.
  await urlField.fill('')
  await expect(urlField).toHaveValue('')

  // A catalog entry's own Install is gated the same way, on its page.
  const id = fixture!.overlayEntryId
  await openPluginDetail(page, id)
  const install = page.getByTestId(`plugin-install-${id}`)
  const entryTrust = page.getByTestId(`plugin-trust-${id}`)
  await expect(entryTrust).toHaveAttribute('aria-checked', 'false')
  await expect(install).toBeDisabled()
  await entryTrust.click()
  await expect(entryTrust).toHaveAttribute('aria-checked', 'true')
  await expect(install).toBeEnabled()
  await entryTrust.click()
  await expect(install).toBeDisabled()

  // Trust is granted per visit, never sticky: on, leave, come back, and it is off.
  await entryTrust.click()
  await expect(install).toBeEnabled()
  await backToApps(page)
  await openPluginDetail(page, id)
  await expect(page.getByTestId(`plugin-trust-${id}`)).toHaveAttribute('aria-checked', 'false')
  await expect(page.getByTestId(`plugin-install-${id}`)).toBeDisabled()
  await backToApps(page)
})

test('settings that live in the App: its page goes there, the save lands, and a missing App falls back', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await openPlugins(page)

  // The App asked for no placement, so it is off the Sidebar and lives on the Apps page,
  // and Settings lists no Apps at all.
  await openPluginDetail(page, 'sigma')
  await expect(page.getByTestId('apps-app-sigma:main')).toHaveAttribute('data-shown', 'false', { timeout: 30_000 })
  await expect(page.getByTestId('sidebar-app-sigma:main')).toHaveCount(0)
  await page.getByTestId('sidebar-core-app-settings').click()
  await expect(page.getByTestId('settings-nav-plugin-store')).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.settings-nav a[href^="/apps/"]')).toHaveCount(0)
  await page.getByTestId('sidebar-core-app-apps').click()
  await expect(page.getByTestId('apps-page')).toBeVisible({ timeout: 30_000 })

  // One home for the form: its page sends you to the App instead of drawing a copy here.
  await openPluginDetail(page, 'sigma')
  await expect(page.getByTestId('plugin-configure-sigma')).toHaveCount(0)
  await expect(page.getByTestId('plugin-config-sigma')).toHaveCount(0)
  const toApp = page.getByTestId('plugin-settings-sigma').getByTestId('plugin-open-settings-sigma')
  await expect(toApp).toHaveText('Open Sigma settings')
  await toApp.click()
  await expect(page).toHaveURL(/\/apps\/sigma~main$/)
  await expect(page.getByTestId('sigma-app')).toBeVisible({ timeout: 30_000 })
  const form = page.getByTestId('plugin-settings-form-sigma')
  await expect(form).toHaveAttribute('data-state', 'ready', { timeout: 30_000 })

  // Top-level rows here: the label starts at the row edge, not at the nested indent.
  const row = form.locator('.settings-row').first()
  await expect(row).toBeVisible({ timeout: 30_000 })
  expect(await row.evaluate((el) => getComputedStyle(el).paddingLeft)).toBe('14px')

  const field = form.locator('#plugin-sigma-interval_minutes')
  await field.fill('45')
  await form.getByTestId('plugin-config-save-sigma').click()
  await expect.poll(async () => (await configPlugins()).sigma as Record<string, unknown> | undefined, { timeout: 20_000 })
    .toMatchObject({ interval_minutes: 45 })
  await page.screenshot({ path: `${SCREENSHOT_DIR}/store-1680-settings-in-app.png` })

  // tau asks for the same, but its web entry failed, so there is no App to send it to:
  // its page keeps the form rather than leaving the settings unreachable.
  await page.getByTestId('sidebar-core-app-apps').click()
  await openPluginDetail(page, 'tau')
  await expect(page.getByTestId('plugin-open-settings-tau')).toHaveCount(0)
  await expect(page.getByTestId('plugin-configure-tau')).toHaveCount(0)
  await expect(page.getByTestId('plugin-config-tau').locator('#plugin-tau-interval_minutes')).toBeVisible({ timeout: 30_000 })

  expect(pageErrors, 'the settings-in-app path must not throw').toEqual([])
})

test('a bundled plugin installs in one click, and Remove takes it back to Get more', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  const id = fixture!.bundledEntryId

  await openPlugins(page)
  const available = page.getByTestId('plugin-store-available')
  const installed = page.getByTestId('plugin-store-installed')
  const card = page.getByTestId(`plugin-card-${id}`)
  const head = page.getByTestId(`plugin-row-${id}`)

  for (const round of [1, 2]) {
    // ── Available: shipped, not loaded, and nothing in config says otherwise ──
    await expect(available.getByTestId(`plugin-card-${id}`)).toHaveCount(1, { timeout: 30_000 })
    await expect(card).toHaveAttribute('data-plugin-status', 'available')
    await expect(page.getByTestId(`plugin-card-${id}-status`)).toHaveText('Get')
    await expect(card).toContainText('Comes with Walnut')
    expect(await configPluginKeys()).not.toContain(id)
    // The section is taller than the viewport, so shoot the group under test, not the page.
    if (round === 1) await available.screenshot({ path: `${SCREENSHOT_DIR}/store-1680-bundled-available.png` })

    await openPluginDetail(page, id)
    await expect(head).toHaveAttribute('data-plugin-status', 'available')
    const install = page.getByTestId(`plugin-install-${id}`)
    await expect(install).toHaveText('Install')
    await expect(install).toHaveAttribute('title', 'Ships with Walnut; not loaded until installed.')
    await expect(page.locator(`#plugin-toggle-${id}`)).toHaveCount(0)

    // ── Install: one click, loaded live, installed on disk ──
    await install.click()
    await expect(head).toHaveAttribute('data-plugin-status', 'active', { timeout: 60_000 })
    await expect(head).toContainText('Comes with Walnut')
    await expect(page.getByTestId(`plugin-about-${id}`).locator('.apps-about-adds')).toHaveText('Agent tools')
    await expect(page.locator(`#plugin-toggle-${id}`)).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByTestId('plugin-detail')).toContainText('Installed Omega.')
    await expect.poll(() => configEnabled(id), { timeout: 15_000 }).toBe(true)
    if (round === 1) await shoot(page, 'store-1680-bundled-installed')

    // The grid agrees: the card moved from Get more to the installed list.
    await backToApps(page)
    await expect(installed.getByTestId(`plugin-card-${id}`)).toHaveCount(1, { timeout: 30_000 })
    await expect(available.getByTestId(`plugin-card-${id}`)).toHaveCount(0)
    await expect(card).toHaveAttribute('data-plugin-status', 'active')
    await openPluginDetail(page, id)

    if (round === 1) {
      // The switch is an ordinary switch: off persists, and Remove still works from off.
      await page.locator(`#plugin-toggle-${id}`).click()
      await expect(head).toHaveAttribute('data-plugin-status', 'disabled', { timeout: 60_000 })
      await expect.poll(() => configEnabled(id), { timeout: 15_000 }).toBe(false)
    }

    // ── Remove: two-step, back to the grid and to Get more, config key gone ──
    const remove = page.getByTestId(`plugin-remove-${id}`)
    await expect(remove).toHaveText('Remove')
    await remove.click()
    await expect(remove).toHaveText('Confirm remove')
    await remove.click()
    await expect(page.getByTestId('plugin-detail')).toHaveCount(0, { timeout: 60_000 })
    await expect(available.getByTestId(`plugin-card-${id}`)).toHaveCount(1, { timeout: 60_000 })
    await expect(installed.getByTestId(`plugin-card-${id}`)).toHaveCount(0)
    await expect(card).toHaveAttribute('data-plugin-status', 'available')
    await expect(page.locator('#plugin-store')).toContainText('Removed Omega; it is back under Get more.')
    await expect.poll(() => configPluginKeys(), { timeout: 15_000 }).not.toContain(id)
    if (round === 1) await available.screenshot({ path: `${SCREENSHOT_DIR}/store-1680-bundled-removed.png` })
  }

  // And a fresh page load agrees with what the store just said.
  await openPlugins(page)
  await expect(available.getByTestId(`plugin-card-${id}`)).toHaveCount(1, { timeout: 30_000 })
  expect(pageErrors, 'installing and removing a bundled plugin must not throw').toEqual([])
})

test('a part has no card: its parent names it, lists it with its switch, and its own page holds its settings', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  const parent = fixture!.partParentId
  const part = fixture!.partId

  await openPlugins(page)

  // ── The grid: one card for the parent, none for the part ──
  const parentCard = page.getByTestId(`plugin-card-${parent}`)
  await expect(parentCard).toBeVisible({ timeout: 30_000 })
  await expect(parentCard).toContainText('Includes Kappa Tools')
  await expect(page.getByTestId(`plugin-card-${part}`)).toHaveCount(0)
  // A search finds the parent by its part's name, and still draws no card for the part.
  const search = page.getByTestId('apps-search')
  await search.fill('Kappa Tools')
  await expect(parentCard).toBeVisible()
  await expect(page.getByTestId(`plugin-card-${part}`)).toHaveCount(0)
  await search.fill('')

  // ── The parent's page lists the part, with its own switch ──
  await openPluginDetail(page, parent)
  const parts = page.getByTestId(`plugin-parts-${parent}`)
  await expect(parts).toBeVisible()
  const partRow = parts.getByTestId(`plugin-part-${part}`)
  await expect(partRow).toHaveAttribute('data-plugin-status', 'active')
  await expect(partRow).toContainText('Kappa Tools')
  // Its settings have one home, its own page, so the parent's page draws no copy.
  await expect(page.getByTestId(`plugin-config-${part}`)).toHaveCount(0)
  await expect(page.getByTestId(`plugin-part-open-${part}`)).toHaveText('Settings')

  // The part's switch works from here, and off persists like any other switch.
  const partToggle = page.locator(`#plugin-toggle-${part}`)
  await expect(partToggle).toHaveAttribute('aria-checked', 'true')
  await partToggle.click()
  await expect(partRow).toHaveAttribute('data-plugin-status', 'disabled', { timeout: 60_000 })
  await expect(partToggle).toHaveAttribute('aria-checked', 'false')
  await expect.poll(() => configEnabled(part), { timeout: 15_000 }).toBe(false)
  await partToggle.click()
  await expect(partRow).toHaveAttribute('data-plugin-status', 'active', { timeout: 60_000 })
  await expect.poll(() => configEnabled(part), { timeout: 15_000 }).toBe(true)
  await shoot(page, 'store-1680-parts')

  // ── The part's own page: whose part it is, and its settings ──
  await openPartDetail(page, part)
  await expect(page.getByTestId('plugin-detail-parent')).toHaveText('Part of Kappa')
  await expect(page.getByTestId(`plugin-config-${part}`).locator(`#plugin-${part}-interval_minutes`)).toBeVisible({ timeout: 30_000 })

  // Back goes where you came from: the parent's page, then the grid.
  await page.getByTestId('plugin-detail-back').click()
  await expect(page.getByTestId('plugin-detail')).toHaveAttribute('data-plugin-id', parent, { timeout: 30_000 })
  await backToApps(page)
  await expect(parentCard).toBeVisible()
  await expect(page.getByTestId(`plugin-card-${part}`)).toHaveCount(0)

  // "Part of Kappa" leads to the parent's page.
  await openPluginDetail(page, parent)
  await openPartDetail(page, part)
  await page.getByTestId('plugin-detail-parent').click()
  await expect(page.getByTestId('plugin-detail')).toHaveAttribute('data-plugin-id', parent, { timeout: 30_000 })
  await expect(page.getByTestId(`plugin-parts-${parent}`)).toBeVisible()

  expect(pageErrors, 'the parts path must not throw').toEqual([])
})

/*
 * LAST on purpose: it turns the plugin off and on, and the fixture server is shared by
 * the whole file.
 */
test('the switch turns a plugin off and on, and off survives a restart', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  await openPlugins(page)
  // Its App is registered, so its card opens it directly.
  await expect(page.getByTestId('plugin-card-open-walnut-time')).toBeVisible({ timeout: 60_000 })
  await openPluginDetail(page, 'walnut-time')
  await expect(page.getByTestId('apps-app-walnut-time:main')).toBeVisible({ timeout: 60_000 })

  // ── OFF ──
  const toggle = page.locator('#plugin-toggle-walnut-time')
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  await toggle.click()

  // The App is owner-scoped, so it leaves this page (and the sidebar) live.
  await expect(page.getByTestId('apps-app-walnut-time:main')).toHaveCount(0, { timeout: 60_000 })
  await expect(page.getByTestId('plugin-open-app-walnut-time')).toHaveCount(0)
  await expect(page.getByTestId('sidebar-app-walnut-time:main')).toHaveCount(0)
  await expect(page.getByTestId('plugin-row-walnut-time')).toHaveAttribute('data-plugin-status', 'disabled')
  await expect(page.locator('#plugin-toggle-walnut-time')).toHaveAttribute('aria-checked', 'false')
  await shoot(page, 'store-1680-toggled-off')

  // The promise the switch makes is durability, and that lives in config.yaml.
  await expect.poll(() => configEnabled('walnut-time'), { timeout: 15_000 }).toBe(false)

  // The card agrees: Off, and no Open for an App that is gone.
  await backToApps(page)
  await expect(page.getByTestId('plugin-card-walnut-time')).toHaveAttribute('data-plugin-status', 'disabled')
  await expect(page.getByTestId('plugin-card-walnut-time-status')).toHaveText('Off')
  await expect(page.getByTestId('plugin-card-open-walnut-time')).toHaveCount(0)

  await page.getByTestId('sidebar-core-app-settings').click()
  await expect(page.getByTestId('settings-nav-plugin-store')).toBeVisible({ timeout: 30_000 })

  // ── ON ── (back through the Settings nav's Apps link)
  await page.getByTestId('settings-nav-plugin-store').click()
  await expect(page.getByTestId('apps-page')).toBeVisible({ timeout: 30_000 })
  await openPluginDetail(page, 'walnut-time')
  const toggleAgain = page.locator('#plugin-toggle-walnut-time')
  await expect(toggleAgain).toHaveAttribute('aria-checked', 'false')
  await toggleAgain.click()

  await expect(page.getByTestId('plugin-row-walnut-time')).toHaveAttribute('data-plugin-status', 'active', { timeout: 60_000 })
  await expect(page.getByTestId('apps-app-walnut-time:main')).toBeVisible({ timeout: 60_000 })
  await expect.poll(() => configEnabled('walnut-time'), { timeout: 15_000 }).toBe(true)
  await shoot(page, 'store-1680-toggled-on')

  // The card is back on (On, or a newer word such as Update available for a checkout behind its remote).
  await backToApps(page)
  await expect(page.getByTestId('plugin-card-walnut-time')).toHaveAttribute('data-plugin-status', 'active')
  await expect(page.getByTestId('plugin-card-walnut-time-status')).not.toHaveText('Off')
  await expect(page.getByTestId('plugin-card-open-walnut-time')).toBeVisible({ timeout: 60_000 })

  expect(pageErrors, 'toggling a plugin must not throw in the browser').toEqual([])
})

/* ── Dependencies. These act on alpha/beta/gamma only, never on walnut-time. ── */

test('a plugin that runs on another comes up with it, and the catalog stays quiet', async ({ page }) => {
  await openPlugins(page)

  // beta and delta declare `dependencies: { alpha: '^1' }` and are on, which means the
  // load order put alpha first and the gate let both through.
  for (const id of ['beta', 'delta']) {
    const card = page.getByTestId(`plugin-card-${id}`)
    await expect(card).toBeVisible({ timeout: 30_000 })
    await expect(card).toHaveAttribute('data-plugin-status', 'active')
    await openPluginDetail(page, id)
    await expect(page.locator(`#plugin-toggle-${id}`)).toHaveAttribute('aria-checked', 'true')
    await backToApps(page)
  }
  await expect(page.getByTestId('plugin-card-alpha')).toHaveAttribute('data-plugin-status', 'active')

  // The catalog entry that `requires` alpha says nothing while alpha is running: there is
  // nothing extra to install, and a permanent "also needs" line would be noise.
  const gamma = page.getByTestId(`plugin-card-${fixture!.requiresEntryId}`)
  await expect(gamma).toHaveAttribute('data-plugin-status', 'available')
  await expect(gamma).not.toContainText('Also needs')
  await openPluginDetail(page, fixture!.requiresEntryId)
  await expect(page.getByTestId(`plugin-row-${fixture!.requiresEntryId}`)).not.toContainText('Also needs')
  await expect(page.getByTestId(`plugin-also-needs-${fixture!.requiresEntryId}`)).toHaveCount(0)
  await backToApps(page)
})

test('installing a dependency asks before it clones anything', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  await openPlugins(page)

  // epsilon came from a source and waits on zeta, which is only in the catalog.
  const epsilonCard = page.getByTestId('plugin-card-epsilon')
  await expect(epsilonCard).toBeVisible({ timeout: 30_000 })
  await expect(epsilonCard).toHaveAttribute('data-plugin-status', 'needs-dependency')
  await expect(page.getByTestId('plugin-card-epsilon-status')).toHaveText('Needs another plugin')

  await openPluginDetail(page, 'epsilon')
  const epsilon = page.getByTestId('plugin-row-epsilon')
  await expect(epsilon).toHaveAttribute('data-plugin-status', 'needs-dependency')
  await expect(page.getByTestId('plugin-dependency-needs-epsilon')).toContainText('Needs Zeta ^1')

  // The action on a blocked plugin is an ASK, not an install.
  const install = page.getByTestId('plugin-dependency-install-epsilon-zeta')
  await expect(install).toHaveText('Install Zeta...')
  await expect(page.getByTestId('plugin-pending-dependencies')).toHaveCount(0)

  await install.click()
  const consent = page.getByTestId('plugin-pending-dependencies')
  await expect(consent).toBeVisible({ timeout: 30_000 })
  // Every URL that would be added, before any of them is: that is the consent.
  await expect(consent).toContainText('Also install: Zeta')
  await expect(consent).toContainText('https://example.invalid/zeta.git')
  await expect(page.getByTestId('plugin-pending-dependencies-install')).toBeVisible()
  await shoot(page, 'store-1680-dependency-consent')

  // Still one source: the click asked, and asking installs nothing.
  expect(await configSourceUrls()).toEqual([fixture!.dependencySourceUrl])

  await page.getByTestId('plugin-pending-dependencies-dismiss').click()
  await expect(consent).toHaveCount(0)
  await expect(epsilon).toHaveAttribute('data-plugin-status', 'needs-dependency')
  expect(await configSourceUrls()).toEqual([fixture!.dependencySourceUrl])

  expect(pageErrors, 'the consent panel must not throw in the browser').toEqual([])
})

test('turning off a plugin others run on asks first, and never writes them off', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  await openPlugins(page)
  await openPluginDetail(page, 'alpha')
  const alphaToggle = page.locator('#plugin-toggle-alpha')
  await expect(alphaToggle).toHaveAttribute('aria-checked', 'true')

  // ── Refused, with the list ──
  await alphaToggle.click()
  const confirm = page.getByTestId('plugin-cascade-confirm')
  await expect(confirm).toBeVisible({ timeout: 30_000 })
  // Both dependents are named, by display name, before anything happens.
  await expect(page.getByTestId('plugin-cascade-ask')).toContainText(/Beta/)
  await expect(page.getByTestId('plugin-cascade-ask')).toContainText(/Delta/)
  await shoot(page, 'store-1680-cascade-confirm')

  // ── Cancel changes nothing, on screen or on disk ──
  await page.getByTestId('plugin-cascade-cancel').click()
  await expect(confirm).toHaveCount(0)
  await expect(page.getByTestId('plugin-row-alpha')).toHaveAttribute('data-plugin-status', 'active')
  await backToApps(page)
  await expect(page.getByTestId('plugin-card-alpha')).toHaveAttribute('data-plugin-status', 'active')
  await expect(page.getByTestId('plugin-card-beta')).toHaveAttribute('data-plugin-status', 'active')
  await expect(page.getByTestId('plugin-card-delta')).toHaveAttribute('data-plugin-status', 'active')
  expect(await configPluginKeys()).not.toContain('alpha')

  // ── Agree, and the cascade parks the dependent instead of switching it off ──
  await openPluginDetail(page, 'alpha')
  await alphaToggle.click()
  await expect(page.getByTestId('plugin-cascade-confirm')).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('plugin-cascade-confirm').click()

  await expect(page.getByTestId('plugin-row-alpha')).toHaveAttribute('data-plugin-status', 'disabled', { timeout: 60_000 })
  await expect(alphaToggle).toHaveAttribute('aria-checked', 'false')
  await backToApps(page)
  for (const id of ['beta', 'delta']) {
    await expect(page.getByTestId(`plugin-card-${id}`)).toHaveAttribute('data-plugin-status', 'needs-dependency', { timeout: 60_000 })
    await expect(page.getByTestId(`plugin-card-${id}-status`)).toHaveText('Needs another plugin')
  }
  // Each plugin names what IT waits for, by display name, in the server's own words, and
  // owns its own action, keyed by row + dependency so neither shadows the other.
  for (const id of ['beta', 'delta']) {
    await openPluginDetail(page, id)
    await expect(page.getByTestId(`plugin-row-${id}`)).toContainText('Needs another plugin')
    await expect(page.getByTestId(`plugin-dependency-needs-${id}`)).toContainText('Needs Alpha ^1')
    await expect(page.getByTestId(`plugin-dependency-needs-${id}`)).toContainText('was turned off')
    await expect(page.getByTestId(`plugin-dependency-turn-on-${id}-alpha`)).toHaveText('Turn on Alpha')
    if (id === 'beta') await shoot(page, 'store-1680-needs-dependency')
    await backToApps(page)
  }

  // Only the target got an off-switch. A dependent with `enabled: false` on disk would
  // stay down after alpha came back, which is the whole point of blocking instead.
  await expect.poll(() => configEnabled('alpha'), { timeout: 15_000 }).toBe(false)
  expect(await configPluginKeys()).not.toContain('beta')
  expect(await configPluginKeys()).not.toContain('delta')

  // And the catalog entry that needs alpha now says so, since alpha is not running.
  await openPluginDetail(page, fixture!.requiresEntryId)
  await expect(page.getByTestId(`plugin-also-needs-${fixture!.requiresEntryId}`)).toContainText('Also needs: Alpha')
  await shoot(page, 'store-1680-also-needs')
  await backToApps(page)

  // ── Back on, from ONE blocked plugin, with no page reload ──
  await openPluginDetail(page, 'beta')
  await page.getByTestId('plugin-dependency-turn-on-beta-alpha').click()
  await expect(page.getByTestId('plugin-row-beta')).toHaveAttribute('data-plugin-status', 'active', { timeout: 60_000 })
  await expect(page.locator('#plugin-toggle-beta')).toHaveAttribute('aria-checked', 'true')
  await backToApps(page)
  await expect(page.getByTestId('plugin-card-alpha')).toHaveAttribute('data-plugin-status', 'active', { timeout: 60_000 })
  // Both dependents return, because neither was ever written off.
  for (const id of ['beta', 'delta']) {
    await expect(page.getByTestId(`plugin-card-${id}`)).toHaveAttribute('data-plugin-status', 'active', { timeout: 60_000 })
  }
  await openPluginDetail(page, 'delta')
  await expect(page.locator('#plugin-toggle-delta')).toHaveAttribute('aria-checked', 'true')
  await expect.poll(() => configEnabled('alpha'), { timeout: 15_000 }).toBe(true)
  await shoot(page, 'store-1680-dependency-restored')
  await backToApps(page)

  expect(pageErrors, 'the dependency flow must not throw in the browser').toEqual([])
})
