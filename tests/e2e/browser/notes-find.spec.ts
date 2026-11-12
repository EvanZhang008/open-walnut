/**
 * Cmd+F over a note searches the NOTE (2026-11-04, the user in the Mac app: "the
 * search should search in the notes not the whole page here it doesn't even find
 * it"; then, after a Notes search hit opened with "?/5" and nothing lit: "I click
 * this it should show highlight the search item right").
 *
 * The page find used to walk the whole page and skip every contenteditable, so a
 * note's own words never counted and the sidebar's did. Here a long invented note
 * holds the needle in bold, a list, a link, a table cell, an upper-case copy and
 * a last paragraph far below the fold; the sidebar holds it too (another note's
 * name), and must not count. Covered: the rendered editor (pressed in the note,
 * and from the sidebar), the raw markdown view (CodeMirror: off-screen lines are
 * not in the DOM), the case toggle, typing into the note with the bar open, and
 * opening a note from a Notes search hit.
 *
 * Real notes in the fixture vault, real clicks and keys. Runs in both engines:
 * Chromium by default, WebKit (the Mac app's) with `PW_WEBKIT=1 ... --project webkit`.
 */
import { test, expect, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'

test.setTimeout(150_000)
// Every test seeds the same notes (one set per project) and several edit them, so
// two tests of one project at once rewrite each other's note mid-test (2026-11-08
// gate: a sibling's seed put back the ledger under a typed word). One after another.
test.describe.configure({ mode: 'default' })

const NEEDLE = 'zircon4471'
/** The Notes page's own editor (Home's Scratchpad keeps another one mounted, hidden). */
const NOTE = '.notes-editor-pane .notes-editor .tiptap'
const SHOT_DIR = process.env.WALNUT_TASK_DIR ? `${process.env.WALNUT_TASK_DIR}/shots/notes-find` : '/tmp/notes-find'

const tag = () => `nfind${test.info().project.name}`
const mainNote = () => `${tag()}-ledger`
/** Its name puts the needle in the sidebar tree, outside the note. */
const sideNote = () => `${tag()}-${NEEDLE}-elsewhere`
const kiteNote = () => `${tag()}-kite-log`

function padding(n: number, from = 0): string[] {
  return Array.from({ length: n }, (_, i) =>
    `Filler paragraph ${from + i} keeps this note long enough to scroll through, with plain words only.`)
}

function ledgerBody(): string {
  return [
    `# Lantern ledger`,
    '',
    `**Reference code:** ${NEEDLE}`,
    '',
    '## Items',
    '',
    `- First item names **${NEEDLE}** in bold`,
    '- Second item says nothing in particular',
    '',
    `See [the ${NEEDLE} page](https://example.com/ref) for more.`,
    '',
    '| Field | Value |',
    '| --- | --- |',
    `| code | ${NEEDLE} |`,
    '| owner | nobody |',
    '',
    `Upper case copy: ${NEEDLE.toUpperCase()}.`,
    '',
    ...padding(70).flatMap((p) => [p, '']),
    `Last line, far below the fold: ${NEEDLE}.`,
  ].join('\n')
}

/** "meadow violet" is not in it as typed; its words cluster only at the end
 *  of a long paragraph far down, which also holds an earlier "violet". */
function kiteBody(): string {
  return [
    '# Kite log',
    '',
    '- violet lamp by the door',
    '',
    ...padding(40, 100).flatMap((p) => [p, '']),
    `A violet ribbon starts this paragraph. ${padding(6, 300).join(' ')} The violet kite drifted over the meadow at dawn.`,
    '',
    ...padding(5, 200).flatMap((p) => [p, '']),
  ].join('\n')
}

const heronNote = () => `${tag()}-heron-log`
/** Three copies of "heron" in ONE short paragraph, so a search hit's snippet
 *  marks all of them: only the last is next to "marsh". */
const HERON_LINE = 'A heron by the gate, a heron on the roof and a heron over the marsh at dusk.'
function heronBody(): string {
  return ['# Heron log', '', ...padding(30, 500).flatMap((p) => [p, '']), HERON_LINE, '', ...padding(5, 600).flatMap((p) => [p, ''])].join('\n')
}

/** The bar and the first pixel of the note's own text: the bar must end above it. */
function barAndText(page: Page) {
  return page.evaluate(() => {
    const bar = document.querySelector('.page-find')!.getBoundingClientRect()
    const frame = document.querySelector('.notes-editor-pane .notes-editor-content')!
    const top = frame.getBoundingClientRect().top + parseFloat(getComputedStyle(frame).borderTopWidth)
    return { barBottom: bar.bottom, textTop: top }
  })
}

async function put(page: Page, name: string, content: string): Promise<void> {
  const res = await page.request.put(`/api/notes-v2/content/${name}.md`, { data: { content } })
  expect(res.ok(), await res.text()).toBe(true)
}

async function openNotes(page: Page, opts: { scratchpad?: boolean } = {}): Promise<void> {
  await page.goto('/')
  await page.waitForLoadState('domcontentloaded')
  if (opts.scratchpad) {
    // Home's Scratchpad with words in it: its editor stays mounted, hidden,
    // ahead of the note in the document while Notes is open.
    const pad = page.locator('.global-notes-section .tiptap')
    // The rail's Scratchpad button toggles it; a layout another spec left on the
    // shared fixture server can start it open, closed, or still loading.
    await expect(page.getByRole('button', { name: 'Scratchpad', exact: true })).toBeVisible({ timeout: 20_000 })
    await expect(async () => {
      if (!(await pad.isVisible())) await page.getByRole('button', { name: 'Scratchpad', exact: true }).click()
      await expect(pad).toBeVisible({ timeout: 3_000 })
    }).toPass({ timeout: 20_000 })
    await pad.click()
    await page.keyboard.type(' scratch words', { delay: 10 })
  }
  await page.locator('.sidebar-nav a[href="/notes"], a[href="/notes"]').first().click()
  await expect(page.locator('.notes-search-input').first()).toBeVisible({ timeout: 30_000 })
}

async function openNote(page: Page, name: string, marker: string): Promise<void> {
  const row = page.locator(`.notes-tree-body [data-node-path="${name}.md"]`)
  await expect(row).toHaveCount(1, { timeout: 20_000 })
  await row.click()
  await expect(page.locator(NOTE)).toContainText(marker, { timeout: 20_000 })
}

const chord = (page: Page) => page.evaluate(() => /Mac|iP/.test(navigator.platform))
  .then((apple) => page.keyboard.press(apple ? 'Meta+f' : 'Control+f'))
const findInput = (page: Page) => page.locator('.page-find input')
const label = (page: Page) => page.locator('.page-find .fv-search-count')

function paint(page: Page) {
  return page.evaluate(() => {
    const reg = (window as unknown as { CSS: { highlights?: Map<string, { size: number }> } }).CSS.highlights
    return { find: reg?.get('walnut-find')?.size ?? 0, active: reg?.get('walnut-find-active')?.size ?? 0 }
  })
}

/** Occurrences in the rendered note, counted independently of the feature. */
function inNote(page: Page, word: string) {
  return page.locator(NOTE).evaluate((el, w) => {
    const text = (el as HTMLElement).innerText.toLowerCase()
    let n = 0
    for (let i = text.indexOf(w); i !== -1; i = text.indexOf(w, i + w.length)) n++
    return n
  }, word.toLowerCase())
}

/** The active match: its text, and whether it shows in the note's pane. */
function activeMatch(page: Page) {
  return page.evaluate(() => {
    const reg = (window as unknown as { CSS: { highlights: Map<string, Set<AbstractRange>> } }).CSS.highlights
    const h = reg.get('walnut-find-active')
    if (!h || !h.size) return null
    const s = [...h][0]!
    const live = document.createRange()
    live.setStart(s.startContainer, s.startOffset)
    live.setEnd(s.endContainer, s.endOffset)
    const r = live.getBoundingClientRect()
    const pane = document.querySelector('.notes-editor-pane .notes-editor-content')!.getBoundingClientRect()
    const block = (s.startContainer.parentElement?.closest('p, li, td, th, h1, h2, h3') as HTMLElement | null)?.innerText ?? ''
    return { text: live.toString(), inView: r.height > 0 && r.top >= pane.top && r.bottom <= pane.bottom, block, offset: s.startOffset }
  })
}

function shot(page: Page, name: string) {
  mkdirSync(SHOT_DIR, { recursive: true })
  return page.screenshot({ path: `${SHOT_DIR}/${test.info().project.name}-${name}.png`, scale: 'css' })
}

// On the Mac (macOS WebKit, the Mac app's engine) each flow is also recorded,
// slowed enough to watch, and the video kept beside the screenshots.
const RECORD = process.platform === 'darwin' || !!process.env.NOTES_FIND_VIDEO
if (RECORD) {
  test.use({
    video: 'on',
    launchOptions: { slowMo: 120 },
  })
}

test.afterEach(async ({ page }, info) => {
  const video = page.video()
  if (!RECORD || !video) return
  await page.close()
  mkdirSync(SHOT_DIR, { recursive: true })
  const slug = info.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 50)
  await video.saveAs(`${SHOT_DIR}/${info.project.name}-${slug}.webm`)
})

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await put(page, mainNote(), ledgerBody())
  await put(page, sideNote(), 'Nothing to see here.')
  await put(page, kiteNote(), kiteBody())
  await put(page, heronNote(), heronBody())
})

