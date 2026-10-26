/**
 * The session overlay on a phone (spec 4.3 to 4.7; C20, C22, C24, C26, C32 to
 * C35, C37, C53, C64, C69, C71, C77, C78, C80, C81, C86).
 *
 * WebKit with devices['iPhone 15'] is the primary engine. The session these
 * tests open is the fixture's own (`Question recovery fixture`), with its
 * record and history stubbed page-locally where a test needs a shape (a long
 * last turn, twenty tool calls), so the shared fixture board is never written.
 * The first load is a goto (a deep link is one); everything after is taps.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { expect, test, type Page, type Route } from '@playwright/test'
import { isolateUiPrefs } from './todo-panel-helpers'
import {
  PHONE, backButton, injectSafeArea, menuButton, setKeyboardInset, findSmallTargets, findSmallText,
  expectNoHorizontalOverflow, openDrawer,
} from './phone-helpers'

const SID = 'pw-question-recovery-session'
const TASK_ID = 'pw-task-question-recovery'
const TASK_TITLE = 'Question recovery fixture'
const SHOTS = '/tmp/mobile-web/phone-session'

test.use({
  viewport: PHONE.viewport,
  screen: PHONE.screen,
  deviceScaleFactor: PHONE.deviceScaleFactor,
  isMobile: true,
  hasTouch: true,
  userAgent: PHONE.userAgent,
})

const overlay = (page: Page) => page.locator(`.main-page-session-column.is-mobile-active .session-panel[data-session-id="${SID}"]`)
const timeline = (page: Page) => overlay(page).locator('.session-history')
const topbar = (page: Page) => page.locator('.phone-topbar')

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString()

/** The session record, as GET /api/sessions/:id answers it. */
function sessionRecord(status: 'running' | 'idle' = 'idle', cwd?: string) {
  return {
    session: {
      ...(cwd ? { cwd } : {}),
      claudeSessionId: SID, taskId: TASK_ID, project: 'Walnut', process_status: status, mode: 'bypass',
      startedAt: iso(600_000), lastActiveAt: iso(5_000), messageCount: 40, title: TASK_TITLE,
    },
    pendingPermissions: [],
  }
}

/** A conversation whose last turn is three screens tall, after 20 tool calls. */
export function longTurnHistory(turns = 6) {
  const msgs: Record<string, unknown>[] = []
  for (let i = 1; i <= turns; i++) {
    msgs.push({ role: 'user', text: `Question number ${i} about the garden plan`, timestamp: iso(500_000 - i * 1000), msgId: `u-${i}` })
    if (i < turns) msgs.push({ role: 'assistant', text: `Answer number ${i}. `.repeat(30), timestamp: iso(499_000 - i * 1000), msgId: `a-${i}` })
  }
  for (let k = 1; k <= 20; k++) {
    msgs.push({
      role: 'assistant', text: '', timestamp: iso(100_000 - k * 100), msgId: `tool-${k}`,
      tools: [{ name: 'Bash', input: { command: `ls step-${k}` }, toolUseId: `tu-${k}`, result: `step-${k}` }],
    })
  }
  const para = 'The last answer keeps going so that it is taller than the screen. '.repeat(6)
  msgs.push({ role: 'assistant', text: Array.from({ length: 24 }, (_, i) => `Paragraph ${i + 1}. ${para}`).join('\n\n'), timestamp: iso(1000), msgId: 'a-last' })
  return msgs
}

async function stubSession(page: Page, opts: { history?: Record<string, unknown>[]; status?: 'running' | 'idle'; cwd?: string } = {}): Promise<void> {
  await page.route(`**/api/sessions/${SID}`, (route: Route) => route.fulfill({ json: sessionRecord(opts.status, opts.cwd) }))
  if (opts.history) {
    const messages = opts.history
    await page.route(`**/api/sessions/${SID}/history**`, (route: Route) =>
      route.fulfill({ json: { messages, cursor: messages.length, delta: false } }))
  }
}

async function boot(page: Page, url = '/', ready = '.phone-topbar'): Promise<string[]> {
  await isolateUiPrefs(page)
  await page.addInitScript(() => {
    try { localStorage.setItem('open-walnut-home-chat-visible', 'false') } catch { /* storage off */ }
  })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(url)
  await expect(page.locator(ready).first()).toBeVisible({ timeout: 30_000 })
  return errors
}

/** Wait for the timeline to stop growing, then put `id` at its top and keep it there. */
async function scrollRowToTop(page: Page, id: string): Promise<void> {
  const scroller = timeline(page)
  let last = -1
  await expect.poll(async () => {
    const h = await scroller.evaluate((el) => el.scrollHeight)
    const same = h === last
    last = h
    return same
  }, { intervals: [400], timeout: 15_000 }).toBe(true)
  await expect.poll(() => scroller.evaluate((el, rid) => {
    const row = el.querySelector<HTMLElement>(`[data-message-id="${rid}"]`)!
    const off = row.getBoundingClientRect().top - el.getBoundingClientRect().top
    // The reader's own move: the input event first, as a finger's pan sends one.
    if (Math.abs(off) > 6) { el.dispatchEvent(new WheelEvent('wheel', { deltaY: -40 })); el.scrollTop += off - 2 }
    return Math.abs(off) <= 6
  }, id), { intervals: [300], timeout: 10_000 }).toBe(true)
}

/** Deep link straight into the session (the first load). */
async function openByDeepLink(page: Page): Promise<string[]> {
  const errors = await boot(page, `/?s1=${SID}`)
  await expect(overlay(page)).toBeVisible({ timeout: 30_000 })
  await expect(backButton(page)).toBeVisible({ timeout: 15_000 })
  return errors
}

/**
 * The spec's budgets are for a 390 x 844 screen (a home-screen web app; the
 * device's own viewport is shorter by Safari's bars). Resize first, then set
 * the keyboard: a resize re-measures the visual viewport and clears it.
 */
async function tallPhone(page: Page): Promise<void> {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(300)
}

const historyInfo = (page: Page) => page.evaluate(() => ({
  length: history.length,
  marker: (history.state as { walnutOverlay?: { id: string; depth: number } } | null)?.walnutOverlay ?? null,
  search: location.search,
  path: location.pathname,
}))

