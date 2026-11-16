/**
 * Every button on a host's "Claude Code is not installed" row in the notification panel's
 * problem list, on each kind of host: a Linux machine, a Mac, and a PC whose sessions run in WSL. 2026-11-03: the user
 * clicked Install on a PC's line and nothing happened (the host's automatic fixes were
 * off, and the click went with them), and the line offered a bash command, which on
 * Windows reads as "run it in PowerShell".
 *
 * Against the SERVER's host fixture (src/core/hosts/host-fixture.ts): the real connect and
 * check routes, the real readiness lines, frames pushed by the server. Only the repair
 * session behind Fix with agent is routed: a real one would start an agent.
 *
 * Run: walnut-dev run bun x playwright test tests/e2e/browser/host-attention-every-button.spec.ts --project chromium-host-fixture --retries=0
 */
import { test, expect, type Page } from '@playwright/test'
import { fixtureCounters, fixtureFile, hostFixture, isolatePrefs, loadApp, loadFixture, resetServerHostFixture } from './host-problems-fixture-helpers'
import { openProblems, problemRow, problemRowHosts } from './host-attention-helpers'
import { storedKeys } from './host-problems-helpers'

const KINDS = [
  { host: 'linuxbox', label: 'Linux box', where: 'Linux box', command: 'curl -fsSL https://claude.ai/install.sh | bash' },
  { host: 'macbox', label: 'Mac box', where: 'Mac box', command: 'curl -fsSL https://claude.ai/install.sh | bash' },
  { host: 'pcbox', label: 'PC box', where: "PC box's Ubuntu (WSL)", command: 'wsl -d Ubuntu -- bash -lc "curl -fsSL https://claude.ai/install.sh | bash"' },
] as const

const FILE = fixtureFile({
  linuxbox: { label: 'Linux box', hostname: 'linux.example.com', phase: 'connected', claude: { found: false } },
  macbox: { label: 'Mac box', hostname: 'mac.example.com', phase: 'connected', platform: 'darwin', claude: { found: false } },
  pcbox: { label: 'PC box', hostname: 'pc.example.com', phase: 'connected', wsl: 'Ubuntu', claude: { found: false } },
})

/** A row starts closed (dense): its other buttons are one Show details away. */
async function details(page: Page, host: string): Promise<void> {
  const show = problemRow(page, host).getByRole('button', { name: 'Show details' })
  if (await show.count()) await show.click()
}

/** The notification panel open on All, its problem list showing every kind's row. */
async function showRows(page: Page): Promise<void> {
  if (!(await page.locator('.notification-panel').isVisible())) await openProblems(page)
  for (const k of KINDS) await expect(problemRow(page, k.host)).toHaveAttribute('data-kind', 'claude_missing', { timeout: 20_000 })
}

async function open(page: Page): Promise<void> {
  await loadApp(page)
  await showRows(page)
}

test.describe('the Claude Code line: every button, every kind of host', () => {
  test.beforeEach(async ({ page, request }) => { await isolatePrefs(page); await loadFixture(request, FILE) })
  test.afterAll(async ({ request }) => { await resetServerHostFixture(request) })

  test('each line names where Claude Code goes; Show details, Copy and Hide details work, and the command runs there', async ({ page }) => {
    await open(page)
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {})
    for (const k of KINDS) {
      const r = problemRow(page, k.host)
      await expect(r.locator('.hpb-message')).toHaveText(`Claude Code is not installed on ${k.where}.`)
      await r.getByRole('button', { name: 'Show details' }).click()
      const code = r.locator('.hc code').first()
      await expect(code).toHaveText(k.command)
      const copy = r.locator('.hc .setup-copy-btn').first()
      await copy.click()
      await expect(copy).toHaveText(/Copied|Copy failed/)
      await r.getByRole('button', { name: 'Hide details' }).click()
      await expect(r.locator('.hc code')).toHaveCount(0)
    }
  })

  test('Install on each kind installs: Installing..., then the row leaves; the click asks for the coding agent', async ({ page, request }) => {
    await open(page)
    for (const k of KINDS) {
      const r = problemRow(page, k.host)
      const asked = page.waitForRequest((q) => q.method() === 'POST' && q.url().endsWith(`/api/hosts/${k.host}/connect`))
      await r.getByTestId('hpb-fix').click()
      expect((await asked).postDataJSON()).toEqual({ agents: true })
      await expect(problemRow(page, k.host)).toContainText(`Installing Claude Code on ${k.label}...`)
      // Installed: the healed host leaves the problem list.
      await expect(problemRow(page, k.host)).toHaveCount(0, { timeout: 15_000 })
    }
    expect((await fixtureCounters(request)).connect).toMatchObject({ linuxbox: 1, macbox: 1, pcbox: 1 })
  })

  test('Check again on each kind checks: Checking..., then the same line with its answer', async ({ page, request }) => {
    for (const k of KINDS) await hostFixture(request, { action: 'check-slow', host: k.host, ms: 800 })
    await open(page)
    for (const k of KINDS) {
      await details(page, k.host)
      const check = problemRow(page, k.host).getByTestId('hpb-check')
      await check.click()
      await expect(check).toHaveText('Checking...')
      await expect(check).toHaveText('Check again', { timeout: 10_000 })
      await expect(problemRow(page, k.host).locator('.hpb-message')).toHaveText(`Claude Code is not installed on ${k.where}.`)
    }
    expect((await fixtureCounters(request)).check).toMatchObject({ linuxbox: 1, macbox: 1, pcbox: 1 })
  })

  test('Fix with agent asks for that host\'s repair and opens it', async ({ page }) => {
    const sent: unknown[] = []
    await page.route('**/api/notifications/fix', async (route) => {
      sent.push(route.request().postDataJSON())
      await route.fulfill({ json: { taskId: `repair-${sent.length}`, reused: false } })
    })
    await open(page)
    for (const k of KINDS) {
      await details(page, k.host)
      await problemRow(page, k.host).getByRole('button', { name: `Fix with agent for ${k.label}`, exact: true }).click()
      await expect.poll(() => sent.length).toBe(KINDS.indexOf(k) + 1)
      // Opening the repair closes the notification panel (NotificationPanel onNavigate).
      await expect(page.locator('.notification-panel')).toHaveCount(0)
      await expect.poll(() => new URL(page.url()).pathname).toBe('/')
      // Back to the list for the next host.
      await showRows(page)
    }
    expect(sent).toEqual(KINDS.map((k) => ({ host: k.host })))
  })

  test('x hides one line and keeps the others', async ({ page }) => {
    await open(page)
    await problemRow(page, 'macbox').getByRole('button', { name: 'Dismiss Mac box' }).click()
    await expect(problemRow(page, 'macbox')).toHaveCount(0)
    await expect.poll(() => problemRowHosts(page)).toEqual(['linuxbox', 'pcbox'])
    expect((await storedKeys(page)).some((k) => k.startsWith('macbox|claude_missing|'))).toBe(true)
  })
})
