/**
 * E2E: session Notes hybrid UI —
 *  - NO note  → a small "📝 Notes" pill next to the btw pill (no bar).
 *  - HAS note → an always-visible sticky-note BAR docked above the composer
 *               (highlight + dot + first-line preview); the pill disappears.
 *
 * The dedicated /sessions page was removed — every test exercises the homepage
 * session column (`.main-page-session-column .session-panel`), the only surface.
 *
 *  1. Empty note → pill visible, bar absent; typing auto-saves; reload persists.
 *  2. Saved note → bar visible on load; clearing swaps back to the pill.
 *  3.–5. Links inside a note are CLICKABLE and SHORT (2026-07-29 report: "the
 *     link inside needs to be clickable, and reduce in size, it is too long,
 *     like this in Slack"). The bar rendered raw text, so a pasted deploy URL
 *     was dead text AND long enough to consume the whole one-line row.
 */
import { test, expect, type Page } from '@playwright/test'

// EVERY test here mutates the SAME seeded session's human_note — parallel runs
// race (one test's cleanup clears another's setup). Serialize within this file.
// This is also why the link tests live HERE rather than in their own file: a
// separate spec file would race against this one no matter how each is ordered
// internally, since Playwright parallelizes ACROSS files.
test.describe.configure({ mode: 'serial' })

// The real link from the report (a deploy pipeline change_history URL).
const LONG_URL =
  'https://deploy.example.com/pipelines/MarinaServiceCDK/change_history_v2?changes=Commit%3AMarinaServiceCDK%2Fmainline%3A52fbf32b7ea96e00d3f2af08d823ec1d21dacdef'

// Seed the home column queue (sessionStorage) so the SessionPanel for the
// seeded 'Normal: fix the bug' session mounts on load.
async function openSeededSessionOnHome(page: Page) {
  await page.addInitScript(() => {
    sessionStorage.setItem('open-walnut-home-session-columns', JSON.stringify([{ id: 'pw-normal-session', locked: false }]))
  })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  const panel = page.locator('.main-page-session-column .session-panel[data-session-id="pw-normal-session"]')
  await expect(panel).toBeVisible({ timeout: 10_000 })
  return panel
}

// The edit view is a contentEditable (CollapsibleUrlEditor), not a <textarea> —
// toHaveValue() doesn't apply. Read its model text the same way the component
// does: text nodes verbatim, <br> as newline, trailing sentinel <br> dropped.
async function editorText(locator: import('@playwright/test').Locator): Promise<string> {
  return locator.evaluate((el) => {
    const isBr = (n: Node) => n.nodeType === 1 && (n as Element).tagName === 'BR'
    const flat = (n: Node): string => n.nodeType === 3 ? (n.textContent ?? '') : isBr(n) ? '\n' : Array.from(n.childNodes).map(flat).join('')
    let t = Array.from(el.childNodes).map(flat).join('')
    const last = el.childNodes[el.childNodes.length - 1]
    if (last && isBr(last)) t = t.slice(0, -1)
    return t
  })
}

