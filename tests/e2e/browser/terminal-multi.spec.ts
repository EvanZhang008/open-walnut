/**
 * A session's terminals: several at once, tabs and split panes, the terminal
 * docked under Changed / Files, a selection's "Add to chat", and file paths in
 * the output that open in Files.
 *
 * Real UI on the fixture server, real local shells under dtach (no stubs): each
 * terminal is its own dtach session, so a reload reattaches every one with its
 * output, and `terminal:list` (the host's sockets) brings back a tab the page's
 * storage lost. The Mac app is a WKWebView: run with PW_WEBKIT=1 ... --project
 * webkit as well.
 */
import fs from 'node:fs/promises'
import { test, expect, type Locator, type Page, type WebSocketRoute } from '@playwright/test'
import { PHONE, findSmallTargets } from './phone-helpers'

const SHOTS = process.env.TERMINAL_MULTI_SHOTS ?? '/tmp/terminal-multi'
const sidFor = (browserName: string) => `pw-term-multi-${browserName}`
const keyFor = (sid: string, slot: number) => (slot === 1 ? sid : `${sid}__term${slot}`)

test.setTimeout(240_000)
test.describe.configure({ mode: 'serial' })

// Playwright's Linux WebKit reports the browser's own ResizeObserver notice as a
// page error (it shows on clean HEAD too); only that exact message is dropped.
const BENIGN_PAGE_ERROR = /^ResizeObserver loop completed with undelivered notifications\.$/

function collectPageErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (e) => {
    if (BENIGN_PAGE_ERROR.test(e.message)) return
    errors.push(String(e))
  })
  return errors
}

async function openColumn(page: Page, sid: string): Promise<Locator> {
  await page.addInitScript((id) => {
    try {
      sessionStorage.setItem('open-walnut-home-session-columns', JSON.stringify([{ id, locked: false }]))
    } catch { /* ignore */ }
  }, sid)
  await page.goto('/')
  const panel = page.locator(`.main-page-session-column .session-panel[data-session-id="${sid}"]`)
  await expect(panel).toBeVisible({ timeout: 90_000 })
  return panel
}

