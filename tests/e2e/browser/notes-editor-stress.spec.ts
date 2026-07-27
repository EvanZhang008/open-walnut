/**
 * Stress tests for the Notes Editor.
 *
 * Exercises the Tiptap editor with adversarial inputs to catch:
 * - Re-render cascade lag (rapid typing)
 * - Serialization perf (paste bomb)
 * - Tab indent logic corruption (tab storm)
 * - Cursor position bugs (concurrent sync, undo/redo)
 * - DOMPurify race conditions (toggle storm)
 * - XSS and rendering corruption (special chars)
 * - Save race conditions (focus/blur cycle)
 */
import { test, expect, type Page } from '@playwright/test'
import { selectSection } from './todo-panel-helpers'

const API = 'http://localhost:3457'

// ── Helpers ──

/** Navigate to the home page and ensure notes section is expanded */
async function openNotesEditor(page: Page) {
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  // The todo panel's section tabs mean Notes isn't mounted unless it's the active
  // section (the panel defaults to Focus). Pick the Notes tab — in that view Notes
  // owns the whole panel and is always expanded, so no chevron click is needed.
  await selectSection(page, 'Notes')

  const header = page.locator('.global-notes-header')
  await expect(header).toBeVisible({ timeout: 5000 })
  const body = page.locator('.global-notes-body')
  await expect(body).toBeVisible({ timeout: 5000 })

  // Wait for tiptap editor to be ready
  const editor = page.locator('.notes-editor .tiptap')
  await expect(editor).toBeVisible({ timeout: 5000 })
  return editor
}

/** Clear notes via API to start each test fresh */
async function clearNotes() {
  await fetch(`${API}/api/notes/global`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: '' }),
  })
}

/** Get notes content via API */
async function getNotesViaApi(): Promise<string> {
  const res = await fetch(`${API}/api/notes/global`)
  const body = (await res.json()) as { content: string }
  return body.content
}

/** Save notes content via API */
async function setNotesViaApi(content: string) {
  await fetch(`${API}/api/notes/global`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  })
}

/** Collect console errors during a test */
function trackConsoleErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(msg.text())
  })
  return errors
}

// ── Tests ──

test.beforeEach(async () => {
  await clearNotes()
})

