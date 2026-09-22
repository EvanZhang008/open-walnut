import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs/promises'
import net from 'node:net'
import { expect, test } from './shortcut-test-fixture'
import { type Page } from '@playwright/test'

/**
 * The Mail console is a CORE app gated on the mail PLUGIN being active.
 *
 * What this pins, in the browser, with real clicks:
 *
 *   1. The sidebar carries a Mail row, and it opens the console's empty state. Slice 0 has
 *      no accounts, so the empty state is the whole screen: it must say so and say what
 *      would change it, not render a blank pane.
 *   2. Turning the mail plugin off in Settings takes the sidebar row away LIVE, with no page
 *      reload. That is the whole reason `requiresPlugin` exists: the console is core code,
 *      but it is useless without the plugin's routes, so it must not be reachable while the
 *      plugin is off. A stock install ships the IMAP provider, which DEPENDS on the base, so
 *      the switch goes through the cascade ask on the way.
 *   3. Turning it back on brings the row back and revives the dependent, also live.
 *
 * Runs against its OWN server (tests/e2e/browser/mail-app-server.ts), not the shared :3457
 * fixture, because the switch under test PERSISTS: a failure between the off and the on
 * would leave `plugins.mail.enabled: false` in a home the next run reattaches to.
 */

const SCREENSHOT_DIR = '/tmp/plugin-platform/pw'

interface Fixture {
  port: number
  home: string
}

let child: ChildProcessWithoutNullStreams | null = null
let fixture: Fixture | null = null
let output = ''

test.describe.configure({ mode: 'serial' })
test.setTimeout(240_000)

async function reservePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Could not reserve a mail fixture port')
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return address.port
}

/** The fixture prints one machine-readable line once it is serving. */
function waitForReady(): Promise<Fixture> {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(
      () => reject(new Error(`Mail fixture did not start\n${output.slice(-8000)}`)),
      180_000,
    )
    const check = () => {
      const match = /MAIL_FIXTURE_READY (\{.*\})/.exec(output)
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
        reject(new Error(`Mail fixture exited early (${child.exitCode})\n${output.slice(-8000)}`))
      }
    }, 250)
  })
}

async function expandSidebar(page: Page): Promise<void> {
  await expect(page.locator('.sidebar')).toBeVisible({ timeout: 60_000 })
  if (await page.locator('.sidebar.collapsed').count()) {
    await page.locator('.sidebar-collapse-btn').click()
    await expect(page.locator('.sidebar.collapsed')).toHaveCount(0)
  }
}

async function openPlugins(page: Page): Promise<void> {
  await page.getByTestId('sidebar-core-app-settings').click()
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible({ timeout: 60_000 })
  await page.getByTestId('settings-nav-plugin-store').click()
  await expect(page.locator('#plugin-store')).toBeVisible({ timeout: 30_000 })
}