test('empty → pill next to btw; saving a note swaps to the always-visible bar', async ({ page }) => {
  // Reset the seeded session's note so the test is idempotent across runs
  await page.request.patch('/api/sessions/pw-normal-session', { data: { human_note: '' } })

  const panel = await openSeededSessionOnHome(page)

  // (1) empty note → pill visible next to btw, NO bar
  const pill = panel.locator('.session-notes-pill')
  await expect(pill).toBeVisible({ timeout: 5000 })
  await expect(panel.locator('.session-notes')).toHaveCount(0)
  const btwPill = panel.locator('.side-question-pill', { hasText: 'btw' })
  await expect(btwPill).toBeVisible()
  const pillBox = await pill.boundingBox()
  const btwBox = await btwPill.boundingBox()
  expect(Math.abs(pillBox!.y - btwBox!.y)).toBeLessThan(8) // same row as btw

  // (2) click pill → bar appears in edit mode; type a note (autosave after 1s debounce)
  await pill.click()
  const bar = panel.locator('.session-notes')
  await expect(bar).toBeVisible()
  const textarea = bar.locator('.session-notes-textarea')
  await expect(textarea).toBeVisible()
  await textarea.fill('remember: deploy after AREX confirms')
  await expect(bar.locator('.session-notes-status-saved')).toBeVisible({ timeout: 5000 })

  // (3) note exists → card carries the has-note state; pill disappears
  await expect(bar).toHaveClass(/session-notes--has-note/)
  await expect(pill).toHaveCount(0)

  // Blur the editor (click the chat area) → collapses to the one-line preview row
  await panel.locator('.session-panel-body').click()
  await expect(bar).toBeVisible()
  await expect(bar.locator('.session-notes-preview')).toHaveText(/remember: deploy after AREX confirms/)

  // Bar is docked at the bottom: inside the composer overlay, above the input.
  // NOT "below .session-panel-body" — the composer overlay FLOATS over the
  // scroll area (G4 glass), so the bar's y sits inside the body's box by design.
  const barBox = await bar.boundingBox()
  const inputBox = await panel.locator('.session-panel-input').boundingBox()
  expect(barBox!.y).toBeGreaterThanOrEqual(inputBox!.y - 1)
  expect(barBox!.y).toBeLessThan(inputBox!.y + inputBox!.height)

  // (4) reload → bar persists with preview, pill still gone
  const panel2 = await openSeededSessionOnHome(page)
  const bar2 = panel2.locator('.session-notes')
  await expect(bar2).toBeVisible({ timeout: 5000 })
  await expect(bar2).toHaveClass(/session-notes--has-note/)
  await expect(bar2.locator('.session-notes-preview')).toHaveText(/remember: deploy after AREX confirms/)
  await expect(panel2.locator('.session-notes-pill')).toHaveCount(0)

  // Clearing the note swaps back: open editor, clear, blur → row unmounts, pill returns
  await bar2.locator('.session-notes-toggle').click()
  await bar2.locator('.session-notes-textarea').fill('')
  await expect(bar2.locator('.session-notes-status-saved')).toBeVisible({ timeout: 5000 })
  await panel2.locator('.session-panel-body').click()
  await expect(panel2.locator('.session-notes')).toHaveCount(0)
  await expect(panel2.locator('.session-notes-pill')).toBeVisible()

  // Cleanup
  await page.request.patch('/api/sessions/pw-normal-session', { data: { human_note: '' } })
})

test('homepage session panel: bar when note exists, pill when empty', async ({ page }) => {
  await page.request.patch('/api/sessions/pw-normal-session', { data: { human_note: 'home panel note' } })

  const panel = await openSeededSessionOnHome(page)

  // Note exists → BAR visible (highlighted, with preview), pill absent
  const bar = panel.locator('.session-notes')
  await expect(bar).toBeVisible({ timeout: 5000 })
  await expect(bar).toHaveClass(/session-notes--has-note/)
  await expect(bar.locator('.session-notes-preview')).toHaveText('home panel note')
  await expect(panel.locator('.session-notes-pill')).toHaveCount(0)

  // Bottom-docked: the bar sits at the TOP of the composer overlay, above the
  // ChatInput card. (See the note above — the overlay floats over the body, so
  // "below .session-panel-body" is not a valid assertion.)
  const barBox = await bar.boundingBox()
  const inputBox = await panel.locator('.session-panel-input').boundingBox()
  const chatCardBox = await panel.locator('.session-panel-input .chat-input-card, .session-panel-input textarea').first().boundingBox()
  expect(barBox!.y).toBeGreaterThanOrEqual(inputBox!.y - 1)
  expect(chatCardBox!.y).toBeGreaterThan(barBox!.y)

  // Clear the note → after save + blur, the row unmounts and the pill returns
  await bar.locator('.session-notes-toggle').click()
  const textarea = bar.locator('.session-notes-textarea')
  expect(await editorText(textarea)).toBe('home panel note')
  await textarea.fill('')
  await expect(bar.locator('.session-notes-status-saved')).toBeVisible({ timeout: 5000 })
  await panel.locator('.session-panel-body').click()
  await expect(panel.locator('.session-notes')).toHaveCount(0)
  const pill = panel.locator('.session-notes-pill')
  await expect(pill).toBeVisible()
  const btwPill = panel.locator('.side-question-pill', { hasText: 'btw' })
  const pillBox = await pill.boundingBox()
  const btwBox = await btwPill.boundingBox()
  expect(Math.abs(pillBox!.y - btwBox!.y)).toBeLessThan(8)

  await page.request.patch('/api/sessions/pw-normal-session', { data: { human_note: '' } })
})

