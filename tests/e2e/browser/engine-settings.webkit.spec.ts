/**
 * Settings → Engines in WEBKIT: the Mac app is a WKWebView, so the section has
 * to load, toggle and persist there too. Kept to keys the chromium spec never
 * touches (both files run in one Playwright invocation against one fixture
 * HOME), and to disk assertions about its own writes only.
 */
import { test, expect } from '@playwright/test'
import {
  control,
  fixtureHome,
  openEnginesSection,
  readClaudeSettings,
  readCodexConfig,
  row,
  waitForEngineRows,
} from './engine-settings-helpers'

test.use({ browserName: 'webkit' })
test.setTimeout(90_000)

test('really runs in WebKit', async ({ browserName }) => {
  expect(browserName).toBe('webkit')
})

test('webkit: a terminal-group toggle and a codex boolean persist to disk', async ({ page, request }) => {
  const home = await fixtureHome(request)
  const section = await openEnginesSection(page)
  await waitForEngineRows(section, 'claude')

  await section.locator('summary', { hasText: 'Terminal only' }).click()
  const turnDuration = control(section, 'claude', 'showTurnDuration')
  await expect(row(section, 'showTurnDuration')).toHaveAttribute('data-source', 'default')
  await expect(turnDuration).toHaveAttribute('aria-checked', 'true')
  await turnDuration.click()
  await expect(turnDuration).toHaveAttribute('aria-checked', 'false')
  await expect.poll(async () => (await readClaudeSettings(home)).showTurnDuration).toBe(false)
  await expect(row(section, 'showTurnDuration')).toHaveAttribute('data-source', 'file')
  // The allowlist next door is exactly the seed.
  expect(((await readClaudeSettings(home)).permissions as Record<string, unknown>).allow).toEqual(['Bash(git *)', 'Read'])

  await waitForEngineRows(section, 'codex')
  const update = control(section, 'codex', 'check_for_update_on_startup')
  await expect(update).toHaveAttribute('aria-checked', 'false')
  await update.click()
  await expect.poll(async () => (await readCodexConfig(home)).includes('check_for_update_on_startup = true')).toBe(true)
  expect(await readCodexConfig(home)).toContain('[projects."/Users/example"]\ntrust_level = "trusted"')
})
