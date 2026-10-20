/**
 * The model picker's session cost line (SessionCostBlock), opened the way the
 * user opens it: the composer's `/model` control on a real session column.
 *
 * The first two tests answer GET /api/sessions/:id/cost with a payload shaped
 * like a real long-running session (three models, a tiered one, one model
 * without a price, five days of runtime); the third runs the real route against
 * the fixture server, whose seeded session has no transcript, and checks the
 * line settles on its reason instead of spinning.
 */
import { test, expect, type Page, type Locator } from '@playwright/test'
import fs from 'node:fs'
import { presetPanelView } from './todo-panel-helpers'
import { REAL_PANEL } from './draft-helpers'

const SHOTS = '/tmp/walnut-session-cost'
const SESSION_ID = 'pw-model-switch-session'

const COST = {
  sessionId: SESSION_ID, engine: 'claude', source: 'claude-transcript', status: 'partial',
  totalUsd: 29.3587, responses: 335, unpricedResponses: 4,
  firstAt: '2026-10-15T06:53:42.000Z', lastAt: '2026-10-20T18:15:20.000Z',
  apiDurationMs: 3_948_316,
  prices: { source: 'litellm', asOf: '2026-10-20T18:12:13.696Z' },
  models: [
    { model: 'claude-opus-5-5', speed: 'standard', responses: 195, costUsd: 23.4591, unpricedResponses: 0, longResponses: 0,
      webSearches: 0, usRegionResponses: 0,
      tokens: { input: 388, output: 164_120, cacheRead: 41_998_806, cacheWrite5m: 0, cacheWrite1h: 1_461_608, cacheWrite: 0 },
      rates: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, cacheWrite1h: 8 },
      priceSource: { kind: 'litellm', key: 'claude-opus-5-5', asOf: '2026-10-20T18:12:13.696Z' },
      firstAt: '2026-10-15T06:53:42.000Z', lastAt: '2026-10-20T18:15:20.000Z' },
    { model: 'gpt-6-1-sol', speed: 'standard', responses: 136, costUsd: 5.8996, unpricedResponses: 0, longResponses: 9,
      webSearches: 0, usRegionResponses: 0,
      tokens: { input: 20_656, output: 60_330, cacheRead: 16_158_435, cacheWrite5m: 0, cacheWrite1h: 0, cacheWrite: 1_315_152 },
      rates: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5, threshold: 272_000,
        long: { input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 }, singleCacheWrite: true },
      priceSource: { kind: 'litellm', key: 'gpt-6.1-sol', asOf: '2026-10-20T18:12:13.696Z' },
      firstAt: '2026-10-15T07:00:00.000Z', lastAt: '2026-10-19T07:00:00.000Z' },
    { model: 'some-unreleased-model', speed: 'standard', responses: 4, costUsd: null, unpricedResponses: 4,
      unpricedReason: 'no price for some-unreleased-model', longResponses: 0, webSearches: 0, usRegionResponses: 0,
      tokens: { input: 1_200, output: 900, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheWrite: 0 },
      firstAt: '2026-10-19T07:00:00.000Z', lastAt: '2026-10-19T08:00:00.000Z' },
  ],
}

async function openPicker(page: Page): Promise<Locator> {
  await presetPanelView(page)
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.locator('.todo-panel-item', { hasText: 'Model switch test task' }).first().click()
  const input = page.locator(`${REAL_PANEL} .chat-input-textarea`)
  await expect(input).toBeVisible({ timeout: 10_000 })
  await input.focus()
  await input.fill('/m')
  const palette = page.locator(`${REAL_PANEL} .command-palette`)
  await expect(palette).toBeVisible({ timeout: 5_000 })
  await palette.locator('.command-palette-item.command-palette-control', { hasText: 'model' }).dispatchEvent('mousedown')
  const picker = page.locator('body > .model-picker.model-picker-popout')
  await expect(picker).toBeVisible({ timeout: 5_000 })
  return picker
}

test.beforeAll(() => fs.mkdirSync(SHOTS, { recursive: true }))

