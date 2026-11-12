/**
 * The chat's reading split (2026-11-11, the user: "a split screen of top and bot ...
 * it won't touch the main scrolling location, keep it to the top panel, the input
 * box is in the bottom", "the right click or the message here can show split
 * window", "I don't want to use the heavy tree mode").
 *
 * On a 230-turn session with no questions, with real wheels, clicks and drags:
 * The panel mounts the newest 10 replies (221 to 230); every row used is among them.
 *  · a message's split button opens the reading pane on that message; the chat
 *    below goes to its end with the composer focused;
 *  · the reading pane holds its place while the chat below scrolls and a message
 *    is sent and lands at the bottom;
 *  · a message's right-click menu re-lands the reading pane on another message;
 *  · the divider drag shares the column; side by side and back; a reload keeps the
 *    split, its share, its way and the pane's place; close goes back to one pane;
 *  · the Send menu's "Send in split" keeps what the reader saw on top.
 * The rule: web/src/components/sessions/reader-split.tsx.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import { centreInHistory, sessionPanel } from './threads-helpers'

const SESSION_ID = 'pw-outline-window-session'
const TASK_ID = 'pw-task-outline-window'
const LAST_REPLY = 'outline filler reply 230'
/** Transcript uuids (test-server.ts longTranscript, prefix 0199bd): pair n is 1-based, written under `…-<n-1>`. */
const replyUuid = (n: number) => `0199bd03-0000-4aaa-8bbb-${String(n - 1).padStart(12, '0')}`

async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.WALNUT_TASK_DIR ? `${process.env.WALNUT_TASK_DIR}/shots` : `/tmp/reader-split/${test.info().project.name}`
  await fs.mkdir(dir, { recursive: true })
  await page.screenshot({ path: `${dir}/reader-${name}-${test.info().project.name}.png` })
}

async function openSession(page: Page): Promise<Locator> {
  const panel = sessionPanel(page, SESSION_ID)
  if (await panel.count() === 0) {
    const search = page.locator('.todo-search-input')
    const task = page.locator(`.todo-panel-item[data-task-id="${TASK_ID}"]`)
    await expect(async () => {
      if (await search.inputValue() !== SESSION_ID) await search.fill(SESSION_ID)
      await expect(task).toBeVisible({ timeout: 5_000 })
    }).toPass({ timeout: 30_000 })
    await task.locator('.todo-item-title').click()
  }
  await expect(panel).toBeVisible({ timeout: 20_000 })
  await expect(panel.locator('.session-panel-body .session-history')).toContainText(LAST_REPLY, { timeout: 30_000 })
  return panel
}

const mainBody = (panel: Locator) => panel.locator('.session-panel-body')
const readerBody = (panel: Locator) => panel.locator('.session-reader-body')
const readerPane = (panel: Locator) => panel.getByTestId('session-reader-pane')

/** The first row showing more than 12px below `scope`'s scroll box top edge, its top in the box, and the gap to the end. */
async function placeOf(scope: Locator): Promise<{ id: string; top: number; fromBottom: number }> {
  return scope.locator('.session-history').evaluate((el) => {
    const box = el.getBoundingClientRect()
    for (const row of Array.from(el.querySelectorAll<HTMLElement>('[data-message-id]'))) {
      if (row.parentElement?.closest('[data-message-id]')) continue
      const r = row.getBoundingClientRect()
      // A row showing only its last few pixels (the ask above a landed reply) is not what the reader sees.
      if (!r.height || r.bottom <= box.top + 12) continue
      return { id: row.dataset.messageId ?? '', top: Math.round(r.top - box.top), fromBottom: Math.round(el.scrollHeight - el.clientHeight - el.scrollTop) }
    }
    return { id: '', top: 0, fromBottom: Math.round(el.scrollHeight - el.clientHeight - el.scrollTop) }
  })
}

async function settled(page: Page, scope: Locator): Promise<{ id: string; top: number; fromBottom: number }> {
  let prev = await placeOf(scope)
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(200)
    const now = await placeOf(scope)
    if (now.id === prev.id && now.top === prev.top) return now
    prev = now
  }
  return prev
}

