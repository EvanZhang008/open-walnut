/**
 * The keyboard commands a person can change (web/src/keyboard/commands.ts), in the Mac app's keys:
 * holding Cmd shows the column numbers and the keys of New task and the current column's close;
 * Cmd+N opens a new task's draft, Cmd+W closes the current column (a draft with typed text stays);
 * Settings > Keyboard shortcuts gives New task another key, refuses one another command holds,
 * and Reset puts it back. The page runs as the Mac app does (a Mac platform and the app's message
 * handlers). Real UI and the fixture's long-transcript columns throughout; the keys a test gives
 * are taken back from the shared fixture's config afterwards.
 */
import { test, expect, type Page } from '@playwright/test'
import { homeColumns, loadHome, seedColumns, setPanelMode } from './draft-helpers'
import { holdPanelCountLock } from './panel-count-lock'

const SID = (k: 'a' | 'b') => `pw-kbd-${k}-session`
const SHOTS = process.env.KBD_SHOTS ?? '/tmp/keyboard-commands'

test.describe.configure({ mode: 'default' })
test.setTimeout(180_000)
holdPanelCountLock('test')

const col = (page: Page, k: 'a' | 'b') => page.locator(`.main-page-session-column[data-column-id="${SID(k)}"]`)
const drafts = (page: Page) => page.locator('.main-page-session-column[data-column-id^="draft:"]')
const toast = (page: Page, title: string) => page.locator('.notification-toast', { has: page.locator('.notification-toast-title', { hasText: title }) })

async function asMacApp(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel', configurable: true })
    if ('userAgentData' in Navigator.prototype) {
      Object.defineProperty(Navigator.prototype, 'userAgentData', { get: () => ({ platform: 'macOS', mobile: false, brands: [] }), configurable: true })
    }
    const w = window as unknown as { webkit?: { messageHandlers?: Record<string, unknown> } }
    const handlers = { walnutChrome: { postMessage: () => {} } }
    try { Object.defineProperty(window, 'webkit', { value: { messageHandlers: handlers }, configurable: true }) } catch {
      if (w.webkit) w.webkit.messageHandlers = { ...(w.webkit.messageHandlers ?? {}), ...handlers }
    }
    try { localStorage.setItem('open-walnut-home-chat-visible', 'false'); localStorage.removeItem('walnut:shortcuts') } catch { /* off */ }
  })
}

async function openColumns(page: Page, keys: Array<'a' | 'b'>) {
  await setPanelMode(page, '3')
  await seedColumns(page, keys.map(SID))
  await loadHome(page)
  await expect(homeColumns(page)).toHaveCount(keys.length, { timeout: 30_000 })
  for (const k of keys) await expect(col(page, k).getByText(`kbd ${k} answer 45`)).toBeVisible({ timeout: 30_000 })
}

async function caretColumn(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null
    if (!el || el.tagName !== 'TEXTAREA') return null
    return el.closest('.main-page-session-column')?.getAttribute('data-column-id') ?? null
  })
}

/** Takes every key a test gave back out of the shared fixture's config. */
async function clearShortcuts(page: Page) {
  const res = await page.request.get('/api/config')
  if (!res.ok()) return
  const { config } = (await res.json()) as { config: { ui?: Record<string, unknown> } }
  if (!config.ui || !('shortcuts' in config.ui)) return
  const { shortcuts: _drop, ...ui } = config.ui
  await page.request.put('/api/config', { data: { ui } })
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  await clearShortcuts(page)
})
test.afterEach(async ({ page }) => { await clearShortcuts(page) })