test('shows the session total, what it leaves out, how long it ran, and each model\'s rates', async ({ page }, info) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.route(`**/api/sessions/${SESSION_ID}/cost`, (route) => route.fulfill({ json: COST }))
  await page.setViewportSize({ width: 1280, height: 860 })
  const picker = await openPicker(page)
  const block = picker.getByTestId('session-cost')
  await expect(block).toHaveAttribute('data-status', 'partial')
  await expect(block.getByTestId('session-cost-total')).toHaveText('$29.36 + 4 requests without a price')
  await expect(block.getByTestId('session-cost-times')).toHaveText('span 5d 11h · model time 1h 5m')

  // Opening lists every model, the most expensive first.
  await block.locator('.session-cost-head').click()
  const rows = block.getByTestId('session-cost-model')
  await expect(rows).toHaveCount(3)
  await expect(rows.nth(0).locator('.session-cost-model-name')).toHaveText('▸ Opus 5.5')
  await expect(rows.nth(0).getByTestId('session-cost-model-usd')).toHaveText('$23.46')
  await expect(rows.nth(1).locator('.session-cost-model-name')).toHaveText('▸ GPT-6.1 Sol')
  await expect(rows.nth(2).getByTestId('session-cost-model-usd')).toHaveText('no price')
  await expect(block).toContainText("Priced per request from Claude Code's own usage records (335 requests, subagents included).")

  // A model opens to the rates it was priced at, its tier, and where they came from.
  await rows.nth(1).locator('.session-cost-model-row').click()
  const sol = rows.nth(1).getByTestId('session-cost-model-detail')
  await expect(sol).toContainText('Per million tokens: $2 in · $10 out · $0.1 cache read · $2.5 cache write')
  await expect(sol).toContainText('Prompt above 272K: $4 in · $15 out · $0.2 cache read · $5 cache write (9 of 136 requests)')
  await expect(sol).toContainText('Price: LiteLLM price list (gpt-6.1-sol')
  await rows.nth(0).locator('.session-cost-model-row').click()
  await expect(rows.nth(0).getByTestId('session-cost-model-detail')).toContainText('$5 / $8 cache write (5m / 1h)')
  await rows.nth(2).locator('.session-cost-model-row').click()
  await expect(rows.nth(2).getByTestId('session-cost-model-detail')).toContainText('4 requests without a price: no price for some-unreleased-model')

  // Nothing in the block spills out of the picker.
  const pickerBox = (await picker.boundingBox())!
  for (const box of await rows.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().toJSON()))) {
    expect(box.right).toBeLessThanOrEqual(pickerBox.x + pickerBox.width + 1)
  }
  await block.screenshot({ path: `${SHOTS}/cost-open-${info.project.name}.png` })
  expect(errors).toEqual([])
})

test('an unreadable session says why, with nothing to open', async ({ page }) => {
  await page.route(`**/api/sessions/${SESSION_ID}/cost`, (route) => route.fulfill({ json: {
    sessionId: SESSION_ID, engine: 'goose', source: 'none', status: 'unavailable',
    reason: 'Goose keeps only session totals, without the cache detail a price needs.',
    totalUsd: null, responses: 0, unpricedResponses: 0, models: [], prices: { source: 'litellm' },
  } }))
  const picker = await openPicker(page)
  const block = picker.getByTestId('session-cost')
  await expect(block.getByTestId('session-cost-total')).toHaveText('not available')
  await expect(block.getByTestId('session-cost-reason')).toHaveText('Goose keeps only session totals, without the cache detail a price needs.')
  await expect(block.locator('.session-cost-head')).toBeDisabled()
})

test('the real route settles on an answer for a session with no transcript', async ({ page }) => {
  const picker = await openPicker(page)
  const block = picker.getByTestId('session-cost')
  await expect(block).not.toHaveAttribute('data-status', 'loading', { timeout: 40_000 })
  await expect(block).toHaveAttribute('data-status', /^(unavailable|empty)$/)
  await expect(block.getByTestId('session-cost-total')).not.toHaveText('calculating…')
})
