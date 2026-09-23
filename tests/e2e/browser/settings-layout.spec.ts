/**
 * Settings layout rules: row insets, the pinned header, nav contrast, the
 * filter and dash-free copy. The F/C tags in test names are review item ids. Runs in both engines: Chromium by default, WebKit with
 * `PW_WEBKIT=1 ... --project=webkit`. Pane switches are real nav clicks.
 * Writes are intercepted with page.route unless a test says otherwise.
 */
import { test, expect, type Page, type Request } from '@playwright/test'

if (process.env.PW_WEBKIT) test.use({ browserName: 'webkit' })
test.setTimeout(120_000)

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

async function paneIds(page: Page): Promise<string[]> {
  return page.$$eval('button.settings-nav-item[data-testid^="settings-nav-"]', (els) =>
    els.map((e) => (e.getAttribute('data-testid') ?? '').replace('settings-nav-', '')).filter(Boolean))
}

/** Every write the page sends, fulfilled locally so the fixture never changes. */
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

test('runs in the engine it was asked for', async ({ browserName }) => {
  expect(browserName).toBe(process.env.PW_WEBKIT ? 'webkit' : 'chromium')
})

test('F02 F03: opening any pane never writes config and never shows Saved', async ({ page }) => {
  const writes = await recordWrites(page)
  await openSettings(page)
  const ids = await paneIds(page)
  expect(ids.length).toBeGreaterThan(15)
  const offenders: string[] = []
  for (const id of ids) {
    const before = writes.length
    await clickNav(page, id)
    // Longer than the auto-save debounce, so a mount-time save would have fired.
    let sawSaved = false
    for (let i = 0; i < 8; i++) {
      await page.waitForTimeout(250)
      if (await page.getByTestId('settings-saved-indicator').count()) sawSaved = true
    }
    const configWrites = writes.slice(before).filter((w) => w.includes('/api/config'))
    if (configWrites.length || sawSaved) offenders.push(`${id}: ${sawSaved ? 'Saved shown; ' : ''}${configWrites.join(' | ')}`)
  }
  expect(offenders).toEqual([])
})

test('F02: Remote Hosts still saves a real edit', async ({ page }) => {
  const writes = await recordWrites(page)
  await openSettings(page)
  await clickNav(page, 'remote-hosts')
  await page.getByTestId('remote-hosts-add').click()
  await page.locator('#remote-hosts').getByPlaceholder('devbox').last().fill('box-one')
  await page.locator('#remote-hosts').getByPlaceholder('host.example.com').last().fill('box-one.example.test')
  await expect.poll(() => writes.filter((w) => w.includes('/api/config') && w.includes('box-one')).length,
    { timeout: 10_000 }).toBeGreaterThan(0)
})

interface RowAudit { pane: string; what: string }

/** Row geometry on the pane now showing: inset, control column, background. */
async function auditRows(page: Page, pane: string): Promise<RowAudit[]> {
  const found = await page.evaluate(() => {
    const out: string[] = []
    const transparent = (c: string) => c === 'rgba(0, 0, 0, 0)' || c === 'transparent'
    for (const group of Array.from(document.querySelectorAll<HTMLElement>('.settings-pane .settings-group'))) {
      const g = group.getBoundingClientRect()
      if (g.width === 0) continue
      const rows = Array.from(group.querySelectorAll<HTMLElement>('.settings-row'))
        .filter((r) => r.closest('.settings-group') === group && r.getBoundingClientRect().height > 0)
      for (const row of rows) {
        const label = row.querySelector<HTMLElement>(':scope > .settings-row-copy > .settings-row-label')
        const name = (label?.textContent ?? row.textContent ?? '').trim().slice(0, 40)
        if (!transparent(getComputedStyle(row).backgroundColor) && !row.matches('.settings-anchor-flash')) {
          out.push(`${name}: row background ${getComputedStyle(row).backgroundColor}`)
        }
        if (label && !row.hasAttribute('data-indent')) {
          const dx = label.getBoundingClientRect().left - g.left
          if (Math.abs(dx - 15) > 0.6) out.push(`${name}: label inset ${dx.toFixed(1)}`)
        }
        for (const c of Array.from(row.querySelectorAll<HTMLElement>('input, select, button, textarea'))) {
          const r = c.getBoundingClientRect()
          if (r.width === 0 || c.closest('.settings-row') !== row) continue
          // N11: a text button is measured at its glyphs; its padding hangs past the edge.
          const text = c.matches('.settings-button-text, .settings-button-danger')
          const right = text ? r.right - parseFloat(getComputedStyle(c).paddingRight) : r.right
          if (right > g.right - 13.4) out.push(`${name}: control ends ${(g.right - right).toFixed(1)}px from group edge`)
        }
      }
    }
    for (const h of Array.from(document.querySelectorAll<HTMLElement>('.settings-pane .settings-group-block > .settings-group-heading .settings-group-title'))) {
      const block = h.closest('.settings-group-block')!
      const group = block.querySelector<HTMLElement>(':scope > .settings-group')
      if (!group) continue
      const dx = h.getBoundingClientRect().left - group.getBoundingClientRect().left
      if (h.getBoundingClientRect().width && Math.abs(dx - 15) > 0.6) out.push(`heading ${h.textContent}: inset ${dx.toFixed(1)}`)
    }
    return out
  })
  return found.map((what) => ({ pane, what }))
}