test('holding Cmd shows the numbers and the keys of New task and the current close; Cmd+N and Cmd+W do them', async ({ page }) => {
  await asMacApp(page)
  await openColumns(page, ['a', 'b'])
  await page.keyboard.press('Meta+2')
  await expect.poll(() => caretColumn(page)).toBe(SID('b'))

  await page.keyboard.down('Meta')
  await expect(page.locator('.session-jump-badge')).toHaveCount(2, { timeout: 3_000 })
  await expect(page.locator('.new-launcher-btn .shortcut-hint')).toHaveText('⌘N')
  // Only the column the keys act on shows its close key.
  await expect(col(page, 'b').locator('.shortcut-hint[data-command="session.close"]')).toHaveText('⌘W')
  await expect(col(page, 'a').locator('.shortcut-hint[data-command="session.close"]')).toBeHidden()
  await page.screenshot({ path: `${SHOTS}/held-hints.png`, clip: { x: 0, y: 0, width: 1600, height: 240 } })
  await page.keyboard.up('Meta')
  await expect(page.locator('.shortcut-hint')).toHaveCount(0)
  await expect(page.locator('.session-jump-badge')).toHaveCount(0)

  // Cmd+W closes the current column (b), and only it.
  await page.keyboard.press('Meta+W')
  await expect(homeColumns(page)).toHaveCount(1, { timeout: 15_000 })
  await expect(col(page, 'a')).toHaveCount(1)
  await expect(col(page, 'b')).toHaveCount(0)

  // Cmd+N opens a new task's draft, with the caret in it.
  await page.keyboard.press('Meta+N')
  await expect(drafts(page)).toHaveCount(1, { timeout: 15_000 })
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('[data-draft-id]'))).toBe(true)
  // A draft with typed text stays on Cmd+W (its x would discard it) and says why.
  await page.keyboard.type('keep these words')
  await page.keyboard.press('Meta+W')
  await expect(toast(page, 'This draft has text, so it stays. Its × discards it.')).toBeVisible()
  await expect(drafts(page)).toHaveCount(1)
  // Empty again, it goes.
  await drafts(page).locator('textarea').first().fill('')
  await page.keyboard.press('Meta+W')
  await expect(drafts(page)).toHaveCount(0, { timeout: 15_000 })
  await expect(homeColumns(page)).toHaveCount(1)

  // The Mac app's menu hands Cmd+W to the page when it got the key first.
  await page.keyboard.press('Meta+1')
  await expect.poll(() => caretColumn(page)).toBe(SID('a'))
  expect(await page.evaluate(() => (window as unknown as { __walnutDesktop?: { menuChord(c: string): boolean } }).__walnutDesktop?.menuChord('Cmd+W'))).toBe(true)
  await expect(homeColumns(page)).toHaveCount(0, { timeout: 15_000 })
  // Nothing left to close: the page leaves the key alone (the app's main window then stays).
  expect(await page.evaluate(() => (window as unknown as { __walnutDesktop?: { menuChord(c: string): boolean } }).__walnutDesktop?.menuChord('Cmd+W'))).toBe(false)
})

test('Settings gives New task another key, refuses a key that is taken, and Reset puts it back', async ({ page }) => {
  await asMacApp(page)
  await page.goto('/settings#shortcuts')
  const row = page.locator('[data-shortcut="task.new"]')
  await expect(row).toBeVisible({ timeout: 30_000 })
  await expect(row.locator('kbd')).toHaveText(['⌘', 'N'])
  // Every shortcut is listed; the fixed ones say so.
  await expect(page.locator('[data-shortcut="session.jump"]')).toContainText('Fixed')
  await expect(page.locator('[data-shortcut="session.close"] kbd')).toHaveText(['⌘', 'W'])

  // A key another command holds is refused, and the old key stays.
  await page.getByTestId('shortcut-change-task.new').click()
  await expect(row).toHaveAttribute('data-listening', 'true')
  await page.keyboard.press('Meta+W')
  // The row's error sits under it (SettingsRow).
  const alert = (text: string) => page.getByRole('alert').filter({ hasText: text })
  await expect(alert('⌘W is already "Close the current session column".')).toBeVisible()
  await expect(row.locator('kbd')).toHaveText(['⌘', 'N'])
  // So is one the Mac app's menus keep.
  await page.getByTestId('shortcut-change-task.new').click()
  await page.keyboard.press('Meta+Q')
  await expect(alert("⌘Q belongs to the Mac app's menus.")).toBeVisible()

  // A free key is saved.
  await page.getByTestId('shortcut-change-task.new').click()
  await page.keyboard.press('Meta+J')
  await expect(row.locator('kbd')).toHaveText(['⌘', 'J'])
  await expect(row).toContainText('Default: ⌘N')
  await expect(page.getByTestId('shortcut-reset-task.new')).toBeVisible()
  await row.screenshot({ path: `${SHOTS}/settings-row.png` })
  await expect.poll(async () => {
    const res = await page.request.get('/api/config')
    return ((await res.json()) as { config: { ui?: { shortcuts?: Record<string, Record<string, string>> } } }).config.ui?.shortcuts?.['mac-app']?.['task.new']
  }).toBe('Cmd+J')

  // Home uses it: Cmd+J opens the draft, Cmd+N does nothing, the held hint says Cmd+J.
  await seedColumns(page, [SID('a')])
  await loadHome(page)
  await expect(homeColumns(page)).toHaveCount(1, { timeout: 30_000 })
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.down('Meta')
  await expect(page.locator('.new-launcher-btn .shortcut-hint')).toHaveText('⌘J', { timeout: 3_000 })
  await page.keyboard.up('Meta')
  await page.keyboard.press('Meta+N')
  await page.waitForTimeout(600)
  await expect(drafts(page)).toHaveCount(0)
  await page.keyboard.press('Meta+J')
  await expect(drafts(page)).toHaveCount(1, { timeout: 15_000 })

  // The shortcuts sheet shows it too.
  await page.keyboard.press('Meta+Slash')
  await expect(page.locator('.shortcuts-help [data-shortcut="task.new"] kbd')).toHaveText(['⌘', 'J'])
  await page.keyboard.press('Escape')

  // Reset: back to Cmd+N.
  await page.goto('/settings#shortcuts')
  await page.getByTestId('shortcut-reset-task.new').click()
  await expect(row.locator('kbd')).toHaveText(['⌘', 'N'])
  await expect(page.getByTestId('shortcut-reset-task.new')).toHaveCount(0)
})
