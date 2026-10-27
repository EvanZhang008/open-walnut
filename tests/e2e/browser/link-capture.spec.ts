import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs/promises'
import net from 'node:net'
import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test'
import { showCustomBoard } from './board-view-helpers'

/**
 * Plugin link handlers (`walnut.ui.link`, web/src/plugins/link-handlers.ts and
 * LinkCaptureHost.tsx), as a user meets them.
 *
 * The fixture (link-capture-server.ts) links a plugin that opens
 * `https://*.chat.example.com/archives/*` in its own App, except a workspace it is not
 * signed into (its `accepts` says no) and one channel it cannot read (its `open`
 * returns false). One task carries those links in its description, its session's
 * messages and its Board.
 *
 * What it pins, in every surface: a plain click on a handled link opens the plugin's
 * App on that message (or the thread, for a reply) and never a browser tab; a link the
 * plugin refuses or declines, and a link nobody handles, opens in the default browser;
 * a modifier click goes to the browser; a right-click on a handled link shows Walnut's
 * menu (Open in Team Chat / Open in default browser / Copy link) and not the message's
 * own menu, each row works, and a link nobody handles keeps the browser's menu; the
 * Board frame forwards its clicks and right-clicks the same way.
 */

interface Fixture {
  port: number
  taskId: string
  sessionId: string
  links: { permalink: string; reply: string; unknownWorkspace: string; declined: string; plain: string }
}

const SHOTS = process.env.LINK_CAPTURE_SHOTS ?? '/tmp/link-capture'
const APP_PATH = '/apps/link-capture-fixture~main'
let fixture: Fixture
let child: ChildProcessWithoutNullStreams | null = null

test.setTimeout(240_000)
test.describe.configure({ mode: 'serial' })
test.use({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1 })

async function reservePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Could not reserve a fixture port')
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return address.port
}

test.beforeAll(async () => {
  test.setTimeout(240_000)
  await fs.mkdir(SHOTS, { recursive: true })
  const port = await reservePort()
  let output = ''
  child = spawn('./node_modules/.bin/tsx', ['tests/e2e/browser/link-capture-server.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, PW_LINK_CAPTURE_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => { output = `${output}${String(chunk)}`.slice(-20_000) })
  child.stderr.on('data', (chunk) => { output = `${output}${String(chunk)}`.slice(-20_000) })
  fixture = await new Promise<Fixture>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`Link capture fixture did not start\n${output.slice(-8000)}`)), 180_000)
    const timer = setInterval(() => {
      const match = /LINK_CAPTURE_READY (\{.*\})/.exec(output)
      if (match) { clearInterval(timer); clearTimeout(deadline); resolve(JSON.parse(match[1]!) as Fixture) }
      else if (child?.exitCode !== null) { clearInterval(timer); clearTimeout(deadline); reject(new Error(`Fixture exited\n${output.slice(-8000)}`)) }
    }, 200)
  })
})

test.afterAll(async () => {
  if (!child || child.exitCode !== null) return
  const exited = new Promise<void>((resolve) => child!.once('exit', () => resolve()))
  child.kill('SIGTERM')
  const graceful = await Promise.race([exited.then(() => true), new Promise<false>((r) => setTimeout(() => r(false), 20_000))])
  if (!graceful) child.kill('SIGKILL')
})

const base = () => `http://127.0.0.1:${fixture.port}`

/** Every outside site lands on a stub, and every window it opens is recorded. */
async function prepare(page: Page): Promise<{ errors: string[]; tabs: () => string[] }> {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const context = page.context()
  await context.route(/^https:\/\/[^/]*example\.(com|org)\//, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<p>stub</p>' }))
  const opened: string[] = []
  context.on('page', (tab) => {
    // A new tab starts on about:blank before it navigates to the link.
    void tab.waitForURL((url) => url.href !== 'about:blank', { timeout: 15_000 }).catch(() => undefined)
      .then(() => { opened.push(tab.url()); void tab.close() })
  })
  await page.addInitScript(() => {
    try {
      localStorage.setItem('open-walnut-home-chat-visible', '0')
      sessionStorage.removeItem('open-walnut-home-session-columns')
    } catch { /* storage off */ }
    // Copy link goes through navigator.clipboard (no desktop bridge here): keep what it wrote.
    const w = window as unknown as { __copied: string[] }
    w.__copied = []
    try {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async (text: string) => { w.__copied.push(text) }, readText: async () => w.__copied.at(-1) ?? '' },
      })
    } catch { /* keep the real one */ }
  })
  await page.goto(`${base()}/`)
  await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 60_000 })
  // The plugin's web module has loaded once its App is in the Sidebar.
  await expect(page.locator(`a[href="${APP_PATH}"]`).first()).toBeAttached({ timeout: 60_000 })
  return { errors, tabs: () => [...opened] }
}

