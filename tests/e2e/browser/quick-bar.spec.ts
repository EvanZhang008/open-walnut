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
import { expect, test } from '@playwright/test'
import { isolateUiPrefs } from './todo-panel-helpers'
import { useSyntheticMic } from './stt-failure-helpers'
import { bar, box, chip, DRAFT, KEY, openApp, openBar, pinFlag, shot, stubAll, voiceOff } from './quick-bar-helpers'

test.describe.configure({ mode: 'serial' })

test.beforeEach(async ({ page }) => {
  await isolateUiPrefs(page)
  await useSyntheticMic(page)
})

test('off, the key opens nothing', async ({ page }) => {
  await pinFlag(page, false)
  await stubAll(page)
  await openApp(page, false)
  await page.keyboard.press(KEY)
  await page.waitForTimeout(400)
  await expect(page.locator('.qb-bar')).toHaveCount(0)
})

test('the switch turned on while Walnut is open: the key and the rail\'s magnifier both open the bar', async ({ page, request }) => {
  // 2026-11-20: the key was tried while the experiment was still off; once on, no reload is needed.
  const flag = await pinFlag(page, false)
  const sends = await stubAll(page)
  await voiceOff(page)
  await openApp(page, false)
  const magnifier = page.getByTestId('sidebar-quick-bar')
  await expect(magnifier).toHaveCount(0)
  flag.set(true)
  await flag.announce(request)
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

test('speak, the name said first picks the VP, and two seconds later it sends and the reply shows', async ({ page }) => {
  await pinFlag(page, true)
  const sends = await stubAll(page)
  await openApp(page)

  await page.keyboard.press(KEY)
  await expect(bar(page)).toBeVisible()
  await expect(bar(page)).toHaveAttribute('data-recording', 'true', { timeout: 10_000 })
  await expect(chip(page)).toHaveText('CEO')
  // The live words, and the chip already shows who the words go to.
  await expect(box(page)).toHaveValue(DRAFT, { timeout: 15_000 })
  await expect(chip(page)).toHaveText('Walnut VP')
  // The keys say what they do now: Esc stops listening, Enter sends (2026-11-20, "done" read as nothing).
  await expect(page.locator('.qb-keys')).toHaveText(/esc\s*stop listening.*↵\s*send/)
  await expect(page.locator('.qb-keys')).not.toContainText('done')
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
  expect(sends.bodies[0]).toEqual({ to: 'pw-vp-walnut', text: 'ship the quick bar first', follow: true, userUuid: expect.any(String) })
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
  await receipt.locator('.qb-receipt-actions').getByRole('button', { name: 'Dismiss' }).click()
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

test('Enter during the take closes the bar at once; the last words are written out and sent after, once, to the first name only', async ({ page }) => {
  await pinFlag(page, true)
  // The second "to ..." is part of what was said: only the first picks who gets it. "ship it" comes
  // only with the final words, and the engine answers them 1.5 s after Enter.
  const sends = await stubAll(page, { draft: 'to CEO, to Walnut VP,', final: 'to CEO, to Walnut VP, ship it', finalDelayMs: 1_500 })
  await openApp(page)
  await page.keyboard.press(KEY)
  await expect(bar(page)).toHaveAttribute('data-recording', 'true', { timeout: 10_000 })
  await expect(box(page)).toHaveValue('to CEO, to Walnut VP,', { timeout: 15_000 })
  // Timed in the page: from the key to the bar hidden.
  await page.evaluate(() => {
    const w = window as unknown as { __qbT: { key?: number; hidden?: number } }
    w.__qbT = {}
    document.addEventListener('keydown', (e) => { if (e.key === 'Enter') w.__qbT.key = performance.now() }, true)
    const center = document.querySelector('.qb-center')!
    new MutationObserver(() => { if (center.hasAttribute('hidden') && w.__qbT.hidden === undefined) w.__qbT.hidden = performance.now() }).observe(center, { attributes: true })
  })
  await box(page).press('Enter')
  await expect(bar(page)).toBeHidden()
  const took = await page.evaluate(() => { const t = (window as unknown as { __qbT: { key: number; hidden: number } }).__qbT; return t.hidden - t.key })
  expect(took).toBeLessThan(100)
  expect(sends.bodies).toHaveLength(0)
  await expect.poll(() => sends.bodies.length, { timeout: 10_000 }).toBe(1)
  expect(sends.bodies[0]).toEqual({ text: 'to Walnut VP, ship it', follow: true, userUuid: expect.any(String) })
  await expect(bar(page)).toBeHidden()
  // The words left with the send: nothing waits in the draft store to go again on the next open.
  await expect.poll(() => page.evaluate(() => localStorage.getItem('draft:quickbar'))).toBeNull()
  await page.waitForTimeout(2_600)
  expect(sends.bodies).toHaveLength(1)
})

test('Esc during the take only stops listening: the words stay, the bar stays, nothing is sent', async ({ page }) => {
  await pinFlag(page, true)
  const sends = await stubAll(page)
  await openApp(page)
  await page.keyboard.press(KEY)
  await expect(bar(page)).toHaveAttribute('data-recording', 'true', { timeout: 10_000 })
  await expect(box(page)).toHaveValue(DRAFT, { timeout: 15_000 })
  await box(page).press('Escape')
  await expect(bar(page)).toHaveAttribute('data-recording', 'false', { timeout: 10_000 })
  await expect(box(page)).toHaveValue('ship the quick bar first', { timeout: 10_000 })
  await expect(chip(page)).toHaveText('Walnut VP')
  await expect(bar(page)).toBeVisible()
  await expect(page.locator('.qb-count')).toHaveCount(0)
  await expect(page.locator('.qb-keys')).toHaveText(/esc\s*close/)
  await page.waitForTimeout(2_400)
  expect(sends.bodies).toHaveLength(0)
  // Esc again closes; Enter on the next open sends them.
  await box(page).press('Escape')
  await expect(bar(page)).toBeHidden()
})

test('a mode left open does not stop the next take: the key after a Notes search listens again', async ({ page }) => {
  await pinFlag(page, true)
  await stubAll(page)
  await openApp(page)
  await page.keyboard.press('Meta+k')
  await expect(bar(page)).toHaveAttribute('data-recording', 'false')
  await page.locator('.qb-mode-pill[data-mode="notes"]').click()
  await expect(bar(page)).toHaveAttribute('data-mode', 'notes')
  await page.keyboard.press('Meta+k')
  await expect(bar(page)).toBeHidden()
  await page.keyboard.press(KEY)
  await expect(bar(page)).toHaveAttribute('data-mode', 'send')
  await expect(bar(page)).toHaveAttribute('data-recording', 'true', { timeout: 10_000 })
})

test('Tab during a take that starts like a keyword picks who gets it, never a mode', async ({ page }) => {
  await pinFlag(page, true)
  const sends = await stubAll(page, { draft: 'ask the VP to ship it', final: 'ask the VP to ship it' })
  await openApp(page)
  await page.keyboard.press(KEY)
  await expect(box(page)).toHaveValue('ask the VP to ship it', { timeout: 15_000 })
  await expect(page.locator('.qb-keys')).toContainText('more')
  await box(page).press('Tab')
  await expect(page.locator('.qb-picker')).toBeVisible()
  // The list shows what else the bar does, but the highlight starts on a person: Enter keeps the words a message.
  await expect(page.locator('.qb-mode-row')).toHaveCount(3)
  await expect(page.locator('.qb-person').first()).toHaveAttribute('aria-selected', 'true')
  await expect(bar(page)).toHaveAttribute('data-mode', 'send')
  await expect(bar(page)).toHaveAttribute('data-recording', 'true')
  await page.keyboard.press('Escape')
  await expect(page.locator('.qb-picker')).toHaveCount(0)
  expect(sends.bodies).toHaveLength(0)
})

test('words emptied elsewhere (the other window sent them): the next take reads its name again', async ({ page }) => {
  await pinFlag(page, true)
  const sends = await stubAll(page, { draft: 'to Walnut VP, move the review', final: 'to Walnut VP, move the review' })
  await openApp(page)
  await page.keyboard.press(KEY)
  await expect(box(page)).toHaveValue('to Walnut VP, move the review', { timeout: 15_000 })
  await box(page).press('Escape')
  await expect(box(page)).toHaveValue('move the review', { timeout: 10_000 })
  await box(page).press('Escape')
  await expect(bar(page)).toBeHidden()
  // The words leave the shared draft (the Mac app's panel sent them, say).
  await page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) => k.includes('quickbar') && k.includes('draft'))
    if (key) { localStorage.removeItem(key); window.dispatchEvent(new StorageEvent('storage', { key })) }
  })
  await page.keyboard.press(KEY)
  await expect(bar(page)).toHaveAttribute('data-recording', 'true', { timeout: 10_000 })
  await expect(box(page)).toHaveValue(/to Walnut VP, move the review/, { timeout: 15_000 })
  await box(page).press('Enter')
  await expect.poll(() => sends.bodies.length, { timeout: 10_000 }).toBe(1)
  expect(sends.bodies[0]).toMatchObject({ to: 'pw-vp-walnut' })
})

