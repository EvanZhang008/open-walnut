/**
 * Working through many sessions from the keyboard (web/src/pages/useHomeKeyboard.ts and
 * web/src/undo/): mod+1..9 and mod+shift+[ / ] move the caret between the columns, mod+i puts
 * it in the current one, holding the modifier shows each column's number, mod+shift+D
 * completes the current task and goes on to the next one that needs the person, and every
 * complete, snooze, pin and delete has an Undo for 5 seconds, on its toast and on mod+z.
 *
 * The page runs as the Mac app does (a Mac platform and the app's message handlers), so the
 * keys are the app's: Cmd for everything. One test runs as a browser elsewhere (Alt).
 * Real UI throughout: the fixture's long-transcript columns, the real toasts, the real server.
 */
import { test, expect, request, type Page } from '@playwright/test'
import { homeColumns, loadHome, seedColumns, setPanelMode } from './draft-helpers'
import { isolateUiPrefs, showEverything } from './todo-panel-helpers'
import { presetPanelDesign } from './status-section-helpers'
import { holdPanelCountLock } from './panel-count-lock'
import { watchColumnFades } from './column-fade-watch'

const KEYS = ['a', 'b', 'c', 'd', 'e'] as const
type Key = (typeof KEYS)[number]
const SID = (k: Key) => `pw-kbd-${k}-session`
const TID = (k: Key) => `pw-task-kbd-${k}`
const TITLE = (k: Key) => `Keyboard fixture ${k.toUpperCase()}`
const SHOTS = process.env.KBD_SHOTS ?? '/tmp/keyboard-triage'

test.describe.configure({ mode: 'default' })
test.setTimeout(180_000)
holdPanelCountLock('test')

const col = (page: Page, k: Key) => page.locator(`.main-page-session-column[data-column-id="${SID(k)}"]`)
const composer = (page: Page, k: Key) => col(page, k).locator('textarea.chat-input-textarea').first()
const chip = (page: Page, k: Key) => page.locator(`.session-taskbar-chip[data-session-id="${SID(k)}"]`)
const toast = (page: Page, title: string) => page.locator('.notification-toast', { has: page.locator('.notification-toast-title', { hasText: title }) })

async function asMacApp(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel', configurable: true })
    // Chromium's userAgentData names the runner's own system and is read first (isMacPlatform).
    if ('userAgentData' in Navigator.prototype) {
      Object.defineProperty(Navigator.prototype, 'userAgentData', { get: () => ({ platform: 'macOS', mobile: false, brands: [] }), configurable: true })
    }
    const w = window as unknown as { webkit?: { messageHandlers?: Record<string, unknown> } }
    const handlers = { walnutChrome: { postMessage: () => {} } }
    try { Object.defineProperty(window, 'webkit', { value: { messageHandlers: handlers }, configurable: true }) } catch {
      if (w.webkit) w.webkit.messageHandlers = { ...(w.webkit.messageHandlers ?? {}), ...handlers }
    }
  })
}

/**
 * The Undo window is 5 s of wall clock. A test that reads what the toast says, where it sits and
 * where the columns went before it presses Undo spends longer than that on a loaded runner: the
 * toast was gone when it was read, and Cmd+Z found nothing left to take back (2026-11-13, CI
 * shard 6 and clouddev at 4 CPUs). openColumns stretches the window for its tests; a test about
 * the window's end (the Undo gone, a delete refused when it ends) keeps the real one
 * (`{ undoWindow: 'real' }`).
 */
async function stretchUndoWindow(page: Page) {
  await page.addInitScript(() => {
    const original = window.setTimeout.bind(window)
    window.setTimeout = ((fn: TimerHandler, delay?: number, ...args: unknown[]) =>
      original(fn, delay === 5000 ? 120_000 : delay, ...args)) as typeof window.setTimeout
  })
}

async function phase(page: Page, k: Key): Promise<string | undefined> {
  const res = await page.request.get(`/api/tasks/${TID(k)}`)
  if (!res.ok()) return undefined
  return ((await res.json()) as { task?: { phase?: string } }).task?.phase
}
async function setPhases(page: Page, phases: Partial<Record<Key, string>>, order: Key[]) {
  // One after another, a beat apart: the Needs you queue is newest activity first.
  for (const k of order) {
    if (!phases[k]) continue
    await page.request.patch(`/api/tasks/${TID(k)}`, { data: { phase: phases[k] } })
    await page.waitForTimeout(40)
  }
}
async function resetTasks(page: Page) {
  for (const k of KEYS) {
    await page.request.patch(`/api/tasks/${TID(k)}`, { data: { phase: 'IN_PROGRESS', start_date: '' } }).catch(() => {})
  }
}
async function caretColumn(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null
    if (!el || el.tagName !== 'TEXTAREA') return null
    return el.closest('.main-page-session-column')?.getAttribute('data-column-id') ?? null
  })
}
async function openColumns(page: Page, keys: Key[], opts: { undoWindow?: 'real' } = {}) {
  if (opts.undoWindow !== 'real') await stretchUndoWindow(page)
  await setPanelMode(page, '3')
  await seedColumns(page, keys.map(SID))
  await loadHome(page)
  await expect(homeColumns(page)).toHaveCount(keys.length, { timeout: 30_000 })
  for (const k of keys) await expect(col(page, k).getByText(`kbd ${k} answer 45`)).toBeVisible({ timeout: 30_000 })
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  await page.addInitScript(() => {
    try { localStorage.setItem('open-walnut-home-chat-visible', 'false') } catch { /* off */ }
  })
})
// A fixture task a test deleted stays held while the page is open (its Undo) and on the server
// for its window after: a test that failed inside that window would leave it to be deleted, and
// every later test of the file found no such task (2026-11-13, clouddev at 4 CPUs: from the
// delete test on, ten tests failed on a missing row). The hold is taken back before the page goes.
test.afterEach(async ({ page }) => {
  await page.request.post('/api/tasks/batch/delete/cancel', { data: { task_ids: KEYS.map(TID) } }).catch(() => {})
  await resetTasks(page)
})

test('Cmd+1..3 and Cmd+Shift+[ ] move the caret between columns; Cmd+I puts it back in the current one', async ({ page }) => {
  await asMacApp(page)
  await resetTasks(page)
  await openColumns(page, ['a', 'b', 'c'])

  await page.keyboard.press('Meta+2')
  await expect.poll(() => caretColumn(page)).toBe(SID('b'))
  await page.keyboard.press('Meta+3')
  await expect.poll(() => caretColumn(page)).toBe(SID('c'))
  await page.keyboard.press('Meta+1')
  await expect.poll(() => caretColumn(page)).toBe(SID('a'))

  // Next and previous wrap around the strip.
  await page.keyboard.press('Meta+Shift+BracketLeft')
  await expect.poll(() => caretColumn(page)).toBe(SID('c'))
  await page.keyboard.press('Meta+Shift+BracketRight')
  await expect.poll(() => caretColumn(page)).toBe(SID('a'))
  await page.keyboard.press('Meta+Shift+BracketRight')
  await expect.poll(() => caretColumn(page)).toBe(SID('b'))

  // A number past the strip does nothing; 9 is the last column.
  await page.keyboard.press('Meta+7')
  await expect.poll(() => caretColumn(page)).toBe(SID('b'))
  await page.keyboard.press('Meta+9')
  await expect.poll(() => caretColumn(page)).toBe(SID('c'))
  // The column the keys act on wears the accent line (is-current); there is one.
  await expect(col(page, 'c')).toHaveClass(/\bis-current\b/)
  await expect(page.locator('.main-page-session-column.is-current')).toHaveCount(1)
  // A click right after a jump is where the person is: the mark (and the keys) follow it.
  await page.keyboard.press('Meta+2')
  await col(page, 'a').getByText('kbd a answer 44').click()
  await expect(col(page, 'a')).toHaveClass(/\bis-current\b/)
  await expect(page.locator('.main-page-session-column.is-current')).toHaveCount(1)
  // A press in the task panel leaves every column: no mark (the keys act on the list's task).
  // (An empty spot under the list: a row would open its own session's column.)
  await page.mouse.click(200, 860)
  await expect(page.locator('.main-page-session-column.is-current')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await page.keyboard.press('Meta+9')
  await expect.poll(() => caretColumn(page)).toBe(SID('c'))

  // Keys pressed faster than the caret moves stack up: two quick "next" go two columns on.
  await page.keyboard.press('Meta+1')
  await expect.poll(() => caretColumn(page)).toBe(SID('a'))
  await page.keyboard.press('Meta+Shift+BracketRight')
  await page.keyboard.press('Meta+Shift+BracketRight')
  await expect.poll(() => caretColumn(page)).toBe(SID('c'))
  await page.keyboard.press('Meta+Shift+BracketRight')
  await page.keyboard.press('Meta+Shift+BracketRight')
  await expect.poll(() => caretColumn(page)).toBe(SID('b'))
  // What is typed right after a jump lands in the column jumped to.
  await page.keyboard.press('Meta+1')
  await page.keyboard.type('xyz')
  await expect(composer(page, 'a')).toHaveValue('xyz')
  await expect(composer(page, 'b')).toHaveValue('')
  await composer(page, 'a').fill('')
  await page.keyboard.press('Meta+2')
  await expect.poll(() => caretColumn(page)).toBe(SID('b'))

  // Reading a transcript focuses nothing; Cmd+I takes the caret into that column's composer.
  await col(page, 'c').getByText('kbd c answer 44').click()
  await expect.poll(() => caretColumn(page)).toBe(null)
  await page.keyboard.press('Meta+i')
  await expect.poll(() => caretColumn(page)).toBe(SID('c'))

  // Typing in the composer is untouched by all of it.
  await page.keyboard.type('still mine')
  await expect(composer(page, 'c')).toHaveValue('still mine')
  await composer(page, 'c').fill('')
})

test('jumping away and back keeps the caret where the person left it in the box', async ({ page }) => {
  await asMacApp(page)
  await resetTasks(page)
  await openColumns(page, ['a', 'b'])
  await page.keyboard.press('Meta+1')
  await expect.poll(() => caretColumn(page)).toBe(SID('a'))
  await page.keyboard.type('hello world')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('Meta+2')
  await expect.poll(() => caretColumn(page)).toBe(SID('b'))
  await page.keyboard.press('Meta+1')
  await expect.poll(() => caretColumn(page)).toBe(SID('a'))
  await page.keyboard.type('Z')
  await expect(composer(page, 'a')).toHaveValue('hello worZld')
  await composer(page, 'a').fill('')
})

test('holding Cmd shows each column its number', async ({ page }) => {
  await asMacApp(page)
  await resetTasks(page)
  await openColumns(page, ['a', 'b', 'c'])
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.down('Meta')
  const badges = page.locator('.session-jump-badge')
  await expect(badges).toHaveCount(3, { timeout: 3_000 })
  await expect(col(page, 'a').locator('.session-jump-badge')).toHaveText('\u23181')
  await expect(col(page, 'c').locator('.session-jump-badge kbd').first()).toHaveText('\u23183')
  // The last column is also Cmd+9's.
  await expect(col(page, 'c').locator('.session-jump-badge-last')).toHaveText('\u23189')
  await expect(page.locator('.session-jump-badge-last')).toHaveCount(1)
  // Just under the header, over none of the header's buttons.
  for (const k of ['a', 'b', 'c'] as const) {
    const badge = (await col(page, k).locator('.session-jump-badge').boundingBox())!
    const header = (await col(page, k).locator('.session-panel-header').first().boundingBox())!
    expect(badge.y, `${k} badge`).toBeGreaterThanOrEqual(header.y + header.height)
    expect(badge.y, `${k} badge`).toBeLessThan(header.y + header.height + 20)
    const buttons = await col(page, k).locator('.session-panel-header button:visible').evaluateAll((els) =>
      els.map((el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, name: el.getAttribute('aria-label') ?? el.textContent ?? '' } }))
    for (const b of buttons.filter((b) => b.w > 0 && b.h > 0)) {
      const overlaps = badge.x < b.x + b.w && b.x < badge.x + badge.width && badge.y < b.y + b.h && b.y < badge.y + badge.height
      expect(overlaps, `${k} badge over the "${b.name}" button`).toBe(false)
    }
  }
  await page.screenshot({ path: `${SHOTS}/jump-badges.png`, clip: { x: 300, y: 0, width: 1300, height: 220 } })
  // Cmd still held: hop 2 then 3 while reading the numbers; they stay up the whole time.
  await page.keyboard.press('2')
  await expect.poll(() => caretColumn(page)).toBe(SID('b'))
  await expect(badges).toHaveCount(3)
  await page.keyboard.press('3')
  await expect.poll(() => caretColumn(page)).toBe(SID('c'))
  await expect(badges).toHaveCount(3)
  await page.keyboard.up('Meta')
  await expect(badges).toHaveCount(0)
})

