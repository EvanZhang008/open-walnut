/**
 * Guard: on EVERY surface of the Files and Changed tabs that offers a selection
 * toolbar, the ask button responds to a real click and what it does is SEEN.
 *
 * The 2026-11-06 report: in the Files tab, and in the Changed tab, pressing
 * `Ask here` on a selection did nothing at all. The older specs press the button
 * with a synthetic `mousedown` and check the card exists, so a card that never
 * became visible (stuck at opacity 0, off screen, under another layer) or a real
 * click that the toolbar never saw passed them all. Here every surface is driven
 * the way a person does it: the words are selected with the mouse (down, move,
 * up), the button gets a real click (locator.click), and the result must be on
 * screen:
 *  - a question card: opaque (computed opacity 1, and it stays so), inside the
 *    viewport, the topmost thing at its center, its box focused, and BESIDE the
 *    passage: over none of its rects, under its last line (or over its first
 *    when there is no room below; 2026-11-06, the rendered diff drew it ON the
 *    passage);
 *  - `Quote in chat`: the composer focused, on screen, holding the quote.
 *
 * The Changed tab has the Files tab's toolbar and card (the same question layer
 * over the diff): a question asked there is the same `file:` record, its line the
 * new side's. A selection that takes a removed line has no Ask here (the line is
 * not in the file, so no card can sit beside it): only Quote in chat.
 *
 * The root cause it guards: the pill's Ask here read the LIVE selection at click
 * time, which is gone by then (CodeMirror drops it; WebKit drops any top-document
 * selection on the press), so the Source tab, code files, the read-only views
 * and, in WebKit, every pill surface but the iframe silently did nothing.
 *
 * Files: the markdown preview (WYSIWYG, its bubble menu), the markdown Source tab
 * and a code file (CodeMirror, the pill), the read-only markdown render (.mdx),
 * the read-only code view (a truncated read), the HTML preview (an iframe).
 * Changed: a unified diff, a split diff and a rendered markdown diff, whose list
 * is stubbed at the network edge over the real files of the session's cwd.
 *
 * WebKit (the Mac app) and Chromium. Fixtures: test-server.ts (the editor-fixture
 * cwd: cache-design.md, cache-report.html, nested-fence.mdx, sync-*.go).
 */
import { expect, type APIRequestContext, type Locator, type Page, type Route } from '@playwright/test'
import fs from 'node:fs/promises'
import { humanPress, mainComposer, openThreadsSession, readRecord, resetThreadsFixture, test } from './threads-helpers'
import { TAGGED_READY, TAGGED_SESSION, TAGGED_TASK } from './threads-fixture'

type Rect = { left: number; right: number; top: number; height: number }

async function shot(page: Page, name: string): Promise<void> {
  const dir = `${process.env.WALNUT_TASK_DIR ?? '/tmp'}/shots/files-changed-ask/${test.info().project.name}`
  await fs.mkdir(dir, { recursive: true })
  await page.screenshot({ path: `${dir}/${name}.png` })
}

async function openSession(page: Page): Promise<Locator> {
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await page.setViewportSize({ width: 1400, height: 820 })
  return openThreadsSession(page, TAGGED_SESSION, TAGGED_TASK, TAGGED_READY, { view: 'linear' })
}

async function openFile(panel: Locator, name: string): Promise<Locator> {
  if (!(await panel.locator('.session-file-explorer').isVisible())) {
    await panel.getByRole('button', { name: 'Files', exact: true }).click()
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

/** Viewport rects of `phrase` inside `root` (top document), the passage scrolled
 *  into view first. The phrase may cross text nodes (a diff's syntax tokens and
 *  intra-line edit marks split a line into many). */
async function textRects(root: Locator, phrase: string, nth = 0, scroll = true): Promise<Rect[]> {
  const rects = await root.evaluate((el, [needle, which, mayScroll]) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    const nodes: Array<{ n: Text; start: number }> = []
    let text = ''
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      nodes.push({ n: n as Text, start: text.length })
      text += (n as Text).data
    }
    let at = text.indexOf(needle)
    for (let k = 0; k < which && at !== -1; k++) at = text.indexOf(needle, at + 1)
    if (at === -1) return null
    const pointAt = (off: number, end: boolean) => {
      for (let i = nodes.length - 1; i >= 0; i--) {
        const e = nodes[i]
        if (end ? e.start < off : e.start <= off) return { node: e.n, offset: off - e.start }
      }
      return { node: nodes[0].n, offset: 0 }
    }
    const a = pointAt(at, false)
    const b = pointAt(at + needle.length, true)
    const r = document.createRange()
    r.setStart(a.node, a.offset)
    r.setEnd(b.node, b.offset)
    // Off screen only: a scroll of an editor's line from outside moves the box
    // CodeMirror measures from, and it draws its lines over its gutter.
    const box = r.getBoundingClientRect()
    if (mayScroll && (box.top < 0 || box.bottom > window.innerHeight)) {
      a.node.parentElement?.scrollIntoView({ block: 'nearest' })
    }
    return Array.from(r.getClientRects()).filter((x) => x.width > 0)
      .map((x) => ({ left: x.left, right: x.right, top: x.top, height: x.height }))
  }, [phrase, nth, scroll] as const)
  expect(rects, `"${phrase}" is not rendered`).not.toBeNull()
  return rects!
}

/** Hovers each block of `root` on screen (on its first word, as a reader
 *  reaches for it) and checks the inline Ask shows next to that block and off
 *  every word on screen: the block's own and its neighbours'. Returns how many
 *  blocks were looked at, and how many of them wrap (a full first line, where the chip covered
 *  its last word: 2026-11-07). */
