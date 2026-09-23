/**
 * Settings per-pane polish: narrow widths, Engines headings, device names,
 * Calendar, Voice, Hooks, Remote Hosts. Same conventions as settings-polish.spec.ts:
 * both engines, real nav clicks after the first load, config writes
 * intercepted so the fixture config never changes under another spec.
 * Screenshots go to /tmp/settings-redesign/shots/r3fix/ (never committed).
 */
import { test, expect, type Page, type Request } from '@playwright/test'

if (process.env.PW_WEBKIT) test.use({ browserName: 'webkit' })
test.setTimeout(120_000)
// The app keeps polling /api/config; an intercepted read can still be in flight
// when a test ends, and its route.fetch would fail the finished test.
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: 'ignoreErrors' }) })

const ENGINE = process.env.PW_WEBKIT ? 'webkit' : 'chromium'
const SHOTS = '/tmp/settings-redesign/shots/r3fix'
const NAV = (id: string) => `settings-nav-${id}`

async function openSettings(page: Page) {
  await page.goto('/settings')
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

/** Engines rows loaded (the fixture's Claude Code settings). */
async function openEngines(page: Page) {
  await clickNav(page, 'engines')
  await expect(page.getByTestId('engine-setting-row-alwaysThinkingEnabled')).toBeVisible({ timeout: 20_000 })
}

/** Rendered line count of an element from its height and line-height. */
async function lines(page: Page, selector: string): Promise<Array<{ text: string; lines: number }>> {
  return page.evaluate((sel) => Array.from(document.querySelectorAll<HTMLElement>(sel))
    .filter((el) => el.getBoundingClientRect().height > 0)
    .map((el) => {
      const lh = parseFloat(getComputedStyle(el).lineHeight) || 19
      return { text: (el.textContent ?? '').trim().slice(0, 40), lines: Math.round(el.getBoundingClientRect().height / lh) }
    }), selector)
}

/** The Mac app's 900px window with its sidebar open: Settings is about 660px. */
async function narrowWithSidebar(page: Page) {
  await page.setViewportSize({ width: 900, height: 800 })
  const expand = page.getByRole('button', { name: 'Expand sidebar' })
  if (await expand.count()) await expand.first().click()
  await expect.poll(async () => page.locator('.settings-container').evaluate((el) => Math.round(el.getBoundingClientRect().width)))
    .toBeLessThan(700)
}

test('N3-01, C42: at 660px no Engines or General label wraps word by word and no control leaves its row', async ({ page }) => {
  await recordWrites(page)
  await openSettings(page)
  await narrowWithSidebar(page)
  await openEngines(page)
  const labels = await lines(page, '.settings-pane .engine-setting-row-pane .settings-row-label')
  expect(labels.length).toBeGreaterThan(10)
  // A long label may take two lines; a word-per-line column is three or more.
  expect(labels.filter((l) => l.lines > 2), JSON.stringify(labels)).toEqual([])
  // Every label keeps at least 45% of its row, or its row put the control underneath.
  const squeezed = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('.settings-pane .engine-setting-row-pane'))
    .filter((r) => r.getBoundingClientRect().height > 0)
    .map((r) => {
      const row = r.getBoundingClientRect()
      const copy = r.querySelector('.settings-row-copy')!.getBoundingClientRect()
      const actions = r.querySelector('.settings-row-actions')!
      const a = actions.getBoundingClientRect()
      const clipped = Array.from(actions.querySelectorAll<HTMLElement>('*')).some((el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== 'visible')
      return { key: r.dataset.testid, share: copy.width / row.width, below: a.top >= copy.bottom - 1, out: a.right > row.right + 1, clipped }
    })
    .filter((r) => (r.share < 0.45 && !r.below) || r.out || r.clipped))
  expect(squeezed, JSON.stringify(squeezed)).toEqual([])
  await page.screenshot({ path: `${SHOTS}/${ENGINE}-660-engines.png` })
  await clickNav(page, 'general')
  const general = await lines(page, '.settings-pane .settings-row-label')
  expect(general.filter((l) => l.lines > 2), JSON.stringify(general)).toEqual([])
  const helps = await lines(page, '.settings-pane .settings-row-help')
  expect(helps.filter((l) => l.lines > 3), JSON.stringify(helps)).toEqual([])
  await page.screenshot({ path: `${SHOTS}/${ENGINE}-660-general.png` })
})

