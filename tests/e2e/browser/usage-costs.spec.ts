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
  // A request with no model name says so, instead of naming a model called "unknown".
  await expect(pane.getByTestId('usage-unpriced')).toHaveText(
    'Not in the total: 2 requests from Task overview upkeep recorded no model name, so they have no price.')
  // Every breakdown row carries its requests, tokens and share under its amount.
  await expect(pane.getByTestId('usage-group-feature').locator('.usage-line').first()).toContainText(/412 requests · [\d.]+[KMB]? tokens · \d+% of the cost/)
  // The Walnut view has no engines.
  await expect(pane.getByRole('radiogroup', { name: 'Engine' })).toHaveCount(0)
  await how.locator(':scope > summary').click()
  await expect(how).toContainText('LiteLLM price list')
  await expect(how).toContainText('Matched.')

  await page.getByTestId('usage-view-agents').click()
  await expect.poll(() => asked.at(-1)?.searchParams.get('view')).toBe('agents')
  const tasks = pane.getByTestId('usage-group-task')
  await expect(tasks).toBeVisible()
  await expect(tasks.locator('.usage-line').first()).toContainText(LONG_TITLE.slice(0, 30))
  await expect(tasks).toContainText('140 more tasks')
  await expect(pane.getByTestId('usage-unpriced')).toHaveText('Not in the total: 14 requests to internal-model (Claude Code) have no public price.')
  await expect(page.getByTestId('usage-engine-all')).toHaveAttribute('aria-checked', 'true')
  expect(asked.at(-1)!.searchParams.has('engine')).toBe(false)
  await expect(tasks.locator('.usage-line').first()).toContainText(/Claude Code · .* · 2,000 requests · [\d.]+[KMB]? tokens/)
  await expect(tasks).toContainText('21,000 requests · 195.0M tokens')
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

test('the engine filter counts one engine, says which, and drops a late reply for another', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('about:blank')
  let release: (() => void) | undefined
  let holdNext = false
  const asked = await routeCosts(page, (url) => {
    if (!holdNext || url.searchParams.get('engine') !== 'codex') return undefined
    holdNext = false
    return new Promise<void>((resolve) => { release = resolve })
  })
  await openUsage(page)
  const pane = page.locator('.settings-pane')
  await page.getByTestId('usage-view-agents').click()
  const costs = page.getByTestId('usage-costs')
  await expect(costs).toHaveAttribute('data-view', 'agents')
  await expect(costs).toHaveAttribute('data-engine', 'all')
  const choice = pane.getByRole('radiogroup', { name: 'Engine' })
  await expect(choice.getByRole('radio')).toHaveText(['All engines', 'Claude Code', 'Codex', 'OpenCode'])
  await expect(pane.getByTestId('usage-scope')).toHaveCount(0)

  await page.getByTestId('usage-engine-codex').click()
  await expect.poll(() => asked.at(-1)?.searchParams.get('engine')).toBe('codex')
  await expect(costs).toHaveAttribute('data-engine', 'codex')
  await expect(page.getByTestId('usage-engine-codex')).toHaveAttribute('aria-checked', 'true')
  await expect(pane.getByTestId('usage-scope')).toHaveText('Codex sessions only')
  await expect(page.getByTestId('usage-total-cost')).toContainText('Codex cost')
  await expect(page.getByTestId('usage-total-cost')).toContainText('$810.00')
  // One engine: no "By engine" group; every list names the engine and holds only its sessions.
  await expect(pane.getByTestId('usage-group-engine')).toHaveCount(0)
  const tasks = pane.getByTestId('usage-group-task')
  await expect(tasks.locator('.settings-group-title')).toContainText('By task · Codex')
  await expect(tasks.locator('.usage-line')).toHaveCount(1)
  await expect(tasks).toContainText('Coding task 4')
  await expect(pane.getByTestId('usage-group-model')).toContainText('gpt-6.1-sol')
  await expect(pane.getByTestId('usage-short-sessions')).toHaveCount(0)

  await page.getByTestId('usage-engine-opencode').click()
  await expect(costs).toHaveAttribute('data-engine', 'opencode')
  await expect(pane).toContainText('No OpenCode sessions in this period.')

  // A slow Codex reply that lands after All was picked is not shown as All.
  holdNext = true
  await page.getByTestId('usage-engine-codex').click()
  await expect.poll(() => release !== undefined).toBe(true)
  await page.getByTestId('usage-engine-all').click()
  await expect(costs).toHaveAttribute('data-engine', 'all')
  await expect(pane.getByTestId('usage-group-engine')).toBeVisible()
  release!()
  await page.waitForTimeout(300)
  await expect(costs).toHaveAttribute('data-engine', 'all')
  await expect(page.getByTestId('usage-total-cost')).toContainText('Estimated cost')
  expect(asked.at(-1)!.searchParams.has('engine')).toBe(false)

  // The Walnut view never sends an engine.
  await page.getByTestId('usage-view-walnut').click()
  await expect(costs).toHaveAttribute('data-view', 'walnut')
  expect(asked.at(-1)!.searchParams.has('engine')).toBe(false)
  expect(errors).toEqual([])
})

