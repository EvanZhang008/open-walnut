/**
 * The session header's tool row uses the room it has (2026-10-04 report: in a
 * mid-width column the row left 60px of empty space beside the "..." menu while
 * Locate, Lock and Open-in-new-tab sat in that menu, and Lock, the button people
 * use to keep a panel, was one of them).
 *
 * Cause: the chips and the window buttons shared one strict priority queue, so
 * the first item that did not fit (a hidden Terminal, or a 90px Heavy pill)
 * kept every 24px button behind it out of the row. Now the chips keep their
 * order and the window buttons fill what is left; Lock, Expand and Close always
 * stay. The panel is drawn at its width from the first frame (the clamp is
 * installed before the app loads), as a window opened narrow or a Mac app
 * launched zoomed draws it.
 *
 * Rules, at every width from 200px to 520px:
 *  - Lock, Expand and Close are on the row, as one line, inside the panel;
 *  - the room left before the window buttons is smaller than every window
 *    button that was sent to the "..." menu, and than the first hidden chip;
 *  - the "..." menu never lists Lock, Expand or Close.
 * Runs in Chromium and, with PW_WEBKIT=1 --project webkit, in WebKit (the Mac app).
 */
import fs from 'node:fs/promises'
import { test, expect, type BrowserContext, type Locator, type Page } from '@playwright/test'
import { CTRL_SESSION, mockControlsSession } from './composer-controls-overflow-helpers'

const SHOT_DIR = process.env.PW_SCREENSHOT_DIR ?? '/tmp/session-header-room'

test.use({ viewport: { width: 1280, height: 800 } })

/** The order chips come back as the row widens; the movable window buttons fill whatever room the chips leave. */
const CHIP_ORDER = ['plan', 'fork', 'changed', 'files', 'board', 'terminal']
const WINDOW_BUTTONS = ['locate', 'popout']
const ALWAYS_ON_THE_ROW = ['lock', 'expand', 'close']

/** A fresh page per call: the panel is drawn at `width` from its first frame. */
async function openAtWidth(context: BrowserContext, width: number | null): Promise<{ page: Page; panel: Locator }> {
  const page = await context.newPage()
  await mockControlsSession(page, CTRL_SESSION)
  await page.addInitScript(({ list, px }) => {
    sessionStorage.setItem('open-walnut-home-session-columns', JSON.stringify(list.map((id: string) => ({ id, locked: false }))))
    if (px == null) return
    // The init script runs before the document has a root: install the clamp the moment it has one,
    // which is before the app's first paint.
    const install = () => {
      if (!document.documentElement || document.getElementById('pw-column-clamp')) return !!document.documentElement
      const style = document.createElement('style')
      style.id = 'pw-column-clamp'
      style.textContent = `.main-page-session-column {
        width: ${px}px !important; max-width: ${px}px !important; min-width: 0 !important; flex: 0 0 ${px}px !important;
      }`
      document.documentElement.appendChild(style)
      return true
    }
    if (!install()) {
      const mo = new MutationObserver(() => { if (install()) mo.disconnect() })
      mo.observe(document, { childList: true })
    }
  }, { list: [CTRL_SESSION], px: width })
  await page.goto('/')
  const panel = page.locator(`.main-page-session-column .session-panel[data-session-id="${CTRL_SESSION}"]`)
  await expect(panel).toBeVisible({ timeout: 90_000 })
  await expect(panel.locator('.session-meta-row-2 [data-header-id="close"]')).toBeVisible({ timeout: 20_000 })
  // Locate appears once the session's task has loaded; a sweep that misses it would test a row without it.
  await expect(panel.locator('.session-meta-row-2 [data-header-id="locate"]')).toBeAttached({ timeout: 30_000 })
  return { page, panel }
}

interface ToolRowRead {
  visible: string[]
  hidden: string[]
  lines: number
  overflowBy: number
  /** Room between the last chip (or the "...") and the window buttons, past the row's own 6px gap. */
  freeBeforeWindowButtons: number
  moreVisible: boolean
  widths: Record<string, number>
}

async function readToolRow(panel: Locator): Promise<ToolRowRead> {
  return panel.locator('.session-meta-row-2').evaluate((row) => {
    const items = [...row.querySelectorAll<HTMLElement>('[data-header-id]')]
      .filter((el) => el.childElementCount > 0 || (el.textContent ?? '').trim())
    const shown = items.filter((el) => el.dataset.hidden !== 'true')
    const centers = shown.map((el) => { const b = el.getBoundingClientRect(); return (b.top + b.bottom) / 2 })
    const rowBox = row.getBoundingClientRect()
    const chips = row.querySelector('.session-meta-row-2-chips')!
    const windows = row.querySelector('.session-panel-window-controls')!.getBoundingClientRect()
    const chipRights = [...chips.querySelectorAll<HTMLElement>('[data-header-id], [data-header-more]')]
      .filter((el) => el.dataset.hidden !== 'true' && el.getBoundingClientRect().width > 0)
      .map((el) => el.getBoundingClientRect().right)
    const widths: Record<string, number> = {}
    for (const el of shown) widths[el.dataset.headerId!] = el.getBoundingClientRect().width
    return {
      visible: shown.map((el) => el.dataset.headerId!),
      hidden: items.filter((el) => el.dataset.hidden === 'true').map((el) => el.dataset.headerId!),
      lines: centers.length && Math.max(...centers) - Math.min(...centers) > 2 ? 2 : 1,
      overflowBy: Math.max(0, ...shown.map((el) => Math.round(el.getBoundingClientRect().right - rowBox.right))),
      freeBeforeWindowButtons: windows.left - 6 - (chipRights.length ? Math.max(...chipRights) : chips.getBoundingClientRect().left),
      moreVisible: !!row.querySelector('[data-header-more]'),
      widths,
    }
  })
}