test('Tab lists who to talk to: Cmd-number and typed words pick', async ({ page }) => {
  await pinFlag(page, true)
  const sends = await stubAll(page)
  await voiceOff(page)
  await openApp(page)
  await page.keyboard.press(KEY)
  await expect(bar(page)).toBeVisible()
  await expect(bar(page)).toHaveAttribute('data-recording', 'false')
  // The box says Tab is there.
  await expect(box(page)).toHaveAttribute('placeholder', 'Send a message, or find tasks and notes')
  await expect(page.locator('.qb-keys')).toContainText('more')
  await box(page).press('Tab')
  const picker = page.locator('.qb-picker')
  await expect(picker).toBeVisible()
  // First what else the bar does, then who to talk to.
  await expect(picker.locator('.qb-section-label')).toHaveText(['Search and ask', 'Pinned', 'VPs', 'Tasks'])
  await expect(picker.locator('.qb-mode-row-name')).toHaveText(['Search tasks', 'Search notes', 'Ask a quick question'])
  await expect(picker.locator('.qb-person-name')).toHaveText(['CEO', 'Walnut VP', 'Garden VP', 'Pick the tile color'])
  await expect(picker.locator('.qb-person').nth(1).locator('.qb-person-line')).toHaveText('3 Needs you · Pick the artifacts layout')
  await shot(page, '4-picker')
  await page.keyboard.press('Meta+3')
  await expect(chip(page)).toHaveText('Garden VP')
  await expect(picker).toHaveCount(0)
  // Typed words find a task; Enter picks it.
  await box(page).press('Tab')
  await page.locator('.qb-picker-search').fill('tile')
  await expect(page.locator('.qb-person-name')).toHaveText(['Pick the tile color'])
  // A name's words never bring a mode ahead of the person ("tile" names no mode).
  await expect(page.locator('.qb-mode-row')).toHaveCount(0)
  await page.keyboard.press('Enter')
  await expect(chip(page)).toHaveText('Pick the tile color')
  await box(page).fill('Sand, please')
  await box(page).press('Enter')
  await expect.poll(() => sends.bodies.at(-1)).toEqual({ to: 'pw-task-tile', text: 'Sand, please', follow: true, userUuid: expect.any(String) })
})