/** Opens every disclosure in the pane (not menus), so folded rows are audited too. */
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

for (const width of [1280, 900]) {
  test(`F04 F05 F06 F07 F29: rows share one inset and control column at ${width}px`, async ({ page }) => {
    test.setTimeout(300_000)
    await recordWrites(page)
    await page.setViewportSize({ width, height: 800 })
    await openSettings(page)
    const problems: RowAudit[] = []
    // At 900 both sidebar states (C42: expanded leaves Settings about 660px);
    // the second click puts the shared sidebar pref back as it was.
    const passes = width === 900 && await page.locator('.sidebar-collapse-btn').count() ? 2 : 1
    for (let pass = 0; pass < passes; pass++) {
      if (pass === 1) await page.locator('.sidebar-collapse-btn').first().click()
      const cw = Math.round(await page.locator('.settings-container').evaluate((e) => e.getBoundingClientRect().width))
      for (const id of await paneIds(page)) {
        await clickNav(page, id)
        await page.waitForTimeout(300)
        await expandAll(page)
        problems.push(...(await auditRows(page, `${id}@${cw}`)))
      }
    }
    if (passes === 2) await page.locator('.sidebar-collapse-btn').first().click()
    expect(problems).toEqual([])
  })
}

/** Bordered or filled boxes drawn inside a group (a group is the only surface). */
async function nestedBoxes(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = []
    const CONTROL = 'input, select, textarea, button, a, [role="switch"], [role="radiogroup"], [role="tablist"], '
      + '.settings-tag, .settings-segmented, code, pre, kbd, svg, img, canvas, .settings-textarea, '
      + '[class*="segmented"], [class*="toggle"], [class*="switch"], [class*="tag"], [class*="chip"], [class*="pill"], '
      + '[class*="badge"], [class*="dot"], [class*="swatch"], [class*="tile"], [class*="icon"], [class*="glyph"], '
      + '[class*="qr"], [class*="bar-fill"], [class*="skeleton"], [class*="progress"], [class*="checkbox"], [class*="color"]'
    const visible = (c: string) => c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent'
    for (const group of Array.from(document.querySelectorAll<HTMLElement>('.settings-pane .settings-group'))) {
      const gBg = getComputedStyle(group).backgroundColor
      for (const el of Array.from(group.querySelectorAll<HTMLElement>('*'))) {
        if (el.matches(CONTROL) || el.closest(CONTROL) || el.closest('.settings-group') !== group) continue
        const r = el.getBoundingClientRect()
        if (r.width < 120 || r.height < 30) continue
        const cs = getComputedStyle(el)
        const sides = ['Top', 'Right', 'Bottom', 'Left'].filter((s) =>
          parseFloat(cs.getPropertyValue(`border-${s.toLowerCase()}-width`)) > 0
          && cs.getPropertyValue(`border-${s.toLowerCase()}-style`) !== 'none'
          && visible(cs.getPropertyValue(`border-${s.toLowerCase()}-color`)))
        const filled = visible(cs.backgroundColor) && cs.backgroundColor !== gBg && parseFloat(cs.borderTopLeftRadius) > 0
        if (sides.length >= 3 || filled) {
          out.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ').join('.')} (${sides.length} borders${filled ? ', filled' : ''})`)
        }
      }
    }
    return out
  })
}