test('? and Cmd+/ open the shortcuts sheet; ? typed in a text box is just a character', async ({ page }) => {
  await asMacApp(page)
  await resetTasks(page)
  await openColumns(page, ['a'])
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.press('Shift+Slash')
  const sheet = page.locator('.shortcuts-help[role="dialog"]')
  await expect(sheet).toBeVisible()
  await expect(sheet.locator('[data-shortcut="session.jump"] kbd').first()).toHaveText('\u2318')
  await expect(sheet.locator('[data-shortcut="task.completeNext"]')).toContainText('Complete the current task')
  await expect(sheet.locator('.shortcuts-help-note')).toHaveCount(0)
  await sheet.screenshot({ path: `${SHOTS}/shortcuts-sheet.png` })
  await page.keyboard.press('Escape')
  await expect(sheet).toHaveCount(0)
  // Cmd+/ from the page itself (nothing focused) opens it too, and again closes it.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.press('Meta+Slash')
  await expect(sheet).toBeVisible()
  await page.keyboard.press('Meta+Slash')
  await expect(sheet).toHaveCount(0)
  await expect(page.locator('.todo-search-bar input:focus')).toHaveCount(0)

  await page.keyboard.press('Meta+1')
  await expect.poll(() => caretColumn(page)).toBe(SID('a'))
  await page.keyboard.type('why?')
  await expect(composer(page, 'a')).toHaveValue('why?')
  await expect(sheet).toHaveCount(0)
  await page.keyboard.press('Meta+Slash')
  await expect(sheet).toBeVisible()
  await sheet.locator('.shortcuts-help-close').click()
  await expect(sheet).toHaveCount(0)
  await composer(page, 'a').fill('')
})

test('Cmd+Shift+D completes the task, opens the next one that needs you, and Cmd+Z takes it all back', async ({ page }) => {
  await asMacApp(page)
  await resetTasks(page)
  // Queue, newest first: A, B, C (D, E stay in progress). C has no column yet.
  await setPhases(page, { c: 'NEED_ACTION', b: 'NEED_ACTION', a: 'NEED_ACTION' }, ['c', 'b', 'a'])
  await openColumns(page, ['a', 'b'])

  await page.keyboard.press('Meta+2')
  await expect.poll(() => caretColumn(page)).toBe(SID('b'))
  await page.keyboard.press('Meta+Shift+D')

  await expect(col(page, 'b')).toHaveCount(0, { timeout: 15_000 })
  await expect(col(page, 'c')).toHaveCount(1, { timeout: 15_000 })
  await expect.poll(() => caretColumn(page), { timeout: 10_000 }).toBe(SID('c'))
  // C opens where B was, so the eye stays put.
  await expect.poll(() => homeColumns(page).evaluateAll((els) => els.map((el) => el.getAttribute('data-column-id')))).toEqual([SID('a'), SID('c')])
  const done = toast(page, 'Task completed')
  await expect(done).toContainText(TITLE('b'))
  await expect(done).toContainText(`Next: ${TITLE('c')}`)
  // Over the columns the corner keeps notices to a line, and an Undo's line names its task.
  await expect(done.locator('.notification-toast-body')).toBeVisible()
  await expect(done.locator('.notification-toast-kbd')).toHaveText('\u2318Z')
  await expect.poll(() => phase(page, 'b')).toBe('COMPLETE')
  // The Undo sits in the notice corner, over no column header or composer (they stay reachable).
  const box = (await done.boundingBox())!
  const covers = (r: { x: number; y: number; width: number; height: number } | null) => !!r
    && box.x < r.x + r.width && r.x < box.x + box.width && box.y < r.y + r.height && r.y < box.y + box.height
  for (const k of ['a', 'c'] as const) {
    expect(covers(await col(page, k).locator('.session-panel-header').first().boundingBox()), `${k} header`).toBe(false)
    expect(covers(await col(page, k).locator('.chat-input-box').first().boundingBox()), `${k} composer`).toBe(false)
  }
  await page.screenshot({ path: `${SHOTS}/complete-next.png` })
  // A completed column was closed, not minimized: it never becomes a taskbar chip.
  await expect(chip(page, 'b')).toHaveCount(0)

  // The caret sits in C's empty composer: Cmd+Z is the task undo there.
  await page.keyboard.press('Meta+z')
  await expect(col(page, 'b')).toHaveCount(1, { timeout: 15_000 })
  await expect(col(page, 'c')).toHaveCount(0, { timeout: 15_000 })
  await expect(done).toHaveCount(0)
  await expect.poll(() => phase(page, 'b')).toBe('NEED_ACTION')
  // The column is back where it was.
  await expect.poll(() => homeColumns(page).evaluateAll((els) => els.map((el) => el.getAttribute('data-column-id')))).toEqual([SID('a'), SID('b')])
  // The column the Undo takes back is closed too, not minimized onto a chip.
  await expect(chip(page, 'c')).toHaveCount(0)
  await expect(chip(page, 'b')).toHaveCount(0)
})

test('completing from the column header goes on too, and the Undo is gone after 5 seconds', async ({ page }) => {
  await asMacApp(page)
  await resetTasks(page)
  await setPhases(page, { b: 'NEED_ACTION', a: 'NEED_ACTION' }, ['b', 'a'])
  await openColumns(page, ['a', 'b'], { undoWindow: 'real' })

  await col(page, 'a').locator('.task-quick-phase-btn').click()
  await expect(col(page, 'a')).toHaveCount(0, { timeout: 15_000 })
  // B was open already: it keeps its place and takes the caret.
  await expect.poll(() => caretColumn(page), { timeout: 10_000 }).toBe(SID('b'))
  await expect(homeColumns(page)).toHaveCount(1)
  const done = toast(page, 'Task completed')
  await expect(done).toContainText(`Next: ${TITLE('b')}`)
  await expect(done.locator('.notification-toast-timer-bar')).toHaveCount(1)

  await expect(done).toHaveCount(0, { timeout: 7_000 })
  await page.keyboard.press('Meta+z')
  await page.waitForTimeout(800)
  await expect(col(page, 'a')).toHaveCount(0)
  expect(await phase(page, 'a')).toBe('COMPLETE')
})

test('completing a task that was not under Needs you closes its column, and the toast Undo brings it back', async ({ page }) => {
  await asMacApp(page)
  await resetTasks(page)
  // D is in progress, not under Needs you; whatever the fixture has under Needs you may open
  // next, and the Undo takes that back too.
  await openColumns(page, ['d'])
  await page.keyboard.press('Meta+1')
  await page.keyboard.press('Meta+Shift+D')
  await expect(col(page, 'd')).toHaveCount(0, { timeout: 15_000 })
  const done = toast(page, 'Task completed')
  await expect(done).toContainText(TITLE('d'))
  await expect.poll(() => phase(page, 'd')).toBe('COMPLETE')
  await done.locator('.notification-toast-action', { hasText: 'Undo' }).click()
  await expect(col(page, 'd')).toHaveCount(1, { timeout: 15_000 })
  await expect.poll(() => phase(page, 'd')).toBe('IN_PROGRESS')
  // Whatever the advance opened is closed again: the strip is as it was.
  await expect(homeColumns(page)).toHaveCount(1, { timeout: 15_000 })
})

test('Cmd+Shift+D in a column with no task says so and changes nothing', async ({ page }) => {
  await asMacApp(page)
  await resetTasks(page)
  await openColumns(page, ['a'])
  // A draft column has no task.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.press('Meta+Shift+Enter')
  await expect(homeColumns(page)).toHaveCount(2, { timeout: 15_000 })
  await page.keyboard.press('Meta+1')
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('[data-draft-id]'))).toBe(true)
  await page.keyboard.press('Meta+Shift+D')
  await expect(toast(page, 'This column has no task to complete.')).toBeVisible()
  await expect(homeColumns(page)).toHaveCount(2)
  expect(await phase(page, 'a')).toBe('IN_PROGRESS')
})

async function taskRow(page: Page, k: Key): Promise<{ pinned?: boolean; start_date?: string; focus_tier?: string }> {
  const res = await page.request.get(`/api/tasks/${TID(k)}`)
  return ((await res.json()) as { task: { pinned?: boolean; start_date?: string; focus_tier?: string } }).task
}
async function columnKebab(page: Page, k: Key, row: string) {
  await col(page, k).locator('.session-panel-header .task-kebab-btn').click()
  const menu = page.locator('.task-kebab-menu')
  await expect(menu).toBeVisible()
  await menu.getByText(row, { exact: true }).click()
}

