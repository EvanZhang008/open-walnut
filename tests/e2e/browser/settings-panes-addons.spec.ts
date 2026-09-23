/**
 * Settings panes for add-ons, machines and diagnostics: Plugins, Calendar
 * Accounts, S3 Backup, Audio Capture, Phones & Cloud, Remote Hosts, Usage.
 *
 * Every pane is opened by a real nav click. The data these panes read from the
 * Mac (EventKit calendars, plugin registry, account links, paired phones) is
 * served by page.route fixtures with neutral names, and every write is
 * intercepted, so nothing here changes the shared fixture config.
 *
 * Runs in both engines: Chromium by default, WebKit (the Mac app is a
 * WKWebView) with `PW_WEBKIT=1 ... --project=webkit`.
 */
import { test, expect, type Page, type Route } from '@playwright/test'

if (process.env.PW_WEBKIT) test.use({ browserName: 'webkit' })
test.setTimeout(120_000)

const NAV = (id: string) => `settings-nav-${id}`

async function openSettings(page: Page) {
  await page.goto('/settings')
  await expect(page.locator('.settings-nav')).toBeVisible({ timeout: 30_000 })
}

async function clickNav(page: Page, id: string) {
  const item = page.getByTestId(NAV(id))
  await item.click()
  await expect(item).toHaveAttribute('aria-current', 'page')
  await expect(page.locator(`.settings-pane [id="${id}"].settings-section`)).toBeVisible({ timeout: 30_000 })
}

/** Viewport evidence (1280 wide at most), one file per engine; never deleted. */
async function shot(page: Page, name: string) {
  const engine = page.context().browser()?.browserType().name() ?? 'browser'
  // CSS pixels: WebKit's 2x device scale would otherwise double the width.
  await page.screenshot({ path: `/tmp/settings-redesign/p4-${engine}-${name}.png`, scale: 'css' })
}

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })

/**
 * Config reads return the real fixture config with `patch` applied; config writes
 * are answered `ok` and remembered, so the next read (the page rebases every save
 * on a fresh read) sees what was written, and the fixture file is never touched.
 */
async function mockConfig(page: Page, patch: (cfg: Record<string, unknown>) => void) {
  let written: Record<string, unknown> | null = null
  const puts: Array<Record<string, unknown>> = []
  await page.route('**/api/config', async (route) => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON() as Record<string, unknown>
      puts.push(body)
      written = (body.config as Record<string, unknown> | undefined) ?? body
      return json(route, { ok: true })
    }
    const res = await route.fetch()
    const data = await res.json() as { config: Record<string, unknown> }
    if (written) data.config = { ...data.config, ...written }
    else patch(data.config)
    return json(route, data)
  })
  return puts
}

// ---------------------------------------------------------------------------
// Calendar fixture: 40 calendars in three accounts, neutral names only.
// ---------------------------------------------------------------------------

interface Cal { id: string; title: string; account: string; color: string; readonly: boolean; hidden: boolean }

const UUID_TITLE = '0f8fad5b-d9cb-469f-a165-70867728950e'
function calendars(): Cal[] {
  const out: Cal[] = []
  const plan: Array<[string, number]> = [['Personal', 14], ['Work', 14], ['Holidays', 12]]
  for (const [account, n] of plan) {
    for (let i = 1; i <= n; i += 1) {
      out.push({
        id: `${account.toLowerCase()}-${i}`,
        title: account === 'Work' && i === 3 ? UUID_TITLE : `${account} calendar ${i}`,
        account,
        color: ['#FF3B30', '#34C759', '#007AFF', '#AF52DE'][i % 4],
        readonly: account === 'Holidays',
        hidden: i % 3 === 0,
      })
    }
  }
  return out
}

interface CalendarMock {
  puts: Array<{ enabled?: boolean; hidden_calendar_ids?: string[] }>
  maxInFlight: number
  hidden: () => string[]
}