/**
 * The Board row is a lead's only (useBoardTab): make the fixture task one for this page, page-locally,
 * by its owner read saying it keeps a Board of its own. The shared fixture board is not written.
 */
async function stubLeads(page: Page): Promise<void> {
  await page.route((url) => url.pathname === `/api/v1/tasks/${TASK_ID}/board/owner` && url.searchParams.get('tab') === '1', async (route: Route) => {
    try {
      const res = await route.fetch()
      if (!res.ok()) await route.fulfill({ response: res })
      else await route.fulfill({ response: res, json: { ...(await res.json()), has_board: true, own_board: true } })
    } catch { /* the page is gone */ }
  })
}

test('one bar: the session title, its status and its kebab are the top bar (C64)', async ({ page }) => {
  await stubSession(page, { history: longTurnHistory(3) })
  // A lead's kebab, so the list below is the longest one a session shows (Board included).
  await stubLeads(page)
  const errors = await openByDeepLink(page)
  await expect(topbar(page).locator('.phone-topbar-title-text')).toHaveText(TASK_TITLE)
  await expect(topbar(page).locator('.phone-topbar-subtitle')).toHaveText(/^(Running|Idle|Stopped|Not available|Needs you|Needs your answer|Needs you: .+)$/)
  // The panel's own header takes no room and no taps.
  const header = await overlay(page).locator('.session-panel-header').evaluate((el) => {
    const r = el.getBoundingClientRect()
    return { h: r.height, vis: getComputedStyle(el).visibility }
  })
  expect(header.h).toBe(0)
  expect(header.vis).toBe('hidden')
  // Every header action is in the bar's kebab.
  const kebab = topbar(page).getByRole('button', { name: 'More actions' })
  const kb = (await kebab.boundingBox())!
  expect(kb.width).toBeGreaterThanOrEqual(44)
  expect(kb.height).toBeGreaterThanOrEqual(44)
  await kebab.click()
  const menu = page.locator('.task-kebab-menu')
  await expect(menu).toBeVisible()
  for (const id of ['changed', 'files', 'board', 'close']) {
    await expect(menu.getByTestId(`phone-row-${id}`)).toBeVisible()
  }
  // N12: the short phone list. No desktop-only rows, and it fits the screen.
  for (const id of ['locate', 'popout']) await expect(menu.getByTestId(`phone-row-${id}`)).toHaveCount(0)
  await expect(menu.getByText('Task detail', { exact: true })).toBeVisible()
  const menuText = await menu.innerText()
  for (const desktopOnly of ['Open in new tab', 'Open in VS Code', 'Copy dir', 'Panels', 'Web preview', 'Fork']) {
    expect(menuText, desktopOnly).not.toContain(desktopOnly)
  }
  await expect(menu.locator('select')).toHaveCount(0)
  const fits = await menu.evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight, items: el.querySelectorAll('.task-kebab-item').length }))
  expect(fits.sh).toBeLessThanOrEqual(fits.ch + 1)
  expect(fits.items).toBeLessThanOrEqual(12)
  const small = await findSmallTargets(page, '.task-kebab-menu')
  expect(small, JSON.stringify(small)).toEqual([])
  const m = (await menu.boundingBox())!
  const bar = (await topbar(page).boundingBox())!
  expect(m.y).toBeGreaterThanOrEqual(bar.y + bar.height - 1)
  expect(m.x + m.width).toBeLessThanOrEqual(PHONE.viewport.width)
  await page.screenshot({ path: `${SHOTS}/c64-kebab-${test.info().project.name}.png` })
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  // Budget: on 390 x 844, notch 47 + keyboard 336 still leaves 300 px of timeline.
  await tallPhone(page)
  await injectSafeArea(page, { top: 47 })
  await setKeyboardInset(page, 336)
  await expect.poll(async () => (await timeline(page).boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(300)
  const t = (await topbar(page).boundingBox())!
  expect(t.height).toBe(91)
  await expectNoHorizontalOverflow(page)
  expect(errors).toEqual([])
})

test('deep link: back closes the session and lands on home, never outside Walnut (C22, C26)', async ({ page }) => {
  await stubSession(page, { history: longTurnHistory(2) })
  const errors = await openByDeepLink(page)
  const opened = await historyInfo(page)
  expect(opened.marker?.id).toBe(`session:${SID}`)
  const origin = new URL(page.url()).origin
  await page.goBack()
  await expect(overlay(page)).toHaveCount(0)
  await expect(menuButton(page)).toBeVisible()
  const home = await historyInfo(page)
  expect(home.path).toBe('/')
  expect(home.search).not.toContain(SID)
  expect(new URL(page.url()).origin).toBe(origin)
  await expect(page.locator('[data-testid="unpaired-notice"]')).toHaveCount(0)
  await expect(page.locator('.todo-search-input')).toBeVisible()
  expect(errors).toEqual([])
})

test('the bar title goes to the start of the latest turn, never to the top (C53)', async ({ page }) => {
  await stubSession(page, { history: longTurnHistory(8) })
  await openByDeepLink(page)
  const scroller = timeline(page)
  await expect(scroller.locator('[data-message-id="u-8"]')).toBeAttached({ timeout: 15_000 })
  await page.waitForTimeout(2200) // past the open-time positioning window
  await scroller.evaluate((el) => { el.scrollTop = el.scrollHeight })
  let historyCalls = 0
  page.on('request', (r) => { if (/\/history/.test(r.url()) && /before|cursor=0|older/.test(r.url())) historyCalls++ })
  await topbar(page).locator('.phone-topbar-title').click()
  await expect.poll(() => scroller.evaluate((el) => {
    const row = el.querySelector<HTMLElement>('[data-message-id="u-8"]')!
    return Math.round(Math.abs(row.getBoundingClientRect().top - el.getBoundingClientRect().top))
  }), { timeout: 5000 }).toBeLessThanOrEqual(40)
  expect(await scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
  expect(historyCalls).toBe(0)
})

/** Capture the app's socket so server frames can be injected verbatim. */
async function captureWs(page: Page): Promise<void> {
  await page.addInitScript(() => {
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
}

async function inject(page: Page, name: string, data: unknown): Promise<void> {
  await page.evaluate(({ n, d }) => {
    const ws = (window as unknown as { __phoneWs?: WebSocket }).__phoneWs
    if (!ws) throw new Error('socket not captured')
    ws.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'event', name: n, data: d, seq: Date.now() }) }))
  }, { n: name, d: data })
}