test('pin to a group and snooze each take one Undo, on the toast and on Cmd+Z', async ({ page }) => {
  await asMacApp(page)
  await resetTasks(page)
  await page.request.delete(`/api/focus/tasks/${TID('d')}`).catch(() => {})
  await openColumns(page, ['d'])

  // Pin to Focus is a pin and then a group: one toast, and one Undo unpins.
  await columnKebab(page, 'd', 'Pin to')
  await page.getByTestId('kebab-pin-focus').click()
  const pinned = toast(page, 'Pinned to Focus')
  await expect(pinned).toContainText(TITLE('d'))
  await expect(page.locator('.notification-toast', { hasText: 'Pinned' })).toHaveCount(1)
  await expect.poll(async () => (await taskRow(page, 'd')).pinned).toBe(true)
  // A menu open over the page owns the key: nothing is undone behind it.
  await col(page, 'd').locator('.session-panel-header .task-kebab-btn').click()
  await expect(page.locator('.task-kebab-menu')).toBeVisible()
  await page.keyboard.press('Meta+z')
  await page.waitForTimeout(500)
  expect((await taskRow(page, 'd')).pinned).toBe(true)
  await page.keyboard.press('Escape')
  await expect(page.locator('.task-kebab-menu')).toHaveCount(0)
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.press('Meta+z')
  await expect(pinned).toHaveCount(0)
  await expect.poll(async () => (await taskRow(page, 'd')).pinned ?? false).toBe(false)
  // The key has no button to watch go: a short line says what it took back.
  await expect(toast(page, 'Undone')).toContainText(TITLE('d'))
  await expect(toast(page, 'Undone')).toHaveCount(0, { timeout: 5_000 })

  // Pinned to Focus, then moved to Satellite: the Undo of the move puts it back in Focus, pinned.
  await columnKebab(page, 'd', 'Pin to')
  await page.getByTestId('kebab-pin-focus').click()
  await expect.poll(async () => (await taskRow(page, 'd')).focus_tier).toBe('focus')
  await page.waitForTimeout(2_000)
  await columnKebab(page, 'd', 'Pin to')
  await page.getByTestId('kebab-pin-satellite').click()
  await expect(toast(page, 'Moved to Satellite')).toBeVisible()
  // Satellite is the default group: stored as no focus_tier on a pinned task.
  await expect.poll(async () => { const t = await taskRow(page, 'd'); return t.pinned ? (t.focus_tier ?? 'satellite') : 'unpinned' }).toBe('satellite')
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.press('Meta+z')
  await expect.poll(async () => (await taskRow(page, 'd')).focus_tier).toBe('focus')
  expect((await taskRow(page, 'd')).pinned).toBe(true)
  await page.request.delete(`/api/focus/tasks/${TID('d')}`).catch(() => {})
  await expect.poll(async () => (await taskRow(page, 'd')).pinned ?? false).toBe(false)

  // Snoozed, a task under Needs you leaves it at once, and its Undo brings it back at once
  // (not after the server's next status pass).
  await page.request.patch(`/api/tasks/${TID('d')}`, { data: { phase: 'NEED_ACTION' } })
  // The Flat layout, where Needs you is a section with its count (this page's prefs only).
  await isolateUiPrefs(page)
  await presetPanelDesign(page, 'status')
  await loadHome(page)
  const needsCount = page.getByTestId('status-section-needs-count')
  await expect.poll(async () => (await taskRow(page, 'd')) && (await needsCount.textContent()) !== null).toBe(true)
  await page.waitForTimeout(2_500)
  const needsBefore = Number((await needsCount.textContent())?.replace('+', ''))
  await columnKebab(page, 'd', 'Snooze until')
  await page.locator('.dp-pill', { hasText: '2h' }).first().click()
  await expect.poll(async () => Number((await needsCount.textContent())?.replace('+', '')), { timeout: 600, intervals: [50] }).toBe(needsBefore - 1)
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.press('Meta+z')
  await expect.poll(async () => Number((await needsCount.textContent())?.replace('+', '')), { timeout: 600, intervals: [50] }).toBe(needsBefore)
  await expect.poll(async () => (await taskRow(page, 'd')).start_date ?? '').toBe('')
  // And it stays back: the server's later pass does not flick it to Waiting and back.
  for (let i = 0; i < 10; i++) {
    expect(Number((await needsCount.textContent())?.replace('+', ''))).toBe(needsBefore)
    await page.waitForTimeout(250)
  }
  await page.request.patch(`/api/tasks/${TID('d')}`, { data: { phase: 'IN_PROGRESS' } })

  // Snooze for 2 hours, then the toast's Undo clears it again.
  await columnKebab(page, 'd', 'Snooze until')
  await page.locator('.dp-pill', { hasText: '2h' }).first().click()
  const snoozed = page.locator('.notification-toast', { has: page.locator('.notification-toast-title', { hasText: /^Snoozed until / }) })
  await expect(snoozed).toBeVisible()
  await expect.poll(async () => (await taskRow(page, 'd')).start_date ?? '').not.toBe('')
  await page.screenshot({ path: `${SHOTS}/snooze-toast.png` })
  await snoozed.locator('.notification-toast-action', { hasText: 'Undo' }).click()
  await expect.poll(async () => (await taskRow(page, 'd')).start_date ?? '').toBe('')
})

/** The task list's own row for a title (not the project group around it). */
const taskListRow = (page: Page, title: string) =>
  // Titles here are letters, digits, spaces and dashes: safe in a pattern as they are.
  page.getByRole('button', { name: new RegExp(`^Mark complete ${title}`) })

