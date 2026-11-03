/**
 * Every button on the home card's "Claude Code is not installed" line, on each kind of
 * host: a Linux machine, a Mac, and a PC whose sessions run in WSL. 2026-11-03: the user
 * clicked Install on a PC's line and nothing happened (the host's automatic fixes were
 * off, and the click went with them), and the line offered a bash command, which on
 * Windows reads as "run it in PowerShell".
 *
 * Against the SERVER's host fixture (src/core/hosts/host-fixture.ts): the real connect and
 * check routes, the real readiness lines, frames pushed by the server. Only the repair
 * session behind Fix with agent is routed: a real one would start an agent.
 *
 * Run: PW_TEST_PORT=35993 npx playwright test host-attention-every-button --project=chromium
 *      PW_WEBKIT=1 PW_TEST_PORT=35993 npx playwright test host-attention-every-button --project=webkit
 */
import { test, expect, type Page } from '@playwright/test'
import { banner, expandSystemAttention, rows } from './host-problems-helpers'
import { bannerRow, fixtureCounters, fixtureFile, hostFixture, isolatePrefs, loadApp, loadFixture, resetServerHostFixture } from './host-problems-fixture-helpers'

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

/** With three lines each starts closed: its other buttons are one Show details away. */
async function details(page: Page, host: string): Promise<void> {
  const show = bannerRow(page, host).getByRole('button', { name: 'Show details' })
  if (await show.count()) await show.click()
}

async function open(page: Page): Promise<void> {
  await loadApp(page)
  await expandSystemAttention(page)
  for (const k of KINDS) await expect(bannerRow(page, k.host)).toHaveAttribute('data-kind', 'claude_missing', { timeout: 20_000 })
}

test.describe('the Claude Code line: every button, every kind of host', () => {
  test.beforeEach(async ({ page, request }) => { await isolatePrefs(page); await loadFixture(request, FILE) })
  test.afterAll(async ({ request }) => { await resetServerHostFixture(request) })

  test('each line names where Claude Code goes; Show details, Copy and Hide details work, and the command runs there', async ({ page }) => {
    await open(page)
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {})
    for (const k of KINDS) {
      const r = bannerRow(page, k.host)
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

  test('Install on each kind installs: Installing..., then ready; the click asks for the coding agent', async ({ page, request }) => {
    await open(page)
    for (const k of KINDS) {
      const r = bannerRow(page, k.host)
      const asked = page.waitForRequest((q) => q.method() === 'POST' && q.url().endsWith(`/api/hosts/${k.host}/connect`))
      await r.getByTestId('hpb-fix').click()
      expect((await asked).postDataJSON()).toEqual({ agents: true })
      await expect(bannerRow(page, k.host)).toContainText(`Installing Claude Code on ${k.label}...`)
      await expect(bannerRow(page, k.host)).toHaveText(new RegExp(`^(\\u2713 )?${k.label} is ready`), { timeout: 15_000 })
    }
    expect((await fixtureCounters(request)).connect).toMatchObject({ linuxbox: 1, macbox: 1, pcbox: 1 })
  })

  test('Check again on each kind checks: Checking..., then the same line with its answer', async ({ page, request }) => {
    for (const k of KINDS) await hostFixture(request, { action: 'check-slow', host: k.host, ms: 800 })
    await open(page)
    for (const k of KINDS) {
      await details(page, k.host)
      const check = bannerRow(page, k.host).getByTestId('hpb-check')
      await check.click()
      await expect(check).toHaveText('Checking...')
      await expect(check).toHaveText('Check again', { timeout: 10_000 })
      await expect(bannerRow(page, k.host).locator('.hpb-message')).toHaveText(`Claude Code is not installed on ${k.where}.`)
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
      await bannerRow(page, k.host).getByRole('button', { name: `Fix with agent for ${k.label}`, exact: true }).click()
      await expect.poll(() => sent.length).toBe(KINDS.indexOf(k) + 1)
      await expect.poll(() => new URL(page.url()).pathname).toBe('/')
      await expandSystemAttention(page)
    }
    expect(sent).toEqual(KINDS.map((k) => ({ host: k.host })))
  })

  test('x hides one line with an undo; Dismiss all hides the rest', async ({ page }) => {
    await open(page)
    await bannerRow(page, 'macbox').locator('.hpb-x').click()
    await expect(bannerRow(page, 'macbox')).toHaveCount(0)
    await expect(banner(page).getByRole('button', { name: /Undo/ })).toBeVisible()
    await expect(rows(page)).toHaveCount(2)
    await banner(page).getByRole('button', { name: 'Dismiss all' }).click()
    await expect(rows(page)).toHaveCount(0)
  })
})
