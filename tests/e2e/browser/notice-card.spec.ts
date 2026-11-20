/**
 * Every notice is one card in one place (web/src/components/common/NoticeCard.tsx, in the corner
 * stack at the bottom left): 2026-11-20, the user, of the quick bar's "Delivered" card: "把所有的
 * notification 都设计成这种", "整个 system 就那么一个 notification system", and of a coloured bar down
 * one side: "那个好丑". Notices of the kinds he sees every day, with the words his own Walnut sent
 * (an error that needs him, a permission ask, a plugin reminder, the quick bar's receipt), are
 * raised the way the server raises them (a `notification:new` frame on the socket) and checked:
 *   - each is a NoticeCard in the stack at the bottom left beside the rail, frosted glass, the same
 *     hairline on all four sides, a 14px radius, an avatar, a bold title and a status dot;
 *   - several stack upward, newest nearest the corner, and an error keeps its place in sight
 *     while plain news folds onto the "N more" card;
 *   - an error stays at least 15 s, never the 6 s it had;
 *   - a click on an ask's words opens the session it came from.
 * NOTICE_SHOTS=<dir> saves a screenshot per step; PROOF_VIDEO_DIR=<dir> records the proof video.
 */
import { expect, test, type Page, type Route } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { captureWs, injectEvent } from './ws-capture-helpers'
import { startProofVideo } from './proof-video'
import { isolateUiPrefs } from './todo-panel-helpers'
import { pinFlag } from './quick-bar-helpers'

const SHOTS = process.env.NOTICE_SHOTS || ''
/** NOTICE_BEFORE=1: the same steps on a build before this change, for its screenshots only. */
const BEFORE = process.env.NOTICE_BEFORE === '1'
const SESSION_ID = 'pw-vscode-session'
const TASK_ID = 'pw-task-vscode'
const NONCE = Date.now().toString(36)

// NOTICE_SCHEME=light runs the first test in the light theme (the user's Mac app).
test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: process.env.NOTICE_SCHEME === 'light' ? 'light' : 'dark' })
test.describe.configure({ mode: 'serial', timeout: 180_000 })

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return
  await fs.mkdir(SHOTS, { recursive: true })
  // Once the cards' entrances settled (a breathing status dot runs for ever, so it is left out).
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity), null, { timeout: 5_000 }).catch(() => {})
  await page.screenshot({ path: path.join(SHOTS, `${BEFORE ? 'before' : 'after'}-${name}.png`) })
}

/** The records as his Walnut wrote them (feed of 2026-11-20), each with its own key for this run. */
const DISK = {
  kind: 'operation-error', severity: 'error', audience: 'user', needsYou: 'disk-full', category: 'Data & Sync',
  recoveryKey: 'health:disk.free', title: 'Disk space low',
  body: 'Free space on the disk that holds Walnut\'s data. Walnut frees what it can rebuild first. 3 of 3 periods crossed < 30 GB Walnut tried: ran the task-directory sweep: 0 directories removed, 0.0 GB freed',
  dedupKey: `error:health:disk.free-${NONCE}`, timestamp: Date.now(),
}
const ASK = {
  kind: 'permission', severity: 'warning', title: 'mcp__walnut__mail_read', body: 'Needs permission approval',
  dedupKey: `perm:req-notice-${NONCE}`, requestId: `req-notice-${NONCE}`, toolName: 'mcp__walnut__mail_read',
  input: { id: 'mail-1' }, sessionId: SESSION_ID, taskId: TASK_ID, sessionTitle: 'Editor fixture session',
  host: 'clouddev', project: 'Walnut', timestamp: Date.now(),
}
const REMINDER = {
  kind: 'reminder', severity: 'info', title: 'Break over. Start the next block?', body: 'Rhythm stays off until you start one.',
  dedupKey: `reminder:rhythm-${NONCE}`, timestamp: Date.now(),
}

