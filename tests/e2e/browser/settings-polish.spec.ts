/**
 * Settings polish: provider naming, disabled rows, Engines wrapping, usage
 * tables, button weights and keyboard reach. Same conventions as
 * settings-layout-fields.spec.ts: both engines, real nav clicks, config writes
 * intercepted so the fixture config never changes under another spec.
 */
import { test, expect, type Page, type Request } from '@playwright/test'

if (process.env.PW_WEBKIT) test.use({ browserName: 'webkit' })
test.setTimeout(120_000)
// The app keeps polling /api/config; an intercepted read can still be in flight
// when a test ends, and its route.fetch would fail the finished test.
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: 'ignoreErrors' }) })

const NAV = (id: string) => `settings-nav-${id}`

async function openSettings(page: Page, hash = '') {
  await page.goto(`/settings${hash}`)
  await expect(page.locator('.settings-nav')).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.settings-pane .settings-section').first()).toBeVisible({ timeout: 30_000 })
}

async function clickNav(page: Page, id: string) {
  const item = page.getByTestId(NAV(id))
  await item.scrollIntoViewIfNeeded()
  await item.click()
  await expect(item).toHaveAttribute('aria-current', 'page')
  await expect(page.locator('.settings-pane .settings-section').first()).toBeVisible({ timeout: 20_000 })
}

async function recordWrites(page: Page): Promise<string[]> {
  const writes: string[] = []
  await page.route('**/api/**', async (route) => {
    const req: Request = route.request()
    if (req.method() === 'GET') return route.fallback()
    writes.push(`${req.method()} ${new URL(req.url()).pathname} ${req.postData() ?? ''}`)
    if (req.url().includes('/api/config')) return route.fulfill({ status: 200, json: { ok: true } })
    return route.fallback()
  })
  return writes
}

async function expandAll(page: Page) {
  for (let pass = 0; pass < 3; pass++) {
    const n = await page.evaluate(() => {
      const closed = Array.from(document.querySelectorAll<HTMLElement>(
        '.settings-pane [aria-expanded="false"]:not([aria-haspopup]):not([role="combobox"])'))
        .filter((el) => el.getBoundingClientRect().height > 0 && !(el as HTMLButtonElement).disabled)
      closed.forEach((el) => el.click())
      return closed.length
    })
    if (!n) return
    await page.waitForTimeout(200)
  }
}

/** Opacity multiplied up the ancestor chain, as the eye sees it. */
async function effectiveOpacity(page: Page, selector: string): Promise<{ text: string; op: number }[]> {
  return page.evaluate((sel) => Array.from(document.querySelectorAll<HTMLElement>(sel))
    // Visually hidden inputs (opacity 0 under a drawn switch or segment) do not count.
    .filter((el) => el.getBoundingClientRect().height > 0 && getComputedStyle(el).opacity !== '0')
    .map((el) => {
      let op = 1
      for (let n: HTMLElement | null = el; n; n = n.parentElement) op *= parseFloat(getComputedStyle(n).opacity)
      return { text: (el.textContent ?? '').trim().slice(0, 40), op: Math.round(op * 100) / 100 }
    }), selector)
}

test('N01: a named claude-cli provider reads as Claude Code in Tasks, Engines and Advanced', async ({ page }) => {
  await recordWrites(page)
  await openSettings(page)
  await clickNav(page, 'tasks')
  await expect(page.getByTestId('smart-runner-default')).toHaveText('Claude Code')
  await expect(page.getByTestId('smart-runner-row')).not.toContainText('your API')
  await clickNav(page, 'engines')
  await expect(page.locator('.settings-pane')).not.toContainText('Small background jobs use an API instead')
  await clickNav(page, 'advanced')
  await expect(page.getByTestId('providers-summary')).toHaveText('Off')
  await expect(page.locator('.settings-pane')).not.toContainText('Unknown provider')
})