test('Cmd+F in a note counts, paints and steps through the note only', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await openNotes(page)
  await openNote(page, mainNote(), 'Lantern ledger')
  // The needle shows in the sidebar too (the other note's name).
  await expect(page.locator('.notes-tree-body').getByText(NEEDLE).first()).toBeVisible()

  await page.locator(NOTE).getByText('Second item says nothing').click()
  await chord(page)
  await expect(findInput(page)).toBeFocused()
  await expect(findInput(page)).toHaveAttribute('placeholder', 'Find in note')
  await page.keyboard.type(NEEDLE, { delay: 30 })

  const want = await inNote(page, NEEDLE)
  expect(want).toBe(6)
  await expect(label(page)).toHaveText(`${want} matches`)
  expect(await paint(page)).toMatchObject({ find: want, active: 0 })
  await shot(page, 'typed')

  // Enter steps through every one, in order, each brought into view: bold,
  // list, link, table cell, upper case, the last line below the fold.
  const blocks: string[] = []
  for (let i = 1; i <= want; i++) {
    await page.keyboard.press('Enter')
    await expect(label(page)).toHaveText(new RegExp(`^\\d+/${want}$`))
    const a = await activeMatch(page)
    expect(a?.text.toLowerCase()).toBe(NEEDLE)
    expect(a?.inView).toBe(true)
    blocks.push(a!.block)
  }
  expect(new Set(blocks).size).toBe(want)
  expect(blocks.some((b) => b.startsWith('Last line'))).toBe(true)
  await shot(page, 'last')
  // Shift+Enter walks back.
  const at = await label(page).textContent()
  await page.keyboard.press('Shift+Enter')
  await expect(label(page)).not.toHaveText(at ?? '')

  // Match case: the upper-case copy drops out, and a match stays chosen
  // (never back to "N matches" after the reader picked one).
  await page.locator('.page-find .fv-search-case').click()
  await expect(label(page)).toHaveText(new RegExp(`^\\d+/${want - 1}$`))
  await page.locator('.page-find .fv-search-case').click()
  await expect(label(page)).toHaveText(new RegExp(`^\\d+/${want}$`))
  expect((await paint(page)).active).toBe(1)

  // Typing the word into the note with the bar open recounts it.
  await page.locator(NOTE).getByText('Second item says nothing').click()
  await page.keyboard.press('End')
  await page.keyboard.type(` ${NEEDLE}`)
  // The match the reader chose stays chosen through the edit.
  await expect(label(page)).toHaveText(new RegExp(`^\\d+/${want + 1}$`))

  // The raw view replaces the rendered one under the open bar: it searches the
  // source now (every copy, also the lines CodeMirror has not drawn), and back.
  // First with no match chosen (the query typed again: it only counts).
  await findInput(page).fill(NEEDLE.slice(0, 6))
  await expect(label(page)).toHaveText(/^\d+ match(es)?$/)
  await findInput(page).press('End')
  await findInput(page).pressSequentially(NEEDLE.slice(6))
  await expect(label(page)).toHaveText(`${want + 1} matches`)
  await page.locator('.notes-raw-toggle-btn').click()
  await expect(page.locator('.notes-raw-view .cm-searchMatch').first()).toBeVisible()
  await expect(label(page)).toHaveText(`${want + 1} matches`)
  await page.locator('.notes-raw-toggle-btn').click()
  await expect(label(page)).toHaveText(`${want + 1} matches`)
  await expect.poll(async () => (await paint(page)).find).toBe(want + 1)
  // A chosen match stays chosen across the toggle, both ways.
  await findInput(page).focus()
  await page.keyboard.press('Enter')
  await expect(label(page)).toHaveText(new RegExp(`^\\d+/${want + 1}$`))
  const chosen = (await label(page).textContent()) ?? ''
  await page.locator('.notes-raw-toggle-btn').click()
  await expect(label(page)).toHaveText(chosen)
  await expect(page.locator('.notes-raw-view .cm-searchMatch-selected')).toBeVisible()
  // Toggled from the bar, the keys stay in the bar: Enter moves on, and never
  // types a newline into the source.
  await expect(findInput(page)).toBeFocused()
  // The saved source (CodeMirror draws only the lines in view, so its DOM text
  // changes with every scroll); past the raw view's save debounce.
  const rawDoc = async () => {
    await page.waitForTimeout(900)
    const res = await page.request.get(`/api/notes-v2/content/${mainNote()}.md`)
    return ((await res.json()) as { content?: string }).content ?? null
  }
  const source = await rawDoc()
  expect(source).toContain(NEEDLE)
  await page.keyboard.press('Enter')
  await expect(label(page)).not.toHaveText(chosen)
  await page.keyboard.press('Shift+Enter')
  await expect(label(page)).toHaveText(chosen)
  expect(await rawDoc()).toBe(source)
  // Back with the keyboard shortcut, from the bar: the same match, focus kept.
  await page.keyboard.press('ControlOrMeta+e')
  await expect(page.locator('.notes-raw-view')).toHaveCount(0)
  await expect(label(page)).toHaveText(chosen)
  await expect.poll(async () => (await paint(page)).active).toBe(1)
  await expect(findInput(page)).toBeFocused()
  // And there again with the shortcut.
  await page.keyboard.press('ControlOrMeta+e')
  await expect(page.locator('.notes-raw-view .cm-searchMatch-selected')).toBeVisible()
  await expect(label(page)).toHaveText(chosen)
  await expect(findInput(page)).toBeFocused()
  await page.keyboard.press('ControlOrMeta+e')
  await expect(label(page)).toHaveText(chosen)

  // Escape from the field closes it and takes the paint off.
  await findInput(page).focus()
  await page.keyboard.press('Escape')
  await expect(page.locator('.page-find')).toHaveCount(0)
  expect(await paint(page)).toMatchObject({ find: 0, active: 0 })
  expect(errors).toEqual([])
})

