/**
 * Settings → Engines: "Default engine for new sessions".
 *
 * One control, three things a unit test cannot see: it shows what the config
 * actually says (not an optimistic local value), merely OPENING the page writes
 * nothing, and a pick survives a real navigation away and back while the sibling
 * `defaults` keys live — the default task priority and the default project sit
 * under the same config key this writes, and `updateConfig` replaces that key
 * whole.
 *
 * Deliberately NOT asserted here: which engine a launch then runs on. That is
 * pinned server-side (tests/web/routes/quick-start-default-engine.test.ts) where
 * SESSION_START can be read directly; a browser spec would have to spawn a real
 * ACP adapter to say anything about it.
 *
 * The WebKit half (settings-default-engine.webkit.spec.ts) is read-only on
 * purpose: both files run in ONE Playwright invocation against one fixture
 * server, and two files writing the same config key would race.
 */
import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { openEnginesSection } from './engine-settings-helpers'

test.describe.configure({ mode: 'serial' })
// A cold SPA navigation under machine load has eaten 27s of the default budget.
test.setTimeout(90_000)

/** The config as the server reports it — the only authority on what was saved. */
async function serverDefaults(request: APIRequestContext): Promise<Record<string, unknown>> {
  const res = await request.get('/api/config')
  expect(res.ok()).toBe(true)
  const body = await res.json() as { config?: { defaults?: Record<string, unknown> } }
  return body.config?.defaults ?? {}
}

/** Real SPA navigation back to Settings → Engines (never a page.goto for nav). */
async function reopenEnginesSection(page: Page) {
  await page.locator('.sidebar-nav a[href="/"]').click()
  await expect(page.locator('#engines')).toHaveCount(0)
  await page.locator('.sidebar-nav a[href="/settings"]').click()
  await page.locator('.settings-nav-item', { hasText: 'Engines' }).click()
  const section = page.locator('#engines')
  await expect(section).toBeVisible()
  return section
}

test.describe('Settings → Engines → default engine', () => {
  test('shows the configured engine, says what it is for, and writes nothing on open', async ({ page, request }) => {
    const before = await serverDefaults(request)
    const section = await openEnginesSection(page)
    const select = section.getByTestId('default-engine-select')
    await expect(select).toBeVisible()
    // No key in the config = Claude (the default lives at the reader).
    await expect(select).toHaveValue((before.engine as string | undefined) ?? 'claude')
    // Opening a section must never rewrite the config — the auto-save trap this
    // control deliberately avoids by saving only on a pick.
    expect(await serverDefaults(request)).toEqual(before)

    await expect(section).toContainText('Default engine')
    // One engine for everything Walnut starts: coding sessions AND its chats.
    await expect(section.getByTestId('default-engine-used-for'))
      .toContainText('Everything Walnut runs uses this: coding sessions, Ask Walnut and agent chats')
    await section.getByTestId('default-engine-used-for').locator('xpath=ancestor::div[contains(@class,"form-group")][1]')
      .screenshot({ path: '/tmp/smart-task-creation/engines-default.png' })

    // Every option is a distinct engine the catalog reported, Claude included,
    // and nothing is offered that the row itself marks as missing.
    const options = await select.locator('option').evaluateAll(
      (nodes) => nodes.map((n) => ({
        value: (n as HTMLOptionElement).value,
        label: (n as HTMLOptionElement).textContent ?? '',
      })),
    )
    expect(options.map((o) => o.value)).toContain('claude')
    expect(new Set(options.map((o) => o.value)).size).toBe(options.length)
    expect(options.filter((o) => o.label.includes('not installed'))).toEqual([])
  })

  test('a pick is saved, keeps the sibling defaults, and survives leaving the page', async ({ page, request }) => {
    const section = await openEnginesSection(page)
    const select = section.getByTestId('default-engine-select')
    // A second engine has to exist for this to mean anything; the fixture ships
    // codex in its catalog.
    await expect(select.locator('option[value="codex"]')).toHaveCount(1)
    const before = await serverDefaults(request)

    await select.selectOption('codex')
    await expect.poll(async () => (await serverDefaults(request)).engine).toBe('codex')
    // The siblings under `defaults` are what a whole-key replace would have eaten.
    const after = await serverDefaults(request)
    for (const key of Object.keys(before)) {
      if (key === 'engine') continue
      expect(after[key], key).toEqual(before[key])
    }

    // Leave and come back through real clicks: the row renders from the config,
    // so this is the assertion that the value was persisted, not just displayed.
    const reopened = await reopenEnginesSection(page)
    await expect(reopened.getByTestId('default-engine-select')).toHaveValue('codex')

    // Back to Claude, so every later spec in this fixture launches on what it expects.
    await reopened.getByTestId('default-engine-select').selectOption('claude')
    await expect.poll(async () => (await serverDefaults(request)).engine).toBe('claude')
  })

  test('the engine tabs below keep working after a pick (one section, two stores)', async ({ page, request }) => {
    const section = await openEnginesSection(page)
    await section.getByTestId('default-engine-select').selectOption('codex')
    await expect.poll(async () => (await serverDefaults(request)).engine).toBe('codex')
    // The tabs edit the ENGINE's own files; the picker above edits Walnut config.
    // A pick must not reset which tab is open or blank the rows.
    await section.getByTestId('engine-settings-tab-claude').click()
    await expect(section.getByTestId('engine-setting-row-alwaysThinkingEnabled')).toBeVisible({ timeout: 15_000 })
    await expect(section.getByTestId('default-engine-select')).toHaveValue('codex')
    await section.getByTestId('default-engine-select').selectOption('claude')
    await expect.poll(async () => (await serverDefaults(request)).engine).toBe('claude')
  })
})
