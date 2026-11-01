/**
 * A picked reference is drawn as a pill IN the composer (ChatInput + ComposerRefLayer),
 * not as raw `@[Title]` text (2026-11-01, the user: "the input bar should render it
 * directly, not just text ... notes and the rest the same").
 *
 *   pick a note, a task, a file  → each is a pill of its kind in the box
 *   the text is unchanged        → the textarea still holds `@[...]` and sends the tag
 *   it lines up                  → the drawn text wraps exactly like the textarea's
 *   it is one unit               → Backspace removes it, ← steps over it, a click in it
 *                                  lands at its edge
 *   every composer               → the draft column and the session column alike
 *
 * Real pipeline: the fixture server, its notes folder and tasks, a Start that reaches
 * the mock CLI. Nothing is route-mocked.
 */
import { test, expect, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import { discoverFixtureRoot, draftComposer, loadHome, openDraftOnCwd, REAL_PANEL } from './draft-helpers'
import { openKebabGroup } from './kebab-group-helpers'

const PALETTE = '.draft-session-panel .mention-palette'

async function shots(): Promise<string> {
  const dir = `${process.env.WALNUT_TASK_DIR ?? '/tmp'}/shots/composer-ref-pills/${test.info().project.name}`
  await fs.mkdir(dir, { recursive: true })
  return dir
}

/** The layer's text box against the textarea's: same place, same wrapping. */
async function expectAligned(input: Locator): Promise<{ taH: number; lineH: number }> {
  const m = await input.evaluate((ta: HTMLTextAreaElement) => {
    const layer = ta.parentElement!.querySelector<HTMLElement>('.chat-input-ref-layer')!
    const text = layer.firstElementChild as HTMLElement
    const a = ta.getBoundingClientRect()
    const b = layer.getBoundingClientRect()
    // The textarea's own content height: its min-height and set height would hide a
    // line the layer wraps differently.
    const prev = [ta.style.minHeight, ta.style.height]
    ta.style.minHeight = '0'
    ta.style.height = '0'
    const taH = ta.scrollHeight
    ;[ta.style.minHeight, ta.style.height] = prev
    const pad = parseFloat(getComputedStyle(layer).paddingTop) + parseFloat(getComputedStyle(layer).paddingBottom)
    return { dx: Math.abs(a.left - b.left), dy: Math.abs(a.top - b.top), taH, layerH: text.getBoundingClientRect().height + pad, lineH: parseFloat(getComputedStyle(ta).lineHeight) }
  })
  expect(m.dx).toBeLessThan(1)
  expect(m.dy).toBeLessThan(1)
  expect(Math.abs(m.taH - m.layerH), `textarea ${m.taH}px vs layer ${m.layerH}px`).toBeLessThan(2)
  return m
}

const pills = (scope: Page | Locator) => scope.locator('[data-testid="composer-ref-layer"] [data-testid="composer-ref-pill"]')

test('picked note, task and file are pills in the draft composer, one unit each, and the send carries them', async ({ page }) => {
  test.setTimeout(240_000)
  const dir = await shots()
  const fixtureRoot = await discoverFixtureRoot()
  await loadHome(page)
  await openDraftOnCwd(page, `${fixtureRoot}/projects/walnut`)
  const input = draftComposer(page)
  const draft = page.locator('.draft-session-panel').first()
  await input.click()

  // Plain typing draws no layer at all.
  await page.keyboard.type('compare ')
  await expect(pills(draft)).toHaveCount(0)
  await expect(input).not.toHaveClass(/has-ref-pills/)

  // A note from All.
  await page.keyboard.type('@vault')
  const noteRow = page.locator(`${PALETTE} [data-group="src:notes"] .mention-row-source`).filter({ hasText: 'Vault note' })
  await expect(noteRow).toBeVisible({ timeout: 15_000 })
  await noteRow.dispatchEvent('mousedown')
  await expect(input).toHaveValue('compare @[Notes · Vault note] ')
  await expect(input).toHaveClass(/has-ref-pills/)
  await expect(pills(draft)).toHaveCount(1)
  await expect(pills(draft).first()).toHaveAttribute('data-kind', 'source')
  await expect(pills(draft).first()).toHaveAttribute('data-source', 'notes')
  // The textarea's own letters are not painted; the layer's are.
  expect(await input.evaluate((el) => getComputedStyle(el).webkitTextFillColor || getComputedStyle(el).color)).toMatch(/rgba\(0, 0, 0, 0\)|transparent/)

  // A task from the Tasks tab.
  await page.keyboard.type('with @')
  await expect(page.locator(PALETTE)).toBeVisible({ timeout: 10_000 })
  await page.keyboard.press('Tab')
  const taskRow = page.locator(`${PALETTE} .mention-row-task`).first()
  await expect(taskRow).toBeVisible({ timeout: 15_000 })
  const taskTitle = (await taskRow.locator('.mention-title').textContent())!.trim()
  await taskRow.dispatchEvent('mousedown')
  await expect(pills(draft)).toHaveCount(2)
  await expect(pills(draft).nth(1)).toHaveAttribute('data-kind', 'task')
  await expect(pills(draft).nth(1).locator('.composer-ref-pill-label')).toHaveText(taskTitle)

  // A file reference from the Files group: the "@" query stays text while it is typed.
  await page.keyboard.type('and @')
  await expect(page.locator(PALETTE)).toBeVisible({ timeout: 10_000 })
  await expect(pills(draft)).toHaveCount(2)
  // The fixture's folder holds one folder: its "Select" references the folder itself.
  const fileRow = page.locator(`${PALETTE} [data-group="files"] .mention-row`).first()
  await expect(fileRow).toBeVisible({ timeout: 15_000 })
  const fileName = (await fileRow.locator('.mention-title').textContent())!.trim()
  await fileRow.locator('.mention-pick-btn').dispatchEvent('mousedown')
  await expect(pills(draft)).toHaveCount(3)
  await expect(pills(draft).nth(2)).toHaveAttribute('data-kind', 'file')
  await expect(pills(draft).nth(2).locator('.composer-ref-pill-label')).toHaveText(fileName)
  await expect(page.locator(PALETTE)).toHaveCount(0)

  // Long prose that wraps over several lines still lines up with the textarea.
  await page.keyboard.type('please read all three of these closely before you start and tell me what differs between them, line by line, and then list every place where the newer one dropped a step the older one still had')
  const aligned = await expectAligned(input)
  expect(aligned.taH / aligned.lineH, 'the check needs text that wraps').toBeGreaterThan(3)
  await draft.locator('.chat-input-box').screenshot({ path: `${dir}/01-three-pills.png` })

  // One unit: ← from right after the file pill lands before it; Backspace from its end removes it whole.
  const value = await input.inputValue()
  const fileStart = value.indexOf(`@${fixtureRoot}`)
  const fileEnd = value.indexOf(' ', fileStart)
  await input.evaluate((el: HTMLTextAreaElement, at) => el.setSelectionRange(at, at), fileEnd)
  await page.keyboard.press('ArrowLeft')
  expect(await input.evaluate((el: HTMLTextAreaElement) => el.selectionStart)).toBe(fileStart)
  await input.evaluate((el: HTMLTextAreaElement, at) => el.setSelectionRange(at, at), fileEnd)
  await page.keyboard.press('Backspace')
  await expect(pills(draft)).toHaveCount(2)
  expect(await input.inputValue()).not.toContain(fixtureRoot)
  // The removal is the browser's own edit: undo brings the reference back whole.
  await page.keyboard.press('ControlOrMeta+z')
  await expect(pills(draft)).toHaveCount(3)
  expect(await input.inputValue()).toBe(value)
  await input.evaluate((el: HTMLTextAreaElement, at) => el.setSelectionRange(at, at), fileEnd)
  await page.keyboard.press('Backspace')
  await expect(pills(draft)).toHaveCount(2)

  // A click into the task pill's words puts the caret at its nearer edge.
  const taskPill = pills(draft).nth(1)
  const box = (await taskPill.locator('.composer-ref-pill-label').boundingBox())!
  await page.mouse.click(box.x + 6, box.y + box.height / 2)
  const v = await input.inputValue()
  const tStart = v.indexOf('@[', v.indexOf('with'))
  await expect.poll(() => input.evaluate((el: HTMLTextAreaElement) => el.selectionStart)).toBe(tStart)
  // A caret moved there any other way (an arrow up or down, Home, End) is moved out the same way.
  await input.evaluate((el: HTMLTextAreaElement, at) => el.setSelectionRange(at, at), tStart + 5)
  await expect.poll(() => input.evaluate((el: HTMLTextAreaElement) => el.selectionStart)).not.toBe(tStart + 5)

  // Option/Ctrl+Backspace (delete a word) right after the note pill removes all of it too.
  const noteEnd = v.indexOf(']') + 1
  await input.evaluate((el: HTMLTextAreaElement, at) => el.setSelectionRange(at, at), noteEnd)
  await page.keyboard.press('Alt+Backspace')
  await expect(pills(draft)).toHaveCount(1)
  expect(await input.inputValue()).not.toContain('Vault note')

  // Send: the message goes out with the task's tag; the bubble draws it as the chat's pill.
  await input.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(el.value.length, el.value.length))
  await page.keyboard.type(' echo-input')
  const quickStart = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/sessions/quick-start')
  await page.keyboard.press('Enter')
  const res = await quickStart
  expect(res.status()).toBe(200)
  const { sessionId } = await res.json() as { sessionId: string }
  const panel = page.locator(`${REAL_PANEL}[data-session-id="${sessionId}"]`)
  await expect(panel).toBeVisible({ timeout: 30_000 })
  await expect(panel.locator('.session-msg-user a.task-link').first()).toHaveText(taskTitle, { timeout: 30_000 })

  // The session column's own composer draws pills too.
  const composer = panel.locator('.chat-input-textarea')
  await composer.click()
  await page.keyboard.type('then @vault')
  const row = panel.locator('.mention-palette [data-group="src:notes"] .mention-row-source').filter({ hasText: 'Vault note' })
  await expect(row).toBeVisible({ timeout: 15_000 })
  await row.dispatchEvent('mousedown')
  await expect(pills(panel)).toHaveCount(1)
  await expect(composer).toHaveValue('then @[Notes · Vault note] ')
  await expectAligned(composer)
  await panel.locator('.chat-input-box').screenshot({ path: `${dir}/02-session-column.png` })

  // A path typed by hand (palette closed with Esc) stays text the user edits letter by letter.
  await page.keyboard.type('@/etc/hosts')
  await page.keyboard.press('Escape')
  await expect(pills(panel)).toHaveCount(1)
  await page.keyboard.press('Backspace')
  await expect(composer).toHaveValue('then @[Notes · Vault note] @/etc/host')

  // Past its max height the textarea scrolls; the layer follows it line for line.
  for (let i = 0; i < 8; i++) { await page.keyboard.press('Shift+Enter'); await page.keyboard.type(`line ${i + 1} of the notes`) }
  const scroll = await composer.evaluate((ta: HTMLTextAreaElement) => {
    ta.scrollTop = ta.scrollHeight
    ta.dispatchEvent(new Event('scroll'))
    const text = ta.parentElement!.querySelector<HTMLElement>('.chat-input-ref-layer-text')!
    return { top: ta.scrollTop, ty: new DOMMatrix(getComputedStyle(text).transform).m42 }
  })
  expect(scroll.top).toBeGreaterThan(0)
  expect(Math.abs(scroll.ty + scroll.top)).toBeLessThan(1)
  await expectAligned(composer)
  await panel.locator('.chat-input-box').screenshot({ path: `${dir}/03-scrolled.png` })

  // What the model got still names the task (Raw input).
  await composer.fill('')
  await panel.locator('.session-panel-header .task-kebab-btn').click()
  const debug = await openKebabGroup(page.locator('.task-kebab-menu'), 'session-kebab-debug')
  await debug.getByTestId('session-kebab-raw-view').click()
  const raw = page.getByTestId('session-raw-view')
  await expect(raw).toContainText(`"${taskTitle}"`, { timeout: 60_000 })
  await page.keyboard.press('Escape')
})