test('F10: no bordered or filled box inside any group, every pane expanded', async ({ page }) => {
  test.setTimeout(300_000)
  await recordWrites(page)
  await openSettings(page)
  const problems: string[] = []
  for (const id of await paneIds(page)) {
    await clickNav(page, id)
    await page.waitForTimeout(400)
    await expandAll(page)
    for (const p of await nestedBoxes(page)) problems.push(`${id}: ${p}`)
  }
  expect([...new Set(problems)]).toEqual([])
})

test('F10 F24: a paired phone is a plain row with a neutral Show QR and a human model', async ({ page }) => {
  await recordWrites(page)
  await page.route('**/api/devices', (route) => route.fulfill({
    json: {
      devices: [
        { name: 'Test phone', createdAt: '2026-09-01T10:00:00Z', role: 'phone',
          info: { model: 'iPhone18,2', os: 'iOS 26.1', appVersion: '1.0 (26)' } },
        { name: 'Second phone', createdAt: '2026-09-02T10:00:00Z', role: 'phone' },
      ],
      cloudDevices: [],
      targets: [{ kind: 'lan', label: 'This network', origin: 'http://192.0.2.10:3456' }],
    },
  }))
  await openSettings(page)
  await clickNav(page, 'devices')
  const row = page.locator('.devices-row[data-device-name="Test phone"]')
  await expect(row).toBeVisible()
  await expect(row).toContainText('iPhone, iOS 26.1')
  await expect(row).not.toContainText('iPhone18,2')
  const style = await row.evaluate((el) => {
    const cs = getComputedStyle(el)
    const name = el.querySelector('.settings-row-label')!
    const qr = el.querySelector('[data-testid="devices-show-qr"]')!
    const remove = el.querySelector('[data-testid="devices-remove"]')!
    return { border: cs.borderTopWidth, radius: cs.borderTopLeftRadius, weight: getComputedStyle(name.querySelector('span') ?? name).fontWeight,
      qr: getComputedStyle(qr).color, remove: getComputedStyle(remove).color }
  })
  expect(style.border).toBe('0px')
  expect(style.radius).toBe('0px')
  expect(Number(style.weight)).toBeLessThan(500)
  expect(style.qr).not.toBe(style.remove)
  expect(await nestedBoxes(page)).toEqual([])
})

function usageOverview() {
  const group = (name: string, cost: number, pct: number) => ({ name, cost_usd: cost, input_tokens: 123456,
    output_tokens: 23456, cache_read_tokens: 3456789, cache_creation_tokens: 45678, api_calls: 12, percentage: pct })
  const recent = Array.from({ length: 30 }, (_, i) => ({
    id: `r${i}`, timestamp: new Date(Date.UTC(2026, 8, 23, 1 + (i % 12), 25)).toISOString(), date: '2026-09-23',
    source: i % 2 ? 'ai-task-search' : 'session-summary', model: 'global.anthropic.claude-example-model-5',
    input_tokens: 12345, output_tokens: 2345, cache_creation_input_tokens: 345, cache_read_input_tokens: 45678,
    cost_usd: 0.0123, ...(i % 3 === 0 ? { agentId: 'helper-agent' } : {}),
  }))
  return {
    summary: { total_cost: 12.34, session_cost: 1, input_tokens: 1234567, output_tokens: 234567,
      cache_read_tokens: 3456789, cache_creation_tokens: 45678, api_calls: 321 },
    daily: [{ date: '2026-09-22', cost_usd: 4, input_tokens: 1, output_tokens: 1 }, { date: '2026-09-23', cost_usd: 8, input_tokens: 1, output_tokens: 1 }],
    bySource: [group('session-summary', 8.1, 65.6), group('ai-task-search', 4.24, 34.4)],
    byModel: [group('global.anthropic.claude-example-model-5', 12.34, 100)],
    byAgent: [group('helper-agent', 2, 16.2)],
    recent,
    dateBounds: { min: '2026-09-01', max: '2026-09-23' },
  }
}