test('complete and delete from the task details popup each get an Undo, and the delete asks no confirm', async ({ page }) => {
  await asMacApp(page)
  await resetTasks(page)
  const title = `Details undo ${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  const id = ((await (await page.request.post('/api/tasks', { data: { title, project: 'Walnut', source: 'local', pinned: false } })).json()) as { task: { id: string } }).task.id
  const phaseOf = async () => ((await (await page.request.get(`/api/tasks/${id}`)).json()) as { task: { phase: string } }).task.phase
  try {
    await loadHome(page)
    await showEverything(page)
    const row = taskListRow(page, title)
    const openDetails = async () => {
      await expect(row).toBeVisible({ timeout: 15_000 })
      await row.hover()
      await row.getByRole('button', { name: 'More actions' }).click({ timeout: 15_000 })
      await page.locator('.task-kebab-menu:visible').getByText('Details', { exact: true }).click()
      const modal = page.locator('.task-detail-modal')
      await expect(modal).toBeVisible()
      return modal
    }

    // Complete: the toast and Cmd+Z, as from any other place.
    let modal = await openDetails()
    await modal.getByTestId('task-detail-complete').click()
    await expect.poll(phaseOf).toBe('COMPLETE')
    await page.keyboard.press('Escape')
    await expect(modal).toHaveCount(0)
    await expect(toast(page, 'Task completed')).toContainText(title)
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await page.keyboard.press('Meta+z')
    await expect.poll(phaseOf).not.toBe('COMPLETE')

    // Delete: no "cannot be undone" confirm; held, with an Undo that keeps the task.
    await page.waitForTimeout(2_500)
    modal = await openDetails()
    await modal.getByTestId('task-detail-delete').click()
    await expect(page.getByText('This cannot be undone.')).toHaveCount(0)
    await expect(modal).toHaveCount(0)
    const gone = toast(page, 'Task deleted')
    await expect(gone).toContainText(title)
    await gone.locator('.notification-toast-action', { hasText: 'Undo' }).click()
    await expect(row).toBeVisible({ timeout: 15_000 })
    await page.waitForTimeout(6_000)
    expect((await page.request.get(`/api/tasks/${id}`)).ok()).toBe(true)
  } finally {
    await page.request.delete(`/api/tasks/${id}?force=true`).catch(() => {})
  }
})

test('delete waits out its Undo: nothing reaches the server until the 5 seconds end', async ({ page }) => {
  await asMacApp(page)
  await resetTasks(page)
  // A task of this test's own (it really goes at the end), in the task list.
  const title = `Delete me ${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  const created = await page.request.post('/api/tasks', { data: { title, project: 'Walnut', source: 'local', pinned: false } })
  const id = ((await created.json()) as { task: { id: string } }).task.id
  const exists = async () => (await page.request.get(`/api/tasks/${id}`)).ok()
  const deletes: string[] = []
  page.on('request', (r) => { if (r.method() === 'DELETE' && r.url().includes(`/api/tasks/${id}`)) deletes.push(r.url()) })
  await loadHome(page)
  await showEverything(page)
  const row = taskListRow(page, title)

  const deleteFromMenu = async () => {
    await expect(row).toBeVisible({ timeout: 15_000 })
    await row.hover()
    await row.getByRole('button', { name: 'More actions' }).click({ timeout: 15_000 })
    const menu = page.locator('.task-kebab-menu')
    await expect(menu).toBeVisible()
    await menu.locator('.task-kebab-item-danger', { hasText: 'Delete' }).click()
    await expect(row).toHaveCount(0)
  }

  // Undo from the toast: the row comes back, nothing was sent.
  await deleteFromMenu()
  const gone = toast(page, 'Task deleted')
  await expect(gone).toContainText(title)
  await page.screenshot({ path: `${SHOTS}/delete-undo-toast.png` })
  await gone.locator('.notification-toast-action', { hasText: 'Undo' }).click()
  await expect(gone).toHaveCount(0)
  await expect(row).toBeVisible()
  await page.waitForTimeout(6_000)
  expect(deletes).toEqual([])
  expect(await exists()).toBe(true)

  // Undo with Cmd+Z (the caret is nowhere).
  await deleteFromMenu()
  await expect(gone).toBeVisible()
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.press('Meta+z')
  await expect(gone).toHaveCount(0)
  await expect(row).toBeVisible()
  await page.waitForTimeout(6_000)
  expect(deletes).toEqual([])

  // Left alone, the delete goes out once, when the window ends.
  await deleteFromMenu()
  await expect(gone).toBeVisible()
  await page.waitForTimeout(2_000)
  expect(deletes).toEqual([])
  await expect.poll(() => deletes.length, { timeout: 10_000 }).toBe(1)
  await expect.poll(exists, { timeout: 10_000 }).toBe(false)
  await page.waitForTimeout(1_000)
  expect(deletes.length).toBe(1)
  await expect(row).toHaveCount(0)
})

test('a reload inside the window keeps a delete held: its Undo comes back, and left alone it goes at the end', async ({ page }) => {
  await asMacApp(page)
  await resetTasks(page)
  const make = async (title: string) => ((await (await page.request.post('/api/tasks', { data: { title, project: 'Walnut', source: 'local', pinned: false } })).json()) as { task: { id: string } }).task.id
  const exists = async (id: string) => (await page.request.get(`/api/tasks/${id}`)).ok()
  const deleteRow = async (title: string) => {
    const row = taskListRow(page, title)
    await expect(row).toBeVisible({ timeout: 15_000 })
    await row.hover()
    await row.getByRole('button', { name: 'More actions' }).click({ timeout: 15_000 })
    await page.locator('.task-kebab-menu .task-kebab-item-danger', { hasText: 'Delete' }).click({ timeout: 15_000 })
    await expect(toast(page, 'Task deleted')).toBeVisible()
  }
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  const kept = `Reload keep ${suffix}`
  const gone = `Reload gone ${suffix}`
  const keptId = await make(kept)
  const goneId = await make(gone)
  await loadHome(page)
  await showEverything(page)

  // Undo after the reload: nothing is deleted, the row is back.
  await deleteRow(kept)
  await page.reload()
  // The toast comes back for the time it had left (about 4 s): take it back at once.
  const back = toast(page, 'Task deleted')
  await expect(back).toContainText(kept, { timeout: 10_000 })
  // The server holds the delete for the page (about 34 s): the Undo has to take it back there.
  const cancelled = page.waitForResponse((r) => r.url().includes('/api/tasks/batch/delete/cancel'))
  await back.locator('.notification-toast-action', { hasText: 'Undo' }).click()
  expect(((await (await cancelled).json()) as { cancelled: string[] }).cancelled).toEqual([keptId])
  await showEverything(page)
  await expect(taskListRow(page, kept)).toBeVisible({ timeout: 15_000 })
  await page.waitForTimeout(6_000)
  expect(await exists(keptId)).toBe(true)

  // Left alone after the reload: it goes when its window ends, not at the reload.
  await deleteRow(gone)
  await page.reload()
  expect(await exists(goneId)).toBe(true)
  await expect(toast(page, 'Task deleted')).toContainText(gone, { timeout: 10_000 })
  await expect.poll(() => exists(goneId), { timeout: 15_000 }).toBe(false)
  await showEverything(page)
  await expect(taskListRow(page, gone)).toHaveCount(0)
})

test('a browser that quits inside the window still has the task deleted, a while later', async ({ browser }) => {
  // Its own browser context, closed whole (no page left to say goodbye): the server already
  // holds the delete from the moment it was asked.
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } })
  const page = await context.newPage()
  await asMacApp(page)
  await resetTasks(page)
  const title = `Closed tab delete ${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  const id = ((await (await page.request.post('/api/tasks', { data: { title, project: 'Walnut', source: 'local', pinned: false } })).json()) as { task: { id: string } }).task.id
  await loadHome(page)
  await showEverything(page)
  const row = taskListRow(page, title)
  await expect(row).toBeVisible({ timeout: 15_000 })
  await row.hover()
  await row.getByRole('button', { name: 'More actions' }).click({ timeout: 15_000 })
  const held = page.waitForRequest((r) => r.url().includes('/api/tasks/batch/delete') && !r.url().includes('cancel')
    && (r.postDataJSON() as { delay_ms?: number; task_ids?: string[] } | null)?.task_ids?.includes(id) === true)
  await page.locator('.task-kebab-menu .task-kebab-item-danger', { hasText: 'Delete' }).click()
  await expect(toast(page, 'Task deleted')).toBeVisible()
  expect(((await held).postDataJSON() as { delay_ms?: number }).delay_ms).toBeGreaterThan(5_000)
  const ask = await request.newContext({ baseURL: new URL(page.url()).origin })
  await context.close()
  expect((await ask.get(`/api/tasks/${id}`)).ok()).toBe(true)
  await expect.poll(async () => (await ask.get(`/api/tasks/${id}`)).ok(), { timeout: 60_000, intervals: [2_000] }).toBe(false)
  await ask.dispose()
})

test('in a browser elsewhere, session switching uses Alt, the task keys Ctrl, and the sheet says why', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'Linux x86_64', configurable: true })
    if ('userAgentData' in Navigator.prototype) {
      Object.defineProperty(Navigator.prototype, 'userAgentData', { get: () => ({ platform: 'Linux', mobile: false, brands: [] }), configurable: true })
    }
  })
  await resetTasks(page)
  await openColumns(page, ['a', 'b'])
  await page.keyboard.press('Alt+2')
  await expect.poll(() => caretColumn(page)).toBe(SID('b'))
  await page.keyboard.press('Control+2')
  await expect.poll(() => caretColumn(page)).toBe(SID('b'))
  await page.keyboard.press('Alt+Shift+BracketRight')
  await expect.poll(() => caretColumn(page)).toBe(SID('a'))
  // Alt+I sits with Alt+1..9: back into the current column after reading elsewhere.
  await col(page, 'a').getByText('kbd a answer 44').click()
  await expect.poll(() => caretColumn(page)).toBe(null)
  await page.keyboard.press('Alt+i')
  await expect.poll(() => caretColumn(page)).toBe(SID('a'))

  // Ctrl+/ from the page itself opens the sheet (not the task search).
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.press('Control+Slash')
  const sheet = page.locator('.shortcuts-help[role="dialog"]')
  await expect(sheet).toBeVisible()
  await expect(sheet.locator('.shortcuts-help-note')).toContainText('Alt')
  await expect(sheet.locator('[data-shortcut="session.jump"] kbd').first()).toHaveText('Alt')
  await expect(sheet.locator('[data-shortcut="task.completeNext"] kbd').first()).toHaveText('Ctrl')
  await page.keyboard.press('Escape')
  await expect(sheet).toHaveCount(0)

  // Ctrl+Shift+D completes the current column's task (as a real keyboard sends it: key "D").
  await page.keyboard.press('Alt+1')
  await expect.poll(() => caretColumn(page)).toBe(SID('a'))
  await page.keyboard.press('Control+Shift+D')
  await expect.poll(() => phase(page, 'a')).toBe('COMPLETE')
  const done = toast(page, 'Task completed')
  await expect(done.locator('.notification-toast-kbd')).toHaveText('Ctrl+Z')
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.press('Control+z')
  await expect.poll(() => phase(page, 'a')).toBe('IN_PROGRESS')
  await expect(col(page, 'a')).toHaveCount(1, { timeout: 15_000 })
})

/** Settings > Tasks' "Go to the next task" switch, through the real Settings page. */
async function setGoingOn(page: Page, on: boolean) {
  await page.locator('.sidebar a[href^="/settings"]').click()
  const toggle = page.locator('#settings-next-after-complete')
  if (!(await toggle.isVisible().catch(() => false))) {
    await page.locator('.settings-nav-item', { hasText: /^Tasks/ }).first().click()
  }
  await expect(toggle).toBeVisible({ timeout: 20_000 })
  if ((await toggle.getAttribute('aria-checked')) !== String(on)) await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', String(on))
  await expect.poll(async () => ((await (await page.request.get('/api/config')).json()) as { config?: { ui?: { next_after_complete?: boolean } } })
    .config?.ui?.next_after_complete ?? true, { timeout: 20_000 }).toBe(on)
}

test('with going on off, the caret moves to the neighbour column; two Undos, the older by its button; a refused complete takes its toast down', async ({ page }) => {
  await asMacApp(page)
  // B's Undo waits behind C's for several slow steps: its 5 second window is stretched here.
  await stretchUndoWindow(page)
  await resetTasks(page)
  await setPanelMode(page, '3')
  await setGoingOn(page, false)
  try {
    await seedColumns(page, ['a', 'b', 'c'].map((k) => SID(k as Key)))
    await loadHome(page)
    await expect(homeColumns(page)).toHaveCount(3, { timeout: 30_000 })

    // B goes; nothing opens; the caret is in C, which took B's place. Then C goes: the caret is in A.
    await page.keyboard.press('Meta+2')
    await expect.poll(() => caretColumn(page)).toBe(SID('b'))
    await page.keyboard.press('Meta+Shift+D')
    await expect(col(page, 'b')).toHaveCount(0, { timeout: 15_000 })
    await expect.poll(() => caretColumn(page), { timeout: 10_000 }).toBe(SID('c'))
    // The person has seen C before completing it (the key rests until then).
    await page.waitForTimeout(1_200)
    await page.keyboard.press('Meta+Shift+D')
    await expect(col(page, 'c')).toHaveCount(0, { timeout: 15_000 })
    await expect.poll(() => caretColumn(page), { timeout: 10_000 }).toBe(SID('a'))
    await expect(homeColumns(page)).toHaveCount(1)

    // Two Undos, both in reach; only the newest (C's) shows the key. The key takes back C, and
    // B's own toast keeps its button.
    const both = toast(page, 'Task completed')
    await expect(both).toHaveCount(2)
    await expect(both.filter({ hasText: TITLE('c') }).locator('.notification-toast-kbd')).toHaveCount(1)
    await expect(both.filter({ hasText: TITLE('b') }).locator('.notification-toast-kbd')).toHaveCount(0)
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await page.keyboard.press('Meta+z')
    await expect(col(page, 'c')).toHaveCount(1, { timeout: 15_000 })
    const older = toast(page, 'Task completed').filter({ hasText: TITLE('b') })
    await expect(older).toBeVisible({ timeout: 10_000 })
    await older.locator('.notification-toast-action', { hasText: 'Undo' }).click({ timeout: 10_000 })
    await expect(col(page, 'b')).toHaveCount(1, { timeout: 15_000 })
    await expect(both).toHaveCount(0)
    await expect.poll(() => phase(page, 'b')).toBe('IN_PROGRESS')
    await expect.poll(() => phase(page, 'c')).toBe('IN_PROGRESS')

    // The server refuses E's completion from the list: no "completed" toast is left behind.
    await page.route(`**/api/tasks/${TID('e')}`, (route) => (route.request().method() === 'PATCH' || route.request().method() === 'PUT')
      ? route.fulfill({ status: 500, json: { error: 'refused for the test' } })
      : route.fallback())
    await page.route(`**/api/tasks/${TID('e')}/complete`, (route) => route.fulfill({ status: 500, json: { error: 'refused for the test' } }))
    await showEverything(page)
    const rowE = taskListRow(page, TITLE('e'))
    await expect(rowE).toBeVisible({ timeout: 15_000 })
    await rowE.getByRole('button', { name: 'Mark complete', exact: true }).click()
    const refused = toast(page, 'Task completed').filter({ hasText: TITLE('e') })
    await expect(refused).toBeVisible()
    // Gone once the write's retries fail. This test's windows are stretched (stretchUndoWindow), so
    // the toast going at all is the refusal taking it down: the 4.5 s bound it had stood for the
    // real 5 s window, and on a loaded runner the retries alone ran past it (2026-11-13, 4 CPUs).
    await expect(refused).toHaveCount(0, { timeout: 30_000 })
    expect(await phase(page, 'e')).toBe('IN_PROGRESS')
  } finally {
    await page.unrouteAll({ behavior: 'ignoreErrors' })
    await setGoingOn(page, true)
  }
})

/** The task's row in the task list (the row is a button named for its complete control and title). */
const listRow = (page: Page, k: Key) => taskListRow(page, TITLE(k)).first()
const listRowTitle = (page: Page, k: Key) => listRow(page, k).getByText(TITLE(k), { exact: true })
const stripIds = (page: Page) => homeColumns(page).evaluateAll((els) => els.map((el) => el.getAttribute('data-column-id')))

test('a column still fading out when the next one swaps in is gone, not left drawn over the strip', async ({ page }) => {
  await asMacApp(page)
  await resetTasks(page)
  // Needs you, newest first: C, B, A, E. C's next (B) is open; A's next (E) is not.
  await setPhases(page, { e: 'NEED_ACTION', a: 'NEED_ACTION', b: 'NEED_ACTION', c: 'NEED_ACTION' }, ['e', 'a', 'b', 'c'])
  await setPanelMode(page, '4')
  await seedColumns(page, ['a', 'b', 'c', 'd'].map((k) => SID(k as Key)))
  await loadHome(page)
  await expect(homeColumns(page)).toHaveCount(4, { timeout: 30_000 })

  const ghosts = () => page.evaluate(() => [...document.querySelectorAll('.main-page-session-column')]
    .filter((el) => '__aa_del' in el || el.classList.contains('is-closing')).length)
  const fades = await watchColumnFades(page)
  await page.keyboard.press('Meta+3')
  await expect.poll(() => caretColumn(page)).toBe(SID('c'))
  await page.keyboard.press('Meta+Shift+D')
  // C fades where it stands (B was open, so it only takes the caret), then is gone whole.
  await expect.poll(async () => (await fades()).map((f) => f.id), { timeout: 15_000 }).toEqual([SID('c')])
  await page.keyboard.press('Meta+1')
  await expect.poll(() => caretColumn(page)).toBe(SID('a'))
  await page.keyboard.press('Meta+Shift+D')
  // E takes A's place in one frame; nothing of C or A is left drawn over the strip.
  await expect(col(page, 'e')).toHaveCount(1, { timeout: 15_000 })
  await expect(col(page, 'c')).toHaveCount(0, { timeout: 2_000 })
  await expect(col(page, 'a')).toHaveCount(0)
  await page.waitForTimeout(1_500)
  expect(await ghosts()).toBe(0)
  await expect.poll(() => stripIds(page)).toEqual([SID('e'), SID('b'), SID('d')])
})

test('a jump during the tick keeps the caret where the person went; the next task still opens', async ({ page }) => {
  await asMacApp(page)
  await resetTasks(page)
  await setPhases(page, { d: 'NEED_ACTION', c: 'NEED_ACTION' }, ['d', 'c'])
  await openColumns(page, ['a', 'b', 'c'])

  await page.keyboard.press('Meta+3')
  await expect.poll(() => caretColumn(page)).toBe(SID('c'))
  await page.keyboard.press('Meta+Shift+D')
  await page.keyboard.press('Meta+1')
  await expect(col(page, 'd')).toHaveCount(1, { timeout: 15_000 })
  await expect.poll(() => stripIds(page)).toEqual([SID('a'), SID('b'), SID('d')])
  // D opened in C's place without taking the caret: it stays in A, and so does the mark.
  for (let i = 0; i < 6; i++) {
    expect(await caretColumn(page)).toBe(SID('a'))
    await page.waitForTimeout(250)
  }
  await expect(col(page, 'a')).toHaveClass(/\bis-current\b/)
})

test('Cmd+Shift+D on a task picked in the list whose column is open completes it the column way', async ({ page }) => {
  await asMacApp(page)
  await resetTasks(page)
  // A is in progress (its row sits in its project's list).
  await setPhases(page, { d: 'NEED_ACTION' }, ['d'])
  await openColumns(page, ['a', 'b', 'c'])

  await showEverything(page)
  await page.keyboard.press('Meta+2')
  await expect.poll(() => caretColumn(page)).toBe(SID('b'))
  await expect(listRowTitle(page, 'a')).toBeVisible({ timeout: 15_000 })
  await listRowTitle(page, 'a').click()
  await expect(page.locator('.main-page-session-column.is-current')).toHaveCount(0)
  await page.keyboard.press('Meta+Shift+D')
  // A's own column closes and the next task that needs the person opens in its place (the
  // first of the queue: A was not in it). Nothing else is pushed out.
  await expect(col(page, 'a')).toHaveCount(0, { timeout: 15_000 })
  await expect.poll(async () => {
    const ids = await stripIds(page)
    return ids.length === 3 && ids[0] !== SID('a') && ids[1] === SID('b') && ids[2] === SID('c')
  }, { timeout: 15_000 }).toBe(true)
  await expect.poll(() => phase(page, 'a')).toBe('COMPLETE')
  expect(await phase(page, 'b')).toBe('IN_PROGRESS')
})

test('Undo of a completion puts back what the session said, not "set to need you by hand"', async ({ page }) => {
  await asMacApp(page)
  await resetTasks(page)
  // Needs you set by a session (a caller header): not the person's own ask.
  await page.request.patch(`/api/tasks/${TID('a')}`, { data: { phase: 'NEED_ACTION' }, headers: { 'x-walnut-caller-sid': '99999999-2222-4333-8444-555555555555' } })
  await page.request.patch(`/api/tasks/${TID('a')}`, { data: { unread: false } })
  const marked = async () => {
    const task = ((await (await page.request.get(`/api/tasks/${TID('a')}`)).json()) as { task: { phase: string; needs_marked_at?: string; phase_changed_at?: string } }).task
    const mark = Date.parse(task.needs_marked_at ?? '')
    return { phase: task.phase, byPerson: Number.isFinite(mark) && mark >= (Date.parse(task.phase_changed_at ?? '') || 0) }
  }
  expect(await marked()).toEqual({ phase: 'NEED_ACTION', byPerson: false })
  await openColumns(page, ['a', 'b'])

  await page.keyboard.press('Meta+1')
  await expect.poll(() => caretColumn(page)).toBe(SID('a'))
  await page.keyboard.press('Meta+Shift+D')
  await expect(col(page, 'a')).toHaveCount(0, { timeout: 15_000 })
  await expect.poll(() => phase(page, 'a')).toBe('COMPLETE')
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.press('Meta+z')
  await expect(col(page, 'a')).toHaveCount(1, { timeout: 15_000 })
  await expect.poll(marked).toEqual({ phase: 'NEED_ACTION', byPerson: false })
  // Read before, read after: the Undo does not light the unread dot.
  expect(((await (await page.request.get(`/api/tasks/${TID('a')}`)).json()) as { task: { unread?: boolean } }).task.unread ?? false).toBe(false)
  await expect(col(page, 'a').locator('.session-panel')).not.toHaveClass(/session-panel-unread/)
  // The list selects the task that came back, and the address says so.
  await expect.poll(() => new URL(page.url()).searchParams.get('task')).toBe(TID('a'))
})

test('a refusal after the column went takes the advance back: its column goes and the caret returns', async ({ page }) => {
  await asMacApp(page)
  await resetTasks(page)
  await setPhases(page, { c: 'NEED_ACTION', b: 'NEED_ACTION' }, ['c', 'b'])
  await openColumns(page, ['a', 'b'])
  await page.route(`**/api/tasks/${TID('b')}`, async (route) => {
    if (route.request().method() === 'PATCH') {
      await new Promise((resolve) => setTimeout(resolve, 2_500))
      await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'refused late, for the test' }) })
      return
    }
    await route.fallback()
  })
  try {
    await page.keyboard.press('Meta+2')
    await expect.poll(() => caretColumn(page)).toBe(SID('b'))
    await page.keyboard.press('Meta+Shift+D')
    await expect(col(page, 'c')).toHaveCount(1, { timeout: 15_000 })
    await expect(col(page, 'b')).toHaveCount(0)

    await expect(col(page, 'b')).toHaveCount(1, { timeout: 30_000 })
    await expect(col(page, 'c')).toHaveCount(0, { timeout: 10_000 })
    await expect.poll(() => stripIds(page)).toEqual([SID('a'), SID('b')])
    await expect.poll(() => caretColumn(page), { timeout: 10_000 }).toBe(SID('b'))
    await expect(toast(page, 'Task completed')).toHaveCount(0)
    expect(await phase(page, 'b')).toBe('NEED_ACTION')
  } finally {
    await page.unrouteAll({ behavior: 'ignoreErrors' })
  }
})

test('a reload inside the window keeps the Undo: Cmd+Z after it brings the task and its column back', async ({ page }) => {
  await asMacApp(page)
  await resetTasks(page)
  await setPhases(page, { c: 'NEED_ACTION', b: 'NEED_ACTION' }, ['c', 'b'])
  await openColumns(page, ['a', 'b'])

  await page.keyboard.press('Meta+2')
  await expect.poll(() => caretColumn(page)).toBe(SID('b'))
  await page.keyboard.press('Meta+Shift+D')
  await expect(col(page, 'b')).toHaveCount(0, { timeout: 15_000 })
  await expect(col(page, 'c')).toHaveCount(1, { timeout: 15_000 })
  // The address already has C in B's place: the reload brings back the strip as it is now.
  await expect.poll(() => new URL(page.url()).searchParams.get('s2')).toBe(SID('c'))
  await page.reload()
  // The Undo is back as soon as the page is, for the time it had left; the columns load after it.
  // Waiting for them first outlasted that time: at one CPU the Undo showed 1 s after the reload
  // with about 3 s left, and the columns came 5.6 s later (2026-11-11, CI: no toast, both tries).
  // So it is read and used at once, and the columns are checked after.
  const done = toast(page, 'Task completed')
  await expect(done).toBeVisible({ timeout: 30_000 })
  await expect(done).toContainText(TITLE('b'))
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.press('Meta+z')
  await expect.poll(() => phase(page, 'b')).toBe('NEED_ACTION')
  await expect(homeColumns(page)).toHaveCount(2, { timeout: 30_000 })
  await expect(col(page, 'b')).toHaveCount(1, { timeout: 15_000 })
  await expect(col(page, 'c')).toHaveCount(0, { timeout: 15_000 })
  // Used once: another reload brings nothing back.
  await page.reload()
  await expect(homeColumns(page)).toHaveCount(2, { timeout: 30_000 })
  await page.waitForTimeout(1_000)
  await expect(done).toHaveCount(0)
})

test('deleting a task closes its open column, and the Undo puts the column back', async ({ page }) => {
  await asMacApp(page)
  await resetTasks(page)
  await openColumns(page, ['a', 'b', 'c'])
  await showEverything(page)
  const row = listRow(page, 'b')
  await expect(row).toBeVisible({ timeout: 15_000 })
  await row.hover()
  await row.getByRole('button', { name: 'More actions' }).click()
  await page.locator('.task-kebab-menu .task-kebab-item-danger', { hasText: 'Delete' }).click()
  const gone = toast(page, 'Task deleted')
  await expect(gone).toBeVisible()
  await expect(col(page, 'b')).toHaveCount(0, { timeout: 10_000 })
  await gone.locator('.notification-toast-action', { hasText: 'Undo' }).click()
  await expect(col(page, 'b')).toHaveCount(1, { timeout: 10_000 })
  await expect.poll(() => stripIds(page)).toEqual([SID('a'), SID('b'), SID('c')])
  await page.waitForTimeout(6_000)
  expect((await page.request.get(`/api/tasks/${TID('b')}`)).ok()).toBe(true)
})

test('a delete the server refuses gives the row and its column back', async ({ page }) => {
  await asMacApp(page)
  await resetTasks(page)
  await openColumns(page, ['a', 'b', 'c'], { undoWindow: 'real' })
  await page.route(`**/api/tasks/${TID('b')}*`, (route) => route.request().method() === 'DELETE'
    ? route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'its session is live, for the test' }) })
    : route.fallback())
  try {
    await showEverything(page)
    const row = listRow(page, 'b')
    await expect(row).toBeVisible({ timeout: 15_000 })
    await row.hover()
    await row.getByRole('button', { name: 'More actions' }).click()
    await page.locator('.task-kebab-menu .task-kebab-item-danger', { hasText: 'Delete' }).click()
    await expect(col(page, 'b')).toHaveCount(0, { timeout: 10_000 })
    // The window ends, the DELETE is refused: the column is back where it stood.
    await expect(col(page, 'b')).toHaveCount(1, { timeout: 30_000 })
    await expect.poll(() => stripIds(page)).toEqual([SID('a'), SID('b'), SID('c')])
    await expect(listRow(page, 'b')).toBeVisible({ timeout: 15_000 })
  } finally {
    await page.unrouteAll({ behavior: 'ignoreErrors' })
  }
})

test('a refusal that lands while the person types in the next task leaves that task alone', async ({ page }) => {
  await asMacApp(page)
  await resetTasks(page)
  await setPhases(page, { c: 'NEED_ACTION', b: 'NEED_ACTION' }, ['c', 'b'])
  await openColumns(page, ['a', 'b'])
  await page.route(`**/api/tasks/${TID('b')}`, async (route) => {
    if (route.request().method() === 'PATCH') {
      await new Promise((resolve) => setTimeout(resolve, 3_000))
      await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'refused late, for the test' }) })
      return
    }
    await route.fallback()
  })
  try {
    await page.keyboard.press('Meta+2')
    await expect.poll(() => caretColumn(page)).toBe(SID('b'))
    await page.keyboard.press('Meta+Shift+D')
    await expect.poll(() => caretColumn(page), { timeout: 15_000 }).toBe(SID('c'))
    await page.keyboard.type('half a reply')
    // B comes back (refused), and C, where the person is typing, stays with the caret and text.
    await expect(col(page, 'b')).toHaveCount(1, { timeout: 30_000 })
    await page.waitForTimeout(1_000)
    await expect(col(page, 'c')).toHaveCount(1)
    expect(await caretColumn(page)).toBe(SID('c'))
    await expect(composer(page, 'c')).toHaveValue('half a reply')
    await composer(page, 'c').fill('')
  } finally {
    await page.unrouteAll({ behavior: 'ignoreErrors' })
  }
})

test('a double click on the ring takes the completion back to Needs you, with no Undo left over', async ({ page }) => {
  await asMacApp(page)
  await resetTasks(page)
  await setPhases(page, { b: 'NEED_ACTION' }, ['b'])
  await openColumns(page, ['a', 'b', 'c'])
  await col(page, 'b').locator('.task-quick-phase-btn').dblclick()
  await page.waitForTimeout(2_000)
  await expect(col(page, 'b')).toHaveCount(1)
  await expect.poll(() => phase(page, 'b')).toBe('NEED_ACTION')
  await expect(toast(page, 'Task reopened')).toHaveCount(0)
  await expect(toast(page, 'Task completed')).toHaveCount(0)
})

test('a next task with no session is passed over for the one after it with a session', async ({ page }) => {
  await asMacApp(page)
  await resetTasks(page)
  const title = `No session next ${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  const id = ((await (await page.request.post('/api/tasks', { data: { title, project: 'Walnut', source: 'local', pinned: false } })).json()) as { task: { id: string } }).task.id
  // Newest first: B, then the session-less task, then C.
  await setPhases(page, { c: 'NEED_ACTION' }, ['c'])
  await page.request.patch(`/api/tasks/${id}`, { data: { phase: 'NEED_ACTION' } })
  await page.waitForTimeout(40)
  await setPhases(page, { b: 'NEED_ACTION' }, ['b'])
  try {
    await openColumns(page, ['a', 'b'])
    await page.keyboard.press('Meta+2')
    await expect.poll(() => caretColumn(page)).toBe(SID('b'))
    await page.keyboard.press('Meta+Shift+D')
    await expect(col(page, 'c')).toHaveCount(1, { timeout: 15_000 })
    await expect.poll(() => caretColumn(page), { timeout: 10_000 }).toBe(SID('c'))
    await expect(toast(page, 'Task completed')).toContainText(`Next: ${TITLE('c')}, skipped 1 with no session`)
    // Read to its end, not cut by an ellipsis.
    const body = toast(page, 'Task completed').locator('.notification-toast-body')
    expect(await body.evaluate((el) => el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1)).toBe(true)
    expect(((await (await page.request.get(`/api/tasks/${id}`)).json()) as { task: { phase: string } }).task.phase).toBe('NEED_ACTION')
  } finally {
    await page.request.delete(`/api/tasks/${id}?force=true`).catch(() => {})
  }
})