/** One RPC over a socket of the page's own. */
async function rpc(page: Page, method: string, payload: unknown): Promise<unknown> {
  return page.evaluate(async ({ method, payload }) => {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${window.location.host}/ws`)
    await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error('ws failed')) })
    const id = `pw-term-multi-${Math.random().toString(36).slice(2)}`
    ws.send(JSON.stringify({ type: 'req', id, method, payload }))
    const answer = await new Promise<unknown>((resolve) => {
      ws.onmessage = (ev) => {
        try {
          const f = JSON.parse(ev.data as string)
          if (f.type === 'res' && f.id === id) resolve(f.ok ? f.payload : { error: f.error })
        } catch { /* not ours */ }
      }
      setTimeout(() => resolve({ error: 'no answer within 30s' }), 30_000)
    })
    ws.close()
    return answer
  }, { method, payload })
}

const pane = (term: Locator, slot: number) => term.locator(`[data-testid="terminal-pane"][data-terminal-slot="${slot}"]`)
const rowsText = (p: Locator) => p.locator('.xterm-rows').innerText()

/** After `clear && echo ...`: the output alone is on screen (the typed command, which holds the same words, is gone). */
async function clearedTo(p: Locator, text: string): Promise<void> {
  await expect.poll(async () => {
    const t = await rowsText(p)
    return t.includes(text) && !t.includes('&& echo')
  }, { timeout: 15_000 }).toBe(true)
}

/** Type a command into a pane's shell (click it first so it has the focus). */
async function run(page: Page, p: Locator, command: string): Promise<void> {
  await p.locator('.xterm-screen').click({ position: { x: 20, y: 10 } })
  await page.keyboard.type(command)
  await page.keyboard.press('Enter')
}

/** The page point of `text` in a pane's visible rows (cell grid from the screen's box). */
async function pointOf(p: Locator, text: string, offset = 0): Promise<{ x: number; y: number }> {
  const at = await p.evaluate((el, { text, offset }) => {
    const rows = Array.from(el.querySelectorAll('.xterm-rows > div'))
    const screen = el.querySelector('.xterm-screen')!.getBoundingClientRect()
    const first = rows[0]?.getBoundingClientRect()
    const rowH = first ? first.height : 17
    // The cell width from a measured row span: the rows' text is monospace.
    const probe = document.createElement('span')
    probe.textContent = 'W'.repeat(50)
    probe.style.visibility = 'hidden'
    rows[0]?.appendChild(probe)
    const cellW = probe.getBoundingClientRect().width / 50
    probe.remove()
    for (let r = rows.length - 1; r >= 0; r--) {
      const t = (rows[r] as HTMLElement).innerText.replace(/ /g, ' ')
      const i = t.indexOf(text)
      if (i >= 0) {
        const box = rows[r]!.getBoundingClientRect()
        return { x: screen.left + (i + offset + 0.5) * cellW, y: box.top + rowH / 2 }
      }
    }
    return null
  }, { text, offset })
  if (!at) throw new Error(`"${text}" is not on screen`)
  return { x: at.x, y: at.y }
}

async function openTerminal(page: Page, panel: Locator): Promise<Locator> {
  const chip = panel.locator('[data-header-id="terminal"]')
  await expect(chip).toBeVisible({ timeout: 30_000 })
  await chip.click()
  const term = page.locator('.session-terminal-panel')
  await expect(term).toBeVisible()
  await expect(term.locator('.session-terminal-header').getByTestId('terminal-status')).toHaveText('Connected', { timeout: 60_000 })
  return term
}

async function endAll(page: Page, sid: string): Promise<void> {
  for (let slot = 1; slot <= 8; slot++) await rpc(page, 'terminal:kill', { terminalId: keyFor(sid, slot) }).catch(() => {})
}

test.afterEach(async ({ page, browserName }) => {
  await endAll(page, sidFor(browserName))
})

test('several terminals: tabs, splits, a reload reattaches each, the host list restores a lost tab', async ({ page, browserName }) => {
  await fs.mkdir(SHOTS, { recursive: true })
  const sid = sidFor(browserName)
  await page.setViewportSize({ width: 1400, height: 860 })
  const errors = collectPageErrors(page)
  const panel = await openColumn(page, sid)
  await endAll(page, sid)
  const term = await openTerminal(page, panel)

  // One terminal: no tab strip, no pane strip.
  await expect(term.getByTestId('terminal-tab')).toHaveCount(0)
  await run(page, pane(term, 1), 'echo one-$((40+2))')
  await expect.poll(() => rowsText(pane(term, 1)), { timeout: 15_000 }).toContain('one-42')

  // A new terminal: a second tab, shown, its own shell. Typed at once, before
  // it even shows: no key is lost, and Enter does not press New again.
  await term.getByTestId('terminal-new').click()
  await page.keyboard.type('echo two-$((1+1))')
  await page.keyboard.press('Enter')
  await expect(term.getByTestId('terminal-tab')).toHaveCount(2)
  await expect(pane(term, 2)).toBeVisible()
  await expect(pane(term, 1)).toBeHidden()
  await expect(term.locator('.session-terminal-header').getByTestId('terminal-status')).toHaveText('Connected', { timeout: 30_000 })
  await expect.poll(() => rowsText(pane(term, 2)), { timeout: 15_000 }).toContain('two-2')
  expect(await rowsText(pane(term, 2))).not.toContain('one-42')

  // Back to the first tab: its output is still there (hidden, never closed).
  await term.getByTestId('terminal-tab').nth(0).getByRole('tab').click()
  await expect(pane(term, 1)).toBeVisible()
  expect(await rowsText(pane(term, 1))).toContain('one-42')

  // Split right: two panes side by side in one tab; split down in the second tab.
  await term.getByTestId('terminal-split-right').click()
  await expect(pane(term, 3)).toBeVisible()
  const [b1, b3] = [await pane(term, 1).boundingBox(), await pane(term, 3).boundingBox()]
  expect(b1 && b3 && b3.x > b1.x + b1.width - 2 && Math.abs(b3.y - b1.y) < 2).toBe(true)
  await expect(pane(term, 3).locator('.session-terminal-pane-strip')).toContainText('Terminal 3')
  await run(page, pane(term, 3), 'echo three')
  await expect.poll(() => rowsText(pane(term, 3)), { timeout: 15_000 }).toContain('three')
  await term.getByTestId('terminal-tab').nth(1).getByRole('tab').click()
  await term.getByTestId('terminal-split-down').click()
  await expect(pane(term, 4)).toBeVisible()
  const [b2, b4] = [await pane(term, 2).boundingBox(), await pane(term, 4).boundingBox()]
  expect(b2 && b4 && b4.y > b2.y + b2.height - 2 && Math.abs(b4.x - b2.x) < 2).toBe(true)
  await term.screenshot({ path: `${SHOTS}/split-${browserName}.png` })

  // The host runs four dtach sessions for this session.
  await expect.poll(async () => ((await rpc(page, 'terminal:list', { sessionId: sid })) as { slots: number[] }).slots).toEqual([1, 2, 3, 4])

  // A reload reattaches every terminal with its output, in the same tabs.
  await page.reload()
  const term2 = page.locator('.session-terminal-panel')
  await expect(term2).toBeVisible({ timeout: 60_000 })
  await expect(term2.getByTestId('terminal-tab')).toHaveCount(2)
  await expect.poll(() => rowsText(pane(term2, 2)), { timeout: 30_000 }).toContain('two-2')
  await expect(pane(term2, 4)).toBeVisible()
  await term2.getByTestId('terminal-tab').nth(0).getByRole('tab').click()
  await expect.poll(() => rowsText(pane(term2, 1)), { timeout: 30_000 }).toContain('one-42')
  await expect.poll(() => rowsText(pane(term2, 3)), { timeout: 30_000 }).toContain('three')

  // The page's storage lost (another device): the host's list brings every terminal back.
  await page.evaluate((s) => localStorage.removeItem(`open-walnut-terminal-layout:${s}`), sid)
  await page.reload()
  const term3 = page.locator('.session-terminal-panel')
  await expect(term3).toBeVisible({ timeout: 60_000 })
  await expect(term3.getByTestId('terminal-tab')).toHaveCount(4)
  for (const slot of [2, 3, 4]) {
    await term3.getByTestId('terminal-tab').nth(slot - 1).getByRole('tab').click()
    await expect(pane(term3, slot)).toBeVisible()
  }
  await expect.poll(() => rowsText(pane(term3, 3)), { timeout: 30_000 }).toContain('three')

  // Closing a tab ends its shell after one confirm; the host stops listing it.
  await term3.getByTestId('terminal-tab').nth(2).locator('.session-terminal-tab-close').click()
  const dialog = page.locator('.app-modal')
  await expect(dialog.locator('.app-modal-title')).toHaveText('End terminal?')
  await dialog.getByRole('button', { name: 'End', exact: true }).click()
  await expect(term3.getByTestId('terminal-tab')).toHaveCount(3, { timeout: 30_000 })
  await expect.poll(async () => ((await rpc(page, 'terminal:list', { sessionId: sid })) as { slots: number[] }).slots, { timeout: 30_000 }).toEqual([1, 2, 4])

  // A terminal closed while it still connects: the End waits for its open and
  // ends the shell that open started, so no shell outlives its closed tab.
  await term3.getByTestId('terminal-new').click()
  await expect(term3.getByTestId('terminal-tab')).toHaveCount(4)
  await term3.getByTestId('terminal-tab').nth(3).locator('.session-terminal-tab-close').click()
  await dialog.getByRole('button', { name: 'End', exact: true }).click()
  await expect(term3.getByTestId('terminal-tab')).toHaveCount(3, { timeout: 30_000 })
  await page.waitForTimeout(1500)
  expect(((await rpc(page, 'terminal:list', { sessionId: sid })) as { slots: number[] }).slots).toEqual([1, 2, 4])
  expect(errors).toEqual([])
})

test('a split splits only the focused pane, keeps every shell; two windows never take the same slot', async ({ page, context, browser, browserName }) => {
  const sid = sidFor(browserName)
  await page.setViewportSize({ width: 1400, height: 860 })
  const errors = collectPageErrors(page)
  const panel = await openColumn(page, sid)
  await endAll(page, sid)
  await page.evaluate((s) => localStorage.removeItem(`open-walnut-terminal-layout:${s}`), sid)
  const term = await openTerminal(page, panel)
  await run(page, pane(term, 1), 'echo left-$((6*7))')
  await expect.poll(() => rowsText(pane(term, 1)), { timeout: 15_000 }).toContain('left-42')
  await pane(term, 1).locator('.xterm').evaluate((el) => { el.setAttribute('data-pw-mark', 'kept') })

  // Split right, then split the right pane down: 1 on the left, full height; 2 over 3 on the right.
  await term.getByTestId('terminal-split-right').click()
  await expect(pane(term, 2)).toBeVisible()
  await expect(term.locator('.session-terminal-header').getByTestId('terminal-status')).toHaveText('Connected', { timeout: 30_000 })
  await term.getByTestId('terminal-split-down').click()
  await expect(pane(term, 3)).toBeVisible()
  const [b1, b2, b3] = [await pane(term, 1).boundingBox(), await pane(term, 2).boundingBox(), await pane(term, 3).boundingBox()]
  expect(b1 && b2 && b3).toBeTruthy()
  expect(Math.abs(b2!.x - (b1!.x + b1!.width))).toBeLessThan(2)
  expect(Math.abs(b3!.x - b2!.x)).toBeLessThan(2)
  expect(Math.abs(b3!.y - (b2!.y + b2!.height))).toBeLessThan(2)
  expect(Math.abs(b1!.height - (b2!.height + b3!.height))).toBeLessThan(2)
  // Half of a half-width pane is too narrow to read: Split right is offered no more there.
  await expect(term.getByTestId('terminal-split-right')).toBeDisabled()
  await expect(term.getByTestId('terminal-split-right')).toHaveAttribute('title', 'Too narrow to split this terminal again')
  // Pane 1 was never remounted: same xterm element, same output.
  await expect(pane(term, 1).locator('.xterm[data-pw-mark="kept"]')).toHaveCount(1)
  expect(await rowsText(pane(term, 1))).toContain('left-42')
  // In a split, the header's End names the pane it ends.
  await expect(term.locator('.session-terminal-btn-kill')).toHaveText('End Terminal 3')
  // Then the left one down: a 2 x 2 grid.
  await pane(term, 1).locator('.xterm-screen').click({ position: { x: 20, y: 10 } })
  await term.getByTestId('terminal-split-down').click()
  await expect(pane(term, 4)).toBeVisible()
  const b4 = await pane(term, 4).boundingBox()
  expect(Math.abs(b4!.x - b1!.x)).toBeLessThan(2)
  expect(Math.abs(b4!.y - b3!.y)).toBeLessThan(3)
  await expect(pane(term, 1).locator('.xterm[data-pw-mark="kept"]')).toHaveCount(1)
  // Four panes is the most a tab holds: the split buttons say so.
  await expect(term.getByTestId('terminal-split-right')).toBeDisabled()
  await expect(term.getByTestId('terminal-split-right')).toHaveAttribute('title', 'At most 4 terminals in a tab')
  await term.screenshot({ path: `${SHOTS}/grid-${browserName}.png` })

  // Another device (a browser with storage of its own) opens the same split:
  // the layout is kept on the server with the other layout prefs.
  await page.waitForTimeout(2500) // the prefs' debounced write
  const device = await browser.newContext({ viewport: { width: 1400, height: 860 } })
  const devPage = await device.newPage()
  const devPanel = await openColumn(devPage, sid)
  const devTerm = await openTerminal(devPage, devPanel)
  await expect(devTerm.getByTestId('terminal-tab')).toHaveCount(0)
  for (const slot of [1, 2, 3, 4]) await expect(pane(devTerm, slot)).toBeVisible()
  await expect.poll(() => rowsText(pane(devTerm, 1)), { timeout: 15_000 }).toContain('left-42')
  await device.close()

  // A second window of the same session (same storage): its new terminal and this
  // one's, asked for at once, get different slots from the server.
  const page2 = await context.newPage()
  await page2.setViewportSize({ width: 1400, height: 860 })
  const errors2 = collectPageErrors(page2)
  await openColumn(page2, sid)
  // The panel's view is kept per session: the second window opens on the Terminal view too.
  const term2 = page2.locator('.session-terminal-panel')
  await expect(term2.locator('.session-terminal-header').getByTestId('terminal-status')).toHaveText('Connected', { timeout: 60_000 })
  await expect(pane(term2, 4)).toBeVisible()
  // Both windows show the same shell: what one types, both see (neither goes quiet).
  await run(page2, pane(term2, 2), 'echo both-$((2+3))')
  await expect.poll(() => rowsText(pane(term2, 2)), { timeout: 15_000 }).toContain('both-5')
  await expect.poll(() => rowsText(pane(term, 2)), { timeout: 15_000 }).toContain('both-5')
  await run(page, pane(term, 2), 'echo back-$((3+4))')
  await expect.poll(() => rowsText(pane(term2, 2)), { timeout: 15_000 }).toContain('back-7')
  await Promise.all([term.getByTestId('terminal-new').click(), term2.getByTestId('terminal-new').click()])
  const shownSlot = async (t: Locator) => {
    await expect(t.getByTestId('terminal-tab')).toHaveCount(2, { timeout: 30_000 })
    return Number(await t.locator('[data-testid="terminal-group"][data-active] [data-testid="terminal-pane"]').getAttribute('data-terminal-slot'))
  }
  const [s1, s2] = [await shownSlot(term), await shownSlot(term2)]
  expect([s1, s2].sort()).toEqual([5, 6])
  await run(page, pane(term, s1), `echo mine-${s1}`)
  await expect.poll(() => rowsText(pane(term, s1)), { timeout: 15_000 }).toContain(`mine-${s1}`)
  expect(await rowsText(pane(term2, s2))).not.toContain(`mine-${s1}`)
  await expect.poll(async () => ((await rpc(page, 'terminal:list', { sessionId: sid })) as { slots: number[] }).slots, { timeout: 30_000 }).toEqual([1, 2, 3, 4, 5, 6])
  // Back in the first window, the other window's new terminal gets a tab too.
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(term.getByTestId('terminal-tab')).toHaveCount(3, { timeout: 15_000 })

  // Arrow keys walk the tabs and keep the focus there (typing does not reach a shell).
  await term.getByTestId('terminal-tab').nth(0).getByRole('tab').focus()
  await page.keyboard.press('Enter')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await expect(term.getByTestId('terminal-tab').nth(2)).toHaveClass(/is-active/)
  expect(await page.evaluate(() => document.activeElement?.getAttribute('role'))).toBe('tab')
  await page.keyboard.press('Home')
  await expect(term.getByTestId('terminal-tab').nth(0)).toHaveClass(/is-active/)

  // Ended in the other window: this one says so, and offers no End for it.
  await term2.locator('.session-terminal-btn-kill').click()
  await page2.locator('.app-modal').getByRole('button', { name: 'End', exact: true }).click()
  // Its tab goes (one tab left: no strip).
  await expect(pane(term2, s2)).toHaveCount(0, { timeout: 30_000 })
  await expect(term2.getByTestId('terminal-tab')).toHaveCount(0)
  await term.getByTestId('terminal-tab').nth(2).getByRole('tab').click()
  await expect(pane(term, s2).locator('.session-terminal-inline-note')).toContainText('Ended in another window.', { timeout: 15_000 })
  await expect(term.locator('.session-terminal-btn-kill')).toHaveCount(0)
  await page2.close()
  expect(errors).toEqual([])
  expect(errors2).toEqual([])
})

test('the terminal docked under Changed and Files; a path opens in Files; a selection goes into the chat', async ({ page, browserName }) => {
  await fs.mkdir(SHOTS, { recursive: true })
  const sid = sidFor(browserName)
  await page.setViewportSize({ width: 1400, height: 860 })
  const errors = collectPageErrors(page)
  const panel = await openColumn(page, sid)
  await endAll(page, sid)
  await page.evaluate((s) => localStorage.removeItem(`open-walnut-terminal-layout:${s}`), sid)
  const term = await openTerminal(page, panel)
  const p1 = pane(term, 1)

  // A file to point at, written by the shell itself.
  await run(page, p1, "mkdir -p pwdemo && seq 1 40 | sed 's/^/line /' > pwdemo/app.ts && clear && echo 'see pwdemo/app.ts:27 for it'")
  await clearedTo(p1, 'see pwdemo/app.ts:27 for it')
  // Mark the xterm element: the same element after the dock means no remount.
  await p1.locator('.xterm').evaluate((el) => { el.setAttribute('data-pw-mark', 'kept') })

  // Selection -> "Add to chat": a drag over the words, the button beside it.
  const from = await pointOf(p1, 'see pwdemo')
  const to = await pointOf(p1, 'for it', 6)
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 6 })
  await page.mouse.up()
  const pop = p1.getByTestId('terminal-add-to-chat-pop')
  await expect(pop).toBeVisible()
  const popStyle = await pop.evaluate((el) => { const cs = getComputedStyle(el); return { border: cs.borderTopWidth, bg: cs.backgroundColor, shadow: cs.boxShadow } })
  expect(popStyle.border).not.toBe('0px')
  expect(popStyle.bg).not.toMatch(/rgba\(0, 0, 0, 0\)|transparent/)
  expect(popStyle.shadow).not.toBe('none')
  await term.screenshot({ path: `${SHOTS}/add-to-chat-${browserName}.png` })
  await pop.getByRole('button', { name: 'Add to chat' }).click()
  await expect(pop).toBeHidden()
  const composer = panel.locator('.chat-input-textarea').first()
  await expect.poll(() => composer.inputValue()).toContain('From Terminal 1:\n```text\nsee pwdemo/app.ts:27 for it\n```')
  // A second block goes after the first, nothing sent.
  await page.mouse.dblclick(from.x, from.y)
  await expect(pop).toBeVisible()
  await pop.getByRole('button', { name: 'Add to chat' }).click()
  await expect.poll(() => composer.inputValue()).toMatch(/for it\n```\n\nFrom Terminal 1:\n```text\nsee\n```/)
  await composer.fill('')

  // The same range selected again after Escape cleared it: the button comes back.
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 6 })
  await page.mouse.up()
  await expect(pop).toBeVisible()
  // The drag gave the terminal the focus, so the Escape goes to it (not to the view, which it would close).
  await expect(p1.locator('.xterm-helper-textarea')).toBeFocused()
  // Escape clears the selection only: it never reaches the shell (readline would eat the next key).
  await page.keyboard.press('Escape')
  await expect(pop).toBeHidden()
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 6 })
  await page.mouse.up()
  await expect(pop).toBeVisible()
  await page.mouse.click(from.x, from.y + 40)
  await expect(pop).toBeHidden()

  // Scrolled out of view, Add to chat goes with the selection; scrolled back, it comes back beside it.
  await run(page, p1, "clear && seq 1 300 && printf 'pick %s\\n' this-line")
  await expect.poll(() => rowsText(p1), { timeout: 15_000 }).toContain('pick this-line')
  const pick = await pointOf(p1, 'pick this-line')
  await page.mouse.dblclick(pick.x, pick.y)
  await expect(pop).toBeVisible()
  await page.mouse.wheel(0, -3000)
  await expect(pop).toBeHidden()
  await page.mouse.wheel(0, 6000)
  await expect(pop).toBeVisible()
  const pb = (await pop.boundingBox())!
  expect(Math.abs(pb.y - pick.y)).toBeLessThan(60)
  await page.keyboard.press('Escape')
  await expect(pop).toBeHidden()

  // A path no host has: a note in the terminal, the view stays.
  await run(page, p1, "clear && echo 'missing nosuch/gone.ts:9'")
  await clearedTo(p1, 'missing nosuch/gone.ts:9')
  const gone = await pointOf(p1, 'nosuch/gone.ts', 2)
  await page.mouse.move(gone.x, gone.y + 60)
  await page.mouse.move(gone.x, gone.y, { steps: 4 })
  await expect(p1.locator('.xterm-cursor-pointer')).not.toHaveCount(0, { timeout: 10_000 })
  await page.mouse.click(gone.x, gone.y)
  await expect(term.getByTestId('terminal-path-notice')).toContainText("Couldn't find nosuch/gone.ts on ")
  await expect(panel.locator('.session-file-explorer')).toHaveCount(0)
  await term.getByTestId('terminal-path-notice').getByRole('button', { name: 'Dismiss' }).click()
  await expect(term.getByTestId('terminal-path-notice')).toHaveCount(0)

  /** Click the link on `text` (coming onto its row from another, so xterm asks for its links). */
  const clickLink = async (text: string, offset = 2) => {
    const at = await pointOf(p1, text, offset)
    await page.mouse.move(at.x, at.y + 60)
    await page.mouse.move(at.x, at.y, { steps: 4 })
    await expect(p1.locator('.xterm-cursor-pointer')).not.toHaveCount(0, { timeout: 10_000 })
    await page.mouse.click(at.x, at.y)
  }
  const files = panel.locator('.session-file-explorer')

  // After a cd, a relative path opens from where the shell is, not the session's directory.
  await run(page, p1, "mkdir -p pwdemo/sub && printf 'SUBFILE line 1\\nSUBFILE line 2\\nSUBFILE line 3\\n' > pwdemo/sub/app.ts && cd pwdemo/sub && clear && echo 'here app.ts:3'")
  await clearedTo(p1, 'here app.ts:3')
  await clickLink('app.ts:3')
  await expect(files.getByText('SUBFILE line 3', { exact: true }).first()).toBeVisible({ timeout: 30_000 })

  // A quoted name with a space is one link.
  await run(page, p1, "cd ../.. && printf 'space line 1\\nspace line 2\\n' > 'pwdemo/with space.ts' && clear && echo '\"pwdemo/with space.ts\":2'")
  await clearedTo(p1, '"pwdemo/with space.ts":2')
  await clickLink('with space.ts')
  await expect(files.getByText('space line 2', { exact: true }).first()).toBeVisible({ timeout: 30_000 })

  // An absolute path with a `..` part (folded), and one printed as $HOME/... (the home folder).
  await run(page, p1, "clear && echo \"$PWD/pwdemo/sub/../app.ts:30\"")
  await clearedTo(p1, '/pwdemo/sub/../app.ts:30')
  await clickLink('sub/../app.ts', 4)
  await expect(files.getByText('line 30', { exact: true }).first()).toBeVisible({ timeout: 30_000 })
  // $HOME/x:150 in a file longer than the view: the home file opens at that line (the host spells it absolute).
  await run(page, p1, `seq 1 200 | sed 's/^/home /' > "$HOME/pw-home-${browserName}.ts" && clear && echo '$HOME/pw-home-${browserName}.ts:150'`)
  await clearedTo(p1, `$HOME/pw-home-${browserName}.ts:150`)
  await clickLink(`pw-home-${browserName}.ts`, 4)
  await expect(files.locator('.cm-activeLine')).toHaveText('home 150', { timeout: 30_000 })
  await run(page, p1, "clear && echo 'see pwdemo/app.ts:27 for it'")
  await clearedTo(p1, 'see pwdemo/app.ts:27 for it')

  // A path in the output: click it, Files opens at that line, the terminal docked under it.
  const link = await pointOf(p1, 'pwdemo/app.ts:27', 3)
  // xterm asks for a row's links when the pointer comes onto that row (it keeps
  // the answer while the pointer stays there), so come onto it from another row.
  await page.mouse.move(link.x, link.y + 60)
  await page.mouse.move(link.x, link.y, { steps: 4 })
  // A hovered link gets the pointer cursor once the provider answered.
  await expect(p1.locator('.xterm-cursor-pointer')).not.toHaveCount(0, { timeout: 10_000 })
  await page.mouse.click(link.x, link.y)
  await expect(files).toBeVisible({ timeout: 30_000 })
  await expect(files).toContainText('app.ts')
  // The file itself shows, around the line the output named.
  await expect(files.getByText('line 27', { exact: true }).first()).toBeVisible({ timeout: 30_000 })
  const dock = panel.getByTestId('terminal-dock-frame')
  await expect(dock).toHaveClass(/is-docked/)
  await expect(pane(term, 1).locator('.xterm[data-pw-mark="kept"]')).toHaveCount(1)
  // Files is above the terminal, both on screen.
  const [fb, db] = [await files.boundingBox(), await dock.boundingBox()]
  expect(fb && db && fb.y < db.y && fb.height > 100 && db.height >= 120).toBe(true)
  await page.screenshot({ path: `${SHOTS}/files-with-terminal-${browserName}.png`, clip: { x: 0, y: 0, width: 1280, height: 860 } })

  // Changed keeps the dock; its bar's Terminal toggle hides and shows it.
  await panel.locator('[data-header-id="changed"]').click()
  await expect(dock).toHaveClass(/is-docked/)
  const toggle = panel.getByTestId('terminal-dock-toggle')
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await toggle.click()
  await expect(panel.getByTestId('terminal-dock-frame')).toHaveCount(0)
  await toggle.click()
  await expect(panel.getByTestId('terminal-dock-frame')).toHaveClass(/is-docked/)
  await expect.poll(() => rowsText(pane(term, 1)), { timeout: 30_000 }).toContain('see pwdemo/app.ts:27')

  // Drag the handle: the dock grows by the drag and keeps it across a reload.
  const handle = panel.getByTestId('terminal-dock-resize')
  const before = (await panel.getByTestId('terminal-dock-frame').boundingBox())!.height
  const hb = (await handle.boundingBox())!
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2)
  await page.mouse.down()
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2 - 120, { steps: 8 })
  await page.mouse.up()
  const after = (await panel.getByTestId('terminal-dock-frame').boundingBox())!.height
  expect(Math.round(after - before)).toBeGreaterThanOrEqual(110)
  await page.reload()
  const dock2 = page.getByTestId('terminal-dock-frame')
  await expect(dock2).toHaveClass(/is-docked/, { timeout: 60_000 })
  expect(Math.abs((await dock2.boundingBox())!.height - after)).toBeLessThan(3)

  // "Terminal only", then "Show with Changed" puts it back under Changed.
  await page.getByTestId('terminal-maximize').click()
  await expect(page.getByTestId('terminal-dock-frame')).toHaveClass(/is-full/)
  await page.getByTestId('terminal-dock').click()
  await expect(page.getByTestId('terminal-dock-frame')).toHaveClass(/is-docked/)
  await expect(page.locator('.session-panel [data-header-id="changed"]')).toHaveClass(/session-action-chip-active/)
  // Hide from the dock's own header.
  await page.getByTestId('terminal-undock').click()
  await expect(page.getByTestId('terminal-dock-frame')).toHaveCount(0)
  expect(errors).toEqual([])
})

