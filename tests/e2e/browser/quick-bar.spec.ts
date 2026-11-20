/**
 * The quick bar (experiment `quick_bar`; web/src/components/quickbar/), in Chromium:
 *   - off, Control-Option-Command-Space does nothing; turned on with the page open, the key and the
 *     rail's magnifier (QuickBarRailButton.tsx) both open the bar, no reload needed;
 *   - on, the key opens the bar listening at once, the live words show as they are said, the
 *     name said first ("to Walnut VP, ...") picks who gets them, and two seconds after the take
 *     ends the words go to that person; the receipt in the corner follows the reply;
 *   - the bar opens again on the person sent to last; Esc during the count stops the send and
 *     Enter sends the edited words; Tab opens the people list, Cmd-number and typed words pick;
 *   - a send that never went out says so and puts the words back;
 *   - /quickbar, the Mac app's panel page, reports its size and mode to the app and answers the
 *     app's calls (the app's side is desktop/QuickBarPanel.swift).
 * The microphone is synthetic, the engine canned, and the people list and the send are stubbed
 * (the send's own contract is tests/e2e/quick-input.test.ts); the rest is the real app.
 */
import { expect, test, type APIRequestContext, type Page, type Route } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { isolateUiPrefs } from './todo-panel-helpers'
import { stubSttStatus } from './voice-selection-helpers'
import { useSyntheticMic } from './stt-failure-helpers'

const SHOT_DIR = process.env.WALNUT_TASK_DIR ? path.join(process.env.WALNUT_TASK_DIR, 'shots') : '/tmp/quick-bar/shots'
const KEY = 'Control+Alt+Meta+Space'
const DRAFT = 'to Walnut VP, ship the'
const FINAL = 'to Walnut VP, ship the quick bar first'

const PEOPLE = [
  { id: 'pw-ceo', title: 'CEO', kind: 'ceo', project: '', state: 'waiting', stateLabel: 'Waiting', line: 'Your next message', needs: 0 },
  { id: 'pw-vp-walnut', title: 'Walnut VP', kind: 'vp', project: 'Walnut', state: 'waiting', stateLabel: 'Waiting', line: 'Pick the artifacts layout', needs: 3 },
  { id: 'pw-vp-garden', title: 'Garden VP', kind: 'vp', project: 'Garden', state: 'working', stateLabel: 'Working', line: 'Planting the spring beds', needs: 0 },
  { id: 'pw-task-tile', title: 'Pick the tile color', kind: 'task', project: 'Garden', state: 'needs', stateLabel: 'Needs you', line: 'Blue or sand?', needs: 1 },
]

test.describe.configure({ mode: 'serial' })

async function shot(page: Page, name: string): Promise<void> {
  await fs.mkdir(SHOT_DIR, { recursive: true })
  await page.screenshot({ path: path.join(SHOT_DIR, `quick-bar-${name}.png`) }).catch(() => {})
}

async function setFlag(request: APIRequestContext, on: boolean): Promise<Record<string, boolean>> {
  const cfg = await (await request.get('/api/config')).json() as { config?: { experimental?: Record<string, boolean> } }
  const before = { ...(cfg.config?.experimental ?? {}) }
  const res = await request.put('/api/config', { data: { experimental: { ...before, quick_bar: on } } })
  expect(res.ok(), await res.text()).toBe(true)
  return before
}

/** `takes`: recordings the engine was asked to write out (none may run while voice is off). */
interface Sends { bodies: Array<{ to?: string; text: string; follow?: boolean }>; fail: boolean; takes: number }

