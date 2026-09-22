import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs/promises'
import net from 'node:net'
import { expect, test } from './shortcut-test-fixture'
import { type Page } from '@playwright/test'

/**
 * Settings → Plugins, the registry store.
 *
 * What it pins:
 *
 *   1. The store lists what is actually on this machine (walnut-time, linked) AND
 *      catalog entries that are not (the fixture's git overlay entry) — one surface,
 *      two lists.
 *   2. The ON/OFF switch is real: turning walnut-time off takes its Settings → Plugins
 *      row and its App away LIVE, and turning it back on brings them back. Before this
 *      section there was no UI that could do it at all (the old spec next door had to
 *      POST the disable route by hand, and said so).
 *   3. OFF PERSISTS. The switch writes `plugins.walnut-time.enabled: false` to
 *      config.yaml, so a plugin cannot come back by itself after a restart — asserted
 *      against the file, because that is where the promise lives.
 *   4. Installing still requires the explicit trust acknowledgement. Prefilling from
 *      the catalog fills the URL and NOTHING else: Add stays disabled until the box is
 *      ticked. A curated listing is not consent.
 *   5. Dependencies are visible and reversible. `beta` and `delta` both run on `alpha`:
 *      turning alpha off is REFUSED until a confirmation names them, cancel changes
 *      nothing, and the cascade parks both ("needs another plugin") without ever writing
 *      an off-switch for them — asserted against config.yaml, because that is the
 *      difference between "waiting for alpha" and "the user turned it off". Each blocked
 *      row carries its OWN action (test ids are keyed by row and dependency, so two rows
 *      waiting on the same plugin stay separately clickable), and using one of them
 *      brings both dependents back with no page reload.
 *   6. Installing a dependency ASKS. `epsilon` (from a source clone) waits on `zeta`,
 *      which only the catalog can supply: its button opens a consent list naming the exact
 *      source URL, and nothing is installed until a second, explicit yes. A curated
 *      catalog file is a suggestion, not permission to run someone's code.
 *
 * Runs against its own server (tests/e2e/browser/plugin-store-server.ts) because the
 * shared :3457 fixture installs no plugins by design.
 */

const SCREENSHOT_DIR = '/tmp/settings-unify'