test.beforeAll(async () => {
  // A hook does NOT inherit the file's test timeout: it gets the config default, and booting
  // a server plus Vite takes longer than that whenever the machine is busy.
  test.setTimeout(240_000)
  await fs.mkdir(SCREENSHOT_DIR, { recursive: true })
  const port = await reservePort()
  child = spawn('./node_modules/.bin/tsx', ['tests/e2e/browser/mail-app-server.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, PW_MAIL_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => { output = `${output}${String(chunk)}`.slice(-20_000) })
  child.stderr.on('data', (chunk) => { output = `${output}${String(chunk)}`.slice(-20_000) })
  fixture = await waitForReady()
})

test.afterAll(async () => {
  if (child) {
    child.kill('SIGTERM')
    // The fixture's own shutdown stops the server, the daemon and then removes its home, which
    // takes longer than a couple of seconds on a loaded machine. Wait for it before escalating,
    // or the SIGKILL is what leaves the temp home behind.
    const deadline = Date.now() + 15_000
    while (child.exitCode === null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    if (child.exitCode === null) child.kill('SIGKILL')
  }
  // Belt and braces: whatever the child managed, this run's home does not outlive it. Guarded on
  // the fixture's own temp-dir name so a wrong value can never delete anything else.
  if (fixture?.home.includes('walnut-mail-app-')) {
    await fs.rm(fixture.home, { recursive: true, force: true }).catch(() => undefined)
  }
})

test('the Mail row opens an empty console, and the plugin switch takes it away and back', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  await page.goto(`http://127.0.0.1:${fixture!.port}/`)
  await page.waitForLoadState('domcontentloaded')
  await expandSidebar(page)

  // 1. The row is there, and it opens the console.
  const mailRow = page.getByTestId('sidebar-core-app-mail')
  await expect(mailRow).toBeVisible({ timeout: 60_000 })
  await mailRow.click()

  const empty = page.getByTestId('mail-app-empty')
  await expect(empty).toBeVisible({ timeout: 30_000 })
  await expect(empty).toContainText('No mail accounts yet')
  // The empty state has to name what would change it. "Nothing here" with no next step is
  // indistinguishable from a broken screen, and telling a machine that HAS a provider to go
  // install one is worse than that: the stock IMAP provider is named, and its Add account is here.
  await expect(empty).toContainText('provider plugin')
  // "Ready to use: IMAP" is the provider's own label (the PLUGIN is "IMAP Mail"), and it only
  // appears when the console actually knows its providers.
  await expect(empty).toContainText('Ready to use: IMAP')
  await expect(page.getByTestId('mail-add-account')).toBeVisible()
  await page.locator('.mail-app').screenshot({ path: `${SCREENSHOT_DIR}/mail-empty-state.png` })

  // 2. Off, and the row goes away without a reload.
  await openPlugins(page)
  const row = page.getByTestId('plugin-row-mail')
  const imapRow = page.getByTestId('plugin-row-mail-imap')
  await expect(row).toBeVisible({ timeout: 30_000 })
  await expect(row).toHaveAttribute('data-plugin-status', 'active')
  await expect(imapRow).toHaveAttribute('data-plugin-status', 'active')

  const toggle = page.locator('#plugin-toggle-mail')
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  await toggle.click()

  // A stock install has a DEPENDENT: the IMAP provider declares `dependencies: { mail }`, so the
  // server refuses to disable the base while it is running and the console asks first. The ask
  // has to name the dependent, or "turn it off anyway" is a blind choice.
  const ask = page.getByTestId('plugin-cascade-ask')
  await expect(ask).toBeVisible({ timeout: 60_000 })
  await expect(ask).toContainText('IMAP Mail')
  await page.getByTestId('plugin-cascade-confirm').click()

  await expect(row).toHaveAttribute('data-plugin-status', 'disabled', { timeout: 60_000 })
  // The dependent is not disabled, it is UNSATISFIED: turning mail back on has to revive it, and
  // that is a different row state from the one the human switched.
  await expect(imapRow).toHaveAttribute('data-plugin-status', 'needs-dependency', { timeout: 60_000 })
  await expect(page.getByTestId('sidebar-core-app-mail')).toHaveCount(0, { timeout: 60_000 })
  await page.locator('.sidebar').screenshot({ path: `${SCREENSHOT_DIR}/mail-sidebar-without-row.png` })

  // 3. On again, and both come back.
  await page.locator('#plugin-toggle-mail').click()
  await expect(row).toHaveAttribute('data-plugin-status', 'active', { timeout: 60_000 })
  await expect(imapRow).toHaveAttribute('data-plugin-status', 'active', { timeout: 60_000 })
  await expect(page.getByTestId('sidebar-core-app-mail')).toBeVisible({ timeout: 60_000 })
  await page.locator('.sidebar').screenshot({ path: `${SCREENSHOT_DIR}/mail-sidebar-with-row.png` })

  expect(pageErrors, 'gating a core app on a plugin must not throw in the browser').toEqual([])
})
