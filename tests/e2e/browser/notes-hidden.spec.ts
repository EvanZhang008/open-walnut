/**
 * A hidden note on the Notes page (docs/reference/locked-notes.md, "Hidden notes"), as the person
 * uses it: Hide from AI in a plain note's Lock menu, the note covered with its eye-off mark in the
 * tree, Show with no password, write (the file keeps its mark), leave and come back, reload (covered
 * again each time), and Unhide. While it is shown nothing hands it to a model: the chat is not told
 * which note is open, there is no dictation, and the tree offers no agent on it. Then hidden ->
 * Encrypt -> Remove lock gives the hidden note back. Fake text only. The Lock control is the
 * `locked_notes` experiment's; a hidden note opens covered whatever it says.
 *
 * HIDDEN_SHOTS=<dir> saves the screenshots shown to the user (1280x800).
 */
import { test, expect, type Page } from '@playwright/test'
import path from 'node:path'
import { vaultSession } from './vault-session-helper'

const API = 'http://localhost:3457'
const SECRET = 'wombatlantern'
const TEXT = `# Diary\n\nMonday: ${SECRET} is what I wrote.\n\nTuesday: rain all day.\n`
const MARK = 'walnut_hidden: 1'
const SHOTS = process.env.HIDDEN_SHOTS