test('what is typed right after Cmd+Shift+D lands in the next task box, none of it in the one that goes', async ({ page }) => {
  await asMacApp(page)
  await resetTasks(page)
  await setPhases(page, { c: 'NEED_ACTION', b: 'NEED_ACTION' }, ['c', 'b'])
  await openColumns(page, ['a', 'b'])
  await page.keyboard.press('Meta+2')
  await expect.poll(() => caretColumn(page)).toBe(SID('b'))
  await page.keyboard.press('Meta+Shift+D')
  await page.waitForTimeout(150)
  await page.keyboard.type('quick reply')
  await expect(col(page, 'c')).toHaveCount(1, { timeout: 15_000 })
  await expect(composer(page, 'c')).toHaveValue('quick reply', { timeout: 10_000 })
  await expect.poll(() => caretColumn(page)).toBe(SID('c'))
  await page.keyboard.type('!')
  await expect(composer(page, 'c')).toHaveValue('quick reply!')
  await composer(page, 'c').fill('')
  // The draft of B, back with its Undo, holds none of it.
  await page.keyboard.press('Meta+z')
  await expect(col(page, 'b')).toHaveCount(1, { timeout: 15_000 })
  await expect(composer(page, 'b')).toHaveValue('')
})

test('Cmd+Shift+D on a column whose task is already complete says so', async ({ page }) => {
  await asMacApp(page)
  await resetTasks(page)
  await openColumns(page, ['a', 'b'])
  await showEverything(page)
  const row = listRow(page, 'b')
  await expect(row).toBeVisible({ timeout: 15_000 })
  // Completed from the list: its column stays.
  await row.getByRole('button', { name: 'Mark complete', exact: true }).click()
  await expect.poll(() => phase(page, 'b')).toBe('COMPLETE')
  await page.keyboard.press('Meta+2')
  await expect.poll(() => caretColumn(page)).toBe(SID('b'))
  await page.waitForTimeout(1_500)
  await page.keyboard.press('Meta+Shift+D')
  await expect(page.locator('.notification-toast', { hasText: 'This task is already complete.' })).toHaveCount(1)
  await expect(col(page, 'b')).toHaveCount(1)
})