async function chipOffWords(page: Page, view: Locator, root: Locator): Promise<{ seen: number; wrapped: number }> {
  const chip = view.locator('.fv-ask-block')
  const vh = page.viewportSize()!.height
  type Box = { left: number; right: number; top: number; bottom: number }
  // Every line box of text in the view (the chip is outside `root`, or in its layer: skipped).
  const allWords = async (): Promise<Box[]> => (await root.evaluate((el) => {
    const out: Array<{ left: number; right: number; top: number; bottom: number }> = []
    const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!(n.nodeValue ?? '').trim() || n.parentElement?.closest('.fv-thread-layer, .thread-card')) continue
      const r = el.ownerDocument.createRange()
      r.selectNodeContents(n)
      for (const q of Array.from(r.getClientRects())) {
        if (q.width > 0 && q.height > 0) out.push({ left: q.left, right: q.right, top: q.top, bottom: q.bottom })
      }
    }
    return out
  }))
  const blocks = root.locator('p, li, h1, h2, h3, tr, pre')
  const n = Math.min(await blocks.count(), 20)
  let seen = 0
  let wrapped = 0
  for (let i = 0; i < n; i++) {
    const own = (await blocks.nth(i).evaluate((el) => {
      const r = el.ownerDocument.createRange()
      r.selectNodeContents(el)
      const b = el.getBoundingClientRect()
      const lines = Array.from(r.getClientRects()).filter((q) => q.width > 0 && q.height > 0 && q.height < 40)
        .map((q) => ({ left: q.left, right: q.right, top: q.top, bottom: q.bottom }))
      // The pointer's spot shows the block itself, not the file's own bar over
      // the top of the scrolled text.
      const at = lines[0] ? el.ownerDocument.elementFromPoint(lines[0].left + 3, (lines[0].top + lines[0].bottom) / 2) : null
      return { box: { left: b.left, right: b.right, top: b.top, bottom: b.bottom }, lines, shown: !!at && el.contains(at) }
    }))
    const { box, lines, shown } = own
    if (!lines.length || !shown || box.top < 80 || box.bottom > vh - 40) continue
    const first = lines[0]
    await page.mouse.move(first.left + 3, (first.top + first.bottom) / 2, { steps: 2 })
    await expect(chip).toBeVisible({ timeout: 3_000 })
    // Settled where it goes for THIS block (it follows the pointer a frame later).
    await expect.poll(async () => {
      const c = await chip.boundingBox()
      return !!c && c.y + c.height >= box.top - 30 && c.y <= box.bottom + 30 && c.x <= box.right + 60 && c.x + c.width >= box.left
    }, { message: `the inline Ask settles beside block ${i}`, timeout: 3_000 }).toBe(true)
    const c = (await chip.boundingBox())!
    for (const w of await allWords()) {
      const hit = c.x < w.right - 0.5 && c.x + c.width > w.left + 0.5 && c.y < w.bottom - 0.5 && c.y + c.height > w.top + 0.5
      expect(hit, `the inline Ask for block ${i} covers words (chip ${JSON.stringify(c)}, words ${JSON.stringify(w)})`).toBe(false)
    }
    seen++
    if (new Set(lines.map((w) => Math.round(w.top))).size > 1) wrapped++
  }
  return { seen, wrapped }
}

/** The same inside the HTML preview's frame, in top-document coordinates. */
async function frameTextRects(view: Locator, phrase: string): Promise<Rect[]> {
  const rects = await view.frameLocator('.fv-html-preview').locator('body').evaluate((el, needle) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const at = (n as Text).data.indexOf(needle)
      if (at === -1) continue
      const r = document.createRange()
      r.setStart(n, at)
      r.setEnd(n, at + needle.length)
      return Array.from(r.getClientRects()).map((b) => ({ left: b.left, right: b.right, top: b.top, height: b.height }))
    }
    return null
  }, phrase)
  expect(rects, `"${phrase}" is not in the frame`).not.toBeNull()
  const frameBox = (await view.locator('.fv-html-preview').boundingBox())!
  return rects!.map((b) => ({ ...b, left: b.left + frameBox.x, right: b.right + frameBox.x, top: b.top + frameBox.y }))
}

/** A real mouse drag over the rects: down at the first, up at the last. */
async function dragSelect(page: Page, rects: Rect[]): Promise<void> {
  const first = rects[0]
  const last = rects[rects.length - 1]
  await page.mouse.move(first.left + 1, first.top + first.height / 2)
  await page.mouse.down()
  await page.mouse.move((first.left + last.right) / 2, (first.top + last.top) / 2 + first.height / 2, { steps: 4 })
  await page.mouse.move(last.right - 1, last.top + last.height / 2, { steps: 4 })
  await page.mouse.up()
}

/** Drag over `phrase` until the button shows (a late layout shift can move the text between measure and drag). */
async function selectUntil(page: Page, rects: () => Promise<Rect[]>, button: Locator): Promise<void> {
  let tries = 0
  await expect(async () => {
    // A second drag must not start on the words still selected: an editor reads
    // that as dragging them away (CodeMirror moved the text). Collapse first.
    if (tries++) await page.keyboard.press('ArrowLeft')
    await dragSelect(page, await rects())
    await expect(button).toBeVisible({ timeout: 3_000 })
  }).toPass({ timeout: 30_000 })
}

/** Is `el` really seen: inside the viewport and the topmost element at its center? */
async function seen(el: Locator): Promise<{ inViewport: boolean; topmost: boolean }> {
  return el.evaluate((node) => {
    const r = node.getBoundingClientRect()
    const inViewport = r.width > 0 && r.height > 0 && r.left >= -1 && r.top >= -1
      && r.right <= window.innerWidth + 1 && r.bottom <= window.innerHeight + 1
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 20))
    return { inViewport, topmost: !!hit && (hit === node || node.contains(hit)) }
  })
}

/** The Ask landed: a draft card in the file view, opaque and staying so, on screen,
 *  its box focused. `whileOpen` runs with the card open, before Esc closes it. */
