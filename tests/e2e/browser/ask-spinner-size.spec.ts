/**
 * The Ask spinners are the size their class says: 12px, a text-line spinner.
 *
 * `.ask-walnut-pending-spinner` sets 12px, but the element also carries the global
 * `.spinner` (32px), and globals.css is imported after the component styles
 * (web/src/main.tsx imports App first), so for single-class vs single-class the
 * global rule won by load order and every one of these drew a 32px ring beside a
 * 13px sentence. The rule is now `.spinner.ask-walnut-pending-spinner`, which
 * wins on specificity whatever the order. Pinned on every surface that uses it:
 *
 *   1. the Ask slot's first-paint view (the board is still loading);
 *   2. the Ask slot's pending view (a New chat launch is in flight);
 *   3. the Ask drawer's "Loading your asks" line;
 *   4. Mail's Ask drawer while its session starts.
 *
 * Each case holds the request that ends the state, so the state is on screen for
 * as long as the test needs. It saves a cropped shot of the surface and the boxes
 * of its neighbours (`ASK_SPINNER_SHOTS`, default /tmp/ask-spinner/run) so a
 * before/after pair shows that only the ring changed.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { openAskWalnutDrawer } from './draft-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'
import { MailFixtureServer, folderRow, openMail } from './mail-review-helpers'

const SHOTS = process.env.ASK_SPINNER_SHOTS ?? '/tmp/ask-spinner/run'

test.setTimeout(240_000)
test.beforeAll(async () => { await fs.mkdir(SHOTS, { recursive: true }) })

/** A promise the test resolves to let a held request through. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void
  const wait = new Promise<void>((resolve) => { open = resolve })
  return { wait, open }
}

/** Hold every `method` request `match` accepts until the gate opens (a minute at most). */
async function hold(page: Page, method: string, match: (url: URL) => boolean, until: Promise<void>): Promise<void> {
  await page.route(match, async (route) => {
    if (route.request().method() !== method) { await route.fallback(); return }
    await Promise.race([until, new Promise((r) => setTimeout(r, 60_000))])
    await route.fallback().catch(() => {})
  })
}

type Box = { x: number; y: number; width: number; height: number } | null

/**
 * Crop the band around the spinner line, and write the spinner's layout size and
 * the boxes of the things around it (the sentence, the container, `others`).
 */
async function record(page: Page, name: string, status: Locator, container: Locator, others: Record<string, Locator>): Promise<{ w: number; h: number }> {
  const spinner = status.locator('.spinner')
  await expect(spinner).toBeVisible()
  const size = await spinner.evaluate((el) => ({ w: (el as HTMLElement).offsetWidth, h: (el as HTMLElement).offsetHeight }))
  const text = await status.evaluate((p) => {
    const node = [...p.childNodes].find((n) => n.nodeType === 3 && n.textContent?.trim())
    if (!node) return null
    const range = document.createRange()
    range.selectNode(node)
    const r = range.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  })
  const boxes: Record<string, Box> = {
    status: await status.boundingBox(), container: await container.boundingBox(), text,
  }
  for (const [key, loc] of Object.entries(others)) boxes[key] = (await loc.count()) ? await loc.first().boundingBox() : null
  const band = boxes.container!
  const line = boxes.status!
  const clip = {
    x: Math.max(0, band.x), width: Math.min(band.width, 1280),
    y: Math.max(0, line.y - 40), height: line.height + 80,
  }
  const project = test.info().project.name
  await page.screenshot({ path: path.join(SHOTS, `${name}-${project}.png`), clip })
  await fs.writeFile(path.join(SHOTS, `${name}-${project}.json`), JSON.stringify({ size, boxes }, null, 1))
  return size
}

