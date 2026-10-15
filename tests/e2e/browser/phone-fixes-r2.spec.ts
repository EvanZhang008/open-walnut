/**
 * Phone review fixes, round 2 (nitpicks N2-xx and checklist items C19, C55,
 * C62, C63, C88): each test pins one defect a reviewer found on a phone.
 * WebKit with devices['iPhone 15'] first, chromium too.
 */
import fs from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import { isolateUiPrefs } from './todo-panel-helpers'
import { PHONE, findSmallTargets, findSmallText, menuButton, openDrawer } from './phone-helpers'
void findSmallTargets; void findSmallText; void openDrawer

/** The bar's Back (exact: a session titled "Background ..." also matches /Back/). */
const backButton = (page: Page) => page.locator('.phone-topbar .phone-topbar-back')

const SHOTS = '/tmp/mobile-web/phone-fixes-r2'

test.use({
  viewport: PHONE.viewport,
  screen: PHONE.screen,
  deviceScaleFactor: PHONE.deviceScaleFactor,
  isMobile: true,
  hasTouch: true,
  userAgent: PHONE.userAgent,
})

test.beforeAll(async () => { await fs.mkdir(SHOTS, { recursive: true }) })

async function bootHome(page: Page): Promise<string[]> {
  await isolateUiPrefs(page)
  await page.addInitScript(() => {
    try {
      if (sessionStorage.getItem('phone-fixes-r2-seeded')) return
      sessionStorage.setItem('phone-fixes-r2-seeded', '1')
      localStorage.setItem('open-walnut-home-chat-visible', 'false')
      localStorage.setItem('walnut-todo-quick-views-visible', 'true')
      // Every tab on the bar (the default hides Focus, Satellite, Parked and Recent).
      localStorage.setItem('walnut-todo-tab-bar-hidden-tabs', '[]')
    } catch { /* storage off */ }
  })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/')
  await expect(menuButton(page)).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.todo-search-input')).toBeVisible({ timeout: 30_000 })
  return errors
}

const shot = (page: Page, name: string) => page.screenshot({ path: `${SHOTS}/${test.info().project.name}-${name}.png` })

/** Every scroller inside the home panel, with its scrollTop. */
const scrollers = (page: Page) => page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('.todo-panel *, .home-navigation-scroll'))
  .filter((el) => el.scrollHeight > el.clientHeight + 4 && /(auto|scroll)/.test(getComputedStyle(el).overflowY))
  .map((el) => ({ cls: String(el.className).split(' ')[0], top: Math.round(el.scrollTop) })))