/** The canned engine, the people list and the send (a reply streamed in three lines). */
async function stubAll(page: Page, said: { draft?: string; final?: string } = {}): Promise<Sends> {
  const sends: Sends = { bodies: [], fail: false, takes: 0 }
  await stubSttStatus(page)
  await page.route('**/api/stt/warmup', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }))
  // The live words grow over two drafts, as they do while one talks: the second must replace the
  // first, never land beside it (2026-11-20: "to Walnut VP to Walnut VP, ..." in the proof video).
  let drafts = 0
  await page.route('**/api/stt/draft', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: said.draft ?? (drafts++ === 0 ? 'to Walnut VP' : DRAFT), durationMs: 30 }) }))
  await page.route('**/api/stt/transcribe', (r) => { sends.takes++; return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: said.final ?? FINAL, durationMs: 40 }) }) })
  await page.route('**/api/stt/save', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ recordingId: 'rec-qb-1', debugAudioPath: '/tmp/rec-qb-1.webm' }) }))
  await page.route('**/api/v1/quick/people**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ people: PEOPLE }) }))
  await page.route('**/api/v1/quick/send', async (r: Route) => {
    const body = JSON.parse(r.request().postData() ?? '{}')
    sends.bodies.push(body)
    if (sends.fail) { await r.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Walnut is restarting' }) }); return }
    const to = body.to ?? 'pw-ceo'
    const lines = [
      { type: 'sent', taskId: to, sessionId: 's-1', started: false, messageId: 'm-1' },
      { type: 'delivered' },
      { type: 'text', delta: 'On it. ' },
      { type: 'result', text: 'On it. The bar ships first, the phone next.' },
    ]
    await r.fulfill({ status: 200, contentType: 'application/x-ndjson', body: lines.map((l) => JSON.stringify(l)).join('\n') + '\n' })
  })
  return sends
}

/** Voice off (no engine): the bar opens for typing. Registered last, so it wins over stubAll's. */
async function voiceOff(page: Page): Promise<void> {
  await page.route('**/api/stt/status', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ engine: null, available: false }) }))
}

/** Walnut open; with the experiment on, also its key listener (the switch is read after the page shows). */
async function openApp(page: Page, barOn = true): Promise<void> {
  await page.setContent(`<a href="${test.info().project.use.baseURL}/">Open Walnut</a>`)
  await page.getByRole('link', { name: 'Open Walnut' }).click()
  // A busy dev host takes a while to boot the app (the other specs give it 45 to 90 s).
  await expect(page.locator('.main-page')).toBeVisible({ timeout: 90_000 })
  if (barOn) await expect(page.locator('.qb-layer')).toBeAttached({ timeout: 15_000 })
}

const bar = (page: Page) => page.locator('.qb-center .qb-bar')
const box = (page: Page) => page.getByRole('textbox', { name: 'Message' })
const chip = (page: Page) => page.locator('.qb-to-name')

let restore: Record<string, boolean> | null = null

test.beforeEach(async ({ page }) => {
  await isolateUiPrefs(page)
  await useSyntheticMic(page)
})

test.afterAll(async ({ request }) => {
  if (restore) await request.put('/api/config', { data: { experimental: restore } })
})

test('off, the key opens nothing', async ({ page, request }) => {
  restore = await setFlag(request, false)
  await stubAll(page)
  await openApp(page, false)
  await page.keyboard.press(KEY)
  await page.waitForTimeout(400)
  await expect(page.locator('.qb-bar')).toHaveCount(0)
})

test('the switch turned on while Walnut is open: the key and the rail\'s magnifier both open the bar', async ({ page, request }) => {
  // 2026-11-20: the key was tried while the experiment was still off; once on, no reload is needed.
  await setFlag(request, false)
  const sends = await stubAll(page)
  await voiceOff(page)
  await openApp(page, false)
  const magnifier = page.getByTestId('sidebar-quick-bar')
  await expect(magnifier).toHaveCount(0)
  await setFlag(request, true)
  await expect(magnifier).toBeVisible({ timeout: 15_000 })
  await expect(magnifier).toHaveAttribute('title', /Control-Option-Command-Space/)
  await page.keyboard.press(KEY)
  await expect(bar(page)).toBeVisible()
  await expect(box(page)).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(bar(page)).toBeHidden()
  await magnifier.click()
  await expect(bar(page)).toBeVisible()
  await expect(box(page)).toBeFocused()
  await shot(page, '0-magnifier')
  expect(sends.takes).toBe(0)
})