/** EventKit through page.route: GET list, PUT source (optional delay/failure), POST refresh. */
async function mockCalendar(page: Page, opts: { putDelayMs?: number; failEnabled?: boolean; refreshedDaysAgo?: number } = {}) {
  const cals = calendars()
  const source = {
    id: 'eventkit', available: true, enabled: true, eventCount: 212,
    lastRefresh: new Date(Date.now() - (opts.refreshedDaysAgo ?? 0) * 86_400_000).toISOString(),
  }
  const mock: CalendarMock = { puts: [], maxInFlight: 0, hidden: () => cals.filter((c) => c.hidden).map((c) => c.id) }
  let inFlight = 0
  await page.route('**/api/calendar/sources', (route) => json(route, { sources: [source], calendars: cals }))
  await page.route('**/api/calendar/sources/eventkit', async (route) => {
    const body = route.request().postDataJSON() as CalendarMock['puts'][number]
    mock.puts.push(body)
    inFlight += 1
    mock.maxInFlight = Math.max(mock.maxInFlight, inFlight)
    if (opts.putDelayMs) await new Promise((r) => setTimeout(r, opts.putDelayMs))
    inFlight -= 1
    if (body.enabled !== undefined && opts.failEnabled) return json(route, { error: 'calendar store is busy' }, 500)
    if (body.enabled !== undefined) source.enabled = body.enabled
    if (body.hidden_calendar_ids) {
      const set = new Set(body.hidden_calendar_ids)
      for (const c of cals) c.hidden = set.has(c.id)
    }
    return json(route, { sources: [source] })
  })
  await page.route('**/api/calendar/refresh', async (route) => {
    await new Promise((r) => setTimeout(r, 600))
    source.lastRefresh = new Date().toISOString()
    source.eventCount = 230
    return json(route, { sources: [source] })
  })
  return mock
}

const accountGroup = (page: Page, account: string) =>
  page.getByTestId('calendar-account-group').filter({ has: page.locator('.settings-group-title', { hasText: account }) })
const countOf = (page: Page, account: string) => accountGroup(page, account).getByTestId('calendar-account-count')

// Settings re-reads /api/config on its own clock; WebKit tears the page down fast
// enough that one such read can still be inside a route callback when a test ends.
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' })
})

test('runs in the engine it was asked for', async ({ browserName }) => {
  expect(browserName).toBe(process.env.PW_WEBKIT ? 'webkit' : 'chromium')
})

test('C32 C33: calendar accounts are checklists with live counts, Refresh now keeps its layout', async ({ page }) => {
  const mock = await mockCalendar(page, { refreshedDaysAgo: 3 })
  await openSettings(page)
  await clickNav(page, 'calendar')

  const master = page.locator('#calendar-enabled')
  await expect(master).toHaveAttribute('role', 'switch')
  await expect(master).toHaveAttribute('aria-checked', 'true')
  // 3 days ago reads as a weekday, never "ago".
  const refreshed = page.getByTestId('calendar-last-refreshed')
  await expect(refreshed.locator('.settings-row-help')).toHaveText(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{1,2}:\d{2}\s?(AM|PM), 212 events cached$/)

  await expect(page.getByTestId('calendar-account-group')).toHaveCount(3)
  await expect(countOf(page, 'Personal')).toHaveText('10 of 14 shown')
  await expect(countOf(page, 'Holidays')).toHaveText('8 of 12 shown')
  await expect(accountGroup(page, 'Holidays').locator('.settings-tag', { hasText: 'Read only' })).toHaveCount(12)
  await expect(accountGroup(page, 'Personal').locator('.settings-tag', { hasText: 'Read only' })).toHaveCount(0)

  // A UUID title is shown as Untitled calendar, the raw value in the title.
  const untitled = page.locator('.settings-checkbox-row', { hasText: 'Untitled calendar' })
  await expect(untitled).toHaveCount(1)
  await expect(untitled).toHaveAttribute('title', UUID_TITLE)

  // The checkbox is drawn by us; the native input stays checkable and Space toggles it.
  const box = page.getByTestId('calendar-checkbox-personal-3')
  await expect(box).not.toBeChecked()
  expect(await box.evaluate((el) => {
    const cs = getComputedStyle(el) as CSSStyleDeclaration & { webkitAppearance?: string }
    return cs.appearance || cs.webkitAppearance
  })).toBe('none')
  await box.check()
  await expect(countOf(page, 'Personal')).toHaveText('11 of 14 shown')
  await expect(page.getByTestId('settings-saved-indicator')).toHaveText(/Saved/, { timeout: 5_000 })
  await box.focus()
  await page.keyboard.press('Space')
  await expect(box).not.toBeChecked()
  await expect(countOf(page, 'Personal')).toHaveText('10 of 14 shown')
  await expect.poll(() => mock.hidden().includes('personal-3')).toBe(true)

  // Refresh now: busy label, disabled, same width, never over its help text.
  const button = page.getByTestId('calendar-refresh-now')
  const before = await button.boundingBox()
  await button.click()
  await expect(button).toHaveText('Refreshing...')
  await expect(button).toBeDisabled()
  const during = await button.boundingBox()
  const help = await refreshed.locator('.settings-row-help').boundingBox()
  expect(Math.abs((during?.width ?? 0) - (before?.width ?? 0))).toBeLessThanOrEqual(1)
  expect(Math.abs((during?.x ?? 0) - (before?.x ?? 0))).toBeLessThanOrEqual(1)
  const overlaps = !!help && !!during && help.x < during.x + during.width && during.x < help.x + help.width
    && help.y < during.y + during.height && during.y < help.y + help.height
  expect(overlaps).toBe(false)
  await expect(button).toHaveText('Refresh now', { timeout: 10_000 })
  await expect(refreshed.locator('.settings-row-help')).toHaveText(/^\d{1,2}:\d{2}\s?(AM|PM), 230 events cached$/)
  await shot(page, 'calendar')
})