test('stacked panes docked under Changed keep readable rows; New at the slot limit says why', async ({ page, browserName }) => {
  // Every socket the page opens, so the test can drop them (a real reconnect, no reload).
  const sockets: WebSocketRoute[] = []
  await page.routeWebSocket('**/ws', (ws) => { sockets.push(ws); ws.connectToServer() })
  const sid = sidFor(browserName)
  await page.setViewportSize({ width: 1400, height: 900 })
  const errors = collectPageErrors(page)
  const panel = await openColumn(page, sid)
  await endAll(page, sid)
  await page.evaluate((s) => localStorage.removeItem(`open-walnut-terminal-layout:${s}`), sid)
  const term = await openTerminal(page, panel)
  // Split down twice: 1 over (2 over 3), the halves of halves.
  await term.getByTestId('terminal-split-down').click()
  await expect(pane(term, 2)).toBeVisible()
  await term.getByTestId('terminal-split-down').click()
  await expect(pane(term, 3)).toBeVisible()
  const [h1, h2] = [(await pane(term, 1).boundingBox())!.height, (await pane(term, 2).boundingBox())!.height]
  expect(Math.abs(h1 - 2 * h2)).toBeLessThan(4) // pane 1 kept its half
  await term.getByTestId('terminal-dock').click()
  const dock = panel.getByTestId('terminal-dock-frame')
  await expect(dock).toHaveClass(/is-docked/)
  // The dock grew past its 300 px default so the smallest pane still shows a few rows.
  await expect.poll(async () => (await dock.boundingBox())!.height, { timeout: 10_000 }).toBeGreaterThan(400)
  for (const slot of [2, 3]) expect((await pane(term, slot).boundingBox())!.height).toBeGreaterThanOrEqual(95)
  await page.screenshot({ path: `${SHOTS}/dock-stacked-${browserName}.png`, clip: { x: 0, y: 0, width: 1280, height: 900 } })

  // Every slot taken by another window: New says so instead of doing nothing.
  for (let slot = 4; slot <= 8; slot++) {
    await rpc(page, 'terminal:open', { sessionId: sid, cols: 80, rows: 24, slot })
  }
  await term.getByTestId('terminal-new').click()
  await expect(term.getByTestId('terminal-path-notice')).toContainText('Every terminal slot is in use (8)')
  // And the terminals that window opened get their tabs here.
  await expect(term.getByTestId('terminal-tab')).toHaveCount(6, { timeout: 15_000 })

  // Ended by a tool that does not show it (no window): said plainly, not "in another window".
  await rpc(page, 'terminal:kill', { terminalId: keyFor(sid, 3) })
  await expect(pane(term, 3).locator('.session-terminal-inline-note')).toContainText('This terminal was ended.', { timeout: 15_000 })
  // Its own exit: the shell's note, and none of dtach's own words.
  await run(page, pane(term, 2), 'exit')
  await expect(pane(term, 2).locator('.session-terminal-inline-note')).toContainText('The shell exited.', { timeout: 15_000 })
  expect(await rowsText(pane(term, 2))).not.toContain('dtach')
  // The connection drops and comes back: an ended terminal stays ended (only Restart starts a shell).
  const opened = sockets.length
  for (const ws of sockets) await ws.close({ code: 1012, reason: 'test disconnect' })
  await expect.poll(() => sockets.length, { timeout: 30_000 }).toBeGreaterThan(opened)
  await expect(pane(term, 1).locator('.xterm-rows')).toBeVisible()
  await page.waitForTimeout(3_000)
  await expect(pane(term, 2).locator('.session-terminal-inline-note')).toContainText('The shell exited.')
  await expect(pane(term, 3).locator('.session-terminal-inline-note')).toContainText('This terminal was ended.')
  expect(errors).toEqual([])
})