async function expectCardLanded(
  page: Page, view: Locator, name: string, passage: () => Promise<Rect[]>, whileOpen?: (card: Locator) => Promise<void>,
): Promise<void> {
  const card = await expectCardShown(page, view, name, passage)
  if (whileOpen) await whileOpen(card)
  // Nothing written: Esc leaves no card behind.
  await card.locator('.thread-card-input').press('Escape')
  await expect(card).toHaveCount(0)
}

/** The card sits beside the passage: over none of its rects, and under its last
 *  line (or, with no room there, over its first). 2026-11-06: in the Changed tab's
 *  rendered markdown diff the card was drawn ON the passage and the line above. */
async function expectCardBesidePassage(card: Locator, passage: () => Promise<Rect[]>, name: string): Promise<void> {
  const rects = (await passage()).slice().sort((a, b) => a.top - b.top)
  expect(rects.length, `${name}: the passage is on screen`).toBeGreaterThan(0)
  const c = (await card.boundingBox())!
  const cardBox = { left: c.x, right: c.x + c.width, top: c.y, bottom: c.y + c.height }
  const over = rects.filter((r) => r.left < cardBox.right - 1 && r.right > cardBox.left + 1
    && r.top < cardBox.bottom - 1 && r.top + r.height > cardBox.top + 1)
  expect(over, `${name}: the card covers none of the passage (card ${JSON.stringify(cardBox)})`).toEqual([])
  const first = rects[0]
  const last = rects[rects.length - 1]
  const lastBottom = Math.max(...rects.map((r) => r.top + r.height))
  const below = cardBox.top >= lastBottom - 1 && cardBox.top - lastBottom <= 32
  const above = cardBox.bottom <= first.top + 1 && first.top - cardBox.bottom <= 32
  expect(below || above, `${name}: the card sits under the passage's last line or over its first `
    + `(card ${Math.round(cardBox.top)}..${Math.round(cardBox.bottom)}, passage ${Math.round(first.top)}..${Math.round(last.top + last.height)})`).toBe(true)
}

/** `passage`: the asked passage's viewport rects, read without scrolling (the card
 *  must sit beside it: expectCardBesidePassage). */
async function expectCardShown(page: Page, view: Locator, name: string, passage: () => Promise<Rect[]>): Promise<Locator> {
  const card = view.locator('.fv-thread-layer .thread-card')
  await expect(card, `${name}: a card opened`).toBeVisible({ timeout: 5_000 })
  await expect(card).toHaveAttribute('data-draft', 'true')
  // Drawn unseen while it is measured (and, over the HTML preview, until its
  // page reports where the passage is), then shown in one step.
  await expect.poll(() => card.evaluate((el) => el.parentElement!.hasAttribute('data-card-measure')), { message: `${name}: the card is measured and shown` }).toBe(false)
  // Opaque from its first shown frame: the card slides in, it never fades from 0
  // (thread-card.css), so this holds even when frames come ~300ms apart.
  expect(await card.evaluate((el) => getComputedStyle(el).opacity), `${name}: the card is opaque at once`).toBe('1')
  // ...and stays: the same element (not remounted every frame) still opaque later.
  await card.evaluate((el) => { (el as HTMLElement).dataset.guardProbe = '1' })
  await page.waitForTimeout(600)
  const later = await card.evaluate((el) => ({ opacity: getComputedStyle(el).opacity, same: (el as HTMLElement).dataset.guardProbe === '1' }))
  expect(later, `${name}: the card stays opaque, mounted once`).toEqual({ opacity: '1', same: true })
  expect(await seen(card), `${name}: the card is on screen and on top`).toEqual({ inViewport: true, topmost: true })
  await expect(card.locator('.thread-card-input'), `${name}: the card's box takes the keyboard`).toBeFocused()
  await expectCardBesidePassage(card, passage, name)
  await shot(page, name)
  return card
}

/** The card's left edge is right of the code view's line-number gutter. */
async function expectCardRightOfGutter(card: Locator, column: Locator, name: string): Promise<void> {
  const cb = (await card.boundingBox())!
  const col = (await column.first().boundingBox())!
  expect(cb.x, `${name}: the card does not cover the line numbers`).toBeGreaterThanOrEqual(col.x - 1)
}

type FileAnchor = { msgId: string; parent: string; line?: number; quote?: { exact: string } }

/** A question typed into the open draft card and sent: the record gains a `file:` anchor for `path`. */
async function sendAndCheckRecord(
  request: APIRequestContext, card: Locator, question: string, path: string, exact: string,
  onSend?: { before?: () => Promise<void>; after?: () => Promise<void> },
): Promise<FileAnchor> {
  const input = card.locator('.thread-card-input')
  await input.fill(question)
  if (onSend?.before) await onSend.before()
  await input.press('Enter')
  await expect(card).not.toHaveAttribute('data-draft', 'true', { timeout: 30_000 })
  await expect(card.locator('.thread-card-q').first()).toHaveText(question)
  let anchor: FileAnchor | undefined
  await expect(async () => {
    const rec = await readRecord(request, TAGGED_SESSION)
    // The newest such anchor: an earlier question in the test may quote the same words.
    anchor = (rec.threadAnchors as FileAnchor[]).filter((a) => a.parent === `file:${path}` && a.quote?.exact.includes(exact)).at(-1)
    expect(anchor, `a file anchor for ${path} quoting "${exact}"`).toBeTruthy()
  }).toPass({ timeout: 15_000 })
  if (onSend?.after) await onSend.after()
  await input.press('Escape')
  await expect(card).toHaveCount(0)
  return anchor!
}

/** Which side of its passage a file card hangs on: by its foot (`bottom`) over
 *  the passage, or by its top under it. */
async function cardSide(card: Locator): Promise<'above' | 'below'> {
  return card.evaluate((el) => ((el as HTMLElement).style.bottom ? 'above' : 'below'))
}

/** One frame of the file card: its side, layout top (no slide transform), opacity,
 *  and where the passage's last line ends then (host coordinates, -1 if not found). */