async function stubQuick(page: Page): Promise<void> {
  await page.route('**/api/stt/status', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ engine: null, available: false }) }))
  await page.route('**/api/v1/quick/people**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ people: [
    { id: 'pw-vp-walnut', title: 'Walnut VP', kind: 'vp', project: 'Walnut', state: 'waiting', stateLabel: 'Waiting', line: 'Notices, one system', needs: 1 },
  ] }) }))
  await page.route('**/api/v1/quick/send', async (r: Route) => {
    const lines = [
      { type: 'sent', taskId: 'pw-vp-walnut', sessionId: 's-1', started: false, messageId: 'm-1' },
      { type: 'delivered' },
      { type: 'text', delta: 'On it. ' },
      { type: 'result', text: 'On it: every notice is one card now, at the bottom left.' },
    ]
    // Delivered, then the reply a moment later, as a real turn comes back.
    await r.fulfill({ status: 200, contentType: 'application/x-ndjson', body: lines.map((l) => JSON.stringify(l)).join('\n') + '\n' })
  })
}

const stack = (page: Page) => page.locator('[data-testid="corner-stack"]')

/** The frame every card in the stack shares, read from the page. */
async function frames(page: Page) {
  return page.locator('[data-testid="corner-stack"] .wn-notice').evaluateAll((els) => els.map((el) => {
    const s = getComputedStyle(el)
    return {
      cls: el.className,
      sides: [s.borderTopWidth, s.borderRightWidth, s.borderBottomWidth, s.borderLeftWidth],
      colours: [s.borderTopColor, s.borderLeftColor],
      radius: s.borderTopLeftRadius,
      blur: s.backdropFilter || (s as unknown as { webkitBackdropFilter?: string }).webkitBackdropFilter || '',
    }
  }))
}

test('the notices he sees every day are one card at the bottom left; a click on an ask opens its session', async ({ page }) => {
  // The switch in this page only (quick-bar-helpers.ts pinFlag): the shared server's stays as it is.
  await pinFlag(page, true)
  await isolateUiPrefs(page)
  await captureWs(page)
  await stubQuick(page)
  await page.route('**/api/quiet*', (r) => r.fulfill({ json: { quiet: false } }))
  await page.route(`**/api/sessions/${SESSION_ID}/permission`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }))
  const video = await startProofVideo(page)
  await page.goto('/')
  await expect(page.locator('.main-page')).toBeVisible({ timeout: 90_000 })

  await video.caption('An error that needs you arrives')
  await injectEvent(page, 'notification:new', DISK)
  const disk = stack(page).locator('.notification-toast', { hasText: 'Disk space low' })
  await expect(disk).toBeVisible({ timeout: 10_000 })
  await page.mouse.move(700, 450)
  await video.hold(1_500)
  await shot(page, '1-error')

  await video.caption('A permission ask comes in under it, nearest the corner')
  await injectEvent(page, 'notification:new', ASK)
  const ask = stack(page).locator('.nfc-perm-toast', { hasText: 'mcp__walnut__mail_read' })
  await expect(ask).toBeVisible({ timeout: 10_000 })
  await video.hold(1_500)
  await shot(page, '2-ask')

  await video.caption('A reminder: the error keeps its place, the reminder waits on the "1 more" card')
  await injectEvent(page, 'notification:new', REMINDER)
  // Two toasts fit beside an ask: the error stays in sight, the newer plain notice folds.
  if (!BEFORE) await expect(stack(page).getByTestId('notification-toaster-more')).toBeVisible({ timeout: 10_000 })
  else await page.waitForTimeout(1_000)
  await video.hold(1_500)
  await shot(page, '3-three')

  if (!BEFORE) {
    // One card for all of them: the hairline on all four sides, the radius, frosted glass.
    const f = await frames(page)
    expect(f.length).toBeGreaterThanOrEqual(2)
    for (const card of f) {
      expect(new Set(card.sides), `${card.cls}: one hairline all round`).toEqual(new Set(['1px']))
      expect(card.colours[0], `${card.cls}: no side of another colour`).toBe(card.colours[1])
      expect(card.radius, card.cls).toBe('14px')
      expect(card.blur, `${card.cls}: frosted glass`).toMatch(/blur\(\d+px\)/)
    }
    // Who it is from and its status, as the quick bar's card has them.
    await expect(ask.locator('.wn-notice-who')).toHaveText('Editor fixture session')
    await expect(ask.locator('.wn-notice-status')).toHaveText('Needs you')
    // The place: the bottom left, 16px right of the rail and above the window's bottom.
    const place = await page.evaluate(() => {
      const r = document.querySelector('[data-testid="corner-stack"]')!.getBoundingClientRect()
      const rail = document.querySelector('.app-shell > .sidebar')!.getBoundingClientRect()
      return { fromRail: Math.round(r.left - rail.right), bottomGap: Math.round(window.innerHeight - r.bottom) }
    })
    expect(place.fromRail).toBe(16)
    expect(place.bottomGap).toBeGreaterThanOrEqual(16)
    // Newest nearest the corner: the ask sits under the older error.
    await expect(disk).toBeVisible()
    const order = await stack(page).locator('.notification-toast').evaluateAll((els) => els.map((e) => [e.textContent ?? '', e.getBoundingClientRect().top] as const))
    const top = (t: string) => order.find(([text]) => text.includes(t))?.[1] ?? -1
    expect(top('mail_read')).toBeGreaterThan(top('Disk space low'))

    // The error stays 15 s at least (its kind's own 6 s is too short to read it).
    // About 12 s after it came: past the old 6 s, before its 15 s.
    await page.waitForTimeout(7_000)
    await expect(stack(page).getByText('Disk space low')).toBeAttached()
  }

  await video.caption('The quick bar: its receipt is the same card, in the same corner')
  await page.keyboard.press('Control+Alt+Meta+Space')
  const box = page.getByRole('textbox', { name: 'Message' })
  await expect(box).toBeVisible({ timeout: 15_000 })
  await box.fill('to Walnut VP, ship the notices')
  await box.press('Enter')
  const receipt = page.locator('.qb-receipt').first()
  await expect(receipt).toBeVisible({ timeout: 15_000 })
  await video.hold(2_000)
  await shot(page, '4-receipt')
  if (!BEFORE) {
    await expect(stack(page).locator('.qb-receipt')).toHaveCount(1)
    await expect(receipt.locator('.wn-notice-who')).toHaveText('Walnut VP')
  }

  if (!BEFORE) {
    // A click on what it asks, under its head (a question form's words, the gaps between its
    // choices), stays: it is answered there (review 2026-11-20: a picked answer was lost).
    await ask.locator('.wn-notice-body').getByText('Needs permission approval').click()
    await page.waitForTimeout(500)
    await expect(ask).toBeVisible()
    await expect(page.locator(`.main-page-session-column .session-panel[data-session-id="${SESSION_ID}"]`)).toHaveCount(0)
  }

  await video.caption('A click on the ask\'s words opens the session it came from')
  const words = ask.locator('.notification-toast-title')
  await words.hover()
  await video.hold(800)
  await words.click()
  await expect(page.locator(`.main-page-session-column .session-panel[data-session-id="${SESSION_ID}"]`)).toBeVisible({ timeout: 20_000 })
  await video.hold(2_000)
  await shot(page, '5-opened')

  if (!BEFORE) {
    // ...and leaves by itself after its 15 s (raised about 20 s ago by now).
    await expect(stack(page).getByText('Disk space low')).toHaveCount(0, { timeout: 15_000 })
  }
  await video.stop(`notice-card${BEFORE ? '-before' : ''}`)
})