test('N02 N07: a disabled row is dimmed once, to 45%, inside disclosures too', async ({ page }) => {
  await recordWrites(page)
  await openSettings(page)
  await clickNav(page, 'advanced')
  await expandAll(page)
  await page.waitForTimeout(400)
  const adv = await effectiveOpacity(page, '.settings-pane .settings-row[aria-disabled="true"]')
  expect(adv.length).toBeGreaterThan(0)
  for (const r of adv) expect(r.op, r.text).toBeCloseTo(0.45, 2)
  await clickNav(page, 'triage')
  await page.waitForTimeout(300)
  for (const pane of ['triage', 'backup', 'heartbeat']) {
    if (pane !== 'triage') await clickNav(page, pane)
    await page.waitForTimeout(300)
    const rows = await effectiveOpacity(page, '.settings-pane .settings-row, .settings-pane .settings-row :is(input, button, [role="switch"])')
    for (const r of rows) expect(r.op, `${pane} ${r.text}`).toBeGreaterThanOrEqual(0.44)
    // Groups never fade as a whole: the card surface stays solid (N07).
    const groups = await effectiveOpacity(page, '.settings-pane .settings-group')
    for (const g of groups) expect(g.op, `${pane} ${g.text}`).toBe(1)
  }
  const dimmed = await effectiveOpacity(page, '.settings-pane .settings-row[aria-disabled="true"]')
  for (const r of dimmed) expect(r.op, r.text).toBeCloseTo(0.45, 2)
})

/** Per visible row: does the control sit under the label, and where. */
async function rowWraps(page: Page, sel: string) {
  return page.evaluate((s) => Array.from(document.querySelectorAll<HTMLElement>(s))
    .filter((r) => r.getBoundingClientRect().height > 0)
    .map((r) => {
      const row = r.getBoundingClientRect()
      const copy = r.querySelector<HTMLElement>(':scope > .settings-row-copy')!.getBoundingClientRect()
      // From a 600px group the actions wrapper is display: contents (subgrid
      // columns, N3-06), so the control and the Reset slot carry the geometry.
      const ctl = (r.querySelector<HTMLElement>('.engine-setting-control') ?? r.querySelector<HTMLElement>(':scope > .settings-row-actions'))!.getBoundingClientRect()
      const reset = r.querySelector<HTMLElement>('.engine-pane-reset-slot')?.getBoundingClientRect()
      const group = r.closest('.settings-group')!.getBoundingClientRect()
      const label = r.querySelector<HTMLElement>('.settings-row-label')!.getBoundingClientRect()
      return {
        label: (r.querySelector('.settings-row-label')?.textContent ?? '').trim(),
        wide: r.hasAttribute('data-wide'),
        wrapped: ctl.top >= copy.bottom - 1,
        copyShare: Math.round((copy.width / row.width) * 100) / 100,
        groupW: Math.round(group.width),
        ctlLeftVsLabel: Math.round(ctl.left - label.left),
        overflow: Math.round(Math.max(ctl.right, reset?.right ?? 0) - group.right),
      }
    }), sel)
}

for (const [w, h] of [[1280, 800], [900, 800], [720, 800]] as const) {
  test(`N04: Engines rows wrap by group width only (${w}px)`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h })
    await recordWrites(page)
    await openSettings(page)
    await clickNav(page, 'engines')
    await expect(page.locator('.engine-setting-row-pane').first()).toBeVisible({ timeout: 20_000 })
    await expandAll(page)
    const rows = await rowWraps(page, '.settings-pane .settings-row.engine-setting-row-pane')
    expect(rows.length).toBeGreaterThan(3)
    for (const r of rows) {
      const why = `${r.label} ${JSON.stringify(r)}`
      expect(r.overflow, why).toBeLessThanOrEqual(0)
      if (r.groupW < 360) continue
      // Free text (model ids, paths) always sits under its label, from the label's x (N3-07).
      if (r.wide) {
        expect(r.wrapped, why).toBe(true)
        expect(Math.abs(r.ctlLeftVsLabel), why).toBeLessThanOrEqual(1)
      } else if (r.groupW >= 600) {
        expect(r.wrapped, why).toBe(false)
      } else {
        // Under 600px a label keeps 45% of its row, or the control drops under it (N3-01).
        expect(r.wrapped || r.copyShare >= 0.45, why).toBe(true)
      }
    }
  })
}