test('collapsed note row: URL is a short real anchor; clicking TEXT edits, clicking LINK opens it', async ({ page }) => {
  await page.request.patch('/api/sessions/pw-normal-session', { data: { human_note: `deploy ${LONG_URL} after AREX` } })

  const panel = await openSeededSessionOnHome(page)
  const bar = panel.locator('.session-notes')
  await expect(bar).toBeVisible({ timeout: 5000 })

  // (1) a real anchor carrying the FULL url, opening in a new tab
  const link = bar.locator('.session-notes-preview a')
  await expect(link).toHaveCount(1)
  await expect(link).toHaveAttribute('href', LONG_URL)
  await expect(link).toHaveAttribute('target', '_blank')
  await expect(link).toHaveAttribute('rel', /noopener/)
  // Full URL still recoverable by hover, even though the label is short
  await expect(link).toHaveAttribute('title', LONG_URL)

  // (2) the LABEL is short — the actual regression the user saw
  const label = (await link.innerText()).trim()
  expect(label.length).toBeLessThan(LONG_URL.length / 2)
  expect(label).toContain('deploy.example.com')
  expect(label).toContain('change_history_v2')          // still recognizable
  expect(label).not.toContain('52fbf32b7ea96e00d3f2af')  // opaque sha elided

  // (3) the surrounding prose survives — linkifying must not eat the note text
  await expect(bar.locator('.session-notes-preview')).toContainText('deploy')
  await expect(bar.locator('.session-notes-preview')).toContainText('after AREX')

  // (4) the row fits its panel instead of overflowing (why we shorten at all)
  const rowBox = (await bar.locator('.session-notes-toggle').boundingBox())!
  const panelBox = (await panel.boundingBox())!
  expect(rowBox.x + rowBox.width).toBeLessThanOrEqual(panelBox.x + panelBox.width + 1)

  // (5) Clicking the note TEXT (not the link) opens the editor with the note
  //     VERBATIM — the short label is display-only, never written back.
  await bar.locator('.session-notes-preview').click({ position: { x: 2, y: 2 } })
  const textarea = bar.locator('.session-notes-textarea')
  await expect(textarea).toBeVisible()
  expect(await editorText(textarea)).toBe(`deploy ${LONG_URL} after AREX`)

  // (6) Clicking the LINK opens the link (that's what links are for) and must
  //     NOT also open the editor (stopPropagation on the anchor).
  const panelAgain = await openSeededSessionOnHome(page)
  const barAgain = panelAgain.locator('.session-notes')
  await expect(barAgain.locator('.session-notes-preview')).toBeVisible({ timeout: 5000 })
  await page.route('**/deploy.example.com/**', route => route.abort())
  const popupPromise = page.context().waitForEvent('page', { timeout: 5000 }).catch(() => null)
  await barAgain.locator('.session-notes-preview a').click()
  const popup = await popupPromise
  expect(popup, 'link click should open a new tab').not.toBeNull()
  await popup?.close()
  await expect(barAgain.locator('.session-notes-textarea')).toHaveCount(0)

  await page.request.patch('/api/sessions/pw-normal-session', { data: { human_note: '' } })
})

test('editor does NOT flash shut after opening (blur-unmount race regression)', async ({ page }) => {
  // 2026-07-30 report: "点了之后他也不会进那个 EditView 他就闪一下" — clicking
  // the row opened the editor and a focusout(relatedTarget=null) from the
  // unmounting row instantly collapsed it again. The collapse must never key off
  // a blur-to-null; only outside pointerdown / Tab-out / Escape close it.
  await page.request.patch('/api/sessions/pw-normal-session', { data: { human_note: `deploy ${LONG_URL} after AREX` } })

  const panel = await openSeededSessionOnHome(page)
  const bar = panel.locator('.session-notes')
  await expect(bar).toBeVisible({ timeout: 5000 })

  await bar.locator('.session-notes-preview').click({ position: { x: 2, y: 2 } })
  const textarea = bar.locator('.session-notes-textarea')
  await expect(textarea).toBeVisible()
  // Sample presence across the window where the flash happened (~50-200ms after
  // open). It must be CONTINUOUSLY present — a single gap is the bug.
  for (let i = 0; i < 8; i++) {
    await page.waitForTimeout(100)
    expect(await textarea.count(), `editor vanished ${(i + 1) * 100}ms after opening`).toBe(1)
  }
  // And it must actually be editable: type, autosave fires.
  await textarea.click()
  await textarea.press('End')
  await textarea.type(' — edited')
  await expect(bar.locator('.session-notes-status-saved')).toBeVisible({ timeout: 5000 })

  // Outside pointerdown is what collapses it now.
  await panel.locator('.session-panel-header').click({ position: { x: 5, y: 5 } })
  await expect(bar.locator('.session-notes-textarea')).toHaveCount(0)

  // Escape also collapses (keyboard parity).
  await bar.locator('.session-notes-preview').click({ position: { x: 2, y: 2 } })
  await expect(bar.locator('.session-notes-textarea')).toBeVisible()
  await bar.locator('.session-notes-textarea').press('Escape')
  await expect(bar.locator('.session-notes-textarea')).toHaveCount(0)

  await page.request.patch('/api/sessions/pw-normal-session', { data: { human_note: '' } })
})