test('Cmd+F from the sidebar still searches the open note, never the sidebar', async ({ page }) => {
  await openNotes(page)
  await openNote(page, mainNote(), 'Lantern ledger')
  await page.locator('.notes-search-input').first().click()
  await chord(page)
  await expect(findInput(page)).toHaveAttribute('placeholder', 'Find in note')
  await findInput(page).fill(NEEDLE)
  await expect(label(page)).toHaveText(`${await inNote(page, NEEDLE)} matches`)
})

test('the raw markdown view is searched through CodeMirror, off-screen lines included', async ({ page }) => {
  await openNotes(page)
  await openNote(page, mainNote(), 'Lantern ledger')
  await page.locator('.notes-raw-toggle-btn').click()
  await expect(page.locator('.notes-raw-view .cm-content')).toBeVisible()
  await page.locator('.notes-raw-view .cm-content').click({ position: { x: 40, y: 20 } })
  // Undo with nothing typed undoes nothing: loading the note is not an edit
  // (one Ctrl+Z used to empty the note and save it empty).
  await page.keyboard.press('ControlOrMeta+z')
  await expect(page.locator('.notes-raw-view .cm-content')).toContainText('Lantern ledger')
  await chord(page)
  await expect(findInput(page)).toBeFocused()
  await page.keyboard.type(NEEDLE, { delay: 30 })
  // Six in the source, the last one hundreds of lines below what CodeMirror
  // draws. Typing only paints and counts, as in the rendered note.
  await expect(label(page)).toHaveText('6 matches')
  await expect(page.locator('.notes-raw-view .cm-searchMatch').first()).toBeVisible()
  // The first press picks from where the view is (it keeps its scroll per
  // note); six presses then visit all six, wrapping.
  const seen = new Set<string>()
  for (let i = 1; i <= 6; i++) {
    await page.keyboard.press('Enter')
    await expect(label(page)).toHaveText(/^[1-6]\/6$/)
    seen.add((await label(page).textContent()) ?? '')
  }
  expect(seen.size).toBe(6)
  // End on the last one, below everything CodeMirror drew at first.
  while ((await label(page).textContent()) !== '6/6') await page.keyboard.press('Enter')
  await expect(page.locator('.notes-raw-view .cm-searchMatch-selected')).toBeVisible()
  await expect(page.locator('.notes-raw-view .cm-line', { hasText: 'Last line, far below the fold' })).toBeVisible()
  await shot(page, 'raw')
  // An edit in the source recounts.
  await page.locator('.notes-raw-view .cm-line', { hasText: 'Last line, far below the fold' }).click()
  await page.keyboard.press('End')
  await page.keyboard.type(` ${NEEDLE}`)
  await expect(label(page)).toHaveText(/\/7$/)
})