test('N2-01: opening a row from Recent keeps Recent, writes no tab preference, and Back lands where the thumb left', async ({ page }) => {
  const errors = await bootHome(page)
  const tabWrites: string[] = []
  page.on('request', (r) => {
    if (r.method() !== 'GET' && r.url().includes('/api/ui-prefs') && (r.postData() ?? '').includes('todo-active-section')) tabWrites.push(r.postData() ?? '')
  })
  const recent = page.locator('.todo-section-tab.todo-section-tab-recent')
  await recent.tap()
  await expect(recent).toHaveAttribute('aria-selected', 'true')
  const rows = page.locator('.todo-panel [data-task-id]')
  await expect(rows.first()).toBeVisible()
  // Scroll the list a little so a lost position shows.
  await page.evaluate(() => {
    const s = Array.from(document.querySelectorAll<HTMLElement>('.todo-panel *, .home-navigation-scroll'))
      .find((el) => el.scrollHeight > el.clientHeight + 40 && /(auto|scroll)/.test(getComputedStyle(el).overflowY))
    if (s) s.scrollTop = 40
  })
  await page.waitForTimeout(200)
  const before = await scrollers(page)
  const row = rows.nth(2)
  const id = (await row.getAttribute('data-task-id'))!
  const idsBefore = await rows.evaluateAll((els) => els.slice(0, 8).map((e) => e.getAttribute('data-task-id')))
  const box = (await row.boundingBox())!
  tabWrites.length = 0
  await page.mouse.move(0, 0)
  await page.touchscreen.tap(box.x + box.width / 2, box.y + Math.min(box.height / 2, 20))
  await expect(backButton(page)).toBeVisible({ timeout: 15_000 })
  await page.waitForTimeout(600)
  await expect(recent).toHaveAttribute('aria-selected', 'true')
  await backButton(page).tap()
  await expect(backButton(page)).toBeHidden({ timeout: 15_000 })
  await expect(recent).toHaveAttribute('aria-selected', 'true')
  const after = await scrollers(page)
  for (const b of before) {
    const a = after.find((x) => x.cls === b.cls)
    expect(a, `scroller ${b.cls} still there`).toBeTruthy()
    expect(Math.abs(a!.top - b.top), `scroller ${b.cls}`).toBeLessThanOrEqual(1)
  }
  // The same spot holds the same row: the next tap opens the same task.
  const box2 = (await page.locator(`.todo-panel [data-task-id="${id}"]`).first().boundingBox())!
  if (Math.abs(box2.y - box.y) > 1) {
    console.log('N2-01 debug', JSON.stringify({ box, box2, idsBefore, idsAfter: await rows.evaluateAll((els) => els.slice(0, 8).map((e) => e.getAttribute('data-task-id'))), before, after }))
  }
  expect(Math.abs(box2.y - box.y)).toBeLessThanOrEqual(1)
  const under = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-task-id]')?.getAttribute('data-task-id') ?? null,
    { x: box.x + box.width / 2, y: box.y + Math.min(box.height / 2, 20) })
  expect(under).toBe(id)
  // The Recent tap itself syncs 'recent' (debounced); opening the row writes nothing else.
  expect(tabWrites.filter((w) => !w.includes('"v":"recent"'))).toEqual([])
  await shot(page, 'n2-01-back')
  expect(errors).toEqual([])
})

// A stubbed session (nothing reaches the fixture's CLI)
const SID = 'pw-question-recovery-session'
const sessionOverlay = (page: Page) => page.locator(`.main-page-session-column.is-mobile-active .session-panel[data-session-id="${SID}"]`)
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString()

async function openStubSession(page: Page, opts: { status?: string; turns?: number } = {}): Promise<string[]> {
  await isolateUiPrefs(page)
  await page.addInitScript(() => {
    try { localStorage.setItem('open-walnut-home-chat-visible', 'false') } catch { /* storage off */ }
    const Original = window.WebSocket
    class Captured extends Original {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        const holder = window as unknown as { __phoneWs?: WebSocket }
        if (new URL(String(url), location.href).pathname === '/ws' && !holder.__phoneWs) holder.__phoneWs = this
      }
    }
    for (const key of Object.getOwnPropertyNames(Original)) {
      if (key === 'prototype' || key === 'length' || key === 'name') continue
      try { (Captured as unknown as Record<string, unknown>)[key] = (Original as unknown as Record<string, unknown>)[key] } catch { /* read-only */ }
    }
    window.WebSocket = Captured as typeof WebSocket
  })
  const turns = opts.turns ?? 2
  const messages: Record<string, unknown>[] = []
  for (let i = 1; i <= turns; i++) {
    messages.push({ role: 'user', text: `Request ${i} for the shed inventory`, timestamp: iso(90_000 - i * 1000), msgId: `u-${i}` })
    messages.push({ role: 'assistant', text: `Working on request ${i}. `.repeat(25), timestamp: iso(89_000 - i * 1000), msgId: `a-${i}` })
  }
  await page.route(`**/api/sessions/${SID}`, (route) => route.fulfill({ json: {
    session: { claudeSessionId: SID, taskId: 'pw-task-question-recovery', project: 'Walnut', process_status: opts.status ?? 'running', mode: 'default',
      startedAt: iso(600_000), lastActiveAt: iso(2000), messageCount: turns * 2, title: 'Round two fixture' },
    pendingPermissions: [],
  } }))
  await page.route(`**/api/sessions/${SID}/history**`, (route) => route.fulfill({ json: { messages, cursor: messages.length, delta: false } }))
  await page.route(`**/api/sessions/${SID}/permission`, (route) => route.fulfill({ json: { status: 'resolved' } }))
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(`/?s1=${SID}`)
  await expect(sessionOverlay(page)).toBeVisible({ timeout: 30_000 })
  await expect(sessionOverlay(page).locator('[data-message-id="a-1"]')).toBeAttached({ timeout: 20_000 })
  return errors
}

