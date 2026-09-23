/**
 * /settings in pane mode: one nav entry = one pane, only that pane's sections
 * mount, the hash picks the pane, Find a setting filters the nav.
 *
 * Runs in both engines against one fixture: Chromium by default, WebKit (the
 * Mac app is a WKWebView) with `PW_WEBKIT=1 ... --project=webkit`. Every pane
 * switch is a real nav click; page.goto carries a hash only in deep-link tests.
 * Writes are intercepted with page.route, so nothing here changes the fixture
 * config other specs read.
 */
import { test, expect, type Page } from '@playwright/test'

if (process.env.PW_WEBKIT) test.use({ browserName: 'webkit' })
test.setTimeout(90_000)

const NAV = (id: string) => `settings-nav-${id}`

async function openSettings(page: Page, hash = '') {
  await page.goto(`/settings${hash}`)
  await expect(page.locator('.settings-nav')).toBeVisible({ timeout: 30_000 })
}

async function clickNav(page: Page, id: string) {
  const item = page.getByTestId(NAV(id))
  await item.click()
  await expect(item).toHaveAttribute('aria-current', 'page')
  await expect(page.locator(`.settings-pane [id="${id}"].settings-section`)).toBeVisible({ timeout: 20_000 })
}

async function mountedSections(page: Page): Promise<string[]> {
  return page.$$eval('.settings-section', (els) => els.map((e) => e.id))
}

async function paneTopOf(page: Page, id: string): Promise<number> {
  return page.evaluate((target) => {
    const el = document.getElementById(target)
    const pane = document.querySelector('.settings-pane')
    if (!el || !pane) return Number.NaN
    return el.getBoundingClientRect().top - pane.getBoundingClientRect().top
  }, id)
}

test('runs in the engine it was asked for', async ({ browserName }) => {
  expect(browserName).toBe(process.env.PW_WEBKIT ? 'webkit' : 'chromium')
})

test('C1: /settings opens General alone', async ({ page }) => {
  await openSettings(page)
  await expect(page.locator('#general.settings-section')).toBeVisible({ timeout: 20_000 })
  expect(await mountedSections(page)).toEqual(['general'])
  const nav = page.getByTestId(NAV('general'))
  await expect(nav).toHaveAttribute('aria-current', 'page')
  await expect(nav).toHaveClass(/settings-nav-active/)
  await expect(page.locator('.settings-nav-active')).toHaveCount(1)
})

test('C2: each nav entry mounts only its own pane', async ({ page }) => {
  await openSettings(page)
  await expect(page.locator('#general.settings-section')).toBeVisible({ timeout: 20_000 })
  const folded: Record<string, string[]> = {
    tasks: ['tasks', 'focus-tiers'],
    devices: ['devices', 'cloud'],
    advanced: ['advanced', 'providers'],
  }
  const panes = await page.$$eval('.settings-nav button.settings-nav-item[data-testid^="settings-nav-"]',
    (els) => els.map((e) => e.getAttribute('data-testid')!.slice('settings-nav-'.length)))
  expect(panes).toEqual(expect.arrayContaining(['hooks', 'plugin-store', 'general', 'tasks', 'devices', 'advanced', 'bug-report']))
  for (const id of panes.filter((p) => !p.includes(':'))) {
    await clickNav(page, id)
    await expect.poll(() => mountedSections(page)).toEqual(folded[id] ?? [id])
  }
})

test('C3: a cold deep link to #providers opens Advanced with the API provider in view', async ({ page }) => {
  await openSettings(page, '#providers')
  await expect(page.getByTestId(NAV('advanced'))).toHaveAttribute('aria-current', 'page')
  await expect(page.locator('#providers')).toBeVisible({ timeout: 20_000 })
  await page.waitForTimeout(2500)
  // Under the 44px compact header, so within 40px of the top or of the bar.
  const top = await paneTopOf(page, 'providers')
  expect(top).toBeGreaterThanOrEqual(0)
  expect(top).toBeLessThanOrEqual(44 + 40)
})