test('a long last turn opens at its start; 20 calls are one row; the jump pill counts what arrives (C69, C35)', async ({ page }) => {
  const history = longTurnHistory(6)
  await stubSession(page, { history })
  await captureWs(page)
  await openByDeepLink(page)
  const scroller = timeline(page)
  await expect(scroller.locator('[data-message-id="a-last"]')).toBeAttached({ timeout: 15_000 })
  // Opened at the start of the latest turn, the jump pill showing.
  await expect.poll(() => scroller.evaluate((el) => {
    const row = el.querySelector<HTMLElement>('[data-message-id="u-6"]')!
    return Math.abs(Math.round(row.getBoundingClientRect().top - el.getBoundingClientRect().top - 8))
  }), { timeout: 5000 }).toBeLessThanOrEqual(10)
  const jump = overlay(page).locator('.scroll-to-bottom-btn')
  await expect(jump).toHaveCount(1)
  await expect(jump).toHaveClass(/visible/)
  await expect(jump).toHaveAttribute('aria-label', 'Scroll to bottom')
  await expect(jump).toHaveText('Latest')
  expect((await jump.boundingBox())!.height).toBeGreaterThanOrEqual(44)
  await expect(page.getByRole('button', { name: 'Jump to latest' })).toHaveCount(0)
  // Twenty consecutive calls: ONE row of 44 px, opens and closes.
  const run = scroller.locator('.tool-run-toggle', { hasText: '20 tool calls' })
  await expect(run).toHaveCount(1)
  expect((await run.boundingBox())!.height).toBeGreaterThanOrEqual(44)
  await run.click()
  await expect(scroller.locator('.tool-run-body').first()).toBeVisible()
  await run.click()
  await expect(scroller.locator('.tool-run-body')).toHaveCount(0)
  await page.screenshot({ path: `${SHOTS}/c69-turn-start-${test.info().project.name}.png` })

  // Three rows arrive while reading above: the view holds, the pill counts them.
  await scroller.evaluate((el) => { el.dispatchEvent(new WheelEvent('wheel', { deltaY: -40 })); el.scrollTop = Math.max(0, el.scrollTop - 200) })
  await page.waitForTimeout(300)
  const before = await scroller.evaluate((el) => el.scrollTop)
  for (let i = 1; i <= 3; i++) {
    history.push({ role: 'assistant', text: `New note ${i}`, timestamp: new Date().toISOString(), msgId: `new-${i}` })
  }
  await inject(page, 'session:batch-completed', { sessionId: SID })
  await expect(scroller.locator('[data-message-id="new-3"]')).toBeAttached({ timeout: 15_000 })
  await expect(jump).toHaveText('3 new')
  expect(Math.abs((await scroller.evaluate((el) => el.scrollTop)) - before)).toBeLessThanOrEqual(1)
  await jump.click()
  await expect.poll(() => scroller.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThanOrEqual(80)
  await expect(jump).not.toHaveClass(/visible/)
})

interface WsTap { sends: Record<string, unknown>[]; push(name: string, data: unknown): void }

/**
 * Sit between the page and the server's socket: `session:send` is answered by
 * `answer` (the fixture's CLI never sees it), everything else passes through.
 */
async function tapSocket(page: Page, answer: (n: number) => { ok: true; messageId: string } | { ok: false; error: string }, delayMs = 150): Promise<WsTap> {
  const tap: WsTap = { sends: [], push: () => { throw new Error('socket not open') } }
  await page.routeWebSocket(/\/ws(?:\?|$)/, (ws) => {
    const server = ws.connectToServer()
    tap.push = (name, data) => ws.send(JSON.stringify({ type: 'event', name, data, seq: Date.now() }))
    ws.onMessage((m) => {
      let f: { type?: string; id?: string; method?: string; payload?: Record<string, unknown> } = {}
      try { f = JSON.parse(String(m)) } catch { /* not JSON */ }
      if (f.type === 'req' && f.method === 'session:send') {
        tap.sends.push(f.payload ?? {})
        const a = answer(tap.sends.length)
        setTimeout(() => ws.send(JSON.stringify(a.ok
          ? { type: 'res', id: f.id, ok: true, payload: { messageId: a.messageId, enqueuedAt: new Date().toISOString() } }
          : { type: 'res', id: f.id, ok: false, error: a.error })), delayMs)
        return
      }
      server.send(m)
    })
    server.onMessage((m) => ws.send(m))
  })
  return tap
}

const composer = (page: Page) => overlay(page).locator('.chat-input-textarea')
const sendButton = (page: Page) => overlay(page).locator('.session-panel-input .chat-send-btn-icon').first()
const delivery = (page: Page) => overlay(page).locator('.session-delivery-meta')

test('send: Return is a newline, the 44 px send button sends, the line says how it went (C32, C33, C71, C20)', async ({ page }) => {
  await stubSession(page, { history: longTurnHistory(2) })
  const tap = await tapSocket(page, (n) => (n === 1 ? { ok: true, messageId: 'qm-phone-1' } : { ok: false, error: 'connection lost' }))
  const errors = await openByDeepLink(page)
  await injectSafeArea(page, { bottom: 34 })
  const input = composer(page)
  // 16 px, so focusing it never zooms the page (C28).
  expect(await input.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16)
  await input.click()
  expect(await page.evaluate(() => window.visualViewport?.scale ?? 1)).toBe(1)
  await input.fill('first line')
  await input.press('Enter')
  await input.pressSequentially('second line')
  expect(await input.inputValue()).toBe('first line\nsecond line')
  expect(tap.sends).toHaveLength(0)
  // The composer clears the home indicator (C20): the box reaches the screen's
  // foot, the input inside it ends 34 px above it.
  const vh = await page.evaluate(() => window.innerHeight)
  const c = (await overlay(page).locator('.session-panel-input').boundingBox())!
  const card = (await input.boundingBox())!
  expect(card.y + card.height).toBeLessThanOrEqual(vh - 34)
  expect(c.y + c.height).toBeLessThanOrEqual(vh + 1)
  expect(c.y + c.height).toBeGreaterThanOrEqual(vh - 1)
  const send = sendButton(page)
  const sb = (await send.boundingBox())!
  expect(sb.width).toBeGreaterThanOrEqual(44)
  expect(sb.height).toBeGreaterThanOrEqual(44)
  // Measured in the page: from the tap's click to the row in the timeline (C32).
  await page.evaluate(() => {
    const w = window as unknown as { __sentAt: number; __rowAt: number }
    w.__sentAt = 0; w.__rowAt = 0
    document.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.chat-send-btn-icon') && !w.__sentAt) w.__sentAt = performance.now()
    }, true)
    const mo = new MutationObserver(() => {
      if (!w.__sentAt || w.__rowAt) return
      const hit = [...document.querySelectorAll('.session-history .session-msg-queued, .session-history .session-msg-received, .session-history .session-msg-delivered')]
        .some((r) => r.textContent?.includes('second line'))
      if (hit) { w.__rowAt = performance.now(); mo.disconnect() }
    })
    mo.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class'] })
  })
  await send.click()
  const row = overlay(page).locator('.session-msg-queued, .session-msg-received, .session-msg-delivered', { hasText: 'second line' })
  await expect(row).toBeVisible({ timeout: 2000 })
  expect(await input.inputValue()).toBe('')
  const appearedMs = await page.evaluate(() => { const w = window as unknown as { __sentAt: number; __rowAt: number }; return w.__rowAt - w.__sentAt })
  expect(appearedMs, `appeared after ${Math.round(appearedMs)} ms`).toBeLessThanOrEqual(300)
  await expect(row.locator('.session-delivery-meta')).toHaveText(/^Sending\.\.\./)
  await expect.poll(() => tap.sends.length).toBe(1)
  tap.push('session:messages-delivered', { sessionId: SID, count: 1, messageIds: ['qm-phone-1'] })
  await expect(row.locator('.session-delivery-meta')).toHaveText('Delivered')
  await expect(row.locator('.session-delivery-meta')).toHaveClass(/is-fading/, { timeout: 4000 })

  // A failed send says so, and is never sent again by itself.
  await input.fill('will not arrive')
  await send.click()
  const failed = overlay(page).locator('.session-msg-failed', { hasText: 'will not arrive' })
  await expect(failed.locator('.session-delivery-meta')).toHaveText('Not sent. Tap to retry.', { timeout: 10_000 })
  await page.waitForTimeout(2500)
  expect(tap.sends).toHaveLength(2)
  const retry = failed.getByRole('button', { name: 'Not sent. Tap to retry.' })
  expect((await retry.boundingBox())!.height).toBeGreaterThanOrEqual(44)
  await retry.click()
  await expect.poll(() => tap.sends.length).toBe(3)
  await page.screenshot({ path: `${SHOTS}/c71-delivery-${test.info().project.name}.png` })
  expect(errors).toEqual([])
})

