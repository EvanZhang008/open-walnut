/**
 * Comments on a document, Google Docs style (2026-11-01, the user: "I comment in
 * the doc, the AI replies in it and resolves it, shown beside it; resolved shows
 * as resolved; it goes into the input like the chat comments").
 *
 *   Comment          the bubble menu's (WYSIWYG) or the pill's (source) Comment
 *                    opens a draft card beside the passage; saved, the words are
 *                    marked, the card sits in a column on the right level with
 *                    them, and a row for it waits above the composer
 *   the sidecar      `<doc>.comments.md` beside the doc holds every comment, its
 *                    anchor and its thread, readable as it is
 *   a send           carries each doc comment with its doc, its id, its sidecar and
 *                    how to answer there; the row goes, the card stays
 *   the AI           writes its reply and "resolved" into the sidecar; the card
 *                    shows the reply, a resolved one leaves the column and is
 *                    listed as resolved by the AI
 *   edits            text added above a passage moves its card with it; words
 *                    taken out make the comment "changed"
 *
 * Real pipeline on a long markdown runbook (test-server.ts: cache-runbook.md):
 * the file API, the session record, a send that reaches the mock CLI. The AI's
 * edit of the sidecar is a plain file write, as its Edit tool would make.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { openThreadsSession, readRecord, resetThreadsFixture } from './threads-helpers'
import { DOC_COMMENTS_SESSION } from './threads-fixture'
import { loadHome } from './draft-helpers'

const TASK = 'pw-task-threads-doc-comments'
const READY = 'How should the reader treat stale copies?'
const DOC = 'cache-runbook.md'
const SIDECAR = 'cache-runbook.md.comments.md'
const TOP = 'The warm-up reads the newest snapshot before it opens the port.'
const MIDDLE = 'A compaction never starts while the ledger is being copied.'
const END = 'The final check compares the row count with the snapshot header.'

async function shot(scope: Page | Locator, name: string): Promise<void> {
  const dir = `${process.env.WALNUT_TASK_DIR ?? '/tmp'}/shots/doc-comments/${test.info().project.name}`
  await fs.mkdir(dir, { recursive: true })
  await scope.screenshot({ path: `${dir}/${name}.png` })
}

function captureSends(page: Page): Array<{ sessionId: string; message: string }> {
  const sent: Array<{ sessionId: string; message: string }> = []
  page.on('websocket', (socket) => socket.on('framesent', (frame) => {
    if (typeof frame.payload !== 'string') return
    try {
      const row = JSON.parse(frame.payload)
      if (row.method === 'session:send') sent.push(row.payload)
    } catch { /* not JSON */ }
  }))
  return sent
}

async function openDoc(page: Page, name = DOC): Promise<{ panel: Locator; view: Locator }> {
  await page.addStyleTag({ content: '.notification-toaster { display: none !important; }' })
  const panel = await openThreadsSession(page, DOC_COMMENTS_SESSION, TASK, READY, { view: 'linear' })
  if (!(await panel.locator('.session-file-explorer').isVisible())) {
    await panel.getByRole('button', { name: 'Files' }).click()
  }
  const explorer = panel.locator('.session-file-explorer')
  const row = explorer.locator('.session-file-explorer-node', { hasText: name }).first()
  await expect(row).toBeVisible({ timeout: 15_000 })
  await row.click()
  const view = explorer.locator('.file-content-view')
  await expect(view).toBeVisible({ timeout: 10_000 })
  return { panel, view }
}

/** Viewport rects of `needle` inside `root`. */
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

/** Bring `needle` to the middle of its scroller (vertically only, as a reader scrolls). */
async function centre(root: Locator, needle: string): Promise<void> {
  await root.evaluate((el, phrase) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!(n as Text).data.includes(phrase)) continue
      let s = n.parentElement
      while (s && !(s.scrollHeight > s.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(s).overflowY))) s = s.parentElement
      if (!s) return
      const r = n.parentElement!.getBoundingClientRect()
      const b = s.getBoundingClientRect()
      s.scrollTop += r.top - (b.top + b.height / 2)
      return
    }
  }, needle)
  await root.page().waitForTimeout(150)
}