let note = ''
let other = ''
async function seed(tag: string) {
  note = `HiddenTest/Diary ${tag}.md`
  other = `HiddenTest/Plain ${tag}.md`
  for (const [p, content] of [[note, TEXT], [other, '# Plain\n\nAn ordinary note.\n']]) {
    const r = await fetch(`${API}/api/notes-v2/content/${p}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content }) })
    expect(r.ok).toBe(true)
  }
}
const stamp = (info: { repeatEachIndex: number }) => `${info.repeatEachIndex}-${Date.now() % 100000}`
/** What the file holds (this fixture server answers its own test calls as the person, so the whole text). */
const onDisk = async (p = note) => (await (await fetch(`${API}/api/notes-v2/content/${p}`)).json()) as { content: string; hidden?: boolean; locked?: boolean }
const nameOf = (p: string) => p.slice('HiddenTest/'.length, -'.md'.length)
async function hideByApi(p: string) {
  const r = await fetch(`${API}/api/v1/notes/hide`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: p }) })
  expect(r.ok, await r.text()).toBe(true)
}

async function boot(page: Page) {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/notes')
  await page.waitForLoadState('networkidle')
}
const editorOf = (page: Page) => page.locator('.notes-editor-pane .notes-editor .tiptap').first()
const cover = (page: Page) => page.getByTestId('hidden-note-cover')

async function openNote(page: Page, p: string) {
  const folder = page.locator('.notes-tree-folder', { hasText: 'HiddenTest' })
  await folder.waitFor({ state: 'visible', timeout: 60_000 })
  const file = page.locator('.notes-tree-file', { hasText: nameOf(p) }).first()
  if (!(await file.isVisible().catch(() => false))) await folder.click()
  await file.click()
}
async function lockMenu(page: Page, row: 'Hide from AI' | 'Encrypt' | 'Unhide', expectRows?: string[]) {
  await page.getByTestId('note-lock').click()
  const menu = page.getByTestId('note-protect-menu')
  await expect(menu).toBeVisible()
  if (expectRows) await expect(menu.getByRole('menuitem')).toHaveText(expectRows)
  await menu.getByRole('menuitem', { name: row }).click()
}
async function typeAtEnd(page: Page, line: string, words: string) {
  await editorOf(page).locator('p', { hasText: line }).click()
  await page.keyboard.press('End')
  await page.keyboard.type(words)
}
async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) })
}
/** The tree's right-click menu on a note: its rows' words. */
async function treeMenuRows(page: Page, p: string): Promise<string[]> {
  await page.locator('.notes-tree-file', { hasText: nameOf(p) }).first().click({ button: 'right' })
  const menu = page.locator('.notes-context-menu')
  await expect(menu).toBeVisible()
  const rows = (await menu.locator('button').allInnerTexts()).map((t) => t.trim())
  // The tree's menu closes on the next click anywhere (NotesTreePanel), not on Escape.
  await page.evaluate(() => window.dispatchEvent(new MouseEvent('click')))
  await expect(menu).toHaveCount(0)
  return rows
}

test.setTimeout(180_000)
test.beforeAll(async ({ request }) => {
  const r = await request.put(`${API}/api/config`, { data: { experimental: { locked_notes: true } } })
  expect(r.ok(), await r.text()).toBe(true)
})

test('hide a note from AI: covered until Show, no password, saves keep the mark, covered again after a switch or a reload, Unhide', async ({ page }, info) => {
  await seed(stamp(info))
  // Every chat send this window makes, to check the open note is never named to the agent.
  const sent: string[] = []
  page.on('websocket', (ws) => ws.on('framesent', (f) => { if (typeof f.payload === 'string') sent.push(f.payload) }))
  await boot(page)

  // A plain note: the Lock control offers the two choices; dictation is on for a plain note.
  await openNote(page, note)
  await expect(editorOf(page)).toContainText(SECRET)
  await expect(page.locator('.notes-editor-pane .editor-mic-dock')).toHaveCount(1)
  await page.getByTestId('note-lock').click()
  await expect(page.getByTestId('note-protect-menu').getByRole('menuitem')).toHaveText(['Hide from AI', 'Encrypt'])
  await shot(page, 'lock-menu-plain')
  await page.keyboard.press('Escape')
  await lockMenu(page, 'Hide from AI')

  // Covered at once: the name, the one line, Show; the text is not in the page; an eye-off in the tree.
  await expect(cover(page)).toBeVisible({ timeout: 15_000 })
  await expect(cover(page)).toContainText(nameOf(note))
  await expect(cover(page)).toContainText('Hidden from AI. Agents cannot read it, and its text is stored unencrypted.')
  await expect(page.locator('body')).not.toContainText(SECRET)
  const row = page.locator('.notes-tree-file', { hasText: nameOf(note) }).first()
  await expect(row.getByTestId('tree-note-hidden')).toBeVisible({ timeout: 15_000 })
  await expect(row.getByTestId('tree-note-locked')).toHaveCount(0)
  await shot(page, 'hidden-covered')
  let disk = await onDisk()
  expect(disk.hidden).toBe(true)
  expect(disk.content).toContain(MARK)
  expect(disk.content).toContain(SECRET) // plain on disk: hidden, not encrypted

  // Show: no password, no sheet; the ordinary editor, its Hide, no dictation.
  await page.getByTestId('hidden-note-show').click()
  await expect(editorOf(page)).toContainText(SECRET, { timeout: 15_000 })
  await expect(page.getByTestId('pw-unlock-sheet')).toHaveCount(0)
  await expect(page.getByTestId('hidden-note-hide')).toBeVisible()
  await expect(page.locator('.notes-editor-pane .editor-mic-dock')).toHaveCount(0)
  await shot(page, 'hidden-shown')

  // Write: saved through the ordinary save, the file keeps its mark.
  await typeAtEnd(page, 'Tuesday', ' Then soup.')
  await expect(page.locator('.notes-save-status.saved')).toHaveCount(1, { timeout: 15_000 })
  await expect.poll(async () => (await onDisk()).content, { timeout: 15_000 }).toContain('Then soup.')
  disk = await onDisk()
  expect(disk.content).toContain(MARK)
  expect(disk.hidden).toBe(true)

  // While shown, the chat is never told which note is open, and the tree offers no agent on it.
  await page.locator('.notes-ai-toggle').click()
  const input = page.locator('.notes-chat .chat-input-textarea')
  await expect(input).toBeVisible({ timeout: 15_000 })
  await input.fill('What is on my mind today?')
  await input.press('Enter')
  await expect.poll(() => sent.filter((f) => f.includes('What is on my mind today?')).length, { timeout: 15_000 }).toBeGreaterThan(0)
  for (const f of sent.filter((x) => x.includes('What is on my mind today?'))) {
    expect(f).not.toContain('currently viewing the note')
    expect(f).not.toContain(nameOf(note))
  }
  await page.locator('.notes-ai-toggle').click()
  const hiddenRows = await treeMenuRows(page, note)
  expect(hiddenRows).not.toContain('New Note Agent chat')
  expect(hiddenRows).not.toContain('Start Claude Code session')
  expect(await treeMenuRows(page, other)).toContain('New Note Agent chat')

  // Hide covers it; another note and back covers it; a reload covers it.
  await page.getByTestId('hidden-note-hide').click()
  await expect(cover(page)).toBeVisible()
  await expect(page.locator('body')).not.toContainText(SECRET)
  await page.getByTestId('hidden-note-show').click()
  await expect(editorOf(page)).toContainText('Then soup.')
  await openNote(page, other)
  await expect(editorOf(page)).toContainText('An ordinary note.')
  await openNote(page, note)
  await expect(cover(page)).toBeVisible()
  await expect(page.locator('body')).not.toContainText(SECRET)
  await page.getByTestId('hidden-note-show').click()
  await expect(editorOf(page)).toContainText('Then soup.')
  await page.reload()
  await page.waitForLoadState('networkidle')
  await openNote(page, note)
  await expect(cover(page)).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('body')).not.toContainText(SECRET)

  // Unhide (a confirm): a plain note again, no cover, the mark gone from the file and the tree.
  await page.getByTestId('hidden-note-show').click()
  await expect(editorOf(page)).toContainText('Then soup.')
  await lockMenu(page, 'Unhide', ['Encrypt', 'Unhide'])
  const dialog = page.locator('.app-modal')
  await expect(dialog).toContainText('Unhide this note?')
  await dialog.getByRole('button', { name: 'Unhide', exact: true }).click()
  await expect.poll(async () => (await onDisk()).hidden, { timeout: 15_000 }).toBeUndefined()
  expect((await onDisk()).content).not.toContain(MARK)
  await expect(page.getByTestId('hidden-note-hide')).toHaveCount(0, { timeout: 15_000 })
  await expect(editorOf(page)).toContainText('Then soup.')
  await expect(page.locator('.notes-tree-file', { hasText: nameOf(note) }).first().getByTestId('tree-note-hidden')).toHaveCount(0, { timeout: 15_000 })
  await openNote(page, other)
  await openNote(page, note)
  await expect(cover(page)).toHaveCount(0)
  await expect(editorOf(page)).toContainText(SECRET)
})

test('hidden, then Encrypt, then Remove lock gives the hidden note back', async ({ page, context, request }, info) => {
  await seed(`enc-${stamp(info)}`)
  await hideByApi(note)
  await hideByApi(other)
  const token = await vaultSession(request, API)
  await context.addInitScript((t) => { try { localStorage.setItem('walnut.vault.session', t) } catch { /* no storage here */ } }, token)
  await boot(page)

  // Opens covered; Show; Encrypt from the Lock control (its confirm, this window already unlocked).
  await openNote(page, note)
  await expect(cover(page)).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('hidden-note-show').click()
  await expect(editorOf(page)).toContainText(SECRET, { timeout: 15_000 })
  await lockMenu(page, 'Encrypt', ['Encrypt', 'Unhide'])
  const dialog = page.locator('.app-modal')
  await expect(dialog).toContainText('Lock this note?')
  await dialog.getByRole('button', { name: 'Lock', exact: true }).click()

  // Locked: the locked pane, the lock in the tree (the other note keeps its eye-off), no text on disk.
  await expect(page.getByTestId('locked-note-hidden')).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('body')).not.toContainText(SECRET)
  await expect(page.locator('.notes-tree-file', { hasText: nameOf(note) }).first().getByTestId('tree-note-locked')).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.notes-tree-file', { hasText: nameOf(other) }).first().getByTestId('tree-note-hidden')).toBeVisible()
  await shot(page, 'tree-both-marks')
  let disk = await onDisk()
  expect(disk.locked).toBe(true)
  expect(disk.content).not.toContain(SECRET)

  // Remove lock: the text comes back hidden, so the note is covered again, with its eye-off.
  await page.getByTestId('locked-note-show').click()
  await expect(editorOf(page)).toContainText(SECRET, { timeout: 15_000 })
  await page.getByTestId('locked-note-remove-lock').click()
  await expect(dialog).toContainText('It stays hidden from AI')
  await dialog.getByRole('button', { name: 'Remove lock', exact: true }).click()
  await expect(cover(page)).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('body')).not.toContainText(SECRET)
  await expect(page.locator('.notes-tree-file', { hasText: nameOf(note) }).first().getByTestId('tree-note-hidden')).toBeVisible({ timeout: 15_000 })
  disk = await onDisk()
  expect(disk.locked).toBeUndefined()
  expect(disk.hidden).toBe(true)
  expect(disk.content).toContain(SECRET)
  expect(disk.content).toContain(MARK)
})

test('with the experiment off: no Lock control, and a hidden note still opens covered', async ({ page }, info) => {
  await seed(`off-${stamp(info)}`)
  await hideByApi(note)
  await page.route((url) => url.pathname === '/api/config', async (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    const response = await route.fetch()
    const body = await response.json() as { config?: { experimental?: Record<string, boolean> } }
    body.config = { ...body.config, experimental: { ...(body.config?.experimental ?? {}), locked_notes: false } }
    await route.fulfill({ response, json: body })
  })
  await boot(page)
  await openNote(page, note)
  await expect(cover(page)).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('body')).not.toContainText(SECRET)
  await page.getByTestId('hidden-note-show').click()
  await expect(editorOf(page)).toContainText(SECRET, { timeout: 15_000 })
  await expect(page.getByTestId('hidden-note-hide')).toBeVisible()
  await expect(page.getByTestId('note-lock')).toHaveCount(0)
})