const homeScroller = (page: Page) => page.locator('.main-page-todo .home-navigation-scroll').first()

/**
 * Real density on the home list: the fixture board is short, so the page's
 * own task list answer gets 40 more rows like the fixture task (page-local,
 * nothing is written). Their session links are dropped.
 */
async function denseHome(page: Page, extra = 40): Promise<void> {
  await page.route(/\/api\/tasks(\?|$)/, async (route: Route) => {
    const req = route.request()
    if (req.method() !== 'GET' || new URL(req.url()).searchParams.has('ids')) { await route.fallback(); return }
    const res = await route.fetch()
    const body = await res.json() as { tasks?: Array<Record<string, unknown>> }
    const seed = body.tasks?.find((t) => t.id === TASK_ID) ?? body.tasks?.[0]
    if (seed && body.tasks) {
      const base = Object.fromEntries(Object.entries(seed).filter(([k]) => !/session|parent|children|subtask/i.test(k)))
      for (let i = 1; i <= extra; i++) body.tasks.push({ ...base, id: `pw-phone-density-${i}`, title: `Density row ${i}` })
    }
    await route.fulfill({ response: res, json: body })
  })
}

/**
 * Expand every project so the home list is long, scroll it well down, open the
 * session from there (its row when it is far enough down, else the open event
 * a row tap sends). The chevron is a rotated glyph, so each is tapped once.
 */
async function openFromMidHome(page: Page): Promise<number> {
  const box = homeScroller(page)
  await expect(box).toBeVisible({ timeout: 20_000 })
  // Open folded projects one by one (a tap anywhere on a project's header
  // row folds or opens it) until the list is long; an open one's chevron
  // carries `expanded`.
  const room = () => box.evaluate((el) => el.scrollHeight - el.clientHeight)
  // The list settles first (the task fetch lands, the headers stop changing).
  const heads = box.locator('.todo-group-project-header')
  let lastHeads = -1
  await expect.poll(async () => { const n = await heads.count(); const same = n > 1 && n === lastHeads; lastHeads = n; return same }, { intervals: [500], timeout: 20_000 }).toBe(true)
  for (let i = 0; i < 24 && (await room()) < 1400; i++) {
    const closed = box.locator('.todo-group-project-header').filter({ has: page.locator('.collapse-chevron:not(.expanded)') })
    if (await closed.count() === 0) break
    const h = closed.first()
    await h.scrollIntoViewIfNeeded()
    await h.click()
    await page.waitForTimeout(150)
  }
  await page.waitForTimeout(300)
  const row = page.locator(`.main-page-todo [data-task-id="${TASK_ID}"]`).first()
  const rowTop = await row.count()
    ? await row.evaluate((el) => {
      const s = el.closest<HTMLElement>('.home-navigation-scroll')!
      return el.getBoundingClientRect().top - s.getBoundingClientRect().top + s.scrollTop
    })
    : -1
  const max = await box.evaluate((el) => el.scrollHeight - el.clientHeight)
  expect(max, `the expanded home list scrolls past the middle (${await heads.allTextContents().then((t) => t.join(' | '))})`).toBeGreaterThanOrEqual(600)
  const target = Math.min(Math.max(640, rowTop - 120), max)
  await box.evaluate((el, top) => { el.scrollTop = top }, target)
  await page.waitForTimeout(250)
  const at = await box.evaluate((el) => el.scrollTop)
  expect(at, 'home scrollTop before the session opens').toBeGreaterThanOrEqual(600)
  const rowInView = rowTop >= 0 && await row.evaluate((el) => {
    const s = el.closest<HTMLElement>('.home-navigation-scroll')!.getBoundingClientRect(); const r = el.getBoundingClientRect()
    return r.top >= s.top && r.bottom <= s.bottom
  })
  if (rowInView) await row.locator('.todo-item-title').first().click()
  else await page.evaluate((sid) => window.dispatchEvent(new CustomEvent('main:open-session', { detail: { sessionId: sid } })), SID)
  await expect(overlay(page)).toBeVisible({ timeout: 20_000 })
  test.info().annotations.push({ type: 'open path', description: rowInView ? `row tap at ${rowTop}` : `event (row at ${rowTop}, room ${max})` })
  return at
}