test('N05 N06: plugin app and provider sub-rows are plain indented rows that say their state', async ({ page }) => {
  await recordWrites(page)
  await openSettings(page)
  await clickNav(page, 'plugin-store')
  await expect(page.locator('[data-testid^="plugin-row-"]').first()).toBeVisible({ timeout: 20_000 })
  const subRows = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>(
    '.settings-pane [data-testid^="plugin-app-row-"], .settings-pane [data-testid^="plugin-provider-"]'))
    .map((row) => {
      const group = row.closest('.settings-group')!
      const boxes: string[] = []
      for (let n = row.parentElement; n && n !== group; n = n.parentElement) {
        const cs = getComputedStyle(n)
        if (cs.backgroundColor !== 'rgba(0, 0, 0, 0)' || parseFloat(cs.borderTopWidth) > 0 || parseFloat(cs.borderRadius) > 0) boxes.push(n.className)
      }
      const indented = document.querySelector<HTMLElement>('.settings-pane .settings-row.settings-row-indent:not([data-testid^="plugin-app-row-"])')
      return {
        id: row.dataset.testid,
        boxes,
        pad: getComputedStyle(row).paddingLeft,
        refPad: indented ? getComputedStyle(indented).paddingLeft : null,
        help: (row.querySelector('.settings-row-help')?.textContent ?? '').trim(),
        tag: (row.querySelector('.settings-tag')?.textContent ?? '').trim(),
      }
    }))
  expect(subRows.length, 'fixture has a provider or an app sub-row').toBeGreaterThan(0)
  for (const r of subRows) {
    expect(r.boxes, r.id).toEqual([])
    if (r.refPad) expect(r.pad, r.id).toBe(r.refPad)
    if (r.id?.startsWith('plugin-provider-')) expect(r.help || r.tag, `${r.id} says its state`).not.toBe('')
  }
})

function usageWithCliRow() {
  const group = (name: string, cost: number, pct: number, tokens = true) => ({ name, cost_usd: cost,
    input_tokens: tokens ? 123456 : 0, output_tokens: tokens ? 23456 : 0, cache_read_tokens: tokens ? 3456789 : 0,
    cache_creation_tokens: tokens ? 45678 : 0, api_calls: 12, percentage: pct })
  return {
    summary: { total_cost: 60, session_cost: 1, input_tokens: 1, output_tokens: 1, cache_read_tokens: 1, cache_creation_tokens: 1, api_calls: 3 },
    daily: Array.from({ length: 14 }, (_, i) => ({ date: `2026-09-${String(10 + i).padStart(2, '0')}`, cost_usd: 1 + i, input_tokens: 1, output_tokens: 1 })),
    bySource: [group('claude-code', 45.47, 97.1, false), group('jev', 1.2, 2.9)],
    byModel: [group('example-model', 46.67, 100)],
    byAgent: [group('helper-agent', 2, 100)],
    recent: [],
    dateBounds: { min: '2026-09-01', max: '2026-09-23' },
  }
}

test('N09: usage headers and shares fit, unknown tokens are a dash, names capitalized, axis text >= 11px', async ({ page }) => {
  await recordWrites(page)
  await page.route('**/api/usage/overview**', (route) => route.fulfill({ json: usageWithCliRow() }))
  await openSettings(page)
  await clickNav(page, 'usage')
  const table = page.locator('.settings-usage-breakdown').first()
  await expect(table).toBeVisible({ timeout: 20_000 })
  const clipped = await table.evaluate((t) => Array.from(t.querySelectorAll<HTMLElement>('th, td'))
    .filter((c) => c.scrollWidth > c.clientWidth + 1).map((c) => c.textContent))
  expect(clipped).toEqual([])
  const cli = table.locator('tbody tr', { hasText: '45.47' })
  await expect(cli.locator('td').nth(2)).toHaveText('-')
  await expect(table.locator('tbody')).toContainText('Jev')
  await expect(table.locator('tbody')).not.toContainText(/\bjev\b/)
  const axis = await page.locator('.usage-chart-svg').first().evaluate((svg) => {
    const scale = svg.getBoundingClientRect().width / 1000
    return Array.from(svg.querySelectorAll('.usage-chart-axis')).map((t) => parseFloat(getComputedStyle(t).fontSize) * scale)
  })
  expect(axis.length).toBeGreaterThan(0)
  for (const px of axis) expect(px).toBeGreaterThanOrEqual(10.9)
})

