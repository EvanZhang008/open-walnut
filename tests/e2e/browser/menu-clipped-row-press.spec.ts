/**
 * A press on a row of a CLIPPED menu runs that row, in every engine.
 *
 * A menu taller than the room beside its trigger is capped by `useMenuPlacement` and scrolls inside.
 * Its rows are buttons. When a press FOCUSES the row it lands on, WebKit scrolls the focused row into
 * view inside the box: a row cut by the box's edge moves up under the pointer between mousedown and
 * mouseup, the release lands on another row or on the box, and the click goes to the box (their
 * common ancestor), so nothing runs. Measured in WebKit (2026-11-09): down on "View project details",
 * up on "Delete project", nothing opened. So the engine's own focus-on-press never runs on a menu
 * row (utils/menu-press-focus.ts prevents it and focuses the row with preventScroll afterwards), also
 * in a menu whose own handler stops the press.
 *
 * Done the way a person does it: open the menu, wheel it until a row is cut by the bottom edge, press
 * the strip of that row that still shows, with the real mouse. No Playwright click (it scrolls the
 * row into view first, so it never sees the bug) and no scrollTop written by the test.
 */
import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import { isolateUiPrefs, openListProjectMenu, presetPanelView } from './todo-panel-helpers'

const API = `http://localhost:${process.env.PW_TEST_PORT ?? 3457}`

test.beforeEach(async ({ page }) => {
  await isolateUiPrefs(page)
  await presetPanelView(page, { section: 'all', project: '' })
})

type Cut = { key: string; x: number; y: number } | null

/** The first item row the box's bottom edge cuts with 5 to 14 px still showing, and a point on that strip. */
function cutRow(menu: Locator): Promise<Cut> {
  return menu.evaluate((box) => {
    const b = box.getBoundingClientRect()
    const bottom = b.top + box.clientTop + box.clientHeight
    for (const row of box.querySelectorAll<HTMLElement>('[role^="menuitem"]')) {
      const r = row.getBoundingClientRect()
      const shows = bottom - r.top
      if (r.bottom > bottom && shows >= 5 && shows <= 14) {
        return { key: row.getAttribute('data-menu-key') ?? '', x: r.left + r.width / 2, y: r.top + shows / 2 }
      }
    }
    return null
  })
}

/** Wait two frames with nothing moving, so the press meets the menu as it will stay. */
async function settled(menu: Locator): Promise<void> {
  await expect.poll(() => menu.evaluate((box) => new Promise<boolean>((done) => {
    const read = () => `${box.scrollTop}/${box.clientHeight}/${box.getBoundingClientRect().top}`
    const a = read()
    requestAnimationFrame(() => requestAnimationFrame(() => done(read() === a)))
  }))).toBe(true)
}

/** Wheel the menu down a few px at a time until a row is cut by its bottom edge. */
async function wheelToCutRow(page: Page, menu: Locator): Promise<NonNullable<Cut>> {
  const b = (await menu.boundingBox())!
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2)
  for (let i = 0; i < 80; i++) {
    await settled(menu)
    const cut = await cutRow(menu)
    if (cut) return cut
    await page.mouse.wheel(0, 4)
  }
  throw new Error('no row ever sat cut at the bottom edge')
}

async function recordPress(menu: Locator, stopPress: boolean): Promise<void> {
  await menu.evaluate((box, stop) => {
    const w = window as unknown as { __press: Record<string, unknown> }
    const key = (t: EventTarget | null) => (t instanceof Element ? t.closest('[data-menu-key]')?.getAttribute('data-menu-key') : null) ?? 'none'
    w.__press = { down: null, downTop: null, upTop: null, click: 'none', enginePrevented: null }
    box.addEventListener('mousedown', (e) => { w.__press.down = key(e.target); w.__press.downTop = box.scrollTop }, { capture: true, once: true })
    // Seen at the row, after every capture listener: is the engine's own focus-on-press (the step
    // WebKit follows with a scroll) still going to run? It must not.
    box.addEventListener('mousedown', (e) => {
      w.__press.enginePrevented = e.defaultPrevented
      // A menu whose own handler keeps the press from the row behind it (ThreadPathBar, CodeContextMenu).
      if (stop) e.stopPropagation()
    }, { once: true })
    box.addEventListener('mouseup', () => { w.__press.upTop = box.scrollTop }, { capture: true, once: true })
    document.addEventListener('click', (e) => { w.__press.click = key(e.target) }, { capture: true, once: true })
  }, stopPress)
}

async function pressCutRow(page: Page, request: APIRequestContext, stopPress: boolean): Promise<void> {
  const project = `ClipMenu${Date.now().toString(36)}`
  const res = await request.post(`${API}/api/tasks`, { data: { title: 'Clipped menu seed', project, pinned: false } })
  expect(res.ok()).toBeTruthy()
  const seed = (await res.json()) as { task?: { id?: string }; id?: string }
  const seedId = seed.task?.id ?? seed.id
  test.info().attach('seed', { body: String(seedId) })
  // The press may run any row (a delete asks first, so nothing is lost); the seed goes either way.
  try {
    // Short enough that the project menu is capped and scrolls inside.
    await page.setViewportSize({ width: 1100, height: 360 })
    await page.goto('/')

    // A live update from another spec can close the menu under the press: retry the whole gesture,
    // but only for that. What the press did is asserted once, outside the retry.
    let press: Record<string, unknown> = {}
    let cut: NonNullable<Cut> = { key: '', x: 0, y: 0 }
    await expect(async () => {
      if (await page.getByRole('menu').count()) await page.keyboard.press('Escape')
      const menu = await openListProjectMenu(page, project)
      await settled(menu)
      const overflow = await menu.evaluate((el) => el.scrollHeight - el.clientHeight)
      expect(overflow, 'the menu must be capped for this test to mean anything').toBeGreaterThan(20)

      cut = await wheelToCutRow(page, menu)
      await recordPress(menu, stopPress)
      await page.mouse.move(cut.x, cut.y)
      await page.mouse.down()
      await page.mouse.up()
      press = await page.evaluate(() => (window as unknown as { __press: Record<string, unknown> }).__press)
      expect(press.down, 'the press landed on the cut row').toBe(cut.key)
    }).toPass({ timeout: 45_000 })
    expect(press.enginePrevented, "the engine's own focus-on-press never runs on a menu row").toBe(true)
    expect(press.upTop, 'the box did not scroll under the press').toBe(press.downTop)
    expect(press.click, 'the click reached the row that was pressed').toBe(cut.key)
  } finally {
    if (seedId) await request.delete(`${API}/api/tasks/${seedId}`).catch(() => {})
  }
}

test('a press on a row the box edge cuts runs that row', async ({ page, request }) => {
  await pressCutRow(page, request, false)
})

test('the same holds in a menu whose own handler stops the press', async ({ page, request }) => {
  await pressCutRow(page, request, true)
})