async function dragSelect(page: Page, root: Locator, needle: string): Promise<void> {
  await centre(root, needle)
  const rects = await textRects(root, needle)
  const first = rects[0]
  const last = rects[rects.length - 1]
  await page.mouse.move(first.left + 1, first.top + first.height / 2)
  await page.mouse.down()
  await page.mouse.move((first.left + last.right) / 2, (first.top + last.top) / 2 + first.height / 2, { steps: 4 })
  await page.mouse.move(last.right - 1, last.top + last.height / 2, { steps: 4 })
  await page.mouse.up()
}

const cards = (view: Locator) => view.getByTestId('doc-comment-card')
const chip = (view: Locator) => view.getByTestId('doc-comments-chip')
const trayRows = (panel: Locator) => panel.getByTestId('pending-comment-row')
const painted = (page: Page, name: string) => page.evaluate(
  (n) => ((CSS as unknown as { highlights?: Map<string, { size: number }> }).highlights?.get(n)?.size ?? 0), name,
)

/** Comment on `needle` through the WYSIWYG bubble menu. */
async function commentInEditor(page: Page, view: Locator, needle: string, words: string): Promise<void> {
  const editor = view.locator('.fv-wysiwyg-editor .ProseMirror')
  await dragSelect(page, editor, needle)
  const btn = page.getByTestId('bubble-comment')
  await expect(btn).toBeVisible()
  await btn.dispatchEvent('mousedown')
  const input = view.getByTestId('doc-comment-draft-input')
  await expect(input).toBeFocused()
  await input.fill(words)
  await input.press('Enter')
  await expect(view.getByTestId('doc-comment-draft')).toHaveCount(0)
}

/** The card's top is level with its passage (within a few pixels), inside the view on the right. */
async function expectBeside(view: Locator, card: Locator, root: Locator, needle: string): Promise<void> {
  const passage = (await textRects(root, needle))[0]
  const cb = (await card.boundingBox())!
  const vb = (await view.boundingBox())!
  expect(Math.abs(cb.y - passage.top), `card at ${cb.y}, passage at ${passage.top}`).toBeLessThan(14)
  expect(cb.x).toBeGreaterThan(passage.left)
  expect(cb.x + cb.width).toBeLessThanOrEqual(vb.x + vb.width + 1)
  // The text keeps clear of the column (the wide view reserves its room).
  const textRight = await root.evaluate((el) => el.getBoundingClientRect().right)
  expect(textRight).toBeLessThanOrEqual(cb.x + 1)
}

/** A narrow view has no column: the card opens over the text, under the passage's last line. */
async function expectUnder(view: Locator, card: Locator, root: Locator, needle: string): Promise<void> {
  const rects = await textRects(root, needle)
  const last = rects[rects.length - 1]
  const cb = (await card.boundingBox())!
  const vb = (await view.boundingBox())!
  expect(cb.y, `card at ${cb.y}, passage ends at ${last.top + last.height}`).toBeGreaterThanOrEqual(last.top + last.height - 1)
  expect(cb.y - (last.top + last.height)).toBeLessThan(16)
  expect(cb.x + cb.width).toBeLessThanOrEqual(vb.x + vb.width + 1)
}

/** Click the middle of `needle`'s first line (no drag: a plain click). */
async function clickWords(page: Page, root: Locator, needle: string): Promise<void> {
  await centre(root, needle)
  const r = (await textRects(root, needle))[0]
  await page.mouse.click(r.left + Math.min(40, (r.right - r.left) / 2), r.top + r.height / 2)
}

