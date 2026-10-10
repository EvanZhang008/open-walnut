/**
 * Settings → Search → Other servers: "Semantic search while this Mac is away"
 * (`search.companion_semantic`, each follower's copy of the search index: the
 * cloud companion, a server on a host).
 *
 * The group shows only once the Mac reaches a follower, with one row per
 * server saying what it is doing (ready, copying, held back by memory, forced
 * on with little memory) and polling while a copy fills. Auto/On/Off save at
 * once, except that On while a listed server is not known to have the memory
 * Auto asks for opens a warning naming it: Cancel leaves the setting alone,
 * Turn on saves it.
 *
 * GET /api/search-index/status is a page.route fixture (the `followers` part
 * is what a round on the Mac would report); the config writes are real, on the
 * fixture server. Navigation is by real clicks. Runs in both engines:
 * Chromium by default, WebKit (the Mac app is a WKWebView) with
 * `PW_WEBKIT=1 ... --project=webkit`.
 */
import { mkdirSync } from 'node:fs'
import { test, expect, type Page, type Route } from '@playwright/test'

test.setTimeout(120_000)

const SHOTS = '/tmp/companion-search'

type Follower = Record<string, unknown>

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })

/** The fixture server's real index status with these followers; returns a counter of the fetches. */
async function mockStatus(page: Page, followers: () => Follower[]): Promise<{ count: () => number }> {
  let n = 0
  await page.route((url) => url.pathname === '/api/search-index/status', async (route) => {
    n++
    const real = await route.fetch()
    const body = await real.json() as Record<string, unknown>
    return json(route, { ...body, followers: followers() })
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

const engine = (page: Page) => page.context().browser()?.browserType().name() ?? 'browser'

async function shot(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true })
  await page.getByTestId('companion-search-group').screenshot({ path: `${SHOTS}/${engine(page)}-${name}.png`, scale: 'css' })
}

const serverRow = (page: Page, id: string) => page.locator(`[data-testid="follower-search-row"][data-follower="${id}"]`)

const NOW = Date.now()
const COMPANION = { id: 'companion', kind: 'companion', label: 'Cloud companion', mode: 'auto', state: 'ready', reason: 'auto', totalMb: 7_900, needMb: 2_600, autoMinMb: 5_600, docs: 12_345, syncedAt: NOW, checkedAt: NOW }
const DEVBOX_MEMORY = { id: 'host:devbox', kind: 'host', label: 'devbox', mode: 'auto', state: 'memory', reason: 'memory', totalMb: 3_900, needMb: 2_600, autoMinMb: 5_600, syncedAt: null, checkedAt: NOW }

test.describe('Settings → Search: semantic search on the other servers', () => {
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

  test('no follower the Mac reaches, or none heard from yet: no group', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    let followers: Follower[] = [{ ...COMPANION, state: 'unavailable' }]
    await mockStatus(page, () => followers)
    const section = await openSearch(page)
    await expect(section.getByText('Excluded folders')).toBeVisible()
    await expect(page.getByTestId('companion-search-group')).toHaveCount(0)
    // Before the Mac's first round there is nothing to say either.
    followers = []
    await page.getByTestId('settings-nav-general').click()
    const again = await openSearchFromNav(page)
    await expect(again.getByText('Excluded folders')).toBeVisible()
    await expect(page.getByTestId('companion-search-group')).toHaveCount(0)
  })

  test('one server with the memory: Auto by default, On saves without a warning, Off and Auto save, twice', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await mockStatus(page, () => [COMPANION])
    await openSearch(page)
    const group = page.getByTestId('companion-search-group')
    await expect(group).toContainText('Other servers')
    await expect(page.getByTestId('companion-search-row')).toContainText('Semantic search while this Mac is away')
    await expect(page.getByTestId('companion-search-row')).toContainText('Auto turns it on for each server with 5.5 GB of memory.')
    await expect(serverRow(page, 'companion')).toContainText('Cloud companion')
    await expect(serverRow(page, 'companion')).toContainText('Ready: 12,345 items.')
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

  test('two servers, one short of memory: On warns naming it; Cancel keeps Auto, Turn on saves; then its row says it is forced', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    let followers: Follower[] = [COMPANION, DEVBOX_MEMORY]
    await mockStatus(page, () => followers)
    await openSearch(page)
    await expect(serverRow(page, 'companion')).toContainText('Ready: 12,345 items.')
    await expect(serverRow(page, 'host:devbox')).toContainText('devbox')
    await expect(serverRow(page, 'host:devbox')).toContainText('Off: Auto needs 5.5 GB of memory and it has 3.8 GB.')
    await shot(page, 'memory')

    await page.getByTestId('companion-search-on').click()
    const dialog = page.getByRole('dialog', { name: 'Turn on semantic search anyway?' })
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('devbox has 3.8 GB of memory. The search model takes about 2.5 GB on each server')
    await expect(dialog).not.toContainText('Cloud companion')
    await page.waitForTimeout(400) // the dialog's fade-in, so the shot is not half transparent
    mkdirSync(SHOTS, { recursive: true })
    await dialog.locator('.app-modal').screenshot({ path: `${SHOTS}/${engine(page)}-warning.png`, scale: 'css' })
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page.getByTestId('companion-search-auto')).toHaveAttribute('aria-checked', 'true')
    expect(await companionSetting(page)).toBeUndefined()

    await page.getByTestId('companion-search-on').click()
    await expect(dialog).toBeVisible()
    // The round after the save finds devbox forced on.
    followers = [{ ...COMPANION, mode: 'on', reason: 'on' }, { ...DEVBOX_MEMORY, mode: 'on', state: 'ready', reason: 'forced', docs: 12_345 }]
    await dialog.getByRole('button', { name: 'Turn on' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(page.getByTestId('companion-search-on')).toHaveAttribute('aria-checked', 'true')
    await expect.poll(() => companionSetting(page)).toBe('on')
    // The rows look again a few seconds after the save.
    await expect(serverRow(page, 'host:devbox')).toContainText('On with little memory: the model takes about 2.5 GB of its 3.8 GB.', { timeout: 15_000 })
    await expect(serverRow(page, 'host:devbox')).toHaveAttribute('data-state', 'warning')
    await expect(serverRow(page, 'companion')).not.toHaveAttribute('data-state', 'warning')
    await shot(page, 'forced')

    // Off needs no warning.
    await page.getByTestId('companion-search-off').click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect.poll(() => companionSetting(page)).toBe('off')
  })

  test('copying: a server\'s row counts down while the page polls', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    let pending = 4_200
    const devbox = { ...DEVBOX_MEMORY, state: 'ready', reason: 'auto', totalMb: 16_000, docs: 12_345 }
    const status = await mockStatus(page, () => [COMPANION, pending > 0 ? { ...devbox, state: 'syncing', pending } : devbox])
    await openSearch(page)
    const row = serverRow(page, 'host:devbox')
    await expect(row).toContainText('Copying this index: 4,200 items left.')
    await shot(page, 'syncing')
    const before = status.count()
    pending = 1_100
    await expect(row).toContainText('1,100 items left.', { timeout: 15_000 })
    pending = 0
    await expect(row).toContainText('Ready: 12,345 items.', { timeout: 15_000 })
    expect(status.count()).toBeGreaterThan(before)
  })

  test('a save that fails puts the choice back and says so', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await mockStatus(page, () => [COMPANION])
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