async function settled(panel: Locator, page: Page): Promise<ToolRowRead> {
  let last = await readToolRow(panel)
  await expect.poll(async () => {
    await page.waitForTimeout(150)
    const now = await readToolRow(panel)
    const same = JSON.stringify(now) === JSON.stringify(last)
    last = now
    return same
  }, { timeout: 15_000 }).toBe(true)
  return last
}

/** What each movable item measures when the row is wide enough to show them all. */
async function measureNaturalWidths(context: BrowserContext): Promise<Record<string, number>> {
  const { page, panel } = await openAtWidth(context, null)
  const wide = await settled(panel, page)
  await page.close()
  expect(wide.hidden, 'a wide column shows every item').toEqual([])
  return wide.widths
}

test('a panel drawn at any width keeps Lock on the row and never leaves room for the next button it hid', async ({ context }) => {
  test.setTimeout(900_000)
  const errors: string[] = []
  context.on('page', (p) => p.on('pageerror', (e) => errors.push(e.message)))
  await fs.mkdir(SHOT_DIR, { recursive: true })
  const natural = await measureNaturalWidths(context)
  for (const id of ALWAYS_ON_THE_ROW) expect(natural[id], `${id} is on the wide row`).toBeGreaterThan(0)

  const violations: string[] = []
  const table: string[] = [`natural widths: ${JSON.stringify(Object.fromEntries(Object.entries(natural).map(([k, v]) => [k, Math.round(v * 10) / 10])))}`]
  const tested: number[] = []
  for (let width = 200; width <= 520; width += 20) {
    const { page, panel } = await openAtWidth(context, width)
    const row = await settled(panel, page)
    tested.push(width)
    const label = `${width}px`
    expect(row.lines, `${label}: the tool row wrapped`).toBeLessThanOrEqual(1)
    expect(row.overflowBy, `${label}: the tool row runs past the panel`).toBeLessThanOrEqual(0)
    for (const id of ALWAYS_ON_THE_ROW) if (!row.visible.includes(id)) violations.push(`${label}: ${id} is not on the row (visible: ${row.visible.join(',')})`)
    // The three that matter most end the row, in this order, whatever else comes and goes before them.
    if (row.visible.slice(-3).join() !== ALWAYS_ON_THE_ROW.join()) violations.push(`${label}: the row ends ${row.visible.slice(-3).join(',')}, not ${ALWAYS_ON_THE_ROW.join(',')}`)
    table.push(`${label}: visible [${row.visible.join(',')}] menu [${row.hidden.join(',')}] free ${Math.round(row.freeBeforeWindowButtons)}px`)
    // What was sent to the menu did not fit: the room left is smaller than the first hidden chip
    // (chips keep their order) and than any hidden window button (they fill what the chips leave).
    // One px of fit slack plus one of sub-pixel rounding stay unspent on purpose.
    const nextChip = CHIP_ORDER.find((id) => row.hidden.includes(id))
    const candidates = [...(nextChip ? [nextChip] : []), ...WINDOW_BUTTONS.filter((id) => row.hidden.includes(id))]
    for (const id of candidates) {
      if (!natural[id]) continue
      const gap = WINDOW_BUTTONS.includes(id) ? 3 : 6
      if (row.freeBeforeWindowButtons >= natural[id] + gap + 2) {
        violations.push(`${label}: ${Math.round(row.freeBeforeWindowButtons)}px free, yet ${id} (${Math.round(natural[id])}px) is in the menu`)
      }
    }
    if ([200, 260, 300, 380].includes(width)) await panel.locator('.session-panel-header').screenshot({ path: `${SHOT_DIR}/${test.info().project.name}-${width}.png` })
    await page.close()
  }
  await fs.writeFile(`${SHOT_DIR}/${test.info().project.name}-table.txt`, table.join('\n') + '\n')
  expect(tested.length).toBeGreaterThan(15)
  expect(violations, violations.join('\n')).toEqual([])
  expect(errors, errors.join('\n')).toEqual([])
})

test('Lock stays on a 200px row, works from there, and the "..." menu never lists Lock, Expand or Close', async ({ context }) => {
  test.setTimeout(120_000)
  const { page, panel } = await openAtWidth(context, 200)
  const row = await settled(panel, page)
  expect(row.visible).toEqual(expect.arrayContaining(ALWAYS_ON_THE_ROW))
  expect(row.visible.slice(-3), 'Lock, Expand and Close end the row, in that order').toEqual(ALWAYS_ON_THE_ROW)
  expect(row.overflowBy).toBeLessThanOrEqual(0)
  expect(row.lines).toBeLessThanOrEqual(1)
  expect(row.moreVisible, 'something is in the menu at 200px').toBe(true)

  const lock = panel.locator('.session-meta-row-2 [data-header-id="lock"]')
  await expect(lock).toHaveAttribute('aria-pressed', 'false')
  await lock.click()
  await expect(lock).toHaveAttribute('aria-pressed', 'true')
  await expect(lock).toHaveClass(/is-locked/)
  await lock.click()
  await expect(lock).toHaveAttribute('aria-pressed', 'false')

  await panel.getByTestId('session-header-more-btn').click()
  const more = page.getByTestId('session-header-more-menu')
  await expect(more).toBeVisible()
  for (const id of ALWAYS_ON_THE_ROW) await expect(more.getByTestId(`session-header-more-item-${id}`)).toHaveCount(0)
  await page.keyboard.press('Escape')
})