test('a send that never went out says so and puts the words back', async ({ page }) => {
  await pinFlag(page, true)
  const sends = await stubAll(page)
  sends.fail = true
  await voiceOff(page)
  await openApp(page)
  await openBar(page)
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
  // It stays (words that never went out are never dropped), and Send again sends them as they were.
  await page.waitForTimeout(8_600)
  await expect(receipt.locator('.qb-receipt-status')).toHaveText('Not sent · Walnut is restarting')
  await receipt.getByRole('button', { name: 'Send again' }).click()
  await expect(page.locator('.qb-receipt-status').first()).toHaveText('Not sent · Walnut is restarting')
  expect(sends.bodies.at(-1)).toMatchObject({ text: 'Move the review to Friday' })
  sends.fail = false
  await page.locator('.qb-receipt-head').first().click()
  await page.locator('.qb-receipt').first().getByRole('button', { name: 'Put it back' }).click()
  await expect(bar(page)).toBeVisible()
  await expect(box(page)).toHaveValue('Move the review to Friday')
  await box(page).press('Enter')
  await expect(page.locator('.qb-receipt-status').first()).toHaveText('Replied')
  // Voice off from the start: no take ran, not even one opened before the voice setup was read.
  expect(sends.takes).toBe(0)
  expect(sends.bodies.at(-1)).toMatchObject({ text: 'Move the review to Friday' })
})

test('/quickbar, the Mac app panel page, reports its size and mode and answers the app', async ({ page }) => {
  await pinFlag(page, true)
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