test('home stays mounted under the session: back returns to the same scroll (C34)', async ({ page }) => {
  await stubSession(page, { history: longTurnHistory(2) })
  await denseHome(page)
  const errors = await boot(page)
  const at = await openFromMidHome(page)
  test.info().annotations.push({ type: 'home scrollTop', description: String(at) })
  await expect(page.locator('.main-page-todo')).toBeAttached()
  const geo = () => homeScroller(page).evaluate((el) => ({ st: Math.round(el.scrollTop), sh: el.scrollHeight, ch: el.clientHeight }))
  const during = await geo()
  await backButton(page).click()
  await expect(overlay(page)).toHaveCount(0)
  const after = await homeScroller(page).evaluate((el) => el.scrollTop)
  expect(Math.abs(after - at), `home ${JSON.stringify({ at, during, after: await geo() })}`).toBeLessThanOrEqual(1)
  expect(errors).toEqual([])
})

test('nested: session, then its task detail; back twice peels them in order (C24)', async ({ page }) => {
  await stubSession(page, { history: longTurnHistory(2) })
  await openByDeepLink(page)
  await topbar(page).getByRole('button', { name: 'More actions' }).click()
  await page.locator('.task-kebab-menu').getByText('Task detail', { exact: true }).click()
  await expect(page.locator('.task-detail-modal')).toBeVisible({ timeout: 10_000 })
  await page.goBack()
  await expect(page.locator('.task-detail-modal')).toHaveCount(0)
  await expect(overlay(page)).toBeVisible()
  await page.goBack()
  await expect(overlay(page)).toHaveCount(0)
  await expect(menuButton(page)).toBeVisible()
  expect(new URL(page.url()).pathname).toBe('/')
})

test('a reload puts the session, its message and the home scroll back, then forgets (C80)', async ({ page }) => {
  await stubSession(page, { history: longTurnHistory(8) })
  await denseHome(page)
  await boot(page)
  const at = await openFromMidHome(page)
  const scroller = timeline(page)
  await expect(scroller.locator('[data-message-id="u-3"]')).toBeAttached({ timeout: 15_000 })
  await scrollRowToTop(page, 'u-3')
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false })))
  const saved = await page.evaluate(() => sessionStorage.getItem('walnut.phoneRestore'))
  expect(JSON.parse(saved!)).toMatchObject({ sessionId: SID, anchorMessageId: 'u-3' })
  await page.reload()
  await expect(overlay(page)).toBeVisible({ timeout: 30_000 })
  await expect.poll(() => timeline(page).evaluate((el) => {
    const row = el.querySelector<HTMLElement>('[data-message-id="u-3"]')
    if (!row) return false
    const r = row.getBoundingClientRect(); const b = el.getBoundingClientRect()
    return r.top >= b.top - 2 && r.top < b.bottom - 40
  }), { timeout: 15_000 }).toBe(true)
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('walnut.phoneRestore')), { timeout: 15_000 }).toBeNull()
  await page.goBack()
  await expect(overlay(page)).toHaveCount(0)
  const after = await homeScroller(page).evaluate((el) => el.scrollTop)
  expect(Math.abs(after - at)).toBeLessThanOrEqual(1)
})

test('a reload while hidden (the deploy path) restores the same way (C80)', async ({ page }) => {
  await stubSession(page, { history: longTurnHistory(8) })
  await denseHome(page)
  await boot(page)
  await openFromMidHome(page)
  const scroller = timeline(page)
  await expect(scroller.locator('[data-message-id="u-4"]')).toBeAttached({ timeout: 15_000 })
  await scrollRowToTop(page, 'u-4')
  // Hidden, as a phone is between uses; stale-assets reloads a hidden page.
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  expect(JSON.parse((await page.evaluate(() => sessionStorage.getItem('walnut.phoneRestore')))!))
    .toMatchObject({ sessionId: SID, anchorMessageId: 'u-4' })
  await page.evaluate(() => location.reload())
  await expect(overlay(page)).toBeVisible({ timeout: 30_000 })
  await expect.poll(() => timeline(page).evaluate((el) => {
    const row = el.querySelector<HTMLElement>('[data-message-id="u-4"]')
    if (!row) return false
    const r = row.getBoundingClientRect(); const b = el.getBoundingClientRect()
    return r.top >= b.top - 2 && r.top < b.bottom - 40
  }), { timeout: 15_000 }).toBe(true)
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('walnut.phoneRestore')), { timeout: 15_000 }).toBeNull()
  await page.goBack()
  await expect(overlay(page)).toHaveCount(0)
})

/**
 * Hover never happens on a touch screen: each action is reached by a tap. On a
 * phone a message's actions are one always-drawn `Message actions` button (N8:
 * no hover strip under the bubble), whose menu holds Copy message.
 */
async function expectTouchReachable(page: Page): Promise<void> {
  const firstAssistant = timeline(page).locator('[data-msg-role="assistant"]').first()
  await expect(firstAssistant).toBeVisible({ timeout: 15_000 })
  const more = firstAssistant.getByRole('button', { name: 'Message actions' })
  await expect(more).toBeAttached()
  const cs = await more.evaluate((el) => ({ o: Number(getComputedStyle(el).opacity), pe: getComputedStyle(el).pointerEvents }))
  expect(cs.o).toBeGreaterThan(0.3)
  expect(cs.pe).not.toBe('none')
  // Scroll it into view as a reader would (input first), then tap it.
  await more.evaluate((b) => {
    b.closest('.session-history')!.dispatchEvent(new WheelEvent('wheel', { deltaY: -40 }))
    b.scrollIntoView({ block: 'center' })
  })
  await more.tap()
  const menu = page.locator('.wn-context-menu, [role="menu"]').last()
  await expect(menu.getByText('Copy message', { exact: true })).toBeVisible()
  await menu.getByText('Copy message', { exact: true }).tap()
}