async function openDetails(page: Page): Promise<Locator> {
  const row = page.locator(`.todo-panel-item[data-task-id="${fixture.taskId}"]:visible`).first()
  await expect(async () => {
    await page.locator('.todo-search-input').fill('Link capture fixture')
    await expect(row).toBeVisible({ timeout: 5_000 })
  }).toPass({ timeout: 40_000 })
  await row.getByRole('button', { name: 'More actions' }).click()
  await page.locator('.task-kebab-menu:visible').getByText('Details', { exact: true }).click()
  const modal = page.locator('.task-detail-modal')
  await expect(modal).toBeVisible()
  return modal
}

async function openColumn(page: Page): Promise<Locator> {
  const modal = await openDetails(page)
  await modal.locator(`.todo-detail-session-item[data-session-id="${fixture.sessionId}"]`).click()
  const col = page.locator(`.main-page-session-column[data-column-id="${fixture.sessionId}"]`)
  await expect(col).toBeVisible({ timeout: 30_000 })
  await page.keyboard.press('Escape')
  await expect(page.locator('.task-detail-modal')).toHaveCount(0)
  await expect(col.getByText('link capture answer').first()).toBeVisible({ timeout: 30_000 })
  return col
}

/** The plugin's App is showing this link, opened this way. */
async function expectOpenedInPlugin(page: Page, href: string, via: 'click' | 'menu'): Promise<void> {
  const app = page.getByTestId('link-fixture-app')
  await expect(app).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('link-fixture-href')).toHaveText(href)
  await expect(page.getByTestId('link-fixture-via')).toHaveText(via)
  // Nothing the link was in (a modal, a full-screen panel) is left on top of the App.
  expect(await page.getByTestId('link-fixture-href').evaluate((el) => {
    const box = el.getBoundingClientRect()
    return el.contains(document.elementFromPoint(box.left + 4, box.top + box.height / 2))
  })).toBe(true)
  const at = new URL(await here(page))
  expect(at.pathname).toBe(APP_PATH)
  expect(at.searchParams.get('link')).toBe(href)
}

async function backHome(page: Page): Promise<void> {
  await page.goBack()
  await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 30_000 })
  // Back returns to the screen the link was on, the task details included (the
  // address carries the open task); put them away for the next step.
  const modal = page.locator('.task-detail-modal')
  if (await modal.count()) {
    await page.keyboard.press('Escape')
    await expect(modal).toHaveCount(0)
  }
}

/** The SPA's own address (Playwright's page.url() can trail a pushState). */
const here = (page: Page) => page.evaluate(() => window.location.href)

const linkMenu = (page: Page) => page.getByTestId('link-ctx-menu')

