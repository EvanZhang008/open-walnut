/**
 * The model picker's engine rail, as a person uses it (ModelPicker.tsx ProviderRail):
 *   - It offers the engines Settings, Sessions turns on: by default the few common ones
 *     (DEFAULT_PICKER_ENGINES). The fixture keeps that default, as a person who just installed
 *     Walnut sees it, so this spec reads the rail as is.
 *   - Hovering the rail widens it over the models at once and shows each engine's name
 *     beside its icon; the pointer leaving narrows it again. Keyboard focus widens it too.
 *   - "More engines" opens Settings, Sessions, where an engine is turned on or off; Custom
 *     (ACP) is the one flipped here, because no other spec picks it on the real catalog.
 */
import { test, expect, type Locator, type Page } from '@playwright/test'
import { isolateUiPrefs } from './todo-panel-helpers'
import { draftEngineButton, draftModelPicker, openDraft, showEnginesInPicker } from './draft-helpers'

test.describe.configure({ mode: 'serial' })
test.setTimeout(120_000)

const DEFAULT_FOUR = ['claude', 'codex', 'opencode', 'pi']
/** Engines only Settings turns on (Evan, 2026-11-20: only the common engines in the picker, the rest in Settings). */
const SETTINGS_ONLY = ['gemini', 'goose', 'dsh', 'custom']

test.beforeEach(async ({ page }) => { await isolateUiPrefs(page) })

async function openHome(page: Page): Promise<void> {
  await page.goto('/')
  await expect(page.locator('.main-page')).toBeVisible({ timeout: 30_000 })
}

const railWidth = (rail: Locator) => rail.evaluate((el) => el.getBoundingClientRect().width)

/** An element's left edge once it stops moving (two reads 100 ms apart agree). */
async function settledLeft(el: Locator): Promise<number> {
  const left = () => el.evaluate((n) => n.getBoundingClientRect().left)
  let prev = await left()
  await expect.poll(async () => {
    await new Promise((r) => setTimeout(r, 100))
    const now = await left()
    const still = Math.abs(now - prev) < 0.5
    prev = now
    return still
  }).toBe(true)
  return prev
}

test('the rail shows the default four engines and widens with their names on hover', async ({ page }) => {
  await showEnginesInPicker(page, DEFAULT_FOUR)
  await openHome(page)
  const panel = await openDraft(page)
  await draftEngineButton(page, panel, 'claude')
  const picker = draftModelPicker(page)
  const rail = picker.getByTestId('provider-rail')
  await expect(rail.locator('.provider-rail-item[data-provider]')).toHaveCount(4)
  expect(await rail.locator('.provider-rail-item[data-provider]').evaluateAll((els) => els.map((e) => e.getAttribute('data-provider')))).toEqual(DEFAULT_FOUR)
  for (const hidden of ['antigravity', 'gemini', 'goose', 'dsh', 'custom']) await expect(rail.locator(`[data-provider="${hidden}"]`)).toHaveCount(0)

  // Narrow: icons only, the names hidden; the model pane beside it keeps its place.
  const pane = picker.locator('.model-picker-pane')
  // The popout settles its place once its catalog arrives: read the pane's left when two
  // reads a frame apart agree, then judge the hover against that.
  const paneLeft = await settledLeft(pane)
  expect(await railWidth(rail)).toBeLessThan(70)
  const piLabel = rail.locator('[data-provider="pi"] .provider-rail-label')
  await expect(piLabel).toHaveCSS('opacity', '0')

  // Hover: wide at once, every name shown, nothing beside it moved.
  await rail.locator('[data-provider="codex"]').hover()
  await expect.poll(() => railWidth(rail)).toBeGreaterThan(160)
  await expect(piLabel).toHaveCSS('opacity', '1')
  await expect(piLabel).toHaveText('Pi')
  await expect(rail.locator('[data-provider="claude"] .provider-rail-label')).toHaveText('Claude Code')
  await expect(rail.getByTestId('provider-rail-more').locator('.provider-rail-label')).toHaveText('More engines')
  expect(Math.abs((await settledLeft(pane)) - paneLeft)).toBeLessThan(0.5)

  // The pointer leaves: narrow again.
  await pane.hover({ position: { x: 300, y: 40 } })
  await expect.poll(() => railWidth(rail)).toBeLessThan(70)
  await expect(piLabel).toHaveCSS('opacity', '0')

  // A click on a name in the widened rail picks that engine.
  await rail.locator('[data-provider="opencode"]').hover()
  await rail.locator('[data-provider="opencode"]').click()
  await expect(rail.locator('[data-provider="opencode"]')).toHaveAttribute('aria-selected', 'true')

  // Keyboard: focus moving onto the rail widens it the same way.
  await pane.hover({ position: { x: 300, y: 40 } })
  await expect.poll(() => railWidth(rail)).toBeLessThan(70)
  await rail.locator('[data-provider="codex"]').focus()
  await page.keyboard.press('Shift+Tab')
  await page.keyboard.press('Tab')
  await expect.poll(() => railWidth(rail)).toBeGreaterThan(160)
})