test('one column is still marked as the one the keys act on', async ({ page }) => {
  await asMacApp(page)
  await resetTasks(page)
  await openColumns(page, ['a'])
  await page.keyboard.press('Meta+1')
  await expect.poll(() => caretColumn(page)).toBe(SID('a'))
  await expect(col(page, 'a')).toHaveClass(/\bis-current\b/)
})

test('a completed column fades where it stands: its neighbours keep their width until it is gone', async ({ page }) => {
  await asMacApp(page)
  await resetTasks(page)
  // Going on off: no next column swaps in where C stood, so C's own fade is what is seen.
  await setPanelMode(page, '3')
  await setGoingOn(page, false)
  try {
    await seedColumns(page, ['a', 'b', 'c'].map((k) => SID(k as Key)))
    await loadHome(page)
    await expect(homeColumns(page)).toHaveCount(3, { timeout: 30_000 })
    const widthOf = async (k: Key) => (await col(page, k).boundingBox())!.width
    const aBefore = await widthOf('a')
    const fades = await watchColumnFades(page)
    await page.keyboard.press('Meta+3')
    await expect.poll(() => caretColumn(page)).toBe(SID('c'))
    await page.keyboard.press('Meta+Shift+D')
    await expect(col(page, 'c')).toHaveCount(0, { timeout: 5_000 })
    // It faded first, and while it did nothing moved under it.
    const [fade] = await fades()
    expect(fade?.id).toBe(SID('c'))
    expect(fade.drift[SID('a')]).toBeLessThan(2)
    expect(fade.drift[SID('b')]).toBeLessThan(2)
    await expect(page.locator('.main-page-session-column.is-closing')).toHaveCount(0)
    await expect.poll(() => widthOf('a')).toBeGreaterThan(aBefore + 50)
    await page.keyboard.press('Meta+z')
    await expect(col(page, 'c')).toHaveCount(1, { timeout: 15_000 })
  } finally {
    await setGoingOn(page, true)
  }
})

test('Cmd+Z in a box typed in and emptied again is the task undo, as in any empty box', async ({ page }) => {
  await asMacApp(page)
  await resetTasks(page)
  await setPhases(page, { c: 'NEED_ACTION', b: 'NEED_ACTION' }, ['c', 'b'])
  await openColumns(page, ['a', 'b'])
  await page.keyboard.press('Meta+2')
  await expect.poll(() => caretColumn(page)).toBe(SID('b'))
  await page.keyboard.press('Meta+Shift+D')
  await expect(col(page, 'b')).toHaveCount(0, { timeout: 15_000 })
  await page.keyboard.press('Meta+1')
  await expect.poll(() => caretColumn(page)).toBe(SID('a'))
  await page.keyboard.type('ab')
  await page.keyboard.press('Backspace')
  await page.keyboard.press('Backspace')
  await expect(composer(page, 'a')).toHaveValue('')
  await page.keyboard.press('Meta+z')
  await expect.poll(() => phase(page, 'b')).toBe('NEED_ACTION')
  await expect(col(page, 'b')).toHaveCount(1, { timeout: 15_000 })
})

