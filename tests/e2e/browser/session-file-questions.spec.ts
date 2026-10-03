/**
 * Questions about a passage of a FILE in the Files tab: the comment card beside
 * the passage, the same card the conversation uses.
 *
 * Covers: in the markdown preview (the WYSIWYG editor) the bubble menu's `Ask
 * here` opens a draft card beside the selection, its send numbers the question,
 * puts an anchor with a `file:` parent on the record and lands the reply in the
 * card; the asked passage is marked and a click on it reopens the card; the
 * sidebar row opens the Files tab on that file with the card beside the passage;
 * the inline `Ask` on a hovered block asks about the whole block; the main
 * composer with the question as its target replies into the card and the main
 * conversation stays a plain chat; Tree Mode names the file on the question's
 * page; the HTML preview (an iframe) offers the two-action pill and the card
 * follows its passage there too.
 *
 * Chromium and WebKit. The fixture files live in the thread sessions' cwd
 * (test-server.ts: cache-design.md, cache-report.html).
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import {
  modePill, nextQuestionNumber, openThreadsSession, readRecord, resetThreadsFixture, switchView,
} from './threads-helpers'
import { TAGGED_READY, TAGGED_SESSION, TAGGED_TASK } from './threads-fixture'

const MD_FILE = 'cache-design.md'
const HTML_FILE = 'cache-report.html'
const MD_PASSAGE = 'A late flush can hide an'
const MD_PASSAGE_FULL = 'A late flush can hide an earlier update to the same slot'
const MD_BLOCK = 'Orphaned ledger rows stay until the next compaction'
const HTML_PASSAGE = 'The p99 rose to 180 ms on Thursday'

async function shot(page: Page, name: string): Promise<void> {
  const dir = `/tmp/one-sidebar/e2e/${test.info().project.name}`
  await fs.mkdir(dir, { recursive: true })
  await page.screenshot({ path: `${dir}/${name}.png` })
}

async function openSession(page: Page): Promise<Locator> {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.setViewportSize({ width: 1400, height: 820 })
  return openThreadsSession(page, TAGGED_SESSION, TAGGED_TASK, TAGGED_READY, { view: 'linear' })
}

async function openFile(page: Page, panel: Locator, name: string): Promise<Locator> {
  if (!(await panel.locator('.session-file-explorer').isVisible())) {
    await panel.getByRole('button', { name: 'Files' }).click()
  }
  const explorer = panel.locator('.session-file-explorer')
  await expect(explorer).toBeVisible({ timeout: 10_000 })
  const row = explorer.locator('.session-file-explorer-node', { hasText: name }).first()
  await expect(row).toBeVisible({ timeout: 10_000 })
  await row.click()
  const view = explorer.locator('.file-content-view')
  await expect(view).toBeVisible({ timeout: 10_000 })
  return view
}

const fileCard = (view: Locator) => view.locator('.fv-thread-layer .thread-card')
const fileRail = (view: Locator) => view.locator('[data-testid="file-question-rail"]')

/** Viewport rects of `needle` inside `root` (the top document). */
async function textRects(root: Locator, needle: string) {
  const rects = await root.evaluate((el, phrase) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const at = (n as Text).data.indexOf(phrase)
      if (at === -1) continue
      const r = document.createRange()
      r.setStart(n, at)
      r.setEnd(n, at + phrase.length)
      return Array.from(r.getClientRects()).map((b) => ({ left: b.left, right: b.right, top: b.top, height: b.height }))
    }
    return null
  }, needle)
  expect(rects, `"${needle}" is not rendered`).not.toBeNull()
  return rects!
}

async function dragSelect(page: Page, rects: Array<{ left: number; right: number; top: number; height: number }>) {
  const first = rects[0]
  const last = rects[rects.length - 1]
  await page.mouse.move(first.left + 1, first.top + first.height / 2)
  await page.mouse.down()
  await page.mouse.move((first.left + last.right) / 2, (first.top + last.top) / 2 + first.height / 2, { steps: 4 })
  await page.mouse.move(last.right - 1, last.top + last.height / 2, { steps: 4 })
  await page.mouse.up()
}

