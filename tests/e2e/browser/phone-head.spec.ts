/**
 * The page head and the Home Screen files (spec 5.2, 5.3; checklist C17, C43
 * to C47, C50): what a phone sees before the bundle runs, and what Add to Home
 * Screen reads.
 *
 * The bundle is held back with page.route (the Vite entry on the fixture, the
 * hashed entry on a built server) so the first frame can be inspected: the page
 * colour, the theme-color metas, the static splash. Screenshots:
 * /tmp/mobile-web/head-*.png.
 */
import fs from 'node:fs/promises'
import { devices, expect, request, test, type Page } from '@playwright/test'

const SHOTS = '/tmp/mobile-web'
const PHONE = devices['iPhone 15']

test.setTimeout(120_000)
test.beforeAll(async () => { await fs.mkdir(SHOTS, { recursive: true }) })

test.use({
  viewport: PHONE.viewport,
  screen: PHONE.screen,
  deviceScaleFactor: PHONE.deviceScaleFactor,
  isMobile: true,
  hasTouch: true,
  userAgent: PHONE.userAgent,
})

/**
 * Evidence only. While the entry module is held the page is still loading, and
 * WebKit may not hand over a frame then: a missing shot never fails a check.
 */
async function shot(page: Page, name: string) {
  const engine = page.context().browser()?.browserType().name() ?? 'browser'
  await page.screenshot({ path: `${SHOTS}/head-${engine}-${name}.png`, timeout: 8_000 })
    .catch((err: Error) => { test.info().annotations.push({ type: 'no-screenshot', description: `${name}: ${err.message.split('\n')[0]}` }) })
}

/**
 * A held module also holds the document's load, and neither engine hands over
 * a screenshot then. So the evidence picture is the same HTML with its module
 * scripts taken out, in a second tab of the same context (same theme, same
 * colour scheme): exactly what shows before the bundle runs.
 */
async function firstFrameShot(page: Page, name: string, scheme: 'light' | 'dark') {
  const html = await (await page.request.get('/')).text()
  const bare = html.replace(/<script type="module"[^>]*>[\s\S]*?<\/script>/g, '')
  const tab = await page.context().newPage()
  await tab.emulateMedia({ colorScheme: scheme })
  await tab.route((url) => url.pathname === '/', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: bare }))
  await tab.goto('/')
  await expect(tab.getByTestId('boot-splash').locator('img')).toBeVisible()
  await tab.waitForFunction(() => (document.querySelector('[data-testid="boot-splash"] img') as HTMLImageElement | null)?.complete === true)
  await shot(tab, name)
  await tab.close()
}

/** Hold the entry module until `release()` (Vite dev entry or a built index chunk). */
async function holdBundle(page: Page) {
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  await page.route((url) => url.pathname.endsWith('/src/main.tsx') || /^\/assets\/index-[\w-]+\.js$/.test(url.pathname), async (route) => {
    await gate
    await route.continue().catch(() => {})
  })
  return release
}

async function refuseProbe(page: Page) {
  await page.route((url) => url.pathname === '/api/v1/me', (route) => {
    if (route.request().headers()['authorization']) return route.continue()
    return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'not paired', code: 'not_paired' }) })
  })
}

async function themeMetas(page: Page) {
  return page.evaluate(() => [...document.querySelectorAll('meta[name="theme-color"]')]
    .map((m) => ({ content: m.getAttribute('content')?.toUpperCase(), media: m.getAttribute('media') })))
}

/**
 * Open `/` while the entry module is held: a module script is deferred, so
 * DOMContentLoaded waits for it. Wait for the parsed splash instead.
 */
async function gotoHeld(page: Page) {
  await page.goto('/', { waitUntil: 'commit' })
  await page.waitForSelector('[data-testid="boot-splash"]', { state: 'attached', timeout: 30_000 })
}

const htmlBg = (page: Page) => page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor)

test('C17 C47: viewport covers the notch, pinch zoom stays, and the Home Screen tags are there', async ({ page }) => {
  const res = await page.request.get('/')
  expect(res.status()).toBe(200)
  const html = await res.text()
  const viewport = /<meta name="viewport" content="([^"]+)"/.exec(html)?.[1] ?? ''
  expect(viewport).toContain('width=device-width')
  expect(viewport).toContain('initial-scale=1')
  expect(viewport).toContain('viewport-fit=cover')
  expect(viewport).not.toMatch(/maximum-scale|user-scalable/)
  expect(html).toContain('<meta name="apple-mobile-web-app-capable" content="yes"')
  expect(html).toContain('<meta name="mobile-web-app-capable" content="yes"')
  expect(html).toContain('<meta name="apple-mobile-web-app-title" content="Walnut"')
  expect(html).toContain('<meta name="apple-mobile-web-app-status-bar-style" content="default"')
  expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest"')
  expect(html).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png"')
  expect(html).toContain('<meta name="color-scheme" content="light dark"')
})

test('C46: the manifest and icons answer without a sign-in', async ({ baseURL }) => {
  const bare = await request.newContext({ baseURL })
  for (const path of ['/manifest.webmanifest', '/apple-touch-icon.png', '/icon-192.png', '/icon-512.png']) {
    const res = await bare.get(path, { headers: { authorization: '' } })
    expect(res.status(), path).toBe(200)
  }
  const manifest = await bare.get('/manifest.webmanifest')
  expect(manifest.headers()['content-type']).toMatch(/application\/(manifest\+)?json/)
  const body = JSON.parse(await manifest.text()) as { display: string; start_url: string; scope: string; name: string; icons: Array<{ src: string; sizes: string }> }
  expect(body).toMatchObject({ name: 'Walnut', short_name: 'Walnut', display: 'standalone', start_url: '/', scope: '/' })
  expect(body.icons.map((i) => i.sizes).sort()).toEqual(['192x192', '512x512'])
  // PNG IHDR: width and height are the big-endian words at bytes 16 and 20.
  const size = async (path: string) => {
    const buf = await (await bare.get(path)).body()
    return [buf.readUInt32BE(16), buf.readUInt32BE(20)]
  }
  expect(await size('/apple-touch-icon.png')).toEqual([180, 180])
  expect(await size('/icon-192.png')).toEqual([192, 192])
  expect(await size('/icon-512.png')).toEqual([512, 512])
  for (const icon of body.icons) expect((await bare.get(icon.src)).status()).toBe(200)
  await bare.dispose()
})

