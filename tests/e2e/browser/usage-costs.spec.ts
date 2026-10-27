/**
 * Settings > Usage & Costs: two views (Walnut's own calls, coding agents),
 * dollars and tokens first, readable one-line rows, tests and one-offs folded,
 * how it is counted kept in one collapsed block. Runs in both engines:
 * WebKit with `PW_WEBKIT=1 ... --project=webkit`. Reads come from the fixture;
 * every write is refused so the page cannot change anything.
 */
import { test, expect, type Page } from '@playwright/test'
import { LONG_TITLE, routeCosts } from './usage-costs-fixture'

if (process.env.PW_WEBKIT) test.use({ browserName: 'webkit' })
test.setTimeout(120_000)

async function openUsage(page: Page) {
  const url = test.info().project.use.baseURL + '/'
  await page.evaluate((u) => { window.location.href = u }, url).catch(() => page.goto(url))
  await expect(page.locator('.app-shell')).toBeVisible({ timeout: 30_000 })
  await page.getByRole('link', { name: 'Settings', exact: true }).click()
  const nav = page.getByTestId('settings-nav-usage')
  await nav.scrollIntoViewIfNeeded()
  await nav.click()
  await expect(page.getByTestId('usage-total-cost')).toBeVisible({ timeout: 20_000 })
}

function localDay(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

test('both views show dollars first, switch periods, and keep the counting details out of the way', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('about:blank')
  const asked = await routeCosts(page)
  await openUsage(page)
  const pane = page.locator('.settings-pane')

  // Walnut is the default view, 7 days the default period: today and the six days before.
  const today = new Date(), weekAgo = new Date(); weekAgo.setDate(weekAgo.getDate() - 6)
  await expect.poll(() => asked.at(-1)?.search).toContain('view=walnut')
  expect(asked.at(-1)!.searchParams.get('start')).toBe(localDay(weekAgo))
  expect(asked.at(-1)!.searchParams.get('end')).toBe(localDay(today))
  await expect(page.getByTestId('usage-total-cost')).toContainText('$68.')
  await expect(pane.getByTestId('usage-group-feature')).toContainText('Personal AI chat')
  await expect(pane.getByTestId('usage-group-feature')).toContainText('Commit messages')
  await expect(pane.getByTestId('usage-group-task')).toHaveCount(0)
  // Eight rows show, the rest fold under one line that says what they add up to.
  await expect(pane.getByTestId('usage-group-feature').locator('.usage-more > summary').first()).toHaveText(/2 more · \$0\.0\d/)

  // The counting details sit in one collapsed block, never in the headline or on a row.
  const how = pane.getByTestId('usage-how')
  await expect(how).not.toHaveAttribute('open', '')
  await expect(pane.getByTestId('usage-summary')).not.toContainText(/verified|matched|reconcil/i)
  await how.locator(':scope > summary').click()
  await expect(how).toContainText('LiteLLM price list')
  await expect(how).toContainText('Matched.')

  await page.getByTestId('usage-view-agents').click()
  await expect.poll(() => asked.at(-1)?.searchParams.get('view')).toBe('agents')
  const tasks = pane.getByTestId('usage-group-task')
  await expect(tasks).toBeVisible()
  await expect(tasks.locator('.usage-line').first()).toContainText(LONG_TITLE.slice(0, 30))
  await expect(tasks).toContainText('140 more tasks')
  await expect(pane.getByTestId('usage-summary')).toContainText('14 requests with no public price (internal-model) are not in the total.')
  for (const id of ['engine', 'model', 'host', 'project']) await expect(pane.getByTestId(`usage-group-${id}`)).toBeVisible()
  await expect(pane.getByTestId('usage-group-engine')).toContainText('Codex')
  await expect(pane.getByTestId('usage-group-project')).toContainText('Inbox')

  // Tests and one-offs are one closed line until asked for.
  const short = pane.getByTestId('usage-short-sessions')
  await expect(short.locator(':scope > summary')).toHaveText(/12 short sessions \(tests and one-offs\) · \$2\.40/)
  await expect(short.getByText('Probe 1', { exact: true })).toBeHidden()
  await short.locator(':scope > summary').click()
  await expect(short.getByText('Probe 1', { exact: true })).toBeVisible()

  // A long title stays on one line and is cut, the full one in its tooltip.
  const label = tasks.locator('.usage-line-label').first()
  const fit = await label.evaluate((el) => ({ h: el.getBoundingClientRect().height, lh: parseFloat(getComputedStyle(el).lineHeight) || 18,
    cut: el.scrollWidth > el.clientWidth, title: el.getAttribute('title') }))
  expect(fit.h).toBeLessThan(fit.lh * 1.6)
  expect(fit.cut).toBe(true)
  expect(fit.title).toBe(LONG_TITLE)

  await page.getByTestId('usage-period-today').click()
  await expect.poll(() => asked.at(-1)?.searchParams.get('start')).toBe(localDay(today))
  expect(asked.at(-1)!.searchParams.get('end')).toBe(localDay(today))
  await page.getByTestId('usage-period-all').click()
  await expect.poll(() => asked.at(-1)?.searchParams.has('start')).toBe(false)
  await expect(page.getByTestId('usage-costs')).toHaveAttribute('data-view', 'agents')

  await page.getByTestId('usage-view-walnut').click()
  await expect(page.getByTestId('usage-costs')).toHaveAttribute('data-view', 'walnut')
  expect(asked.at(-1)!.searchParams.has('start')).toBe(false)

  const text = await pane.textContent()
  expect(text).not.toMatch(/[–—]/)
  expect(errors).toEqual([])
})

test('a task row opens its session on the home page', async ({ page }) => {
  await page.goto('about:blank')
  await routeCosts(page)
  await openUsage(page)
  await page.getByTestId('usage-view-agents').click()
  const row = page.getByTestId('usage-group-task').locator('.usage-line').nth(1)
  await row.locator('button').click()
  await expect.poll(() => new URL(page.url()).pathname).toBe('/')
})

test('the chart has a bar per day and its axis text is readable', async ({ page }) => {
  await page.goto('about:blank')
  await routeCosts(page)
  await openUsage(page)
  await page.getByTestId('usage-period-30d').click()
  const svg = page.locator('.usage-chart-svg').first()
  await expect(svg).toBeVisible()
  const axis = await svg.evaluate((el) => {
    const scale = el.getBoundingClientRect().width / 1000
    return Array.from(el.querySelectorAll('.usage-chart-axis')).map((t) => parseFloat(getComputedStyle(t).fontSize) * scale)
  })
  expect(axis.length).toBeGreaterThan(0)
  for (const px of axis) expect(px).toBeGreaterThanOrEqual(10.9)
})