test.describe('Questions about a file passage (Files tab)', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(240_000)

  test.beforeEach(async ({ request }) => {
    await resetThreadsFixture(request, TAGGED_SESSION)
  })

  test('Ask here on a selection in the markdown preview: a draft card beside the passage, numbered by its send, the reply inside', async ({ page, request }) => {
    const panel = await openSession(page)
    const next = await nextQuestionNumber(request, TAGGED_SESSION)
    const view = await openFile(page, panel, MD_FILE)
    const editor = view.locator('.fv-wysiwyg-editor .ProseMirror')
    await expect(editor).toContainText(MD_PASSAGE_FULL)
    await expect(view.locator('.fv-thread-layer')).toHaveCount(1)

    // No question about this file yet: no rail.
    await expect(fileRail(view)).toHaveCount(0)
    const rects = await textRects(editor, MD_PASSAGE_FULL)
    await dragSelect(page, rects)
    const askHere = page.locator('[data-testid="bubble-ask-here"]')
    await expect(askHere).toBeVisible()
    await expect(page.locator('[data-testid="bubble-ask-quote"]')).toHaveText('Quote in chat')
    // mousedown is the bubble's trigger (it keeps the selection alive).
    await askHere.dispatchEvent('mousedown')

    const card = fileCard(view)
    await expect(card).toBeVisible()
    await expect(card).toHaveAttribute('data-draft', 'true')
    await expect(card.locator('.thread-card-title')).toHaveText('New question')
    const input = card.locator('.thread-card-input')
    await expect(input).toBeFocused()
    // Beside the passage: below its last line, inside the file view.
    const passage = (await textRects(editor, MD_PASSAGE_FULL)).at(-1)!
    const cb = (await card.boundingBox())!
    const vb = (await view.boundingBox())!
    expect(cb.y).toBeGreaterThanOrEqual(passage.top + passage.height - 1)
    expect(cb.y - (passage.top + passage.height)).toBeLessThan(40)
    expect(cb.x).toBeGreaterThanOrEqual(vb.x)
    expect(cb.x + cb.width).toBeLessThanOrEqual(vb.x + vb.width + 1)
    // The rail appears with the draft: one dashed mark, under the toolbar at the left edge.
    const rail = fileRail(view)
    await expect(rail.locator('.thread-map-mark')).toHaveCount(1)
    await expect(rail.locator('.thread-map-mark')).toHaveAttribute('data-kind', 'pending')
    const rb = (await rail.boundingBox())!
    const tb = (await view.locator('.fv-html-toolbar').first().boundingBox())!
    expect(rb.y).toBeGreaterThanOrEqual(tb.y + tb.height)
    expect(rb.y - (tb.y + tb.height)).toBeLessThan(12)
    expect(rb.x - vb.x).toBeLessThan(10)
    await shot(page, 'file-q-draft')

    await input.fill('Why keep both versions until compaction?')
    await input.press('Enter')
    await expect(card).not.toHaveAttribute('data-draft', 'true', { timeout: 30_000 })
    await expect(card.locator('.thread-card-head .thread-map-num')).toHaveText(String(next))
    // The question as typed: no file line, no quote block.
    await expect(card.locator('.thread-card-q').first()).toHaveText('Why keep both versions until compaction?')
    await expect(card.locator('.thread-card-body')).toContainText('processed your message', { timeout: 60_000 })
    expect(await card.locator('.thread-card-body').innerText()).not.toMatch(/\[Q\s?\d+\]|About `/)
    await expect(input).toHaveAttribute('placeholder', /Reply in/)
    // The record: an anchor whose parent names the file, and a numbered meta entry.
    const rec = await readRecord(request, TAGGED_SESSION)
    const anchor = (rec.threadAnchors as Array<{ msgId: string; parent: string; quote?: { exact: string } }>)
      .find((a) => a.parent.startsWith('file:') && a.parent.endsWith(`/${MD_FILE}`))
    expect(anchor, 'a file anchor on the record').toBeTruthy()
    expect(anchor!.quote?.exact).toContain(MD_PASSAGE)
    expect(rec.threadMeta!.find((m) => m.headId === anchor!.msgId)?.seq).toBe(next)
    // The sidebar lists it (a rail of marks: the chat column beside the Files tab
    // is narrow); the bubble names the file by its path from the session's cwd.
    await expect(panel.locator('.thread-map [data-kind="thread"]')).toHaveCount(3)
    // The session rail's marks sit close together (10px pitch, not 14).
    const markBox = (await panel.locator('.thread-map .thread-map-mark').first().boundingBox())!
    expect(markBox.height).toBeLessThanOrEqual(10.5)
    // The file's rail: the question's mark is now a solid, current one.
    await expect(rail.locator('.thread-map-mark')).toHaveCount(1)
    await expect(rail.locator('.thread-map-mark')).toHaveAttribute('data-kind', 'thread')
    await expect(rail.locator('.thread-map-mark')).toHaveAttribute('data-current', 'true')
    const bubble = panel.locator('.session-history .session-msg--threaded').last()
    await expect(bubble).toContainText(`About ${MD_FILE}:`)
    await expect(bubble).not.toContainText('/projects/editor-fixture/')
    await shot(page, 'file-q-answered')

    // Esc closes; the passage is marked and a click on it reopens the card.
    await input.press('Escape')
    await expect(card).toHaveCount(0)
    expect(await page.evaluate(() => CSS.highlights?.has('thread-mark-neutral') ?? false), 'the passage wears a mark').toBe(true)
    const r = (await textRects(editor, MD_PASSAGE_FULL))[0]
    await page.mouse.click(r.left + 8, r.top + r.height / 2)
    await expect(card).toBeVisible()
    await expect(card.locator('.thread-card-head .thread-map-num')).toHaveText(String(next))

    // The rail's list: hovering names the question; its row opens the card.
    await input.press('Escape')
    await expect(card).toHaveCount(0)
    await rail.locator('.thread-map-rail').hover()
    const list = rail.locator('.thread-map-overlay')
    await expect(list).toBeVisible()
    await expect(list.locator('.thread-map-title')).toHaveText('In this file')
    await expect(list.locator('.thread-map-row')).toHaveCount(1)
    await expect(list.locator('.thread-map-row .thread-map-num')).toHaveText(String(next))
    await shot(page, 'file-q-rail-list')
    await list.locator('.thread-map-row').click()
    await expect(list).toHaveCount(0)
    await expect(card).toBeVisible()
    await expect(card.locator('.thread-card-head .thread-map-num')).toHaveText(String(next))
  })

  test('a sidebar row opens the Files tab on the file with the card beside the passage; the composer targets it; Main is plain chat', async ({ page, request }) => {
    const panel = await openSession(page)
    const next = await nextQuestionNumber(request, TAGGED_SESSION)
    const view = await openFile(page, panel, MD_FILE)
    const editor = view.locator('.fv-wysiwyg-editor .ProseMirror')
    await dragSelect(page, await textRects(editor, MD_PASSAGE_FULL))
    await page.locator('[data-testid="bubble-ask-here"]').dispatchEvent('mousedown')
    const card = fileCard(view)
    await card.locator('.thread-card-input').fill('Is the ledger bounded?')
    await card.locator('.thread-card-input').press('Enter')
    await expect(card.locator('.thread-card-head .thread-map-num')).toHaveText(String(next), { timeout: 30_000 })
    await expect(card.locator('.thread-card-body')).toContainText('processed your message', { timeout: 60_000 })

    // Close the Files tab; the question is still the composer's target.
    await panel.getByRole('button', { name: 'Files' }).click()
    await expect(panel.locator('.session-file-explorer')).toHaveCount(0)
    const composer = panel.locator('.chat-input-textarea').first()
    await expect(composer).toHaveAttribute('placeholder', /Reply in/)
    // A send from the main composer goes INTO the question (prefix routing).
    await composer.fill('Follow-up from the main composer')
    await composer.press('Enter')
    await expect(panel.locator('.session-history')).toContainText('Follow-up from the main composer', { timeout: 30_000 })

    // Main conversation: no target, a plain chat placeholder.
    await panel.locator('.thread-map .thread-map-row[data-kind="root"]').click()
    await expect(composer).not.toHaveAttribute('placeholder', /Reply in/)

    // The sidebar row of the file question: the Files tab opens on the file,
    // the card sits beside the passage, with the follow-up in it.
    const fileRow = panel.locator('.thread-map .thread-map-row[data-kind="thread"]').nth(2)
    await fileRow.click()
    const view2 = panel.locator('.session-file-explorer .file-content-view')
    await expect(view2).toBeVisible({ timeout: 15_000 })
    await expect(view2.locator('.fv-wysiwyg-editor .ProseMirror')).toContainText(MD_PASSAGE_FULL, { timeout: 15_000 })
    const card2 = fileCard(view2)
    await expect(card2).toBeVisible({ timeout: 15_000 })
    await expect(card2.locator('.thread-card-head .thread-map-num')).toHaveText(String(next))
    await expect(card2.locator('.thread-card-body')).toContainText('Follow-up from the main composer')
    await expect(fileRail(view2).locator('.thread-map-mark[data-current="true"]')).toHaveCount(1)
    const passage = (await textRects(view2.locator('.fv-wysiwyg-editor .ProseMirror'), MD_PASSAGE_FULL)).at(-1)!
    const cb = (await card2.boundingBox())!
    expect(cb.y).toBeGreaterThanOrEqual(passage.top + passage.height - 1)
    expect(cb.y - (passage.top + passage.height)).toBeLessThan(40)
    await shot(page, 'file-q-from-sidebar')
  })

  test('the inline Ask on a hovered block asks about the whole block; Tree Mode names the file on the page', async ({ page, request }) => {
    const panel = await openSession(page)
    const next = await nextQuestionNumber(request, TAGGED_SESSION)
    const view = await openFile(page, panel, MD_FILE)
    const editor = view.locator('.fv-wysiwyg-editor .ProseMirror')
    // The block sits below the first screen of the file.
    await editor.locator('p', { hasText: MD_BLOCK }).scrollIntoViewIfNeeded()
    const r = (await textRects(editor, MD_BLOCK))[0]
    await page.mouse.move(r.left + 20, r.top + r.height / 2, { steps: 3 })
    const askBlock = view.locator('.fv-ask-block')
    await expect(askBlock).toBeVisible()
    await askBlock.click()
    const card = fileCard(view)
    await expect(card).toHaveAttribute('data-draft', 'true')
    await card.locator('.thread-card-input').fill('When does compaction run?')
    await card.locator('.thread-card-input').press('Enter')
    await expect(card.locator('.thread-card-head .thread-map-num')).toHaveText(String(next), { timeout: 30_000 })
    const rec = await readRecord(request, TAGGED_SESSION)
    const anchors = rec.threadAnchors as Array<{ parent: string; quote?: { exact: string } }>
    const mine = anchors.find((a) => a.quote?.exact.startsWith(MD_BLOCK))
    expect(mine, 'the block is the quote').toBeTruthy()
    expect(mine!.quote!.exact).toContain('never runs while a flush is in progress')

    // Tree Mode: the question is a page whose head names the file.
    await switchView(panel, 'stack')
    await expect(modePill(panel)).toHaveAttribute('data-view-mode', 'stack')
    await expect(panel.locator('.thread-quote-from-title')).toHaveText(MD_FILE)
    await expect(panel.locator('.session-history .thread-card')).toHaveCount(0)
    await switchView(panel, 'linear')
  })

  test('the HTML preview: a selection inside the frame gets the two-action pill, Ask here opens the card over the passage', async ({ page, request }) => {
    const panel = await openSession(page)
    const next = await nextQuestionNumber(request, TAGGED_SESSION)
    const view = await openFile(page, panel, HTML_FILE)
    const frame = view.frameLocator('.fv-html-preview')
    await expect(frame.locator('body')).toContainText(HTML_PASSAGE, { timeout: 15_000 })
    /** Viewport rects of the passage: the frame's own rects plus the frame's offset. */
    const passageRects = async () => {
      const frameBox = (await view.locator('.fv-html-preview').boundingBox())!
      const rects = await frame.locator('body').evaluate((el, phrase) => {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          const at = (n as Text).data.indexOf(phrase)
          if (at === -1) continue
          const r = document.createRange()
          r.setStart(n, at)
          r.setEnd(n, at + phrase.length)
          return Array.from(r.getClientRects()).map((b) => ({ left: b.left, right: b.right, top: b.top, height: b.height }))
        }
        return null
      }, HTML_PASSAGE)
      expect(rects).not.toBeNull()
      return rects!.map((b) => ({ ...b, left: b.left + frameBox.x, right: b.right + frameBox.x, top: b.top + frameBox.y }))
    }
    const shifted = await passageRects()
    await dragSelect(page, shifted)
    const pill = page.locator('[data-testid="file-ask-pill"]')
    await expect(pill).toBeVisible()
    await expect(pill.locator('[data-testid="file-ask-quote"]')).toHaveText('Quote in chat')
    await pill.locator('[data-testid="file-ask-here"]').click()
    const card = fileCard(view)
    await expect(card).toHaveAttribute('data-draft', 'true')
    const last = shifted.at(-1)!
    const cb = (await card.boundingBox())!
    expect(cb.y).toBeGreaterThanOrEqual(last.top + last.height - 1)
    expect(cb.y - (last.top + last.height)).toBeLessThan(40)
    await card.locator('.thread-card-input').fill('What caused the Thursday spike?')
    await card.locator('.thread-card-input').press('Enter')
    await expect(card.locator('.thread-card-head .thread-map-num')).toHaveText(String(next), { timeout: 30_000 })
    await expect(card.locator('.thread-card-body')).toContainText('processed your message', { timeout: 60_000 })
    // The frame's own document wears the mark; a click on the passage reopens the card.
    await card.locator('.thread-card-input').press('Escape')
    await expect(card).toHaveCount(0)
    expect(await frame.locator('body').evaluate(() => (window as unknown as { CSS: { highlights?: Map<string, unknown> } }).CSS.highlights?.has('thread-mark-neutral') ?? false)).toBe(true)
    // Measured again: a banner above the panel (the fixture CLI exits after its
    // turn, which the server reports) can have moved the frame since the drag.
    const again = (await passageRects())[0]
    await page.mouse.click(again.left + 8, again.top + again.height / 2)
    await expect(card).toBeVisible()
    await expect(card.locator('.thread-card-head .thread-map-num')).toHaveText(String(next))
    // The rail sits over the frame too, and its row reaches the card.
    await card.locator('.thread-card-input').press('Escape')
    await expect(card).toHaveCount(0)
    const rail = fileRail(view)
    await expect(rail.locator('.thread-map-mark')).toHaveCount(1)
    // Under the toolbar even here: the preview is a block taller than its pane,
    // whose scroll (the card's own scroll-into-view) moves the sticky toolbar
    // against the view. The first build pinned the rail to the view's top and
    // the toolbar slid over it.
    await expect.poll(async () => {
      const rb = (await rail.boundingBox())!
      const tb = (await view.locator('.fv-html-toolbar').first().boundingBox())!
      return rb.y - (tb.y + tb.height)
    }).toBeGreaterThanOrEqual(0)
    await rail.locator('.thread-map-rail').hover()
    await rail.locator('.thread-map-overlay .thread-map-row').click()
    await expect(card).toBeVisible()
    // The card fades in (120ms): the shot is of the settled card over the frame.
    await page.waitForTimeout(300)
    const opaque = await card.evaluate((el) => {
      const cs = getComputedStyle(el)
      return { opacity: cs.opacity, bg: cs.backgroundColor, z: getComputedStyle(el.parentElement!).zIndex }
    })
    expect(opaque.opacity).toBe('1')
    expect(opaque.bg).not.toMatch(/rgba\(\d+, \d+, \d+, 0\)|transparent/)
    await shot(page, 'file-q-html')
  })
})