interface Fixture {
  port: number
  home: string
  overlayEntryId: string
  requiresEntryId: string
  dependencySourceSlug: string
  dependencySourceUrl: string
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

async function shoot(page: Page, name: string): Promise<void> {
  await page.locator('#plugin-store').screenshot({ path: `${SCREENSHOT_DIR}/${name}.png` })
}

async function expandSidebar(page: Page): Promise<void> {
  await expect(page.locator('.sidebar')).toBeVisible({ timeout: 60_000 })
  if (await page.locator('.sidebar.collapsed').count()) {
    await page.locator('.sidebar-collapse-btn').click()
    await expect(page.locator('.sidebar.collapsed')).toHaveCount(0)
  }
}

/** Settings, opened the way a user opens it. */
async function openPlugins(page: Page): Promise<void> {
  await page.goto(`http://127.0.0.1:${fixture!.port}/`)
  await page.waitForLoadState('domcontentloaded')
  await expandSidebar(page)
  await page.getByTestId('sidebar-core-app-settings').click()
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible({ timeout: 60_000 })
  await page.getByTestId('settings-nav-plugin-store').click()
  await expect(page.locator('#plugin-store')).toBeVisible({ timeout: 30_000 })
}

/** What config.yaml says about a plugin — the durable half of the switch. */
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
  child = spawn('./node_modules/.bin/tsx', ['tests/e2e/browser/plugin-store-server.ts'], {
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

  // Installed: the linked plugin, on, with what it adds.
  const timeRow = page.getByTestId('plugin-row-walnut-time')
  await expect(timeRow).toBeVisible({ timeout: 30_000 })
  await expect(timeRow).toHaveAttribute('data-plugin-status', 'active')
  await expect(timeRow).toContainText('on')
  await expect(timeRow).toContainText('adds App')

  // Available: a catalog entry that is NOT on this machine.
  const available = page.getByTestId('plugin-store-available')
  await expect(available).toBeVisible()
  const fixtureRow = page.getByTestId(`plugin-row-${fixture!.overlayEntryId}`)
  await expect(fixtureRow).toHaveAttribute('data-plugin-status', 'available')
  await expect(fixtureRow).toContainText('not installed')

  // Builtin sync plugins ship with Walnut and need credentials, so they are honest
  // about it rather than showing a switch that would refuse to flip.
  const jira = page.getByTestId('plugin-row-jira')
  if (await jira.count()) {
    await expect(jira).toHaveAttribute('data-plugin-status', 'needs-config')
    await expect(jira.locator('[role="switch"]')).toHaveCount(0)
    // And it offers the thing that CAN help. A needs-config plugin is not in the
    // registry, so its schema has to come from the loader's set-aside list; without
    // that the plugins most in need of configuring had no Configure button at all.
    await expect(page.getByTestId('plugin-configure-jira')).toBeVisible()
    await expect(jira).toContainText('Missing configuration: base_url')

    // Configure opens the plugin's own form UNDER its row — configured where it is
    // turned on. It must not be open on mount: an eight-field form expanded by default
    // buries every row below it.
    await expect(page.getByTestId('plugin-config-jira')).toHaveCount(0)
    await page.getByTestId('plugin-configure-jira').click()
    const form = page.getByTestId('plugin-config-jira')
    await expect(form).toBeVisible({ timeout: 30_000 })
    await expect(form.locator('#plugin-jira-base_url')).toBeVisible()
    await shoot(page, 'store-1680-configure-inline')
    await page.getByTestId('plugin-configure-jira').click()
    await expect(page.getByTestId('plugin-config-jira')).toHaveCount(0)
  }

  await shoot(page, 'store-1680-lists')
  expect(pageErrors, 'rendering the store must not throw').toEqual([])
})

test('installing still requires the trust acknowledgement, prefill included', async ({ page }) => {
  await openPlugins(page)

  const store = page.locator('#plugin-store')
  const addButton = store.getByRole('button', { name: 'Add', exact: true })
  const trust = store.getByTestId('plugin-trust-confirm')

  // Nothing typed: nothing to add.
  await expect(addButton).toBeDisabled()

  // Prefill from the catalog fills the URL and NOTHING else.
  await page.getByTestId(`plugin-install-${fixture!.overlayEntryId}`).click()
  await expect(store.locator('#plugin-source-url')).toHaveValue(
    'https://example.invalid/store-fixture-plugin.git',
  )
  await expect(trust).not.toBeChecked()
  await expect(addButton).toBeDisabled()

  // Only the explicit acknowledgement enables it.
  await trust.check()
  await expect(addButton).toBeEnabled()

  // The sentence a person has to READ must not be shouted. `.form-group label`
  // uppercases every label, which caught this one too.
  await expect(store.locator('label.plugin-trust-label')).toHaveCSS('text-transform', 'none')
  await shoot(page, 'store-1680-install-trust')

  // And unticking takes the ability away again.
  await trust.uncheck()
  await expect(addButton).toBeDisabled()
})

/*
 * LAST on purpose: it turns the plugin off and on, and the fixture server is shared by
 * the whole file.
 */
test('the switch turns a plugin off and on, and off survives a restart', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  await openPlugins(page)
  await expect(page.getByTestId('settings-nav-app-walnut-time:main')).toBeVisible({ timeout: 60_000 })

  // ── OFF ──
  const toggle = page.locator('#plugin-toggle-walnut-time')
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  await toggle.click()

  // The row is owner-scoped, so the App's Settings → Plugins entry goes away live.
  await expect(page.getByTestId('settings-nav-app-walnut-time:main')).toHaveCount(0, { timeout: 60_000 })
  await expect(page.getByTestId('sidebar-app-walnut-time:main')).toHaveCount(0)
  await expect(page.getByTestId('plugin-row-walnut-time')).toHaveAttribute('data-plugin-status', 'disabled')
  await expect(page.getByTestId('plugin-row-walnut-time')).toContainText('off')
  await shoot(page, 'store-1680-toggled-off')

  // One registry, so the plugin's app row forgets it in the same beat as the nav row.
  await expect(page.getByTestId('plugin-app-row-walnut-time:main')).toHaveCount(0)

  // The promise the switch makes is durability, and that lives in config.yaml.
  await expect.poll(() => configEnabled('walnut-time'), { timeout: 15_000 }).toBe(false)

  // ── ON ──
  await page.getByTestId('settings-nav-plugin-store').click()
  const toggleAgain = page.locator('#plugin-toggle-walnut-time')
  await expect(toggleAgain).toHaveAttribute('aria-checked', 'false')
  await toggleAgain.click()

  await expect(page.getByTestId('plugin-row-walnut-time')).toHaveAttribute('data-plugin-status', 'active', { timeout: 60_000 })
  await expect(page.getByTestId('settings-nav-app-walnut-time:main')).toBeVisible({ timeout: 60_000 })
  await expect.poll(() => configEnabled('walnut-time'), { timeout: 15_000 }).toBe(true)
  await shoot(page, 'store-1680-toggled-on')

  expect(pageErrors, 'toggling a plugin must not throw in the browser').toEqual([])
})

/* ── Dependencies. These act on alpha/beta/gamma only, never on walnut-time. ── */

