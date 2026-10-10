/**
 * Settings → Search: "Semantic search while this Mac is away"
 * (`search.companion_semantic`, the companion's copy of the search index).
 *
 * The row shows only once the Mac has talked to a companion. Auto/On/Off save
 * at once, except that On on a companion without the memory Auto asks for
 * opens a warning first: Cancel leaves the setting alone, Turn on saves it.
 * The row says what the companion is doing (ready, copying, held back by
 * memory, forced on with little memory), and polls while the copy fills.
 *
 * GET /api/search-index/status is a page.route fixture (the companion part is
 * what a round on the Mac would report); the config writes are real, on the
 * fixture server. Navigation is by real clicks. Runs in both engines:
 * Chromium by default, WebKit (the Mac app is a WKWebView) with
 * `PW_WEBKIT=1 ... --project=webkit`.
 */
import { mkdirSync } from 'node:fs'
import { test, expect, type Page, type Route } from '@playwright/test'

test.setTimeout(120_000)

const SHOTS = '/tmp/companion-search'

type Companion = Record<string, unknown> | null

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })

/** The fixture server's real index status with this companion part; returns a counter of the fetches. */
async function mockStatus(page: Page, companion: () => Companion): Promise<{ count: () => number }> {
  let n = 0
  await page.route((url) => url.pathname === '/api/search-index/status', async (route) => {
    n++
    const real = await route.fetch()
    const body = await real.json() as Record<string, unknown>
    return json(route, { ...body, companion: companion() })
  })
  return { count: () => n }
}

async function readConfig(page: Page): Promise<Record<string, unknown>> {
  const res = await page.request.get('/api/config')
  expect(res.ok()).toBe(true)
  const body = await res.json() as { config?: Record<string, unknown> } & Record<string, unknown>
  return (body.config ?? body) as Record<string, unknown>
}

async function companionSetting(page: Page): Promise<unknown> {
  return ((await readConfig(page)).search as Record<string, unknown> | undefined)?.companion_semantic
}

async function writeSearch(page: Page, search: Record<string, unknown> | undefined) {
  const res = await page.request.put('/api/config', { data: { search: search ?? {} } })
  expect(res.ok()).toBe(true)
}

async function openSearch(page: Page) {
  await page.goto('/')
  await page.waitForLoadState('domcontentloaded')
  await page.getByRole('link', { name: /settings/i }).first().click()
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible({ timeout: 30_000 })
  return openSearchFromNav(page)
}

async function openSearchFromNav(page: Page) {
  const nav = page.getByTestId('settings-nav-search')
  await nav.click()
  await expect(nav).toHaveAttribute('aria-current', 'page')
  const section = page.locator('#search')
  await expect(section).toContainText('Embedding model', { timeout: 30_000 })
  await expect(section).not.toHaveAttribute('data-crashed', 'true')
  return section
}

async function shot(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true })
  const engine = page.context().browser()?.browserType().name() ?? 'browser'
  await page.getByTestId('companion-search-group').screenshot({ path: `${SHOTS}/${engine}-${name}.png`, scale: 'css' })
}

const READY = { mode: 'auto', state: 'ready', reason: 'auto', totalMb: 7_900, needMb: 2_600, autoMinMb: 5_600, docs: 12_345, syncedAt: Date.now(), checkedAt: Date.now() }
const MEMORY = { mode: 'auto', state: 'memory', reason: 'memory', totalMb: 3_900, needMb: 2_600, autoMinMb: 5_600, syncedAt: null, checkedAt: Date.now() }