test('N08 N26: accuracy chips stay on one line, the list is capped, Refresh sits in the pane header', async ({ page }) => {
  await recordWrites(page)
  const long = '/Users/example/workplace/a-very-long-project-folder-name/with/many/nested/levels/src/app'
  await page.route('**/api/tasks/suggest-accuracy**', (route) => route.fulfill({ json: {
    commits: 25, since: '2026-08-01T10:00:00Z',
    fields: { project: { kept: 1, changed: 1, dropped: 0, total: 2 }, cwd: { kept: 0, changed: 2, dropped: 0, total: 2 } },
    overall: { kept: 1, changed: 3, dropped: 0, total: 4 },
    recent: Array.from({ length: 20 }, (_, i) => ({ at: `2026-08-23T10:${String(i).padStart(2, '0')}:00Z`,
      entries: [{ field: 'cwd', suggested: long, chosen: `${long}-other`, verdict: 'changed' }] })),
  } }))
  await openSettings(page)
  await clickNav(page, 'suggest-accuracy')
  await expect(page.locator('.suggest-accuracy-record').first()).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('.suggest-accuracy-record')).toHaveCount(10)
  await expect(page.getByTestId('suggest-accuracy-more')).toBeVisible()
  const chips = await page.locator('.suggest-accuracy-entry').evaluateAll((els) => els.map((e) => ({
    h: Math.round(e.getBoundingClientRect().height),
    field: Math.round(e.querySelector('.suggest-accuracy-field')!.getBoundingClientRect().height),
    title: e.querySelector('.suggest-accuracy-values')!.getAttribute('title'),
  })))
  for (const c of chips) {
    expect(c.h).toBeLessThanOrEqual(20)
    expect(c.field).toBeLessThanOrEqual(17)
    expect(c.title).toContain('a-very-long-project-folder-name')
  }
  await expect(page.locator('.settings-pane-header-trailing').getByRole('button', { name: 'Refresh' })).toBeVisible()
  await page.getByTestId('suggest-accuracy-more').getByRole('button', { name: 'Show more' }).click()
  await expect(page.locator('.suggest-accuracy-record')).toHaveCount(20)
})

