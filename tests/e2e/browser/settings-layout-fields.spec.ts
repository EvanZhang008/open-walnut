/**
 * Settings field layout: number fields, plugin slots, Usage refresh, recent
 * guesses and the S3 Backup refresh race. Same conventions as
 * settings-layout.spec.ts: both engines, real nav clicks, writes intercepted.
 */
import { routeCosts } from './usage-costs-fixture'
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

test('F27 N03 F31 F33 F36: number fields end on the content edge, no-op bulk links are off, no steppers', async ({ page }) => {
  await recordWrites(page)
  await openSettings(page)
  for (const id of ['sessions', 'advanced']) {
    await clickNav(page, id)
    await expandAll(page)
    // N03: the field plus its unit ends 14px inside the group, like switches;
    // no reserved unit slot on unitless fields.
    const rights = await page.locator('.settings-pane').evaluate((el) =>
      Array.from(el.querySelectorAll<HTMLInputElement>('.settings-row-actions input[type="number"]'))
        .filter((i) => i.getBoundingClientRect().width > 0)
        .map((i) => {
          const wrap = i.closest('.settings-input-with-unit') ?? i
          const row = i.closest('.settings-row')!
          const pad = parseFloat(getComputedStyle(row).paddingRight)
          const edge = row.getBoundingClientRect().right - pad
          return { inset: Math.round(edge - wrap.getBoundingClientRect().right), a: getComputedStyle(i).appearance }
        }))
    expect(rights.length, id).toBeGreaterThan(1)
    expect(new Set(rights.map((x) => x.inset)), `${id} ${JSON.stringify(rights)}`).toEqual(new Set([0]))
    for (const x of rights) expect(x.a).toBe('textfield')
  }
  // A secret field with nothing in it shows no reveal toggle (Tasks holds the
  // Jev key; the Integrations pane this used to read is gone).
  await clickNav(page, 'tasks')
  // count(), not evaluate(): a pane with no secret field must not wait for one.
  const empties = await page.locator('.settings-pane .settings-secret').count()
  if (empties) {
    const bad = await page.locator('.settings-pane').evaluate((el) =>
      Array.from(el.querySelectorAll<HTMLElement>('.settings-secret')).filter((w) => !(w.querySelector('input') as HTMLInputElement).value
        && w.querySelector('.secret-toggle')).length)
    expect(bad).toBe(0)
  }
  await clickNav(page, 'calendar')
  const groups = page.locator('[data-testid="calendar-account-group"]')
  for (let i = 0; i < await groups.count(); i++) {
    const count = (await groups.nth(i).getByTestId('calendar-account-count').textContent()) ?? ''
    const [shown, total] = (count.match(/\d+/g) ?? []).map(Number)
    const show = groups.nth(i).getByRole('button', { name: 'Show all' })
    const hide = groups.nth(i).getByRole('button', { name: 'Hide all' })
    if (shown === total) await expect(show).toBeDisabled()
    if (shown === 0) await expect(hide).toBeDisabled()
  }
})

test('F17 F18 F28: plugin slots line up, install rows stack', async ({ page }) => {
  await recordWrites(page)
  await openSettings(page)
  // Plugins live on the Apps page; the Settings nav's Plugins row links there.
  await page.getByTestId(NAV('plugin-store')).click()
  await expect(page.getByTestId('apps-page')).toBeVisible({ timeout: 20_000 })
  // The free-form install opens from Get more's "Add from a git or npm link" card.
  await page.getByTestId('apps-add-from-link').click()
  const install = page.locator('.settings-row:has(#plugin-source-url)')
  await expect(install).toBeVisible()
  const lines = await install.evaluate((row) => {
    const label = row.querySelector<HTMLElement>('.settings-row-label')!
    const input = row.querySelector<HTMLElement>('#plugin-source-url')!
    return { labelLines: Math.round(label.getBoundingClientRect().height / 19), inputBelow: input.getBoundingClientRect().top > label.getBoundingClientRect().bottom }
  })
  expect(lines).toEqual({ labelLines: 1, inputBelow: true })
  // The slots line up on the card grid: cards side by side share one height, so their
  // footers (status, Open, where it comes from) sit on one line.
  const footRows = await page.locator('[data-testid="plugin-store-installed"] .apps-grid').evaluateAll((grids) => grids.map((grid) => {
    const byTop = new Map<number, number[]>()
    for (const card of Array.from(grid.querySelectorAll<HTMLElement>(':scope > .apps-card'))) {
      const top = Math.round(card.getBoundingClientRect().top)
      const foot = card.querySelector('.apps-card-foot')!.getBoundingClientRect()
      byTop.set(top, [...(byTop.get(top) ?? []), Math.round(foot.bottom)])
    }
    return Array.from(byTop.values())
  }).flat())
  expect(footRows.length).toBeGreaterThan(0)
  for (const bottoms of footRows) expect(new Set(bottoms).size, JSON.stringify(bottoms)).toBe(1)
  // Back to Settings from the sidebar for the panes after it.
  await page.getByTestId('sidebar-core-app-settings').click()
  await expect(page.locator('.settings-nav')).toBeVisible({ timeout: 20_000 })
  // F35 (an engine menu's chevron) went with the Engines pane on 2026-10-27.
  await page.route('**/api/backup/status', (route) => route.fulfill({ json: { configured: true, running: false, consecutiveFailures: 0, versioningEnabled: false } }))
  await clickNav(page, 'backup')
  const warn = page.getByTestId('backup-versioning-off')
  await expect(warn).toBeVisible()
  expect(await nestedBoxes(page)).toEqual([])
  await expect(page.locator('.settings-pane .settings-group-footer code', { hasText: 'auth.json' })).toHaveCount(1)
})

