/**
 * The engine split, as a person uses it:
 *   - Settings → Sessions, "Share new tasks": checking two engines turns it on and writes
 *     `defaults.engine_split` with the other `defaults` keys kept; unchecking one turns it off.
 *   - Settings → Usage & Costs, "Engines compared": engines are columns, metrics are rows, the
 *     best value of a ranked row is marked, a column with few finished tasks says so, the
 *     project filter asks the server again, and the tasks behind the numbers open their task.
 * The comparison reads a routed fixture at real density (three engines, 60 tasks), like
 * usage-costs.spec.ts; the settings half writes the fixture server's real config.
 * WebKit: `PW_WEBKIT=1 ... --project webkit`.
 */
import { devices, test, expect, type APIRequestContext, type Page } from '@playwright/test'
import path from 'node:path'
import { openSessionsSection } from './engine-settings-helpers'
import { routeCosts } from './usage-costs-fixture'

if (process.env.PW_WEBKIT) test.use({ browserName: 'webkit', userAgent: devices['Desktop Safari'].userAgent })
test.describe.configure({ mode: 'serial' })
test.setTimeout(120_000)

const SHOTS = path.join(process.env.WALNUT_TASK_DIR || '/tmp', 'shots')

async function serverDefaults(request: APIRequestContext): Promise<Record<string, unknown>> {
  const body = await (await request.get('/api/config')).json() as { config?: { defaults?: Record<string, unknown> } }
  return body.config?.defaults ?? {}
}

function row(key: string, label: string, done: number, extra: Record<string, unknown> = {}) {
  return { key, engine: key.split('|')[0], family: key.split('|')[1], label, done, open: 2, split: 0, medianHours: 3.2, costUsd: done * 40,
    medianCostUsd: 38, tokens: done * 9e7, medianTokens: 8.5e7, reviewsPerTask: 2.4, reviewCostPerTask: 9, followUpsPerTask: 1.1, reopens: 2, errored: 1,
    reopenedShare: 0.06, erroredShare: 0.03, partialCost: 0, ...extra }
}

function engines(project: string | null) {
  const rows: Record<string, unknown>[] = [
    row('claude|Claude', 'Claude Code · Claude', project ? 20 : 34, { split: 5 }),
    row('codex|GPT', 'Codex · GPT', 6, { partialCost: 0,  medianHours: 1.9, medianCostUsd: 12.5, medianTokens: 3.1e7, reviewsPerTask: 3.1, reviewCostPerTask: 6.5, followUpsPerTask: 0.6, split: 6, switched: 2, errored: 3, erroredShare: 0.38 }),
    row('claude|GPT', 'Claude Code · GPT', 3, { medianHours: 5.5, medianCostUsd: 21, reviewsPerTask: 1.5, followUpsPerTask: 2 }),
    // A fourth engine whose model has no price: its cost is a floor and never "cheapest".
    row('opencode|Other', 'OpenCode · Other', 7, { medianCostUsd: null, medianTokens: null, partialCost: 7, noUsage: 7, medianHours: 2.5, reviewsPerTask: 2.9, erroredShare: 0.1 }),
  ]
  const tasks = Array.from({ length: 60 }, (_, i) => ({
    taskId: `t-${i}`, title: i === 0 ? 'Settings: share new tasks between engines and compare them on Usage & Costs' : `Task number ${i}`,
    project: i % 3 ? 'Walnut' : 'Walnut Idea', key: rows[i % 3].key, done: i % 7 !== 0, hours: i % 7 ? 1 + i / 4 : null,
    costUsd: 5 + i, tokens: 1e6 * i, reviews: i % 4, reviewCostUsd: (i % 4) * 2, followUps: i % 3, reopens: i % 9 === 0 ? 1 : 0, errored: i % 11 === 0, split: i % 2 === 0,
  }))
  return { range: { start: null, end: null }, rows, tasks, taskCount: 75, projects: [{ project: 'Walnut', tasks: 40 }, { project: 'Walnut Idea', tasks: 20 }],
    split: { on: true, entries: [{ key: 'claude', label: 'Claude Code · Claude', weight: 1 }, { key: 'codex', label: 'Codex · GPT', weight: 1 }] } }
}

async function openUsage(page: Page) {
  await page.goto('/')
  await expect(page.locator('.app-shell')).toBeVisible({ timeout: 30_000 })
  await page.getByRole('link', { name: 'Settings', exact: true }).click()
  const nav = page.getByTestId('settings-nav-usage')
  await nav.scrollIntoViewIfNeeded()
  await nav.click()
}