test.describe('Settings → Search: the companion runs semantic search', () => {
  // One fixture server, one config: these tests write it, so they take turns.
  test.describe.configure({ mode: 'serial' })
  let saved: Record<string, unknown> | undefined

  test.beforeEach(async ({ page }) => {
    saved = (await readConfig(page)).search as Record<string, unknown> | undefined
    const { companion_semantic: _drop, ...rest } = saved ?? {}
    await writeSearch(page, rest)
  })

  test.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: 'ignoreErrors' })
    await writeSearch(page, saved)
  })

  test('no companion, or none heard from yet: no row', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    let companion: Companion = { mode: 'auto', state: 'no-companion', checkedAt: Date.now() }
    await mockStatus(page, () => companion)
    const section = await openSearch(page)
    await expect(section.getByText('Excluded folders')).toBeVisible()
    await expect(page.getByTestId('companion-search-group')).toHaveCount(0)
    // Before the Mac's first round there is nothing to say either.
    companion = null
    await page.getByTestId('settings-nav-general').click()
    const again = await openSearchFromNav(page)
    await expect(again.getByText('Excluded folders')).toBeVisible()
    await expect(page.getByTestId('companion-search-group')).toHaveCount(0)
  })

  test('ready with the memory: Auto by default, On saves without a warning, Off and Auto save, twice', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await mockStatus(page, () => READY)
    await openSearch(page)
    const row = page.getByTestId('companion-search-row')
    await expect(row).toContainText('Semantic search while this Mac is away')
    await expect(row).toContainText('Ready: the companion runs semantic search over 12,345 items while this Mac is away.')
    await expect(page.getByTestId('companion-search-auto')).toHaveAttribute('aria-checked', 'true')
    await shot(page, 'ready')

    for (let round = 0; round < 2; round++) {
      await page.getByTestId('companion-search-on').click()
      await expect(page.getByRole('dialog')).toHaveCount(0)
      await expect(page.getByTestId('companion-search-on')).toHaveAttribute('aria-checked', 'true')
      await expect.poll(() => companionSetting(page)).toBe('on')

      await page.getByTestId('companion-search-off').click()
      await expect(page.getByTestId('companion-search-off')).toHaveAttribute('aria-checked', 'true')
      await expect.poll(() => companionSetting(page)).toBe('off')

      await page.getByTestId('companion-search-auto').click()
      await expect(page.getByTestId('companion-search-auto')).toHaveAttribute('aria-checked', 'true')
      await expect.poll(() => companionSetting(page)).toBeUndefined()
    }
  })

  test('held back by memory: On warns; Cancel keeps Auto, Turn on saves it; then the row says it is forced', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    let companion: Companion = MEMORY
    await mockStatus(page, () => companion)
    await openSearch(page)
    const row = page.getByTestId('companion-search-row')
    await expect(row).toContainText('Off: Auto needs 5.5 GB of memory and the companion has 3.8 GB.')
    await shot(page, 'memory')

    await page.getByTestId('companion-search-on').click()
    const dialog = page.getByRole('dialog', { name: 'Turn on semantic search on the companion?' })
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('The companion has 3.8 GB of memory. The search model takes about 2.5 GB')
    mkdirSync(SHOTS, { recursive: true })
    const engine = page.context().browser()?.browserType().name() ?? 'browser'
    await dialog.locator('.app-modal').screenshot({ path: `${SHOTS}/${engine}-warning.png`, scale: 'css' })
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page.getByTestId('companion-search-auto')).toHaveAttribute('aria-checked', 'true')
    expect(await companionSetting(page)).toBeUndefined()

    await page.getByTestId('companion-search-on').click()
    await expect(dialog).toBeVisible()
    // The round after the save finds the copy forced on.
    companion = { ...READY, mode: 'on', reason: 'forced', totalMb: 3_900 }
    await dialog.getByRole('button', { name: 'Turn on' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page.getByTestId('companion-search-on')).toHaveAttribute('aria-checked', 'true')
    await expect.poll(() => companionSetting(page)).toBe('on')
    // The row looks again a few seconds after the save.
    await expect(row).toContainText('On with little memory: the model takes about 2.5 GB of the companion\'s 3.8 GB.', { timeout: 15_000 })
    await expect(row).toHaveAttribute('data-state', 'warning')
    await shot(page, 'forced')

    // Off needs no warning.
    await page.getByTestId('companion-search-off').click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect.poll(() => companionSetting(page)).toBe('off')
  })

  test('copying: the row counts down while it polls', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    let pending = 4_200
    const status = await mockStatus(page, () => (pending > 0
      ? { ...READY, state: 'syncing', pending }
      : READY))
    await openSearch(page)
    const row = page.getByTestId('companion-search-row')
    await expect(row).toContainText('Copying this index to the companion: 4,200 items left.')
    await shot(page, 'syncing')
    const before = status.count()
    pending = 1_100
    await expect(row).toContainText('1,100 items left.', { timeout: 15_000 })
    pending = 0
    await expect(row).toContainText('Ready: the companion runs semantic search over 12,345 items', { timeout: 15_000 })
    expect(status.count()).toBeGreaterThan(before)
  })

  test('a save that fails puts the choice back and says so', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await mockStatus(page, () => READY)
    await openSearch(page)
    await page.route((url) => url.pathname === '/api/config', (route) => (
      route.request().method() === 'PUT' ? json(route, { error: 'disk full' }, 500) : route.fallback()
    ))
    await page.getByTestId('companion-search-off').click()
    const row = page.getByTestId('companion-search-row')
    await expect(page.getByTestId('companion-search-auto')).toHaveAttribute('aria-checked', 'true', { timeout: 15_000 })
    await expect(row).toHaveAttribute('data-state', 'error')
    await expect(page.getByTestId('companion-search-group').locator('.settings-row-error')).toBeVisible()
    await shot(page, 'save-failed')
    await page.unroute((url) => url.pathname === '/api/config')
    expect(await companionSetting(page)).toBeUndefined()
  })
})