test('touch: message copy is reachable without hover (C37)', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await stubSession(page, { history: longTurnHistory(2) })
  await openByDeepLink(page)
  expect(await page.evaluate(() => matchMedia('(hover: none)').matches)).toBe(true)
  await expectTouchReachable(page)
  // The header's actions are the bar's kebab rows (tapped one by one in C64).
  await topbar(page).getByRole('button', { name: 'More actions' }).tap()
  await expect(page.getByTestId('phone-session-rows')).toBeVisible()
})

test.describe('iPad portrait, touch (C86)', () => {
  test.use({ viewport: { width: 820, height: 1180 }, screen: { width: 820, height: 1180 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })

  test('desktop columns, and nothing in a session needs hover', async ({ page }) => {
    await stubSession(page, { history: longTurnHistory(2) })
    await boot(page, `/?s1=${SID}`, `.session-panel[data-session-id="${SID}"]`)
    const panel = page.locator(`.main-page-session-column .session-panel[data-session-id="${SID}"]`)
    await expect(panel).toBeVisible({ timeout: 30_000 })
    // Desktop layout: no phone bar, the panel's own header is there.
    await expect(page.locator('.phone-topbar')).toBeHidden()
    await expect(panel.locator('.session-panel-header')).toBeVisible()
    const firstAssistant = panel.locator('.session-history [data-msg-role="assistant"]').first()
    await expect(firstAssistant).toBeVisible({ timeout: 15_000 })
    const actions = firstAssistant.locator('.session-msg-actions').first()
    expect(await actions.evaluate((el) => Number(getComputedStyle(el).opacity))).toBeGreaterThan(0.3)
    await actions.evaluate((a) => {
      a.closest('.session-history')!.dispatchEvent(new WheelEvent('wheel', { deltaY: -40 }))
      a.scrollIntoView({ block: 'center' })
    })
    await actions.locator('button').first().tap()
    const kebab = panel.locator('.session-panel-header').getByRole('button', { name: 'More actions' })
    expect(await kebab.evaluate((el) => Number(getComputedStyle(el).opacity))).toBe(1)
    await kebab.tap()
    await expect(page.locator('.task-kebab-menu')).toBeVisible()
    await page.screenshot({ path: `${SHOTS}/c86-ipad-${test.info().project.name}.png` })
  })
})

const BOARD_HTML = `<h1>Garden board</h1>
<table><tr>${Array.from({ length: 12 }, (_, i) => `<td style="min-width:100px">Column ${i + 1}</td>`).join('')}</tr></table>
<walnut-choice id="water-when" title="When to water" options="dawn:At dawn,dusk:At dusk"></walnut-choice>
<walnut-thread id="garden-talk" title="Garden talk"></walnut-thread>`

/**
 * Both write the fixture task's Board and delete it when done, and the phone's Board row is there
 * only while the task keeps one (the row is a lead's, 2026-10-26): run in parallel, one's delete
 * took the other's row away. One after the other.
 */
test.describe('the fixture task\'s Board', () => {
  test.describe.configure({ mode: 'serial' })

  test('Board in a session: full width, a Chat toggle, phone text in the frame, the reply dock on the keyboard (C77)', async ({ page }) => {
    const put = await page.request.put(`/api/v1/tasks/${TASK_ID}/board`, { data: { html: BOARD_HTML } })
    expect(put.ok(), await put.text()).toBe(true)
    try {
      await stubSession(page, { history: longTurnHistory(2) })
      await openByDeepLink(page)
      await topbar(page).getByRole('button', { name: 'More actions' }).click()
      await page.getByTestId('phone-row-board').click()
      const pane = page.getByTestId('task-board-pane')
      await expect(pane).toBeVisible({ timeout: 15_000 })
      await expect(topbar(page).locator('.phone-topbar-title-text')).toHaveText('Board')
      // The leader's own page (the `Page` view), not the Cards view of the team.
      const custom = pane.getByTestId('board-view-custom')
      await expect(custom).toBeVisible({ timeout: 15_000 })
      if ((await custom.getAttribute('aria-pressed')) !== 'true') await custom.click()
      await expect(custom).toHaveAttribute('aria-pressed', 'true')
      const frame = page.frameLocator('.task-board-frame')
      await expect(frame.locator('walnut-choice[id="water-when"]')).toBeVisible({ timeout: 15_000 })
      const pb = (await pane.boundingBox())!
      expect(pb.width).toBeGreaterThanOrEqual(PHONE.viewport.width - 2)
      await expectNoHorizontalOverflow(page)
      expect(await frame.locator('body').evaluate((b) => getComputedStyle(b).fontSize)).toBe('16px')
      for (const b of await frame.locator('walnut-choice button, walnut-thread button').all()) {
        if (!(await b.isVisible())) continue
        expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44)
      }
      const chat = pane.getByTestId('kanban-show-chat').or(page.getByTestId('kanban-show-chat'))
      await expect(chat.first()).toHaveText('Chat')
      expect((await chat.first().boundingBox())!.height).toBeGreaterThanOrEqual(44)
      await page.screenshot({ path: `${SHOTS}/c77-board-${test.info().project.name}.png` })
      // The thread's reply opens the dock; with the keyboard up it sits on it.
      await frame.locator('walnut-thread[id="garden-talk"] .wn-reply').click()
      const dock = page.getByTestId('board-reply-dock')
      await expect(dock).toBeVisible({ timeout: 10_000 })
      await tallPhone(page)
      await setKeyboardInset(page, 336)
      await expect.poll(async () => { const d = await dock.boundingBox(); return d ? Math.round(d.y + d.height) : 0 }).toBeGreaterThanOrEqual(844 - 336 - 2)
      const d = (await dock.boundingBox())!
      expect(d.y + d.height).toBeLessThanOrEqual(844 - 336 + 2)
      await setKeyboardInset(page, 0)
      // Back closes the Board, the session stays.
      await page.goBack()
      await expect(pane).toHaveCount(0)
      await expect(overlay(page)).toBeVisible()
    } finally {
      await page.request.delete(`/api/v1/tasks/${TASK_ID}/board`).catch(() => undefined)
    }
  })

  test('C19: the Board\'s Cards view in a session takes a finger, reads 12 px, and raises no keyboard', async ({ page }) => {
    const put = await page.request.put(`/api/v1/tasks/${TASK_ID}/board`, { data: { html: BOARD_HTML } })
    expect(put.ok(), await put.text()).toBe(true)
    try { await boardCardsCheck(page) } finally {
      await page.request.delete(`/api/v1/tasks/${TASK_ID}/board`).catch(() => undefined)
    }
  })
})