test('F10 F11 F12: Usage tables are sentence case, one line per cell, dash free, one scroller', async ({ page }) => {
  await recordWrites(page)
  await page.route('**/api/usage/overview**', (route) => route.fulfill({ json: usageOverview() }))
  await openSettings(page)
  await clickNav(page, 'usage')
  const pane = page.locator('.settings-pane')
  await expect(pane.locator('.settings-usage-recent tbody tr')).toHaveCount(30)
  const audit = await pane.evaluate((el) => {
    const out: string[] = []
    for (const th of Array.from(el.querySelectorAll<HTMLElement>('th'))) {
      if (getComputedStyle(th).textTransform !== 'none') out.push(`th ${th.textContent} transformed`)
    }
    for (const cell of Array.from(el.querySelectorAll<HTMLElement>('th, td'))) {
      const lh = parseFloat(getComputedStyle(cell).lineHeight) || 17
      const pad = parseFloat(getComputedStyle(cell).paddingTop) + parseFloat(getComputedStyle(cell).paddingBottom)
      if (cell.getBoundingClientRect().height - pad > lh * 1.5) out.push(`cell wraps: ${cell.textContent}`)
    }
    if (/[\u2013\u2014]/.test(el.textContent ?? '')) out.push('dash in pane text')
    for (const s of Array.from(el.querySelectorAll<HTMLElement>('*'))) {
      const cs = getComputedStyle(s)
      if (s !== el && /(auto|scroll)/.test(cs.overflowY) && s.scrollHeight > s.clientHeight + 1) out.push(`inner scroller ${s.className}`)
    }
    const widths = Array.from(el.querySelectorAll<HTMLTableElement>('.settings-usage-breakdown'))
      .map((t) => Array.from(t.querySelectorAll('th')).map((th) => Math.round(th.getBoundingClientRect().left)).join(','))
    if (new Set(widths).size > 1) out.push(`breakdown columns differ: ${widths.join(' | ')}`)
    return out
  })
  expect(audit).toEqual([])
  await expect(pane.locator('.settings-group-heading-trailing').filter({ hasText: /Showing|\d{4}-\d{2}-\d{2}/ })).toHaveCount(0)
  const refresh = pane.locator('.usage-refresh-btn').first()
  expect(await refresh.evaluate((b) => b.classList.contains('settings-button-primary'))).toBe(false)
  expect(await refresh.evaluate((b) => getComputedStyle(b).backgroundColor)).not.toBe('rgb(0, 122, 255)')
  expect(await nestedBoxes(page)).toEqual([])
})

test('F23 C42: Settings runs edge to edge; at 900px the nav keeps its 200px column', async ({ page }) => {
  await recordWrites(page)
  for (const width of [1280, 900]) {
    await page.setViewportSize({ width, height: 800 })
    await openSettings(page)
    const m = await page.evaluate(() => {
      const area = document.querySelector('.app-content-area')!.getBoundingClientRect()
      const box = document.querySelector('.settings-container')!.getBoundingClientRect()
      const nav = document.querySelector('.settings-nav')!.getBoundingClientRect()
      return { area: [area.left, area.top, area.right, area.bottom], box: [box.left, box.top, box.right, box.bottom],
        nav: nav.width, container: box.width, vh: window.innerHeight }
    })
    expect(m.box).toEqual(m.area)
    expect(m.box[1]).toBe(0)
    expect(m.box[3]).toBe(m.vh)
    if (m.container >= 640 && m.container < 900) expect(m.nav).toBe(200)
    if (width === 900) expect(m.container).toBeGreaterThanOrEqual(640)
  }
})

test('F09: the title and Find a setting stay pinned while the nav list scrolls', async ({ page }) => {
  await recordWrites(page)
  await page.setViewportSize({ width: 1280, height: 600 })
  await openSettings(page)
  const ids = await paneIds(page)
  await clickNav(page, ids[ids.length - 1])
  const m = await page.evaluate(() => {
    const nav = document.querySelector<HTMLElement>('.settings-nav')!
    const list = document.querySelector<HTMLElement>('.settings-nav-list')!
    const filter = document.querySelector<HTMLElement>('[data-testid="settings-filter"]')!.getBoundingClientRect()
    const title = document.querySelector<HTMLElement>('.settings-nav-title')!.getBoundingClientRect()
    return { navScroll: nav.scrollTop, listScroll: list.scrollTop, filterTop: filter.top, titleTop: title.top,
      navTop: nav.getBoundingClientRect().top, listScrollable: list.scrollHeight > list.clientHeight }
  })
  expect(m.navScroll).toBe(0)
  expect(m.filterTop).toBeGreaterThan(m.navTop)
  expect(m.titleTop).toBeGreaterThanOrEqual(m.navTop)
  expect(m.listScrollable).toBe(true)
  expect(m.listScroll).toBeGreaterThan(0)
  await expect(page.getByTestId('settings-filter')).toBeInViewport()
})