async function injectFrame(page: Page, name: string, data: unknown): Promise<void> {
  await page.evaluate(({ n, d }) => {
    const ws = (window as unknown as { __phoneWs?: WebSocket }).__phoneWs
    if (!ws) throw new Error('socket not captured')
    ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'event', name: n, data: d, seq: Date.now() }) }))
  }, { n: name, d: data })
}

const bashAsk = (requestId: string) => ({ sessionId: SID, requestId, toolName: 'Bash', input: { command: 'ls -la ./garden', description: 'List the garden folder' }, reason: `ask ${requestId}` })

test('N2-10, N2-11: a waiting card names the bar, and the pill stays until its buttons show', async ({ page }) => {
  const errors = await openStubSession(page, { turns: 6 })
  await injectFrame(page, 'session:permission-request', bashAsk('req-r2-1'))
  const card = sessionOverlay(page).locator('.permission-request-card', { hasText: 'ask req-r2-1' })
  await expect(card).toBeVisible({ timeout: 10_000 })
  await expect(page.locator('.phone-topbar .phone-topbar-subtitle')).toHaveText('Needs you: Bash', { timeout: 10_000 })
  // Scroll so only the card's head shows above the composer: its buttons are off screen.
  await sessionOverlay(page).locator('.session-history').evaluate((scroller, sel) => {
    const c = scroller.querySelector<HTMLElement>(sel)!
    const s = scroller.getBoundingClientRect()
    // A reader's move (the input event first): the view opened on the card (R3-01).
    scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -40 }))
    scroller.scrollTop += c.getBoundingClientRect().top - (s.bottom - 40)
  }, '[data-prompt-pending="true"]')
  const pill = sessionOverlay(page).getByTestId('phone-prompt-pill')
  await expect(pill).toBeVisible({ timeout: 5_000 })
  await shot(page, 'n2-11-cut-card')
  const height = () => sessionOverlay(page).locator('.session-history').evaluate((el) => el.scrollHeight)
  const before = await height()
  await pill.tap()
  const allow = card.getByRole('button', { name: /^(Allow|Approve)/ }).first()
  await expect.poll(async () => {
    const b = await allow.boundingBox()
    const s = await sessionOverlay(page).locator('.session-history').boundingBox()
    return !!b && !!s && b.y >= s.y && b.y + b.height <= s.y + s.height + 1
  }, { timeout: 5_000 }).toBe(true)
  await expect(pill).toBeHidden()
  // Hiding the pill leaves the timeline's height alone: a shrink in the middle
  // of the pill's smooth scroll stopped it in WebKit, the buttons cut off.
  expect(await height()).toBe(before)
  expect(errors).toEqual([])
})