test('in the light theme the card reads the same', async ({ page }) => {
  await pinFlag(page, true)
  await page.emulateMedia({ colorScheme: 'light' })
  await isolateUiPrefs(page)
  await captureWs(page)
  await stubQuick(page)
  await page.route('**/api/quiet*', (r) => r.fulfill({ json: { quiet: false } }))
  await page.goto('/')
  await expect(page.locator('.main-page')).toBeVisible({ timeout: 90_000 })
  await injectEvent(page, 'notification:new', { ...DISK, dedupKey: `${DISK.dedupKey}-light` })
  await injectEvent(page, 'notification:new', { ...ASK, dedupKey: `${ASK.dedupKey}-light`, requestId: `${ASK.requestId}-light` })
  await expect(stack(page).locator('.nfc-perm-toast')).toBeVisible({ timeout: 10_000 })
  await page.mouse.move(700, 450)
  await page.waitForTimeout(400)
  await shot(page, '6-light')
  if (!BEFORE) {
    for (const card of await frames(page)) {
      expect(new Set(card.sides)).toEqual(new Set(['1px']))
      // A dark hairline in the light theme: a white one vanished on a white page (2026-11-20).
      expect(card.colours[0], `${card.cls}: an edge that shows on white`).toMatch(/^rgba\(0, 0, 0, 0\.\d+\)$/)
    }
  }
  // The quick bar takes the same edge in the light theme.
  await page.keyboard.press('Control+Alt+Meta+Space')
  await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible({ timeout: 15_000 })
  await page.waitForTimeout(400)
  await shot(page, '7-light-bar')
})
