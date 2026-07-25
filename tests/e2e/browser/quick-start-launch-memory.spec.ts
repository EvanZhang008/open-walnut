/**
 * Per-directory launch memory in the Quick Start picker.
 *
 * working-dirs is mocked to carry `lastLaunch` for one dir; verifies:
 *  1. highlighting that dir previews its remembered model in the footer select
 *  2. highlighting a dir WITHOUT memory shows Auto (no leak between rows)
 *  3. confirming the remembered dir sends the model on /quick-start
 *  4. a user's explicit model pick beats the memory of a later-highlighted row
 */
import { test, expect, type Page, type Route } from '@playwright/test'

const rememberedCwd = '/Users/playwright/memory-fixture/projects/walnut'
const plainCwd = '/Users/playwright/memory-fixture/projects/scratch'
const rememberedModel = 'sonnet-1m' // legacy alias — present in the static SESSION_MODELS fallback
const now = new Date().toISOString()

async function fulfillWorkingDirs(route: Route): Promise<void> {
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      dirs: [
        { cwd: rememberedCwd, host: null, category: 'Work', count: 20, lastUsed: now, lastLaunch: { model: rememberedModel } },
        { cwd: plainCwd, host: null, category: 'Work', count: 10, lastUsed: now },
      ],
      hosts: [],
    }),
  })
}

/** The picker's outside-click listener attaches on a 100ms timer after open —
 *  elastic under parallel test load. Poll-click outside until it takes effect. */
async function clickOutsideUntilClosed(page: Page): Promise<void> {
  await expect(async () => {
    await page.locator('.main-page').click({ position: { x: 10, y: 10 } })
    await expect(page.locator('.session-path-selector')).toHaveCount(0, { timeout: 500 })
  }).toPass({ timeout: 10_000 })
}

async function openPicker(page: Page): Promise<void> {
  await page.route('**/api/sessions/working-dirs', fulfillWorkingDirs)
  // The fixture paths don't exist on the test machine's disk — mock the live
  // listing so pathValidity sees them as real (dismiss-confirm requires a
  // non-missing verdict; a missing path deliberately routes dismiss → close).
  await page.route('**/api/sessions/list-dirs**', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        dirs: [rememberedCwd, plainCwd],
        parent: '/Users/playwright/memory-fixture/projects/',
        exists: true,
      }),
    })
  })
  await page.goto('/')
  // Two "+ Session" buttons exist (TodoPanel launcher + chat QuickAccessBar) —
  // disambiguate via the QuickAccessBar pill's title.
  const pill = page.getByTitle(/start a Claude Code session there directly/)
  await expect(pill).toBeVisible({ timeout: 15_000 })
  await pill.click()
  await expect(page.locator('.sps-path-item')).toHaveCount(2, { timeout: 20_000 })
}

test('highlighted dir previews its remembered model; plain dir shows Auto', async ({ page }) => {
  await openPicker(page)

  const modelSelect = page.getByRole('combobox', { name: 'Session model' })
  const rows = page.locator('.sps-path-item')

  // Row 0 = remembered dir (highest count) — footer previews its model
  await expect(rows.nth(0).locator('.sps-path-cwd')).toHaveAttribute('title', rememberedCwd)
  await expect(modelSelect).toHaveValue(rememberedModel)

  // Move highlight to the plain dir → preview resets to Auto
  await page.keyboard.press('ArrowDown')
  await expect(rows.nth(1)).toHaveClass(/active/)
  await expect(modelSelect).toHaveValue('')

  // Back to the remembered dir → preview returns
  await page.keyboard.press('ArrowUp')
  await expect(modelSelect).toHaveValue(rememberedModel)

  await page.screenshot({ path: '/tmp/quick-start-launch-memory/preview.png' })
})

test('CLICKING the remembered dir (drill into edit mode) keeps the model preview', async ({ page }) => {
  // Regression: clicking a history row enters edit mode where the highlight
  // moves to live CHILD dirs — the preview must follow the TYPED path (the
  // launch target), not the highlighted child, else it resets to Auto and
  // reads as "my model wasn't remembered".
  await openPicker(page)

  const modelSelect = page.getByRole('combobox', { name: 'Session model' })
  await expect(modelSelect).toHaveValue(rememberedModel)

  await page.locator('.sps-path-item', {
    has: page.locator(`.sps-path-cwd[title="${rememberedCwd}"]`),
  }).first().click()

  // Now in edit mode with the path filled — preview must survive
  await expect(page.locator('.sps-search-input, .sps-path-input, input').first()).toBeVisible()
  await expect(modelSelect).toHaveValue(rememberedModel)
})