test('N3-02: Engines headings are real topics, never "continued"', async ({ page }) => {
  await recordWrites(page)
  await openSettings(page)
  await openEngines(page)
  const headings = await page.locator('.settings-pane .settings-group-title').allInnerTexts()
  expect(headings.filter((h) => /continued/i.test(h))).toEqual([])
  expect(headings).toEqual(expect.arrayContaining(['Model', 'Replies', 'Workflows', 'Safety']))
})

test('N3-06, N3-07: one source-tag column per group; free text goes under its label', async ({ page }) => {
  await recordWrites(page)
  await page.setViewportSize({ width: 1280, height: 800 })
  await openSettings(page)
  await openEngines(page)
  const spread = await page.evaluate(() => Array.from(document.querySelectorAll('.settings-pane .engine-settings-grid')).map((g) => {
    const xs = Array.from(g.querySelectorAll<HTMLElement>('.engine-setting-row-pane .engine-pane-tag-slot .settings-tag'))
      .filter((t) => t.getBoundingClientRect().height > 0).map((t) => Math.round(t.getBoundingClientRect().left))
    return xs.length ? Math.max(...xs) - Math.min(...xs) : 0
  }))
  expect(spread.every((d) => d <= 1), JSON.stringify(spread)).toBe(true)
  // Every row shows its source, tri-state rows included.
  const untagged = await page.locator('.settings-pane .engine-setting-row-pane:not(:has(.settings-tag))').count()
  expect(untagged).toBe(0)
  const model = page.getByTestId('engine-setting-row-model')
  const help = await lines(page, '[data-testid="engine-setting-row-model"] .settings-row-help')
  expect(help[0].lines).toBeLessThanOrEqual(2)
  const labelBox = await model.locator('.settings-row-label').boundingBox()
  const inputBox = await model.locator('input.engine-setting-text').boundingBox()
  expect(Math.abs(inputBox!.x - labelBox!.x)).toBeLessThanOrEqual(1)
  expect(inputBox!.y).toBeGreaterThan(labelBox!.y + labelBox!.height)
  const langFont = await page.getByTestId('engine-setting-row-language').locator('input').evaluate((el) => getComputedStyle(el).fontFamily)
  expect(langFont).not.toMatch(/mono|menlo|courier/i)
  await page.screenshot({ path: `${SHOTS}/${ENGINE}-1280-engines.png` })
})

test('N3-17: an overridden engine row has no live control, Reset included', async ({ page }) => {
  await recordWrites(page)
  await openSettings(page)
  await openEngines(page)
  const overridden = page.locator('.settings-pane .engine-setting-row-pane[aria-disabled="true"]')
  expect(await overridden.count()).toBeGreaterThan(0)
  const live = await overridden.evaluateAll((rows) => rows.flatMap((r) => Array.from(r.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('button, input, select'))
    .filter((el) => !el.disabled && !el.closest('fieldset:disabled')).map((el) => `${(r as HTMLElement).dataset.testid}: ${el.textContent || el.tagName}`)))
  expect(live).toEqual([])
})

test('N3-03: the placeholder-shaped name "Test phone" pairs as Test-phone, no rule error', async ({ page }) => {
  await recordWrites(page)
  const names: string[] = []
  await page.route('**/api/devices', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    names.push((route.request().postDataJSON() as { name?: string }).name ?? '')
    return route.fulfill({ status: 500, json: { error: 'stub: not created' } })
  })
  await openSettings(page)
  await clickNav(page, 'devices')
  const section = page.locator('#devices')
  await section.locator('#devices-new-name').fill('Test phone')
  await section.getByRole('button', { name: 'Pair new device' }).click()
  await expect.poll(() => names).toEqual(['Test-phone'])
  await expect(section).not.toContainText('Invalid device name')
})

test('N3-04: Calendar plugin Configure links to Calendar Accounts instead of a second id editor', async ({ page }) => {
  await recordWrites(page)
  await openSettings(page)
  await clickNav(page, 'plugin-store')
  const configure = page.getByTestId('plugin-configure-calendar')
  await expect(configure).toBeVisible({ timeout: 30_000 })
  await configure.click()
  const form = page.getByTestId('plugin-config-calendar')
  await expect(form.getByTestId('plugin-config-owned-calendar')).toBeVisible()
  await expect(form.locator('#plugin-calendar-hidden_calendar_ids, #plugin-calendar-visible_calendar_ids, textarea')).toHaveCount(0)
  await form.scrollIntoViewIfNeeded()
  await page.screenshot({ path: `${SHOTS}/${ENGINE}-plugin-configure.png` })
  await form.getByRole('link', { name: 'Open Calendar Accounts' }).click()
  await expect(page.getByTestId(NAV('calendar'))).toHaveAttribute('aria-current', 'page')
})