test('Files is the tree or one file (back returns to the tree); Changed is one column (C78)', async ({ page }) => {
  // A fixture working dir with a file at its root (read-only GETs).
  const dirs = await (await page.request.get('/api/sessions/working-dirs')).json() as { dirs: Array<{ cwd: string }> }
  // Breadth first, two levels down, so the explorer opens on files.
  let cwd: string | undefined
  const queue = dirs.dirs.map((d) => ({ path: d.cwd, depth: 0 }))
  for (let n = 0; n < 40 && queue.length && !cwd; n++) {
    const d = queue.shift()!
    const res = await page.request.get(`/api/files/list?path=${encodeURIComponent(d.path)}`)
    if (!res.ok()) continue
    const list = await res.json() as { path?: string; entries?: Array<{ name: string; type: string }> }
    if (list.entries?.some((e) => e.type === 'file')) { cwd = list.path ?? d.path; break }
    if (d.depth < 2) for (const e of list.entries ?? []) if (e.type === 'dir') queue.push({ path: `${list.path ?? d.path}/${e.name}`, depth: d.depth + 1 })
  }
  // The fixture's project dirs are bare folders: fall back to this checkout's
  // own hooks folder (a local dir with files; only listed and read).
  cwd ??= `${process.cwd()}/web/src/hooks`
  test.info().annotations.push({ type: 'files cwd', description: cwd.startsWith(process.cwd()) ? 'checkout web/src/hooks' : 'fixture dir' })
  await stubSession(page, { history: longTurnHistory(2), cwd })
  await openByDeepLink(page)
  await topbar(page).getByRole('button', { name: 'More actions' }).click()
  await page.getByTestId('phone-row-files').click()
  const body = overlay(page).locator('.session-file-explorer-body')
  await expect(body).toHaveClass(/is-phone-tree/, { timeout: 15_000 })
  const tree = body.locator('.session-file-explorer-tree')
  await expect(tree).toBeVisible()
  expect((await tree.boundingBox())!.width).toBeGreaterThanOrEqual(PHONE.viewport.width - 4)
  await expect(body.locator('.session-file-explorer-preview')).toBeHidden()
  // A file row has the page glyph; the fixture keeps its files in a folder,
  // so open folders until one shows.
  const files = tree.locator('.session-file-explorer-node:not(.sfe-root-header)').filter({ has: page.locator('.sfe-icon', { hasText: '\u{1F4C4}' }) })
  const closedDirs = tree.locator('.session-file-explorer-node:not(.sfe-root-header)').filter({ has: page.locator('.sfe-arrow', { hasText: '\u25B6' }) })
  await expect(tree.locator('.session-file-explorer-node:not(.sfe-root-header)').first()).toBeVisible({ timeout: 15_000 })
  for (let i = 0; i < 4 && (await files.count()) === 0; i++) {
    if ((await closedDirs.count()) === 0) break
    await closedDirs.first().click()
    await expect.poll(async () => (await files.count()) + (await closedDirs.count()), { timeout: 10_000 }).toBeGreaterThan(0)
    await page.waitForTimeout(300)
  }
  const file = files.first()
  await expect(file).toBeVisible({ timeout: 15_000 })
  const name = (await file.locator('.sfe-name').textContent())!.trim()
  await file.click()
  await expect(body).toHaveClass(/is-phone-file/)
  await expect(tree).toBeHidden()
  await expect(topbar(page).locator('.phone-topbar-title-text')).toHaveText(name)
  expect((await historyInfo(page)).marker?.id).toMatch(/^file:/)
  await expectNoHorizontalOverflow(page)
  await page.screenshot({ path: `${SHOTS}/c78-file-${test.info().project.name}.png` })
  await page.goBack()
  await expect(body).toHaveClass(/is-phone-tree/)
  await expect(tree).toBeVisible()
  // Changed: one column, never the side-by-side pair.
  await topbar(page).getByRole('button', { name: 'Back' }).click()
  await expect(overlay(page).locator('.session-file-explorer-body')).toHaveCount(0)
  await topbar(page).getByRole('button', { name: 'More actions' }).click()
  await page.getByTestId('phone-row-changed').click()
  await expect(topbar(page).locator('.phone-topbar-title-text')).toHaveText('Changed')
  await page.waitForTimeout(800)
  await expect(overlay(page).locator('.session-diff-table.is-split')).toHaveCount(0)
  await expect(overlay(page).getByRole('group', { name: 'Diff layout' })).toBeHidden()
  await expectNoHorizontalOverflow(page)
})

test('a reply during a running turn reads Queued; offline and back, it is sent once (C71)', async ({ page }) => {
  await stubSession(page, { history: longTurnHistory(2), status: 'running' })
  const tap = await tapSocket(page, () => ({ ok: true, messageId: 'qm-phone-queued' }), 1500)
  await openByDeepLink(page)
  // The turn is streaming: text keeps arriving while the reply waits.
  const beat = setInterval(() => {
    try { tap.push('session:text-delta', { sessionId: SID, taskId: TASK_ID, delta: 'Still working on the beds. ' }) } catch { /* socket closing */ }
  }, 400)
  try {
    const input = composer(page)
    await input.click()
    await input.fill('after this turn')
    await sendButton(page).click()
    const row = overlay(page).locator('.session-msg-queued, .session-msg-received, .session-msg-delivered', { hasText: 'after this turn' })
    await expect(row.locator('.session-delivery-meta')).toHaveText(/^Sending\.\.\./)
    // In flight: the phone drops off the network, is put away and comes back.
    await page.evaluate(() => {
      const vis = (v: 'hidden' | 'visible') => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => v })
        document.dispatchEvent(new Event('visibilitychange'))
      }
      window.dispatchEvent(new Event('offline'))
      vis('hidden')
      vis('visible')
      window.dispatchEvent(new Event('online'))
    })
    await expect(row.locator('.session-delivery-meta')).toHaveText('Queued: delivered when this turn ends', { timeout: 10_000 })
    await page.waitForTimeout(2500)
    expect(tap.sends.filter((m) => JSON.stringify(m).includes('after this turn'))).toHaveLength(1)
  } finally {
    clearInterval(beat)
  }
})

