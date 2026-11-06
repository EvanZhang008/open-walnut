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
 *    viewport, the topmost thing at its center, its box focused;
 *  - the Changed tab's one button (Ask about this: no card has a place beside a
 *    diff line): the composer focused, on screen, holding the quote.
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
import { expect, type Locator, type Page, type Route } from '@playwright/test'
import fs from 'node:fs/promises'
import { mainComposer, openThreadsSession, readRecord, resetThreadsFixture, test } from './threads-helpers'
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

/** Viewport rects of `phrase` inside `root` (top document), the passage scrolled into view first. */
async function textRects(root: Locator, phrase: string): Promise<Rect[]> {
  const rects = await root.evaluate((el, needle) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const at = (n as Text).data.indexOf(needle)
      if (at === -1) continue
      const r = document.createRange()
      r.setStart(n, at)
      r.setEnd(n, at + needle.length)
      // Off screen only: a scroll of an editor's line from outside moves the box
      // CodeMirror measures from, and it draws its lines over its gutter.
      const box = r.getBoundingClientRect()
      if (box.top < 0 || box.bottom > window.innerHeight) {
        ;(n as Text).parentElement?.scrollIntoView({ block: 'nearest' })
      }
      return Array.from(r.getClientRects()).map((b) => ({ left: b.left, right: b.right, top: b.top, height: b.height }))
    }
    return null
  }, phrase)
  expect(rects, `"${phrase}" is not rendered`).not.toBeNull()
  return rects!
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

/** The Ask landed: a draft card in the file view, opaque and staying so, on screen, its box focused. */
async function expectCardLanded(page: Page, view: Locator, name: string): Promise<void> {
  const card = view.locator('.fv-thread-layer .thread-card')
  await expect(card, `${name}: a card opened`).toBeVisible({ timeout: 5_000 })
  await expect(card).toHaveAttribute('data-draft', 'true')
  // Opaque from its first frame: the card slides in, it never fades from 0
  // (thread-card.css), so this holds even when frames come ~300ms apart.
  expect(await card.evaluate((el) => getComputedStyle(el).opacity), `${name}: the card is opaque at once`).toBe('1')
  // ...and stays: the same element (not remounted every frame) still opaque later.
  await card.evaluate((el) => { (el as HTMLElement).dataset.guardProbe = '1' })
  await page.waitForTimeout(600)
  const later = await card.evaluate((el) => ({ opacity: getComputedStyle(el).opacity, same: (el as HTMLElement).dataset.guardProbe === '1' }))
  expect(later, `${name}: the card stays opaque, mounted once`).toEqual({ opacity: '1', same: true })
  expect(await seen(card), `${name}: the card is on screen and on top`).toEqual({ inViewport: true, topmost: true })
  await expect(card.locator('.thread-card-input'), `${name}: the card's box takes the keyboard`).toBeFocused()
  await shot(page, name)
  // Nothing written: Esc leaves no card behind.
  await card.locator('.thread-card-input').press('Escape')
  await expect(card).toHaveCount(0)
}

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
  const row = diff.locator('.session-diff-tree-file', { hasText: rel.split('/').pop()! }).first()
  if (await row.count()) await row.click()
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
    const askHere = page.locator('[data-testid="bubble-ask-here"]')
    await selectUntil(page, () => textRects(editor, MD_PASSAGE), askHere)
    await askHere.click()
    await expectCardLanded(page, view, 'files-md-wysiwyg')
  })

  test('Files: the markdown Source tab (pill)', async ({ page }) => {
    const panel = await openSession(page)
    const view = await openFile(panel, MD_FILE)
    await view.getByRole('button', { name: 'Source', exact: true }).click()
    const cm = view.locator('.cm-content')
    await expect(cm).toContainText(MD_SOURCE_LINE, { timeout: 10_000 })
    const askHere = page.locator('[data-testid="file-ask-here"]')
    await selectUntil(page, () => textRects(cm, MD_SOURCE_LINE), askHere)
    await askHere.click()
    await expectCardLanded(page, view, 'files-md-source')
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
    await askHere.click()
    await expectCardLanded(page, view, 'files-code-source')
  })

  test('Files: the read-only markdown render (.mdx, pill)', async ({ page }) => {
    const panel = await openSession(page)
    const view = await openFile(panel, MDX_FILE)
    const preview = view.locator('.fv-md-preview')
    await expect(preview).toContainText(MDX_LINE, { timeout: 10_000 })
    const askHere = page.locator('[data-testid="file-ask-here"]')
    await selectUntil(page, () => textRects(preview, MDX_LINE), askHere)
    await askHere.click()
    await expectCardLanded(page, view, 'files-md-readonly')
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
    await askHere.click()
    await expectCardLanded(page, view, 'files-code-readonly')
  })

  test('Files: the HTML preview (an iframe, pill)', async ({ page }) => {
    const panel = await openSession(page)
    const view = await openFile(panel, HTML_FILE)
    await expect(view.frameLocator('.fv-html-preview').locator('body')).toContainText(HTML_PASSAGE, { timeout: 15_000 })
    const askHere = page.locator('[data-testid="file-ask-here"]')
    await selectUntil(page, () => frameTextRects(view, HTML_PASSAGE), askHere)
    await askHere.click()
    await expectCardLanded(page, view, 'files-html')
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

    /** Select `phrase` in the diff and press the pill's one button. The Changed
     *  tab has no Ask here: the diff lends no card a place beside its lines, so
     *  its pill quotes the passage into the composer, which must then be seen. */
    async function askInDiff(page: Page, diff: Locator, phrase: string): Promise<void> {
      const pill = page.locator('.session-diff-ask-pill')
      await selectUntil(page, () => textRects(diff.locator('.session-diff-main'), phrase), pill)
      await expect(pill).toHaveText('Ask about this')
      await pill.click()
    }

    test('Changed: a unified diff (an added file)', async ({ page }) => {
      const panel = await openSession(page)
      const diff = await openChanged(panel, RO_FILE)
      await askInDiff(page, diff, RO_LINE)
      await expectComposerQuoted(page, panel, RO_LINE, 'changed-unified')
    })

    test('Changed: a split diff (a line changed in place)', async ({ page }) => {
      const panel = await openSession(page)
      const diff = await openChanged(panel, GO_FILE)
      await diff.getByRole('button', { name: 'Split', exact: true }).click()
      await expect(diff.locator('.diff-split, table.diff-split, .diff.diff-split').first()).toBeVisible({ timeout: 10_000 })
      await askInDiff(page, diff, GO_LINE)
      await expectComposerQuoted(page, panel, GO_LINE, 'changed-split')
      await diff.getByRole('button', { name: 'Auto', exact: true }).click().catch(() => undefined)
    })

    test('Changed: a rendered markdown diff', async ({ page }) => {
      const panel = await openSession(page)
      const diff = await openChanged(panel, MD_FILE)
      await diff.getByRole('button', { name: 'Rendered', exact: true }).click()
      await expect(diff.locator('.session-diff-rendered')).toContainText(MD_PASSAGE, { timeout: 10_000 })
      await askInDiff(page, diff, MD_PASSAGE)
      await expectComposerQuoted(page, panel, MD_PASSAGE, 'changed-rendered-md')
    })
  })
})
