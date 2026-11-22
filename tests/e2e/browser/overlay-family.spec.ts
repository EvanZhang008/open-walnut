/**
 * One overlay family (web/src/styles/overlay-family.css): every floating surface in this list opens
 * inside the window, wears the family's frame (radius, one shadow, one layer) and closes on Escape and
 * on a press outside it, through the one close hook (useOverlayLayer / useModalOverlay).
 *
 * 2026-11-21, the user: "why the ui still not consistent ... why they are not even consistent come on".
 * The source side (every portalled overlay carries a family class and a close hook) is
 * tests/web/overlay-family-ratchet.test.ts; this spec proves the family on the page.
 *
 * `page.goto('/')` is the initial load (the repo's sanctioned exception); every other step is a click.
 */
import { test, expect, type Locator, type Page } from '@playwright/test'
import { isolateUiPrefs, presetPanelView } from './todo-panel-helpers'
import { calendarEmptySlotPoint } from './calendar-helpers'
import { filterMenu, openFilterMenu } from './filter-bar-helpers'
import { openDraft } from './draft-helpers'

test.use({ viewport: { width: 1280, height: 820 } })
test.setTimeout(90_000)

function localDay(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

async function home(page: Page): Promise<void> {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await expect(page.locator('.todo-panel-item').first()).toBeVisible()
}

interface Case {
  name: string
  /** Opens the overlay and returns it. */
  open(page: Page): Promise<Locator>
  /** The family class it must wear, and the corner that class gives. */
  family: 'wn-overlay' | 'wn-dialog'
  radius: number
  /** A press outside closes it (dialogs with a Cancel close on Escape only). */
  outside: boolean
}

const CASES: Case[] = [
  {
    name: 'task menu (kebab)',
    family: 'wn-overlay', radius: 12, outside: true,
    async open(page) {
      await page.locator('.todo-panel-item').first().hover()
      await page.locator('.todo-panel-item .task-kebab-btn').first().click()
      return page.locator('.task-kebab-menu').first()
    },
  },
  {
    name: 'task menu (right-click)',
    family: 'wn-overlay', radius: 12, outside: true,
    async open(page) {
      await page.locator('.todo-panel-item .todo-item-title').first().click({ button: 'right' })
      return page.locator('.task-kebab-menu, .wn-context-menu').first()
    },
  },
  {
    name: 'Display popover',
    family: 'wn-overlay', radius: 12, outside: true,
    async open(page) {
      await page.locator('.dm-display-btn').first().click()
      return page.locator('.wn-overlay:visible').last()
    },
  },
  {
    name: 'Filter menu',
    family: 'wn-overlay', radius: 12, outside: true,
    async open(page) {
      await openFilterMenu(page)
      return filterMenu(page)
    },
  },
  {
    name: 'keyboard shortcuts dialog',
    family: 'wn-dialog', radius: 16, outside: false,
    async open(page) {
      await page.locator('body').press('Shift+Slash')
      return page.locator('.wn-dialog:visible').last()
    },
  },
  {
    name: 'calendar new-item popover',
    family: 'wn-overlay', radius: 12, outside: true,
    async open(page) {
      await page.click('a[href="/calendar"]')
      await expect(page.locator('.cal-grid')).toBeVisible()
      const slot = await calendarEmptySlotPoint(page, localDay(), 9)
      await page.mouse.click(slot.x, slot.y)
      return page.locator('.cal-create-popover')
    },
  },
]

async function expectFamily(page: Page, el: Locator, c: Case): Promise<void> {
  await expect(el).toBeVisible()
  await expect(el).toHaveClass(new RegExp(`\\b${c.family}\\b`))
  const vp = page.viewportSize()!
  // Settled placement: two frames with no movement.
  await expect.poll(() => el.evaluate((n) => new Promise<string>((done) => {
    const a = JSON.stringify(n.getBoundingClientRect())
    requestAnimationFrame(() => requestAnimationFrame(() => done(a === JSON.stringify(n.getBoundingClientRect()) ? 'still' : 'moving')))
  }))).toBe('still')
  const b = (await el.boundingBox())!
  expect(b.x, `${c.name}: left edge`).toBeGreaterThanOrEqual(0)
  expect(b.y, `${c.name}: top edge`).toBeGreaterThanOrEqual(0)
  expect(b.x + b.width, `${c.name}: right edge`).toBeLessThanOrEqual(vp.width + 0.5)
  expect(b.y + b.height, `${c.name}: bottom edge`).toBeLessThanOrEqual(vp.height + 0.5)
  const style = await el.evaluate((n) => {
    const s = getComputedStyle(n)
    return { radius: parseFloat(s.borderTopLeftRadius), z: s.zIndex }
  })
  expect(style.radius, `${c.name}: corner`).toBe(c.radius)
  // The menu and dialog layer (10000), from the tokens; never a value of its own.
  if (c.family === 'wn-overlay') expect(style.z, `${c.name}: layer`).toBe('10000')
  // Nothing lies over it (2026-11-21 review: a code menu's own backdrop sat above the menu, so every
  // press on a row closed the menu and ran nothing): the overlay's middle is the overlay.
  const onTop = await el.evaluate((n, p) => n.contains(document.elementFromPoint(p.x, p.y)), { x: b.x + b.width / 2, y: b.y + Math.min(24, b.height / 2) })
  expect(onTop, `${c.name}: on top where it is drawn`).toBe(true)
}

test.beforeEach(async ({ page }) => {
  await isolateUiPrefs(page)
  await presetPanelView(page, { section: 'all', project: '' })
})

for (const c of CASES) {
  test(`${c.name}: opens inside the window on the family, closes on Escape${c.outside ? ' and an outside press' : ''}`, async ({ page }) => {
    await home(page)
    const el = await c.open(page)
    await expectFamily(page, el, c)
    await page.keyboard.press('Escape')
    await expect(el).toBeHidden()

    if (!c.outside) return
    const again = await c.open(page)
    await expect(again).toBeVisible()
    const b = (await again.boundingBox())!
    const vp = page.viewportSize()!
    // A point well away from the overlay (the side with the most room).
    const x = b.x > vp.width - (b.x + b.width) ? 8 : vp.width - 8
    await page.mouse.click(x, vp.height - 8)
    await expect(again).toBeHidden()
  })
}

// 2026-11-22 audit: a menu opened from a composer's pill (permission mode, "+", the send split) covered
// the first line of the draft; the slash list cut its last row in half with no sign that it scrolls.
test.describe('composer menus', () => {
  async function draftWithText(page: Page): Promise<{ panel: Locator; box: Locator }> {
    await home(page)
    const panel = await openDraft(page)
    const input = panel.locator('.chat-input-container textarea').first()
    await input.fill('A draft line that must stay readable')
    return { panel, box: panel.locator('.chat-input-container').first() }
  }

  test('a menu from a composer pill opens above the whole composer, never over the draft', async ({ page }) => {
    const { panel, box } = await draftWithText(page)
    const opens: Array<[string, () => Promise<Locator>]> = [
      ['permission mode', async () => { await panel.locator('.mode-toggle-pill').first().click(); return page.locator('.permission-mode-menu') }],
      ['"+" menu', async () => { await panel.locator('.chat-plus-btn').first().click(); return page.locator('.chat-plus-menu') }],
    ]
    for (const [name, open] of opens) {
      const menu = await open()
      await expect(menu, name).toBeVisible()
      await expect(menu, name).toHaveClass(/\bwn-overlay\b/)
      const top = (await box.boundingBox())!.y
      await expect.poll(async () => { const b = (await menu.boundingBox())!; return b.y + b.height <= top + 0.5 }, { message: `${name} clears the composer` }).toBe(true)
      await page.keyboard.press('Escape')
      await expect(menu, name).toBeHidden()
    }
  })

  test('the slash list wears the family frame and fades its foot while rows are below', async ({ page }) => {
    const { panel } = await draftWithText(page)
    const input = panel.locator('.chat-input-container textarea').first()
    await input.fill('/')
    const wrap = panel.locator('.command-palette-wrap')
    await expect(wrap).toBeVisible()
    await expect(wrap).toHaveClass(/\bwn-overlay\b/)
    expect(await wrap.evaluate((n) => parseFloat(getComputedStyle(n).borderTopLeftRadius))).toBe(12)
    const list = wrap.locator('.command-palette')
    const overflows = await list.evaluate((n) => n.scrollHeight - n.clientHeight > 1)
    test.skip(!overflows, 'the fixture lists too few commands to scroll')
    await expect(list).toHaveAttribute('data-more', 'true')
    expect(await list.evaluate((n) => getComputedStyle(n).maskImage || getComputedStyle(n).webkitMaskImage)).toContain('gradient')
    await list.evaluate((n) => { n.scrollTop = n.scrollHeight })
    await expect(list).not.toHaveAttribute('data-more', 'true')
  })
})