test('a Notes search hit opens with the word found, painted, and the hit\'s match chosen', async ({ page }) => {
  await openNotes(page, { scratchpad: true })
  const q = 'meadow violet'
  const input = page.locator('.notes-search-input').first()
  await input.click()
  await input.fill(q)
  const hit = page.locator('.notes-search-results .notes-search-result', { hasText: 'violet kite' })
  await expect(hit.first()).toBeVisible({ timeout: 20_000 })
  await hit.first().click()
  await expect(page.locator(NOTE)).toContainText('Kite log', { timeout: 20_000 })

  // The typed words are not in the note as typed: the bar takes the word the
  // search marked, counts every copy in the note and chooses the one in the
  // paragraph the hit came from, far down, not the list item.
  await expect(page.locator('.page-find')).toBeVisible({ timeout: 10_000 })
  await expect(findInput(page)).toHaveValue(/violet|meadow/)
  const word = await findInput(page).inputValue()
  const total = await inNote(page, word)
  await expect(label(page)).toHaveText(new RegExp(`^\\d+/${total}$`))
  const shown = (await label(page).textContent()) ?? ''
  expect(shown.startsWith('?')).toBe(false)
  expect(await paint(page)).toMatchObject({ find: total, active: 1 })
  // The copy the hit's text starts at: the last one, late in that paragraph,
  // not its first "violet" nor the list item's.
  expect(total).toBe(3)
  await expect(label(page)).toHaveText('3/3')
  await expect.poll(async () => (await activeMatch(page))?.block ?? '').toContain('violet kite drifted over the meadow')
  expect((await activeMatch(page))!.offset).toBeGreaterThan(100)
  await expect.poll(async () => (await activeMatch(page))?.inView).toBe(true)
  await expect(findInput(page)).toBeFocused()
  await shot(page, 'from-search')

  // Enter moves on from there (wrapping), in the bar, never typing into the note.
  const before = await page.locator(NOTE).innerText()
  await page.keyboard.press('Enter')
  if (total > 1) await expect(label(page)).not.toHaveText(shown)
  expect(await page.locator(NOTE).innerText()).toBe(before)

  // A second hit, in another note, takes over the open bar.
  await input.click()
  await input.fill(NEEDLE)
  const hit2 = page.locator('.notes-search-results .notes-search-result', { hasText: 'ledger' })
  await expect(hit2.first()).toBeVisible({ timeout: 20_000 })
  await hit2.first().click()
  await expect(page.locator(NOTE)).toContainText('Lantern ledger', { timeout: 20_000 })
  await expect(findInput(page)).toHaveValue(NEEDLE, { timeout: 10_000 })
  await expect(label(page)).toHaveText(new RegExp(`^\\d+/${await inNote(page, NEEDLE)}$`))

  // Escape right after a hit gives the caret back to the note, not to nothing.
  await page.keyboard.press('Escape')
  await expect(page.locator('.page-find')).toHaveCount(0)
  await expect.poll(() => page.evaluate((sel) => !!document.activeElement?.closest(sel), NOTE)).toBe(true)

  // Leaving Notes with the bar open closes it (never a bar left over another page).
  await chord(page)
  await expect(findInput(page)).toBeFocused()
  await page.locator('.sidebar-nav a[href="/"], a[href="/"]').first().click()
  await expect(page.locator('.main-page-right').first()).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('.page-find[data-scope="doc"]')).toHaveCount(0, { timeout: 3_000 })
})