test('N12 N28 C8: Engines groups all have headings, labels start upper case, paths sit in code', async ({ page }) => {
  await recordWrites(page)
  await openSettings(page)
  await clickNav(page, 'engines')
  await expect(page.locator('.engine-setting-row-pane').first()).toBeVisible({ timeout: 20_000 })
  const facts = await page.locator('.settings-pane').evaluate((pane) => {
    const groups = Array.from(pane.querySelectorAll<HTMLElement>('.engine-settings-groups > *'))
    const unheaded = groups.filter((g) => !g.querySelector('.settings-group-title') && !g.querySelector('.settings-disclosure-row'))
    const files = Array.from(pane.querySelectorAll('.engine-settings-file .settings-row-label')).map((l) => (l.textContent ?? '').trim())
    const floating = Array.from(pane.querySelectorAll('.settings-section > p.settings-group-footer, .settings-pane-body > p.engine-settings-note')).length
    const note = pane.querySelector('[data-testid="engine-settings-note"]')
    return { unheaded: unheaded.length, files, floating, noteInFooter: !!note?.closest('.settings-group-footer'),
      notePathsInCode: note ? !/~\/\S+/.test(Array.from(note.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join('')) : true }
  })
  expect(facts.unheaded).toBe(0)
  for (const f of facts.files) expect(f.charAt(0), f).toBe(f.charAt(0).toUpperCase())
  expect(facts.floating).toBe(0)
  if (await page.getByTestId('engine-settings-note').count()) expect(facts.noteInFooter).toBe(true)
  expect(facts.notePathsInCode).toBe(true)
  // A tri-state Default segment is never paired with a visible "Default" tag.
  const dup = await page.locator('.engine-setting-row-pane').evaluateAll((rows) => rows.filter((r) =>
    Array.from(r.querySelectorAll('[role="radio"]')).some((s) => (s.textContent ?? '').trim() === 'Default')
    && Array.from(r.querySelectorAll('.settings-tag')).some((t) => (t.textContent ?? '').trim() === 'Default')).length)
  expect(dup).toBe(0)
})

test('N10 N11: an off host keeps its controls at full strength; text buttons end on the content edge', async ({ page }) => {
  await recordWrites(page)
  await openSettings(page)
  await clickNav(page, 'remote-hosts')
  const off = page.locator('.rh-host-row[data-host-off="true"]').first()
  await expect(off).toBeVisible({ timeout: 20_000 })
  await page.waitForTimeout(400) // the pane's own fade-in
  const ops = await effectiveOpacity(page, '.rh-host-row[data-host-off="true"] .settings-row-actions :is(button, [role="switch"])')
  expect(ops.length).toBeGreaterThan(0)
  for (const o of ops) expect(o.op, o.text).toBe(1)
  const label = await effectiveOpacity(page, '.rh-host-row[data-host-off="true"] .settings-row-label')
  expect(label[0].op).toBeCloseTo(0.45, 2)
  // N11: a text button that ends a row has its glyphs on the content edge
  // (its 6px padding hangs past it), like the Engines Reset slot.
  await clickNav(page, 'engines')
  await expect(page.locator('.engine-setting-row-pane').first()).toBeVisible({ timeout: 20_000 })
  const edges = await page.locator('.settings-pane .engine-setting-row-pane').evaluateAll((rows) => rows
    .filter((r) => r.getBoundingClientRect().height > 0).slice(0, 8).map((row) => {
      const pad = parseFloat(getComputedStyle(row).paddingRight)
      const btn = row.querySelector<HTMLElement>('.engine-setting-reset')!
      const inner = parseFloat(getComputedStyle(btn).paddingRight)
      return Math.round(row.getBoundingClientRect().right - pad - (btn.getBoundingClientRect().right - inner))
    }))
  expect(edges.length).toBeGreaterThan(0)
  for (const e of edges) expect(Math.abs(e)).toBeLessThanOrEqual(1)
  const deco = await page.locator('.settings-pane .engine-setting-reset').first().evaluate((b) => getComputedStyle(b).textDecorationLine)
  expect(deco).toBe('none')
})

test('N13: plugin row controls are centred on the row like every pane', async ({ page }) => {
  await recordWrites(page)
  await openSettings(page)
  await clickNav(page, 'plugin-store')
  await expect(page.locator('[data-testid^="plugin-row-"]').first()).toBeVisible({ timeout: 20_000 })
  const off = await page.locator('.settings-pane [data-testid^="plugin-row-"]').evaluateAll((rows) => rows
    .filter((r) => r.getBoundingClientRect().height > 50)
    .map((r) => {
      const a = r.querySelector<HTMLElement>(':scope > .settings-row-actions')
      if (!a) return 0
      const rr = r.getBoundingClientRect(); const ar = a.getBoundingClientRect()
      return Math.round(Math.abs((ar.top + ar.bottom) / 2 - (rr.top + rr.bottom) / 2))
    }))
  for (const d of off) expect(d).toBeLessThanOrEqual(2)
})

test('N25 N14 N18: one single-line row height, flat primary buttons, no fade on the nav highlight', async ({ page }) => {
  await recordWrites(page)
  await openSettings(page)
  await clickNav(page, 'advanced')
  await expandAll(page)
  const heights = await page.locator('.settings-pane .settings-row').evaluateAll((rows) => rows
    .filter((r) => r.getBoundingClientRect().height > 0 && !r.querySelector('.settings-row-help') && !r.hasAttribute('data-wide'))
    .map((r) => Math.round(r.getBoundingClientRect().height)))
  expect(heights.length).toBeGreaterThan(3)
  expect(new Set(heights), JSON.stringify(heights)).toEqual(new Set([44]))
  const nav = await page.getByTestId(NAV('advanced')).evaluate((el) => getComputedStyle(el).transitionDuration)
  expect(nav.split(',').every((d) => parseFloat(d) === 0)).toBe(true)
  await clickNav(page, 'plugin-store')
  const primaries = await page.locator('.settings-pane .settings-button-primary').evaluateAll((els) =>
    els.map((b) => ({ ap: getComputedStyle(b).appearance, border: getComputedStyle(b).borderTopColor, bg: getComputedStyle(b).backgroundColor })))
  for (const p of primaries) expect(p.ap).toBe('none')
})

test('N30 N23 N27: Claude Code is named in full, empties share one style, Phones & Cloud asks for devices once', async ({ page }) => {
  await recordWrites(page)
  const devicesGets: string[] = []
  page.on('request', (r) => { if (r.method() === 'GET' && new URL(r.url()).pathname === '/api/devices') devicesGets.push(r.url()) })
  await openSettings(page)
  await clickNav(page, 'engines')
  await expect(page.getByTestId('engine-settings-tab-claude')).toHaveText('Claude Code')
  await clickNav(page, 'devices')
  await page.waitForTimeout(1_500)
  // Dev mode runs each mount effect twice (StrictMode); three readers once each would be 3+.
  expect(devicesGets.length).toBeLessThanOrEqual(2)
  const empties = await page.locator('.settings-pane .settings-row').evaluateAll((rows) => rows
    .filter((r) => /^No .+ yet\.$/.test((r.textContent ?? '').trim())).length)
  expect(empties).toBe(0)
})

test('C50: disclosure help keeps 4.5:1 on its hover band in dark mode', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await recordWrites(page)
  await openSettings(page)
  await clickNav(page, 'engines')
  const row = page.locator('.settings-pane .settings-disclosure-row').first()
  await expect(row).toBeVisible({ timeout: 20_000 })
  await row.hover()
  await page.waitForTimeout(200)
  const ratio = await row.evaluate((el) => {
    const help = el.querySelector<HTMLElement>('.settings-row-help, .settings-disclosure-summary')!
    const rgba = (c: string) => { const n = (c.match(/[\d.]+/g) ?? []).map(Number); return [n[0], n[1], n[2], n[3] ?? 1] }
    // The band may be translucent: composite every background up the chain.
    const layers: number[][] = []
    for (let n: HTMLElement | null = el; n; n = n.parentElement) {
      const c = rgba(getComputedStyle(n).backgroundColor)
      if (c[3] > 0) layers.push(c)
      if (c[3] >= 1) break
    }
    let bgc = [255, 255, 255]
    for (const c of layers.reverse()) bgc = bgc.map((v, i) => v * (1 - c[3]) + c[i] * c[3])
    const rgb = (c: string) => rgba(c).slice(0, 3)
    const lum = ([r, g, b]: number[]) => {
      const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
    }
    const fg = lum(rgb(getComputedStyle(help).color)); const bg = lum(bgc)
    return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05)
  })
  expect(ratio).toBeGreaterThanOrEqual(4.5)
})