test('speak, the name said first picks the VP, and two seconds later it sends and the reply shows', async ({ page, request }) => {
  await setFlag(request, true)
  const sends = await stubAll(page)
  await openApp(page)

  await page.keyboard.press(KEY)
  await expect(bar(page)).toBeVisible()
  await expect(bar(page)).toHaveAttribute('data-recording', 'true', { timeout: 10_000 })
  await expect(chip(page)).toHaveText('CEO')
  // The live words, and the chip already shows who the words go to.
  await expect(box(page)).toHaveValue(DRAFT, { timeout: 15_000 })
  await expect(chip(page)).toHaveText('Walnut VP')
  await shot(page, '1-listening')

  // The key again ends the take: the address leaves the words, the count starts.
  await page.keyboard.press(KEY)
  await expect(box(page)).toHaveValue('ship the quick bar first', { timeout: 15_000 })
  await expect(page.locator('.qb-foot-send')).toHaveText('Sending to Walnut VP…')
  await expect(page.locator('.qb-count')).toBeVisible()
  await shot(page, '2-countdown')
  expect(sends.bodies).toHaveLength(0)

  // Two seconds later: sent to the VP, the bar closes, the receipt follows the reply.
  await expect.poll(() => sends.bodies.length, { timeout: 5_000 }).toBe(1)
  expect(sends.bodies[0]).toEqual({ to: 'pw-vp-walnut', text: 'ship the quick bar first', follow: true })
  await expect(bar(page)).toBeHidden()
  const receipt = page.locator('.qb-receipt').first()
  await expect(receipt.locator('.qb-receipt-who')).toHaveText('Walnut VP')
  await expect(receipt.locator('.qb-receipt-status')).toHaveText('Replied')
  await expect(receipt.locator('.qb-receipt-line')).toHaveText('On it. The bar ships first, the phone next.')
  await shot(page, '3-receipt')
  // Open it: the whole reply, and the way to its chat.
  await receipt.locator('.qb-receipt-head').click()
  await expect(receipt.locator('.qb-receipt-reply')).toContainText('the phone next')
  // The reply shows once: the line above it now says what was sent.
  await expect(receipt.locator('.qb-receipt-line')).toHaveText('You: ship the quick bar first')
  await expect(receipt.getByRole('button', { name: 'Open chat' })).toBeVisible()
  await receipt.getByRole('button', { name: 'Dismiss' }).click()
  await expect(page.locator('.qb-receipt')).toHaveCount(0)

  // It opens again on the person just sent to. Esc during the count stops it; Enter sends.
  await page.keyboard.press(KEY)
  await expect(chip(page)).toHaveText('Walnut VP')
  await expect(box(page)).toHaveValue(DRAFT, { timeout: 15_000 })
  await page.keyboard.press(KEY)
  await expect(page.locator('.qb-count')).toBeVisible({ timeout: 15_000 })
  await page.keyboard.press('Escape')
  await expect(page.locator('.qb-count')).toHaveCount(0)
  await expect(page.locator('.qb-foot-note')).toContainText('Not sent')
  await page.waitForTimeout(2_400)
  expect(sends.bodies).toHaveLength(1)
  await box(page).press('End')
  await box(page).pressSequentially(' today')
  await box(page).press('Enter')
  await expect.poll(() => sends.bodies.length).toBe(2)
  expect(sends.bodies[1]).toMatchObject({ to: 'pw-vp-walnut', text: 'ship the quick bar first today' })
})

test('Enter during the take sends at once, once, and reads only the first name', async ({ page, request }) => {
  await setFlag(request, true)
  // The second "to ..." is part of what was said: only the first picks who gets it.
  const sends = await stubAll(page, { draft: 'to CEO, to Walnut VP,', final: 'to CEO, to Walnut VP, ship it' })
  await openApp(page)
  await page.keyboard.press(KEY)
  await expect(bar(page)).toHaveAttribute('data-recording', 'true', { timeout: 10_000 })
  await expect(box(page)).toHaveValue('to CEO, to Walnut VP,', { timeout: 15_000 })
  await box(page).press('Enter')
  await expect.poll(() => sends.bodies.length, { timeout: 10_000 }).toBe(1)
  expect(sends.bodies[0]).toEqual({ text: 'to Walnut VP, ship it', follow: true })
  await expect(bar(page)).toBeHidden()
  // The words left with the send: nothing waits in the draft store to go again on the next open.
  await expect.poll(() => page.evaluate(() => localStorage.getItem('draft:quickbar'))).toBeNull()
  await page.waitForTimeout(2_600)
  expect(sends.bodies).toHaveLength(1)
})

test('Tab lists who to talk to: Cmd-number and typed words pick', async ({ page, request }) => {
  await setFlag(request, true)
  const sends = await stubAll(page)
  await voiceOff(page)
  await openApp(page)
  await page.keyboard.press(KEY)
  await expect(bar(page)).toBeVisible()
  await expect(bar(page)).toHaveAttribute('data-recording', 'false')
  await expect(box(page)).toHaveAttribute('placeholder', 'Type a message…')
  await box(page).press('Tab')
  const picker = page.locator('.qb-picker')
  await expect(picker).toBeVisible()
  await expect(picker.locator('.qb-section-label')).toHaveText(['Pinned', 'VPs', 'Tasks'])
  await expect(picker.locator('.qb-person-name')).toHaveText(['CEO', 'Walnut VP', 'Garden VP', 'Pick the tile color'])
  await expect(picker.locator('.qb-person').nth(1).locator('.qb-person-line')).toHaveText('3 need you · Pick the artifacts layout')
  await shot(page, '4-picker')
  await page.keyboard.press('Meta+3')
  await expect(chip(page)).toHaveText('Garden VP')
  await expect(picker).toHaveCount(0)
  // Typed words find a task; Enter picks it.
  await box(page).press('Tab')
  await page.locator('.qb-picker-search').fill('tile')
  await expect(page.locator('.qb-person-name')).toHaveText(['Pick the tile color'])
  await page.keyboard.press('Enter')
  await expect(chip(page)).toHaveText('Pick the tile color')
  await box(page).fill('Sand, please')
  await box(page).press('Enter')
  await expect.poll(() => sends.bodies.at(-1)).toEqual({ to: 'pw-task-tile', text: 'Sand, please', follow: true })
})