test('a multi-line note KEEPS its line structure in the collapsed row', async ({ page }) => {
  // A note is typically a checklist. An earlier attempt folded every newline to
  // a space, which destroyed the shape the user typed ("why did my returns
  // disappear?"). Each typed line must render as its own line — bounded, so the
  // bar can't push the composer around, but not flattened.
  await page.request.patch('/api/sessions/pw-normal-session', {
    data: { human_note: '1. confirm by AREX\n2. deploy the CDK change\n3. verify the rollout' },
  })

  const panel = await openSeededSessionOnHome(page)
  const bar = panel.locator('.session-notes')
  await expect(bar).toBeVisible({ timeout: 5000 })

  // One typed line → one rendered line, in order, each on its own row.
  const lines = bar.locator('.session-notes-line')
  await expect(lines).toHaveCount(3)
  await expect(lines.nth(0)).toHaveText('1. confirm by AREX')
  await expect(lines.nth(1)).toHaveText('2. deploy the CDK change')
  await expect(lines.nth(2)).toHaveText('3. verify the rollout')

  // Each line is vertically BELOW the previous one (not folded side by side).
  const boxes = await lines.evaluateAll(els => els.map(e => e.getBoundingClientRect().y))
  expect(boxes[1]!).toBeGreaterThan(boxes[0]!)
  expect(boxes[2]!).toBeGreaterThan(boxes[1]!)

  // Bounded: the block stays inside the panel width and stays modest in height
  // (clamped to 3 lines, so a 40-line note can't swallow the panel).
  const box = (await bar.locator('.session-notes-preview').boundingBox())!
  const panelBox = (await panel.boundingBox())!
  expect(box.x + box.width).toBeLessThanOrEqual(panelBox.x + panelBox.width + 1)
  expect(box.height).toBeLessThan(70)

  await page.request.patch('/api/sessions/pw-normal-session', { data: { human_note: '' } })
})

test('a long note is clamped, and clicking it still opens the full text', async ({ page }) => {
  const many = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n')
  await page.request.patch('/api/sessions/pw-normal-session', { data: { human_note: many } })

  const panel = await openSeededSessionOnHome(page)
  const bar = panel.locator('.session-notes')
  await expect(bar).toBeVisible({ timeout: 5000 })

  // All lines exist in the DOM, but the visible block is clamped short so the
  // composer above it can't be shoved off-screen by a long note.
  await expect(bar.locator('.session-notes-line')).toHaveCount(12)
  const box = (await bar.locator('.session-notes-preview').boundingBox())!
  expect(box.height).toBeLessThan(70)

  // Click → editor with the COMPLETE text, newlines intact
  await bar.locator('.session-notes-preview').click({ position: { x: 2, y: 2 } })
  expect(await editorText(bar.locator('.session-notes-textarea'))).toBe(many)

  await page.request.patch('/api/sessions/pw-normal-session', { data: { human_note: '' } })
})

test('a URL on line 2+ is clickable INLINE in the note text — no separate chip row', async ({ page }) => {
  // The reported note shape: numbered steps, link NOT on the first line.
  await page.request.patch('/api/sessions/pw-normal-session', {
    data: { human_note: `1. confirm by AREX\n2. Deploy to pipeline ${LONG_URL}\n3. verify` },
  })

  const panel = await openSeededSessionOnHome(page)
  const bar = panel.locator('.session-notes')
  await expect(bar).toBeVisible({ timeout: 5000 })

  // The row shows the WHOLE note folded to one line, so a line-2 link is right
  // there in the text — reachable without lifting it out into its own widget.
  const preview = bar.locator('.session-notes-preview')
  await expect(preview).toContainText('1. confirm by AREX')
  await expect(preview).toContainText('3. verify')

  // The anchor is INSIDE the note text, and there is NO duplicate chip surface.
  const link = preview.locator('a')
  await expect(link).toHaveCount(1)
  await expect(link).toHaveAttribute('href', LONG_URL)
  await expect(link).toHaveAttribute('title', new RegExp(LONG_URL.replace(/[.?*+^$[\]\\(){}|]/g, '\\$&')))
  await expect(bar.locator('.session-notes-link')).toHaveCount(0)
  await expect(bar.locator('.session-notes-links-row')).toHaveCount(0)

  // Inline click opens the link, NOT the editor
  await page.route('**/deploy.example.com/**', route => route.abort())
  await link.click({ modifiers: ['Shift'] })
  await expect(bar.locator('.session-notes-textarea')).toHaveCount(0)

  // Clicking into the note opens the editor whose MODEL holds the full text —
  // this is what makes shortening safe ("customer can use cursor when they go
  // left and you expand to all").
  await preview.click({ position: { x: 2, y: 2 } })
  const textarea = bar.locator('.session-notes-textarea')
  await expect(textarea).toBeVisible()
  expect(await editorText(textarea)).toContain(LONG_URL)
  // Edit mode shows no chip row either — the editor IS the full-text surface.
  await expect(bar.locator('.session-notes-links-row')).toHaveCount(0)

  await page.request.patch('/api/sessions/pw-normal-session', { data: { human_note: '' } })
})