test('C78: Hide all writes once, quick checks never overlap, a failed master switch reverts', async ({ page }) => {
  const mock = await mockCalendar(page, { putDelayMs: 500, failEnabled: true })
  await openSettings(page)
  await clickNav(page, 'calendar')
  await expect(countOf(page, 'Work')).toHaveText('10 of 14 shown')

  await accountGroup(page, 'Work').getByRole('button', { name: 'Hide all' }).click()
  await expect(countOf(page, 'Work')).toHaveText('0 of 14 shown')
  await expect.poll(() => mock.puts.length).toBe(1)
  await expect.poll(() => mock.hidden().filter((id) => id.startsWith('work-')).length).toBe(14)

  // Two checks inside 100ms while writes take 500ms: one request in flight at a time,
  // and the last write carries the final UI state.
  const start = mock.puts.length
  await page.getByTestId('calendar-checkbox-personal-1').uncheck()
  await page.getByTestId('calendar-checkbox-personal-2').uncheck()
  await expect.poll(() => mock.puts.length, { timeout: 10_000 }).toBe(start + 2)
  expect(mock.maxInFlight).toBe(1)
  const last = mock.puts[mock.puts.length - 1].hidden_calendar_ids ?? []
  expect(last).toEqual(expect.arrayContaining(['personal-1', 'personal-2']))
  await expect(countOf(page, 'Personal')).toHaveText('8 of 14 shown')

  // Master switch write fails: the thumb returns, the row says why, Not saved shows.
  const master = page.locator('#calendar-enabled')
  await master.click()
  await expect(master).toHaveAttribute('aria-checked', 'true', { timeout: 10_000 })
  await expect(page.locator('#calendar [role="alert"]', { hasText: "Couldn't save" })).toBeVisible()
  await expect(page.getByTestId('settings-saved-indicator')).toHaveText(/Not saved/)
})

test('C67: checking the last of 40 calendars shows Saved inside the viewport on the 44px bar', async ({ page }) => {
  await mockCalendar(page)
  await page.setViewportSize({ width: 1280, height: 800 })
  await openSettings(page)
  await clickNav(page, 'calendar')
  const last = page.getByTestId('calendar-checkbox-holidays-12')
  await last.scrollIntoViewIfNeeded()
  await page.locator('.settings-pane').evaluate((el) => { el.scrollTop = el.scrollHeight })
  await expect(page.locator('.settings-pane-stickybar.is-compact, .settings-pane-stickybar .is-compact').first()).toBeAttached({ timeout: 5_000 })
  await last.click({ force: true })
  const indicator = page.getByTestId('settings-saved-indicator')
  await expect(indicator).toHaveText(/Saved/, { timeout: 5_000 })
  const box = await indicator.boundingBox()
  const vp = page.viewportSize()!
  expect(box).not.toBeNull()
  expect(box!.y).toBeGreaterThanOrEqual(0)
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.y + box!.height).toBeLessThanOrEqual(vp.height)
  expect(box!.x + box!.width).toBeLessThanOrEqual(vp.width)
  const barHeight = await page.evaluate(() => {
    const bar = document.querySelector('.settings-pane-stickybar')
    const inner = bar?.firstElementChild as HTMLElement | null
    return inner ? inner.getBoundingClientRect().height : 0
  })
  expect(Math.abs(barHeight - 44)).toBeLessThanOrEqual(2)
})

/**
 * aria-disabled and not interactive (inert), yet still on screen. N07: the card
 * surface stays solid (the group itself is at 1) and its heading and rows fade
 * to 45%, once.
 */
async function expectDimmed(page: Page, selector: string) {
  const el = page.locator(selector).first()
  await expect(el).toBeVisible()
  await expect(el).toHaveAttribute('aria-disabled', 'true')
  expect(Number(await el.evaluate((n) => getComputedStyle(n).opacity))).toBe(1)
  const inner = await el.evaluate((n) => Array.from(n.querySelectorAll<HTMLElement>('.settings-group-heading, .settings-row'))
    .filter((c) => c.getBoundingClientRect().height > 0)
    .map((c) => { let op = 1; for (let x: HTMLElement | null = c; x && x !== n.parentElement; x = x.parentElement) op *= parseFloat(getComputedStyle(x).opacity); return op }))
  expect(inner.length).toBeGreaterThan(0)
  for (const op of inner) expect(op).toBeCloseTo(0.45, 2)
  expect(await el.evaluate((n) => (n as HTMLElement).inert === true || n.hasAttribute('inert'))).toBe(true)
}

