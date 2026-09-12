/**
 * The home page's panel layout survives a relaunch.
 *
 * The chat spot (Ask Walnut slot), the Todo panel and the Agenda panel each have
 * an open/hidden toggle. Their state used to live in sessionStorage, which the Mac
 * app's WKWebView drops on every relaunch and on every page-process recycle, so a
 * user who had closed the chat got it back on the next launch, every time. The
 * state is now a localStorage layout preference, like the dock and the section
 * folds.
 *
 * "Relaunch" here is a NEW browser context seeded with the old context's
 * `storageState()`: Playwright's storage state carries cookies + localStorage and
 * NOT sessionStorage, which is exactly what a recreated WKWebView sees. A plain
 * `page.reload()` would keep sessionStorage and could not tell the two apart.
 *
 * ui-prefs is isolated per context (`isolateUiPrefs`): these keys are mirrored to
 * the SHARED fixture server, and a hidden chat left there would break every later
 * spec that waits for the slot. The mirror's own round trip is covered elsewhere;
 * the relaunch path under test is the localStorage read, which the mirror only
 * supplements when the browser has nothing of its own.
 *
 * Real UI only: the × on the slot's panel, the sidebar toggles, the Focus Dock
 * button and the toolbar "+" are the entry points a user has.
 */
import fs from 'node:fs/promises'
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { DRAFT_PANEL, openDraft } from './draft-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'

const SCREENSHOT_DIR = process.env.HOME_PANEL_SHOT_DIR ?? '/tmp/home-panel-visibility'

const CHAT_KEY = 'open-walnut-home-chat-visible'
const TODO_KEY = 'open-walnut-home-todo-visible'
const CALENDAR_KEY = 'open-walnut-home-calendar-visible'

test.setTimeout(120_000)

test.beforeAll(async () => {
  await fs.mkdir(SCREENSHOT_DIR, { recursive: true })
})

test.beforeEach(async ({ page }) => {
  await isolateUiPrefs(page)
  // The Focus Dock is opt-in; its Chat button is one of the toggles under test.
  await page.addInitScript(() => { localStorage.setItem('open-walnut-focus-dock-visible', 'true') })
})

/** Contexts opened by `relaunch`, closed here so a failing test does not leak them
 *  (the built-in fixtures only know about the original context). */
const spawned: BrowserContext[] = []
test.afterEach(async () => {
  await Promise.all(spawned.splice(0).map((context) => context.close().catch(() => {})))
})

// ── Locators ─────────────────────────────────────────────────────────────────

const slot = (page: Page) => page.locator('[data-testid="ask-walnut-slot"]')
/** The slot body that carries a × on load: the session panel when the fixture has
 *  Ask Walnut tasks, the New composer when it has none (its × hides the slot too
 *  when there is no conversation to go back to; see AskWalnutSlot's closeDraft). */
const slotPanel = (page: Page) => page.locator('[data-testid="ask-walnut-session"], [data-testid="ask-walnut-draft"]').first()
const sidebarChat = (page: Page) => page.locator('.sidebar-panel-toggle', { hasText: 'Chat' })
const sidebarTodo = (page: Page) => page.locator('.sidebar-panel-toggle', { hasText: 'Todo' })
const sidebarAgenda = (page: Page) => page.locator('[data-testid="sidebar-toggle-calendar"]')
const dockChat = (page: Page) => page.locator('.dock-chat-item')
const todoColumn = (page: Page) => page.locator('.main-page-todo')
const agendaPanel = (page: Page) => page.locator('[data-testid="cal-side-panel"]')

/** Width of the chat spot; 0 when hidden (flex 0 0 0px) or unmounted. */
async function chatSpotWidth(page: Page): Promise<number> {
  const chat = page.locator('.main-page-chat')
  if ((await chat.count()) === 0) return 0
  return (await chat.first().boundingBox())?.width ?? 0
}

