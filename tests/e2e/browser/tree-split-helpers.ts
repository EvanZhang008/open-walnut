/**
 * Shared steps for the Tree Mode split specs (session-tree-split.spec.ts,
 * session-tree-panes-keep.spec.ts): open the split fixture in the full-screen
 * sheet, open a question from the list, read the pages on screen and the path
 * bar, select a passage with the real mouse, watch the sends.
 */
import { expect, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import { openThreadsSession, test } from './threads-helpers'
import { SPLIT_READY, SPLIT_SESSION, SPLIT_TASK } from './threads-fixture'

export type SentFrame = { message: string; hints?: Record<string, { arg?: string }> }

/** Every `session:send` the page puts on the socket (its text and its hints). */
export function captureSends(page: Page): SentFrame[] {
  const sent: SentFrame[] = []
  page.on('websocket', (socket) => socket.on('framesent', (frame) => {
    if (typeof frame.payload !== 'string') return
    try {
      const row = JSON.parse(frame.payload)
      if (row.method === 'session:send') sent.push(row.payload)
    } catch { /* not JSON */ }
  }))
  return sent
}

/** The question hint (its thread id) of the send whose text has `words`. */
export function hintOf(sent: SentFrame[], words: string): string | undefined {
  return sent.find((x) => x.message.includes(words))?.hints?.question?.arg
}

export async function shot(page: Page, name: string, target: Locator): Promise<void> {
  const dir = process.env.WALNUT_TASK_DIR ? `${process.env.WALNUT_TASK_DIR}/shots` : `/tmp/tree-split/${test.info().project.name}`
  await fs.mkdir(dir, { recursive: true })
  await target.screenshot({ path: `${dir}/split-${name}-${test.info().project.name}.png` })
}

/** The split fixture in the full-screen sheet (Tree Mode), at `width` x `height`. */
export async function openSheet(page: Page, width = 1440, height = 900): Promise<Locator> {
  await page.setViewportSize({ width, height })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.addStyleTag({ content: '.notification-toaster { display: none !important; }' })
  const panel = await openThreadsSession(page, SPLIT_SESSION, SPLIT_TASK, SPLIT_READY, { view: 'stack', pages: 'room' })
  await panel.getByRole('button', { name: 'Expand session to full screen' }).click()
  await expect(panel).toHaveClass(/open-walnut-fullscreen/)
  return panel
}

/** Open a question from the question list (the right page's map: the pages left of it have none). */
export async function openQuestion(panel: Locator, title: string): Promise<void> {
  const map = panel.locator('.session-panel-body .thread-map')
  await expect(map.locator('.thread-map-body')).toBeVisible()
  if (await map.getAttribute('data-shape') === 'rail') {
    const overlay = map.locator('.thread-map-overlay')
    if (await overlay.count() === 0) await map.locator('.thread-map-rail').dispatchEvent('click')
    await expect(overlay).toBeVisible()
  }
  await map.locator('.thread-map-icon[aria-label="Open the question list"]').click()
  const drawer = panel.page().locator('.thread-drawer')
  await expect(drawer).toBeVisible()
  await drawer.locator('.thread-drawer-chip', { hasText: /^All\b/ }).click()
  await drawer.locator('.thread-tree-row').filter({ has: panel.page().locator('.thread-tree-title', { hasText: title }) }).first().focus()
  await panel.page().keyboard.press('Enter')
  await expect(drawer).toHaveCount(0)
}

export const bar = (panel: Locator) => panel.locator('.tree-path-bar')
/** The pages left of the right one (the sibling page above it is not one of them). */
export const sidePages = (panel: Locator) => panel.locator('.tree-split-left:not([data-tree-half="S"])')
export const siblingPage = (panel: Locator) => panel.locator('.tree-split-left[data-tree-half="S"]')
export const leftHalf = (panel: Locator) => panel.locator('.tree-split-left[data-tree-half="L"]')
export const rightBody = (panel: Locator) => panel.locator('.session-panel-body')
export const leftHeader = (panel: Locator) => leftHalf(panel).locator('.thread-stack-header[data-half="L"]')
export const rightHeader = (panel: Locator) => rightBody(panel).locator('.thread-stack-header[data-half="R"]')
export const rightComposer = (panel: Locator) => panel.locator('.session-panel-input:not(.tree-split-input) textarea.chat-input-textarea')
export const leftComposer = (panel: Locator) => leftHalf(panel).locator('textarea.chat-input-textarea')

/** The pages on screen, left to right, as `<badge> <name>` (`L Main conversation`, `R 1`). */
export async function pagesOnScreen(panel: Locator): Promise<string[]> {
  const sides = await sidePages(panel).evaluateAll((els) => els.map((el) => {
    const h = el.querySelector('.thread-stack-header[data-half]')
    return `${h?.querySelector('.thread-half-badge')?.textContent ?? '?'} ${h?.querySelector('.thread-half-name')?.textContent ?? ''}`.trim()
  }))
  const right = rightHeader(panel)
  if (await right.count() === 0) return sides.length ? [...sides, '?'] : []
  const name = await right.locator('.thread-half-name').textContent()
  return [...sides, `R ${name ?? ''}`.trim()]
}

/** Each path bar segment as `<number> <title> [role]`. */
export async function segments(panel: Locator): Promise<string[]> {
  return bar(panel).locator('.tree-path-seg').evaluateAll((els) => els.map((el) => {
    const num = el.querySelector('.tree-path-num')?.textContent ?? ''
    const title = el.querySelector('.tree-path-title')?.textContent ?? ''
    const role = el.querySelector('.tree-path-role')?.textContent ?? ''
    return [num, title, role ? `[${role}]` : ''].filter(Boolean).join(' ')
  }))
}

/** The rects of `phrase` inside `scope`'s timeline (scrolled to the middle of its box first, when `scroll`). */
async function phraseRects(scope: Locator, phrase: string, scroll: boolean) {
  return scope.evaluate((root, [needle, doScroll]) => {
    for (const body of Array.from(root.querySelectorAll('.session-history [data-message-id] .session-msg-content'))) {
      const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT)
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const t = n as Text
        const at = t.data.indexOf(needle as string)
        if (at === -1) continue
        if (doScroll) t.parentElement!.scrollIntoView({ block: 'center' })
        const range = document.createRange()
        range.setStart(t, at)
        range.setEnd(t, at + (needle as string).length)
        return Array.from(range.getClientRects()).map((r) => ({ left: r.left, right: r.right, top: r.top, height: r.height }))
      }
    }
    return null
  }, [phrase, scroll] as const)
}