test('C51 C79: S3 Backup can be filled in and tested before it is switched on; Test connection keeps its box', async ({ page }) => {
  await mockCalendar(page)
  await mockConfig(page, (cfg) => { cfg.backup = { enabled: false, bucket: '', region: 'us-west-2', prefix: 'walnut' } })
  await openSettings(page)

  // S3 Backup: master first; Destination and Credentials stay usable while off,
  // so a bucket can be set up and tested before any scheduled run is armed.
  await clickNav(page, 'backup')
  const firstRow = page.locator('#backup .settings-row').first()
  await expect(firstRow).toContainText('Scheduled backups')
  await expect(page.locator('#backup-enabled')).toHaveAttribute('aria-checked', 'false')
  for (const heading of ['Destination', 'Credentials']) {
    await expect(page.locator(`#backup .settings-group-block:has(.settings-group-title:text-is("${heading}"))`)).not.toHaveAttribute('aria-disabled', 'true')
  }
  await expect(page.locator('#backup-bucket')).toBeEditable()
  await shot(page, 'backup-off')
  await page.locator('#backup-enabled').click()
  await expect(page.locator('#backup-enabled')).toHaveAttribute('aria-checked', 'true')
  await expect(page.locator('#backup .settings-group-block:has(.settings-group-title:text-is("Destination"))')).not.toHaveAttribute('aria-disabled', 'true')
  await expect(page.locator('#backup-bucket')).toBeEditable()

  // C79: Test connection turns into Testing... in the same box, and the row's
  // label does not move.
  await page.route('**/api/backup/test', async (route) => {
    await new Promise((r) => setTimeout(r, 800))
    return json(route, { ok: false, error: 'bucket not found' })
  })
  await page.locator('#backup-bucket').fill('example-bucket')
  const testBtn = page.getByTestId('backup-test-connection')
  const connRow = page.getByTestId('backup-connection-row')
  const label = connRow.locator('.settings-row-label')
  const [btnBefore, labelBefore] = [await testBtn.boundingBox(), await label.boundingBox()]
  await testBtn.click()
  await expect(testBtn).toHaveText('Testing...')
  const [btnDuring, labelDuring] = [await testBtn.boundingBox(), await label.boundingBox()]
  expect(Math.abs((btnDuring?.x ?? 0) - (btnBefore?.x ?? 0))).toBeLessThanOrEqual(1)
  expect(Math.abs((btnDuring?.width ?? 0) - (btnBefore?.width ?? 0))).toBeLessThanOrEqual(1)
  expect(Math.abs((labelDuring?.x ?? 0) - (labelBefore?.x ?? 0))).toBeLessThanOrEqual(1)
  expect(Math.abs((labelDuring?.width ?? 0) - (labelBefore?.width ?? 0))).toBeLessThanOrEqual(1)
  await expect(connRow).toContainText("Couldn't connect: bucket not found")
  await expect(testBtn).toHaveText('Test connection')

  // Calendar: master off dims every account group but keeps it visible.
  await clickNav(page, 'calendar')
  await page.locator('#calendar-enabled').click()
  await expect(page.locator('#calendar-enabled')).toHaveAttribute('aria-checked', 'false')
  await expectDimmed(page, '[data-testid="calendar-account-group"]')
  await expect(page.getByTestId('calendar-account-group')).toHaveCount(3)
})

test('Audio Capture: the recording control leads, excluded apps are rows with Remove', async ({ page }) => {
  await mockConfig(page, (cfg) => { cfg.audio = { exclude_apps: ['com.example.player'] } })
  await openSettings(page)
  await clickNav(page, 'audio-capture')
  const rows = page.locator('#audio-capture .settings-row')
  await expect(rows.first()).toContainText('Recording')
  const row = page.locator('#audio-capture .settings-row', { hasText: 'com.example.player' })
  await expect(row.getByRole('button', { name: 'Remove com.example.player' })).toBeVisible()
  await expect(page.locator('#audio-delete-after-transcription')).toHaveAttribute('role', 'switch')
  await expect(page.locator('#audio-capture input[type="checkbox"]:visible')).toHaveCount(0)
})