async function expectChatHidden(page: Page): Promise<void> {
  await expect.poll(() => chatSpotWidth(page), { timeout: 15_000, message: 'chat spot still open' }).toBeLessThanOrEqual(1)
  // Hidden means UNMOUNTED, not a zero-width live panel.
  await expect(slot(page)).toHaveCount(0)
  await expect(sidebarChat(page)).not.toHaveClass(/active/)
  await expect(dockChat(page)).not.toHaveClass(/dock-chat-active/)
}

async function expectChatOpen(page: Page): Promise<void> {
  await expect.poll(() => chatSpotWidth(page), { timeout: 15_000, message: 'chat spot never opened' }).toBeGreaterThan(1)
  await expect(slot(page)).toBeVisible({ timeout: 30_000 })
  await expect(sidebarChat(page)).toHaveClass(/active/)
  await expect(dockChat(page)).toHaveClass(/dock-chat-active/)
}

const stored = (page: Page, key: string) => page.evaluate((k) => localStorage.getItem(k), key)

/** Boot the SPA on the home page. Not `loadHome`: that helper waits for the Todo
 *  panel, which one scenario below deliberately leaves hidden across a relaunch. */
async function boot(page: Page): Promise<void> {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await expect(page.locator('.main-page')).toBeVisible({ timeout: 30_000 })
  await expect(sidebarChat(page)).toBeVisible({ timeout: 30_000 })
}

/**
 * Relaunch: snapshot the context's storage state (localStorage, no sessionStorage),
 * close it, and boot the app in a brand-new context seeded with that snapshot.
 */
async function relaunch(browser: Browser, page: Page): Promise<Page> {
  const storageState = await page.context().storageState()
  await page.context().close()
  const { baseURL, viewport } = test.info().project.use
  const context = await browser.newContext({ storageState, baseURL, viewport })
  spawned.push(context)
  const next = await context.newPage()
  await isolateUiPrefs(next)
  await boot(next)
  // The construction guarantee this spec rests on: nothing per-tab came along.
  expect(await next.evaluate(() => sessionStorage.getItem('open-walnut-home-chat-visible'))).toBeNull()
  return next
}

// ── Scenarios ────────────────────────────────────────────────────────────────

test('a chat closed with its × stays closed after a relaunch, and reopened stays open', async ({ browser, page }) => {
  await boot(page)
  await expectChatOpen(page)
  expect(await stored(page, CHAT_KEY)).not.toBe('false')

  // Close it the way a user does: the × on the slot's panel (session or New state).
  await expect(slotPanel(page)).toBeVisible({ timeout: 60_000 })
  await slotPanel(page).locator('.session-panel-close').click()
  await expectChatHidden(page)
  await expect.poll(() => stored(page, CHAT_KEY)).toBe('false')
  await page.screenshot({ path: `${SCREENSHOT_DIR}/1-chat-closed.png` })

  // Relaunch #1: still closed.
  let next = await relaunch(browser, page)
  await expectChatHidden(next)
  expect(await stored(next, CHAT_KEY)).toBe('false')
  await next.screenshot({ path: `${SCREENSHOT_DIR}/2-chat-closed-after-relaunch.png` })

  // Reopen from the sidebar, then relaunch #2: open.
  await sidebarChat(next).click()
  await expectChatOpen(next)
  await expect.poll(() => stored(next, CHAT_KEY)).toBe('true')
  next = await relaunch(browser, next)
  await expectChatOpen(next)
  await next.screenshot({ path: `${SCREENSHOT_DIR}/3-chat-open-after-relaunch.png` })

  // Repeat: two toggles in a row, the LAST state is what a relaunch restores.
  await dockChat(next).click()
  await expectChatHidden(next)
  await dockChat(next).click()
  await expectChatOpen(next)
  await dockChat(next).click()
  await expectChatHidden(next)
  next = await relaunch(browser, next)
  await expectChatHidden(next)

  // Leave the context as it started.
  await sidebarChat(next).click()
  await expectChatOpen(next)
  await next.context().close()
})

