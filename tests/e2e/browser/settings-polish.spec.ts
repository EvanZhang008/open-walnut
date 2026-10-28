/**
 * Settings polish: provider naming, disabled rows, usage
 * tables, button weights and keyboard reach. Same conventions as
 * settings-layout-fields.spec.ts: both engines, real nav clicks, config writes
 * intercepted so the fixture config never changes under another spec.
 */
import { test, expect, type Page, type Request } from '@playwright/test'
import { backToApps, openPluginDetail } from './apps-store-helpers'

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

/** Plugins moved to the Apps page: the Settings nav's Plugins row is a link there now. */
async function openApps(page: Page) {
  await page.getByTestId(NAV('plugin-store')).click()
  await expect(page.getByTestId('apps-page')).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('#plugin-store')).toBeVisible({ timeout: 20_000 })
}

/** Ids of the installed plugins that have a card, in page order. */
async function installedCardIds(page: Page): Promise<string[]> {
  await expect(page.locator('[data-testid="plugin-store-installed"] .apps-card').first()).toBeVisible({ timeout: 20_000 })
  return page.locator('[data-testid="plugin-store-installed"] .apps-card').evaluateAll((cards) => cards
    .map((c) => (c.getAttribute('data-testid') ?? '').replace(/^plugin-card-/, ''))
    .filter(Boolean))
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

test('N01: a named claude-cli provider reads as Claude Code in Tasks, Sessions and Advanced', async ({ page }) => {
  await recordWrites(page)
  await openSettings(page)
  await clickNav(page, 'tasks')
  await expect(page.getByTestId('smart-runner-default')).toHaveText('Claude Code')
  await expect(page.getByTestId('smart-runner-row')).not.toContainText('your API')
  // The default engine row (in Sessions since the Engines pane was retired) warns only for an API.
  await clickNav(page, 'sessions')
  await expect(page.getByTestId('default-engine-row')).toBeVisible()
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
  for (const pane of ['triage', 'backup']) {
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

// A plugin's parts (a mail account of Mail, an MCP server of its app) have no card of their
// own: they are rows on their parent's page, in its Parts section.
test('N05 N06: a plugin\'s parts are plain rows on its page that say their state', async ({ page }) => {
  await recordWrites(page)
  await openSettings(page)
  await openApps(page)
  await installedCardIds(page)
  // A parent's card names its parts.
  const parents = await page.locator('[data-testid="plugin-store-installed"] .apps-card:has(.apps-card-note)').evaluateAll((cards) => cards
    .filter((c) => /^Includes /.test(c.querySelector('.apps-card-note')?.textContent ?? ''))
    .map((c) => (c.getAttribute('data-testid') ?? '').replace(/^plugin-card-/, '')))
  expect(parents.length, 'fixture has a plugin with parts').toBeGreaterThan(0)
  let seen = 0
  for (const id of parents) {
    await openPluginDetail(page, id)
    const subRows = await page.evaluate((parentId) => Array.from(document.querySelectorAll<HTMLElement>(
      `[data-testid="plugin-parts-${parentId}"] [data-testid^="plugin-part-"]:not([data-testid^="plugin-part-open-"]), [data-testid="plugin-detail"] [data-testid^="plugin-app-failed-"]`))
      .map((row) => {
        const group = row.closest('.settings-group')!
        const boxes: string[] = []
        // The part itself and everything up to its group: no card inside the card. A hairline
        // between two parts is a separator, not a box.
        for (let n: HTMLElement | null = row; n && n !== group; n = n.parentElement) {
          const cs = getComputedStyle(n)
          if (cs.backgroundColor !== 'rgba(0, 0, 0, 0)' || parseFloat(cs.borderRadius) > 0
            || parseFloat(cs.borderLeftWidth) > 0 || parseFloat(cs.borderRightWidth) > 0) boxes.push(n.className)
        }
        const line = row.matches('.settings-row') ? row : row.querySelector<HTMLElement>(':scope > .settings-row')
        // The page's other rows: the parts start where every row of the page starts.
        const ref = document.querySelector<HTMLElement>(`[data-testid="plugin-source-${parentId}"] .settings-row`)
        const toggle = row.querySelector<HTMLElement>('[role="switch"]')
        return {
          id: row.dataset.testid,
          boxes,
          pad: line ? getComputedStyle(line).paddingLeft : null,
          refPad: ref ? getComputedStyle(ref).paddingLeft : null,
          help: (line?.querySelector('.settings-row-help')?.textContent ?? '').trim(),
          tag: (row.querySelector('[data-testid^="plugin-provider-"] .settings-tag, .settings-tag')?.textContent ?? '').trim(),
          switchState: toggle?.getAttribute('aria-checked') ?? null,
        }
      }), id)
    for (const r of subRows) {
      seen += 1
      expect(r.boxes, r.id).toEqual([])
      if (r.refPad && r.id?.startsWith('plugin-part-')) expect(r.pad, r.id).toBe(r.refPad)
      // Its state: its switch, or a tag (Not set up, Failed) where it cannot be switched.
      if (r.id?.startsWith('plugin-part-')) expect(r.switchState ?? (r.help || r.tag), `${r.id} says its state`).toBeTruthy()
    }
    await backToApps(page)
  }
  expect(seen, 'fixture has a part row').toBeGreaterThan(0)
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

test('N10: an off host keeps its controls at full strength', async ({ page }) => {
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
  // N11 (the Engines Reset slot's edge) went with the Engines pane on 2026-10-27.
})

test('N13: plugin page controls are centred on the row like every pane', async ({ page }) => {
  await recordWrites(page)
  await openSettings(page)
  await openApps(page)
  const ids = await installedCardIds(page)
  expect(ids.length).toBeGreaterThan(0)
  // Each plugin's page, where its switch, settings, parts and versions live now.
  for (const id of ids) {
    await openPluginDetail(page, id)
    const off = await page.locator('[data-testid="plugin-detail"] .settings-row:not(.settings-row-stacked):not([data-wide])').evaluateAll((rows) => rows
      .filter((r) => r.getBoundingClientRect().height > 50)
      .map((r) => {
        const a = r.querySelector<HTMLElement>(':scope > .settings-row-actions')
        const label = r.querySelector('.settings-row-label')?.textContent?.trim().slice(0, 30) ?? ''
        if (!a) return { label, d: 0, h: 0 }
        const rr = r.getBoundingClientRect(); const ar = a.getBoundingClientRect()
        return { label, d: Math.round(Math.abs((ar.top + ar.bottom) / 2 - (rr.top + rr.bottom) / 2)), h: Math.round(rr.height) }
      }))
    for (const { label, d, h } of off) expect(d, `${id}: ${label} (row ${h}px)`).toBeLessThanOrEqual(2)
    await backToApps(page)
  }
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
  await openApps(page)
  const flat = (sel: string) => page.locator(sel).evaluateAll((els) =>
    els.map((b) => ({ ap: getComputedStyle(b).appearance, border: getComputedStyle(b).borderTopColor, bg: getComputedStyle(b).backgroundColor })))
  // The grid's own primary (Add, in the install form), then every plugin page's (Save, Open App, Install).
  await page.getByTestId('apps-add-from-link').click()
  const primaries = await flat('#plugin-store .settings-button-primary')
  for (const id of await installedCardIds(page)) {
    await openPluginDetail(page, id)
    primaries.push(...await flat('[data-testid="plugin-detail"] .settings-button-primary'))
    await backToApps(page)
  }
  expect(primaries.length).toBeGreaterThan(1)
  for (const p of primaries) expect(p.ap).toBe('none')
})

test('N30 N23 N27: Claude Code is named in full, empties share one style, Phones & Cloud asks for devices once', async ({ page }) => {
  await recordWrites(page)
  const devicesGets: string[] = []
  page.on('request', (r) => { if (r.method() === 'GET' && new URL(r.url()).pathname === '/api/devices') devicesGets.push(r.url()) })
  await openSettings(page)
  await clickNav(page, 'sessions')
  // The default engine picker (segments, or a select past five engines) names it in full.
  await expect(page.locator('[data-testid="default-engine-option-claude"], [data-testid="default-engine-select"] option[value="claude"]')).toHaveText('Claude Code')
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
  await clickNav(page, 'advanced')
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