test.describe('the Ask slot and drawer', () => {
  test.beforeEach(async ({ page }) => { await isolateUiPrefs(page) })

  test('the slot while the board loads, and the drawer opened then', async ({ page }) => {
    const board = gate()
    await hold(page, 'GET', (u) => u.pathname === '/api/tasks' && u.searchParams.get('fields') === 'list', board.wait)
    await page.goto('/')
    const loadingView = page.getByTestId('ask-walnut-loading')
    await expect(loadingView).toBeVisible({ timeout: 60_000 })
    const slotSize = await record(page, 'slot-loading', loadingView.locator('.ask-walnut-pending-status'), loadingView, {
      menu: loadingView.getByTestId('ask-walnut-menu'),
    })

    await openAskWalnutDrawer(page)
    const line = page.getByTestId('ask-walnut-drawer-loading')
    await expect(line).toBeVisible()
    const drawerSize = await record(page, 'drawer-loading', line, page.getByTestId('ask-walnut-drawer'), {
      search: page.getByTestId('ask-walnut-search'), title: page.locator('.ask-walnut-drawer-title'),
    })
    board.open()
    expect(slotSize).toEqual({ w: 12, h: 12 })
    expect(drawerSize).toEqual({ w: 12, h: 12 })
  })

  test('the slot while a New chat launch is in flight', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 60_000 })
    await openAskWalnutDrawer(page)
    await page.getByTestId('ask-walnut-new').click()
    const composer = page.getByTestId('ask-walnut-draft').locator('.chat-input-textarea')
    await expect(composer).toBeVisible({ timeout: 30_000 })

    const launch = gate()
    await hold(page, 'POST', (u) => u.pathname === '/api/sessions/quick-start', launch.wait)
    const answered = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/sessions/quick-start').catch(() => null)
    await composer.fill(`spinner size probe ${Date.now().toString(36)}`)
    await composer.press('Enter')
    const pending = page.getByTestId('ask-walnut-pending')
    await expect(pending).toBeVisible({ timeout: 30_000 })
    const size = await record(page, 'slot-pending', pending.locator('.ask-walnut-pending-status'), pending, {
      menu: pending.getByTestId('ask-walnut-menu'), echo: pending.locator('.ask-walnut-pending-echo'),
    })
    launch.open()
    await answered
    expect(size).toEqual({ w: 12, h: 12 })
  })
})

test.describe("Mail's Ask drawer", () => {
  const server = new MailFixtureServer()
  let port = 0
  const WRITER = 'fixture:ctx-writer@example.invalid'

  test.beforeAll(async () => {
    test.setTimeout(300_000)
    // The small mailbox (PW_MAIL_DENSE emptied: the helper defaults it on).
    port = (await server.start({ PW_MAIL_CTX: '1', PW_MAIL_DENSE: '' })).port
  })
  test.afterAll(async () => { await server.stop() })

  test('while its session starts', async ({ page }) => {
    await openMail(page, port)
    // A plain folder, not the inbox: the inbox's own layout (groups) is not what
    // this case is about, and any mail opens the same drawer.
    await expect(folderRow(page, WRITER, 'Archive')).toHaveCount(1, { timeout: 90_000 })
    await folderRow(page, WRITER, 'Archive').click()
    const row = page.locator(`.mail-row[data-account-id="${WRITER}"]`).first()
    await expect(row).toBeVisible({ timeout: 90_000 })

    const launch = gate()
    await hold(page, 'POST', (u) => u.pathname === '/api/sessions/quick-start', launch.wait)
    const answered = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/sessions/quick-start').catch(() => null)
    await row.click({ button: 'right' })
    const menu = page.getByTestId('mail-row-ctx-menu')
    await menu.locator('[role="menuitem"]', { hasText: 'Summarize with Walnut' }).first().click()
    const drawer = page.getByTestId('ask-object-drawer')
    await expect(drawer).toHaveAttribute('data-view', 'starting', { timeout: 60_000 })
    const pending = drawer.getByTestId('ask-object-pending')
    const size = await record(page, 'mail-starting', pending.locator('.ask-walnut-pending-status'), pending, {
      head: pending.locator('.ask-object-head'), quote: pending.getByTestId('ask-object-quote'),
      echo: pending.locator('.ask-walnut-pending-echo'),
    })
    launch.open()
    await answered
    expect(size).toEqual({ w: 12, h: 12 })
  })
})