test('a Notes search hit for a note open in its raw view chooses the hit\'s copy in the source', async ({ page }) => {
  await openNotes(page)
  await openNote(page, kiteNote(), 'Kite log')
  await page.locator('.notes-raw-toggle-btn').click()
  await expect(page.locator('.notes-raw-view .cm-content')).toBeVisible()
  const input = page.locator('.notes-search-input').first()
  await input.click()
  await input.fill('meadow violet')
  const hit = page.locator('.notes-search-results .notes-search-result', { hasText: 'violet kite' })
  await expect(hit.first()).toBeVisible({ timeout: 20_000 })
  await hit.first().click()
  await expect(findInput(page)).toHaveValue('violet', { timeout: 10_000 })
  await expect(label(page)).toHaveText('3/3')
  const chosen = page.locator('.notes-raw-view .cm-searchMatch-selected')
  await expect(chosen).toBeVisible()
  await expect(page.locator('.notes-raw-view .cm-line', { has: page.locator('.cm-searchMatch-selected') })).toContainText('violet kite drifted')
  await expect(findInput(page)).toBeFocused()
  await shot(page, 'raw-from-search')
})

test('a hit for several words chooses the copy next to the other words, and the bar covers none of the note', async ({ page }) => {
  await openNotes(page)
  const input = page.locator('.notes-search-input').first()
  const openHit = async () => {
    await input.click()
    await input.fill('')
    await input.fill('marsh heron')
    const hit = page.locator('.notes-search-results .notes-search-result', { hasText: 'heron' })
    await expect(hit.first()).toBeVisible({ timeout: 20_000 })
    await hit.first().click()
    await expect(findInput(page)).toHaveValue('heron', { timeout: 10_000 })
  }
  await openHit()
  await expect(page.locator(NOTE)).toContainText('Heron log', { timeout: 20_000 })
  // Its snippet marks the paragraph's three herons (the title holds a fourth);
  // the one beside "marsh" is the last.
  await expect(label(page)).toHaveText('4/4')
  await expect.poll(async () => (await activeMatch(page))?.offset).toBe(HERON_LINE.indexOf('heron over'))
  await expect.poll(async () => (await activeMatch(page))?.inView).toBe(true)
  // The bar sits in a strip above the text, not over it.
  const r = await barAndText(page)
  expect(r.barBottom).toBeLessThanOrEqual(r.textTop)
  await shot(page, 'heron-rendered')
  // Closing gives the strip back.
  await page.keyboard.press('Escape')
  await expect(page.locator('.page-find')).toHaveCount(0)
  expect(await page.locator('.notes-editor-pane .notes-editor-content').evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe('0px')

  // The raw view: the same copy, in the source.
  await page.locator('.notes-raw-toggle-btn').click()
  await expect(page.locator('.notes-raw-view .cm-content')).toBeVisible()
  await openHit()
  await expect(label(page)).toHaveText('4/4')
  await expect.poll(() => page.locator('.notes-raw-view .cm-searchMatch-selected').evaluate((el) => {
    // The text right after the chosen match, across CodeMirror's spans.
    const line = el.closest('.cm-line')!
    const all = (line as HTMLElement).innerText
    const before = document.createRange()
    before.setStart(line, 0)
    before.setEndAfter(el)
    return all.slice(before.toString().length, before.toString().length + 10)
  })).toBe(' over the ')
  const raw = await barAndText(page)
  expect(raw.barBottom).toBeLessThanOrEqual(raw.textTop)
  await shot(page, 'heron-raw')
  await page.locator('.notes-raw-toggle-btn').click()
})

test('a word selected in the note fills the bar', async ({ page }) => {
  await openNotes(page)
  await openNote(page, mainNote(), 'Lantern ledger')
  // Double-click the word itself (the paragraph's box runs the whole line). The
  // note may open scrolled (its kept scroll place) or still settling, so bring
  // the word into view first and try again until the double-click selects it.
  const wordAt = () => page.locator(NOTE).evaluate((root) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = (n as Text).data.indexOf('Upper')
      if (i < 0) continue
      n.parentElement?.scrollIntoView({ block: 'center' })
      const r = document.createRange()
      r.setStart(n, i)
      r.setEnd(n, i + 5)
      const b = r.getBoundingClientRect()
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 }
    }
    throw new Error('no word')
  })
  let picked = ''
  await expect(async () => {
    const first = await wordAt()
    await page.waitForTimeout(150)
    const at = await wordAt()
    expect(Math.abs(at.y - first.y)).toBeLessThan(2)
    await page.mouse.dblclick(at.x, at.y)
    picked = (await page.evaluate(() => getSelection()?.toString() ?? '')).trim()
    expect(picked).toBe('Upper')
  }).toPass({ timeout: 20_000 })
  await chord(page)
  await expect(findInput(page)).toHaveValue(picked)
  await expect(label(page)).toHaveText(/^\d+ match(es)?$/)
})