/** Drag-select `phrase` inside `scope`'s timeline with the real mouse. */
export async function selectIn(page: Page, scope: Locator, phrase: string): Promise<void> {
  expect(await phraseRects(scope, phrase, true), `passage "${phrase}" is not rendered`).not.toBeNull()
  await page.waitForTimeout(200)
  // Measured again after the scroll settled.
  const again = (await phraseRects(scope, phrase, false))!
  const first = again[0]
  const last = again[again.length - 1]
  await page.mouse.move(first.left + 1, first.top + first.height / 2)
  await page.mouse.down()
  await page.mouse.move((first.left + last.right) / 2, last.top + last.height / 2, { steps: 5 })
  await page.mouse.move(last.right - 1, last.top + last.height / 2, { steps: 5 })
  await page.mouse.up()
  expect((await page.evaluate(() => window.getSelection()?.toString() ?? '')).trim().length).toBeGreaterThan(0)
}

export async function send(box: Locator, text: string): Promise<void> {
  await box.click()
  await box.fill(text)
  await box.press('Enter')
  await expect(box).toHaveValue('')
}

/** Comment on `phrase` in `scope` from the selection pill: the comment waits for the next message. */
export async function commentOn(page: Page, scope: Locator, phrase: string, words: string): Promise<void> {
  await selectIn(page, scope, phrase)
  await page.locator('[data-testid="quote-pin-pill"] [data-testid="quote-comment-btn"]').click()
  const box = page.locator('[data-testid="quote-comment-input"]')
  await expect(box).toBeVisible()
  await box.fill(words)
  await page.locator('[data-testid="quote-comment-add"]').click()
  await expect(page.locator('[data-testid="quote-comment-box"]')).toHaveCount(0)
}

/** The rows a page's timeline draws (a turn adds the message and its answer). */
export const rowCountOf = (scope: Locator) => scope.locator('.session-history [data-message-id]').count()

/** A timeline's scroll box. */
export const scrollBoxOf = (scope: Locator) => scope.locator('.session-history').first()
export const scrollTopOf = (scope: Locator) => scrollBoxOf(scope).evaluate((el) => Math.round(el.scrollTop))