test('Cmd+Shift+D pressed again while the strip moves on completes nothing the person has not seen, and leaves the Undo in sight', async ({ page }) => {
  await asMacApp(page)
  await resetTasks(page)
  await setPhases(page, { c: 'NEED_ACTION', b: 'NEED_ACTION' }, ['c', 'b'])
  await openColumns(page, ['a', 'b'])
  await page.keyboard.press('Meta+2')
  await expect.poll(() => caretColumn(page)).toBe(SID('b'))
  await page.keyboard.press('Meta+Shift+D')
  await page.waitForTimeout(150)
  await page.keyboard.press('Meta+Shift+D')
  await page.waitForTimeout(60)
  await page.keyboard.press('Meta+Shift+D')
  await expect(col(page, 'c')).toHaveCount(1, { timeout: 15_000 })
  await expect.poll(() => caretColumn(page), { timeout: 10_000, intervals: [50] }).toBe(SID('c'))
  // C has only just come: a press now is still the double tap, not a look at C.
  await page.keyboard.press('Meta+Shift+D')
  await page.waitForTimeout(1_000)
  await expect(col(page, 'c')).toHaveCount(1)
  // The corner shows the completion and its Undo, naming where it went; no hint over it.
  const done = toast(page, 'Task completed')
  await expect(done).toBeVisible()
  await expect(done).toContainText(`Next: ${TITLE('c')}`)
  await expect(page.locator('.notification-toast', { hasText: 'no task to complete' })).toHaveCount(0)
  await expect(page.locator('.notification-toast', { hasText: 'Select a task' })).toHaveCount(0)
  await expect(page.getByTestId('notification-toaster-more')).toHaveCount(0)
  expect(await phase(page, 'c')).toBe('NEED_ACTION')
})

test('the list follows the column a jump lands on, without opening a detail or a fold', async ({ page }) => {
  await asMacApp(page)
  await resetTasks(page)
  await openColumns(page, ['a', 'b', 'c'])
  await showEverything(page)
  const focused = page.locator('.task-focused')
  await page.keyboard.press('Meta+2')
  await expect.poll(() => caretColumn(page)).toBe(SID('b'))
  await expect(focused).toHaveCount(1)
  await expect(focused).toContainText(TITLE('b'))
  await page.keyboard.press('Meta+3')
  await expect(focused).toContainText(TITLE('c'))
  await expect.poll(() => caretColumn(page)).toBe(SID('c'))
  await expect(homeColumns(page)).toHaveCount(3)
  await expect(page.locator('.task-detail-modal')).toHaveCount(0)
})

test('To do picked from the menu right after a completion is written as To do, not taken back to what it was', async ({ page }) => {
  await asMacApp(page)
  await resetTasks(page)
  // B is In progress: taking the completion back would put In progress, not the To do picked.
  await openColumns(page, ['a', 'b'])
  await showEverything(page)
  const row = listRow(page, 'b')
  await expect(row).toBeVisible({ timeout: 15_000 })
  // Completed from the list, its column stays (that close is the column's own).
  await row.getByRole('button', { name: 'Mark complete', exact: true }).click()
  await expect.poll(() => phase(page, 'b')).toBe('COMPLETE')
  await col(page, 'b').locator('.session-panel-header .task-kebab-btn').click()
  await page.locator('[data-testid="task-status-toggle"]').click()
  await page.locator('.task-status-pill-todo').click()
  await expect.poll(() => phase(page, 'b')).toBe('TODO')
  await page.waitForTimeout(1_000)
  expect(await phase(page, 'b')).toBe('TODO')
})

test('an Undo pressed while the completed column still fades brings it back to stay', async ({ page }) => {
  await asMacApp(page)
  await resetTasks(page)
  await setPhases(page, { c: 'NEED_ACTION', b: 'NEED_ACTION' }, ['c', 'b'])
  await openColumns(page, ['a', 'b'])
  await page.keyboard.press('Meta+2')
  await expect.poll(() => caretColumn(page)).toBe(SID('b'))
  await page.keyboard.press('Meta+Shift+D')
  // At once, the moment the column starts to go.
  await expect(toast(page, 'Task completed')).toHaveCount(1, { timeout: 5_000 })
  await page.keyboard.press('Meta+z')
  await expect(col(page, 'b')).toHaveCount(1, { timeout: 15_000 })
  await page.waitForTimeout(1_500)
  await expect(col(page, 'b')).toHaveCount(1)
  await expect(col(page, 'b')).not.toHaveClass(/\bis-closing\b/)
  await expect(col(page, 'c')).toHaveCount(0)
  await expect.poll(() => phase(page, 'b')).toBe('NEED_ACTION')
})

test('a completion refused at once gives what was typed after the key back to its own box', async ({ page }) => {
  await asMacApp(page)
  await resetTasks(page)
  await setPhases(page, { c: 'NEED_ACTION', b: 'NEED_ACTION' }, ['c', 'b'])
  await openColumns(page, ['a', 'b'])
  await page.route(`**/api/tasks/${TID('b')}`, (route) => route.request().method() === 'PATCH'
    ? route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'refused for the test' }) })
    : route.fallback())
  try {
    await page.keyboard.press('Meta+2')
    await expect.poll(() => caretColumn(page)).toBe(SID('b'))
    await page.keyboard.press('Meta+Shift+D')
    await page.keyboard.type('still mine')
    await expect(composer(page, 'b')).toHaveValue('still mine', { timeout: 10_000 })
    await expect.poll(() => caretColumn(page)).toBe(SID('b'))
    await expect(col(page, 'c')).toHaveCount(0)
    expect(await phase(page, 'b')).toBe('NEED_ACTION')
  } finally {
    await page.unrouteAll({ behavior: 'ignoreErrors' })
  }
})

test('a completion refused after its column went takes the next task back, and the typed text with it', async ({ page }) => {
  await asMacApp(page)
  await resetTasks(page)
  await setPhases(page, { c: 'NEED_ACTION', b: 'NEED_ACTION' }, ['c', 'b'])
  await openColumns(page, ['a', 'b'])
  // The refusal comes back after the close tick: B has gone and C has opened in its place.
  await page.route(`**/api/tasks/${TID('b')}`, async (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback()
    await new Promise((r) => setTimeout(r, 900))
    await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'refused for the test' }) })
  })
  try {
    await page.keyboard.press('Meta+2')
    await expect.poll(() => caretColumn(page)).toBe(SID('b'))
    await page.keyboard.press('Meta+Shift+D')
    await page.keyboard.type('still mine')
    await expect(col(page, 'b')).toHaveCount(1, { timeout: 15_000 })
    await expect(col(page, 'c')).toHaveCount(0, { timeout: 15_000 })
    await expect(composer(page, 'b')).toHaveValue('still mine', { timeout: 10_000 })
    await expect.poll(() => caretColumn(page)).toBe(SID('b'))
    expect(await phase(page, 'b')).toBe('NEED_ACTION')
  } finally {
    await page.unrouteAll({ behavior: 'ignoreErrors' })
  }
  // C's box keeps nothing of B's text.
  await openColumns(page, ['a', 'c'])
  await expect(composer(page, 'c')).toHaveValue('')
})

test('with no next task and no other column, the keys work again as soon as the column goes', async ({ page }) => {
  await asMacApp(page)
  await resetTasks(page)
  // Going on off (the fixture holds other tasks that need the person): nowhere to go next.
  await setPanelMode(page, '3')
  await setGoingOn(page, false)
  try {
    await seedColumns(page, [SID('a')])
    await loadHome(page)
    await expect(col(page, 'a').getByText('kbd a answer 45')).toBeVisible({ timeout: 30_000 })
    await page.keyboard.press('Meta+1')
    await expect.poll(() => caretColumn(page)).toBe(SID('a'))
    await page.keyboard.press('Meta+Shift+D')
    await expect(col(page, 'a')).toHaveCount(0, { timeout: 10_000 })
    // Well inside the 3 s a carry would hold the keys: ? opens the sheet.
    await page.keyboard.press('?')
    await expect(page.locator('.shortcuts-help[role="dialog"]')).toBeVisible({ timeout: 2_000 })
    await page.keyboard.press('Escape')
  } finally {
    await setGoingOn(page, true)
  }
})