test('Share new tasks: two engines turn it on, the other defaults stay, one turns it off', async ({ page, request }) => {
  const before = await serverDefaults(request)
  const section = await openSessionsSection(page)
  const state = section.getByTestId('engine-split-state')
  await expect(state).toHaveText('Off')
  const boxes = section.locator('input[type="checkbox"][data-testid^="engine-split-"]')
  expect(await boxes.count()).toBeGreaterThanOrEqual(2)
  await boxes.nth(0).check()
  await expect(state).toHaveText('Off')
  await boxes.nth(1).check()
  await expect(state).toHaveText('On')
  await expect.poll(async () => ((await serverDefaults(request)).engine_split as unknown[] | undefined)?.length).toBe(2)
  const after = await serverDefaults(request)
  for (const k of ['priority', 'platform', 'project', 'engine']) expect(after[k]).toEqual(before[k])
  await section.getByTestId('engine-split-row').scrollIntoViewIfNeeded()
  await page.screenshot({ path: path.join(SHOTS, `split-settings-${test.info().project.name}.png`), clip: await section.boundingBox().then((b) => b ? { x: b.x, y: b.y, width: Math.min(b.width, 1280), height: Math.min(b.height, 700) } : undefined) })
  await boxes.nth(1).uncheck()
  await expect(state).toHaveText('Off')
  await expect.poll(async () => ((await serverDefaults(request)).engine_split as unknown[] | undefined)?.length).toBe(1)
  await boxes.nth(0).uncheck()
  await expect.poll(async () => ((await serverDefaults(request)).engine_split as unknown[] | undefined)?.length).toBe(0)
})

test('Engines compared: engines side by side, the best marked, a project filter, the tasks behind it', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await routeCosts(page)
  const asked: (string | null)[] = []
  let onlyOne = false
  const splitAsked: (string | null)[] = []
  await page.route('**/api/usage/engines**', (route) => {
    const url = new URL(route.request().url())
    const project = url.searchParams.get('project')
    asked.push(project)
    const mode = url.searchParams.get('split')
    splitAsked.push(mode)
    // The server's 'auto': the split is on and assigned 11 tasks here, so it counts only those.
    const json = { ...engines(project), splitOnly: mode === '1' || mode === 'auto', splitTasks: 11, auto: true }
    return route.fulfill({ json: onlyOne ? { ...json, projects: [{ project: 'Walnut', tasks: 40 }] } : json })
  })
  // Update now asks the server to collect; here it answers at once, as a finished collection.
  await page.route('**/api/usage/collect', (route) => route.fulfill({ status: 202, json: { running: false } }))
  await openUsage(page)
  const card = page.getByTestId('usage-engines')
  await card.scrollIntoViewIfNeeded()
  await expect(card.getByTestId('usage-engines-split')).toContainText('New tasks are shared: Claude Code · Claude 1 : Codex · GPT 1')
  // The split assigned 11 tasks here (two columns' worth): the card counts only those, a fair test.
  await expect.poll(() => splitAsked.at(-1)).toBe('auto')
  await expect(card.getByTestId('usage-engines-split-only')).toHaveAttribute('aria-checked', 'true')
  await expect(card.getByTestId('usage-engines-bias')).toHaveCount(0)
  await card.getByTestId('usage-engines-all').click()
  await expect.poll(() => splitAsked.at(-1)).toBe(null)
  await expect(card.getByTestId('usage-engines-bias')).toBeVisible()
  const table = card.getByTestId('usage-engines-table')
  await expect(table.locator('thead th')).toHaveText(['', 'Claude Code · Claude', 'Codex · GPT', 'Claude Code · GPTfew', 'OpenCode · Other'])
  const cell = (metric: string, col: number) => table.locator(`tr[data-metric="${metric}"] td`).nth(col)
  await expect(cell('done', 1)).toHaveText('34')
  await expect(cell('time', 2)).toHaveText('1.9 h')
  await expect(cell('time', 2)).toHaveAttribute('data-best', 'true')
  await expect(cell('cost', 2)).toHaveText('$12.50')
  await expect(cell('cost', 2)).toHaveAttribute('data-best', 'true')
  await expect(cell('cost', 4)).toHaveText('-')
  await expect(cell('cost', 4)).toHaveAttribute('data-partial', 'true')
  // No usage recorded for it: its tokens are unknown too, never the "best" zero.
  await expect(cell('tokens', 4)).toHaveText('-')
  await expect(cell('tokens', 4)).toHaveAttribute('title', '7 tasks had no usage recorded: their tokens are unknown')
  await expect(cell('tokens', 4)).not.toHaveAttribute('data-best', 'true')
  await expect(cell('switched', 2)).toHaveText('2')
  // "Claude Code · GPT" has 3 finished (few): it is never ranked, though its 1.5 reviews is lowest.
  await expect(cell('reviews', 1)).toHaveAttribute('data-best', 'true')
  await expect(table.locator('tr td:nth-child(4)[data-best]')).toHaveCount(0)
  await expect(cell('followups', 2)).toHaveAttribute('data-best', 'true')
  await expect(cell('errored', 2)).toHaveText('38%')
  await expect(cell('errored', 1)).toHaveAttribute('data-best', 'true')
  // Unranked rows (counts) mark nothing.
  await expect(table.locator('tr[data-metric="done"] td[data-best]')).toHaveCount(0)
  await card.screenshot({ path: path.join(SHOTS, `engines-card-${test.info().project.name}.png`) })

  await card.getByTestId('usage-engines-project').selectOption('Walnut')
  await expect(cell('done', 1)).toHaveText('20')
  expect(asked.at(-1)).toBe('Walnut')
  // A chosen project keeps its filter even when the period holds no other: there is a way back to all.
  onlyOne = true
  await page.getByTestId('usage-period-7d').click()
  await expect(card.getByTestId('usage-engines-project')).toBeVisible()
  await card.getByTestId('usage-engines-project').selectOption('*')
  await expect(cell('done', 1)).toHaveText('34')
  onlyOne = false

  const tasks = card.getByTestId('usage-engines-tasks')
  await expect(tasks.locator('summary')).toHaveText('The latest 60 of the 75 tasks behind these numbers')
  await tasks.locator('summary').click()
  await expect(tasks.locator('tr')).toHaveCount(60)
  await expect(tasks.locator('tr').first()).toContainText('Settings: share new tasks')
  await expect(tasks.locator('tr').first()).toContainText('Claude Code · Claude')
  // A task row opens its task from the keyboard too.
  await tasks.locator('tr').first().getByRole('button').focus()
  await expect(tasks.locator('tr').first().getByRole('button')).toBeFocused()
  // Update now reads the comparison again, not only the cost report.
  const before = asked.length
  await page.locator('.usage-refresh-btn').click()
  await expect.poll(() => asked.length).toBeGreaterThan(before)
  // Back to what 'auto' gives (the split's own tasks here): the card follows 'auto' again, not a fixed choice.
  await card.getByTestId('usage-engines-split-only').click()
  await expect.poll(() => splitAsked.at(-1)).toBe('auto')
  await card.getByTestId('usage-engines-defs').locator('summary').click()
  await expect(card.getByTestId('usage-engines-defs')).toContainText('From its first session starting to its first completion.')
  expect(errors).toEqual([])
})