test('confirming the remembered dir sends its model on quick-start', async ({ page }) => {
  await openPicker(page)

  let sentBody: Record<string, unknown> | null = null
  await page.route('**/api/sessions/quick-start', async route => {
    sentBody = route.request().postDataJSON() as Record<string, unknown>
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ taskId: 'mem-task-1', task: { id: 'mem-task-1' } }),
    })
  })

  // Shift+Enter on the highlighted remembered row = select directly
  await page.keyboard.press('Shift+Enter')
  await expect(page.locator('.quick-start-bar')).toBeVisible()
  // Collapsed bar chip shows the remembered model label (Sonnet 1M), not Auto
  await expect(page.locator('.qsb-model-chip')).toHaveText('Sonnet 1M')

  await page.locator('.chat-input-textarea').fill('hello from memory test')
  await page.keyboard.press('Enter')

  await expect.poll(() => sentBody).not.toBeNull()
  expect(sentBody!.cwd).toBe(rememberedCwd)
  expect(sentBody!.model).toBe(rememberedModel)
})

test('dismissing (outside click) after picking a path confirms it as Quick Start', async ({ page }) => {
  await openPicker(page)

  // Click a history row → edit mode with the path filled
  await page.locator('.sps-path-item', {
    has: page.locator(`.sps-path-cwd[title="${rememberedCwd}"]`),
  }).first().click()

  // Click outside the popover — the pick must become the Quick Start target
  // (no ✓/⇧Enter needed), carrying the remembered model. The outside-click
  // listener attaches on a 100ms timer (elastic under parallel load), so
  // poll-click until the popover actually closes.
  await clickOutsideUntilClosed(page)
  await expect(page.locator('.quick-start-bar')).toBeVisible()
  await expect(page.locator('.qsb-path')).toHaveText(rememberedCwd)
  await expect(page.locator('.qsb-model-chip')).toHaveText('Sonnet 1M')
})

test('dismissing with no path picked still just closes (no phantom bar)', async ({ page }) => {
  await openPicker(page)
  // Browse mode, nothing typed — outside click closes without a quick-start bar
  await clickOutsideUntilClosed(page)
  await expect(page.locator('.session-path-selector')).toHaveCount(0)
  await expect(page.locator('.quick-start-bar')).toHaveCount(0)
})

test('panel height is fixed — drilling into a dir with few children must not shrink it', async ({ page }) => {
  await openPicker(page)
  const panel = page.locator('.session-path-selector')
  const browseBox = await panel.boundingBox()

  // Drill into a dir (edit mode; live listing likely empty in fixture) — height stays
  await page.locator('.sps-path-item', {
    has: page.locator(`.sps-path-cwd[title="${rememberedCwd}"]`),
  }).first().click()
  await page.waitForTimeout(500)
  const editBox = await panel.boundingBox()
  expect(editBox!.height).toBe(browseBox!.height)
})

test('explicit user pick beats the remembered model', async ({ page }) => {
  await openPicker(page)

  const modelSelect = page.getByRole('combobox', { name: 'Session model' })
  await expect(modelSelect).toHaveValue(rememberedModel)

  // User explicitly resets to Auto — memory must NOT re-apply on highlight moves
  await modelSelect.selectOption('')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowUp')
  await expect(modelSelect).toHaveValue('')

  let sentBody: Record<string, unknown> | null = null
  await page.route('**/api/sessions/quick-start', async route => {
    sentBody = route.request().postDataJSON() as Record<string, unknown>
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ taskId: 'mem-task-2', task: { id: 'mem-task-2' } }),
    })
  })

  await page.keyboard.press('Shift+Enter')
  await expect(page.locator('.quick-start-bar')).toBeVisible()
  await expect(page.locator('.qsb-model-chip')).toHaveText('Auto')

  await page.locator('.chat-input-textarea').fill('explicit auto wins')
  await page.keyboard.press('Enter')

  await expect.poll(() => sentBody).not.toBeNull()
  expect(sentBody!.model).toBeUndefined()
})