test('EDIT VIEW: URL renders collapsed; caret inside expands it; caret out re-collapses', async ({ page }) => {
  // 2026-07-30: "collapse in the edit view also — paste 时把 link 变小,但所有的
  // Edit 还在;Cursor 进到里面它还是会展开". The editor shows the URL as a small
  // ellipsized pill; the MODEL always holds the full text.
  await page.request.patch('/api/sessions/pw-normal-session', {
    data: { human_note: `check deployment\n${LONG_URL}\ndone` },
  })

  const panel = await openSeededSessionOnHome(page)
  const bar = panel.locator('.session-notes')
  await expect(bar).toBeVisible({ timeout: 5000 })
  await bar.locator('.session-notes-preview').click({ position: { x: 2, y: 2 } })
  const editor = bar.locator('.session-notes-editor')
  await expect(editor).toBeVisible()

  // (1) The URL is a collapsed pill: its span holds the FULL text (model
  // verbatim) but occupies far less width than it would uncollapsed.
  const pill = editor.locator('.cue-url')
  await expect(pill).toHaveCount(1)
  await expect(pill).toHaveText(LONG_URL)
  await expect(pill).not.toHaveClass(/cue-active/)
  const collapsedBox = (await pill.boundingBox())!
  const editorBox = (await editor.boundingBox())!
  expect(collapsedBox.width).toBeLessThan(editorBox.width * 0.5)

  // (2) Click INTO the pill → caret inside → expands in place.
  await pill.click()
  await expect(pill).toHaveClass(/cue-active/)
  const expandedBox = (await pill.boundingBox())!
  expect(expandedBox.width).toBeGreaterThan(collapsedBox.width * 2)

  // (3) Move the caret OUT (click the first line) → re-collapses.
  await editor.click({ position: { x: 4, y: 4 } })
  await expect(pill).not.toHaveClass(/cue-active/)

  // (4) Everything is still editable: append to the prose, autosave persists
  // the FULL note (URL never truncated in the data).
  await editor.click({ position: { x: 4, y: 4 } })
  await page.keyboard.press('End')
  await page.keyboard.type(' now')
  await expect(bar.locator('.session-notes-status-saved')).toBeVisible({ timeout: 5000 })
  expect(await editorText(editor)).toBe(`check deployment now\n${LONG_URL}\ndone`)

  // (5) PASTE a second URL → collapses immediately (the headline use case).
  await page.keyboard.press('Control+End')
  await page.keyboard.press('Enter')
  await editor.evaluate((el, url) => {
    const dt = new DataTransfer()
    dt.setData('text/plain', url)
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  }, 'https://deploy.example.com/pipelines/OtherService/change_history_v2?changes=deadbeef')
  await expect(editor.locator('.cue-url')).toHaveCount(2)
  const secondPill = editor.locator('.cue-url').nth(1)
  await expect(secondPill).not.toHaveClass(/cue-active/)

  await page.request.patch('/api/sessions/pw-normal-session', { data: { human_note: '' } })
})

test('a link-free note renders no anchors at all', async ({ page }) => {
  await page.request.patch('/api/sessions/pw-normal-session', { data: { human_note: 'remember: confirm before deploy' } })

  const panel = await openSeededSessionOnHome(page)
  const bar = panel.locator('.session-notes')
  await expect(bar).toBeVisible({ timeout: 5000 })
  await expect(bar.locator('.session-notes-preview')).toHaveText('remember: confirm before deploy')
  await expect(bar.locator('.session-notes-preview a')).toHaveCount(0)
  await expect(bar.locator('.session-notes-link')).toHaveCount(0)

  await page.request.patch('/api/sessions/pw-normal-session', { data: { human_note: '' } })
})