test.describe('Notes Editor Stress Tests', () => {

  test('rapid typing — 200 chars at 20ms intervals', async ({ page }) => {
    const errors = trackConsoleErrors(page)
    const editor = await openNotesEditor(page)

    // Focus editor
    await editor.click()

    // Type 200 characters rapidly
    const chars = 'abcdefghij'.repeat(20) // 200 chars
    const start = Date.now()
    await page.keyboard.type(chars, { delay: 20 })
    const elapsed = Date.now() - start

    // Should complete in reasonable time (200 chars * 20ms = 4s + overhead)
    expect(elapsed).toBeLessThan(15_000)

    // Wait for debounced save to complete
    await page.waitForTimeout(1000)

    // Verify content persisted
    const saved = await getNotesViaApi()
    expect(saved).toContain('abcdefghij')
    // All 200 chars should be in the saved content
    expect(saved.replace(/\s/g, '').length).toBeGreaterThanOrEqual(200)

    // No console errors
    expect(errors.filter(e => !e.includes('favicon'))).toHaveLength(0)
  })

  test('paste bomb — 50KB markdown blob', async ({ page }) => {
    const errors = trackConsoleErrors(page)
    const editor = await openNotesEditor(page)
    await editor.click()

    // Generate a ~50KB markdown blob
    const line = '- Item with **bold** and `code` and [link](https://example.com)\n'
    const blob = line.repeat(Math.ceil(50_000 / line.length))

    // Paste via clipboard API
    await page.evaluate((text) => {
      const dt = new DataTransfer()
      dt.setData('text/plain', text)
      const event = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true })
      document.querySelector('.notes-editor .tiptap')?.dispatchEvent(event)
    }, blob)

    // Wait for editor to process
    await page.waitForTimeout(2000)

    // Editor should still be functional — type after paste
    await page.keyboard.type('AFTER_PASTE')
    await page.waitForTimeout(1000)

    // Verify editor didn't crash
    const editorVisible = await editor.isVisible()
    expect(editorVisible).toBe(true)

    expect(errors.filter(e => !e.includes('favicon'))).toHaveLength(0)
  })

  test('tab storm — nested list Tab/Shift-Tab 20x rapidly', async ({ page }) => {
    const errors = trackConsoleErrors(page)
    const editor = await openNotesEditor(page)
    await editor.click()

    // Create a task list with multiple items
    await page.keyboard.type('- [ ] First item')
    await page.keyboard.press('Enter')
    await page.keyboard.type('Second item')
    await page.keyboard.press('Enter')
    await page.keyboard.type('Third item')
    await page.keyboard.press('Enter')
    await page.keyboard.type('Fourth item')

    // Move cursor back to second item
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('ArrowUp')

    // Tab storm: indent/unindent rapidly 20 times
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press('Tab')
      await page.keyboard.press('Shift+Tab')
    }

    // Editor should still be functional
    await page.keyboard.type(' SURVIVED')
    await page.waitForTimeout(1000)

    const editorVisible = await editor.isVisible()
    expect(editorVisible).toBe(true)

    expect(errors.filter(e => !e.includes('favicon'))).toHaveLength(0)
  })

  test('tab on first item in split list — no crash, content preserved', async ({ page }) => {
    const errors = trackConsoleErrors(page)
    const editor = await openNotesEditor(page)
    await editor.click()

    // Create two task items with a blank line between (user types Enter twice)
    await page.keyboard.type('- [ ] Item above')
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter') // exits the list → blank line
    await page.keyboard.type('- [ ] Should indent')
    await page.waitForTimeout(300)

    // Click on "Should indent" and press Tab
    const target = editor.locator('li', { hasText: 'Should indent' })
    if (await target.isVisible()) {
      await target.click()
      await page.keyboard.press('Tab')
      await page.waitForTimeout(500)
    }

    // Editor must not crash — content must still be present
    await page.keyboard.type(' survived')
    const text = await editor.innerText()
    expect(text).toContain('Item above')
    expect(text).toContain('indent') // "Should indent" or "Should indent survived"

    const editorVisible = await editor.isVisible()
    expect(editorVisible).toBe(true)

    expect(errors.filter(e => !e.includes('favicon'))).toHaveLength(0)
  })

  test('concurrent sync — type while external content arrives', async ({ page }) => {
    const errors = trackConsoleErrors(page)
    const editor = await openNotesEditor(page)
    await editor.click()

    // Type some initial content
    await page.keyboard.type('User is typing here...')

    // While typing, update notes via API (simulating external sync)
    await setNotesViaApi('# External Update\n\nThis came from another source.')

    // Keep typing
    await page.keyboard.type(' more typing after sync')
    await page.waitForTimeout(1000)

    // Editor should not crash — content may vary depending on timing
    const editorVisible = await editor.isVisible()
    expect(editorVisible).toBe(true)

    // A 409 here is the DESIGNED outcome, not a defect: this test deliberately
    // races a user edit against an external write, and `useGlobalNotes` resolves
    // that by letting the external write win and reloading (see its 409 branch).
    // Asserting zero errors contradicted the very behavior being exercised — only
    // genuinely unexpected errors should fail this.
    const unexpected = errors
      .filter(e => !e.includes('favicon'))
      .filter(e => !/\b409\b|modified externally/i.test(e))
    expect(unexpected).toHaveLength(0)
  })

  test('toggle storm — click 10 checkboxes rapidly', async ({ page }) => {
    const errors = trackConsoleErrors(page)

    // Seed notes with checkboxes
    await setNotesViaApi(
      '- [ ] Item 1\n- [ ] Item 2\n- [ ] Item 3\n- [ ] Item 4\n- [ ] Item 5\n' +
      '- [ ] Item 6\n- [ ] Item 7\n- [ ] Item 8\n- [ ] Item 9\n- [ ] Item 10\n'
    )

    const editor = await openNotesEditor(page)

    // Wait for checkboxes to render
    const checkboxes = editor.locator('input[type="checkbox"]')
    await expect(checkboxes.first()).toBeVisible({ timeout: 5000 })

    // Click all 10 checkboxes rapidly
    const count = await checkboxes.count()
    for (let i = 0; i < Math.min(count, 10); i++) {
      await checkboxes.nth(i).click({ force: true })
    }

    // Wait for all saves to settle
    await page.waitForTimeout(1500)

    // Editor should not crash
    const editorVisible = await editor.isVisible()
    expect(editorVisible).toBe(true)

    expect(errors.filter(e => !e.includes('favicon'))).toHaveLength(0)
  })

  test('empty → large → empty — fill 10KB, select-all delete, type again', async ({ page }) => {
    const errors = trackConsoleErrors(page)
    const editor = await openNotesEditor(page)
    await editor.click()

    // Fill with ~10KB of content via paste
    const content = 'Lorem ipsum dolor sit amet. '.repeat(400)
    await page.evaluate((text) => {
      const dt = new DataTransfer()
      dt.setData('text/plain', text)
      const event = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true })
      document.querySelector('.notes-editor .tiptap')?.dispatchEvent(event)
    }, content)

    await page.waitForTimeout(1000)

    // Select all and delete
    await page.keyboard.press('Meta+a')
    await page.keyboard.press('Backspace')

    await page.waitForTimeout(500)

    // Type new content — editor should accept input after clear
    await page.keyboard.type('Fresh start after wipe')
    await page.waitForTimeout(1000)

    // Verify editor recovered — check text is present in the editor
    const text = await editor.innerText()
    expect(text).toContain('Fresh start after wipe')

    // Placeholder should NOT be showing since we typed content
    const placeholder = editor.locator('p.is-editor-empty')
    await expect(placeholder).toHaveCount(0)

    expect(errors.filter(e => !e.includes('favicon'))).toHaveLength(0)
  })

  test('special chars — XSS attempts and exotic content', async ({ page }) => {
    const errors = trackConsoleErrors(page)
    const editor = await openNotesEditor(page)
    await editor.click()

    // Type various XSS payloads and exotic content
    const payloads = [
      '<script>alert("xss")</script>',
      '{{template injection}}',
      '```nested `backtick` hell```',
      'emoji bomb: 🎉🔥💀👻🤖✨🌈🎵🎯🏆',
      '<img src=x onerror=alert(1)>',
      'javascript:alert(1)',
      '<a href="javascript:void(0)">click</a>',
    ]

    for (const payload of payloads) {
      await page.keyboard.type(payload)
      await page.keyboard.press('Enter')
    }

    await page.waitForTimeout(1000)

    // Verify no script tags were rendered (XSS protection)
    const scriptTags = await editor.locator('script').count()
    expect(scriptTags).toBe(0)

    // Editor should still be functional
    await page.keyboard.type('Still working after XSS attempts')

    const text = await editor.innerText()
    expect(text).toContain('Still working after XSS attempts')
    expect(text).toContain('emoji bomb')

    expect(errors.filter(e => !e.includes('favicon'))).toHaveLength(0)
  })

  test('undo/redo spam — type, undo 50x, redo 50x', async ({ page }) => {
    const errors = trackConsoleErrors(page)
    const editor = await openNotesEditor(page)
    await editor.click()

    // Type a few words
    await page.keyboard.type('Hello World')
    await page.keyboard.press('Enter')
    await page.keyboard.type('Second line')
    await page.keyboard.press('Enter')
    await page.keyboard.type('Third line')

    // Undo 50 times (more than history has)
    for (let i = 0; i < 50; i++) {
      await page.keyboard.press('Meta+z')
    }

    await page.waitForTimeout(300)

    // Redo 50 times
    for (let i = 0; i < 50; i++) {
      await page.keyboard.press('Meta+Shift+z')
    }

    await page.waitForTimeout(500)

    // Editor should still be functional
    await page.keyboard.type(' Appended after undo/redo')
    await page.waitForTimeout(500)

    const text = await editor.innerText()
    expect(text).toContain('Appended after undo/redo')

    const editorVisible = await editor.isVisible()
    expect(editorVisible).toBe(true)

    expect(errors.filter(e => !e.includes('favicon'))).toHaveLength(0)
  })

  test('focus/blur cycle — click in/out of editor 20x during typing', async ({ page }) => {
    const errors = trackConsoleErrors(page)
    const editor = await openNotesEditor(page)

    // Click on the chat input to blur — NOT the notes header (that toggles collapse)
    const blurTarget = page.locator('.chat-input-textarea')

    for (let i = 0; i < 20; i++) {
      // Focus editor and type
      await editor.click()
      await page.keyboard.type(`${i} `)

      // Click outside editor to blur (page title area — doesn't collapse notes)
      await blurTarget.click()
    }

    // Wait for saves to settle
    await page.waitForTimeout(1500)

    // Editor should still be visible and functional
    const editorVisible = await editor.isVisible()
    expect(editorVisible).toBe(true)

    expect(errors.filter(e => !e.includes('favicon'))).toHaveLength(0)
  })

  test('markdown round-trip — content survives getMarkdown → setContent cycle', async ({ page }) => {
    const errors = trackConsoleErrors(page)

    // Seed complex markdown content
    const md = [
      '# Heading 1',
      '## Heading 2',
      '',
      'Paragraph with **bold**, *italic*, and `code`.',
      '',
      '- Bullet 1',
      '- Bullet 2',
      '  - Nested bullet',
      '',
      '1. Ordered 1',
      '2. Ordered 2',
      '',
      '> Blockquote content',
      '',
      '```javascript',
      'const x = 42;',
      '```',
      '',
      '- [ ] Unchecked task',
      '- [x] Checked task',
      '',
      '---',
      '',
      '[Link text](https://example.com)',
    ].join('\n')

    await setNotesViaApi(md)

    const editor = await openNotesEditor(page)

    // Wait for content to render
    await expect(editor.locator('h1')).toBeVisible({ timeout: 5000 })

    // Verify key elements rendered
    await expect(editor.locator('h1')).toHaveText('Heading 1')
    await expect(editor.locator('h2')).toHaveText('Heading 2')
    await expect(editor.locator('strong')).toContainText('bold')
    await expect(editor.locator('em')).toContainText('italic')
    await expect(editor.locator('code').first()).toBeVisible()
    await expect(editor.locator('blockquote')).toBeVisible()

    // Checkboxes should render
    const checkboxes = editor.locator('input[type="checkbox"]')
    expect(await checkboxes.count()).toBeGreaterThanOrEqual(2)

    expect(errors.filter(e => !e.includes('favicon'))).toHaveLength(0)
  })

  test('long typing session — 1000 chars with periodic pauses', async ({ page }) => {
    const errors = trackConsoleErrors(page)
    const editor = await openNotesEditor(page)
    await editor.click()

    // Simulate realistic typing: bursts of text with pauses
    for (let burst = 0; burst < 10; burst++) {
      const text = `Burst ${burst}: ${('x').repeat(90)}\n`
      await page.keyboard.type(text, { delay: 10 })
      // Pause to let debounced save fire
      await page.waitForTimeout(600)
    }

    // Verify final content was saved
    await page.waitForTimeout(1000)
    const saved = await getNotesViaApi()
    expect(saved).toContain('Burst 9')

    // Cursor should be at the end — verify we can still type
    await page.keyboard.type('THE_END')
    await page.waitForTimeout(1000)

    const finalSaved = await getNotesViaApi()
    expect(finalSaved).toContain('THE_END')

    expect(errors.filter(e => !e.includes('favicon'))).toHaveLength(0)
  })
})