test('N3-05: the Voice scan line is replaced in place; nothing below it moves', async ({ page }) => {
  await recordWrites(page)
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => { release = r })
  await page.route('**/api/stt/detect', async (route) => { await gate; return route.fallback() })
  await openSettings(page)
  await clickNav(page, 'stt')
  const scan = page.getByTestId('stt-scan-row')
  await expect(scan).toContainText('Scanning this Mac...')
  // Page offsets (scroll-proof): the scan row's own top and height.
  const geo = () => scan.evaluate((el) => {
    const scroller = el.closest<HTMLElement>('.settings-pane')!
    const r = el.getBoundingClientRect()
    return { top: Math.round(r.top + scroller.scrollTop), height: Math.round(r.height) }
  })
  const before = await geo()
  release()
  await expect(scan.locator('.stt-scan-status')).toHaveAttribute('data-scan', /done|failed/, { timeout: 20_000 })
  await expect(scan).not.toContainText('Scanning this Mac...')
  expect((await scan.locator('.stt-scan-status').innerText()).length).toBeGreaterThan(5)
  // Replaced in place: same row, same box, so nothing under it is pulled up.
  expect(await geo()).toEqual(before)
  // Model rows found by the scan are ordinary rows (copy left, action right),
  // never the legacy column layout that centred their copy.
  const dirs = await page.locator('.settings-pane [data-testid^="stt-model-"]').evaluateAll((els) =>
    els.map((e) => getComputedStyle(e).flexDirection))
  expect(dirs.filter((d) => d !== 'row')).toEqual([])
})

test('N3-08: number boxes in consecutive rows share both edges', async ({ page }) => {
  await recordWrites(page)
  await page.setViewportSize({ width: 1280, height: 800 })
  await openSettings(page)
  await clickNav(page, 'sessions')
  const a = (await page.locator('#idle-timeout').boundingBox())!
  const b = (await page.locator('#max-idle').boundingBox())!
  expect(Math.abs(a.x - b.x)).toBeLessThanOrEqual(1)
  expect(Math.abs(a.x + a.width - (b.x + b.width))).toBeLessThanOrEqual(1)
})

test('N3-09, N3-10: the compact bar is opaque from its first frame; header actions sit on the title line', async ({ page }) => {
  await recordWrites(page)
  await page.setViewportSize({ width: 1280, height: 800 })
  await openSettings(page)
  await clickNav(page, 'usage')
  const title = (await page.locator('.settings-pane .settings-pane-title').first().boundingBox())!
  const trailing = (await page.locator('.settings-pane .settings-pane-header-trailing').first().boundingBox())!
  expect(Math.abs(trailing.y + trailing.height / 2 - (title.y + title.height / 2))).toBeLessThanOrEqual(1)
  await openEngines(page)
  const state = await page.evaluate(async () => {
    const scroller = document.querySelector<HTMLElement>('.settings-pane')!
    const inner = document.querySelector<HTMLElement>('.settings-pane .settings-pane-stickybar-inner')!
    scroller.scrollTop = 700
    // The very next frame after the bar turns compact.
    for (let i = 0; i < 30 && !inner.closest('.is-compact'); i++) await new Promise((r) => requestAnimationFrame(r))
    let op = 1
    for (let n: HTMLElement | null = inner; n; n = n.parentElement) op *= parseFloat(getComputedStyle(n).opacity)
    return { compact: !!inner.closest('.is-compact'), op, bg: getComputedStyle(inner).backgroundColor }
  })
  expect(state.compact).toBe(true)
  expect(state.op).toBe(1)
  expect(state.bg).not.toMatch(/rgba\(.*,\s*0\)|transparent/)
})