test('a send that never went out says so and puts the words back', async ({ page, request }) => {
  await setFlag(request, true)
  const sends = await stubAll(page)
  sends.fail = true
  await voiceOff(page)
  await openApp(page)
  await page.keyboard.press(KEY)
  await box(page).fill('Move the review to Friday')
  // Esc closes and keeps the words; the key opens the bar on them again.
  await box(page).press('Escape')
  await expect(bar(page)).toBeHidden()
  await page.keyboard.press(KEY)
  await expect(box(page)).toHaveValue('Move the review to Friday')
  await box(page).press('Enter')
  const receipt = page.locator('.qb-receipt').first()
  await expect(receipt.locator('.qb-receipt-status')).toHaveText('Not sent · Walnut is restarting')
  await shot(page, '5-failed')
  await receipt.locator('.qb-receipt-head').click()
  sends.fail = false
  await receipt.getByRole('button', { name: 'Put it back' }).click()
  await expect(bar(page)).toBeVisible()
  await expect(box(page)).toHaveValue('Move the review to Friday')
  await box(page).press('Enter')
  await expect(page.locator('.qb-receipt-status').first()).toHaveText('Replied')
  // Voice off from the start: no take ran, not even one opened before the voice setup was read.
  expect(sends.takes).toBe(0)
  expect(sends.bodies.at(-1)).toMatchObject({ text: 'Move the review to Friday' })
})

test('/quickbar, the Mac app panel page, reports its size and mode and answers the app', async ({ page, request }) => {
  await setFlag(request, true)
  const sends = await stubAll(page)
  // The app's message handler, as WKWebView gives it to the page.
  await page.addInitScript(() => {
    const posted: unknown[] = []
    Object.assign(window, { __posted: posted, webkit: { messageHandlers: { walnutQuickBar: { postMessage: (m: unknown) => posted.push(m) } } } })
  })
  const posted = () => page.evaluate(() => (window as unknown as { __posted: Array<{ type: string; mode?: string; height?: number }> }).__posted)
  // The panel loads this page itself (desktop/QuickBarPanel.swift), as no click could.
  await page.goto('/quickbar')
  await expect.poll(async () => (await posted()).some((m) => m.type === 'layout' && m.mode === 'hidden')).toBe(true)
  await page.evaluate(() => (window as unknown as { __walnutQuickBar: { open(): void } }).__walnutQuickBar.open())
  await expect(page.locator('.qb-bar-panel')).toBeVisible()
  await expect.poll(async () => (await posted()).filter((m) => m.type === 'layout' && m.mode === 'bar').at(-1)?.height ?? 0).toBeGreaterThan(60)
  // The app's second press ends the take; the count sends; the panel shrinks to its receipt.
  await expect(box(page)).toHaveValue(DRAFT, { timeout: 15_000 })
  await page.evaluate(() => (window as unknown as { __walnutQuickBar: { hotkey(): void } }).__walnutQuickBar.hotkey())
  await expect.poll(() => sends.bodies.length, { timeout: 6_000 }).toBe(1)
  await expect.poll(async () => (await posted()).at(-1)).toMatchObject({ type: 'layout', mode: 'receipts' })
  await expect(page.locator('.qb-receipt-status')).toHaveText('Replied')
  // A receipt's Open chat asks the app to open the task in its window.
  await page.locator('.qb-receipt-head').click()
  await page.getByRole('button', { name: 'Open chat' }).click()
  await expect.poll(async () => (await posted()).some((m) => m.type === 'open')).toBe(true)
  // A screenshot from the app's capture lands in the bar.
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  await page.evaluate((data) => (window as unknown as { __walnutQuickBar: { attach(d: string): void } }).__walnutQuickBar.attach(data), png)
  await expect(page.getByTestId('qb-pictures').locator('img')).toHaveCount(1)
})
