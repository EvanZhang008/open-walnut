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
  totalUsd: 140.661, responses: 2003, unpricedResponses: 4,
  firstAt: '2026-10-15T06:53:42.000Z', lastAt: '2026-10-20T18:15:20.000Z',
  apiDurationMs: 3_948_316,
  prices: { source: 'litellm', asOf: '2026-10-20T18:12:13.696Z' },
  models: [
    // A real session's numbers (1,804 requests, 746 over 272K), recomputed by hand from its transcript.
    { model: 'gpt-6-1-sol', speed: 'standard', responses: 1804, costUsd: 117.2019, unpricedResponses: 0, longResponses: 746,
      webSearches: 0, usRegionResponses: 0,
      tokens: { input: 199_762, output: 828_792, cacheRead: 435_194_347, cacheWrite5m: 0, cacheWrite1h: 0, cacheWrite: 10_939_373 },
      rates: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5, threshold: 272_000,
        long: { input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 }, singleCacheWrite: true },
      tiers: [
        { tier: 'base', responses: 1058, costUsd: 40.196, lines: [
          { kind: 'input', count: 78_052, rate: 2, costUsd: 0.156104 },
          { kind: 'cacheWrite', count: 7_687_473, rate: 2.5, costUsd: 19.2186825 },
          { kind: 'cacheRead', count: 159_587_391, rate: 0.1, costUsd: 15.9587391 },
          { kind: 'output', count: 486_247, rate: 10, costUsd: 4.86247 },
        ] },
        { tier: 'long', responses: 746, costUsd: 77.0059, lines: [
          { kind: 'input', count: 121_710, rate: 4, costUsd: 0.48684 },
          { kind: 'cacheWrite', count: 3_251_900, rate: 5, costUsd: 16.2595 },
          { kind: 'cacheRead', count: 275_606_956, rate: 0.2, costUsd: 55.1213912 },
          { kind: 'output', count: 342_545, rate: 15, costUsd: 5.138175 },
        ] },
      ],
      priceSource: { kind: 'litellm', key: 'gpt-6.1-sol', asOf: '2026-10-20T18:12:13.696Z' },
      firstAt: '2026-10-15T07:00:00.000Z', lastAt: '2026-10-19T07:00:00.000Z' },
    { model: 'claude-opus-5-5', speed: 'standard', responses: 195, costUsd: 23.4591, unpricedResponses: 0, longResponses: 0,
      webSearches: 0, usRegionResponses: 0,
      tokens: { input: 388, output: 164_120, cacheRead: 41_998_806, cacheWrite5m: 0, cacheWrite1h: 1_461_608, cacheWrite: 0 },
      rates: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, cacheWrite1h: 8 },
      tiers: [{ tier: 'base', responses: 195, costUsd: 23.4591, lines: [
        { kind: 'input', count: 388, rate: 4, costUsd: 0.001552 },
        { kind: 'cacheWrite5m', count: 0, rate: 5, costUsd: 0 },
        { kind: 'cacheWrite1h', count: 1_461_608, rate: 8, costUsd: 11.692864 },
        { kind: 'cacheRead', count: 41_998_806, rate: 0.2, costUsd: 8.3997612 },
        { kind: 'output', count: 164_120, rate: 20, costUsd: 3.2824 },
        { kind: 'webSearch', count: 8, rate: 10, costUsd: 0.08 },
      ] }],
      priceSource: { kind: 'litellm', key: 'claude-opus-5-5', asOf: '2026-10-20T18:12:13.696Z' },
      firstAt: '2026-10-15T06:53:42.000Z', lastAt: '2026-10-20T18:15:20.000Z' },
    { model: 'some-unreleased-model', speed: 'standard', responses: 4, costUsd: null, unpricedResponses: 4,
      unpricedReason: 'no price for some-unreleased-model', longResponses: 0, webSearches: 0, usRegionResponses: 0,
      tokens: { input: 1_200, output: 900, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheWrite: 0 }, tiers: [],
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
  await expect(block.getByTestId('session-cost-total')).toHaveText('$141 + 4 requests without a price')
  await expect(block.getByTestId('session-cost-times')).toHaveText('span 5d 11h · model time 1h 5m')

  // Opening lists every model, the most expensive first.
  await block.locator('.session-cost-head').click()
  const rows = block.getByTestId('session-cost-model')
  await expect(rows).toHaveCount(3)
  await expect(rows.nth(0).locator('.session-cost-model-name')).toHaveText('▸ GPT-6.1 Sol')
  await expect(rows.nth(0).getByTestId('session-cost-model-usd')).toHaveText('$117')
  await expect(rows.nth(1).locator('.session-cost-model-name')).toHaveText('▸ Opus 5.5')
  await expect(rows.nth(2).getByTestId('session-cost-model-usd')).toHaveText('no price')
  await expect(block).toContainText("Priced per request from Claude Code's own usage records (2003 requests, subagents included).")

  // A model opens to its cost table: tokens x price per million = cost, one block per prompt tier.
  await rows.nth(0).locator('.session-cost-model-row').click()
  const sol = rows.nth(0).getByTestId('session-cost-table')
  const cells = (tr: Locator) => tr.locator('th, td').allInnerTexts()
  await expect(sol.locator('thead tr')).toHaveCount(1)
  expect(await cells(sol.locator('thead tr'))).toEqual(['', 'Tokens', 'Price / 1M', 'Cost'])
  const base = sol.locator('tbody[data-tier="base"]')
  expect(await cells(base.locator('tr.session-cost-tier'))).toEqual(['Prompt up to 272K · 1,058 requests', '$40.20'])
  expect(await cells(base.locator('tr[data-kind="cacheWrite"]'))).toEqual(['Cache write', '7.7M', '$2.5', '$19.22'])
  expect(await cells(base.locator('tr[data-kind="cacheRead"]'))).toEqual(['Cache read', '159.6M', '$0.1', '$15.96'])
  const long = sol.locator('tbody[data-tier="long"]')
  expect(await cells(long.locator('tr.session-cost-tier'))).toEqual(['Prompt over 272K · 746 requests', '$77.01'])
  expect(await cells(long.locator('tr[data-kind="input"]'))).toEqual(['Input', '121.7K', '$4', '$0.49'])
  expect(await cells(long.locator('tr[data-kind="cacheRead"]'))).toEqual(['Cache read', '275.6M', '$0.2', '$55.12'])
  expect(await cells(long.locator('tr[data-kind="output"]'))).toEqual(['Output', '342.5K', '$15', '$5.14'])
  await expect(sol.getByTestId('session-cost-table-total')).toHaveText('$117.20')
  const solDetail = rows.nth(0).getByTestId('session-cost-model-detail')
  await expect(solDetail).toContainText('A request whose prompt is over 272K tokens pays the higher prices on all of its tokens.')
  await expect(solDetail).toContainText('Prices: LiteLLM price list (gpt-6.1-sol')

  // Claude's two cache lifetimes are their own rows; an unused one and its $0 stay out.
  await rows.nth(1).locator('.session-cost-model-row').click()
  const opus = rows.nth(1).getByTestId('session-cost-table')
  await expect(opus.locator('tr.session-cost-tier')).toHaveCount(0)
  await expect(opus.locator('tr[data-kind="cacheWrite5m"]')).toHaveCount(0)
  expect(await cells(opus.locator('tr[data-kind="cacheWrite1h"]'))).toEqual(['Cache write (1h)', '1.5M', '$8', '$11.69'])
  expect(await cells(opus.locator('tr[data-kind="webSearch"]'))).toEqual(['Web search', '8 searches', '$10 / 1K', '$0.08'])
  await rows.nth(2).locator('.session-cost-model-row').click()
  await expect(rows.nth(2).getByTestId('session-cost-model-detail')).toContainText('4 requests without a price: no price for some-unreleased-model')
  await expect(rows.nth(2).getByTestId('session-cost-table')).toHaveCount(0)

  // Nothing in the block spills out of the picker.
  const pickerBox = (await picker.boundingBox())!
  for (const box of await block.locator('.session-cost-model, .session-cost-table').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().toJSON()))) {
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
