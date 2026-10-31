/**
 * Settings > Usage & Costs: one picture of what models cost (every coding agent
 * and Walnut itself), one smooth stacked chart with a Break down by switch
 * (agent, model, project, host), each choice per day, and a table under it that
 * follows the choice. Runs in both engines: WebKit with
 * `PW_WEBKIT=1 ... --project=webkit`. Reads come from the fixture; every write is
 * refused so the page cannot change anything.
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

const rowNames = (page: Page, id: string) => page.getByTestId(`usage-group-${id}`).locator('tbody tr .usage-bd-name')

test('one picture: dollars first, and every Break down by choice shows its lines per day', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('about:blank')
  // Start from no remembered choice, once: the reload below must keep what was picked.
  await page.addInitScript(() => {
    if (sessionStorage.getItem('usage-spec-fresh')) return
    localStorage.removeItem('walnut-usage-breakdown')
    sessionStorage.setItem('usage-spec-fresh', '1')
  })
  const asked = await routeCosts(page)
  await openUsage(page)
  const pane = page.locator('.settings-pane')

  // The whole picture over 30 days by default: today and the 29 days before.
  const today = new Date(), monthAgo = new Date(); monthAgo.setDate(monthAgo.getDate() - 29)
  await expect.poll(() => asked.at(-1)?.searchParams.get('view')).toBe('all')
  expect(asked.at(-1)!.searchParams.get('start')).toBe(localDay(monthAgo))
  expect(asked.at(-1)!.searchParams.get('end')).toBe(localDay(today))
  expect(asked.every((u) => !u.searchParams.has('engine'))).toBe(true)
  // No view or engine switch: one total with Walnut as one part of it.
  await expect(pane.getByRole('radiogroup', { name: 'Show' })).toHaveCount(0)
  await expect(pane.getByRole('radiogroup', { name: 'Engine' })).toHaveCount(0)
  await expect(page.getByTestId('usage-total-cost')).toContainText('Estimated cost')
  await expect(page.getByTestId('usage-average-day')).toContainText('Average day')

  const chart = page.getByTestId('usage-breakdown-chart')
  await expect(chart).toHaveAttribute('data-buckets', '30')
  await expect(page.getByTestId('usage-breakdown-agent')).toHaveAttribute('aria-checked', 'true')
  await expect(rowNames(page, 'agent')).toHaveText(['Claude Code', 'Codex', 'Walnut'])
  await expect(chart.locator('path.usage-bd-area')).toHaveCount(3)

  // Model: the five biggest are drawn and the rest are one Other layer; the table keeps every line.
  await page.getByTestId('usage-breakdown-model').click()
  await expect(page.getByTestId('usage-costs')).toHaveAttribute('data-breakdown', 'model')
  await expect(chart.locator('path.usage-bd-area')).toHaveCount(6)
  await expect(chart.locator('path[data-series="__other__"] title')).toHaveText('Other (6)')
  await expect(rowNames(page, 'model')).toHaveCount(8)
  await expect(page.getByTestId('usage-breakdown-more')).toHaveText(/^3 more · \$[\d,]+\.\d\d$/)
  await page.getByTestId('usage-breakdown-more').click()
  await expect(rowNames(page, 'model')).toHaveCount(11)

  // Project: Walnut's own calls are one line, a task with no project reads Inbox.
  await page.getByTestId('usage-breakdown-project').click()
  await expect(rowNames(page, 'project')).toHaveText(['Walnut', 'Notes', 'Walnut itself', 'Inbox'])
  await expect(page.getByTestId('usage-breakdown-more')).toHaveCount(0)
  // Host, by the name the user gave it.
  await page.getByTestId('usage-breakdown-host').click()
  await expect(rowNames(page, 'host')).toHaveCount(2)
  await expect(chart.locator('path.usage-bd-area')).toHaveCount(2)

  // Each row: cost, share, requests and its own trend over the same days.
  const first = page.getByTestId('usage-group-host').locator('tbody tr').first()
  await expect(first.locator('td').nth(2)).toHaveText('60%')
  await expect(first.locator('td').nth(3)).toHaveText('36,000')
  await expect(first.locator('.usage-bd-spark path')).toHaveCount(1)

  // The curves are smooth: every layer is cubic segments, no straight polyline corners.
  const d = await chart.locator('path.usage-bd-area').first().getAttribute('d')
  expect(d).toMatch(/^M[\d.]+,[\d.]+ C/)
  expect((d!.match(/ L/g) ?? []).length).toBe(1) // only the join from the top edge to the bottom one

  // Hovering a day lists that day's split, largest first.
  const box = (await chart.boundingBox())!
  await page.mouse.move(box.x + box.width * 0.6, box.y + 100)
  const tip = page.getByTestId('usage-breakdown-tip')
  await expect(tip).toBeVisible()
  await expect(tip.locator('.usage-bd-tip-row')).toHaveCount(2)
  await expect(tip.locator('.usage-bd-tip-head b')).toHaveText(/^\$[\d,]+\.\d\d$/)
  await page.mouse.move(box.x + box.width / 2, box.y + box.height + 200)
  await expect(tip).toHaveCount(0)

  // The choice is remembered the next time the page opens.
  await page.getByTestId('usage-breakdown-project').click()
  await openUsage(page)
  await expect(page.getByTestId('usage-breakdown-project')).toHaveAttribute('aria-checked', 'true')

  // The counting details sit in one collapsed block, never in the headline.
  const how = pane.getByTestId('usage-how')
  await expect(how).not.toHaveAttribute('open', '')
  await expect(pane.getByTestId('usage-summary')).not.toContainText(/verified|matched|reconcil/i)
  await expect(pane.getByTestId('usage-unpriced')).toHaveText('Not in the total: 14 requests to internal-model (Claude Code) have no public price.')
  await how.locator(':scope > summary').click()
  await expect(how).toContainText('LiteLLM price list')
  await expect(how).toContainText("Walnut: the Personal AI's chat")

  // The most expensive tasks follow, one line each, short sessions folded.
  const tasks = pane.getByTestId('usage-group-task')
  await expect(tasks.locator('.settings-group-title')).toContainText('Most expensive tasks')
  await expect(tasks.locator('.usage-line').first()).toContainText(LONG_TITLE.slice(0, 30))
  await expect(tasks).toContainText('140 more tasks')
  const short = pane.getByTestId('usage-short-sessions')
  await expect(short.locator(':scope > summary')).toHaveText(/12 short sessions \(tests and one-offs\) · \$2\.40/)
  const label = tasks.locator('.usage-line-label').first()
  const fit = await label.evaluate((el) => ({ h: el.getBoundingClientRect().height, lh: parseFloat(getComputedStyle(el).lineHeight) || 18,
    cut: el.scrollWidth > el.clientWidth, title: el.getAttribute('title') }))
  expect(fit.h).toBeLessThan(fit.lh * 1.6)
  expect(fit.cut).toBe(true)
  expect(fit.title).toBe(LONG_TITLE)

  // Periods: Today is one flat band, All time asks for no bounds.
  await page.getByTestId('usage-period-today').click()
  await expect.poll(() => asked.at(-1)?.searchParams.get('start')).toBe(localDay(today))
  await expect(chart).toHaveAttribute('data-buckets', '1')
  await expect(chart.locator('path.usage-bd-area')).not.toHaveCount(0)
  await page.getByTestId('usage-period-all').click()
  await expect.poll(() => asked.at(-1)?.searchParams.has('start')).toBe(false)
  await expect(chart).toHaveAttribute('data-buckets', '23')

  const text = await pane.textContent()
  expect(text).not.toMatch(/[\u2013\u2014]/)
  expect(errors).toEqual([])
})

test('a task row opens its session on the home page', async ({ page }) => {
  await page.goto('about:blank')
  await routeCosts(page)
  await openUsage(page)
  const row = page.getByTestId('usage-group-task').locator('.usage-line').nth(1)
  await row.locator('button').click()
  await expect.poll(() => new URL(page.url()).pathname).toBe('/')
})

test('the chart axis text is readable, and a click on a day opens that day', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('about:blank')
  const asked = await routeCosts(page)
  await openUsage(page)
  const chart = page.getByTestId('usage-breakdown-chart')
  await expect(chart).toHaveAttribute('data-buckets', '30')
  const sizes = await chart.locator('.usage-bd-tick').evaluateAll((els) => els.map((t) => parseFloat(getComputedStyle(t).fontSize)))
  expect(sizes.length).toBeGreaterThan(6)
  for (const px of sizes) expect(px).toBeGreaterThanOrEqual(10.9)
  // The x labels never overlap each other.
  const xs = await chart.locator('text.usage-bd-tick[text-anchor]').evaluateAll((els) => els
    .filter((t) => Number(t.getAttribute('y')) > 200).map((t) => { const r = t.getBoundingClientRect(); return [r.left, r.right] }))
  xs.sort((a, b) => a[0] - b[0])
  for (let i = 1; i < xs.length; i++) expect(xs[i][0]).toBeGreaterThan(xs[i - 1][1])

  const box = (await chart.boundingBox())!
  await page.mouse.click(box.x + box.width - 14, box.y + 100)
  const today = localDay(new Date())
  await expect.poll(() => asked.at(-1)?.searchParams.get('start')).toBe(today)
  expect(asked.at(-1)!.searchParams.get('end')).toBe(today)
  await expect(page.getByTestId('usage-period-custom')).toHaveClass(/active/)
  // The pointer stays on the chart while it turns into one day: the hover follows, nothing breaks.
  await expect(chart).toHaveAttribute('data-buckets', '1')
  await page.mouse.move(box.x + box.width / 2, box.y + 110)
  await expect(page.getByTestId('usage-breakdown-tip')).toBeVisible()
  // The same day again goes back to the month.
  await page.mouse.click(box.x + box.width / 2, box.y + 100)
  await expect(chart).toHaveAttribute('data-buckets', '30')
  expect(errors).toEqual([])
})

test('a slow reply for a period the user left is not shown for the new one', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('about:blank')
  let release: (() => void) | undefined
  let holdToday = false
  const today = localDay(new Date())
  const asked = await routeCosts(page, (url) => {
    if (!holdToday || url.searchParams.get('start') !== today || url.searchParams.get('end') !== today) return undefined
    holdToday = false
    return new Promise<void>((resolve) => { release = resolve })
  })
  await openUsage(page)
  const chart = page.getByTestId('usage-breakdown-chart')
  await expect(chart).toHaveAttribute('data-buckets', '30')
  holdToday = true
  await page.getByTestId('usage-period-today').click()
  await expect.poll(() => release !== undefined).toBe(true)
  await page.getByTestId('usage-period-7d').click()
  await expect(chart).toHaveAttribute('data-buckets', '7')
  release!()
  await page.waitForTimeout(300)
  await expect(chart).toHaveAttribute('data-buckets', '7')
  expect(asked.every((u) => u.searchParams.get('view') === 'all')).toBe(true)
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
