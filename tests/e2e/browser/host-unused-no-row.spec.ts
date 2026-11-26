/**
 * A host nothing uses for sessions takes no problem row for its Claude Code in the
 * notification panel (2026-11-05, the user: "fix all the errors in errors fix the root
 * cause"; the first problem listed was a fleet Mac with no Claude Code that no project or
 * task ran on). The row is back the moment something uses the host, and goes again by
 * itself when nothing does;
 * Settings keeps the line and its Install for whoever wants sessions there.
 *
 * Against the SERVER's host fixture (src/core/hosts/host-fixture.ts): real frames, the real
 * readiness lines; `usedForSessions` is the fixture's stand-in for host-session-use.ts.
 *
 * Run: walnut-dev run bun x playwright test tests/e2e/browser/host-unused-no-row.spec.ts --project chromium-host-fixture --retries=0
 */
import fs from 'node:fs'
import { test, expect, type Page } from '@playwright/test'
import {
  HEALTHY, fixtureFile, hostFixture, hostRow, isolatePrefs, loadApp, loadFixture, openPicker, openRemoteHosts, pickFolder, resetServerHostFixture,
} from './host-problems-fixture-helpers'
import { closeModelPicker, draftCwdPill, draftEngineButton, draftModelPicker } from './draft-helpers'
import { openProblems, pickRail, problemRow, systemHostLine, systemHostRow, systemHosts } from './host-attention-helpers'

const SHOTS = process.env.PW_SHOTS_DIR ?? 'test-results/host-unused-no-row-shots'
const FILE = fixtureFile({
  devbox: { label: 'Dev box', hostname: 'dev.example.com', phase: 'connected', claude: { found: false } },
  fleet: { label: 'Fleet Mac', hostname: 'fleet.example.com', phase: 'connected', platform: 'darwin', claude: { found: false }, usedForSessions: false },
  signbox: { label: 'Sign box', hostname: 'sign.example.com', phase: 'connected', claude: { found: true, version: '2.1.300', auth: 'not-logged-in' }, usedForSessions: false },
  readybox: { label: 'Ready box', hostname: 'ready.example.com', phase: 'connected', claude: HEALTHY, usedForSessions: false },
})

async function shot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(SHOTS, { recursive: true })
  await page.screenshot({ path: `${SHOTS}/${name}.png` })
}

/** Home, then the notification panel's problem list, where the used Dev box has its row. */
async function home(page: Page): Promise<void> {
  await loadApp(page)
  await openProblems(page)
  await expect(problemRow(page, 'devbox')).toHaveAttribute('data-kind', 'claude_missing', { timeout: 20_000 })
}

test.describe('a host nothing uses for sessions', () => {
  test.beforeEach(async ({ page, request }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await isolatePrefs(page)
    await loadFixture(request, FILE)
  })
  test.afterAll(async ({ request }) => { await resetServerHostFixture(request) })

  test('takes no problem row; the System list says it quietly; the used host keeps its row', async ({ page }) => {
    await home(page)
    await expect(problemRow(page, 'fleet')).toHaveCount(0)
    await expect(problemRow(page, 'signbox')).toHaveCount(0)
    await shot(page, '01-problem-rows')

    await pickRail(page, 'System')
    await expect(systemHosts(page)).toBeVisible({ timeout: 20_000 })
    await expect(systemHostRow(page, 'devbox')).toHaveAttribute('data-kind', 'claude_missing')
    for (const [host, words] of [['fleet', 'Connected. Claude Code is not installed on Fleet Mac.'], ['signbox', 'Connected. Claude Code on Sign box is not signed in.']] as const) {
      await expect(systemHostRow(page, host), host).toHaveCount(0)
      const status = systemHostLine(page, host).locator('.nfc-daemon-status')
      await expect(status, host).toHaveText(words)
      await expect(status, host).not.toHaveClass(/\bwarn\b/)
    }
    await shot(page, '02-system-list')
  })

  test('the row comes back when something uses the host, and goes by itself when nothing does', async ({ page, request }) => {
    await home(page)
    await expect(problemRow(page, 'fleet')).toHaveCount(0)
    await hostFixture(request, { action: 'set-used', host: 'fleet', used: true })
    await expect(problemRow(page, 'fleet')).toHaveAttribute('data-kind', 'claude_missing', { timeout: 10_000 })
    await expect(problemRow(page, 'fleet').locator('.hpb-message')).toHaveText('Claude Code is not installed on Fleet Mac.')
    await shot(page, '03-used-row-back')
    await hostFixture(request, { action: 'set-used', host: 'fleet', used: false })
    await expect(problemRow(page, 'fleet')).toHaveCount(0, { timeout: 15_000 })
    await expect(problemRow(page, 'devbox')).toBeVisible()
    await shot(page, '04-unused-row-gone')
  })

  test('a draft on a host without Claude Code says so where the engine is picked', async ({ page }) => {
    await loadApp(page)
    const panel = await openPicker(page, 'fleet')
    await pickFolder(page, panel, 'fleet', '/home/dev/work')
    const claude = await draftEngineButton(page, panel, 'claude')
    await expect(claude).toHaveAttribute('aria-selected', 'true')
    await expect(claude).toHaveClass(/provider-rail-item-unavailable/, { timeout: 10_000 })
    // The rail's tooltip names the engine first, then why (ea800b085f: provider icons carry their names).
    await expect(claude).toHaveAttribute('title', 'Claude Code: Not available on fleet: Claude Code is not installed on Fleet Mac')
    await expect(draftModelPicker(page).getByTestId('model-picker-engine-unavailable')).toHaveText('Not available on fleet: Claude Code is not installed on Fleet Mac')
    fs.mkdirSync(SHOTS, { recursive: true })
    await draftModelPicker(page).screenshot({ path: `${SHOTS}/06-picker-missing.png` })
    await closeModelPicker(page)

    // The same draft moved to a host that runs Claude Code: nothing to say.
    await draftCwdPill(panel).click()
    await expect(page.locator('.session-path-selector')).toBeVisible({ timeout: 10_000 })
    await pickFolder(page, panel, 'readybox', '/home/dev/work')
    const ready = await draftEngineButton(page, panel, 'claude')
    await expect(ready).toHaveAttribute('aria-selected', 'true')
    await expect(ready).not.toHaveClass(/provider-rail-item-unavailable/)
    await expect(draftModelPicker(page).getByTestId('model-picker-engine-unavailable')).toHaveCount(0)
    await draftModelPicker(page).screenshot({ path: `${SHOTS}/07-picker-ready.png` })
  })

  test('Settings keeps the line and its Install', async ({ page }) => {
    await loadApp(page, '/settings')
    await openRemoteHosts(page)
    // The host's own row says it and offers the fix (the row carries both since Remote Hosts says each thing once).
    const row = hostRow(page, 'fleet')
    await expect(row).toContainText('Claude Code is not installed on Fleet Mac.', { timeout: 20_000 })
    await expect(row.getByTestId('rh-readiness-fix-claude_missing')).toHaveText('Install')
    await row.scrollIntoViewIfNeeded()
    fs.mkdirSync(SHOTS, { recursive: true })
    await row.screenshot({ path: `${SHOTS}/05-settings-line.png` })
  })
})