test('C43 C45: a dark phone, not signed in, sees black and the icon before the bundle runs', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await refuseProbe(page)
  const release = await holdBundle(page)
  await gotoHeld(page)
  const metas = await themeMetas(page)
  expect(metas).toEqual([
    { content: '#FFFFFF', media: '(prefers-color-scheme: light)' },
    { content: '#000000', media: '(prefers-color-scheme: dark)' },
  ])
  await page.waitForTimeout(3_000)
  expect(await htmlBg(page)).toBe('rgb(0, 0, 0)')
  const splash = page.getByTestId('boot-splash')
  await expect(splash).toBeVisible()
  await expect(splash).toHaveAttribute('aria-hidden', 'true')
  expect(await page.locator('#root').innerText()).toBe('')
  expect(await splash.locator('img').count()).toBe(1)
  const img = (await splash.locator('img').boundingBox())!
  expect(img.width).toBe(64)
  expect(Math.abs(img.x + 32 - PHONE.viewport.width / 2)).toBeLessThanOrEqual(1)
  release()
  await firstFrameShot(page, 'splash-dark', 'dark')
  await expect(page.getByTestId('unpaired-notice')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('boot-splash')).toHaveCount(0)
  expect(await htmlBg(page)).toBe('rgb(0, 0, 0)')
})

test('C43: a light phone sees white before the bundle runs', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await refuseProbe(page)
  const release = await holdBundle(page)
  await gotoHeld(page)
  expect(await htmlBg(page)).toBe('rgb(255, 255, 255)')
  await expect(page.getByTestId('boot-splash')).toBeVisible()
  release()
  await firstFrameShot(page, 'splash-light', 'light')
  await expect(page.getByTestId('unpaired-notice')).toBeVisible({ timeout: 30_000 })
})

test('C44: an explicit dark theme on a light system: one theme-color, and Settings switches it', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await page.addInitScript(() => {
    if (sessionStorage.getItem('head-seeded')) return
    sessionStorage.setItem('head-seeded', '1')
    localStorage.setItem('open-walnut-theme', 'dark')
  })
  const release = await holdBundle(page)
  await gotoHeld(page)
  expect(await htmlBg(page)).toBe('rgb(0, 0, 0)')
  expect(await themeMetas(page)).toEqual([{ content: '#000000', media: null }])
  release()
  await firstFrameShot(page, 'explicit-dark-first-frame', 'light')

  // Signed in (the fixture trusts this machine): switch the theme in Settings.
  await openSettingsOnPhone(page)
  await page.getByTestId('settings-theme-light').click()
  await expect.poll(() => themeMetas(page)).toEqual([{ content: '#FFFFFF', media: null }])
  await expect.poll(() => htmlBg(page)).toBe('rgb(255, 255, 255)')
  await page.getByTestId('settings-theme-system').click()
  await expect.poll(() => themeMetas(page)).toEqual([
    { content: '#FFFFFF', media: '(prefers-color-scheme: light)' },
    { content: '#000000', media: '(prefers-color-scheme: dark)' },
  ])
  await page.getByTestId('settings-theme-dark').click()
  await expect.poll(() => themeMetas(page)).toEqual([{ content: '#000000', media: null }])
  await page.evaluate(() => localStorage.setItem('open-walnut-theme', 'system'))
})

test('C50: built assets cache for a year, the page itself revalidates', async ({ page }) => {
  const res = await page.request.get('/')
  const html = await res.text()
  const asset = /\/assets\/index-[\w-]+\.js/.exec(html)?.[0]
  test.skip(!asset, 'the fixture serves the SPA through Vite dev: no hashed assets to check (see notes)')
  const indexCache = res.headers()['cache-control'] ?? ''
  expect(indexCache).toMatch(/no-cache|no-store|max-age=0/)
  const js = await page.request.get(asset!)
  expect(js.headers()['cache-control'] ?? '').toMatch(/max-age=(\d{7,})|immutable/)
})

/** Drawer > Settings > General, by taps, on the phone layout. */
async function openSettingsOnPhone(page: Page) {
  await page.getByRole('button', { name: 'Menu', exact: true }).click({ timeout: 30_000 })
  await page.locator('#primary-sidebar').getByRole('link', { name: /settings/i }).first().click()
  const general = page.getByTestId('settings-nav-general')
  await general.click({ timeout: 30_000 })
  await expect(page.getByTestId('settings-theme-light')).toBeVisible({ timeout: 30_000 })
}

for (const scheme of ['light', 'dark'] as const) {
  test(`N2-37: a ${scheme} phone links the manifest whose launch colour is ${scheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme })
    await refuseProbe(page)
    await page.goto('/')
    const href = await page.locator('link[rel="manifest"]').getAttribute('href')
    expect(href).toBe(scheme === 'dark' ? '/manifest-dark.webmanifest' : '/manifest.webmanifest')
    const body = await (await page.request.get(href!)).json() as { background_color: string; theme_color: string }
    expect(body.background_color).toBe(scheme === 'dark' ? '#000000' : '#FFFFFF')
  })
}
