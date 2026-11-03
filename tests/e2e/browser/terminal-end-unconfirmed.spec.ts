/**
 * "End terminal" never claims an end the server could not confirm. terminal:kill
 * answers `{ killed: false, unconfirmed: true, reason }` when the dtach master was
 * left running (unproved owner, probe without an answer); the UI used to ignore the
 * answer, mark the terminal exited and close it while the shell kept running.
 *
 * Real UI: a local session's Terminal chip opens a real terminal on the fixture
 * server; the fixture (terminal-end-fixture.ts) holds back the next stops of this
 * session, so End shows the notice and keeps the terminal, a second End (header)
 * is still possible, and Try again, now with the real stop, ends and closes it.
 * A slow End whose answer lands after the user moved to Files must not close
 * Files (the panel's onClose toggles from the view it was rendered with).
 *
 * The Mac app is a WKWebView: run with PW_WEBKIT=1 ... --project webkit as well.
 */
import fs from 'node:fs/promises'
import { test, expect, type Locator, type Page } from '@playwright/test'
import { TERMINAL_STATUSES, TERMINAL_STATUS_LABEL, type TerminalStatus } from '../../../web/src/hooks/terminal-status-label'

const SHOTS = '/tmp/end-terminal-unconfirmed'
const sidFor = (browserName: string) => `pw-term-end-${browserName}`

test.setTimeout(150_000)
test.describe.configure({ mode: 'serial' })
test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })

// Playwright's Linux WebKit reports the browser's own ResizeObserver notice (a loop
// that settled on the next frame, harmless by the spec) as a page error; it shows on
// clean HEAD too. Only that exact message is dropped: every other page error still
// fails the test, and the first test proves the collector still records one.
const BENIGN_PAGE_ERROR = /^ResizeObserver loop completed with undelivered notifications\.$/

/** Page errors of this page, the benign ResizeObserver notice left out. */
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
  // The first spec of a run meets a cold dev server that is still compiling the app.
  await expect(panel).toBeVisible({ timeout: 90_000 })
  return panel
}

