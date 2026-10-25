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
import { openHome } from './home-navigation-helpers'

const SHOTS = '/tmp/walnut-session-cost'
// openHome alone may take 90 s on a loaded machine; the default 30 s test budget was spent before the picker opened.
test.describe.configure({ timeout: 120_000 })
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
  await openHome(page, String(test.info().project.use.baseURL), 90_000)
  await page.locator('.todo-panel-item', { hasText: 'Model switch test task' }).first().click()
  const input = page.locator(`${REAL_PANEL} .chat-input-textarea`)
  await expect(input).toBeVisible({ timeout: 10_000 })
  await input.focus()
  await input.fill('/m')
  const palette = page.locator(`${REAL_PANEL} .command-palette`)
  await expect(palette).toBeVisible({ timeout: 15_000 })
  await palette.locator('.command-palette-item.command-palette-control', { hasText: 'model' }).dispatchEvent('mousedown')
  const picker = page.locator('body > .model-picker.model-picker-popout')
  // The picker shows once its catalog loads: at load 60, three WebKit workers saw it open just past 5 s.
  await expect(picker).toBeVisible({ timeout: 20_000 })
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

test('prices the same usage on other models, the picker\'s and popular ones', async ({ page }, info) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  const asked: string[][] = []
  await page.route(`**/api/sessions/${SESSION_ID}/cost`, (route) => route.fulfill({ json: { ...COST, status: 'priced', unpricedResponses: 0,
    totalUsd: 117.2019, models: [COST.models[0]] } }))
  const rates = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 }
  await page.route(`**/api/sessions/${SESSION_ID}/cost/compare**`, (route) => {
    asked.push((new URL(route.request().url()).searchParams.get('models') ?? '').split(',').filter(Boolean))
    return route.fulfill({ json: { sessionId: SESSION_ID, status: 'ok', responses: 1804, unknown: [], rows: [
      { id: 'deepseek-v4-flash', key: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash', group: 'popular', costUsd: 6.95, longResponses: 0, rates, assumptions: [], current: false, priceSource: { kind: 'litellm', key: 'deepseek-v4-flash' } },
      { id: 'kimi-k3', key: 'kimi-k3', label: 'Kimi K3', group: 'popular', costUsd: 176.41, longResponses: 0, rates, assumptions: ['cache writes at the input price (no cache write price listed)'], current: false, priceSource: { kind: 'litellm', key: 'moonshot/kimi-k3' } },
      { id: 'converse/global.openai.gpt-6.1-sol', key: 'gpt-6-1-sol', group: 'walnut', costUsd: 117.2019, longResponses: 746, rates: { ...rates, threshold: 272_000 }, assumptions: [], current: true, priceSource: { kind: 'litellm', key: 'gpt-6.1-sol' } },
      { id: 'claude-opus-5-5', key: 'claude-opus-5-5', group: 'walnut', costUsd: 191.93, longResponses: 0, rates, assumptions: [], current: false, priceSource: { kind: 'litellm', key: 'claude-opus-5-5' } },
    ] } })
  })
  await page.setViewportSize({ width: 1280, height: 860 })
  const picker = await openPicker(page)
  const block = picker.getByTestId('session-cost')
  await expect(block).toHaveAttribute('data-status', 'priced')
  await block.locator('.session-cost-head').click()
  const compare = block.getByTestId('session-cost-compare')
  // Nothing is asked until the section is opened.
  expect(asked).toEqual([])
  await compare.locator('.session-cost-compare-head').click()
  const table = compare.getByTestId('session-cost-compare-table')
  await expect(table).toBeVisible()
  // The picker's own models went along with the request.
  expect(asked.length).toBeGreaterThan(0)
  expect(asked.at(-1)!.length).toBeGreaterThan(0)
  const cells = (tr: Locator) => tr.locator('th, td').allInnerTexts()
  const walnut = table.locator('tbody[data-group="walnut"] tr:not(.session-cost-tier)')
  await expect(walnut).toHaveCount(2)
  expect(await cells(walnut.nth(0))).toEqual(['GPT-6.1 Sol · used in this session', '$117.20', 'same'])
  expect(await cells(walnut.nth(1))).toEqual(['Opus 5.5', '$191.93', '1.6x'])
  const popular = table.locator('tbody[data-group="popular"] tr:not(.session-cost-tier)')
  expect(await cells(popular.nth(0))).toEqual(['DeepSeek V4 Flash', '$6.95', '0.06x'])
  expect(await cells(popular.nth(1))).toEqual(['Kimi K3', '$176.41', '1.5x'])
  await expect(popular.nth(1)).toHaveAttribute('title', /\$1 in · \$2 out[\s\S]*cache writes at the input price/)
  await expect(table.locator('tbody[data-group="walnut"] tr.session-cost-tier')).toHaveText('In Walnut')
  await expect(table.locator('tbody[data-group="popular"] tr.session-cost-tier')).toHaveText('Popular, not in Walnut')
  await expect(compare).toContainText('read this as a guide')
  await compare.scrollIntoViewIfNeeded()
  await compare.screenshot({ path: `${SHOTS}/compare-${info.project.name}.png` })
  // Closing and opening again asks again (the session may have grown).
  const before = asked.length
  await compare.locator('.session-cost-compare-head').click()
  await expect(table).toHaveCount(0)
  await compare.locator('.session-cost-compare-head').click()
  await expect(compare.getByTestId('session-cost-compare-table')).toBeVisible()
  expect(asked.length).toBe(before + 1)
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

test('the budget sits under the cost: set from the picker, then shown as spent of limit, and paused when over', async ({ page }, info) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.route(`**/api/sessions/${SESSION_ID}/cost`, (route) => route.fulfill({ json: { ...COST, status: 'priced', unpricedResponses: 0,
    totalUsd: 117.2019, models: [COST.models[0]] } }))
  const budget = { limitUsd: null as number | null, spentUsd: null as number | null, state: 'unlimited', reason: null as string | null, revision: 0,
    updatedAt: null, responses: 0, unpricedResponses: 0, unpricedModel: null, pausedAt: null, pauseId: null as string | null, stopError: null, engine: 'codex' }
  let patches = 0
  await page.route(`**/api/usage/sessions/${SESSION_ID}`, (route) => route.fulfill({ json: {
    sessionId: SESSION_ID, title: 'Model switch test task', engine: 'codex', checkEverySec: 5, budget, checkedAt: null } }))
  await page.route(`**/api/usage/sessions/${SESSION_ID}/budget`, async (route) => {
    patches++
    const body = route.request().postDataJSON()
    Object.assign(budget, { limitUsd: body.limitUsd, revision: budget.revision + 1, spentUsd: 117.2019, responses: 1804,
      state: body.limitUsd !== null && body.limitUsd <= 117.2019 ? 'paused' : 'active', reason: body.limitUsd !== null && body.limitUsd <= 117.2019 ? 'limit' : null })
    await route.fulfill({ json: { sessionId: SESSION_ID, engine: 'codex', checkEverySec: 5, budget, checkedAt: new Date().toISOString() } })
  })
  await page.setViewportSize({ width: 1280, height: 860 })
  const picker = await openPicker(page)
  const row = picker.getByTestId('session-cost-budget')
  await expect(row.getByTestId('session-cost-budget-summary')).toHaveText('No budget')
  await row.getByRole('button', { name: 'Set budget' }).click()
  const dialog = page.getByRole('dialog', { name: 'Usage & Budget' })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('Checked at the end of each turn and every 5 s.')
  await dialog.getByRole('textbox', { name: 'Budget for this session (USD)' }).fill('200')
  await dialog.getByRole('button', { name: 'Save limit' }).click()
  await expect(dialog.getByText('Saved limit: $200.00')).toBeVisible()
  await expect(dialog.getByText('Remaining: $82.80')).toBeVisible()
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(row.getByTestId('session-cost-budget-summary')).toHaveText('$117.20 of $200.00')
  await expect(row.getByRole('button', { name: 'Change' })).toBeVisible()
  // Lowered under what it already spent: paused, and the line says so.
  await row.getByRole('button', { name: 'Change' }).click()
  await dialog.getByRole('textbox', { name: 'Budget for this session (USD)' }).fill('100')
  await dialog.getByRole('button', { name: 'Save limit' }).click()
  await expect(dialog.getByText('Paused at budget: $117.20 of $100.00').first()).toBeVisible()
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(row).toHaveAttribute('data-state', 'paused')
  await expect(row.getByTestId('session-cost-budget-summary')).toHaveText('Paused at budget: $117.20 of $100.00')
  await expect(page.locator(`${REAL_PANEL} .session-budget-status`)).toContainText('Paused at budget: $117.20 of $100.00')
  expect(patches).toBe(2)
  const pickerBox = (await picker.boundingBox())!
  const rowBox = (await row.boundingBox())!
  expect(rowBox.x + rowBox.width).toBeLessThanOrEqual(pickerBox.x + pickerBox.width + 1)
  await picker.screenshot({ path: `${SHOTS}/budget-row-${info.project.name}.png` })
  expect(errors).toEqual([])
})