test('a hit whose word is not in the note body opens no bar', async ({ page }) => {
  const name = `${tag()}-pelicanword-title-only`
  await put(page, name, 'Body without the word at all.')
  await openNotes(page)
  const input = page.locator('.notes-search-input').first()
  await input.click()
  await input.fill('pelicanword')
  const hit = page.locator('.notes-search-results .notes-search-result', { hasText: 'pelicanword' })
  await expect(hit.first()).toBeVisible({ timeout: 20_000 })
  await hit.first().click()
  await expect(page.locator(NOTE)).toContainText('Body without the word', { timeout: 20_000 })
  // Past the jump's whole retry budget: still no bar, and keys stay the reader's.
  await page.waitForTimeout(4000)
  await expect(page.locator('.page-find')).toHaveCount(0)

  // With a bar already open from another note, such a hit closes it: it would
  // otherwise search this note for the old word ("No results").
  await input.fill('')
  await openNote(page, mainNote(), 'Lantern ledger')
  await page.locator(NOTE).getByText('Second item says nothing').click()
  await chord(page)
  await findInput(page).fill(NEEDLE)
  await expect(label(page)).toHaveText(/^(\d+\/6|6 matches)$/)
  await input.click()
  await input.fill('pelicanword')
  await expect(hit.first()).toBeVisible({ timeout: 20_000 })
  await hit.first().click()
  await expect(page.locator(NOTE)).toContainText('Body without the word', { timeout: 20_000 })
  // At once, never a "No results" bar over the new note first.
  await expect(page.locator('.page-find')).toHaveCount(0, { timeout: 1_500 })
})