test('C4: a same-page #link and a router navigation both switch panes without a reload', async ({ page }) => {
  await openSettings(page)
  await expect(page.locator('#general.settings-section')).toBeVisible({ timeout: 20_000 })
  await page.evaluate(() => { (window as unknown as { __paneMarker: string }).__paneMarker = 'kept' })
  // A section-style in-pane link, the shape sections use (`<a href="#providers">`).
  await page.evaluate(() => {
    const a = document.createElement('a')
    a.href = '#providers'
    a.textContent = 'Fixture link to providers'
    a.id = 'fixture-hash-link'
    document.querySelector('.settings-pane-inner')!.prepend(a)
  })
  await page.locator('#fixture-hash-link').click()
  await expect(page.getByTestId(NAV('advanced'))).toHaveAttribute('aria-current', 'page')
  await expect(page.locator('#providers')).toBeVisible({ timeout: 20_000 })
  await expect(page).toHaveURL(/\/settings#providers$/)
  // A router navigation (what navigate('/settings#engines') does): push + popstate.
  await page.evaluate(() => {
    window.history.pushState({}, '', '/settings#engines')
    window.dispatchEvent(new PopStateEvent('popstate', { state: {} }))
  })
  await expect(page.getByTestId(NAV('engines'))).toHaveAttribute('aria-current', 'page')
  await expect(page.locator('#engines.settings-section')).toBeVisible({ timeout: 20_000 })
  expect(await page.evaluate(() => (window as unknown as { __paneMarker?: string }).__paneMarker)).toBe('kept')
})

test('C5: an unknown hash opens General and logs it', async ({ page }) => {
  const warnings: string[] = []
  page.on('console', (m) => { if (m.type() === 'warning') warnings.push(m.text()) })
  await openSettings(page, '#does-not-exist')
  await expect(page.locator('#general.settings-section')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId(NAV('general'))).toHaveAttribute('aria-current', 'page')
  await expect(page.getByTestId('settings-section-crash')).toHaveCount(0)
  await expect.poll(() => warnings.some((w) => w.includes('unknown settings hash')), { timeout: 15_000 }).toBe(true)
})

// Endpoints only other panes read (from the sections' own fetch calls).
const OTHER_PANE_ENDPOINTS = [
  /^\/api\/hooks(\/|$)/,
  /^\/api\/usage\//,
  /^\/api\/calendar\/sources/,
  /^\/api\/plugin-sources/,
  /^\/api\/devices/,
  /^\/api\/timeline/,
  /^\/api\/engines\/[^/]+\/settings/,
]

test('C6: opening General requests nothing that only another pane needs', async ({ page }) => {
  const seen: string[] = []
  page.on('request', (r) => seen.push(new URL(r.url()).pathname))
  await openSettings(page)
  await expect(page.locator('#general.settings-section')).toBeVisible({ timeout: 20_000 })
  await page.waitForTimeout(2000)
  const offending = seen.filter((p) => OTHER_PANE_ENDPOINTS.some((re) => re.test(p)))
  expect(offending).toEqual([])
  // Control: the same watcher does see a pane's own reads once it opens.
  await clickNav(page, 'hooks')
  await expect.poll(() => seen.some((p) => /\/api\/hooks/.test(p)), { timeout: 15_000 }).toBe(true)
})

const visibleNavKeys = (page: Page) => page.$$eval('.settings-nav-list .settings-nav-item[data-testid]',
  (els) => els.filter((e) => (e as HTMLElement).offsetParent !== null).map((e) => e.getAttribute('data-testid')!))

test('C17: filtering "idle" leaves Sessions with a Matches hint; Enter opens it and focuses its title', async ({ page }) => {
  await openSettings(page)
  const filter = page.getByTestId('settings-filter')
  await filter.fill('idle')
  await expect.poll(() => visibleNavKeys(page)).toEqual([NAV('sessions')])
  await expect(page.getByTestId(NAV('sessions')).locator('.settings-nav-hint')).toHaveText(/^Matches "idle/i)
  // Groups with no hit lose their heading too.
  await expect(page.locator('.settings-nav-group-label', { hasText: 'Manage' })).toHaveCount(0)
  await expect(page.locator('.settings-nav-group-label', { hasText: 'Configure' })).toHaveCount(1)
  await filter.press('ArrowDown')
  await expect(filter).toHaveAttribute('aria-activedescendant', /sessions/)
  await filter.press('Enter')
  await expect(page.getByTestId(NAV('sessions'))).toHaveAttribute('aria-current', 'page')
  await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe('sessions-title')
  await expect(page).toHaveURL(/#sessions$/)
})

test('C22: "/" focuses Find a setting from the page, but types inside an input', async ({ page }) => {
  await openSettings(page)
  await expect(page.locator('#general.settings-section')).toBeVisible({ timeout: 20_000 })
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.press('/')
  await expect(page.getByTestId('settings-filter')).toBeFocused()
  await expect(page.getByTestId('settings-filter')).toHaveValue('')
  // Inside a text field the key is just a character.
  await page.evaluate(() => {
    const input = document.createElement('input')
    input.id = 'fixture-text-input'
    document.querySelector('.settings-pane-inner')!.prepend(input)
  })
  await page.locator('#fixture-text-input').click()
  await page.keyboard.press('/')
  await expect(page.locator('#fixture-text-input')).toHaveValue('/')
  await expect(page.locator('#fixture-text-input')).toBeFocused()
})

test('C23: no match shows the empty line and Clear search; Esc clears then blurs', async ({ page }) => {
  await openSettings(page)
  const filter = page.getByTestId('settings-filter')
  const before = (await visibleNavKeys(page)).length
  await filter.fill('zzzq')
  await expect(page.getByTestId('settings-filter-empty')).toContainText('No settings match "zzzq".')
  await expect.poll(() => visibleNavKeys(page)).toEqual([])
  await page.getByRole('button', { name: 'Clear search' }).click()
  await expect(filter).toHaveValue('')
  await expect.poll(async () => (await visibleNavKeys(page)).length).toBe(before)
  await filter.fill('tasks')
  await filter.press('Escape')
  await expect(filter).toHaveValue('')
  await expect(filter).toBeFocused()
  await filter.press('Escape')
  await expect(filter).not.toBeFocused()
})

test('C73: model, all clear, cloud companion, focus tiers, use an api, agent', async ({ page }) => {
  await openSettings(page)
  const filter = page.getByTestId('settings-filter')
  await filter.fill('model')
  await expect.poll(() => visibleNavKeys(page)).toEqual(expect.arrayContaining([NAV('engines'), NAV('advanced'), NAV('tasks')]))
  await filter.fill('all clear')
  await expect(page.getByTestId(NAV('general')).locator('.settings-nav-hint')).toHaveText('Matches "Heartbeat all clear"')
  await filter.fill('cloud companion')
  await expect.poll(() => visibleNavKeys(page)).toContain(NAV('devices'))
  await filter.fill('focus tiers')
  await expect.poll(() => visibleNavKeys(page)).toContain(NAV('tasks'))
  await filter.fill('use an api')
  await expect.poll(() => visibleNavKeys(page)).toContain(NAV('advanced'))
  await filter.fill('agent')
  await expect(page.getByTestId(NAV('agents'))).toBeVisible()
  await filter.press('Enter')
  await expect(page).toHaveURL(/\/settings#engines$/)
  await expect(page.getByTestId(NAV('engines'))).toHaveAttribute('aria-current', 'page')
  await expect(page.getByTestId(NAV('agents'))).toBeVisible()
})

test('C52: "your name" + Enter scrolls to the name row and flashes it', async ({ page }) => {
  await openSettings(page)
  await clickNav(page, 'sessions')
  const filter = page.getByTestId('settings-filter')
  await filter.fill('your name')
  await filter.press('Enter')
  await expect(page.getByTestId(NAV('general'))).toHaveAttribute('aria-current', 'page')
  await expect(page.locator('#settings-name')).toBeVisible({ timeout: 20_000 })
  const flashed = page.locator('.settings-anchor-flash')
  await expect(flashed).toHaveCount(1, { timeout: 5_000 })
  expect(await flashed.evaluate((el) => el.contains(document.getElementById('settings-name')) || el.id === 'settings-name')).toBe(true)
  await expect(flashed).toHaveCount(0, { timeout: 3_000 })
})

const hexToRgb = (hex: string) => {
  const n = parseInt(hex.slice(1), 16)
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`
}

test('C24: off-page links carry the arrow and title, and navigate in the SPA', async ({ page }) => {
  await openSettings(page)
  for (const [id, label] of [['agents', 'Agents'], ['skills', 'Skills'], ['commands', 'Commands'], ['memory', 'Memory']]) {
    const link = page.getByTestId(NAV(id))
    await expect(link).toHaveAttribute('title', `Opens the ${label} page`)
    await expect(link.locator('svg[data-glyph="arrow-up-right"]')).toHaveCount(1)
  }
  await page.evaluate(() => { (window as unknown as { __paneMarker: string }).__paneMarker = 'kept' })
  await page.getByTestId(NAV('skills')).click()
  await expect(page).toHaveURL(/\/skills/)
  expect(await page.evaluate(() => (window as unknown as { __paneMarker?: string }).__paneMarker)).toBe('kept')
})

test('C25: every nav tile is a 20px tinted square; the active entry is accent with white text', async ({ page }) => {
  await openSettings(page)
  await expect(page.locator('#general.settings-section')).toBeVisible({ timeout: 20_000 })
  const tiles = await page.$$eval('.settings-nav-list .settings-nav-item[data-testid] .settings-pane-tile', (els) => els.map((el) => {
    const cs = getComputedStyle(el)
    const r = el.getBoundingClientRect()
    return { w: r.width, h: r.height, radius: cs.borderTopLeftRadius, bg: cs.backgroundColor, svg: !!el.querySelector('svg') || !!el.textContent }
  }))
  expect(tiles.length).toBeGreaterThan(20)
  for (const t of tiles) {
    expect(t.w).toBeCloseTo(20, 0)
    expect(t.h).toBeCloseTo(20, 0)
    expect(t.radius).toBe('5px')
    expect(t.bg).not.toBe('rgba(0, 0, 0, 0)')
    expect(t.svg).toBe(true)
  }
  expect(await page.getByTestId(NAV('general')).locator('.settings-pane-tile').evaluate((el) => getComputedStyle(el).backgroundColor))
    .toBe(hexToRgb('#8E8E93'))
  // The active entry is the settings selection blue (a deeper accent, so white
  // 13px text passes 4.5:1: C50) with white text.
  const active = await page.getByTestId(NAV('general')).evaluate((el) => {
    const probe = document.createElement('span')
    probe.style.color = 'var(--settings-nav-selected-bg)'
    el.closest('.settings-container')!.append(probe)
    const selected = getComputedStyle(probe).color
    probe.remove()
    return { bg: getComputedStyle(el).backgroundColor, color: getComputedStyle(el.querySelector('.settings-nav-label')!).color, selected }
  })
  expect(active.bg).toBe(active.selected)
  expect(active.bg).toBe('rgb(0, 100, 210)')
  expect(active.color).toBe('rgb(255, 255, 255)')
})

test('C47: nav clicks replace history, so one Back leaves Settings', async ({ page }) => {
  await page.goto('/skills')
  await expect(page).toHaveURL(/\/skills/)
  await page.evaluate(() => {
    window.history.pushState({}, '', '/settings')
    window.dispatchEvent(new PopStateEvent('popstate', { state: {} }))
  })
  await expect(page.locator('.settings-nav')).toBeVisible({ timeout: 30_000 })
  await clickNav(page, 'general')
  await clickNav(page, 'sessions')
  await clickNav(page, 'engines')
  await page.goBack()
  await expect(page).toHaveURL(/\/skills/)
})

test('C48: the document title names the pane', async ({ page }) => {
  await openSettings(page)
  await expect.poll(() => page.title()).toBe('Settings: General')
  await clickNav(page, 'stt')
  await expect.poll(() => page.title()).toBe('Settings: Voice')
  await clickNav(page, 'devices')
  await expect.poll(() => page.title()).toBe('Settings: Phones & Cloud')
})

test('C82: a same-page #link keeps history flat: Back returns to the page before Settings', async ({ page }) => {
  await page.goto('/skills')
  await page.evaluate(() => {
    window.history.pushState({}, '', '/settings')
    window.dispatchEvent(new PopStateEvent('popstate', { state: {} }))
  })
  await expect(page.locator('#general.settings-section')).toBeVisible({ timeout: 30_000 })
  await page.evaluate(() => {
    const a = document.createElement('a')
    a.href = '#providers'
    a.id = 'fixture-hash-link'
    a.textContent = 'Fixture link'
    document.querySelector('.settings-pane-inner')!.prepend(a)
  })
  await page.locator('#fixture-hash-link').click()
  await expect(page.getByTestId(NAV('advanced'))).toHaveAttribute('aria-current', 'page')
  await page.goBack()
  await expect(page).toHaveURL(/\/skills/)
})

type TestHooks = {
  pluginUiRegistry: { registerSettings: (id: string, name: string, v: { id: string; label: string; component: unknown }) => { dispose(): void } }
  appRegistry: { registerPlugin: (id: string, name: string, v: Record<string, unknown>) => { dispose(): void } }
}
type HookWindow = Window & { __walnutSettingsTestHooks?: TestHooks; __fixtureDisposers?: Record<string, { dispose(): void }>; __walnutSettingsCrash?: string }

/** Register a fake plugin settings panel through the dev-only hook SettingsPage exposes. */
async function registerPanel(page: Page, pluginId: string, pluginName: string, label: string, mode: 'ok' | 'throw' = 'ok') {
  await page.waitForFunction(() => !!(window as HookWindow).__walnutSettingsTestHooks)
  await page.evaluate(({ pluginId, pluginName, label, mode }) => {
    const w = window as HookWindow
    const component = mode === 'throw' ? () => { throw new Error('fixture panel crash') } : () => `${label} body`
    const handle = w.__walnutSettingsTestHooks!.pluginUiRegistry.registerSettings(pluginId, pluginName, { id: 'panel', label, component })
    w.__fixtureDisposers = { ...(w.__fixtureDisposers ?? {}), [pluginId]: handle }
  }, { pluginId, pluginName, label, mode })
}

test('C37: a plugin panel gets a pane header; a crashing panel stays inside its boundary', async ({ page }) => {
  await openSettings(page)
  await registerPanel(page, 'fixture-alpha', 'Fixture Alpha', 'Alpha Panel')
  await clickNav(page, 'fixture-alpha:panel')
  await expect(page.locator('.settings-pane-title')).toHaveText('Alpha Panel')
  await expect(page.locator('.settings-pane-desc')).toHaveText('Provided by the Fixture Alpha plugin.')
  await expect(page.locator('.settings-plugin-body')).toContainText('Alpha Panel body')
  await registerPanel(page, 'fixture-beta', 'Fixture Beta', 'Beta Panel', 'throw')
  await page.getByTestId(NAV('fixture-beta:panel')).click()
  await expect(page.locator('.settings-pane-title')).toHaveText('Beta Panel')
  await expect(page.locator('.settings-plugin-body')).not.toContainText('Beta Panel body')
  await expect(page.locator('.settings-nav')).toBeVisible()
  await clickNav(page, 'general')
  expect(await mountedSections(page)).toEqual(['general'])
})

test('C82: a plugin panel that goes away says so, with a way back to Plugins', async ({ page }) => {
  await openSettings(page)
  await registerPanel(page, 'fixture-gamma', 'Fixture Gamma', 'Gamma Panel')
  await clickNav(page, 'fixture-gamma:panel')
  await page.evaluate(() => (window as HookWindow).__fixtureDisposers!['fixture-gamma'].dispose())
  const off = page.getByTestId('settings-plugin-off')
  await expect(off).toContainText('This panel went away because Fixture Gamma is off.')
  await expect(page).toHaveURL(/#fixture-gamma:panel$/)
  await off.getByRole('button', { name: 'Open Plugins' }).click()
  await expect(page.getByTestId(NAV('plugin-store'))).toHaveAttribute('aria-current', 'page')
})

test('C38: a crashing core section shows its own shell and Try again', async ({ page }) => {
  const warnings: string[] = []
  page.on('console', (m) => { if (m.type() === 'warning') warnings.push(m.text()) })
  await openSettings(page)
  await expect(page.locator('#general.settings-section')).toBeVisible({ timeout: 20_000 })
  await page.evaluate(() => { (window as HookWindow).__walnutSettingsCrash = 'sessions' })
  await page.getByTestId(NAV('sessions')).click()
  const section = page.locator('#sessions.settings-section')
  await expect(section).toContainText("This section couldn't load.")
  await expect(section.getByRole('button', { name: 'Try again' })).toBeVisible()
  await expect.poll(() => warnings.some((w) => w.includes('section crashed'))).toBe(true)
  await clickNav(page, 'engines')
  await clickNav(page, 'sessions')
  await page.evaluate(() => { delete (window as HookWindow).__walnutSettingsCrash })
  await section.getByRole('button', { name: 'Try again' }).click()
  await expect(section).not.toContainText("This section couldn't load.")
  await expect(page.locator('#idle-timeout')).toBeVisible()
})

test('C39: Cmd+S submits the focused settings form once and never reaches the browser', async ({ page }) => {
  await page.route('**/api/config', (route) => (route.request().method() === 'PUT'
    ? route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' })
    : route.continue()))
  await openSettings(page)
  await clickNav(page, 'triage')
  await page.evaluate(() => {
    const w = window as unknown as { __submits: number; __prevented: boolean[] }
    w.__submits = 0
    w.__prevented = []
    document.querySelector('form#triage')!.addEventListener('submit', () => { w.__submits++ })
    window.addEventListener('keydown', (e) => { if (e.key.toLowerCase() === 's') w.__prevented.push(e.defaultPrevented) })
  })
  await page.locator('form#triage input:not([type=hidden]):not([tabindex="-1"])').first().focus()
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s')
  await expect.poll(() => page.evaluate(() => (window as unknown as { __submits: number }).__submits)).toBe(1)
  expect(await page.evaluate(() => (window as unknown as { __prevented: boolean[] }).__prevented)).toEqual([true])
  // Outside any form, on a pane whose lead is not a form: nothing is sent.
  const puts: string[] = []
  page.on('request', (r) => { if (r.method() === 'PUT' && r.url().includes('/api/config')) puts.push(r.url()) })
  await clickNav(page, 'usage')
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s')
  await page.waitForTimeout(500)
  expect(puts).toEqual([])
})

test('C40: with a slow config read the nav is usable at once and the pane shows a real skeleton', async ({ page }) => {
  await page.route('**/api/config', async (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    await new Promise((r) => setTimeout(r, 2000))
    return route.continue()
  })
  await page.goto('/settings')
  await expect(page.locator('.settings-nav')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId(NAV('sessions'))).toBeEnabled()
  const skeleton = page.getByTestId('settings-pane-skeleton')
  await expect(skeleton).toBeVisible({ timeout: 1_500 })
  await expect(skeleton.locator('.settings-pane-tile')).toHaveCount(1)
  await expect(skeleton.locator('.settings-pane-title')).toHaveText('General')
  await expect(page.locator('#general.settings-section')).toBeVisible({ timeout: 20_000 })
  await expect(skeleton).toHaveCount(0)
})

test('C41: a failed config read offers Try again, which reads again', async ({ page }) => {
  let gets = 0
  await page.route('**/api/config', (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    gets++
    return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"fixture config failure"}' })
  })
  await page.goto('/settings')
  const err = page.getByTestId('settings-config-error')
  await expect(err).toContainText("Settings couldn't load.", { timeout: 30_000 })
  await expect(page.locator('.settings-nav')).toBeVisible()
  const before = gets
  await err.getByRole('button', { name: 'Try again' }).click()
  await expect.poll(() => gets).toBeGreaterThan(before)
  // The nav still only changes the hash.
  await page.getByTestId(NAV('sessions')).click()
  await expect(page).toHaveURL(/#sessions$/)
  await expect(err).toBeVisible()
})

test('C42: layout follows the Settings width, never the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 800 })
  await openSettings(page)
  await expect(page.locator('#general.settings-section')).toBeVisible({ timeout: 20_000 })
  const geo = await page.evaluate(() => ({
    container: document.querySelector('.settings-container')!.getBoundingClientRect().width,
    nav: document.querySelector('.settings-nav')!.getBoundingClientRect().width,
    scrollW: document.scrollingElement!.scrollWidth,
    clientW: document.scrollingElement!.clientWidth,
  }))
  const expected = geo.container >= 900 ? 232 : geo.container >= 640 ? 200 : 56
  expect(Math.round(geo.nav)).toBe(expected)
  expect(geo.scrollW).toBeLessThanOrEqual(geo.clientW)
  // No viewport width media queries in the settings stylesheets (Vite dev injects them as <style>).
  const viewportRules = await page.evaluate(() => [...document.querySelectorAll('style[data-vite-dev-id*="settings-"]')]
    .filter((s) => /@media[^{]*(min-width|max-width|width\s*[<>])/.test(s.textContent ?? ''))
    .map((s) => s.getAttribute('data-vite-dev-id')))
  expect(viewportRules).toEqual([])
})

test('C43: under 640px the nav is an icon rail whose magnifier opens the full nav', async ({ page }) => {
  await page.setViewportSize({ width: 620, height: 800 })
  await openSettings(page)
  const nav = page.locator('.settings-nav')
  await expect.poll(async () => Math.round((await nav.boundingBox())!.width)).toBe(56)
  await expect(page.getByTestId('settings-filter')).toBeHidden()
  await page.locator('.settings-nav-find-button').click()
  await expect(nav).toHaveClass(/is-overlay-open/)
  await expect.poll(async () => Math.round((await nav.boundingBox())!.width)).toBe(232)
  await expect(page.getByTestId('settings-filter')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(nav).not.toHaveClass(/is-overlay-open/)
  await page.locator('.settings-nav-find-button').click()
  await page.getByTestId(NAV('sessions')).click()
  await expect(nav).not.toHaveClass(/is-overlay-open/)
  await expect(page.locator('#sessions.settings-section')).toBeVisible({ timeout: 20_000 })
})

test('C70: one Clear button and no native search chrome', async ({ page, browserName }) => {
  await openSettings(page)
  const filter = page.getByTestId('settings-filter')
  await filter.fill('a')
  await expect(page.locator('[aria-label="Clear"]:visible')).toHaveCount(1)
  const styles = await filter.evaluate((el) => {
    // Chromium answers getComputedStyle for this pseudo with the input's own
    // style, so also read the rule the stylesheet applies to it.
    const rules: string[] = []
    for (const sheet of [...document.styleSheets]) {
      let list: CSSRuleList
      try { list = sheet.cssRules } catch { continue }
      for (const rule of [...list]) {
        if (rule instanceof CSSStyleRule && rule.selectorText.includes('settings-filter::-webkit-search-cancel-button')
          && el.matches(rule.selectorText.replace(/::-webkit-search-cancel-button/g, ''))) rules.push(rule.style.display)
      }
    }
    return {
      cancel: getComputedStyle(el, '::-webkit-search-cancel-button').display,
      own: getComputedStyle(el).display,
      rules,
      appearance: getComputedStyle(el).appearance || (getComputedStyle(el) as unknown as { webkitAppearance: string }).webkitAppearance,
    }
  })
  expect(styles.rules).toContain('none')
  if (styles.cancel !== styles.own) expect(styles.cancel).toBe('none')
  expect(styles.appearance).toBe('none')
  await page.locator('.settings-nav').screenshot({ path: `/tmp/settings-redesign/after/filter-${browserName}.png` })
})

test('C69: a slow plugin runtime does not move the Configure group', async ({ page }) => {
  await openSettings(page)
  // Let the nav learn (and cache) how many plugin rows this fixture has.
  await expect.poll(() => page.evaluate(() => window.localStorage.getItem('walnut.settings.nav.pluginCount')), { timeout: 20_000 }).not.toBeNull()
  await page.route('**/api/plugin-runtime', async (route) => {
    await new Promise((r) => setTimeout(r, 1000))
    return route.continue()
  })
  await page.reload()
  const sessions = page.getByTestId(NAV('sessions'))
  await expect(sessions).toBeVisible({ timeout: 30_000 })
  const firstY = (await sessions.boundingBox())!.y
  await page.waitForTimeout(2500)
  const laterY = (await sessions.boundingBox())!.y
  expect(Math.abs(laterY - firstY)).toBeLessThanOrEqual(1)
  // No cache: the first frame shows only the Plugins row in its group, then the cache is written.
  await page.evaluate(() => window.localStorage.removeItem('walnut.settings.nav.pluginCount'))
  await page.reload()
  await expect(sessions).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.settings-nav-placeholder')).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => window.localStorage.getItem('walnut.settings.nav.pluginCount')), { timeout: 20_000 }).not.toBeNull()
})

test('C74: deep links hold their target while slow content above it grows', async ({ page }) => {
  await page.route(/\/api\/(devices|keep-awake)(\/|$|\?)/, async (route) => {
    await new Promise((r) => setTimeout(r, 800))
    return route.continue()
  })
  for (const id of ['cloud', 'focus-tiers', 'providers', 'remote-hosts', 'calendar']) {
    await openSettings(page, `#${id}`)
    await expect(page.locator(`[id="${id}"]`)).toBeVisible({ timeout: 20_000 })
    await page.waitForTimeout(2500)
    const top = await paneTopOf(page, id)
    expect(top, `#${id}`).toBeGreaterThanOrEqual(0)
    expect(top, `#${id}`).toBeLessThanOrEqual(44 + 40)
  }
  // A wheel during the hold hands the scroll back to the person.
  await openSettings(page, '#providers')
  await expect(page.locator('#providers')).toBeVisible({ timeout: 20_000 })
  const pane = page.locator('.settings-pane')
  const box = (await pane.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + 200)
  await page.mouse.wheel(0, -300)
  await page.waitForTimeout(300)
  const afterWheel = await pane.evaluate((el) => el.scrollTop)
  await page.waitForTimeout(1500)
  expect(Math.abs((await pane.evaluate((el) => el.scrollTop)) - afterWheel)).toBeLessThanOrEqual(2)
})

test('C75: nav tiles stay distinct with plugin apps and panels', async ({ page }) => {
  await openSettings(page)
  await page.waitForFunction(() => !!(window as HookWindow).__walnutSettingsTestHooks)
  await page.evaluate(() => {
    const hooks = (window as HookWindow).__walnutSettingsTestHooks!
    const Page = () => null
    for (const [id, title] of [['fixture-app-one', 'Fixture One'], ['fixture-app-two', 'Fixture Two'], ['fixture-app-three', 'Fixture Three']]) {
      hooks.appRegistry.registerPlugin(id, title, { id: 'main', title, component: Page, placement: 'settings' })
    }
    for (const [id, name] of [['fixture-panel-one', 'Fixture Panel One'], ['fixture-panel-two', 'Fixture Panel Two']]) {
      hooks.pluginUiRegistry.registerSettings(id, name, { id: 'panel', label: name, component: () => null })
    }
  })
  await expect(page.locator('[data-testid^="settings-nav-app-fixture-app-"]')).toHaveCount(3)
  await expect(page.locator('[data-testid^="settings-nav-fixture-panel-"]')).toHaveCount(2)
  const tileKeys = () => page.$$eval('.settings-nav-list .settings-nav-item[data-testid] .settings-pane-tile', (els) =>
    els.map((el) => `${getComputedStyle(el).backgroundColor}|${el.getAttribute('data-glyph') ?? el.textContent}`))
  const keys = await tileKeys()
  expect(new Set(keys).size).toBe(keys.length)
  await page.setViewportSize({ width: 620, height: 800 })
  await expect.poll(async () => Math.round((await page.locator('.settings-nav').boundingBox())!.width)).toBe(56)
  const railKeys = await tileKeys()
  expect(new Set(railKeys).size).toBe(railKeys.length)
})

test('C60: a change left behind by a pane switch still saves, and a failure marks its pane', async ({ page }) => {
  const bodies: string[] = []
  let fail = false
  await page.route('**/api/config', (route) => {
    if (route.request().method() !== 'PUT') return route.continue()
    bodies.push(route.request().postData() ?? '')
    return fail
      ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"fixture write failure"}' })
      : route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' })
  })
  await openSettings(page)
  await clickNav(page, 'sessions')
  const idle = page.locator('#idle-timeout')
  await idle.fill('47')
  await page.getByTestId(NAV('engines')).click()
  await expect(page.locator('#engines.settings-section')).toBeVisible({ timeout: 20_000 })
  await expect.poll(() => bodies.some((b) => b.includes('"idle_timeout_minutes":47')), { timeout: 5_000 }).toBe(true)
  // The save belonged to Sessions: Engines never says Saved.
  for (let i = 0; i < 10; i++) {
    await expect(page.locator('#engines [data-testid="settings-saved-indicator"]')).toHaveCount(0)
    await page.waitForTimeout(250)
  }
  fail = true
  await clickNav(page, 'sessions')
  await idle.fill('48')
  await page.getByTestId(NAV('engines')).click()
  await expect(page.getByTestId('settings-nav-error-sessions')).toBeVisible({ timeout: 5_000 })
  await expect(page.getByTestId('settings-nav-error-sessions')).toHaveAttribute('title', "A change here wasn't saved.")
  await clickNav(page, 'sessions')
  await expect(page.getByTestId('settings-nav-error-sessions')).toHaveCount(0)
  await expect(page.locator('.settings-row:has(#idle-timeout) [role="alert"], #idle-timeout ~ [role="alert"], [role="alert"]:near(#idle-timeout)').first()).toBeVisible()
})

test('evidence: pane screenshots at 1280, 900 and 620 wide', async ({ page, browserName }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await openSettings(page)
  await expect(page.locator('#general.settings-section')).toBeVisible({ timeout: 20_000 })
  await page.waitForTimeout(500)
  await page.screenshot({ path: `/tmp/settings-redesign/after/p2-general-1280-${browserName}.png` })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.waitForTimeout(300)
  await page.screenshot({ path: `/tmp/settings-redesign/after/p2-general-1280-dark-${browserName}.png` })
  await page.emulateMedia({ colorScheme: 'light' })
  await clickNav(page, 'advanced')
  await page.waitForTimeout(500)
  await page.screenshot({ path: `/tmp/settings-redesign/after/p2-advanced-1280-${browserName}.png` })
  await page.setViewportSize({ width: 900, height: 800 })
  await page.waitForTimeout(300)
  await page.screenshot({ path: `/tmp/settings-redesign/after/p2-advanced-900-${browserName}.png` })
  await page.setViewportSize({ width: 620, height: 800 })
  await page.waitForTimeout(300)
  await page.screenshot({ path: `/tmp/settings-redesign/after/p2-rail-620-${browserName}.png` })
  await page.locator('.settings-nav-find-button').click()
  await page.waitForTimeout(200)
  await page.screenshot({ path: `/tmp/settings-redesign/after/p2-rail-overlay-620-${browserName}.png` })
})

test('C83 + C64: the second group reads Plugins; slack puts Plugins first', async ({ page }) => {
  await openSettings(page)
  const labels = await page.locator('.settings-nav-group-label').allTextContents()
  expect(labels).toEqual(['Manage', 'Plugins', 'Configure', 'Diagnostics'])
  expect(await page.locator('.settings-nav-group-label').first().evaluate((el) => getComputedStyle(el).textTransform)).toBe('none')
  await page.getByTestId('settings-filter').fill('slack')
  await expect.poll(async () => (await visibleNavKeys(page))[0]).toBe(NAV('plugin-store'))
  await page.getByTestId('settings-filter').press('Enter')
  await expect(page.getByTestId(NAV('plugin-store'))).toHaveAttribute('aria-current', 'page')
})

test('C82: a deep link to an installed plugin that is off says so after the runtime answers', async ({ page }) => {
  await page.route('**/api/plugin-runtime', async (route) => {
    try {
      const res = await route.fetch()
      const json = await res.json() as { plugins?: Array<{ id: string; state: string }> }
      json.plugins = [...(json.plugins ?? []), { id: 'fixture-off', state: 'disabled' }]
      await route.fulfill({ response: res, json })
    } catch {
      /* the page closed mid-refresh at the end of the test */
    }
  })
  await openSettings(page, '#fixture-off:panel')
  const off = page.getByTestId('settings-plugin-off')
  await expect(off).toContainText('This panel is from fixture-off, which is off.', { timeout: 20_000 })
  await expect(page.locator('#general.settings-section')).toHaveCount(0)
  await page.unrouteAll({ behavior: 'ignoreErrors' })
})

test('C45: reduced motion stops every settings transition and animation', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await openSettings(page)
  await expect(page.locator('#general.settings-section')).toBeVisible({ timeout: 20_000 })
  const moving = await page.evaluate(() => {
    const out: string[] = []
    const els = [...document.querySelectorAll('.settings-layout, .settings-layout *')] as HTMLElement[]
    for (const el of els) {
      const cs = getComputedStyle(el)
      const t = cs.transitionDuration.split(',').some((d) => parseFloat(d) > 0)
      const a = cs.animationName !== 'none' && cs.animationDuration.split(',').some((d) => parseFloat(d) > 0)
      if (t || a) out.push(`${el.tagName}.${el.className}`)
    }
    return out.slice(0, 10)
  })
  expect(moving).toEqual([])
})

for (const theme of ['light', 'dark'] as const) {
  test(`C46: every Tab stop in the nav and filter shows a focus ring (${theme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await openSettings(page)
    await expect(page.locator('#general.settings-section')).toBeVisible({ timeout: 20_000 })
    await page.getByTestId('settings-filter').focus()
    const missing: string[] = []
    for (let i = 0; i < 40; i++) {
      const info = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null
        if (!el || !el.closest('.settings-layout')) return null
        const cs = getComputedStyle(el)
        const ring = (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || cs.boxShadow !== 'none'
        return { ring, name: el.getAttribute('data-testid') ?? el.id ?? el.tagName, inNav: !!el.closest('.settings-nav') }
      })
      if (!info) break
      if (!info.ring) missing.push(info.name)
      if (!info.inNav) break
      await page.keyboard.press('Tab')
    }
    expect(missing).toEqual([])
  })
}