test('Engines compared with the split turned off: its tasks can still be counted alone, and the choice shows', async ({ page }) => {
  await routeCosts(page)
  const modes: (string | null)[] = []
  await page.route('**/api/usage/engines**', (route) => {
    const mode = new URL(route.request().url()).searchParams.get('split')
    modes.push(mode)
    // Off now, so the server's 'auto' counts every task; 11 tasks it assigned while it was on remain.
    return route.fulfill({ json: { ...engines(null), split: { on: false, entries: [] }, splitOnly: mode === '1', splitTasks: 11, auto: false } })
  })
  await openUsage(page)
  const card = page.getByTestId('usage-engines')
  await card.scrollIntoViewIfNeeded()
  await expect(card.getByTestId('usage-engines-split')).toContainText('New tasks all run on the default engine')
  // 'auto' (or the "All tasks" the test before left in view memory): every task, and the choice shows.
  await expect.poll(() => modes.at(-1)).not.toBe('1')
  await expect(card.getByTestId('usage-engines-all')).toHaveAttribute('aria-checked', 'true')
  await card.getByTestId('usage-engines-split-only').click()
  await expect.poll(() => modes.at(-1)).toBe('1')
  await expect(card.getByTestId('usage-engines-split-only')).toHaveAttribute('aria-checked', 'true')
  // Kept across a visit elsewhere: back on the page it still counts the split's tasks, and says so.
  await page.getByRole('link', { name: 'Home', exact: true }).first().click()
  await page.getByRole('link', { name: 'Settings', exact: true }).click()
  await page.getByTestId('settings-nav-usage').click()
  await card.scrollIntoViewIfNeeded()
  await expect(card.getByTestId('usage-engines-split-only')).toHaveAttribute('aria-checked', 'true')
  expect(modes.at(-1)).toBe('1')
  await card.screenshot({ path: path.join(SHOTS, `engines-split-off-${test.info().project.name}.png`) })
})