test('F08: the compact bar pins flush at the pane top with nothing above it', async ({ page }) => {
  await recordWrites(page)
  await openSettings(page)
  for (const id of ['hooks', 'plugin-store', 'engines']) {
    await clickNav(page, id)
    await page.waitForTimeout(300)
    // Panes fill in after their own reads; scroll once there is room to scroll.
    await expect.poll(() => page.locator('.settings-pane').evaluate((el) => el.scrollHeight - el.clientHeight), { timeout: 20_000 })
      .toBeGreaterThan(150)
    await page.locator('.settings-pane').evaluate((el) => { el.scrollTop = el.scrollHeight })
    await expect(page.locator('.settings-pane-stickybar.is-compact'), id).toHaveCount(1)
    const m = await page.evaluate(() => {
      const pane = document.querySelector<HTMLElement>('.settings-pane')!.getBoundingClientRect()
      const bar = document.querySelector<HTMLElement>('.settings-pane-stickybar-inner')!.getBoundingClientRect()
      const hit = document.elementFromPoint(pane.left + pane.width / 2, pane.top + 4)
      const header = document.querySelector<HTMLElement>('.settings-pane .settings-pane-header')?.getBoundingClientRect()
      return { dy: bar.top - pane.top, inBar: !!hit?.closest('.settings-pane-stickybar'),
        headerVisibleBelowPaneTop: header ? header.bottom > pane.top + 44 : false }
    })
    expect(m, id).toEqual({ dy: 0, inBar: true, headerVisibleBelowPaneTop: false })
  }
})

for (const theme of ['light', 'dark'] as const) {
  test(`C50 F37: selected nav text passes 4.5:1 and dark controls stay visible (${theme})`, async ({ page }) => {
    await recordWrites(page)
    await page.emulateMedia({ colorScheme: theme })
    await page.addInitScript((t) => { try { localStorage.setItem('open-walnut-theme', t) } catch { /* ignore */ } }, theme)
    await openSettings(page)
    await page.evaluate((t) => { document.documentElement.dataset.theme = t }, theme)
    await clickNav(page, 'sessions')
    const m = await page.evaluate(() => {
      const rgb = (c: string) => (c.match(/[\d.]+/g) ?? []).map(Number)
      const lum = ([r, g, b]: number[]) => {
        const f = (v: number) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4 }
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
      }
      const ratio = (a: string, b: string) => { const [x, y] = [lum(rgb(a)), lum(rgb(b))].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05) }
      const active = document.querySelector<HTMLElement>('.settings-nav-active')!
      const label = active.querySelector<HTMLElement>('.settings-nav-label')!
      const box = document.querySelector<HTMLElement>('.settings-pane .settings-checkbox-input:not(:checked)')
      return {
        nav: ratio(getComputedStyle(label).color, getComputedStyle(active).backgroundColor),
        boxBorder: box ? getComputedStyle(box).borderTopColor : null,
      }
    })
    expect(m.nav).toBeGreaterThanOrEqual(4.5)
    if (theme === 'dark' && m.boxBorder) {
      const alpha = Number((m.boxBorder.match(/[\d.]+/g) ?? [])[3] ?? 1)
      expect(alpha).toBeGreaterThanOrEqual(0.3)
    }
  })
}

test('F20 F21 F22: filter Enter lands on the row, flashes it, and the heading has no ring', async ({ page }) => {
  await recordWrites(page)
  await openSettings(page)
  await clickNav(page, 'sessions')
  const filter = page.getByTestId('settings-filter')
  await filter.fill('all clear')
  await filter.press('Enter')
  await expect(page.getByTestId(NAV('general'))).toHaveAttribute('aria-current', 'page')
  const row = page.locator('.settings-row:has(#settings-notify-heartbeat)')
  await expect(row).toHaveClass(/settings-anchor-flash/, { timeout: 10_000 })
  await expect(row).toBeInViewport()
  const peak = await row.evaluate((el) => Number((getComputedStyle(el).backgroundColor.match(/[\d.]+/g) ?? [])[3] ?? 0))
  expect(peak).toBeGreaterThan(0.12)
  const ring = await page.evaluate(() => {
    const h = document.activeElement as HTMLElement | null
    return h && h.matches('.settings-pane-title') ? getComputedStyle(h).outlineStyle : 'not-focused'
  })
  expect(['none', 'not-focused']).toContain(ring)
  await filter.fill('port')
  await expect(page.locator('.settings-nav-item.is-highlighted')).toHaveAttribute('data-testid', NAV('advanced'))
  await filter.fill('theme')
  await expect(page.getByTestId(NAV('general')).locator('.settings-nav-hint')).toHaveText('Matches "Appearance"')
})