test('the Custom period opens in full above the card edge, applies a range and closes on an outside press', async ({ page }) => {
  await page.goto('about:blank')
  const asked = await routeCosts(page)
  await openUsage(page)
  const trigger = page.getByTestId('usage-period-custom')
  for (const size of [{ width: 1280, height: 800 }, { width: 900, height: 560 }]) {
    await page.setViewportSize(size)
    await trigger.scrollIntoViewIfNeeded()
    await trigger.click()
    const pop = page.getByTestId('usage-daterange-pop')
    await expect(pop).toBeVisible()
    // It opens on the whole range there is data for.
    await expect(pop.locator('input[type="date"]').first()).toHaveValue('2026-09-01')
    await expect(pop.locator('input[type="date"]').nth(1)).toHaveValue('2026-09-23')
    await expect(pop.getByRole('button', { name: 'Apply' })).toBeInViewport({ ratio: 1 })
    const fit = await pop.evaluate((el) => {
      const r = el.getBoundingClientRect()
      const clippedBy: string[] = []
      for (let a = el.parentElement; a; a = a.parentElement) {
        const cs = getComputedStyle(a)
        if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue
        const b = a.getBoundingClientRect()
        if (a !== document.body && a !== document.documentElement
          && (r.left < b.left - 0.5 || r.right > b.right + 0.5 || r.top < b.top - 0.5 || r.bottom > b.bottom + 0.5)) clippedBy.push(a.className)
      }
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, w: window.innerWidth, h: window.innerHeight,
        inPane: !!el.closest('.settings-pane, .settings-group'), clippedBy, fullHeight: el.scrollHeight <= el.clientHeight + 1 }
    })
    expect(fit.left).toBeGreaterThanOrEqual(0)
    expect(fit.top).toBeGreaterThanOrEqual(0)
    expect(fit.right).toBeLessThanOrEqual(fit.w)
    expect(fit.bottom).toBeLessThanOrEqual(fit.h)
    expect(fit.inPane).toBe(false)
    expect(fit.clippedBy).toEqual([])
    expect(fit.fullHeight).toBe(true)
    // A press inside keeps it open; a press outside closes it.
    await pop.locator('input[type="date"]').first().click()
    await expect(pop).toBeVisible()
    await page.getByTestId('usage-summary').click({ position: { x: 10, y: 10 } })
    await expect(pop).toHaveCount(0)
  }

  await trigger.click()
  const pop = page.getByTestId('usage-daterange-pop')
  const [from, to] = [pop.locator('input[type="date"]').nth(0), pop.locator('input[type="date"]').nth(1)]
  await expect(from).toHaveAttribute('min', '2026-09-01')
  await expect(to).toHaveAttribute('max', '2026-09-23')
  await from.fill('2026-09-10')
  await to.fill('2026-09-05')
  await expect(pop.getByRole('button', { name: 'Apply' })).toBeDisabled()
  await to.fill('2026-09-12')
  await pop.getByRole('button', { name: 'Apply' }).click()
  await expect(pop).toHaveCount(0)
  await expect.poll(() => asked.at(-1)?.searchParams.get('start')).toBe('2026-09-10')
  expect(asked.at(-1)!.searchParams.get('end')).toBe('2026-09-12')
  await expect(trigger).toHaveText(/09-10 to 09-12/)
  await expect(trigger).toHaveClass(/active/)
  // Escape closes it too.
  await trigger.click()
  await expect(pop).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(pop).toHaveCount(0)
})