test('N3-11, N3-12: hook chevrons share one x, no repeated group tag, no developer details', async ({ page }) => {
  await recordWrites(page)
  await page.setViewportSize({ width: 1280, height: 800 })
  await openSettings(page)
  await clickNav(page, 'hooks')
  const walnut = page.getByTestId('hooks-group-walnut')
  await expect(walnut.locator('.hook-row').first()).toBeVisible({ timeout: 20_000 })
  const xs = await walnut.locator('.hook-row-disclose .settings-disclosure-chevron').evaluateAll((els) =>
    els.map((e) => Math.round(e.getBoundingClientRect().left)))
  expect(new Set(xs).size, JSON.stringify(xs)).toBe(1)
  await expect(walnut.locator('.hook-row .settings-tag', { hasText: 'Built-in' })).toHaveCount(0)
  await expect(page.getByTestId('hooks-group-daemon').locator('.hook-row .settings-tag', { hasText: 'Daemon policy' })).toHaveCount(0)
  // The hook whose server description read "Auto-updates task.cwd ... missing cwds".
  const first = page.getByTestId('hook-disclose-cwd-rename-detector')
  await first.click()
  const details = page.locator('#hook-details-cwd-rename-detector')
  await expect(details).toBeVisible()
  await expect(details.locator('.hook-description-row')).toHaveCount(0)
  await expect(details).not.toContainText(/cwds|task\.cwd|note\/summary/)
})

test('N3-13, N3-14: match hints keep the matched word whole; a scrolled nav list gets an edge', async ({ page }) => {
  await recordWrites(page)
  await page.setViewportSize({ width: 1280, height: 800 })
  await openSettings(page)
  await page.getByTestId('settings-filter').fill('model')
  const hints = page.locator('.settings-nav .settings-nav-hint')
  await expect(hints.first()).toBeVisible()
  const cut = await hints.evaluateAll((els) => els.filter((e) => e.scrollHeight > e.clientHeight + 1 || e.scrollWidth > e.clientWidth + 1)
    .map((e) => e.textContent))
  expect(cut).toEqual([])
  const texts = await hints.allInnerTexts()
  expect(texts.every((t) => /model/i.test(t)), JSON.stringify(texts)).toBe(true)
  await page.getByTestId('settings-filter').fill('')
  await clickNav(page, 'advanced')
  const nav = page.locator('.settings-nav')
  const list = page.locator('#settings-nav-list')
  const scrolled = await list.evaluate((el) => el.scrollTop > 0)
  if (!scrolled) await list.evaluate((el) => { el.scrollTop = 120; el.dispatchEvent(new Event('scroll')) })
  await expect(nav).toHaveClass(/is-list-scrolled/)
  const edge = await page.locator('.settings-nav .settings-filter-wrap').evaluate((el) => getComputedStyle(el, '::after').height)
  expect(edge).toBe('1px')
})

test('N3-15, N3-16: the name placeholder is not a fake name; a suggestion field draws the settings chevron', async ({ page }) => {
  await recordWrites(page)
  await openSettings(page)
  await clickNav(page, 'general')
  await expect(page.locator('#settings-name')).toHaveAttribute('placeholder', 'Your name')
  await clickNav(page, 'tasks')
  const project = page.locator('#settings-project')
  await expect(project).toBeVisible()
  const bg = await project.evaluate((el) => getComputedStyle(el).backgroundImage)
  expect(bg).toContain('svg')
})

test('N3-18: a stacked control starts at the label and spans the row', async ({ page }) => {
  await recordWrites(page)
  await page.setViewportSize({ width: 1280, height: 800 })
  await openSettings(page)
  await clickNav(page, 'plugin-store')
  const row = page.locator('.settings-row', { has: page.locator('#plugin-source-url') })
  await expect(row).toBeVisible({ timeout: 30_000 })
  const label = (await row.locator('.settings-row-label').boundingBox())!
  const input = (await page.locator('#plugin-source-url').boundingBox())!
  const actions = (await row.locator('.settings-row-actions').boundingBox())!
  const box = (await row.boundingBox())!
  expect(Math.abs(input.x - label.x)).toBeLessThanOrEqual(1)
  expect(box.x + box.width - (actions.x + actions.width)).toBeLessThanOrEqual(20)
  await expect(page.locator('#plugin-store')).toContainText('full access to your tasks, notes, credentials and this Mac.')
  await expect(page.locator('#plugin-store')).not.toContainText('On, with no sign-in state to report.')
})