test('N20: Tab reaches switches, checkboxes and nav items (WebKit skips untabbable buttons)', async ({ page }) => {
  await recordWrites(page)
  await openSettings(page)
  await clickNav(page, 'sessions')
  await page.locator('.settings-filter').focus()
  const seen = new Set<string>()
  for (let i = 0; i < 80; i++) {
    await page.keyboard.press('Tab')
    const kind = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null
      if (!el) return 'none'
      if (el.getAttribute('role') === 'switch') return 'switch'
      if (el.matches('input[type="checkbox"]')) return 'checkbox'
      if (el.classList.contains('settings-nav-item')) return 'nav'
      return el.tagName.toLowerCase()
    })
    seen.add(kind)
    if (seen.has('switch') && seen.has('checkbox') && seen.has('nav')) break
  }
  expect([...seen]).toEqual(expect.arrayContaining(['switch', 'checkbox', 'nav']))
})

test('N29: a saved Jev key offers Replace next to Remove', async ({ page }) => {
  await recordWrites(page)
  let state: Record<string, any> | null = null
  await page.route('**/api/config', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    if (!state) {
      state = await (await route.fetch({ method: 'GET' })).json() as Record<string, any>
      state.config.jev = { ...(state.config.jev ?? {}), api_key: '${secret:jev}', decisions: { quick_parse: true, session_organize: true } }
    }
    await route.fulfill({ json: state, headers: { 'cache-control': 'no-store' } })
  })
  await openSettings(page)
  await clickNav(page, 'tasks')
  await expect(page.getByTestId('jev-key-status')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId('jev-key-remove')).toBeVisible()
  await page.getByTestId('jev-key-replace').click()
  await expect(page.locator('#jev-key')).toBeVisible()
  await expect(page.getByTestId('jev-key-save')).toBeDisabled()
  await page.getByTestId('jev-key-replace-cancel').click()
  await expect(page.getByTestId('jev-key-status')).toBeVisible()
})