async function wheel(page: Page, scope: Locator, dy: number): Promise<void> {
  const box = (await scope.locator('.session-history').boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.wheel(0, dy)
  await page.waitForTimeout(300)
}

const row = (scope: Locator, n: number) => scope.locator(`[data-message-id="${replyUuid(n)}"]`).first()

test.describe('Reading split', () => {
  test.setTimeout(180_000)

  const flag = (on: boolean) => ({ data: { experimental: { chat_reading_split: on } } })
  test.afterEach(async ({ request }) => { await request.put('/api/config', flag(false)) })

  test('off by default: no Send in split, no split button, no menu item', async ({ page, request }) => {
    await request.put('/api/config', flag(false))
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    const panel = await openSession(page)
    const last = row(mainBody(panel), 230)
    await last.hover()
    await expect(last.getByTestId('msg-read-split')).toHaveCount(0)
    await last.locator('.session-msg-content').first().click({ button: 'right' })
    await expect(page.getByRole('menuitem', { name: 'Copy message', exact: true })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'Read in split' })).toHaveCount(0)
    await page.keyboard.press('Escape')
    const box = panel.locator('.session-panel-input textarea').first()
    await box.fill('just typing')
    await expect(panel.getByRole('button', { name: 'More send options' })).toHaveCount(0)
    await box.fill('')
  })

  test('read a message on top, ask below: open, hold, re-land, resize, turn, reload, close, send in split', async ({ page, request }) => {
    await request.put('/api/config', flag(true))
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await page.addStyleTag({ content: '.notification-toaster { display: none !important; }' })
    let panel = await openSession(page)
    await panel.getByRole('button', { name: 'Expand session to full screen' }).click()
    await expect(panel).toHaveClass(/open-walnut-fullscreen/)

    // 1. A message's split button: the pane opens on it, the chat goes to its end.
    const target = row(mainBody(panel), 223)
    await centreInHistory(page, mainBody(panel), target, { at: 0.4, tolerance: 60 })
    await target.hover()
    await target.getByTestId('msg-read-split').click()
    await expect(readerPane(panel)).toBeVisible()
    let top = await settled(page, readerBody(panel))
    expect(top.id, 'the reading pane opens on the message').toBe(replyUuid(223))
    expect(top.top).toBeLessThanOrEqual(12)
    await expect.poll(async () => (await placeOf(mainBody(panel))).fromBottom, { message: 'the chat below goes to its end' }).toBeLessThanOrEqual(40)
    await expect(panel.locator('.session-panel-input textarea').first()).toBeFocused()
    await shot(page, '1-open-on-message')

    // 2. The chat below scrolls and sends: the reading pane does not move.
    await wheel(page, mainBody(panel), -900)
    expect((await settled(page, readerBody(panel))).id).toBe(replyUuid(223))
    const box = panel.locator('.session-panel-input textarea').first()
    await box.click()
    await box.fill('split question one')
    await page.keyboard.press('Enter')
    await expect(mainBody(panel).locator('.session-history')).toContainText('split question one', { timeout: 15_000 })
    await page.waitForTimeout(1500)
    top = await settled(page, readerBody(panel))
    expect(top.id, 'a send below leaves the reading pane where it is').toBe(replyUuid(223))
    expect(top.fromBottom).toBeGreaterThan(200)
    await shot(page, '2-sent-below')

    // 3. Right-click another message below: the pane lands there.
    const other = row(mainBody(panel), 227)
    await centreInHistory(page, mainBody(panel), other, { at: 0.5, tolerance: 60 })
    // On a word: WebKit (the Mac app) selects the word under a right-press first, and the row's menu
    // must still open (useContextMenu ignorePressSelection).
    await other.locator('.session-msg-content p').first().click({ button: 'right', position: { x: 12, y: 8 } })
    expect(await page.evaluate(() => window.getSelection()?.toString() ?? ''), 'the menu opened over no lit selection').toBe('')
    await page.getByRole('menuitem', { name: 'Read in split' }).click()
    expect((await settled(page, readerBody(panel))).id).toBe(replyUuid(227))
    // The re-landed pane mounted after the reply streamed in: the question still sits above its answer.
    const order = await readerBody(panel).locator('.session-history').evaluate((el) => {
      const t = (el as HTMLElement).innerText
      return { question: t.indexOf('split question one'), answer: t.indexOf('Hello! I processed your message') }
    })
    expect(order.answer, 'the reply is in the reading pane').toBeGreaterThan(-1)
    expect(order.question, 'the question comes before its reply in the reading pane').toBeLessThan(order.answer)

    // 4. The divider: drag down, the pane grows; kept.
    const before = (await readerPane(panel).boundingBox())!
    const div = (await panel.getByTestId('session-reader-divider').boundingBox())!
    await page.mouse.move(div.x + div.width / 2, div.y + div.height / 2)
    await page.mouse.down()
    await page.mouse.move(div.x + div.width / 2, div.y + 120, { steps: 8 })
    await page.mouse.up()
    const grown = (await readerPane(panel).boundingBox())!
    expect(grown.height - before.height).toBeGreaterThan(80)

    // 5. Side by side, then a reload keeps it all.
    const beforeTurn = await settled(page, readerBody(panel))
    await panel.getByTestId('session-reader-orient').click()
    await expect(readerPane(panel)).toHaveClass(/is-side/)
    // The narrower pane rewraps its text; the message being read stays on screen in it (at its
    // top unless the pane, taller side by side, reaches the end of this short fixture).
    await settled(page, readerBody(panel))
    const turned = await readerBody(panel).locator('.session-history').evaluate((el, id) => {
      const box = el.getBoundingClientRect()
      const r = el.querySelector(`[data-message-id="${id}"]`)?.getBoundingClientRect()
      return r ? { top: Math.round(r.top - box.top), bottom: Math.round(r.bottom - box.top), height: Math.round(box.height), fromBottom: Math.round(el.scrollHeight - el.clientHeight - el.scrollTop) } : null
    }, beforeTurn.id)
    expect(turned, 'the message being read is still drawn').not.toBeNull()
    expect(turned!.top, 'turning the split keeps the message being read on screen').toBeGreaterThanOrEqual(-4)
    expect(turned!.top).toBeLessThan(turned!.height - 20)
    if (turned!.fromBottom > 4) expect(turned!.top, 'not at the end: at the top').toBeLessThanOrEqual(12)
    const side = (await readerPane(panel).boundingBox())!
    const sideBody = (await mainBody(panel).boundingBox())!
    expect(sideBody.x).toBeGreaterThan(side.x + side.width - 4)
    await shot(page, '3-side-by-side')
    // The reader's own scroll in the pane is kept as its place: up, so the pane holds a place
    // mid-history (side by side it is tall enough to reach the end of this short fixture).
    await wheel(page, readerBody(panel), -320)
    const kept = await settled(page, readerBody(panel))
    expect(kept.fromBottom, 'the pane is mid-history before the reload').toBeGreaterThan(100)
    await page.reload()
    await page.waitForLoadState('networkidle')
    panel = await openSession(page)
    await expect(readerPane(panel)).toBeVisible()
    await expect(readerPane(panel)).toHaveClass(/is-side/)
    expect((await settled(page, readerBody(panel))).id, 'a reload lands the pane where it was left').toBe(kept.id)
    await panel.getByTestId('session-reader-orient').click()
    await expect(readerPane(panel)).toHaveClass(/is-stack/)

    // 6. Close: one pane again, kept across a reload.
    await panel.getByTestId('session-reader-close').click()
    await expect(readerPane(panel)).toHaveCount(0)
    await page.reload()
    await page.waitForLoadState('networkidle')
    panel = await openSession(page)
    await expect(readerPane(panel)).toHaveCount(0)

    // 7. Send in split from the Send menu: what the reader saw stays on top.
    const seen = row(mainBody(panel), 224)
    await centreInHistory(page, mainBody(panel), seen, { at: 0.1, tolerance: 40 })
    const was = await settled(page, mainBody(panel))
    const box2 = panel.locator('.session-panel-input textarea').first()
    await box2.click()
    await box2.fill('split question two')
    await panel.getByRole('button', { name: 'More send options' }).click()
    await panel.getByTestId('send-in-split').click()
    await expect(readerPane(panel)).toBeVisible()
    await expect(mainBody(panel).locator('.session-history')).toContainText('split question two', { timeout: 15_000 })
    await page.waitForTimeout(1500)
    expect((await settled(page, readerBody(panel))).id, 'Send in split keeps the reader\'s message on top').toBe(was.id)
    await expect.poll(async () => (await placeOf(mainBody(panel))).fromBottom).toBeLessThanOrEqual(40)
    await shot(page, '4-send-in-split')
    // Leave the panel one pane for the next spec.
    await panel.getByTestId('session-reader-close').click()
  })
})