test.describe('Doc comments: beside the doc, in its sidecar, to the AI with the next message', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(300_000)
  let docPath = ''
  let original = ''

  test.beforeEach(async ({ page, request }) => {
    await resetThreadsFixture(request, DOC_COMMENTS_SESSION)
    const rec = await readRecord(request, DOC_COMMENTS_SESSION)
    docPath = path.join(rec.cwd as string, DOC)
    original ||= await fs.readFile(docPath, 'utf8')
    await fs.writeFile(docPath, original)
    await fs.rm(path.join(rec.cwd as string, SIDECAR), { force: true })
    await page.setViewportSize({ width: 1440, height: 900 })
    await loadHome(page)
  })
  test.afterEach(async ({ request }) => {
    await resetThreadsFixture(request, DOC_COMMENTS_SESSION)
    if (docPath) {
      await fs.writeFile(docPath, original)
      await fs.rm(path.join(path.dirname(docPath), SIDECAR), { force: true })
    }
  })

  test('comment twice on a long doc, keep over a reload, send, the AI replies and resolves, the user replies', async ({ page }) => {
    // Wide enough for the doc to keep the column's room beside its text.
    await page.setViewportSize({ width: 1720, height: 960 })
    const sent = captureSends(page)
    let { panel, view } = await openDoc(page)
    let editor = view.locator('.fv-wysiwyg-editor .ProseMirror')
    await expect(editor).toContainText(END)
    // No comment yet: no chip, no column, no room taken.
    await expect(chip(view)).toHaveCount(0)
    await expect(view).not.toHaveClass(/fv-doc-comments-wide/)

    await commentInEditor(page, view, TOP, 'Does it wait for the whole snapshot?')
    await expect(cards(view)).toHaveCount(1)
    await expect(view).toHaveClass(/fv-doc-comments-wide/)
    const first = cards(view).first()
    await expect(first).toHaveClass(/is-current/)
    await expect(first.getByTestId('doc-comment-post')).toHaveText(/You.*Does it wait for the whole snapshot\?/s)
    await expectBeside(view, first, editor, TOP)
    expect(await painted(page, 'walnut-doc-comment-current')).toBe(1)
    // It waits above the composer, which holds no text of it.
    await expect(trayRows(panel)).toHaveCount(1)
    await expect(trayRows(panel).first().locator('.pending-comments-doc')).toHaveText(DOC)
    await expect(panel.locator('.session-panel-input .chat-input-textarea')).toHaveValue('')
    await shot(view, '01-first-comment')
    // A wheel over the card scrolls the doc (the column sits over its scroller).
    const scroller = view.locator('.fv-wysiwyg-editor')
    const before = await scroller.evaluate((el) => el.scrollTop)
    const cardBox = (await first.boundingBox())!
    await page.mouse.move(cardBox.x + cardBox.width / 2, cardBox.y + 12)
    await page.mouse.wheel(0, 240)
    await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(before + 100)
    await centre(editor, TOP)

    await commentInEditor(page, view, MIDDLE, 'Who checks this?\nThe runbook does not say.')
    await expect(cards(view)).toHaveCount(2)
    const second = view.locator('[data-testid="doc-comment-card"].is-current')
    await expectBeside(view, second, editor, MIDDLE)
    expect(await painted(page, 'walnut-doc-comment')).toBe(1)
    await expect(chip(view)).toHaveText('2 comments')
    await expect(trayRows(panel)).toHaveCount(2)

    // The sidecar on disk, as a person or the AI reads it.
    const sidecarPath = path.join(path.dirname(docPath), SIDECAR)
    await expect.poll(async () => (await fs.readFile(sidecarPath, 'utf8').catch(() => '')).match(/^## c-[0-9a-f]{8} · open$/gm)?.length ?? 0).toBe(2)
    const file = await fs.readFile(sidecarPath, 'utf8')
    expect(file).toContain(`> ${TOP}`)
    expect(file).toContain(`> ${MIDDLE}`)
    expect(file).toMatch(/- \*\*You\*\* · \d{4}-\d\d-\d\dT[\d:.]+Z · Who checks this\?\n  The runbook does not say\./)
    const ids = [...file.matchAll(/^## (c-[0-9a-f]{8})/gm)].map((m) => m[1])

    // A click elsewhere in the doc: no card is current; a click on the words opens it again.
    await centre(editor, END)
    const endRect = (await textRects(editor, END))[0]
    await page.mouse.click(endRect.left + 20, endRect.top + endRect.height / 2)
    await expect(view.locator('[data-testid="doc-comment-card"].is-current')).toHaveCount(0)
    await centre(editor, TOP)
    const topRect = (await textRects(editor, TOP))[0]
    await page.mouse.click(topRect.left + 30, topRect.top + topRect.height / 2)
    await expect(view.locator(`[data-comment-id="${ids[0]}"].doc-comment-card`)).toHaveClass(/is-current/)

    // A reload keeps both, on the doc and above the composer.
    await page.reload()
    await page.waitForLoadState('networkidle')
    ;({ panel, view } = await openDoc(page))
    editor = view.locator('.fv-wysiwyg-editor .ProseMirror')
    await expect(chip(view)).toHaveText('2 comments')
    await expect(trayRows(panel)).toHaveCount(2)
    await centre(editor, MIDDLE)
    await expectBeside(view, view.locator(`[data-comment-id="${ids[1]}"].doc-comment-card`), editor, MIDDLE)

    // One send carries both, each with its doc, its id and its sidecar, then how to answer.
    const composer = panel.locator('.session-panel-input .chat-input-textarea')
    await composer.fill('Please answer the comments.')
    await composer.press('Enter')
    await expect.poll(() => sent.filter((s) => s.sessionId === DOC_COMMENTS_SESSION).length, { timeout: 15_000 }).toBe(1)
    const message = sent.find((s) => s.sessionId === DOC_COMMENTS_SESSION)!.message
    expect(message).toContain(`Comment ${ids[0]} on \`${docPath}\` (thread in \`${sidecarPath}\`):\n> ${TOP}\n\nDoes it wait for the whole snapshot?`)
    expect(message).toContain(`Comment ${ids[1]} on \`${docPath}\``)
    expect(message).toContain('as a list item `- **AI** · <ISO time> · <your words>`')
    expect(message.trimEnd().endsWith('Please answer the comments.')).toBe(true)
    await expect(trayRows(panel)).toHaveCount(0)
    await expect(cards(view)).toHaveCount(2)

    // The AI answers in the sidecar: a reply on both, and the first resolved.
    const aiAt = new Date().toISOString()
    let disk = await fs.readFile(sidecarPath, 'utf8')
    disk = disk.replace(`## ${ids[0]} · open`, `## ${ids[0]} · resolved · AI · ${aiAt}`)
      .replace(/(- \*\*You\*\* · [^\n]+ · Does it wait for the whole snapshot\?)/, `$1\n- **AI** · ${aiAt} · Yes. I said so in step 3.`)
      .replace(/(  The runbook does not say\.)/, `$1\n- **AI** · ${aiAt} · The on-call engineer. Should I add it?`)
    await fs.writeFile(sidecarPath, disk)
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(chip(view)).toHaveText('1 comment · 1 resolved', { timeout: 15_000 })
    await expect(cards(view)).toHaveCount(1)
    const open = cards(view).first()
    await expect(open).toHaveAttribute('data-comment-id', ids[1])
    await expect(open.locator('[data-author="AI"]')).toHaveCount(0) // folded: the first post and "1 reply"
    await expect(open.locator('.doc-comment-more')).toHaveText('1 reply')
    expect(await painted(page, 'walnut-doc-comment')).toBe(1)
    await chip(view).click()
    const list = view.getByTestId('doc-comments-list')
    await expect(list.locator(`[data-comment-id="${ids[0]}"]`)).toContainText('Resolved by AI')
    await shot(view, '02-resolved-in-list')
    await chip(view).click()

    // The user answers the AI on the open one: the reply joins the thread and waits for the next send.
    await open.click()
    await expect(open).toHaveClass(/is-current/)
    await expect(open.locator('[data-author="AI"]')).toHaveText(/The on-call engineer/)
    const reply = open.getByTestId('doc-comment-reply')
    await reply.fill('Yes, add it.')
    await reply.press('Enter')
    await expect(open.getByTestId('doc-comment-post')).toHaveCount(3)
    await expect(open.locator('.doc-comment-queued')).toBeVisible()
    await expect(trayRows(panel)).toHaveCount(1)
    await expect(trayRows(panel).first().locator('.pending-comments-doc')).toHaveText(`${DOC} · reply`)
    await expect.poll(async () => fs.readFile(sidecarPath, 'utf8'), { timeout: 10_000 }).toMatch(/- \*\*You\*\* · [^\n]+ · Yes, add it\./)
    // The AI's words written meanwhile were kept by the user's write.
    expect(await fs.readFile(sidecarPath, 'utf8')).toContain('Yes. I said so in step 3.')
    await shot(view, '03-reply-queued')

    // A race: the AI writes the file again and the user replies before the page read it.
    // The user's write is refused (the file moved) and replayed on the fresh read.
    const raced = (await fs.readFile(sidecarPath, 'utf8')).replace(/(- \*\*You\*\* · [^\n]+ · Yes, add it\.)/, `$1\n- **AI** · ${new Date().toISOString()} · Added in step 18.`)
    await fs.writeFile(sidecarPath, raced)
    await reply.fill('Thanks.')
    await reply.press('Enter')
    await expect.poll(async () => fs.readFile(sidecarPath, 'utf8'), { timeout: 10_000 }).toMatch(/Added in step 18\.\n- \*\*You\*\* · [^\n]+ · Thanks\./)
    await expect(open.getByTestId('doc-comment-post')).toHaveCount(5)

    // The row above the composer, with the doc scrolled away and no card current: a
    // click opens the doc on that comment, its words in view and its card beside them.
    await page.mouse.click((await textRects(editor, MIDDLE))[0].left + 30, (await textRects(editor, MIDDLE))[0].top - 30)
    await expect(view.locator('[data-testid="doc-comment-card"].is-current')).toHaveCount(0)
    await view.locator('.fv-wysiwyg-editor').evaluate((el) => { el.scrollTop = 0 })
    await trayRows(panel).first().locator('.pending-comments-jump').click()
    const jumped = view.locator(`[data-comment-id="${ids[1]}"].doc-comment-card`)
    await expect(jumped).toHaveClass(/is-current/)
    await expectBeside(view, jumped, editor, MIDDLE)
    const mid = (await textRects(editor, MIDDLE))[0]
    const vbox = (await view.boundingBox())!
    expect(mid.top).toBeGreaterThan(vbox.y + 40)
    expect(mid.top).toBeLessThan(vbox.y + vbox.height - 40)

    // Reopen the resolved one from the list: back in the column.
    await chip(view).click()
    await list.locator(`[data-comment-id="${ids[0]}"]`).getByRole('button', { name: 'Reopen' }).click()
    await expect(chip(view)).toHaveText('2 comments')
    await expect.poll(async () => fs.readFile(sidecarPath, 'utf8')).toContain(`## ${ids[0]} · open`)
  })

  test('a narrow view: the card under its words; it follows them through an edit, words taken out make it changed; the source view comments too', async ({ page }) => {
    const { panel, view } = await openDoc(page)
    const refresh = () => panel.locator('.session-file-explorer').getByRole('button', { name: 'Refresh' }).first().click()
    const editor = view.locator('.fv-wysiwyg-editor .ProseMirror')
    await expect(editor).toContainText(END)
    await commentInEditor(page, view, END, 'Is the header always written?')
    await expect(cards(view)).toHaveCount(1)
    // Too narrow for a column: no room taken, the card under the passage, over the text.
    await expect(view).not.toHaveClass(/fv-doc-comments-wide/)
    await expectUnder(view, cards(view).first(), editor, END)
    await shot(view, '04-narrow')
    const sidecarPath = path.join(path.dirname(docPath), SIDECAR)
    await expect.poll(async () => fs.readFile(sidecarPath, 'utf8').catch(() => '')).toContain(`> ${END}`)

    // A save that fails is kept and retried: the card stays, the doc says so, then it lands.
    let failed = 0
    await page.route('**/api/file-content', async (route) => {
      if (route.request().method() === 'PUT' && (route.request().postData() ?? '').includes(SIDECAR) && failed === 0) {
        failed += 1
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Host is reconnecting' }) })
        return
      }
      await route.fallback()
    })
    const current = view.locator('[data-testid="doc-comment-card"].is-current')
    await current.getByTestId('doc-comment-reply').fill('One more thing.')
    await current.getByTestId('doc-comment-reply').press('Enter')
    await expect(view.locator('.doc-comments-error')).toContainText('Host is reconnecting')
    await expect(current.getByTestId('doc-comment-post')).toHaveCount(2)
    await expect.poll(async () => fs.readFile(sidecarPath, 'utf8'), { timeout: 15_000 }).toContain('One more thing.')
    await expect(view.locator('.doc-comments-error')).toHaveCount(0)
    expect(failed).toBe(1)
    await page.unroute('**/api/file-content')

    // Escape gives a draft up: nothing written.
    await dragSelect(page, editor, TOP)
    await page.getByTestId('bubble-comment').dispatchEvent('mousedown')
    await expect(view.getByTestId('doc-comment-draft-input')).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(view.getByTestId('doc-comment-draft')).toHaveCount(0)
    await expect(chip(view)).toHaveText('1 comment')
    await expect.poll(async () => (await fs.readFile(sidecarPath, 'utf8')).match(/^## c-/gm)?.length).toBe(1)

    // Someone adds a paragraph above it on disk: after Refresh its words are still marked
    // and a click on them opens the card under them.
    await fs.writeFile(docPath, original.replace('## 30.', 'A new paragraph a writer added above the end.\n\n## 30.'))
    await refresh()
    await expect(editor).toContainText('A new paragraph a writer added above the end.')
    await expect.poll(() => painted(page, 'walnut-doc-comment')).toBe(1)
    await clickWords(page, editor, END)
    await expect(cards(view)).toHaveCount(1)
    await expectUnder(view, cards(view).first(), editor, END)

    // The words are taken out: the comment is "changed", listed with its passage.
    await fs.writeFile(docPath, original.replace(END, 'The final check is described elsewhere.'))
    await refresh()
    await expect(editor).toContainText('The final check is described elsewhere.')
    await expect(chip(view)).toHaveText('1 comment · 1 changed')
    await expect(cards(view)).toHaveCount(0)
    await chip(view).click()
    await expect(view.getByTestId('doc-comments-list-row')).toContainText('Words changed')
    await shot(view, '05-changed')

    // The source view (CodeMirror): the pill's Comment.
    await fs.writeFile(docPath, original)
    await refresh()
    await view.getByRole('button', { name: 'Source', exact: true }).click()
    const source = view.locator('.cm-content')
    await expect(source).toBeVisible()
    // CodeMirror draws only the lines near the screen: the comment far down is not "changed" here.
    await expect(chip(view)).toHaveText('1 comment')
    await dragSelect(page, source, TOP)
    const pillComment = page.getByTestId('file-comment')
    await expect(pillComment).toBeVisible()
    await pillComment.click()
    const input = view.getByTestId('doc-comment-draft-input')
    await expect(input).toBeFocused()
    await input.fill('From the source view.')
    await input.press('Enter')
    await expect(chip(view)).toHaveText('2 comments')
    await expect.poll(async () => fs.readFile(sidecarPath, 'utf8')).toContain('From the source view.')
    await shot(view, '06-source')
  })
})