test('a draft borrowing the chat spot does not persist as "chat closed"', async ({ browser, page }) => {
  await boot(page)
  await expectChatOpen(page)

  // "+" opens a draft column that takes the chat's place for the draft's lifetime.
  await openDraft(page)
  await expect(page.locator(DRAFT_PANEL)).toHaveCount(1, { timeout: 20_000 })
  await expect.poll(() => chatSpotWidth(page), { timeout: 15_000 }).toBeLessThanOrEqual(1)
  // The stored PREFERENCE is still open: the borrow is transient. (No key at all
  // is the untouched default, which is also "open".)
  expect(await stored(page, CHAT_KEY)).not.toBe('false')

  // Drafts do not survive a relaunch, so the chat must come back on its own.
  const next = await relaunch(browser, page)
  await expect(next.locator(DRAFT_PANEL)).toHaveCount(0)
  await expectChatOpen(next)
  await next.screenshot({ path: `${SCREENSHOT_DIR}/4-borrow-not-persisted.png` })
  await next.context().close()
})

test('the Todo and Agenda toggles survive a relaunch too', async ({ browser, page }) => {
  await boot(page)
  await expect(todoColumn(page)).not.toHaveClass(/collapsed/)
  await expect(agendaPanel(page)).toHaveCount(0)

  await sidebarTodo(page).click()
  await expect(todoColumn(page)).toHaveClass(/collapsed/)
  await sidebarAgenda(page).click()
  await expect(agendaPanel(page)).toBeVisible({ timeout: 15_000 })
  await expect.poll(() => stored(page, TODO_KEY)).toBe('false')
  await expect.poll(() => stored(page, CALENDAR_KEY)).toBe('true')

  let next = await relaunch(browser, page)
  await expect(todoColumn(next)).toHaveClass(/collapsed/)
  await expect(sidebarTodo(next)).not.toHaveClass(/active/)
  await expect(agendaPanel(next)).toBeVisible({ timeout: 15_000 })
  await expect(sidebarAgenda(next)).toHaveClass(/active/)
  await next.screenshot({ path: `${SCREENSHOT_DIR}/5-todo-hidden-agenda-open-after-relaunch.png` })

  // Back to the defaults, and a relaunch keeps THOSE.
  await sidebarTodo(next).click()
  await expect(todoColumn(next)).not.toHaveClass(/collapsed/)
  await sidebarAgenda(next).click()
  await expect(agendaPanel(next)).toHaveCount(0)
  next = await relaunch(browser, next)
  await expect(todoColumn(next)).not.toHaveClass(/collapsed/)
  await expect(agendaPanel(next)).toHaveCount(0)
  await next.context().close()
})

test.describe('at phone width', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('a Todo hidden elsewhere gives its height to the chat instead of an invisible band', async ({ page }) => {
    // The state arrives from another device through the mirror; here it is seeded
    // straight into localStorage, which is what the boot merge produces.
    await page.addInitScript(([key]) => { localStorage.setItem(key, 'false') }, [TODO_KEY])
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await expect(page.locator('.main-page')).toBeVisible({ timeout: 30_000 })

    const todo = todoColumn(page)
    await expect(todo).toHaveClass(/collapsed/)
    // The desktop collapse only zeroes the width, which the phone layout overrides;
    // a 40%-tall opacity:0 band used to sit above the chat, swallowing taps.
    await expect.poll(async () => (await todo.boundingBox())?.height ?? 0, { timeout: 10_000 }).toBeLessThanOrEqual(1)
    await expect(slot(page)).toBeVisible({ timeout: 30_000 })
    const slotBox = (await slot(page).boundingBox())!
    expect(slotBox.height, 'the chat slot should take the freed height').toBeGreaterThan(400)
    await page.screenshot({ path: `${SCREENSHOT_DIR}/6-phone-todo-hidden.png` })
  })
})