test('N3-20, N3-21, N3-22: host row shows its address, Remove sits by Edit, limits are labelled rows, Shell setup stacks', async ({ page }) => {
  await recordWrites(page)
  await page.setViewportSize({ width: 1280, height: 800 })
  await openSettings(page)
  await clickNav(page, 'remote-hosts')
  const host = page.locator('.rh-host-row').first()
  await expect(host).toBeVisible({ timeout: 20_000 })
  const sub = host.locator('.settings-addons-mono')
  if (await sub.count()) await expect(sub.first()).toHaveText(/\./) // a hostname, not the display label
  const remove = (await host.getByTestId('devices-remove').or(host.getByRole('button', { name: /^Remove/ })).first().boundingBox())!
  const edit = (await host.getByRole('button', { name: 'Edit' }).boundingBox())!
  expect(edit.x - (remove.x + remove.width)).toBeLessThanOrEqual(12)
  const add = page.locator('.rh-limit-add')
  await expect(add.locator('.settings-row-label')).toHaveText('Add limit')
  await expect(page.locator('.kv-editor')).toHaveCount(0)
  await host.getByRole('button', { name: 'Edit' }).click()
  const shell = page.locator('.settings-row', { has: page.locator('textarea[id^="rh-shell-"]') }).first()
  const label = (await shell.locator('.settings-row-label').boundingBox())!
  const area = (await shell.locator('textarea').boundingBox())!
  expect(area.y).toBeGreaterThan(label.y + label.height - 1)
  expect(Math.abs(area.x - label.x)).toBeLessThanOrEqual(1)
  await page.screenshot({ path: `${SHOTS}/${ENGINE}-remote-hosts-edit.png` })
})

test('N3-23, N3-24, N3-25, N3-26: Advanced dims the SDK port, shows seconds and minutes, edges the raw config', async ({ page }) => {
  await recordWrites(page)
  await openSettings(page)
  await clickNav(page, 'advanced')
  await page.getByTestId('advanced-disclosure-sdk').click()
  const sdkOn = await page.locator('#sdk-enabled').getAttribute('aria-checked')
  if (sdkOn !== 'true') {
    await expect(page.locator('.settings-row', { has: page.locator('#sdk-port') })).toHaveAttribute('aria-disabled', 'true')
    await expect(page.locator('#sdk-port')).toHaveAttribute('readonly', '')
  }
  await page.locator('[data-testid="advanced-disclosure-git"], #advanced-git [aria-expanded]').first().click().catch(() => {})
  const unit = (id: string) => page.locator('.settings-input-with-unit', { has: page.locator(`#${id}`) }).locator('.settings-input-unit')
  await expect(unit('git-debounce')).toHaveText('seconds')
  await expect(unit('git-interval')).toHaveText('minutes')
  await expect(unit('exec-timeout')).toHaveText('seconds')
  await page.getByTestId('advanced-disclosure-raw').click()
  const pre = page.getByTestId('advanced-raw-config')
  const css = await pre.evaluate((el) => ({ pb: parseFloat(getComputedStyle(el).paddingBottom), bw: parseFloat(getComputedStyle(el).borderBottomWidth) }))
  expect(css.pb).toBeGreaterThanOrEqual(8)
  expect(css.bw).toBeGreaterThanOrEqual(1)
  // The API provider section is folded into Advanced (no nav row of its own).
  await expect(page.locator('#providers')).not.toContainText('Credential source')
  await expect(page.locator('#providers')).not.toContainText(/Ready, access keys/)
})

test('N3-27: Jev without a key: short placeholder, Test connection disabled, one-line help that never grows the row', async ({ page }) => {
  await recordWrites(page)
  // Serve the fixture config with Jev picked and no key, as a first-time user sees it.
  await page.route((url) => url.pathname === '/api/config', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    const res = await route.fetch()
    const body = await res.json()
    const cfg = body.config ?? body
    cfg.jev = { ...(cfg.jev ?? {}), api_key: undefined, decisions: { quick_parse: true, session_organize: true } }
    return route.fulfill({ response: res, json: body })
  })
  await openSettings(page)
  await clickNav(page, 'tasks')
  const jev = page.getByTestId('jev-settings')
  await expect(jev).toBeVisible({ timeout: 20_000 })
  await expect(jev.getByTestId('jev-no-key')).toBeVisible()
  await expect(jev.locator('#jev-key')).toHaveAttribute('placeholder', 'API key')
  await expect(jev.getByTestId('jev-test')).toBeDisabled()
  await expect(jev.getByTestId('jev-no-key')).not.toContainText('default engine')
  const conn = jev.locator('.settings-row', { has: page.getByTestId('jev-test') })
  await expect(conn.locator('.settings-row-help')).toHaveText('Add an API key first.')
})