test('F12: Usage Refresh keeps its x when the header turns compact', async ({ page }) => {
  await recordWrites(page)
  await routeCosts(page)
  await openSettings(page)
  await clickNav(page, 'usage')
  const refresh = page.locator('.usage-refresh-btn')
  await expect(refresh.first()).toBeVisible()
  // Scroll only once the mocked rows are in, or the pane is too short to scroll.
  await expect(page.getByTestId('usage-group-task').locator('.usage-line:visible')).toHaveCount(25)
  const before = await refresh.first().evaluate((b) => Math.round(b.getBoundingClientRect().right))
  await page.locator('.settings-pane').evaluate((el) => { el.scrollTop = el.scrollHeight })
  await expect(page.locator('.settings-pane-stickybar.is-compact')).toHaveCount(1)
  const after = await page.locator('.settings-pane-stickybar .usage-refresh-btn').evaluate((b) => Math.round(b.getBoundingClientRect().right))
  expect(Math.abs(after - before)).toBeLessThanOrEqual(1)
})

test('F01: Recent guesses are one row per guess, never drawn over each other', async ({ page }) => {
  await recordWrites(page)
  const stats = { kept: 3, changed: 1, dropped: 1, total: 5, accuracy: 0.6 }
  const recent = Array.from({ length: 8 }, (_, i) => ({
    at: new Date(Date.UTC(2026, 7, 23, 10 + i, 31)).toISOString(), surface: 'draft',
    entries: [
      { field: 'project', suggested: 'Example project', verdict: 'kept' },
      { field: 'cwd', suggested: '/tmp/example/some/long/working/folder/name', chosen: '/tmp/example/other', verdict: i % 2 ? 'changed' : 'kept' },
      { field: 'priority', suggested: 'high', verdict: 'dropped' },
    ],
  }))
  await page.route('**/api/tasks/suggest-accuracy**', (route) => route.fulfill({ json: {
    commits: 8, overall: stats, recent,
    fields: Object.fromEntries(['project', 'cwd', 'pinTier', 'priority', 'dueDate', 'startDate', 'endDate'].map((f) => [f, stats])),
  } }))
  await page.setViewportSize({ width: 900, height: 800 })
  await openSettings(page)
  await clickNav(page, 'suggest-accuracy')
  const rows = page.locator('.suggest-accuracy-record')
  await expect(rows).toHaveCount(8)
  const boxes = await rows.evaluateAll((els) => els.map((e) => {
    const r = e.getBoundingClientRect()
    const chips = Array.from(e.querySelectorAll('.suggest-accuracy-entry')).map((c) => c.getBoundingClientRect())
    return { top: r.top, bottom: r.bottom, chipsInside: chips.every((c) => c.top >= r.top - 0.5 && c.bottom <= r.bottom + 0.5) }
  }))
  for (let i = 1; i < boxes.length; i++) expect(boxes[i].top).toBeGreaterThanOrEqual(boxes[i - 1].bottom - 0.5)
  for (const b of boxes) expect(b.chipsInside).toBe(true)
  await expect(rows.first().locator('.suggest-accuracy-when')).toHaveText(/^Aug 23, \d{1,2}:31\s(AM|PM)$/)
  await page.screenshot({ path: '/tmp/settings-redesign/fx-suggest-accuracy.png' })
})

test('S3 Backup: text typed while another field saves is not wiped by the refresh', async ({ page }) => {
  let backup: Record<string, unknown> = { enabled: false, bucket: '', region: 'us-west-2', prefix: 'walnut' }
  let puts = 0
  let release: () => void = () => {}
  const held = new Promise<void>((r) => { release = r })
  await page.route('**/api/config', async (route) => {
    const req = route.request()
    if (req.method() === 'PUT') {
      const body = JSON.parse(req.postData() ?? '{}')
      if (body.backup) backup = body.backup
      puts += 1
      if (puts === 1) await held // the switch's write stays in flight until the test says so
      return route.fulfill({ json: { ok: true } })
    }
    const res = await route.fetch()
    const json = await res.json()
    const cfg = json.config ?? json
    cfg.backup = backup
    return route.fulfill({ response: res, json })
  })
  await openSettings(page)
  await clickNav(page, 'backup')
  await page.locator('#backup-enabled').click()
  await expect.poll(() => puts, { timeout: 10_000 }).toBe(1)
  await page.locator('#backup-bucket').fill('example-bucket')
  release() // the switch's save lands now: its refresh carries bucket '' from before the typing
  await page.waitForTimeout(2500)
  await expect(page.locator('#backup-bucket')).toHaveValue('example-bucket')
  await page.unrouteAll({ behavior: 'ignoreErrors' })
})