test.describe('phone', () => {
  test.use({
    viewport: PHONE.viewport,
    screen: PHONE.screen,
    deviceScaleFactor: PHONE.deviceScaleFactor,
    isMobile: true,
    hasTouch: true,
    userAgent: PHONE.userAgent,
  })

  test('the phone switches between terminals, one at a time, 44 px targets', async ({ page, browserName }) => {
    await fs.mkdir(SHOTS, { recursive: true })
    const sid = sidFor(browserName)
    const errors = collectPageErrors(page)
    await page.goto(`/?s1=${sid}`)
    const overlay = page.locator(`.main-page-session-column.is-mobile-active .session-panel[data-session-id="${sid}"]`)
    await expect(overlay).toBeVisible({ timeout: 90_000 })
    await endAll(page, sid)
    await page.evaluate((s) => localStorage.removeItem(`open-walnut-terminal-layout:${s}`), sid)
    await page.locator('.phone-topbar').getByRole('button', { name: 'More actions' }).click()
    await page.getByTestId('phone-row-terminal').click()
    const term = overlay.locator('.session-terminal-panel')
    await expect(term.locator('.session-terminal-header').getByTestId('terminal-status')).toHaveText('Connected', { timeout: 60_000 })
    // No split on a phone.
    await expect(term.getByTestId('terminal-split-right')).toHaveCount(0)
    // A short End: the folder name keeps the narrow header's room.
    await expect(term.locator('.session-terminal-btn-kill')).toHaveText('End')
    const labelW = await term.locator('.session-terminal-header .session-terminal-label').evaluate((el) => el.getBoundingClientRect().width)
    expect(labelW).toBeGreaterThan(40)
    // A path tapped in the terminal opens the file as a layer under the top bar (with a Back), never a sheet over it.
    const p1 = pane(term, 1)
    await run(page, p1, "mkdir -p pwphone && seq 1 60 | sed 's/^/phone /' > pwphone/a.ts && clear && echo 'at pwphone/a.ts:40'")
    await clearedTo(p1, 'at pwphone/a.ts:40')
    const at = await pointOf(p1, 'pwphone/a.ts:40', 3)
    await page.mouse.move(at.x, at.y + 60)
    await page.mouse.move(at.x, at.y, { steps: 4 })
    await expect(p1.locator('.xterm-cursor-pointer')).not.toHaveCount(0, { timeout: 10_000 })
    await page.mouse.click(at.x, at.y)
    const files = overlay.locator('.session-file-explorer')
    await expect(files.locator('.cm-activeLine')).toHaveText('phone 40', { timeout: 30_000 })
    // Back peels the layers in order: the file, then its folder, then the view.
    await page.locator('.phone-topbar').getByRole('button', { name: 'Back' }).tap()
    await expect(files.locator('.cm-activeLine')).toHaveCount(0)
    await expect(page.locator('.phone-topbar')).toContainText('Files')
    await page.locator('.phone-topbar').getByRole('button', { name: 'Back' }).tap()
    await expect(files).toHaveCount(0)
    // The terminal kept running: opened again, it is the same shell.
    await page.locator('.phone-topbar').getByRole('button', { name: 'More actions' }).click()
    await page.getByTestId('phone-row-terminal').click()
    await expect(term.locator('.session-terminal-header').getByTestId('terminal-status')).toHaveText('Connected', { timeout: 30_000 })
    await expect.poll(() => rowsText(pane(term, 1)), { timeout: 15_000 }).toContain('at pwphone/a.ts:40')
    await term.getByTestId('terminal-new').tap()
    await expect(term.getByTestId('terminal-tab')).toHaveCount(2)
    await expect(pane(term, 2)).toBeVisible()
    await expect(term.locator('.session-terminal-header').getByTestId('terminal-status')).toHaveText('Connected', { timeout: 30_000 })
    await term.getByTestId('terminal-tab').nth(0).getByRole('tab').tap()
    await expect(pane(term, 1)).toBeVisible()
    await expect(pane(term, 2)).toBeHidden()
    const small = (await findSmallTargets(page, '.session-terminal-panel')).filter((t) => /session-terminal-(icon-btn|tab-btn|tab-close|btn)/.test(t.tag))
    expect(small).toEqual([])
    // Many tabs: the strip scrolls and the shown tab is always in view.
    for (let i = 0; i < 4; i++) {
      await term.getByTestId('terminal-new').tap()
      await expect(term.getByTestId('terminal-tab')).toHaveCount(3 + i, { timeout: 30_000 })
    }
    const inView = await term.locator('.session-terminal-tabs').evaluate((strip) => {
      const tab = strip.querySelector('.session-terminal-tab.is-active')!.getBoundingClientRect()
      const box = strip.getBoundingClientRect()
      return { scrolls: strip.scrollWidth > strip.clientWidth, inside: tab.left >= box.left - 1 && tab.right <= box.right + 1 }
    })
    expect(inView).toEqual({ scrolls: true, inside: true })
    await page.screenshot({ path: `${SHOTS}/phone-${browserName}.png` })
    expect(errors).toEqual([])
  })
})