test('Ask Walnut from the drawer is its own layer: back closes only it (C23)', async ({ page }) => {
  const errors = await boot(page)
  await openDrawer(page)
  await page.locator('.sidebar.open').getByRole('button', { name: 'Ask Walnut' }).click()
  const slot = page.getByTestId('ask-walnut-slot')
  await expect(slot).toBeVisible({ timeout: 15_000 })
  await expect(backButton(page)).toBeVisible()
  await expect(page.locator('.sidebar.open')).toHaveCount(0)
  expect((await historyInfo(page)).marker?.id).toBe('chat')
  await expectNoHorizontalOverflow(page)
  await page.screenshot({ path: `${SHOTS}/c23-ask-walnut-${test.info().project.name}.png` })
  await page.goBack()
  await expect(slot).toBeHidden()
  await expect(menuButton(page)).toBeVisible()
  await expect(page.locator('.todo-search-input')).toBeVisible()
  expect(errors).toEqual([])
})

/**
 * C18 / C19 for this package's surfaces (the session overlay and its bar, the
 * kebab, Files, Changed, Ask Walnut) at the three phone widths: no sideways
 * scroll, every target a finger can hit, no text under 12 px. The lists are
 * written to /tmp/mobile-web/phone-session/sweep-<width>.json as evidence.
 */
for (const vp of [{ width: 390, height: 844 }, { width: 375, height: 667 }, { width: 320, height: 568 }]) {
  test(`${vp.width} x ${vp.height}: the session surfaces fit and take a finger (C18, C19)`, async ({ page }) => {
    await page.setViewportSize(vp)
    await stubSession(page, { history: longTurnHistory(2) })
    await openByDeepLink(page)
    const report: Record<string, { overflow: number; small: unknown[]; text: unknown[] }> = {}
    const check = async (name: string, roots: string[]) => {
      await page.waitForTimeout(400)
      const overflow = await page.evaluate(() => (document.scrollingElement?.scrollWidth ?? 0) - window.innerWidth)
      const small: unknown[] = []
      const text: unknown[] = []
      for (const r of roots) {
        small.push(...await findSmallTargets(page, r))
        text.push(...await findSmallText(page, 12, r))
      }
      report[name] = { overflow: Math.max(0, overflow), small, text }
    }
    const column = '.main-page-session-column.is-mobile-active'
    await check('session overlay', [column, '.phone-topbar'])
    await topbar(page).getByRole('button', { name: 'More actions' }).click()
    await expect(page.locator('.task-kebab-menu')).toBeVisible()
    await check('session kebab', ['.task-kebab-menu'])
    await page.getByTestId('phone-row-files').click()
    await expect(overlay(page).locator('.session-file-explorer-body')).toBeVisible({ timeout: 15_000 })
    await check('files', [column, '.phone-topbar'])
    await backButton(page).click()
    await topbar(page).getByRole('button', { name: 'More actions' }).click()
    await page.getByTestId('phone-row-changed').click()
    await expect(topbar(page).locator('.phone-topbar-title-text')).toHaveText('Changed')
    await check('changed', [column, '.phone-topbar'])
    await backButton(page).click()
    await backButton(page).click()
    await expect(overlay(page)).toHaveCount(0)
    await openDrawer(page)
    await page.locator('.sidebar.open').getByRole('button', { name: 'Ask Walnut' }).click()
    await expect(page.getByTestId('ask-walnut-slot')).toBeVisible({ timeout: 15_000 })
    await check('ask walnut', ['.main-page-chat', '.phone-topbar'])
    mkdirSync(SHOTS, { recursive: true })
    writeFileSync(`${SHOTS}/sweep-${vp.width}-${test.info().project.name}.json`, JSON.stringify(report, null, 2))
    const clean = Object.fromEntries(Object.keys(report).map((k) => [k, { overflow: 0, small: [], text: [] }]))
    expect(report).toEqual(clean)
  })
}

async function boardCardsCheck(page: Page): Promise<void> {
  await stubSession(page, { history: longTurnHistory(2) })
  await openByDeepLink(page)
  await topbar(page).getByRole('button', { name: 'More actions' }).click()
  await page.getByTestId('phone-row-board').click()
  const pane = page.getByTestId('task-board-pane')
  await expect(pane).toBeVisible({ timeout: 15_000 })
  const cards = pane.getByTestId('board-view-cards')
  if (await cards.count()) {
    if ((await cards.getAttribute('aria-pressed')) !== 'true') await cards.click()
  }
  await expect(pane.locator('.kanban-root')).toBeVisible({ timeout: 15_000 })
  await page.waitForTimeout(800)
  // No form opened on its own: the iOS keyboard would cover the board.
  const focused = await page.evaluate(() => {
    const a = document.activeElement as HTMLElement | null
    return a && /^(INPUT|TEXTAREA)$/.test(a.tagName) ? a.getAttribute('data-testid') ?? a.className : null
  })
  expect(focused).toBeNull()
  for (const width of [390, 375, 320]) {
    await page.setViewportSize({ width, height: width === 320 ? 568 : 844 })
    await page.waitForTimeout(300)
    const small = await findSmallTargets(page, '[data-testid="task-board-pane"]')
    expect(small, `${width}: ${JSON.stringify(small)}`).toEqual([])
    const tiny = await findSmallText(page, 12, '[data-testid="task-board-pane"]')
    expect(tiny, `${width}: ${JSON.stringify(tiny)}`).toEqual([])
  }
  await page.screenshot({ path: `${SHOTS}/c19-board-cards-${test.info().project.name}.png` })
}