type ConfigBody = { config?: { session?: { picker_engines?: string[] } } }

test('the rail as installed shows only the picker engines, never the ones Settings turns on', async ({ page, request }) => {
  const catalog = await (await request.get('/api/engines')).json() as { engines: Array<{ id: string; inPicker?: boolean }> }
  const shown = catalog.engines.filter((e) => e.inPicker || e.id === 'claude').map((e) => e.id)
  for (const id of SETTINGS_ONLY) expect(shown, `${id} is turned on only in Settings`).not.toContain(id)
  await openHome(page)
  const panel = await openDraft(page)
  await draftEngineButton(page, panel, 'claude')
  const rail = draftModelPicker(page).getByTestId('provider-rail')
  expect(await rail.locator('.provider-rail-item[data-provider]').evaluateAll((els) => els.map((e) => e.getAttribute('data-provider')))).toEqual(shown)
})

test('More engines opens Settings, and an engine turned on there joins the rail', async ({ page, request }) => {
  try {
    await openHome(page)
    let panel = await openDraft(page)
    await draftEngineButton(page, panel, 'claude')
    const picker = draftModelPicker(page)
    // As installed, Custom (ACP) is not on the rail: Settings turns it on.
    await expect(picker.locator('[data-provider="custom"]')).toHaveCount(0)
    await picker.getByTestId('provider-rail-more').click()
    await expect(page).toHaveURL(/\/settings#sessions$/)
    await expect(picker).toHaveCount(0)
    const group = page.getByTestId('picker-engines-group')
    await expect(group).toBeVisible()
    const box = group.getByTestId('picker-engine-custom')
    await expect(box).not.toBeChecked()
    await expect(group.getByTestId('picker-engine-pi')).toBeChecked()
    await box.check()
    await expect.poll(async () => ((await (await request.get('/api/config')).json()) as ConfigBody).config?.session?.picker_engines ?? [])
      .toContain('custom')

    // Home again (the sidebar link): the rail offers it, and still not the others Settings keeps.
    await page.locator('.sidebar-nav a[href="/"]').first().click()
    panel = await openDraft(page)
    await draftEngineButton(page, panel, 'custom')
    await expect(draftModelPicker(page).locator('[data-provider="gemini"]')).toHaveCount(0)

    // Off again in Settings (reached the same way, from the rail): gone from the rail.
    await draftModelPicker(page).getByTestId('provider-rail-more').click()
    await expect(page).toHaveURL(/\/settings#sessions$/)
    await page.getByTestId('picker-engines-group').getByTestId('picker-engine-custom').uncheck()
    await expect.poll(async () => ((await (await request.get('/api/config')).json()) as ConfigBody).config?.session?.picker_engines ?? [])
      .not.toContain('custom')
    await page.locator('.sidebar-nav a[href="/"]').first().click()
    panel = await openDraft(page)
    await draftEngineButton(page, panel, 'claude')
    await expect(draftModelPicker(page).locator('[data-provider="custom"]')).toHaveCount(0)
  } finally {
    // Back to the installed default: no list saved.
    await request.put('/api/config', { data: { session: { picker_engines: null } } })
  }
})
