/**
 * Checks remote-hosts-every-button.spec.ts and remote-hosts-narrow.spec.ts share (2026-11-05
 * review, round 5):
 *  - a form opened in place (a secret's, by Add or Edit) lands with its start right below the
 *    page bar, its first control focused, Save and Cancel whole in the window and at its own end,
 *    over no row of it (Edit had opened it at the window's foot, the focus left on Edit, the
 *    pinned Save across its first row);
 *  - nothing a host's row says is said again in its open Details (the reboot warning was on the
 *    row and again in Status).
 * No tests in this file (Playwright refuses a test() call from an imported module).
 */
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { expect, type Locator, type Page } from '@playwright/test'

const SHOTS = process.env.PW_SHOTS_DIR || path.join(process.cwd(), 'test-results', 'rh-every-button-shots')

/** How far below the pane's top edge a landed form starts (BELOW_BAR_PX), and the slack allowed. */
const BELOW_BAR_PX = 52
const SLACK_PX = 8

export async function expectFormLanded(page: Page, form: Locator, first: Locator): Promise<void> {
  await expect(first).toBeFocused()
  const where = () => form.evaluate((el) => {
    const pane = el.closest('.settings-pane') as HTMLElement
    const paneTop = pane.getBoundingClientRect().top
    // The compact bar, when it shows, sits over the pane's top.
    const bar = pane.querySelector<HTMLElement>('.settings-pane-stickybar-inner')
    const shown = bar && getComputedStyle(bar).visibility !== 'hidden' && getComputedStyle(bar).display !== 'none'
    const barBottom = shown ? bar.getBoundingClientRect().bottom : paneTop
    const box = el.getBoundingClientRect()
    const atEnd = pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 2
    return { fromPaneTop: Math.round(box.top - paneTop), belowBar: Math.round(box.top - barBottom), bottom: Math.round(box.bottom), viewBottom: Math.round(pane.getBoundingClientRect().bottom), atEnd }
  })
  // The landing runs a frame after the press, and holds through late layout.
  await expect.poll(async () => (await where()).belowBar, { message: 'the form starts below the page bar' }).toBeGreaterThanOrEqual(0)
  const w = await where()
  // Right below the bar, unless the page ends first (then all of the form shows).
  if (w.fromPaneTop > BELOW_BAR_PX + SLACK_PX) {
    expect(w.atEnd, `a form at ${w.fromPaneTop} px from the pane's top, with page left below it`).toBe(true)
    expect(w.bottom, `a form at ${w.fromPaneTop} px is whole in the window`).toBeLessThanOrEqual(w.viewBottom)
  }
  // Save and Cancel at the form's own end, whole in the window, over no row of the form.
  const strip = await form.evaluate((el) => {
    const actions = el.querySelector<HTMLElement>('.secret-editor-actions')!
    const a = actions.getBoundingClientRect()
    const rows = [...el.children].filter((c) => c !== actions)
    return {
      position: getComputedStyle(actions).position,
      last: el.lastElementChild === actions,
      under: rows.filter((r) => { const b = r.getBoundingClientRect(); return b.bottom > a.top + 1 && b.top < a.bottom - 1 }).map((r) => (r.textContent ?? '').trim().slice(0, 40)),
    }
  })
  expect(strip.position).not.toMatch(/sticky|fixed/)
  expect(strip.last).toBe(true)
  expect(strip.under, 'rows under Save and Cancel').toEqual([])
  await expect(form.getByTestId('secret-save')).toBeInViewport({ ratio: 1 })
  await expect(form.getByTestId('secret-cancel')).toBeInViewport({ ratio: 1 })
}

const norm = (t: string) => t.replace(/\s+/g, ' ').trim().replace(/[.\s]+$/, '')

/** No line of a host's row (its state line included) is said again in its open Details. Returns the lines compared. */
export async function expectRowLinesNotRepeated(rowEl: Locator, details: Locator): Promise<string[]> {
  const lines = (await rowEl.evaluate((el) => [...el.querySelectorAll('.rh-row-line, [data-testid="rh-row-state"]')]
    .filter((l) => !l.closest('[data-testid="rh-details"]'))
    .map((l) => l.textContent ?? ''))).map(norm).filter((l) => l.length >= 16)
  const said = norm((await details.textContent()) ?? '')
  for (const line of lines) expect(said, `the row's line "${line}" is said again in its Details`).not.toContain(line)
  return lines
}

/**
 * A screenshot of the window's strip that holds `parts`, from the window's top (the page bar in it)
 * to the last part's end, as wide as they are. Nothing is scrolled to take it.
 */
export async function shotPart(page: Page, name: string, ...parts: Locator[]): Promise<string> {
  mkdirSync(SHOTS, { recursive: true })
  const engine = page.context().browser()?.browserType().name() ?? 'browser'
  const view = page.viewportSize()!
  const boxes = await Promise.all(parts.map(async (p) => (await p.boundingBox())!))
  const left = Math.min(...boxes.map((b) => b.x))
  const right = Math.max(...boxes.map((b) => b.x + b.width))
  const bottom = Math.max(...boxes.map((b) => b.y + b.height))
  const x = Math.max(0, Math.floor(left - 16))
  const width = Math.min(view.width - x, Math.ceil(right - left + 32))
  const height = Math.max(1, Math.min(view.height, Math.ceil(bottom + 16)))
  const file = `${SHOTS}/${engine}-${name}.png`
  await page.screenshot({ path: file, clip: { x, y: 0, width, height }, scale: 'css' })
  return file
}