test('N3-28: macOS Access puts the state first, then a named action', async ({ page }) => {
  await recordWrites(page)
  await page.route((url) => url.pathname === '/api/permissions', (route) => route.request().method() !== 'GET' ? route.fallback() : route.fulfill({
    json: {
      applicable: true, launcher: { kind: 'mac-app', name: 'Walnut' },
      permissions: [
        { id: 'calendar', label: 'Calendar', why: 'Reads your calendars.', state: 'unknown', launcherIndependent: true },
        { id: 'fda', label: 'Full Disk Access', why: 'Reads session files.', state: 'denied', launcherIndependent: true },
      ],
    },
  }))
  await openSettings(page)
  await clickNav(page, 'permissions')
  const row = page.locator('.permission-row', { hasText: 'Full Disk Access' })
  await expect(row).toBeVisible({ timeout: 20_000 })
  const order = await row.locator('.settings-row-actions > *').evaluateAll((els) => els.map((e) => e.className))
  expect(order[0]).toContain('permission-row-state')
  await expect(row.getByRole('button', { name: 'Open System Settings...' })).toBeVisible()
  await expect(page.locator('.permission-row', { hasText: 'Calendar' }).locator('.permission-row-state')).toHaveText("Couldn't check")
  await expect(page.locator('.settings-pane')).not.toContainText('Fix...')
})

test('N3-30, N3-31: folded descriptions use the column; plain labels and reasons', async ({ page }) => {
  await recordWrites(page)
  await page.setViewportSize({ width: 1280, height: 800 })
  await openSettings(page)
  await clickNav(page, 'advanced')
  const folded = page.locator('#providers .settings-folded-desc')
  await expect(folded).toBeVisible({ timeout: 20_000 })
  const maxWidth = await folded.evaluate((el) => getComputedStyle(el).maxWidth)
  expect(maxWidth).toBe('100%')
  const header = (await page.locator('#providers .settings-folded-header').boundingBox())!
  const firstGroup = page.locator('#providers .settings-group-title, #providers .settings-group').first()
  const gap = (await firstGroup.boundingBox())!.y - (header.y + header.height)
  expect(gap).toBeGreaterThanOrEqual(21)
  await clickNav(page, 'calendar')
  await expect(page.locator('.settings-pane')).not.toContainText('Last refreshed')
  await clickNav(page, 'audio-capture')
  const storage = page.locator('.settings-group-block', { has: page.locator('.settings-group-title', { hasText: 'Storage' }) })
  await expect(storage).not.toContainText('App refresh interval')
  await clickNav(page, 'stt')
  await expect(page.locator('.settings-pane')).not.toContainText('for example Samantha')
  await clickNav(page, 'suggest-accuracy')
  await expect(page.locator('.settings-pane .settings-row-label', { hasText: /^Ledger$/ })).toHaveCount(0)
})

test('evidence: 660px panes keep controls inside their groups with no horizontal scroll', async ({ page }) => {
  await recordWrites(page)
  await openSettings(page)
  await narrowWithSidebar(page)
  for (const id of ['general', 'tasks', 'engines', 'plugin-store', 'remote-hosts', 'advanced']) {
    await clickNav(page, id)
    await page.waitForTimeout(600)
    const bad = await page.evaluate(() => {
      const pane = document.querySelector<HTMLElement>('.settings-pane')!
      const out = Array.from(document.querySelectorAll<HTMLElement>('.settings-pane .settings-row-actions'))
        .filter((a) => a.getBoundingClientRect().height > 0)
        .filter((a) => {
          const g = a.closest('.settings-group')!.getBoundingClientRect()
          const r = a.getBoundingClientRect()
          return r.right > g.right + 1 || r.left < g.left - 1
        }).map((a) => a.closest('.settings-row')?.textContent?.slice(0, 30))
      return { hscroll: pane.scrollWidth > pane.clientWidth + 1, out }
    })
    expect(bad, id).toEqual({ hscroll: false, out: [] })
    await page.screenshot({ path: `${SHOTS}/${ENGINE}-660-${id}.png` })
  }
})