test('a plugin that runs on another comes up with it, and the catalog stays quiet', async ({ page }) => {
  await openPlugins(page)

  // beta and delta declare `dependencies: { alpha: '^1' }` and are on, which means the
  // load order put alpha first and the gate let both through.
  for (const id of ['beta', 'delta']) {
    const row = page.getByTestId(`plugin-row-${id}`)
    await expect(row).toBeVisible({ timeout: 30_000 })
    await expect(row).toHaveAttribute('data-plugin-status', 'active')
    await expect(row).toContainText('on')
  }
  await expect(page.getByTestId('plugin-row-alpha')).toHaveAttribute('data-plugin-status', 'active')

  // The catalog entry that `requires` alpha says nothing while alpha is running: there is
  // nothing extra to install, and a permanent "also needs" line would be noise.
  const gamma = page.getByTestId(`plugin-row-${fixture!.requiresEntryId}`)
  await expect(gamma).toHaveAttribute('data-plugin-status', 'available')
  await expect(gamma).not.toContainText('Also needs')
  await expect(page.getByTestId(`plugin-also-needs-${fixture!.requiresEntryId}`)).toHaveCount(0)
})

test('installing a dependency asks before it clones anything', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  await openPlugins(page)

  // epsilon came from a source and waits on zeta, which is only in the catalog.
  const epsilon = page.getByTestId('plugin-row-epsilon')
  await expect(epsilon).toBeVisible({ timeout: 30_000 })
  await expect(epsilon).toHaveAttribute('data-plugin-status', 'needs-dependency')
  await expect(page.getByTestId('plugin-dependency-needs-epsilon')).toContainText('Needs Zeta ^1')

  // The action on a blocked row is an ASK, not an install.
  const install = page.getByTestId('plugin-dependency-install-epsilon-zeta')
  await expect(install).toHaveText('Install Zeta…')
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
  await expect(page.getByTestId('plugin-row-beta')).toHaveAttribute('data-plugin-status', 'active')
  await expect(page.getByTestId('plugin-row-delta')).toHaveAttribute('data-plugin-status', 'active')
  expect(await configPluginKeys()).not.toContain('alpha')

  // ── Agree, and the cascade parks the dependent instead of switching it off ──
  await alphaToggle.click()
  await expect(page.getByTestId('plugin-cascade-confirm')).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('plugin-cascade-confirm').click()

  await expect(page.getByTestId('plugin-row-alpha')).toHaveAttribute('data-plugin-status', 'disabled', { timeout: 60_000 })
  await expect(page.getByTestId('plugin-row-alpha')).toContainText('off')
  const beta = page.getByTestId('plugin-row-beta')
  const delta = page.getByTestId('plugin-row-delta')
  for (const row of [beta, delta]) {
    await expect(row).toHaveAttribute('data-plugin-status', 'needs-dependency', { timeout: 60_000 })
    await expect(row).toContainText('needs another plugin')
  }
  // Each row names what IT waits for, by display name, in the server's own words — and
  // owns its own action, keyed by row + dependency so neither shadows the other.
  for (const id of ['beta', 'delta']) {
    await expect(page.getByTestId(`plugin-dependency-needs-${id}`)).toContainText('Needs Alpha ^1')
    await expect(page.getByTestId(`plugin-dependency-needs-${id}`)).toContainText('was turned off')
    await expect(page.getByTestId(`plugin-dependency-turn-on-${id}-alpha`)).toHaveText('Turn on Alpha')
  }
  await shoot(page, 'store-1680-needs-dependency')

  // Only the target got an off-switch. A dependent with `enabled: false` on disk would
  // stay down after alpha came back, which is the whole point of blocking instead.
  await expect.poll(() => configEnabled('alpha'), { timeout: 15_000 }).toBe(false)
  expect(await configPluginKeys()).not.toContain('beta')
  expect(await configPluginKeys()).not.toContain('delta')

  // And the catalog row that needs alpha now says so, since alpha is not running.
  await expect(page.getByTestId(`plugin-also-needs-${fixture!.requiresEntryId}`)).toContainText('Also needs: Alpha')
  await page.getByTestId('plugin-store-available').screenshot({ path: `${SCREENSHOT_DIR}/store-1680-also-needs.png` })

  // ── Back on, from ONE blocked row, with no page reload ──
  await page.getByTestId('plugin-dependency-turn-on-beta-alpha').click()
  await expect(page.getByTestId('plugin-row-alpha')).toHaveAttribute('data-plugin-status', 'active', { timeout: 60_000 })
  // Both dependents return, because neither was ever written off.
  for (const row of [beta, delta]) {
    await expect(row).toHaveAttribute('data-plugin-status', 'active', { timeout: 60_000 })
    await expect(row).toContainText('on')
  }
  await expect.poll(() => configEnabled('alpha'), { timeout: 15_000 }).toBe(true)
  await shoot(page, 'store-1680-dependency-restored')

  expect(pageErrors, 'the dependency flow must not throw in the browser').toEqual([])
})