test('N2-06, N2-08: keyboard up, the strips fold, the controls keep one row, the band under the layer is painted; chrome reads 12 px', async ({ page }) => {
  const errors = await openStubSession(page)
  await page.setViewportSize({ width: 390, height: 844 })
  const panel = sessionOverlay(page)
  // Chrome the real data shows and the fixture does not: a recap, the notes row, the Background strip.
  await panel.evaluate((p) => {
    const host = p.querySelector('.session-history')!.parentElement!
    const wrap = document.createElement('div')
    wrap.innerHTML = '<div class="session-recap-tip" data-testid="r2-recap"><div class="session-recap-tip-body is-scrollable"><p class="session-recap-tip-row"><span class="session-recap-tip-label">Overall</span><span class="session-recap-tip-text">Sorting the shed inventory.</span></p></div><button type="button" class="session-recap-tip-close" aria-label="Dismiss recap">x</button></div>'
      + '<div class="session-notes-toggle" role="button" tabindex="0" data-testid="r2-notes">Notes</div>'
      + '<button type="button" class="wf-card wf-card--bar" data-testid="r2-bg"><span class="wf-card-title">Background</span><span class="wf-card-open"><span class="wf-card-open-label">View all </span></span></button>'
    host.insertBefore(wrap, host.firstChild)
  })
  const sizes = await panel.evaluate((p) => ['.session-recap-tip-label', '.session-recap-tip-text', '.wf-card-open-label']
    .map((sel) => parseFloat(getComputedStyle(p.querySelector(sel)!).fontSize)))
  for (const px of sizes) expect(px).toBeGreaterThanOrEqual(12)
  for (const id of ['r2-bg', 'r2-notes']) expect((await page.getByTestId(id).boundingBox())!.height).toBeGreaterThanOrEqual(43.5)
  const close = (await panel.locator('.session-recap-tip-close').boundingBox())!
  expect(Math.min(close.width, close.height)).toBeGreaterThanOrEqual(43.5)
  expect(await panel.locator('.session-recap-tip-body').evaluate((el) => getComputedStyle(el).overflowY)).toBe('visible')

  await page.evaluate(() => {
    const r = document.documentElement.style
    r.setProperty('--wn-safe-top', '47px')
    r.setProperty('--wn-keyboard-inset', '336px')
    document.documentElement.dataset.wnKeyboard = 'open'
  })
  for (const id of ['r2-recap', 'r2-notes', 'r2-bg']) await expect(page.getByTestId(id)).toBeHidden()
  await expect.poll(async () => (await panel.locator('.session-history').boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(300)
  // One row: every visible control in the composer's toolbar shares a line.
  const tops = await panel.locator('.session-panel-input .chat-input-controls').first().evaluate((row) => Array.from(row.children)
    .filter((c) => (c as HTMLElement).offsetParent !== null && c.getBoundingClientRect().height > 0)
    .map((c) => Math.round(c.getBoundingClientRect().top + c.getBoundingClientRect().height / 2)))
  expect(Math.max(...tops) - Math.min(...tops)).toBeLessThanOrEqual(6)
  // The band under the layer (where the keyboard is) is the layer's color, not the home list.
  const shadow = await page.locator('.main-page-content-row > .main-page-sessions-area:not(.collapsed)').first().evaluate((el) => getComputedStyle(el).boxShadow)
  expect(shadow).toContain('336px')
  await shot(page, 'n2-06-keyboard')
  expect(errors).toEqual([])
})

test('N2-07: the session menu is opaque, its labels sit in the middle of their rows, one divider under them', async ({ page }) => {
  const errors = await openStubSession(page)
  await page.locator('.phone-topbar').getByRole('button', { name: 'More actions' }).tap()
  const menu = page.locator('.task-kebab-menu').first()
  await expect(menu).toBeVisible()
  const bg = await menu.evaluate((el) => ({ color: getComputedStyle(el).backgroundColor, blur: getComputedStyle(el).backdropFilter || (getComputedStyle(el) as unknown as Record<string, string>).webkitBackdropFilter }))
  // The solid layer under the card color: alpha 1 (rgb(), or rgba with 1).
  expect(bg.color).toMatch(/^rgb\(|, 1\)$/)
  const off = await menu.locator('.phone-session-row').evaluateAll((rows) => rows.map((r) => {
    const label = r.querySelector('span')!.getBoundingClientRect()
    const box = r.getBoundingClientRect()
    return Math.abs((label.top + label.height / 2) - (box.top + box.height / 2))
  }))
  expect(off.length).toBeGreaterThan(0)
  for (const d of off) expect(d).toBeLessThanOrEqual(3)
  // No two dividers drawn back to back.
  const doubled = await menu.evaluate((m) => {
    const ds = Array.from(m.querySelectorAll<HTMLElement>('.task-kebab-divider')).filter((d) => d.getClientRects().length > 0)
    for (let i = 1; i < ds.length; i++) {
      if (ds[i]!.getBoundingClientRect().top - ds[i - 1]!.getBoundingClientRect().bottom < 4) return true
    }
    return false
  })
  expect(doubled).toBe(false)
  await shot(page, 'n2-07-menu')
  expect(errors).toEqual([])
})

test('N2-23: the Latest pill is opaque and sits about 8 px above the composer', async ({ page }) => {
  const errors = await openStubSession(page, { turns: 8 })
  const scroller = sessionOverlay(page).locator('.session-history')
  await scroller.evaluate((el) => { el.dispatchEvent(new WheelEvent('wheel', { deltaY: -400 })); el.scrollTop = 0 })
  const pill = sessionOverlay(page).locator('.scroll-to-bottom-btn')
  await expect(pill).toBeVisible({ timeout: 10_000 })
  await page.waitForTimeout(300)
  const p = (await pill.boundingBox())!
  const composer = (await sessionOverlay(page).locator('.session-panel-input').first().boundingBox())!
  const gap = composer.y - (p.y + p.height)
  expect(gap, `gap ${gap}`).toBeGreaterThanOrEqual(4)
  expect(gap, `gap ${gap}`).toBeLessThanOrEqual(16)
  const bg = await pill.evaluate((el) => getComputedStyle(el).backgroundColor)
  expect(bg).toMatch(/^rgb\(|, 1\)$/)
  await shot(page, 'n2-23-latest')
  expect(errors).toEqual([])
})

test('N2-16, N2-27: the phone drawer has no Tasks dashboard, and the quiet moon sits clear of the bell', async ({ page }) => {
  const errors = await bootHome(page)
  await openDrawer(page)
  const drawer = page.locator('#primary-sidebar')
  await expect(drawer.getByRole('link', { name: 'Notes' })).toBeVisible()
  await expect(drawer.getByRole('link', { name: 'Tasks', exact: true })).toHaveCount(0)
  // A moon the way quiet mode draws it: its box never overlaps the bell icon.
  const overlap = await page.evaluate(() => {
    const btn = document.querySelector<HTMLElement>('.sidebar .sidebar-notification-btn')!
    const moon = document.createElement('span')
    moon.className = 'quiet-moon'
    moon.textContent = '\u263E'
    btn.querySelector('svg')!.after(moon)
    const a = btn.querySelector('svg')!.getBoundingClientRect()
    const b = moon.getBoundingClientRect()
    const hit = !(b.right <= a.left || b.left >= a.right || b.bottom <= a.top || b.top >= a.bottom)
    moon.remove()
    return hit
  })
  expect(overlap).toBe(false)
  expect(errors).toEqual([])
})

test('N2-35: the sign-in page sends nothing but the sign-in probe, and writes nothing', async ({ page }) => {
  const calls: string[] = []
  await page.route((url) => url.pathname.startsWith('/api/'), (route) => {
    calls.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`)
    return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'not paired', code: 'not_paired' }) })
  })
  await page.goto('/')
  await expect(page.getByTestId('unpaired-notice')).toBeVisible({ timeout: 30_000 })
  // Past two of the deferred-start fallbacks (4 s each).
  await page.waitForTimeout(9_000)
  const extra = calls.filter((c) => !/^GET \/api\/v1\/me$/.test(c) && !/^(GET|POST) \/api\/browser-logs$/.test(c))
  expect(extra, JSON.stringify(calls)).toEqual([])
  expect(calls.filter((c) => !c.startsWith('GET ') && !c.includes('/api/browser-logs'))).toEqual([])
})

test('N2-28: the task panel footer draws no comma at a line end: each count is its own tap', async ({ page }) => {
  const errors = await bootHome(page)
  const footer = page.getByTestId('todo-filter-footer').first()
  if (await footer.count() === 0) { test.info().annotations.push({ type: 'note', description: 'no footer on this fixture view' }); return }
  const seps = await footer.locator('.todo-filter-footer-sep').evaluateAll((els) => els.filter((e) => getComputedStyle(e).display !== 'none').length)
  expect(seps).toBe(0)
  expect(errors).toEqual([])
})

test('N2-32: Ask Walnut on a phone has the session composer\'s one-line placeholder', async ({ page }) => {
  const errors = await bootHome(page)
  await openDrawer(page)
  await page.locator('#primary-sidebar').getByRole('button', { name: 'Ask Walnut', exact: true }).tap()
  const slot = page.getByTestId('ask-walnut-slot')
  await expect(slot).toBeVisible({ timeout: 15_000 })
  const input = slot.locator('textarea').first()
  await expect(input).toBeVisible({ timeout: 15_000 })
  const ph = await input.getAttribute('placeholder')
  expect(ph).not.toContain('/ for commands')
  const h = await input.evaluate((el) => ({ h: el.getBoundingClientRect().height, lh: parseFloat(getComputedStyle(el).lineHeight) || 22 }))
  expect(h.h).toBeLessThan(h.lh * 2)
  expect(errors).toEqual([])
})

test('N2-19: Routines on a phone: one title (the bar\'s), finger-sized controls, 12 px text', async ({ page }) => {
  const errors = await bootHome(page)
  await openDrawer(page)
  await page.locator('#primary-sidebar').getByRole('link', { name: 'Routines' }).click()
  await expect(page).toHaveURL(/\/routines/)
  const view = page.locator('.routines-view').first()
  await expect(view).toBeVisible({ timeout: 15_000 })
  await page.waitForTimeout(800)
  await expect(page.locator('.page-header .page-title', { hasText: 'Routines' })).toBeHidden()
  await expect(page.locator('.phone-topbar .phone-topbar-title-text')).toHaveText('Routines')
  const small = await findSmallTargets(page, '.routines-view')
  expect(small, JSON.stringify(small)).toEqual([])
  const tiny = await findSmallText(page, 12, '.routines-view')
  expect(tiny, JSON.stringify(tiny)).toEqual([])
  await shot(page, 'n2-19-routines')
  expect(errors).toEqual([])
})

test('N2-18: calendar event details read at 12 px on a phone', async ({ page }) => {
  const errors = await bootHome(page)
  await openDrawer(page)
  await page.locator('#primary-sidebar').getByRole('link', { name: 'Calendar' }).click()
  const cal = page.locator('.cal-page').first()
  await expect(cal).toBeVisible({ timeout: 15_000 })
  // A chip's location line as the day view draws it (the fixture may have no events today).
  const px = await cal.evaluate((root) => {
    const el = document.createElement('div')
    el.className = 'cal-chip-location'
    el.textContent = 'Greenhouse'
    root.appendChild(el)
    const size = parseFloat(getComputedStyle(el).fontSize)
    el.remove()
    return size
  })
  expect(px).toBeGreaterThanOrEqual(12)
  expect(errors).toEqual([])
})

test('N2-14: a tier\'s project and folder fold chevrons take a finger', async ({ page }) => {
  const errors = await bootHome(page)
  const tabs = page.locator('.todo-section-tabs .todo-section-tab')
  await expect(tabs.first()).toBeVisible()
  const n = await tabs.count()
  let seen = 0
  for (let i = 0; i < n; i++) {
    await tabs.nth(i).tap()
    await page.waitForTimeout(300)
    const boxes = await page.locator('.todo-panel .collapse-chevron').evaluateAll((els) => els
      .filter((e) => e.getClientRects().length > 0 && getComputedStyle(e).pointerEvents !== 'none')
      .map((e) => { const r = e.getBoundingClientRect(); return { w: r.width, h: r.height, label: e.getAttribute('aria-label') } }))
    for (const b of boxes) {
      expect(Math.min(b.w, b.h), JSON.stringify(b)).toBeGreaterThanOrEqual(43.5)
      seen++
    }
  }
  test.info().annotations.push({ type: 'chevrons', description: String(seen) })
  expect(errors).toEqual([])
})