interface CardSample { side: string; top: number; opacity: string; height: number; passageBottom: number }

/** Every frame for `ms` from now, read in requestAnimationFrame (what the frame paints). */
async function startCardSampler(page: Page, ms: number, phrase: string): Promise<void> {
  await page.evaluate(([span, needle]) => {
    const w = window as unknown as { __cardSamples: CardSample[]; __cardSampled: boolean }
    w.__cardSamples = []
    w.__cardSampled = false
    const passageBottom = (layer: HTMLElement): number => {
      const root = layer.parentElement
      if (!root) return -1
      // The phrase may cross text nodes (a diff's edit marks split its lines).
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      const nodes: Array<{ n: Text; start: number }> = []
      let text = ''
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (layer.contains(n)) continue
        nodes.push({ n: n as Text, start: text.length })
        text += (n as Text).data
      }
      const at = text.indexOf(needle)
      if (at === -1) return -1
      const end = at + needle.length
      const last = nodes.filter((x) => x.start < end).at(-1)!
      const r = document.createRange()
      r.setStart(last.n, Math.max(0, at - last.start))
      r.setEnd(last.n, end - last.start)
      return Math.round(r.getBoundingClientRect().bottom - layer.getBoundingClientRect().top)
    }
    const t0 = performance.now()
    const tick = () => {
      const el = document.querySelector<HTMLElement>('.fv-thread-layer > .thread-card')
      if (el) {
        w.__cardSamples.push({
          side: el.style.bottom ? 'above' : 'below', top: el.offsetTop, opacity: getComputedStyle(el).opacity,
          height: el.offsetHeight, passageBottom: passageBottom(el.parentElement as HTMLElement),
        })
      }
      if (performance.now() - t0 < span) requestAnimationFrame(tick)
      else w.__cardSampled = true
    }
    requestAnimationFrame(tick)
  }, [ms, phrase] as const)
}

async function cardSamples(page: Page): Promise<CardSample[]> {
  await page.waitForFunction(() => (window as unknown as { __cardSampled: boolean }).__cardSampled, undefined, { timeout: 30_000 })
  return page.evaluate(() => (window as unknown as { __cardSamples: CardSample[] }).__cardSamples)
}

/** The samples that differ from the one before: a short story of what moved. */
const cardChanges = (xs: CardSample[]): CardSample[] =>
  xs.filter((x, i) => i === 0 || JSON.stringify(x) !== JSON.stringify(xs[i - 1])).slice(0, 12)