test('C54 C79: removing a phone and showing a new QR are two-step, and the button keeps its box', async ({ page }) => {
  const deletes: string[] = []
  const mints: Array<Record<string, unknown>> = []
  await page.route('**/api/devices', async (route) => {
    if (route.request().method() === 'POST') {
      mints.push(route.request().postDataJSON() as Record<string, unknown>)
      return json(route, { name: 'Test phone', token: 'tok-test-1', pairingURI: 'wn://pair?token=tok-test-1', target: 'lan', server: 'http://192.0.2.10:3456' })
    }
    return json(route, {
      devices: deletes.length ? [] : [{ name: 'Test phone', createdAt: new Date(Date.now() - 86_400_000).toISOString(), role: 'phone' }],
      cloudDevices: [],
      targets: [{ kind: 'lan', label: 'This network', origin: 'http://192.0.2.10:3456' }],
    })
  })
  await page.route('**/api/devices/*', (route) => {
    deletes.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`)
    return json(route, { ok: true })
  })
  await openSettings(page)
  await clickNav(page, 'devices')
  await expect(page.locator('#cloud.settings-section')).toBeAttached()
  const row = page.locator('.devices-row', { hasText: 'Test phone' })
  await expect(row).toBeVisible()

  // Remove: arm, let it disarm after 3s without a request, then arm and confirm.
  const remove = row.getByTestId('devices-remove')
  const before = await remove.boundingBox()
  await remove.click()
  await expect(remove).toHaveText('Confirm remove')
  const armed = await remove.boundingBox()
  expect(Math.abs((armed?.width ?? 0) - (before?.width ?? 0))).toBeLessThanOrEqual(1)
  expect(Math.abs((armed?.x ?? 0) - (before?.x ?? 0))).toBeLessThanOrEqual(1)
  await expect(remove).toHaveText('Remove', { timeout: 5_000 })
  expect(deletes).toEqual([])

  // Show QR (a new token for the same phone): two steps as well, then the QR row.
  const showQr = row.getByTestId('devices-show-qr')
  await showQr.click()
  await expect(showQr).toHaveText('Confirm new QR')
  expect(mints).toEqual([])
  await showQr.click()
  await expect.poll(() => mints.length).toBe(1)
  expect(mints[0]).toMatchObject({ name: 'Test phone', replace: true })
  const qr = page.locator('#devices .devices-qr-block img')
  await expect(qr).toBeVisible()
  expect((await qr.boundingBox())!.width).toBeLessThanOrEqual(200.5)
  await qr.scrollIntoViewIfNeeded()
  await shot(page, 'devices-qr')
  await page.locator('#devices').getByRole('button', { name: 'Done' }).click()

  await remove.click()
  await remove.click()
  await expect.poll(() => deletes).toEqual(['DELETE /api/devices/Test%20phone'])
  await expect(page.locator('#devices')).toContainText('No phones paired yet.')
})

test('Remote Hosts: Add host lives in the header, the empty state says so', async ({ page }) => {
  await mockConfig(page, (cfg) => { cfg.hosts = {} })
  await openSettings(page)
  await clickNav(page, 'remote-hosts')
  await expect(page.locator('#remote-hosts')).toContainText('No remote hosts yet.')
  await expect(page.locator('#remote-hosts .settings-pane-header').getByTestId('remote-hosts-add')).toBeVisible()
  await page.locator('#remote-hosts .settings-pane-header').getByTestId('remote-hosts-add').click()
  await expect(page.locator('#rh-alias-0')).toBeVisible()
  await shot(page, 'remote-hosts')
  await expect(page.locator('#remote-hosts details.settings-collapsible, #remote-hosts .form-group')).toHaveCount(0)
})

test('Usage: three summary numbers in one group, or the empty sentence', async ({ page }) => {
  await openSettings(page)
  await clickNav(page, 'usage')
  const summary = page.getByTestId('usage-summary')
  const empty = page.locator('#usage', { hasText: 'No model calls recorded yet.' })
  await expect.poll(async () => (await summary.count()) + (await empty.count()), { timeout: 20_000 }).toBeGreaterThan(0)
  if (await summary.count()) {
    const values = summary.locator('.settings-addons-stat-value')
    await expect(values).toHaveCount(3)
    const style = await values.first().evaluate((el) => {
      const cs = getComputedStyle(el)
      return { size: cs.fontSize, weight: cs.fontWeight, nums: cs.fontVariantNumeric }
    })
    expect(style).toEqual({ size: '20px', weight: '600', nums: 'tabular-nums' })
  }
  // A diagnostic pane never says Saved.
  await expect(page.getByTestId('settings-saved-indicator')).toHaveCount(0)
  await shot(page, 'usage')
})

// ---------------------------------------------------------------------------
// Plugins fixture: neutral plugin names, every connection state, a base plugin
// with two providers, one plugin others run on, one quarantined, one needing setup.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown> & { id: string; status: string }
const builtin = { kind: 'builtin' }
const row = (id: string, name: string, extra: Partial<Row> = {}): Row => ({
  id, name, description: `${name} keeps things in step. A second sentence that stays out of the row.`,
  source: builtin, installed: true, status: 'active', builtin: true, configurable: false,
  catalog: false, toggleable: true, version: '1.2.0', ...extra,
})

function connection(pluginId: string, pluginName: string, state: string, extra: Record<string, unknown> = {}) {
  return { pluginId, pluginName, state, canSignIn: true, sync: null, ...extra }
}

async function mockPlugins(page: Page) {
  const hourAgo = new Date(Date.now() - 3_600_000).toISOString()
  const rows: Row[] = [
    row('north-sync', 'North Sync'),
    row('east-sync', 'East Sync'),
    row('south-sync', 'South Sync'),
    row('west-sync', 'West Sync'),
    row('center-sync', 'Center Sync'),
    row('acme-mail', 'Acme Mail'),
    row('acme-mail-imap', 'Acme IMAP'),
    row('acme-mail-cloud', 'Acme Cloud Mail'),
    row('core-lib', 'Core Library'),
    row('broken-tool', 'Broken Tool', { status: 'quarantined', toggleable: false, error: 'Crashed twice while loading. The log has the stack.' }),
    row('tracker-sync', 'Tracker Sync', { status: 'needs-config', toggleable: false, configurable: true, missingConfig: ['base_url', 'api_key'] }),
  ]
  const connections = [
    connection('north-sync', 'North Sync', 'connected', {
      account: 'person@example.com', credentialExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      sync: { lastOkAt: hourAgo, consecutiveFailures: 0 },
    }),
    connection('east-sync', 'East Sync', 'signing-in', {
      signIn: { userCode: 'WXYZ-2468', verificationUri: 'https://example.invalid/device', expiresAt: new Date(Date.now() + 600_000).toISOString(), startedAt: hourAgo },
    }),
    connection('south-sync', 'South Sync', 'sign-in-required', { detail: 'The refresh token was revoked.' }),
    connection('west-sync', 'West Sync', 'unreachable', { canSignIn: false }),
    connection('center-sync', 'Center Sync', 'not-configured', { canSignIn: false }),
    connection('acme-mail-cloud', 'Acme Cloud Mail', 'connected', { account: 'box@example.com', sync: { lastOkAt: hourAgo, consecutiveFailures: 0 } }),
  ]
  const calls: string[] = []
  await page.route('**/api/plugin-runtime/registry', (route) =>
    json(route, { rows, installedCount: rows.length, availableCount: 0 }))
  await page.route('**/api/plugin-sources', (route) => json(route, []))
  await page.route('**/api/integrations/connections', (route) => json(route, { connections }))
  await page.route('**/api/integrations/*/connection', (route) => {
    const id = new URL(route.request().url()).pathname.split('/')[3]
    return json(route, connections.find((c) => c.pluginId === id) ?? connection(id, id, 'not-configured'))
  })
  await page.route('**/api/integrations/settings', (route) => json(route, [{
    id: 'tracker-sync', name: 'Tracker Sync', status: 'needs-config', missing: ['base_url', 'api_key'],
    configSchema: { properties: { base_url: { type: 'string' }, api_key: { type: 'string' } }, required: ['base_url', 'api_key'] },
    uiHints: { base_url: { label: 'Base URL' }, api_key: { label: 'API key' } }, values: {},
  }]))
  await page.route('**/api/plugin-runtime/*/*', async (route) => {
    const [, , , id, verb] = new URL(route.request().url()).pathname.split('/')
    const body = route.request().postData() ?? ''
    calls.push(`${verb} ${id}${body.includes('cascade') ? ' cascade' : ''}`)
    const target = rows.find((r) => r.id === id)
    if (verb === 'disable' && id === 'core-lib' && !body.includes('cascade')) {
      return json(route, { error: 'has dependents', code: 'has-dependents', dependents: ['east-sync', 'north-sync'] }, 409)
    }
    if (target && verb === 'disable') target.status = 'disabled'
    if (target && (verb === 'reload' || verb === 'clear-quarantine')) target.status = 'active'
    return json(route, { ok: true })
  })
  return { rows, calls }
}

const accountRow = (page: Page, id: string) => page.getByTestId(`plugin-connection-${id}`).locator('.plugin-connection-row')

test('C65 C83: every account state has its tag, providers sit under their base, times are absolute', async ({ page }) => {
  await mockPlugins(page)
  await openSettings(page)
  await clickNav(page, 'plugin-store')
  await expect(page.getByTestId('plugin-row-north-sync')).toBeVisible({ timeout: 30_000 })

  const expected: Array<[string, string, string]> = [
    ['north-sync', 'connected', 'Signed in'],
    ['east-sync', 'signing-in', 'Signing in...'],
    ['south-sync', 'sign-in-required', 'Sign in needed'],
    ['west-sync', 'unreachable', "Can't reach the provider"],
    ['center-sync', 'not-configured', 'Not set up'],
  ]
  for (const [id, state, tag] of expected) {
    await expect(page.getByTestId(`plugin-connection-${id}`)).toHaveAttribute('data-connection-state', state)
    await expect(page.getByTestId(`plugin-connection-badge-${id}`)).toHaveText(tag)
  }
  await expect(accountRow(page, 'south-sync')).toContainText('Sign in again to keep syncing.')
  await expect(accountRow(page, 'south-sync').getByTestId('plugin-sign-in-south-sync')).toHaveText('Sign in')
  await expect(accountRow(page, 'west-sync')).toContainText("Can't reach the provider right now.")
  await expect(page.getByTestId('plugin-connection-retry-west-sync')).toHaveText('Retry')
  await expect(accountRow(page, 'center-sync')).toContainText('Add the missing settings under Configure.')

  // Signing in: the device code in mono with Copy, and Open sign-in page.
  const prompt = page.getByTestId('plugin-signin-prompt-east-sync')
  const code = page.getByTestId('plugin-signin-code-east-sync')
  await expect(code).toHaveText('WXYZ-2468')
  expect(await code.evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(/mono|Menlo|Courier|SF Mono|ui-monospace/i)
  await expect(prompt.getByRole('button', { name: 'Copy' })).toBeVisible()
  await expect(prompt.getByRole('link', { name: 'Open sign-in page' })).toHaveAttribute('href', 'https://example.invalid/device')
  await expect(accountRow(page, 'east-sync')).toContainText('Waiting for you to finish signing in.')

  // Connected: absolute time, never "ago" (C83).
  const northHelp = accountRow(page, 'north-sync').locator('.settings-row-help')
  await expect(northHelp).toHaveText(/^Renews automatically, last synced \d{1,2}:\d{2}\s?(AM|PM)$/)
  await expect(page.locator('#plugin-store')).not.toContainText(' ago')

  // The base plugin has no account row of its own: one provider row each.
  await expect(page.getByTestId('plugin-connection-acme-mail')).toHaveCount(0)
  // F16: no invented credential line on a provider without a connection report.
  await expect(page.getByTestId('plugin-provider-acme-mail-imap')).not.toContainText('system sign-in')
  await expect(page.getByTestId('plugin-provider-acme-mail-cloud')).toContainText('Signed in')

  // No ON tag anywhere: the switch says it. Help is the first sentence only.
  await expect(page.locator('#plugin-store .settings-tag', { hasText: /^(ON|On)$/ })).toHaveCount(0)
  await expect(page.getByTestId('plugin-row-north-sync').locator('.settings-row-help')).toHaveText('North Sync keeps things in step.')
  await expect(page.getByTestId('plugin-row-north-sync')).toHaveAttribute('title', 'Built in.')
  await page.getByTestId('plugin-row-north-sync').scrollIntoViewIfNeeded()
  await shot(page, 'plugins-accounts')
})

test('C65 C36: cascade asks before writing, quarantine offers Try again, Configure opens rows in place', async ({ page }) => {
  const { calls } = await mockPlugins(page)
  await openSettings(page)
  await clickNav(page, 'plugin-store')
  const coreSwitch = page.locator('#plugin-toggle-core-lib')
  await expect(coreSwitch).toHaveAttribute('aria-checked', 'true', { timeout: 30_000 })

  await coreSwitch.click()
  const ask = page.getByTestId('plugin-cascade-ask')
  await expect(ask).toContainText('Also turns off East Sync, North Sync.')
  await expect(coreSwitch).toHaveAttribute('aria-checked', 'true')
  await expect(coreSwitch).toHaveAttribute('aria-busy', 'true')
  expect(calls.filter((c) => c.includes('cascade'))).toEqual([])
  await page.getByTestId('plugin-cascade-cancel').click()
  await expect(ask).toHaveCount(0)
  expect(calls.filter((c) => c.includes('cascade'))).toEqual([])

  await coreSwitch.click()
  await expect(page.getByTestId('plugin-cascade-confirm')).toHaveText('Turn off all')
  await page.getByTestId('plugin-cascade-confirm').click()
  await expect.poll(() => calls).toContain('disable core-lib cascade')
  await expect(coreSwitch).toHaveAttribute('aria-checked', 'false', { timeout: 10_000 })

  // Quarantined: Failed tag, first sentence of the reason, Try again clears it.
  const broken = page.getByTestId('plugin-row-broken-tool')
  await expect(broken.locator('.settings-tag', { hasText: 'Failed' })).toBeVisible()
  await expect(broken.locator('.settings-row-help')).toHaveText('Crashed twice while loading.')
  await page.getByTestId('plugin-try-again-broken-tool').click()
  await expect.poll(() => calls).toContain('clear-quarantine broken-tool')

  // Needs setup: warning help with human field names, primary Configure, rows in the same group.
  const tracker = page.getByTestId('plugin-row-tracker-sync')
  await expect(tracker).toHaveAttribute('data-state', 'warning')
  await expect(tracker.locator('.settings-row-help')).toHaveText('Needs setup: base URL and API key.')
  const configure = page.getByTestId('plugin-configure-tracker-sync')
  await expect(configure).toHaveClass(/settings-button-primary/)
  await configure.click()
  const form = page.getByTestId('plugin-config-tracker-sync')
  await expect(form.locator('#plugin-tracker-sync-base_url')).toBeVisible()
  await expect(form.locator('.settings-row.settings-row-indent').first()).toBeVisible()
  expect(await form.evaluate((el) => !!el.closest('[data-testid="plugin-store-installed"]'))).toBe(true)
  await form.scrollIntoViewIfNeeded()
  await shot(page, 'plugins-configure')
  await expect(page.locator('#plugin-store .settings-group .settings-group')).toHaveCount(0)
  await form.locator('#plugin-tracker-sync-base_url').press('Escape')
  await expect(form).toHaveCount(0)
  await expect(page.locator('#plugin-store input[type="checkbox"]:visible')).toHaveCount(0)
})

// ---------------------------------------------------------------------------
// Copy and control audit over every pane this package owns.
// ---------------------------------------------------------------------------

const OWNED_PANES = [
  'plugin-store', 'calendar', 'permissions', 'backup', 'devices', 'remote-hosts',
  'audio-capture', 'usage', 'suggest-accuracy', 'timeline', 'bug-report',
]

interface PaneAudit { transformed: string[]; upper: string[]; glyphs: string[]; emoji: string[]; checkboxes: number; legacy: number }

/** Runs in the page: what C8, C10, C14, C19, C20 and C80 forbid, found in one pane. */
function auditPane(root: Element, provided: string[]): PaneAudit {
  const ABBR = new Set(['JSON', 'HTML', 'TOML', 'HEARTBEAT', 'CLAUDE'])
  // Em and en dash, middle dot, arrows, triangles, check and cross marks, times, ellipsis (as escapes).
  const GLYPHS = /[\u2014\u2013\u00b7\u2192\u203a\u25b8\u25be\u2713\u2717\u00d7\u2026\u2197]/
  const shown = (el: Element) => (el as HTMLElement).getClientRects().length > 0
  const exempt = (el: Element | null) => !!el?.closest('code, kbd, pre, .settings-plugin-body, [data-plugin-provided]')
    || /mono/i.test(getComputedStyle(el as Element).fontFamily)
  const out: PaneAudit = { transformed: [], upper: [], glyphs: [], emoji: [], checkboxes: 0, legacy: 0 }
  for (const el of Array.from(root.querySelectorAll('*'))) {
    const t = getComputedStyle(el).textTransform
    if (t !== 'none' && shown(el)) out.transformed.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]} ${t}`)
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const parent = n.parentElement
    // Plugin names and descriptions are the plugin's words, not settings copy.
    const text = provided.reduce((t, p) => t.split(p).join(''), n.textContent ?? '')
    if (!parent || !text.trim() || !shown(parent) || exempt(parent)) continue
    for (const word of text.match(/\b[A-Z]{4,}\b/g) ?? []) if (!ABBR.has(word)) out.upper.push(word)
    if (GLYPHS.test(text)) out.glyphs.push(text.trim().slice(0, 80))
    if (/\p{Extended_Pictographic}/u.test(text)) out.emoji.push(text.trim().slice(0, 80))
  }
  out.checkboxes = Array.from(root.querySelectorAll('input[type="checkbox"]'))
    .filter((el) => shown(el) && !el.closest('.settings-checklist')).length
  out.legacy = root.querySelectorAll('.form-group, details.settings-collapsible').length
  return out
}

test('C8 C10 C14 C19 C20 C80: owned panes are sentence case, glyph free, switches only', async ({ page }) => {
  test.setTimeout(120_000)
  await mockCalendar(page)
  const { rows } = await mockPlugins(page)
  const provided = rows.flatMap((r) => [String(r.name), String(r.description)])
  await openSettings(page)
  for (const id of OWNED_PANES) {
    await clickNav(page, id)
    // Every disclosure open, so the hidden rows are audited too.
    const closed = page.locator('.settings-pane button.settings-disclosure-row[aria-expanded="false"]')
    for (let i = 0; i < 20 && (await closed.count()) > 0; i += 1) await closed.first().click()
    await page.waitForTimeout(300)
    const audit = await page.locator('.settings-pane').evaluate(auditPane, provided)
    expect(audit, `pane ${id}`).toEqual({ transformed: [], upper: [], glyphs: [], emoji: [], checkboxes: 0, legacy: 0 })
  }
})