test('the caret stays where the reader was across a view toggle, and Aa shows its new pick', async ({ page }) => {
  await openNotes(page)
  await openNote(page, mainNote(), 'Lantern ledger')
  const raw = page.locator('.notes-raw-view .cm-content')
  const inNoteFocus = () => page.evaluate(() => {
    const a = document.activeElement
    return a?.closest('.notes-raw-view') ? 'raw' : a?.closest('.notes-editor .tiptap') ? 'rendered' : a?.closest('.page-find') ? 'bar' : (a?.tagName ?? 'none')
  })

  // Bar closed: the caret moves with the view, both ways.
  await page.locator(NOTE).getByText('Second item says nothing').click()
  await page.keyboard.press('ControlOrMeta+e')
  await expect(raw).toBeVisible()
  await expect.poll(inNoteFocus).toBe('raw')
  await page.keyboard.press('ControlOrMeta+e')
  await expect(raw).toHaveCount(0)
  await expect.poll(inNoteFocus).toBe('rendered')

  // Bar open, toggled from inside the note: the caret stays in the note, the
  // keys never go to the bar (typing there would replace the query).
  await chord(page)
  await page.keyboard.type(NEEDLE)
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await expect(label(page)).toHaveText('2/6')
  await page.locator(NOTE).getByText('Second item says nothing').click()
  await page.keyboard.press('ControlOrMeta+e')
  await expect(raw).toBeVisible()
  await expect.poll(inNoteFocus).toBe('raw')
  await expect(label(page)).toHaveText('2/6')
  await page.keyboard.press('ControlOrMeta+e')
  await expect(raw).toHaveCount(0)
  await expect.poll(inNoteFocus).toBe('rendered')
  await expect(findInput(page)).toHaveValue(NEEDLE)
  await expect(label(page)).toHaveText('2/6')

  // Aa while the upper-case copy is chosen: it drops out, the next copy (far
  // below) is chosen and brought into view. First let the rendered editor take
  // the source back from the toggle (it scrolls to its caret when it does).
  await page.waitForTimeout(1500)
  await findInput(page).focus()
  for (let i = 0; i < 6; i++) {
    if ((await activeMatch(page))?.text === NEEDLE.toUpperCase()) break
    await page.keyboard.press('Enter')
  }
  expect((await activeMatch(page))?.text).toBe(NEEDLE.toUpperCase())
  await page.locator('.page-find .fv-search-case').click()
  await expect(label(page)).toHaveText(/^5\/5$/)
  await expect.poll(async () => (await activeMatch(page))?.block ?? '').toMatch(/^Last line/)
  await expect.poll(async () => (await activeMatch(page))?.inView).toBe(true)

  // Escape after a bar button was pressed (opened from the tab strip, where
  // nothing had focus): the caret goes back to the note.
  await page.locator('.page-find .fv-search-case').click()
  await page.keyboard.press('Escape')
  await page.locator('.notes-tab.active').click()
  await chord(page)
  await findInput(page).fill(NEEDLE)
  await page.locator('.page-find button[aria-label="Next match"]').click()
  // The click leaves the keys in the field: Enter moves on, Escape closes.
  await expect(findInput(page)).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.locator('.page-find')).toHaveCount(0)
  await expect.poll(inNoteFocus).toBe('rendered')

  // An arrow clicked while the caret is in the note takes the keys to the bar:
  // Enter then moves on and never splits the paragraph.
  await chord(page)
  await findInput(page).fill(NEEDLE)
  await page.locator(NOTE).getByText('Second item says nothing').click()
  const text = await page.locator(NOTE).innerText()
  await page.locator('.page-find button[aria-label="Next match"]').click()
  await expect(findInput(page)).toBeFocused()
  const at = (await label(page).textContent()) ?? ''
  await page.keyboard.press('Enter')
  await expect(label(page)).not.toHaveText(at)
  expect(await page.locator(NOTE).innerText()).toBe(text)

  // Escape with the caret in the rendered note closes the bar (VS Code).
  await page.locator(NOTE).getByText('Second item says nothing').click()
  await page.keyboard.press('Escape')
  await expect(page.locator('.page-find')).toHaveCount(0)
  await expect.poll(inNoteFocus).toBe('rendered')
  await chord(page)
  await findInput(page).fill(NEEDLE)

  // Escape in the raw view goes back to the raw view, never the page body.
  await page.keyboard.press('ControlOrMeta+e')
  await expect(raw).toBeVisible()
  await page.locator('.notes-raw-view .cm-line').first().click()
  await findInput(page).click()
  await page.keyboard.press('Escape')
  await expect(page.locator('.page-find')).toHaveCount(0)
  await expect.poll(inNoteFocus).toBe('raw')

  // Escape with the caret in the note closes the bar too (VS Code).
  await chord(page)
  await findInput(page).fill(NEEDLE)
  await page.locator('.notes-raw-view .cm-line').first().click()
  await page.keyboard.press('Escape')
  await expect(page.locator('.page-find')).toHaveCount(0)
  await expect.poll(inNoteFocus).toBe('raw')
  await page.keyboard.press('ControlOrMeta+e')
})