test('F14: an API provider this build does not know still shows a Provider row, never a raw id', async ({ page }) => {
  await recordWrites(page)
  await page.route('**/api/config', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    const res = await route.fetch()
    const body = await res.json()
    const cfg = body.config ?? body
    cfg.agent = { ...(cfg.agent ?? {}), main_provider: 'some-new-api' }
    await route.fulfill({ response: res, json: body })
  })
  test.info().annotations.push({ type: 'cleanup', description: 'unrouteAll at the end' })
  await openSettings(page)
  await clickNav(page, 'advanced')
  const summary = page.getByTestId('providers-summary')
  await expect(summary).toHaveText('On, an unknown provider')
  await expect(page.locator('#provider-select')).toBeVisible()
  await expect(page.getByTestId('custom-agent-providers')).toContainText('Unknown provider')
  const visibleText = () => page.locator('.settings-pane').evaluate((el) => {
    const copy = el.cloneNode(true) as HTMLElement
    copy.querySelectorAll('pre, code, textarea, .settings-mono-block').forEach((n) => n.remove())
    return copy.textContent ?? ''
  })
  expect(await visibleText()).not.toContain('some-new-api')
  await clickNav(page, 'tasks')
  await expect(page.getByTestId('smart-runner-row')).toContainText('Your API')
  expect(await visibleText()).not.toContain('some-new-api')
  await page.unrouteAll({ behavior: 'ignoreErrors' })
})

test('F15 F19 C8 C10: Hooks and Plugins show sentence case, unique names, no dashes', async ({ page }) => {
  await recordWrites(page)
  await openSettings(page)
  await clickNav(page, 'hooks')
  await expect(page.locator('.hook-row').first()).toBeVisible()
  await expandAll(page)
  const hooks = await page.locator('.settings-pane').evaluate((el) => {
    const names = Array.from(el.querySelectorAll('.hook-row-name')).map((n) => (n.textContent ?? '').trim())
    const text = (el as HTMLElement).innerText
    const heights = Array.from(el.querySelectorAll<HTMLElement>('.hook-row')).map((r) => r.getBoundingClientRect().height)
    const caps = (text.match(/\b[A-Z]{4,}\b/g) ?? []).filter((w: string) => !['MCP', 'TOML', 'ISO', 'HEARTBEAT', 'CLAUDE', 'JSON', 'YAML', 'JSONL', 'FIFO', 'IMAP', 'TOCTOU', 'PGID', 'ENXIO'].includes(w))
    const dashAt = Array.from(el.querySelectorAll<HTMLElement>('*')).filter((n) => n.children.length === 0 && /[\u2013\u2014]/.test(n.textContent ?? '')).map((n) => n.className)
    return { names, dash: dashAt.join(' | ') || false, eg: /\be\.g\./.test(text), inline: /\bInline\b/.test(text),
      minHeight: Math.min(...heights), caps }
  })
  expect(new Set(hooks.names).size).toBe(hooks.names.length)
  for (const n of hooks.names) expect(n.split(' ').slice(1).some((w) => /^[A-Z][a-z]/.test(w)), n).toBe(false)
  expect(hooks).toMatchObject({ dash: false, eg: false, inline: false, caps: [] })
  expect(hooks.minHeight).toBeGreaterThanOrEqual(44)
  await clickNav(page, 'plugin-store')
  const chips = page.locator('.settings-pane .plugin-update-chip')
  for (let i = 0; i < await chips.count(); i++) {
    const t = await chips.nth(i).evaluate((el) => ({ tt: getComputedStyle(el).textTransform, ls: getComputedStyle(el).letterSpacing }))
    expect(t.tt).toBe('none')
    expect(['normal', '0px']).toContain(t.ls)
  }
})