test('a handled link opens in its plugin from a task and a session; the rest go to the browser', async ({ page }) => {
  const { errors, tabs } = await prepare(page)
  const { links } = fixture

  // ── Task details: the description's permalink opens the plugin on that message ──
  let modal = await openDetails(page)
  await modal.getByRole('link', { name: 'the permalink' }).click()
  await expectOpenedInPlugin(page, links.permalink, 'click')
  await expect(page.getByTestId('link-fixture-channel')).toHaveText('C09N75FP9GR')
  await expect(page.getByTestId('link-fixture-ts')).toHaveText('1791925699018009')
  await expect(page.getByTestId('link-fixture-thread')).toHaveText('')
  // The modal the link was in closed: it does not sit on top of the App.
  await expect(page.locator('.task-detail-modal')).toHaveCount(0)
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-1-plugin-from-task.png` })
  await backHome(page)

  // ── Session messages: the reply opens the thread; the bare URL and the user's own message too ──
  const col = await openColumn(page)
  const answer = col.locator('.session-msg-content', { hasText: 'link capture answer' }).last()
  for (let round = 0; round < 3; round++) {
    // Several rounds: the second click after a trip to the App must work like the first.
    await answer.getByRole('link', { name: 'the thread reply' }).click()
    await expectOpenedInPlugin(page, links.reply, 'click')
    await expect(page.getByTestId('link-fixture-thread')).toHaveText('1791925699.018009')
    await backHome(page)
  }
  await col.locator(`a[href="${links.reply}"]`).filter({ hasText: links.reply }).first().click()
  await expectOpenedInPlugin(page, links.reply, 'click')
  await backHome(page)
  // The keyboard: Enter on a focused link is the same click.
  await answer.getByRole('link', { name: 'the permalink' }).focus()
  await page.keyboard.press('Enter')
  await expectOpenedInPlugin(page, links.permalink, 'click')
  await backHome(page)
  await col.locator(`a[href="${links.permalink}"]`).filter({ hasText: links.permalink }).first().click()
  await expectOpenedInPlugin(page, links.permalink, 'click')
  await backHome(page)

  // ── Not the plugin's: another workspace, a declined channel, another site → the default browser ──
  for (const [name, href] of [['unknown workspace', links.unknownWorkspace], ['declined channel', links.declined], ['plain site', links.plain]] as const) {
    const before = tabs().length
    await answer.getByRole('link', { name }).click()
    await expect.poll(() => tabs().slice(before), { timeout: 15_000 }).toEqual([href])
    expect(new URL(await here(page)).pathname).toBe('/')
  }

  // ── A modifier click is the user asking for the browser ──
  const before = tabs().length
  await answer.getByRole('link', { name: 'the permalink' }).click({ modifiers: ['ControlOrMeta'] })
  await expect.poll(() => tabs().slice(before), { timeout: 15_000 }).toEqual([links.permalink])
  expect(new URL(await here(page)).pathname).toBe('/')
  await expect(page.getByTestId('link-fixture-app')).toHaveCount(0)
  expect(errors).toEqual([])
})

test('a right-click on a handled link offers the plugin, the browser and Copy link', async ({ page }) => {
  const { errors, tabs } = await prepare(page)
  const { links } = fixture
  const col = await openColumn(page)
  const answer = col.locator('.session-msg-content', { hasText: 'link capture answer' }).last()
  const permalink = answer.getByRole('link', { name: 'the permalink' })

  await permalink.click({ button: 'right' })
  const menu = linkMenu(page)
  await expect(menu).toBeVisible()
  await expect(menu.getByRole('menuitem')).toHaveText(['Open in Team Chat', 'Open in default browser', 'Copy link'])
  // Walnut's link menu, not the message's own row menu.
  await expect(page.getByTestId('session-msg-ctx-menu')).toHaveCount(0)
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-2-link-menu.png` })
  // Escape closes it and leaves everything where it was.
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)

  // Open in default browser
  let before = tabs().length
  await permalink.click({ button: 'right' })
  await menu.getByRole('menuitem', { name: 'Open in default browser' }).click()
  await expect.poll(() => tabs().slice(before), { timeout: 15_000 }).toEqual([links.permalink])
  await expect(menu).toHaveCount(0)
  expect(new URL(await here(page)).pathname).toBe('/')

  // Copy link
  await permalink.click({ button: 'right' })
  await menu.getByRole('menuitem', { name: 'Copy link' }).click()
  await expect.poll(() => page.evaluate(() => (window as unknown as { __copied: string[] }).__copied)).toEqual([links.permalink])

  // A link nobody handles keeps the browser's own menu: no Walnut link menu.
  await answer.getByRole('link', { name: 'plain site' }).click({ button: 'right' })
  await expect(menu).toHaveCount(0)
  await page.keyboard.press('Escape')

  // Open in Team Chat
  before = tabs().length
  await permalink.click({ button: 'right' })
  await menu.getByRole('menuitem', { name: 'Open in Team Chat' }).click()
  await expectOpenedInPlugin(page, links.permalink, 'menu')
  expect(tabs().slice(before)).toEqual([])
  expect(errors).toEqual([])
})

