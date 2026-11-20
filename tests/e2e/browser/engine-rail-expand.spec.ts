/**
 * The model picker's engine rail, as a person uses it (ModelPicker.tsx ProviderRail):
 *   - It offers the engines Settings, Sessions turns on: by default Claude Code, Codex,
 *     OpenCode and Pi. The fixture turns every engine on for the engine specs, so the
 *     default list is driven here by answering GET /api/engines with those four marked.
 *   - Hovering the rail widens it over the models at once and shows each engine's name
 *     beside its icon; the pointer leaving narrows it again. Keyboard focus widens it too.
 *   - "More engines" opens Settings, Sessions, where an engine is turned on or off; Custom
 *     (ACP) is the one flipped here, because no other spec picks it on the real catalog.
 */
import { test, expect, type Locator, type Page } from '@playwright/test'
import { isolateUiPrefs } from './todo-panel-helpers'
import { draftEngineButton, draftModelPicker, openDraft } from './draft-helpers'

test.describe.configure({ mode: 'serial' })
test.setTimeout(120_000)

const DEFAULT_FOUR = ['claude', 'codex', 'opencode', 'pi']
const ALL = ['claude', 'codex', 'gemini', 'opencode', 'goose', 'pi', 'dsh', 'custom']

test.beforeEach(async ({ page }) => { await isolateUiPrefs(page) })

/** The real catalog, with the default four marked for the picker (a config naming none). */
async function answerDefaultFour(page: Page): Promise<void> {
  await page.route('**/api/engines', async (route) => {
    const res = await route.fetch()
    const body = await res.json() as { engines: Array<Record<string, unknown>> }
    for (const e of body.engines) e.inPicker = DEFAULT_FOUR.includes(String(e.id))
    await route.fulfill({ response: res, json: body })
  })
}

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
  await answerDefaultFour(page)
  await openHome(page)
  const panel = await openDraft(page)
  await draftEngineButton(page, panel, 'claude')
  const picker = draftModelPicker(page)
  const rail = picker.getByTestId('provider-rail')
  await expect(rail.locator('.provider-rail-item[data-provider]')).toHaveCount(4)
  expect(await rail.locator('.provider-rail-item[data-provider]').evaluateAll((els) => els.map((e) => e.getAttribute('data-provider')))).toEqual(DEFAULT_FOUR)
  for (const hidden of ['gemini', 'goose', 'dsh', 'custom']) await expect(rail.locator(`[data-provider="${hidden}"]`)).toHaveCount(0)

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

test('More engines opens Settings, and an engine turned on there joins the rail', async ({ page, request }) => {
  try {
    await openHome(page)
    let panel = await openDraft(page)
    await draftEngineButton(page, panel, 'claude')
    const picker = draftModelPicker(page)
    // The fixture shows every engine: Custom (ACP) is on the rail, locked until its command is set.
    await expect(picker.locator('[data-provider="custom"]')).toHaveCount(1)
    await picker.getByTestId('provider-rail-more').click()
    await expect(page).toHaveURL(/\/settings#sessions$/)
    await expect(picker).toHaveCount(0)
    const group = page.getByTestId('picker-engines-group')
    await expect(group).toBeVisible()
    const box = group.getByTestId('picker-engine-custom')
    await expect(box).toBeChecked()
    await box.uncheck()
    await expect.poll(async () => {
      const body = await (await request.get('/api/config')).json() as { config?: { session?: { picker_engines?: string[] } } }
      return body.config?.session?.picker_engines
    }).toEqual(ALL.filter((id) => id !== 'custom'))
    await expect(group.getByTestId('picker-engine-pi')).toBeChecked()

    // Home again (the sidebar link): the rail no longer offers it.
    await page.locator('.sidebar-nav a[href="/"]').first().click()
    panel = await openDraft(page)
    await draftEngineButton(page, panel, 'claude')
    await expect(draftModelPicker(page).locator('[data-provider="custom"]')).toHaveCount(0)
    await expect(draftModelPicker(page).locator('[data-provider="gemini"]')).toHaveCount(1)

    // On again in Settings (reached the same way, from the rail): back on the rail.
    await draftModelPicker(page).getByTestId('provider-rail-more').click()
    await expect(page).toHaveURL(/\/settings#sessions$/)
    await page.getByTestId('picker-engines-group').getByTestId('picker-engine-custom').check()
    await expect.poll(async () => {
      const body = await (await request.get('/api/config')).json() as { config?: { session?: { picker_engines?: string[] } } }
      return body.config?.session?.picker_engines
    }).toEqual(ALL)
    await page.locator('.sidebar-nav a[href="/"]').first().click()
    panel = await openDraft(page)
    await draftEngineButton(page, panel, 'custom')
  } finally {
    await request.put('/api/config', { data: { session: { picker_engines: ALL } } })
  }
})