/** One RPC over a socket of the page's own (the fixture-only arm, and the cleanup). */
async function rpc(page: Page, method: string, payload: unknown): Promise<unknown> {
  return page.evaluate(async ({ method, payload }) => {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${window.location.host}/ws`)
    await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error('ws failed')) })
    const id = `pw-term-end-${Math.random().toString(36).slice(2)}`
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

const RAW_CODE = new RegExp(`\\b(${TERMINAL_STATUSES.filter((c) => c.includes('_')).join('|')})\\b`, 'i')

/** The pill shows the state in words; the code is only its data-status. */
async function expectPill(term: Locator, status: TerminalStatus, timeout?: number): Promise<void> {
  const pill = term.getByTestId('terminal-status')
  await expect(pill).toHaveAttribute('data-status', status, { timeout })
  await expect(pill).toHaveText(TERMINAL_STATUS_LABEL[status])
  expect(await pill.innerText()).not.toMatch(/_/)
  // Nowhere in the header (text, tooltips, screen-reader names) shows a code. The
  // codes with an underscore are matched as whole words anywhere; a one-word code
  // ("ready", "ending") only as a whole title or name, so copy like "Ending" passes.
  const header = term.locator('.session-terminal-header')
  expect(await header.innerText()).not.toMatch(RAW_CODE)
  const names = await header.evaluate((el) =>
    [el, ...el.querySelectorAll('*')].flatMap((e) => ['title', 'aria-label'].map((a) => e.getAttribute(a)).filter((v): v is string => v !== null)))
  for (const name of names) {
    expect(name).not.toMatch(RAW_CODE)
    expect(TERMINAL_STATUSES as readonly string[]).not.toContain(name.trim().toLowerCase())
  }
}

async function openTerminal(page: Page, panel: Locator): Promise<{ chip: Locator; term: Locator }> {
  const chip = panel.locator('[data-header-id="terminal"]')
  await expect(chip).toBeVisible({ timeout: 30_000 })
  await chip.click()
  const term = page.locator('.session-terminal-panel')
  await expect(term).toBeVisible()
  await expectPill(term, 'ready', 60_000)
  await expect(term.getByTestId('terminal-status')).toHaveText('Connected')
  return { chip, term }
}

async function confirmEnd(page: Page): Promise<void> {
  const dialog = page.locator('.app-modal')
  await expect(dialog.locator('.app-modal-title')).toHaveText('End terminal?')
  await dialog.getByRole('button', { name: 'End', exact: true }).click()
}

test.afterEach(async ({ page, browserName }) => {
  // Whatever happened, end the real dtach session this test opened, through the real stop.
  const sid = sidFor(browserName)
  await rpc(page, 'test:terminal-end-unconfirmed', { sessionId: sid, times: 0, delayMs: 0 }).catch(() => {})
  await rpc(page, 'terminal:kill', { terminalId: sid }).catch(() => {})
})

test('an unconfirmed End keeps the terminal with a notice; a second End and Try again work', async ({ page, browserName }) => {
  await fs.mkdir(SHOTS, { recursive: true })
  const sid = sidFor(browserName)
  const errors = collectPageErrors(page)
  const panel = await openColumn(page, sid)

  // The filter swallows nothing else: a real uncaught error is still recorded.
  await page.evaluate(() => { setTimeout(() => { throw new Error('pw-term-end probe error') }, 0) })
  await expect.poll(() => errors.some((e) => e.includes('pw-term-end probe error'))).toBe(true)
  // Drop only the probe's own error; anything the page raised while loading stays.
  errors.splice(0, errors.length, ...errors.filter((e) => !e.includes('pw-term-end probe error')))

  const { chip, term } = await openTerminal(page, panel)

  // The next two stops of this session leave the master as unproved.
  expect(await rpc(page, 'test:terminal-end-unconfirmed', { sessionId: sid, times: 2 })).toEqual({ armed: 2, delayMs: 0 })

  const end = term.locator('.session-terminal-btn-kill')
  await end.click()
  await confirmEnd(page)
  const notice = term.getByTestId('terminal-end-unconfirmed')
  await expect(notice).toBeVisible({ timeout: 30_000 })
  await expect(notice).toContainText('Walnut could not confirm the terminal ended. It may still be running.')
  await expect(notice).toContainText('Reason: the host did not answer in time.')
  await expect(notice).toContainText('Close and reopen the terminal to reattach to it.')
  await expectPill(term, 'end_unconfirmed')
  await expect(term.getByTestId('terminal-status')).toHaveText('End not confirmed')
  await expect(term).toBeVisible() // never closed as if it ended
  await expect(end).toBeEnabled()
  await term.screenshot({ path: `${SHOTS}/notice-${browserName}.png` })
  await notice.screenshot({ path: `${SHOTS}/notice-only-${browserName}.png` })

  // A second End from the header: still held back, still honest.
  await end.click()
  await confirmEnd(page)
  await expectPill(term, 'end_unconfirmed', 30_000)
  await expect(notice).toBeVisible()

  // Try again, now with the real stop: the terminal ends and closes.
  await notice.getByRole('button', { name: 'Try again' }).click()
  await expect(term).toBeHidden({ timeout: 30_000 })
  await expect(chip).not.toHaveClass(/session-action-chip-active/)
  // The server agrees nothing is left to end.
  expect(await rpc(page, 'terminal:kill', { terminalId: sid })).toEqual({ killed: true })
  expect(errors).toEqual([])
})

test('a slow End that answers after the user moved to Files leaves Files open', async ({ page, browserName }) => {
  const sid = sidFor(browserName)
  await fs.mkdir(SHOTS, { recursive: true })
  const errors = collectPageErrors(page)
  const panel = await openColumn(page, sid)
  const { chip, term } = await openTerminal(page, panel)

  // A slow host: the real stop answers killed:true only after 5 s.
  expect(await rpc(page, 'test:terminal-end-unconfirmed', { sessionId: sid, times: 0, delayMs: 5_000 })).toEqual({ armed: 0, delayMs: 5_000 })
  await term.locator('.session-terminal-btn-kill').click()
  await confirmEnd(page)
  await expectPill(term, 'ending')

  const filesChip = panel.locator('[data-header-id="files"]')
  await filesChip.click()
  const files = panel.locator('.session-file-explorer')
  await expect(files).toBeVisible({ timeout: 30_000 })
  await expect(term).toBeHidden()

  // Past the delay and the answer: Files stays, and no terminal view came back.
  await page.waitForTimeout(7_000)
  await expect(files).toBeVisible()
  await expect(filesChip).toHaveClass(/session-action-chip-active/)
  await expect(chip).not.toHaveClass(/session-action-chip-active/)
  await expect(page.locator('.session-terminal-panel')).toHaveCount(0)
  await page.screenshot({ path: `${SHOTS}/files-kept-${browserName}.png`, clip: { x: 0, y: 0, width: 1280, height: 400 } })

  await filesChip.click() // leave the panel as it was
  await expect(files).toBeHidden()
  expect(errors).toEqual([])
})