test('the Board frame forwards its link clicks and right-clicks to the same handlers', async ({ page }) => {
  const { errors, tabs } = await prepare(page)
  const { links } = fixture
  const html = `<h2>Links</h2><p><a class="perm" href="${links.permalink}">board permalink</a></p>`
    + `<p><a class="plain" href="${links.plain}">board plain</a></p>`
  const put = await fetch(`${base()}/api/v1/tasks/${fixture.taskId}/board`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ html }),
  })
  expect(put.status, await put.text()).toBe(200)

  const openBoard = async () => {
    const col = await openColumn(page)
    const chip = col.getByTestId('session-board-chip')
    await expect(chip).toBeVisible({ timeout: 15_000 })
    if (!/session-action-chip-active/.test((await chip.getAttribute('class')) ?? '')) await chip.click()
    const pane = page.getByTestId('task-board-pane')
    await showCustomBoard(pane)
    const frame = page.frameLocator('.task-board-frame')
    await expect(frame.locator('a.perm')).toBeVisible({ timeout: 15_000 })
    return frame
  }

  let frame = await openBoard()
  await frame.locator('a.perm').click()
  await expectOpenedInPlugin(page, links.permalink, 'click')
  await backHome(page)

  frame = await openBoard()
  // A script on the board cannot open a link: a synthetic click does nothing.
  let before = tabs().length
  await frame.locator('a.perm').evaluate((a) => (a as HTMLAnchorElement).click())
  await page.waitForTimeout(500)
  expect(new URL(await here(page)).pathname).toBe('/')
  expect(tabs().slice(before)).toEqual([])
  before = tabs().length
  await frame.locator('a.plain').click()
  await expect.poll(() => tabs().slice(before), { timeout: 15_000 }).toEqual([links.plain])
  before = tabs().length
  await frame.locator('a.perm').click({ modifiers: ['ControlOrMeta'] })
  await expect.poll(() => tabs().slice(before), { timeout: 15_000 }).toEqual([links.permalink])
  expect(new URL(await here(page)).pathname).toBe('/')

  // Right-click in the frame: the console's menu, at the link.
  const link = frame.locator('a.perm')
  await link.click({ button: 'right' })
  const menu = linkMenu(page)
  await expect(menu).toBeVisible()
  await expect(menu.getByRole('menuitem')).toHaveText(['Open in Team Chat', 'Open in default browser', 'Copy link'])
  const linkBox = (await page.locator('.task-board-frame').boundingBox())!
  const menuBox = (await menu.boundingBox())!
  expect(menuBox.x).toBeGreaterThanOrEqual(linkBox.x - 1)
  expect(menuBox.y).toBeGreaterThanOrEqual(linkBox.y - 1)
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-3-board-menu.png` })
  await menu.getByRole('menuitem', { name: 'Copy link' }).click()
  await expect.poll(() => page.evaluate(() => (window as unknown as { __copied: string[] }).__copied)).toEqual([links.permalink])

  // A link nobody handles gets the menu without the plugin row.
  await frame.locator('a.plain').click({ button: 'right' })
  await expect(menu.getByRole('menuitem')).toHaveText(['Open in default browser', 'Copy link'])
  await page.keyboard.press('Escape')

  await link.click({ button: 'right' })
  await menu.getByRole('menuitem', { name: 'Open in Team Chat' }).click()
  await expectOpenedInPlugin(page, links.permalink, 'menu')
  expect(errors).toEqual([])
})

test('the notes editor opens a handled link in its plugin, once', async ({ page }) => {
  const { errors, tabs } = await prepare(page)
  const { links } = fixture
  await page.locator('a[href="/notes"]').first().click()
  await page.locator('.notes-tree-file', { hasText: 'Chat links' }).first().click()
  const editor = page.locator('.ProseMirror').first()
  await expect(editor.getByRole('link', { name: 'the thread reply' })).toBeVisible({ timeout: 30_000 })
  const before = tabs().length
  await editor.getByRole('link', { name: 'the thread reply' }).click()
  await expectOpenedInPlugin(page, links.reply, 'click')
  await expect(page.getByTestId('link-fixture-thread')).toHaveText('1791925699.018009')
  await page.goBack()
  await expect(editor.getByRole('link', { name: 'the permalink' })).toBeVisible({ timeout: 30_000 })
  // A modifier click in the editor goes to the browser, as everywhere else.
  await editor.getByRole('link', { name: 'the permalink' }).click({ modifiers: ['ControlOrMeta'] })
  await expect.poll(() => tabs().slice(before), { timeout: 15_000 }).toEqual([links.permalink])
  expect(new URL(await here(page)).pathname).toMatch(/^\/notes/)
  await editor.getByRole('link', { name: 'plain site' }).click()
  await expect.poll(() => tabs().slice(before), { timeout: 15_000 }).toEqual([links.permalink, links.plain])
  // The editor took the click; the page's own capture did not open it a second time.
  await page.waitForTimeout(500)
  expect(tabs().slice(before)).toEqual([links.permalink, links.plain])
  expect(errors).toEqual([])
})

test.describe('phone layout', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

  test('a link in the task details opens the plugin, and closing the details does not undo it', async ({ page }) => {
    const { errors, tabs } = await prepare(page)
    const { links } = fixture
    // A phone opens on the chat layer; its Back leads to the board.
    const back = page.locator('.phone-topbar').getByRole('button', { name: 'Back' })
    if (await back.isVisible().catch(() => false)) await back.click()
    const row = page.getByRole('button', { name: /Link capture fixture task/ }).first()
    await expect(row).toBeVisible({ timeout: 40_000 })
    await row.getByRole('button', { name: 'More actions' }).click()
    await page.locator('.task-kebab-menu:visible').getByText('Details', { exact: true }).click()
    const modal = page.locator('.task-detail-modal')
    await expect(modal).toBeVisible()
    await modal.getByRole('link', { name: 'the permalink' }).click()
    await expectOpenedInPlugin(page, links.permalink, 'click')
    await expect(modal).toHaveCount(0)
    // The details' history back has landed; the App is still the page.
    await page.waitForTimeout(800)
    expect(new URL(await here(page)).pathname).toBe(APP_PATH)
    await expect(page.getByTestId('link-fixture-app')).toBeVisible()
    await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-4-phone-plugin.png` })
    expect(tabs()).toEqual([])
    expect(errors).toEqual([])
  })
})
