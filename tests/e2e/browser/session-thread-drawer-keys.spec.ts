/**
 * Tree drawer keyboard and inline actions (spec 6.5, 6.7): the full key table,
 * inline Done that keeps the row in place, inline Remove with its own
 * `Removed · Undo` placeholder, the follow-up confirm, pin Undo, F2 rename,
 * and portals that never close the drawer. Dense fixture, reset per test,
 * Chromium and WebKit.
 *
 * Checklist: C13, C30, C33, C39, C66, C73, C81.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import { DENSE_SESSION, openThreadsSession, readRecord, resetThreadsFixture } from './threads-helpers'
import { buildDenseSession } from './threads-fixture'

const TASK = 'pw-task-threads-dense'
const REMOVE_BODY = 'Walnut hides them from this view. The session transcript is owned by the CLI and keeps every message; you can still read them in Show all in order.'

async function openDrawer(page: Page): Promise<{ panel: Locator; drawer: Locator }> {
  await page.goto('/')
  const panel = await openThreadsSession(page, DENSE_SESSION, TASK)
  const toggle = panel.locator('.thread-drawer-toggle')
  await expect(toggle).toBeVisible({ timeout: 30_000 })
  await toggle.click()
  const drawer = panel.locator('.thread-drawer')
  await expect(drawer).toHaveAttribute('data-mode', 'open')
  return { panel, drawer }
}

const rowTitled = (drawer: Locator, title: string) =>
  drawer.locator('.thread-tree-row').filter({ has: drawer.page().locator('.thread-tree-title', { hasText: title }) })
const focusedRow = (drawer: Locator) => drawer.locator('.thread-tree-row:focus')
const chip = (drawer: Locator, name: string) => drawer.locator('.thread-drawer-chip', { hasText: new RegExp(`^${name}\\b`) })
const headOf = (q: string) => buildDenseSession(Date.now()).ids.head[q]
const top = (loc: Locator) => loc.evaluate((el) => Math.round(el.getBoundingClientRect().top))

test.describe('tree drawer keys and inline actions', () => {
  test.beforeEach(async ({ request }) => { await resetThreadsFixture(request, DENSE_SESSION) })

  test('arrows, Home / End, Right / Left, search round trip (C30)', async ({ page }) => {
    const { drawer } = await openDrawer(page)
    await chip(drawer, 'All').click()
    const q1 = rowTitled(drawer, 'Buffer flush order')
    await q1.focus()
    await page.keyboard.press('ArrowLeft')
    await expect(q1).toHaveAttribute('aria-expanded', 'false')
    await page.keyboard.press('ArrowRight')
    await expect(q1).toHaveAttribute('aria-expanded', 'true')
    await page.keyboard.press('ArrowRight')
    const child = focusedRow(drawer)
    await expect(child).toHaveAttribute('aria-level', '3')
    await page.keyboard.press('ArrowLeft')
    await expect(q1).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(focusedRow(drawer)).toHaveAttribute('aria-level', '3')
    await page.keyboard.press('Home')
    await expect(focusedRow(drawer)).toHaveAttribute('data-kind', 'root')
    await page.keyboard.press('ArrowUp')
    const search = drawer.locator('.thread-drawer-search-input')
    await expect(search).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(focusedRow(drawer)).toHaveCount(1)
    await page.keyboard.press('End')
    const last = drawer.locator('.thread-tree-row[tabindex]').last()
    await expect(last).toBeFocused()
    // Modifier combos pass through; printable keys type into the search.
    await page.keyboard.press('ControlOrMeta+a')
    await expect(search).toHaveValue('')
    await page.keyboard.press('b')
    await expect(search).toBeFocused()
    await expect(search).toHaveValue('b')
    await page.keyboard.press('Escape')
    await expect(search).toHaveValue('')
    await page.keyboard.press('Escape')
    await expect(drawer).toHaveCount(0)
  })

  test('Enter jumps and closes; Esc on a row closes and gives focus back (C30)', async ({ page }) => {
    const { panel, drawer } = await openDrawer(page)
    const toggle = panel.locator('.thread-drawer-toggle')
    await rowTitled(drawer, 'Buffer flush order').focus()
    await page.keyboard.press('Escape')
    await expect(drawer).toHaveCount(0)
    await expect(toggle).toBeFocused()
    await toggle.click()
    await rowTitled(drawer, 'Buffer flush order').focus()
    await page.keyboard.press('Enter')
    await expect(drawer).toHaveCount(0)
    await expect(panel.locator('.thread-stack-header .thread-stack-title')).toHaveText('Buffer flush order')
  })

  test('Space toggles done in place; Open keeps the settled row until the filter changes (C30, C33)', async ({ page, request }) => {
    const { drawer } = await openDrawer(page)
    await expect(chip(drawer, 'Open')).toHaveAttribute('aria-pressed', 'true')
    // A leaf: a done question with open follow-ups stays in Open as their context.
    const row = rowTitled(drawer, 'Point 22:')
    const y = await top(row)
    await row.focus()
    await page.keyboard.press(' ')
    await expect(row).toHaveAttribute('data-status', 'resolved')
    await expect(row).toHaveAttribute('data-settled', 'true')
    await expect(row).toBeFocused()
    expect(await top(row)).toBe(y)
    await expect(drawer).toHaveAttribute('data-mode', 'open')
    await expect.poll(async () => (await readRecord(request, DENSE_SESSION)).threadMeta!
      .find((m) => m.headId === headOf('Q22'))?.status).toBe('resolved')
    await page.waitForTimeout(450) // past the 400ms double-fire guard
    await page.keyboard.press(' ')
    await expect(row).not.toHaveAttribute('data-status', 'resolved')
    await page.waitForTimeout(450)
    await page.keyboard.press(' ')
    await expect(row).toHaveAttribute('data-status', 'resolved')
    await chip(drawer, 'All').click()
    await chip(drawer, 'Open').click()
    await expect(rowTitled(drawer, 'Point 22:')).toHaveCount(0)
  })

  test('a quick double click on trash removes one row and leaves a 44px `Removed · Undo` in place (C66, C33)', async ({ page, request }) => {
    const { drawer } = await openDrawer(page)
    const target = rowTitled(drawer, 'Point 22:')
    // Row ids can carry a NUL separator, so they are compared as values, never
    // put into a selector.
    const next = target.locator('xpath=following-sibling::*[1]')
    const nextId = await next.getAttribute('data-row-id')
    // Hover first: it may scroll the row into view, which is not the removal's doing.
    await target.hover()
    const [y, yNext] = [await top(target), await top(next)]
    const trash = target.getByRole('button', { name: 'Remove (Undo available)' })
    await trash.dblclick()
    const placeholder = drawer.locator('.thread-tree-row--removed')
    await expect(placeholder).toHaveCount(1)
    await expect(placeholder).toContainText('Removed')
    await expect(placeholder.getByRole('button', { name: 'Undo' })).toBeVisible()
    expect(await top(placeholder)).toBe(y)
    expect(Math.round(await placeholder.evaluate((el) => el.getBoundingClientRect().height))).toBe(44)
    const afterPlaceholder = placeholder.locator('xpath=following-sibling::*[1]')
    expect(await afterPlaceholder.getAttribute('data-row-id')).toBe(nextId)
    expect(await top(afterPlaceholder)).toBe(yNext)
    // The cursor went to a surviving sibling (or the parent).
    await expect(focusedRow(drawer)).toHaveCount(1)
    await expect(focusedRow(drawer)).not.toHaveClass(/thread-tree-row--removed/)
    // Remove another question; the first placeholder's Undo still works.
    const other = rowTitled(drawer, 'Version skip rule')
    await other.hover()
    await other.getByRole('button', { name: 'Remove (Undo available)' }).click()
    const confirm = page.locator('.thread-confirm')
    if (await confirm.count()) await confirm.getByRole('button', { name: 'Remove' }).click()
    await expect(drawer.locator('.thread-tree-row--removed')).toHaveCount(2)
    await drawer.locator('.thread-tree-row--removed').first().getByRole('button', { name: 'Undo' }).click()
    await expect(rowTitled(drawer, 'Point 22:')).toHaveCount(1)
    await expect.poll(async () => (await readRecord(request, DENSE_SESSION)).threadMeta!.filter((m) => m.hidden === true).length).toBe(4)
  })

  test('removing a question with follow-ups confirms first, verbatim, default focus Cancel (C13)', async ({ page, request }) => {
    const { panel, drawer } = await openDrawer(page)
    const q1 = rowTitled(drawer, 'Buffer flush order')
    await q1.focus()
    await page.keyboard.press('Delete')
    const confirm = page.locator('.thread-confirm')
    await expect(confirm.locator('.thread-confirm-title')).toHaveText(/^Remove this question and \d+ follow-ups\?$/)
    await expect(confirm.locator('.thread-confirm-body')).toHaveText(REMOVE_BODY)
    // Soft: default focus is ThreadConfirm's (P1) job; the steps after it still run.
    await expect.soft(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(confirm).toHaveCount(0)
    await expect(drawer).toHaveAttribute('data-mode', 'open')
    await q1.hover()
    await q1.getByRole('button', { name: 'Remove (Undo available)' }).click()
    // Clicking inside the confirm (a portal) never closes the drawer (C39).
    await confirm.locator('.thread-confirm-body').click()
    await expect(drawer).toHaveAttribute('data-mode', 'open')
    await confirm.getByRole('button', { name: 'Remove' }).click()
    const toast = panel.page().locator('.thread-toast')
    await expect(toast).toContainText(/^Removed “Buffer flush order” and \d+ follow-ups\. The messages stay in the transcript\./)
    await expect(rowTitled(drawer, 'Buffer flush order')).toHaveCount(0)
    await toast.click({ position: { x: 4, y: 4 } })
    await expect(drawer).toHaveAttribute('data-mode', 'open')
    await toast.getByRole('button', { name: 'Undo' }).click()
    await expect(rowTitled(drawer, 'Buffer flush order')).toHaveCount(1)
    await expect.poll(async () => (await readRecord(request, DENSE_SESSION)).threadMeta!.filter((m) => m.hidden === true).length).toBe(3)
  })

  test('pin rows: 30px single line, Remove pin with Undo puts the same pin back (C73)', async ({ page, request }) => {
    const { panel, drawer } = await openDrawer(page)
    await chip(drawer, 'Pinned').click()
    const pin = drawer.locator('.thread-tree-row[data-kind="pin"]').first()
    const pinId = (await pin.getAttribute('data-row-id'))!.replace(/^p:/, '')
    expect((await pin.locator('.thread-tree-title').innerText()).length).toBeLessThanOrEqual(81)
    await expect(pin).toHaveAttribute('title', /.+/)
    const before = (await readRecord(request, DENSE_SESSION)).pinnedMessages as Array<{ id?: string }>
    await pin.hover()
    await pin.getByRole('button', { name: 'Remove pin (Undo available)' }).click()
    const toast = panel.page().locator('.thread-toast')
    await expect(toast).toContainText('Removed pin')
    await expect(drawer.locator('.thread-tree-row--removed[data-of="pin"]')).toHaveCount(1)
    await expect.poll(async () => ((await readRecord(request, DENSE_SESSION)).pinnedMessages as unknown[]).length).toBe(before.length - 1)
    await toast.getByRole('button', { name: 'Undo' }).click()
    await expect.poll(async () => ((await readRecord(request, DENSE_SESSION)).pinnedMessages as Array<{ id?: string }>).map((p) => p.id))
      .toEqual(before.map((p) => p.id))
    expect(before.some((p) => p.id === pinId)).toBe(true)
  })

  test('F2 renames the cursor row inline and saves as the user title (C81)', async ({ page, request }) => {
    const { drawer } = await openDrawer(page)
    await rowTitled(drawer, 'Buffer flush order').focus()
    await page.keyboard.press('F2')
    const input = drawer.locator('.thread-inline-rename')
    await expect(input).toBeFocused()
    expect(await input.evaluate((el) => { const i = el as HTMLInputElement; return [i.selectionStart, i.selectionEnd, i.value.length] }))
      .toEqual([0, 'Buffer flush order'.length, 'Buffer flush order'.length])
    await page.keyboard.type('Flush ordering rules')
    await page.keyboard.press('Enter')
    await expect(rowTitled(drawer, 'Flush ordering rules')).toHaveCount(1)
    await expect(drawer).toHaveAttribute('data-mode', 'open')
    await expect.poll(async () => (await readRecord(request, DENSE_SESSION)).threadMeta!
      .find((m) => m.title === 'Flush ordering rules')?.titleSource).toBe('user')
    // Esc cancels an edit without closing the drawer.
    await rowTitled(drawer, 'Flush ordering rules').focus()
    await page.keyboard.press('F2')
    await page.keyboard.type('Discarded')
    await page.keyboard.press('Escape')
    await expect(rowTitled(drawer, 'Flush ordering rules')).toHaveCount(1)
    await expect(drawer).toHaveAttribute('data-mode', 'open')
  })
})
