/**
 * A saved host's row in remote-hosts-every-button.spec.ts, step by step: its More menu, its
 * Details in place (the reading, the command to copy, Other ways, Check again, Kind, Probe),
 * its one action (Install, then Set up). Takes the spec's context like the other steps.
 * No tests in this file (Playwright refuses a test() call from an imported module).
 */
import { expect, type Page } from '@playwright/test'
import { fixtureCounters } from './host-problems-fixture-helpers'
import { expectFocusKept, pick, row } from './remote-hosts-every-button-helpers'
import { expectRing, type StepCtx } from './remote-hosts-every-button-steps'

const menu = (page: Page) => page.getByTestId('rh-row-menu')

/** Alpha box: its menu, Details, Install, Set up. */
export async function checkAlphaRow(ctx: StepCtx): Promise<void> {
  const { page, request, routes, sweep, ran } = ctx
  const alpha = row(page, 'devbox')
  const more = alpha.getByTestId('rh-row-more')
  await more.click()
  await expect(menu(page)).toBeVisible()
  await expect(menu(page).getByRole('menuitem')).toHaveText(['Edit', 'Details', 'Turn off', 'Remove'])
  await expect(menu(page).getByRole('menuitem', { name: 'Remove' })).toHaveClass(/danger/)
  await sweep()
  await page.keyboard.press('Escape')
  await expect(menu(page)).toHaveCount(0)
  await expect(more).toBeFocused()
  ran('Hosts/button#rh-row-more')

  // Details in place, reading the host again; What Walnut knows is in them.
  const reads = routes.callsTo('POST', '/api/v1/hosts/refresh').length
  await pick(page, alpha, 'Details')
  const details = page.locator('[data-testid="rh-details"][data-host="devbox"]')
  await expect(details).toBeVisible()
  expect((await routes.nth('POST', '/api/v1/hosts/refresh', reads + 1)).body).toEqual({ hosts: ['devbox'] })
  await expect(details.getByTestId('host-fleet-card')).toBeVisible()
  // The read it started is the summary's one Refreshing...; Details say how old what they show is.
  await expect(details.getByTestId('host-fleet-read-age')).toHaveText(/^Read /)
  await expect(details.getByText('Refreshing...', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Refreshing...', { exact: true })).toHaveCount(await page.getByTestId('host-fleet-refreshing').count())
  await expect(details.getByTestId('host-profile-system')).toHaveText('Ubuntu 24.04, x64, 16 CPUs, 64 GB memory, 200 GB free')
  // The reading's disk says the same free space (one fixture).
  await expect(details.locator('[data-gauge="disk"]')).toContainText('200 GB')
  await expectFocusKept(page)
  await sweep()
  ran('Row menu/menuitem[details]')

  // The command to copy: a box that wraps (no scrollbar) and the page's one Copy look.
  const block = details.locator('.rh-readiness-block[data-host="devbox"]')
  const chip = block.locator('.hc-chip').first()
  expect(await chip.evaluate((el) => [getComputedStyle(el).whiteSpace, el.scrollWidth <= el.clientWidth + 1])).toEqual(['pre-wrap', true])
  const copy = block.locator('button.setup-copy-btn').first()
  await copy.click()
  await expect(copy).toHaveAccessibleName(/^(Copied|Copy failed)$/)
  const other = block.locator('button.hc-other')
  await other.click()
  await expect(other).toHaveAttribute('aria-expanded', 'true')
  await expect(block.locator('.hc-other-list')).toContainText('npm install -g @anthropic-ai/claude-code')
  await sweep()
  await other.click()
  await expect(block.locator('.hc-other-list')).toHaveCount(0)
  ran('Hosts/button.setup-copy-btn', 'Hosts/button.hc-other')
  // The fix is the row's one action, never a second button in Details.
  await expect(details.getByTestId('rh-readiness-fix-claude_missing')).toHaveCount(0)

  const check = block.getByTestId('rh-readiness-recheck')
  const checks = (await fixtureCounters(request)).check.devbox ?? 0
  await check.click()
  await expect(check).toHaveText('Checking...')
  await expect(check).toHaveText('Check again', { timeout: 10_000 })
  expect((await fixtureCounters(request)).check.devbox).toBe(checks + 1)
  ran('Hosts/button#rh-readiness-recheck')

  // The kind: Escape gives the focus back; a pick is saved, shown and focused.
  const kind = details.getByRole('button', { name: 'Kind of Alpha box' })
  await expect(kind).toHaveText('Dev box (automatic)')
  const list = page.getByRole('listbox', { name: 'Kind of Alpha box' })
  await kind.click()
  await expect(list).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(list).toHaveCount(0)
  await expectRing(page, kind)
  await kind.click()
  await list.getByRole('option', { name: /Laptop$/ }).click()
  await expect(list).toHaveCount(0)
  expect((await routes.nth('PATCH', '/api/v1/hosts/devbox/profile', 1)).body).toEqual({ kind: 'laptop' })
  await expect(kind).toHaveText('Laptop')
  await expect(kind).toBeFocused()
  await details.getByRole('button', { name: 'Probe again' }).click()
  expect((await routes.nth('PATCH', '/api/v1/hosts/devbox/profile', 2)).body).toEqual({ refresh: true })
  await expect(details.getByTestId('host-profile-system')).toContainText('32 CPUs')
  ran('Hosts/button:Kind of <host>', 'Hosts/button:Probe again')

  // Install, the row's one action: Installing..., then Installed, said once (2026-11-04
  // review: "Last checked just nowInstalled Claude Code" beside "Alpha box is ready").
  const install = alpha.getByTestId('rh-readiness-fix-claude_missing')
  await expect(install).toHaveText('Install')
  const asked = page.waitForRequest((q) => q.method() === 'POST' && q.url().endsWith('/api/hosts/devbox/connect'))
  await install.click()
  expect((await asked).postDataJSON()).toEqual({ agents: true })
  await expect(alpha.getByTestId('rh-row-fixing')).toContainText('Installing Claude Code on Alpha box')
  await expect(alpha.getByTestId('rh-row-fix-note')).toContainText('Installed Claude Code', { timeout: 20_000 })
  await expect(details.locator('.rh-readiness-ready')).toHaveCount(0)
  // Said once on the page: the row's line, never again in its open Details.
  await expect(alpha.getByTestId('rh-row-fix-note')).toHaveCount(1)
  await expect(details).not.toContainText('Installed Claude Code')
  for (const line of await alpha.locator('.rh-row-line').allTextContents()) expect(line).toMatch(/[.:)]$|^Connected/)
  await expect(install).toHaveCount(0)
  await expectFocusKept(page)
  ran('Hosts/button#rh-readiness-fix-claude_missing')

  // Then its daemon: Set up (it does not start after a reboot).
  const fix = alpha.getByTestId('host-fleet-fix')
  await expect(fix).toHaveText('Set up')
  await sweep()
  const releaseBoot = routes.gate('boot')
  await fix.click()
  await expect(fix).toHaveText('Setting up...')
  releaseBoot()
  await expect(alpha.getByTestId('host-fleet-action-note')).toHaveText('Set up: starts by itself after a reboot (as a systemd user service).')
  await expect(fix).toHaveCount(0)
  expect(routes.callsTo('POST', '/api/v1/hosts/devbox/boot-start')).toHaveLength(1)
  await expectFocusKept(page)
  ran('Hosts/button#host-fleet-fix')

  await pick(page, alpha, 'Hide details')
  await expect(details).toHaveCount(0)
  await expect(more).toBeFocused()
}