test('an Undo whose cancel failed, then a reload at once, still keeps the task', async ({ page }) => {
  test.setTimeout(240_000)
  await asMacApp(page)
  await resetTasks(page)
  const title = `Undo then reload ${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  const id = ((await (await page.request.post('/api/tasks', { data: { title, project: 'Walnut', source: 'local', pinned: false } })).json()) as { task: { id: string } }).task.id
  await loadHome(page)
  await showEverything(page)
  const row = taskListRow(page, title)
  await expect(row).toBeVisible({ timeout: 15_000 })
  await row.hover()
  await row.getByRole('button', { name: 'More actions' }).click({ timeout: 15_000 })
  const held = page.waitForResponse((r) => r.url().includes('/api/tasks/batch/delete') && !r.url().includes('cancel'))
  await page.locator('.task-kebab-menu .task-kebab-item-danger', { hasText: 'Delete' }).click({ timeout: 15_000 })
  await held
  // The first cancel does not get through; the page goes before its retry.
  let failed = false
  await page.route('**/api/tasks/batch/delete/cancel', (route) => {
    if (failed) return route.fallback()
    failed = true
    return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'down for the test' }) })
  })
  const first = page.waitForResponse((r) => r.url().includes('/api/tasks/batch/delete/cancel') && r.status() === 500)
  await toast(page, 'Task deleted').locator('.notification-toast-action', { hasText: 'Undo' }).click()
  await first
  await page.reload()
  await page.unrouteAll({ behavior: 'ignoreErrors' })
  // Past the server's hold (the window plus the time a reload takes): still there.
  await page.waitForTimeout(40_000)
  expect((await page.request.get(`/api/tasks/${id}`)).ok()).toBe(true)
  await page.request.delete(`/api/tasks/${id}?force=true`).catch(() => {})
})

test('two actions on the same task stack: each Cmd+Z steps back one', async ({ page }) => {
  await asMacApp(page)
  await resetTasks(page)
  await page.request.delete(`/api/focus/tasks/${TID('d')}`).catch(() => {})
  await openColumns(page, ['d'])
  try {
    await columnKebab(page, 'd', 'Pin to')
    await page.getByTestId('kebab-pin-focus').click()
    await expect.poll(async () => (await taskRow(page, 'd')).focus_tier).toBe('focus')
    await columnKebab(page, 'd', 'Pin to')
    await page.getByTestId('kebab-pin-satellite').click()
    await expect(toast(page, 'Moved to Satellite')).toBeVisible()
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await page.keyboard.press('Meta+z')
    await expect.poll(async () => (await taskRow(page, 'd')).focus_tier).toBe('focus')
    await page.keyboard.press('Meta+z')
    await expect.poll(async () => (await taskRow(page, 'd')).pinned ?? false).toBe(false)
  } finally {
    await page.request.delete(`/api/focus/tasks/${TID('d')}`).catch(() => {})
  }
})

test('with going on off, completing another column from its checkbox leaves the caret where the person types', async ({ page }) => {
  await asMacApp(page)
  await resetTasks(page)
  await setPanelMode(page, '3')
  await setGoingOn(page, false)
  try {
    await seedColumns(page, ['c', 'b', 'a'].map((k) => SID(k as Key)))
    await loadHome(page)
    for (const k of ['c', 'b', 'a'] as const) await expect(col(page, k).getByText(`kbd ${k} answer 45`)).toBeVisible({ timeout: 30_000 })
    await page.keyboard.press('Meta+1')
    await expect.poll(() => caretColumn(page)).toBe(SID('c'))
    await page.keyboard.type('mid sentence')
    await col(page, 'b').locator('.task-quick-phase-btn').click()
    await expect(col(page, 'b')).toHaveCount(0, { timeout: 10_000 })
    await page.waitForTimeout(800)
    expect(await caretColumn(page)).toBe(SID('c'))
    await expect(composer(page, 'c')).toHaveValue('mid sentence')
    await expect(col(page, 'c')).toHaveClass(/\bis-current\b/)
    await expect(page.locator('.main-page-session-column.is-current')).toHaveCount(1)
    await composer(page, 'c').fill('')
  } finally {
    await setGoingOn(page, true)
  }
})

test('deleting the task of the column the person is in moves the caret on, and its Undo brings it back', async ({ page }) => {
  await asMacApp(page)
  await resetTasks(page)
  // The server holds the delete far longer than the window, so a failed run never deletes B
  // for the tests after it; the Undo must still take the hold back itself.
  await page.route('**/api/tasks/batch/delete', async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}')
    await route.continue({ postData: JSON.stringify({ ...body, delay_ms: 600_000 }) })
  })
  try {
    await openColumns(page, ['c', 'b', 'a'])
    await page.keyboard.press('Meta+2')
    await expect.poll(() => caretColumn(page)).toBe(SID('b'))
    await page.keyboard.type('keep this draft')
    await columnKebab(page, 'b', 'Delete')
    await expect(col(page, 'b')).toHaveCount(0, { timeout: 10_000 })
    await expect.poll(() => caretColumn(page), { timeout: 10_000 }).toBe(SID('a'))
    const takenBack = page.waitForRequest((r) => r.url().endsWith('/api/tasks/batch/delete/cancel')
      && (JSON.parse(r.postData() ?? '{}').task_ids ?? []).includes(TID('b')))
    await page.keyboard.press('Meta+z')
    await takenBack
    await expect(col(page, 'b')).toHaveCount(1, { timeout: 15_000 })
    await expect.poll(() => caretColumn(page), { timeout: 10_000 }).toBe(SID('b'))
    await expect(composer(page, 'b')).toHaveValue('keep this draft')
    await composer(page, 'b').fill('')
  } finally {
    await page.route('**/api/tasks/batch/delete', (route) => route.abort())
    await page.request.post('/api/tasks/batch/delete/cancel', { data: { task_ids: [TID('b')] } }).catch(() => {})
  }
  expect((await page.request.get(`/api/tasks/${TID('b')}`)).ok()).toBe(true)
})

test('an Undo toast out of sight behind a newer one keeps its time, and comes back with it', async ({ page }) => {
  await asMacApp(page)
  await resetTasks(page)
  for (const k of ['a', 'b'] as const) await page.request.delete(`/api/focus/tasks/${TID(k)}`).catch(() => {})
  // A short window: the corner shows one toast, so a newer one hides the older.
  await page.setViewportSize({ width: 1600, height: 700 })
  await openColumns(page, ['a', 'b'], { undoWindow: 'real' })
  try {
    await columnKebab(page, 'a', 'Pin to')
    await page.getByTestId('kebab-pin-focus').click()
    const first = toast(page, 'Pinned to Focus').filter({ hasText: TITLE('a') })
    await expect(first).toBeVisible()
    const firstAt = Date.now()
    // The second Undo from the keyboard, so a slow menu does not eat A's time first.
    await page.keyboard.press('Meta+2')
    await expect.poll(() => caretColumn(page)).toBe(SID('b'))
    await page.keyboard.press('Meta+Shift+D')
    const second = toast(page, 'Task completed').filter({ hasText: TITLE('b') })
    await expect(second).toBeVisible()
    // A's waits behind B's, its clock standing still.
    await expect(first).toHaveCount(0)
    // What A had left as it went out of sight.
    const leftAtHide = 5_000 - (Date.now() - firstAt)
    expect(leftAtHide).toBeGreaterThan(1_500)
    await expect(page.getByTestId('notification-toaster-more')).toBeVisible()
    await expect(second).toHaveCount(0, { timeout: 8_000 })
    // Back with the time it had left, though it was out of sight for longer than that.
    await expect(first).toBeVisible()
    await page.waitForTimeout(leftAtHide - 800)
    await expect(first).toBeVisible()
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await page.keyboard.press('Meta+z')
    await expect.poll(async () => (await taskRow(page, 'a')).pinned ?? false).toBe(false)
  } finally {
    for (const k of ['a', 'b'] as const) await page.request.delete(`/api/focus/tasks/${TID(k)}`).catch(() => {})
  }
})

test('what is typed after Cmd+Shift+D goes to the next task box when its column is already open', async ({ page }) => {
  await asMacApp(page)
  await resetTasks(page)
  await setPhases(page, { c: 'NEED_ACTION', b: 'NEED_ACTION' }, ['c', 'b'])
  await openColumns(page, ['a', 'b', 'c'])
  await page.keyboard.press('Meta+2')
  await expect.poll(() => caretColumn(page)).toBe(SID('b'))
  await page.keyboard.press('Meta+Shift+D')
  await page.waitForTimeout(150)
  await page.keyboard.type('to the open one')
  await expect(col(page, 'b')).toHaveCount(0, { timeout: 15_000 })
  await expect(composer(page, 'c')).toHaveValue('to the open one', { timeout: 10_000 })
  await expect.poll(() => caretColumn(page)).toBe(SID('c'))
  await composer(page, 'c').fill('')
  await page.keyboard.press('Meta+z')
  await expect(col(page, 'b')).toHaveCount(1, { timeout: 15_000 })
})

test('a delete the server refuses seconds later puts the column back but leaves the caret where the person is', async ({ page }) => {
  await asMacApp(page)
  await resetTasks(page)
  await openColumns(page, ['c', 'b', 'a'], { undoWindow: 'real' })
  await page.route(`**/api/tasks/${TID('b')}*`, (route) => route.request().method() === 'DELETE'
    ? route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'its session is live, for the test' }) })
    : route.fallback())
  // As above: the server's hold outlasts any failed run, and the refusal must take it back.
  await page.route('**/api/tasks/batch/delete', async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}')
    await route.continue({ postData: JSON.stringify({ ...body, delay_ms: 600_000 }) })
  })
  try {
    await page.keyboard.press('Meta+2')
    await expect.poll(() => caretColumn(page)).toBe(SID('b'))
    const takenBack = page.waitForRequest((r) => r.url().endsWith('/api/tasks/batch/delete/cancel')
      && (JSON.parse(r.postData() ?? '{}').task_ids ?? []).includes(TID('b')), { timeout: 60_000 })
    await columnKebab(page, 'b', 'Delete')
    await expect(col(page, 'b')).toHaveCount(0, { timeout: 10_000 })
    await expect.poll(() => caretColumn(page), { timeout: 10_000 }).toBe(SID('a'))
    await page.keyboard.type('writing in A')
    // The window ends, the DELETE is refused: B is back, the caret and the text stay in A.
    await expect(col(page, 'b')).toHaveCount(1, { timeout: 30_000 })
    await page.waitForTimeout(1_000)
    expect(await caretColumn(page)).toBe(SID('a'))
    await expect(composer(page, 'a')).toHaveValue('writing in A')
    await takenBack
    await composer(page, 'a').fill('')
  } finally {
    await page.route('**/api/tasks/batch/delete', (route) => route.abort())
    await page.request.post('/api/tasks/batch/delete/cancel', { data: { task_ids: [TID('b')] } }).catch(() => {})
  }
  expect((await page.request.get(`/api/tasks/${TID('b')}`)).ok()).toBe(true)
})

test('Cmd+Shift+D before the board has its list completes the column task, as its header Complete does', async ({ page }) => {
  // A slow load (2026-11-10, CI and a loaded dev host): the columns are up and take the caret
  // before the board's first task list has come. The key read only that list and said "This
  // column has no task to complete" under a column showing its task; it now reads the column's
  // own copy until the list comes, as the header's Complete does.
  await asMacApp(page)
  await resetTasks(page)
  await setPanelMode(page, '3')
  await seedColumns(page, ['a', 'b', 'c'].map((k) => SID(k as Key)))
  let releaseList!: () => void
  const listHeld = new Promise<void>((resolve) => { releaseList = resolve })
  await page.route(/\/api\/tasks\?/, async (route) => {
    if (new URL(route.request().url()).searchParams.get('fields') === 'list') await listHeld
    await route.fallback()
  })
  try {
    await page.goto('/')
    await expect(homeColumns(page)).toHaveCount(3, { timeout: 30_000 })
    // The column knows its task (its header shows it) while the list is still held.
    await expect(col(page, 'b').getByText(TITLE('b')).first()).toBeVisible({ timeout: 30_000 })
    await page.keyboard.press('Meta+2')
    await expect.poll(() => caretColumn(page)).toBe(SID('b'))
    await page.keyboard.press('Meta+Shift+D')
    await expect(col(page, 'b')).toHaveCount(0, { timeout: 15_000 })
    const done = toast(page, 'Task completed').filter({ hasText: TITLE('b') })
    await expect(done).toBeVisible()
    await expect(toast(page, 'This column has no task to complete.')).toHaveCount(0)
    await expect.poll(() => phase(page, 'b'), { timeout: 10_000 }).toBe('COMPLETE')
    // The list the board asked for before the key lands now: the column stays closed.
    releaseList()
    await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 30_000 })
    await page.waitForTimeout(1_500)
    await expect(col(page, 'b')).toHaveCount(0)
    // And its Undo brings it back.
    await done.locator('.notification-toast-action', { hasText: 'Undo' }).click({ timeout: 10_000 })
    await expect(col(page, 'b')).toHaveCount(1, { timeout: 15_000 })
    await expect.poll(() => phase(page, 'b')).toBe('IN_PROGRESS')
  } finally {
    releaseList()
    await page.unrouteAll({ behavior: 'ignoreErrors' })
  }
})
