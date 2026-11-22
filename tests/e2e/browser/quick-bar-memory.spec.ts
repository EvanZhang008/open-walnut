/**
 * The quick bar remembers who it talks to (web/src/components/quickbar/quickbar-people.ts), in
 * Chromium (2026-11-22, the user: "the quick search should remember the last time selection, if
 * I choose walnut, it will choose walnut again, but there should be a way to quickly select CEO,
 * like shift tab"):
 *   - it opens on the last one chosen, however long ago: a send days old (data an older version
 *     wrote), a pick by hand never sent, the CEO picked last, and after the app is opened again;
 *   - Shift-Tab goes to the CEO, and from the CEO back to the one chosen before; the foot names
 *     who it goes to;
 *   - with nobody to go back to, Shift-Tab on the CEO opens the Tab list;
 *   - over a typed address ("to Walnut VP, ..."), Shift-Tab's pick is what the chip names and the
 *     send takes.
 * The people list and the send are stubbed (quick-bar-helpers.ts); the rest is the real app.
 */
import { expect, test, type Page } from '@playwright/test'
import { isolateUiPrefs } from './todo-panel-helpers'
import { bar, box, chip, KEY, openApp, pinFlag, shot, stubAll, voiceOff } from './quick-bar-helpers'

test.describe.configure({ mode: 'serial' })

test.beforeEach(async ({ page }) => {
  await isolateUiPrefs(page)
})

const switchHint = (page: Page) => page.locator('.qb-keys .qb-switch-key')

async function openBar(page: Page): Promise<void> {
  await page.keyboard.press(KEY)
  await expect(bar(page)).toBeVisible()
}

async function closeBar(page: Page): Promise<void> {
  await box(page).press('Escape')
  await expect(bar(page)).toBeHidden()
}

test('opens on the last one chosen however long ago; Shift-Tab goes to the CEO and back', async ({ page }) => {
  await pinFlag(page, true)
  const sends = await stubAll(page)
  await voiceOff(page)
  await openApp(page)
  // A send three days old, as an older version kept it (no picks list yet): the bar used to go
  // back to the CEO after ten minutes.
  await page.evaluate(() => {
    localStorage.removeItem('walnut:quickbar-chosen')
    localStorage.setItem('walnut:quickbar-recents', JSON.stringify([{ id: 'pw-vp-walnut', title: 'Walnut VP', kind: 'vp', at: Date.now() - 3 * 24 * 3_600_000 }]))
  })
  await openBar(page)
  await expect(chip(page)).toHaveText('Walnut VP')
  await expect(switchHint(page)).toHaveText(/⇧tab\s*CEO/)
  await shot(page, 'memory-1-opens-on-walnut')

  // Shift-Tab: the CEO; again: back to Walnut VP.
  await box(page).press('Shift+Tab')
  await expect(chip(page)).toHaveText('CEO')
  await expect(page.locator('.qb-picker')).toHaveCount(0)
  await expect(switchHint(page)).toHaveText(/⇧tab\s*Walnut/)
  await shot(page, 'memory-2-shift-tab-ceo')
  await box(page).press('Shift+Tab')
  await expect(chip(page)).toHaveText('Walnut VP')

  // A pick by hand that is never sent is remembered.
  await box(page).press('Tab')
  await page.keyboard.press('Meta+3')
  await expect(chip(page)).toHaveText('Garden VP')
  await closeBar(page)
  await openBar(page)
  await expect(chip(page)).toHaveText('Garden VP')

  // The CEO chosen and sent to last is what the bar opens on; Shift-Tab goes back to Garden VP.
  await box(page).press('Shift+Tab')
  await expect(chip(page)).toHaveText('CEO')
  await box(page).fill('Move the review to Friday')
  await box(page).press('Enter')
  // A send to the CEO names nobody (useQuickReceipts.ts): the server's own CEO gets it.
  await expect.poll(() => sends.bodies.at(-1)?.text).toBe('Move the review to Friday')
  expect(sends.bodies.at(-1)?.to).toBeUndefined()
  await openBar(page)
  await expect(chip(page)).toHaveText('CEO')
  await expect(switchHint(page)).toHaveText(/⇧tab\s*Garden/)
  await box(page).press('Shift+Tab')
  await expect(chip(page)).toHaveText('Garden VP')
  await closeBar(page)

  // The app opened again: still the last one chosen.
  await openApp(page)
  await openBar(page)
  await expect(chip(page)).toHaveText('Garden VP')
  await box(page).fill('Water the beds')
  await box(page).press('Enter')
  await expect.poll(() => sends.bodies.at(-1)).toMatchObject({ to: 'pw-vp-garden', text: 'Water the beds' })
})

test('nothing chosen yet: the bar opens on the CEO, Shift-Tab there opens the Tab list; over a typed address it picks the CEO', async ({ page }) => {
  await pinFlag(page, true)
  const sends = await stubAll(page)
  await voiceOff(page)
  await openApp(page)
  await page.evaluate(() => {
    localStorage.removeItem('walnut:quickbar-chosen')
    localStorage.removeItem('walnut:quickbar-recents')
  })
  await openBar(page)
  await expect(chip(page)).toHaveText('CEO')
  // Nobody to go back to: no Shift-Tab hint, and the key opens the list to choose from.
  await expect(switchHint(page)).toHaveCount(0)
  await box(page).press('Shift+Tab')
  await expect(page.locator('.qb-picker')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('.qb-picker')).toHaveCount(0)

  // A typed address names Walnut VP; Shift-Tab picks the CEO (the person the bar already holds),
  // the chip says so at once, and the words go to the CEO as typed.
  await box(page).fill('to Walnut VP, ship it')
  await expect(chip(page)).toHaveText('Walnut VP')
  await box(page).press('Shift+Tab')
  await expect(chip(page)).toHaveText('CEO')
  await box(page).press('Enter')
  await expect.poll(() => sends.bodies.at(-1)?.text).toBe('to Walnut VP, ship it')
  expect(sends.bodies.at(-1)?.to).toBeUndefined()
})