/** The quote landed in the composer: focused, on screen, holding the words. */
async function expectComposerQuoted(page: Page, panel: Locator, words: string, name: string): Promise<void> {
  const input = mainComposer(panel)
  await expect(input, `${name}: the composer takes the keyboard`).toBeFocused({ timeout: 5_000 })
  await expect(input).toHaveValue(new RegExp(words.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  expect(await seen(input), `${name}: the composer is on screen and on top`).toEqual({ inViewport: true, topmost: true })
  await shot(page, name)
  await input.fill('')
}

// ── Changed tab stub: the list and file records over the cwd's real files ──
interface StubFile { rel: string; before: string; after: string; status: 'added' | 'modified' }

async function stubChanges(page: Page, cwd: string, files: StubFile[]): Promise<void> {
  const rec = (f: StubFile) => ({
    filePath: `${cwd}/${f.rel}`, relPath: f.rel, before: f.before, after: f.after, status: f.status, ops: 1, partial: false,
  })
  const list = (light: boolean) => ({
    sessionId: TAGGED_SESSION,
    groups: [{
      repoRoot: cwd, label: 'editor-fixture', kind: 'cwd',
      files: files.map((f) => (light ? { ...rec(f), before: '', after: '' } : rec(f))),
    }],
    fileCount: files.length, anyPartial: false, light,
  })
  await page.route(`**/api/sessions/${TAGGED_SESSION}/changes**`, async (route: Route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith('/changes/file')) {
      const f = files.find((x) => `${cwd}/${x.rel}` === url.searchParams.get('path'))
      if (!f) return route.fulfill({ status: 404, json: { error: 'not in the change' } })
      return route.fulfill({ json: { sessionId: TAGGED_SESSION, repoRoot: cwd, file: rec(f) } })
    }
    if (url.pathname.endsWith('/changes/summary') || url.pathname.endsWith('/changes/triage')) {
      return route.fulfill({ status: 404, json: { error: 'off in this spec' } })
    }
    return route.fulfill({ json: list(url.searchParams.get('light') === '1' && !url.searchParams.get('base')) })
  })
}

async function openChanged(panel: Locator, rel: string): Promise<Locator> {
  await panel.getByRole('button', { name: /^Changed/ }).first().click()
  const diff = panel.locator('.session-diff-view')
  await expect(diff).toBeVisible({ timeout: 10_000 })
  // The list loads after the view: wait for the row (the view may reopen on
  // another file it remembers), then pick it.
  const row = diff.locator('.session-diff-tree-file', { hasText: rel.split('/').pop()! }).first()
  await expect(row).toBeVisible({ timeout: 15_000 })
  await row.click()
  const pane = diff.locator(`.session-diff-filepane[data-file-path$="${rel}"]`)
  await expect(pane).toBeVisible({ timeout: 15_000 })
  return diff
}

const MD_FILE = 'cache-design.md'
const MD_PASSAGE = 'A late flush can hide an'
const MD_SOURCE_LINE = 'Workers flush in the order the index lists them.'
const GO_FILE = 'sync-controller.go'
const GO_LINE = 'registerResources wires'
const MDX_FILE = 'nested-fence.mdx'
const MDX_LINE = 'Copy this prompt verbatim:'
const RO_FILE = 'sync-caller.go'
const RO_LINE = 'timed out'
const HTML_FILE = 'cache-report.html'
const HTML_PASSAGE = 'The p99 rose to 180 ms on Thursday'
/** sync-controller.go in the Changed tab: line 3 changed in place, line 4 unchanged. */
const GO_NEW = 'wires the informers.'
const GO_REMOVED = 'wires informers.'
const GO_CONTEXT = 'HasSyncedForItems'

test.describe('Ask here on every Files and Changed selection toolbar responds, and is seen', () => {
  // In order on one worker (one fixture session, its server-side view memory),
  // and a failing surface does not skip the others.
  test.describe.configure({ mode: 'default' })
  test.setTimeout(180_000)

  test.beforeEach(async ({ page, request }) => {
    await resetThreadsFixture(request, TAGGED_SESSION)
    // The tree expanded before first render (its collapse pref syncs to the shared server).
    await page.addInitScript(() => {
      try { localStorage.setItem('open-walnut-file-explorer-tree-collapsed', '0') } catch { /* off */ }
    })
  })

  test('Files: the markdown preview (WYSIWYG bubble menu)', async ({ page }) => {
    const panel = await openSession(page)
    const view = await openFile(panel, MD_FILE)
    const editor = view.locator('.fv-wysiwyg-editor .ProseMirror')
    await expect(editor).toContainText(MD_PASSAGE)
    // The hovered block's inline Ask shows (so its absence below means something).
    const chip = view.locator('.fv-ask-block')
    const hoverPassage = async () => {
      const r = (await textRects(editor, MD_PASSAGE))[0]
      await page.mouse.move(r.left + 4, r.top + r.height / 2)
      await page.mouse.move(r.left + 12, r.top + r.height / 2, { steps: 3 })
    }
    await hoverPassage()
    await expect(chip, 'the inline Ask shows on the hovered block').toBeVisible({ timeout: 5_000 })
    const askHere = page.locator('[data-testid="bubble-ask-here"]')
    await selectUntil(page, () => textRects(editor, MD_PASSAGE), askHere)
    await humanPress(page, askHere)
    await expectCardLanded(page, view, 'files-md-wysiwyg', () => textRects(editor, MD_PASSAGE, 0, false), async (card) => {
      // While this file's card is open the chip stays away: it covered a word.
      await hoverPassage()
      await page.waitForTimeout(300)
      await expect(chip, 'no inline Ask over the passage while its card is open').toHaveCount(0)
      // The text above reflows with no mutation in the view and no scroll (a
      // stylesheet, as a late font does): the card follows its passage
      // (2026-11-09: it stayed a line, 26px, below it).
      await page.addStyleTag({ content: '.fv-wysiwyg-editor .ProseMirror > :first-child { margin-top: 64px !important; }' })
      await expect(async () => {
        await expectCardBesidePassage(card, () => textRects(editor, MD_PASSAGE, 0, false), 'files-md-wysiwyg reflowed')
      }).toPass({ timeout: 5_000 })
    })
  })

  test('Files: the hovered block\'s inline Ask never covers its words, and a drag from a line\'s end selects', async ({ page }) => {
    const panel = await openSession(page)
    // Narrow enough that paragraphs wrap and their first line runs to the edge.
    await page.setViewportSize({ width: 1100, height: 820 })
    let view = await openFile(panel, MD_FILE)
    const editor = view.locator('.fv-wysiwyg-editor .ProseMirror')
    await expect(editor).toContainText(MD_PASSAGE)
    const md = await chipOffWords(page, view, editor)
    expect(md.seen, 'markdown blocks looked at').toBeGreaterThan(2)
    expect(md.wrapped, 'a wrapped markdown block was among them').toBeGreaterThan(0)
    // A drag that starts at the right end of a wrapped block's first line (where
    // the chip sat) selects words.
    const wrappedEnd = await editor.locator('p').evaluateAll((els) => {
      for (const el of els) {
        const r = el.ownerDocument.createRange()
        r.selectNodeContents(el)
        const rects = Array.from(r.getClientRects()).filter((q) => q.width > 0)
        if (new Set(rects.map((q) => Math.round(q.top))).size < 2) continue
        const top = Math.min(...rects.map((q) => q.top))
        const line = rects.filter((q) => Math.round(q.top) === Math.round(top))
        const right = Math.max(...line.map((q) => q.right))
        if (top < 80 || top > window.innerHeight - 60) continue
        const at = el.ownerDocument.elementFromPoint(right - 4, top + line[0].height / 2)
        if (!at || !el.contains(at)) continue
        return { x: right - 4, y: top + line[0].height / 2 }
      }
      return null
    })
    expect(wrappedEnd, 'a wrapped paragraph on screen').not.toBeNull()
    await page.mouse.move(wrappedEnd!.x - 40, wrappedEnd!.y, { steps: 2 })
    await page.mouse.move(wrappedEnd!.x, wrappedEnd!.y, { steps: 2 })
    await page.mouse.down()
    await page.mouse.move(wrappedEnd!.x - 120, wrappedEnd!.y, { steps: 6 })
    await page.mouse.up()
    expect((await page.evaluate(() => window.getSelection()?.toString() ?? '')).trim().length, 'the drag from the line end selected words').toBeGreaterThan(3)
    await page.keyboard.press('Escape')

    view = await openFile(panel, MDX_FILE)
    const preview = view.locator('.fv-md-preview')
    await expect(preview).toContainText(MDX_LINE, { timeout: 10_000 })
    expect((await chipOffWords(page, view, preview)).seen, 'read-only render blocks looked at').toBeGreaterThan(0)
  })

  test('Files: the markdown Source tab (pill)', async ({ page }) => {
    const panel = await openSession(page)
    const view = await openFile(panel, MD_FILE)
    await view.getByRole('button', { name: 'Source', exact: true }).click()
    const cm = view.locator('.cm-content')
    await expect(cm).toContainText(MD_SOURCE_LINE, { timeout: 10_000 })
    const askHere = page.locator('[data-testid="file-ask-here"]')
    await selectUntil(page, () => textRects(cm, MD_SOURCE_LINE), askHere)
    await humanPress(page, askHere)
    await expectCardLanded(page, view, 'files-md-source', () => textRects(cm, MD_SOURCE_LINE, 0, false))
    // Back to the preview for the next test (the tab is remembered per file).
    await view.getByRole('button', { name: 'Preview', exact: true }).click()
  })

  test('Files: a code file in the source editor (pill)', async ({ page }) => {
    const panel = await openSession(page)
    const view = await openFile(panel, GO_FILE)
    const cm = view.locator('.cm-content')
    await expect(cm).toContainText(GO_LINE, { timeout: 10_000 })
    const askHere = page.locator('[data-testid="file-ask-here"]')
    await selectUntil(page, () => textRects(cm, GO_LINE), askHere)
    await humanPress(page, askHere)
    await expectCardLanded(page, view, 'files-code-source', () => textRects(cm, GO_LINE, 0, false))
  })

  test('Files: the read-only markdown render (.mdx, pill)', async ({ page }) => {
    const panel = await openSession(page)
    const view = await openFile(panel, MDX_FILE)
    const preview = view.locator('.fv-md-preview')
    await expect(preview).toContainText(MDX_LINE, { timeout: 10_000 })
    const askHere = page.locator('[data-testid="file-ask-here"]')
    await selectUntil(page, () => textRects(preview, MDX_LINE), askHere)
    await humanPress(page, askHere)
    await expectCardLanded(page, view, 'files-md-readonly', () => textRects(preview, MDX_LINE, 0, false))
  })

  test('Files: the read-only render re-rendered between the selection and the press: Ask here still opens the card', async ({ page }) => {
    // 2026-11-06, the Mac app: Ask here on the .mdx render once opened nothing.
    // The press asked with a range kept at mouseup, and a re-render of the view
    // in between (React rewriting its html) leaves that range pointing at
    // nothing: the ask returned silently. It now asks with the QUOTE taken at
    // mouseup (text, found again in the new DOM), and says why when it cannot.
    const panel = await openSession(page)
    const view = await openFile(panel, MDX_FILE)
    const preview = view.locator('.fv-md-preview')
    await expect(preview).toContainText(MDX_LINE, { timeout: 10_000 })
    const askHere = page.locator('[data-testid="file-ask-here"]')
    await selectUntil(page, () => textRects(preview, MDX_LINE), askHere)
    // The same html written again (every node the selection was in is replaced)
    // and Ask here pressed in the same task: the window before the selection's
    // loss reaches the pill (its selectionchange comes later, and dismisses it).
    // Pressed later, the pill is gone, which is right: the words are unselected.
    const pressed = await preview.evaluate((el) => {
      const before = el.firstElementChild
      el.innerHTML = el.innerHTML // eslint-disable-line no-self-assign
      const btn = document.querySelector<HTMLButtonElement>('[data-testid="file-ask-here"]')
      btn?.click()
      return { replaced: el.firstElementChild !== before, pressed: !!btn }
    })
    expect(pressed, 'the render was replaced under the pill, and Ask here pressed').toEqual({ replaced: true, pressed: true })
    await expectCardLanded(page, view, 'files-md-readonly-rerendered', () => textRects(preview, MDX_LINE, 0, false))
    await expect(page.locator('[data-testid="file-ask-notice"]')).toHaveCount(0)
  })

  test('Files: the read-only code view (a truncated read, pill)', async ({ page }) => {
    // A truncated read has no content hash: the viewer shows the read-only <pre>.
    await page.route((url) => url.pathname === '/api/file-content' && (url.searchParams.get('path') ?? '').endsWith(`/${RO_FILE}`), async (route) => {
      const res = await route.fetch({ headers: { ...route.request().headers(), 'if-none-match': '' } })
      const body = await res.json() as Record<string, unknown>
      delete body.contentHash
      await route.fulfill({ json: { ...body, truncated: true, size: 600 * 1024 } })
    })
    const panel = await openSession(page)
    const view = await openFile(panel, RO_FILE)
    const pre = view.locator('pre.file-viewer-code')
    await expect(pre).toContainText(RO_LINE, { timeout: 10_000 })
    const askHere = page.locator('[data-testid="file-ask-here"]')
    await selectUntil(page, () => textRects(pre, RO_LINE), askHere)
    await humanPress(page, askHere)
    await expectCardLanded(page, view, 'files-code-readonly', () => textRects(pre, RO_LINE, 0, false), async (card) => {
      await expectCardRightOfGutter(card, pre.locator('.fv-line-text'), 'files-code-readonly')
    })
  })

  test('Files: the HTML preview (an iframe, pill)', async ({ page }) => {
    const panel = await openSession(page)
    const view = await openFile(panel, HTML_FILE)
    await expect(view.frameLocator('.fv-html-preview').locator('body')).toContainText(HTML_PASSAGE, { timeout: 15_000 })
    const askHere = page.locator('[data-testid="file-ask-here"]')
    await selectUntil(page, () => frameTextRects(view, HTML_PASSAGE), askHere)
    await humanPress(page, askHere)
    await expectCardLanded(page, view, 'files-html', () => frameTextRects(view, HTML_PASSAGE))
  })

  test.describe('Changed', () => {
    let cwd = ''
    let md = ''
    let go = ''
    let caller = ''
    test.beforeEach(async ({ page, request }) => {
      cwd = ((await readRecord(request, TAGGED_SESSION)) as unknown as { cwd: string }).cwd
      expect(cwd, 'the fixture session has a cwd').toBeTruthy()
      md = await fs.readFile(`${cwd}/${MD_FILE}`, 'utf8')
      go = await fs.readFile(`${cwd}/${GO_FILE}`, 'utf8')
      caller = await fs.readFile(`${cwd}/${RO_FILE}`, 'utf8')
      await stubChanges(page, cwd, [
        { rel: RO_FILE, before: '', after: caller, status: 'added' },
        { rel: GO_FILE, before: go.replace('// registerResources wires the informers.', '// registerResources wires informers.'), after: go, status: 'modified' },
        { rel: MD_FILE, before: md.replace('A late flush can hide an', 'A late flush may hide an'), after: md, status: 'modified' },
      ])
    })

    const askHereBtn = (page: Page) => page.locator('[data-testid="file-ask-here"]')
    const quoteBtn = (page: Page) => page.locator('[data-testid="file-ask-quote"]')

    /** Select `phrase` in the diff and press the pill's Ask here: the card must land. */
    async function askHereInDiff(page: Page, diff: Locator, phrase: string, name: string): Promise<Locator> {
      await selectUntil(page, () => textRects(diff.locator('.session-diff-main'), phrase), askHereBtn(page))
      await expect(quoteBtn(page)).toBeVisible()
      await humanPress(page, askHereBtn(page))
      return expectCardShown(page, diff, name, () => textRects(diff.locator('.session-diff-main'), phrase, 0, false))
    }

    /** Select `phrase` in the diff and press Quote in chat. */
    async function quoteInDiff(page: Page, diff: Locator, phrase: string): Promise<void> {
      await selectUntil(page, () => textRects(diff.locator('.session-diff-main'), phrase), quoteBtn(page))
      await humanPress(page, quoteBtn(page))
    }

    test('Changed: a unified diff (an added file): Ask here records a file question; another file closes an unwritten one', async ({ page, request }) => {
      const panel = await openSession(page)
      const diff = await openChanged(panel, RO_FILE)
      const card = await askHereInDiff(page, diff, RO_LINE, 'changed-unified')
      await expectCardRightOfGutter(card, diff.locator('td.diff-code'), 'changed-unified')
      // The new side's line, the same record as the Files tab's.
      const anchor = await sendAndCheckRecord(request, card, 'Why print instead of returning an error?', `${cwd}/${RO_FILE}`, RO_LINE)
      expect(anchor.quote!.exact).toBe(RO_LINE)
      expect(anchor.line).toBe(5)

      // An unwritten Ask, then another file of the diff list: the card closes.
      await askHereInDiff(page, diff, 'func wait', 'changed-unified-again')
      await diff.locator('.session-diff-tree-file', { hasText: GO_FILE }).first().click()
      await expect(diff.locator(`.session-diff-filepane[data-file-path$="${GO_FILE}"]`)).toBeVisible({ timeout: 15_000 })
      await expect(diff.locator('.thread-card')).toHaveCount(0)
    })

    test('Changed: a unified diff: Quote in chat', async ({ page }) => {
      const panel = await openSession(page)
      const diff = await openChanged(panel, RO_FILE)
      await quoteInDiff(page, diff, RO_LINE)
      await expectComposerQuoted(page, panel, RO_LINE, 'changed-unified-quote')
    })

    test('Changed: a split diff: the new side and the left copy of an unchanged line are asked about; a removed line only quoted', async ({ page, request }) => {
      const panel = await openSession(page)
      const diff = await openChanged(panel, GO_FILE)
      // Split needs a diff pane two code columns wide (856fd6db5): beside the
      // chat at 1400px the pane is about 580px, so Split reads unified and says
      // so. Hide the chat, as the tag asks, and the same diff splits.
      await diff.getByRole('button', { name: 'Split', exact: true }).click()
      const tooNarrow = diff.getByText('unified: too narrow to split')
      await expect(tooNarrow).toBeVisible({ timeout: 10_000 })
      await panel.getByRole('button', { name: 'Hide chat', exact: true }).click()
      await expect(tooNarrow).toHaveCount(0)
      await expect(diff.locator('.diff-split').first()).toBeVisible({ timeout: 10_000 })

      // The changed line's new side.
      let card = await askHereInDiff(page, diff, GO_NEW, 'changed-split-new')
      let anchor = await sendAndCheckRecord(request, card, 'Which informers?', `${cwd}/${GO_FILE}`, GO_NEW)
      expect(anchor.quote!.exact).toBe(GO_NEW)
      expect(anchor.line).toBe(3)

      // An unchanged line, selected in its LEFT copy: the question is about the file's line.
      card = await askHereInDiff(page, diff, GO_CONTEXT, 'changed-split-context')
      anchor = await sendAndCheckRecord(request, card, 'Who calls this?', `${cwd}/${GO_FILE}`, GO_CONTEXT)
      expect(anchor.quote!.exact).toBe(GO_CONTEXT)
      expect(anchor.line).toBe(4)

      // Down the right side over three lines: through the left column's removed
      // line (DOM order) and a blank line. The quote is the file's text, as the
      // Files tab indexes it: lines joined, no filler for the blank one.
      const main = diff.locator('.session-diff-main')
      await selectUntil(page, async () => [
        (await textRects(main, 'package marina', 1))[0], ...(await textRects(main, GO_NEW)).slice(-1),
      ], askHereBtn(page))
      await humanPress(page, askHereBtn(page))
      card = await expectCardShown(page, diff, 'changed-split-multiline', async () => [
        ...(await textRects(main, 'package marina', 1, false)), ...(await textRects(main, GO_NEW, 0, false)),
      ])
      // Its mark paints the file's text only: no gutter number, no removed line.
      const painted = await diff.locator('.session-diff-filepane').evaluate((pane) => {
        const reg = (CSS as unknown as { highlights: Map<string, Set<Range>> }).highlights
        let total = 0
        let chrome = 0
        const skip = Array.from(pane.querySelectorAll('.diff-gutter, .diff-code-delete'))
        reg.forEach((h, name) => {
          if (!String(name).startsWith('thread-mark')) return
          h.forEach((r) => {
            if (!pane.contains(r.commonAncestorContainer)) return
            total++
            if (skip.some((el) => r.intersectsNode(el))) chrome++
          })
        })
        return { total, chrome }
      })
      expect(painted.total, 'the passage is marked').toBeGreaterThan(0)
      expect(painted.chrome, 'no mark paints a gutter or a removed line').toBe(0)
      anchor = await sendAndCheckRecord(request, card, 'Why this comment here?', `${cwd}/${GO_FILE}`, GO_NEW)
      // The file's own text, line breaks and the blank line included (2026-11-06:
      // it was `package marina// registerResources ...`, lines joined, which is
      // not in the file and read so in the chat's question rail).
      expect(anchor.quote!.exact).toBe(`package marina\n\n// registerResources ${GO_NEW}`)
      expect(go.includes(anchor.quote!.exact), 'the quote is a passage of the file').toBe(true)
      expect(anchor.line).toBe(1)

      // The removed line: no Ask here, Quote in chat says why and quotes it.
      await selectUntil(page, () => textRects(diff.locator('.session-diff-main'), GO_REMOVED), quoteBtn(page))
      await expect(askHereBtn(page)).toHaveCount(0)
      await expect(quoteBtn(page)).toHaveAttribute('title', /Removed lines are not in the file/)
      await humanPress(page, quoteBtn(page))
      await expectComposerQuoted(page, panel, GO_REMOVED, 'changed-split-removed-quote')
      await diff.getByRole('button', { name: 'Auto', exact: true }).click().catch(() => undefined)
    })

    test('Changed: a rendered markdown diff: Ask here, the card stays on screen while the diff scrolls, Quote in chat', async ({ page, request }) => {
      const panel = await openSession(page)
      const diff = await openChanged(panel, MD_FILE)
      await diff.getByRole('button', { name: 'Rendered', exact: true }).click()
      await expect(diff.locator('.session-diff-rendered')).toContainText(MD_PASSAGE, { timeout: 10_000 })
      const main = diff.locator('.session-diff-main')
      await selectUntil(page, () => textRects(main, MD_PASSAGE), askHereBtn(page))
      await expect(quoteBtn(page)).toBeVisible()
      // Every frame from the press on: the card must show on ONE side, never
      // drawn on one and moved to the other (its side waits for its height).
      await startCardSampler(page, 1_500, MD_PASSAGE)
      await humanPress(page, askHereBtn(page))
      const card = await expectCardShown(page, diff, 'changed-rendered-md', () => textRects(main, MD_PASSAGE, 0, false))
      const samples = await cardSamples(page)
      const shown = samples.filter((x) => x.opacity === '1')
      const story = JSON.stringify(cardChanges(samples))
      expect(shown.length, 'the card was sampled while on show').toBeGreaterThan(0)
      expect(samples.filter((x) => x.opacity !== '1'), `no frame shows the card unseen while it is measured: ${story}`).toEqual([])
      // The passage did not move meanwhile, so neither may the card.
      expect(new Set(shown.map((x) => x.passageBottom)).size, `the passage stays put: ${story}`).toBe(1)
      expect(new Set(shown.map((x) => x.side)).size, `the card keeps one side from its first frame: ${story}`).toBe(1)
      expect(Math.max(...shown.map((x) => x.top)) - Math.min(...shown.map((x) => x.top)), `the card does not move while open: ${story}`).toBeLessThanOrEqual(1)
      // 2026-11-06: a ~70px draft hung ABOVE the passage, over the lines before
      // it, with ~135px free below, because the side was chosen for a 180px card.
      // When the card's own height fits under the passage, it goes there.
      const rects = await textRects(main, MD_PASSAGE, 0, false)
      const lastBottom = Math.max(...rects.map((r) => r.top + r.height))
      const layerBox = (await diff.locator('.fv-thread-layer').boundingBox())!
      const cardBox = (await card.boundingBox())!
      const roomBelow = layerBox.y + layerBox.height - lastBottom - 2 * 8
      test.info().annotations.push({ type: 'rendered-md-room', description: `below ${Math.round(roomBelow)}px, card ${Math.round(cardBox.height)}px` })
      if (cardBox.height <= roomBelow) {
        expect(await cardSide(card), `the card fits below (room ${Math.round(roomBelow)}px, card ${Math.round(cardBox.height)}px): it goes under the passage`).toBe('below')
        expect(cardBox.y).toBeGreaterThanOrEqual(lastBottom - 1)
      }
      const openSide = await cardSide(card)
      // The passage scrolled away: the card stays docked inside the diff, on screen.
      await main.evaluate((el) => { el.scrollTop = el.scrollHeight })
      await page.waitForTimeout(200)
      expect(await seen(card), 'the card stays on screen with the passage scrolled off').toEqual({ inViewport: true, topmost: true })
      await main.evaluate((el) => { el.scrollTop = 0 })
      await page.waitForTimeout(200)
      const sideBeforeSend = await cardSide(card)
      await sendAndCheckRecord(request, card, 'What does the ledger keep?', `${cwd}/${MD_FILE}`, MD_PASSAGE, {
        // Every frame from the send on: the draft becomes a question (its key
        // moves, its body grows with the question and the wait), and the card
        // stays on the side it opened on, scrolling inside its height instead.
        before: () => startCardSampler(page, 3_000, MD_PASSAGE),
        after: async () => {
          const after = await cardSamples(page)
          expect(after.length).toBeGreaterThan(0)
          // While the passage stays where it was: a diff re-rendered or scrolled
          // under the card places it again, which is not a jump.
          const still = after.filter((x) => x.passageBottom === after[0].passageBottom)
          expect(new Set(still.map((x) => x.side)), `the card keeps its side through the send (opened ${openSide}): ${JSON.stringify(cardChanges(after))}`)
            .toEqual(new Set([sideBeforeSend]))
        },
      })

      await quoteInDiff(page, diff, MD_SOURCE_LINE)
      await expectComposerQuoted(page, panel, MD_SOURCE_LINE, 'changed-rendered-md-quote')
    })
  })
})
