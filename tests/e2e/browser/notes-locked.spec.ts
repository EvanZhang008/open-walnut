/**
 * A locked note on the Notes page (docs/reference/locked-notes.md), as the person uses it: lock a
 * plain note from its header (the master password asked in the unlock sheet), see the lock in the
 * tree and the hidden pane, press Show, write, Hide, leave and come back (hidden again), and remove
 * the lock. The file on disk holds only the stub and the ciphertext at every step. Fake text only.
 */
import { test, expect, type Page } from '@playwright/test'
import { VAULT_MASTER, vaultSession } from './vault-session-helper'

const API = 'http://localhost:3457'
const SECRET = 'quokkamarmalade'
const TEXT = `# Week\n\nMonday: ${SECRET} is the word I keep.\n\nTuesday: a walk by the river.\n`

let note = ''
let other = ''
async function seed(tag: string) {
  note = `LockedTest/Week ${tag}.md`
  other = `LockedTest/Other ${tag}.md`
  for (const [p, content] of [[note, TEXT], [other, '# Other\n\nA plain note.\n']]) {
    const r = await fetch(`${API}/api/notes-v2/content/${p}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content }) })
    expect(r.ok).toBe(true)
  }
}
const onDisk = async () => (await (await fetch(`${API}/api/notes-v2/content/${note}`)).json()) as { content: string; locked?: boolean }
const nameOf = (p: string) => p.slice('LockedTest/'.length, -'.md'.length)

async function openNote(page: Page, p: string) {
  const folder = page.locator('.notes-tree-folder', { hasText: 'LockedTest' })
  await folder.waitFor({ state: 'visible', timeout: 60_000 })
  const file = page.locator('.notes-tree-file', { hasText: nameOf(p) }).first()
  if (!(await file.isVisible().catch(() => false))) await folder.click()
  await file.click()
}

async function unlockInSheet(page: Page) {
  const sheet = page.getByTestId('pw-unlock-sheet')
  await expect(sheet).toBeVisible()
  await sheet.getByLabel('Master password').fill(VAULT_MASTER)
  await sheet.getByRole('button', { name: 'Unlock', exact: true }).click()
  await expect(sheet).toHaveCount(0, { timeout: 30_000 })
}

test.setTimeout(180_000)

test('lock a note, show it with the master password, write, hide, and remove the lock', async ({ page, request }, info) => {
  await seed(`${info.repeatEachIndex}-${Date.now() % 100000}`)
  await vaultSession(request, API) // Passwords is set up; this window has no unlock of its own
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/notes')
  await page.waitForLoadState('networkidle')

  // A plain note, then Lock in its header: a confirm, then the unlock sheet asks the master password.
  await openNote(page, note)
  const editor = page.locator('.notes-editor-pane .notes-editor .tiptap').first()
  await expect(editor).toContainText(SECRET)
  await page.getByTestId('note-lock').click()
  const dialog = page.locator('.app-modal')
  await expect(dialog).toContainText('Lock this note?')
  await dialog.getByRole('button', { name: 'Lock', exact: true }).click()
  await unlockInSheet(page)

  // Hidden: the name and Show; no text in the page, a lock in the tree, the stub on disk.
  const hidden = page.getByTestId('locked-note-hidden')
  await expect(hidden).toBeVisible({ timeout: 15_000 })
  await expect(hidden).toContainText(nameOf(note))
  await expect(page.locator('body')).not.toContainText(SECRET)
  await expect(page.locator('.notes-tree-file', { hasText: nameOf(note) }).first().getByTestId('tree-note-locked')).toBeVisible({ timeout: 15_000 })
  let disk = await onDisk()
  expect(disk.locked).toBe(true)
  expect(disk.content).not.toContain(SECRET)

  // Show: this window is unlocked now, so the text opens at once.
  await page.getByTestId('locked-note-show').click()
  const shown = page.locator('.notes-editor-pane .notes-editor .tiptap').first()
  await expect(shown).toContainText(SECRET, { timeout: 15_000 })
  await expect(page.locator('.notes-format-toolbar').getByRole('button', { name: 'Image' })).toHaveCount(0)

  // Write: saved sealed, the file still holds no text.
  await shown.locator('p', { hasText: 'Tuesday' }).click()
  await page.keyboard.press('End')
  await page.keyboard.type(' Then tea.')
  await expect(page.locator('.notes-save-status.saved')).toHaveCount(1, { timeout: 15_000 })
  disk = await onDisk()
  expect(disk.content).not.toContain('Then tea')
  expect(disk.content).not.toContain(SECRET)

  // Hide, and leaving the note hides it too.
  await page.getByTestId('locked-note-hide').click()
  await expect(hidden).toBeVisible()
  await expect(page.locator('body')).not.toContainText(SECRET)
  await page.getByTestId('locked-note-show').click()
  await expect(shown).toContainText('Then tea.')
  await openNote(page, other)
  await expect(page.locator('.notes-editor-pane .notes-editor .tiptap').first()).toContainText('A plain note.')
  await openNote(page, note)
  await expect(hidden).toBeVisible()
  await expect(page.locator('body')).not.toContainText(SECRET)

  // Remove lock: the text goes back into the file as a plain note.
  await page.getByTestId('locked-note-show').click()
  await expect(shown).toContainText('Then tea.')
  await page.getByTestId('locked-note-remove-lock').click()
  await expect(dialog).toContainText('Remove the lock?')
  await dialog.getByRole('button', { name: 'Remove lock', exact: true }).click()
  await expect(page.getByTestId('note-lock')).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.notes-editor-pane .notes-editor .tiptap').first()).toContainText('Then tea.')
  disk = await onDisk()
  expect(disk.locked).toBeUndefined()
  expect(disk.content).toContain(SECRET)
  expect(disk.content).toContain('Then tea.')
})

test('an agent reads a locked note only after the person approves its card with the master password', async ({ page, request }, info) => {
  await seed(`ask-${info.repeatEachIndex}-${Date.now() % 100000}`)
  const token = await vaultSession(request, API)
  const vault = { 'x-walnut-vault-session': token }
  expect((await request.post(`${API}/api/v1/vault/notes/lock`, { data: { path: note }, headers: vault })).ok()).toBe(true)
  const agent = { 'x-walnut-caller-sid': 'pw-locked-note-agent' }
  const ask = await (await request.post(`${API}/api/v1/vault/notes/agent/ask`, { data: { path: note, purpose: 'summarise the week for the plan' }, headers: agent })).json()
  expect(ask.status).toBe('pending')
  const wait = async () => (await request.post(`${API}/api/v1/vault/notes/agent/ask/${ask.requestId}/wait`, { data: { token: ask.waitToken, wait_ms: 0 }, headers: agent })).json()
  expect((await wait()).status).toBe('pending')

  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/')
  const card = page.locator(`[data-testid="approval-card"][data-approval-id="${ask.requestId}"]`)
  await expect(card).toBeVisible({ timeout: 30_000 })
  await expect(card).toContainText(`read your locked note "${nameOf(note)}"`)
  await expect(card).not.toContainText(SECRET)
  // Approve: this window has no Passwords unlock, so the sheet asks for the master password first.
  await card.getByTestId('approval-approve').click()
  await unlockInSheet(page)
  await expect(page.locator(`.approval-card-settled[data-approval-id="${ask.requestId}"]`)).toContainText('Approved', { timeout: 15_000 })
  const got = await wait()
  expect(got.status).toBe('released')
  expect(got.content).toContain(SECRET)
  // The file itself still holds no text.
  expect((await onDisk()).content).not.toContain(SECRET)
})

test('a quick note switch and a Passwords lock never lose what was typed', async ({ page, request }, info) => {
  await seed(`fast-${info.repeatEachIndex}-${Date.now() % 100000}`)
  const token = await vaultSession(request, API)
  expect((await request.post(`${API}/api/v1/vault/notes/lock`, { data: { path: note }, headers: { 'x-walnut-vault-session': token } })).ok()).toBe(true)
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/notes')
  await page.waitForLoadState('networkidle')
  await openNote(page, note)
  await page.getByTestId('locked-note-show').click()
  await unlockInSheet(page)
  const shown = page.locator('.notes-editor-pane .notes-editor .tiptap').first()
  await expect(shown).toContainText(SECRET)

  // Typed, then straight to another note, inside the save delay.
  await shown.locator('p', { hasText: 'Tuesday' }).click()
  await page.keyboard.press('End')
  await page.keyboard.type(' Fast words.')
  await openNote(page, other)
  await expect(page.locator('.notes-editor-pane .notes-editor .tiptap').first()).toContainText('A plain note.')
  await openNote(page, note)
  await page.getByTestId('locked-note-show').click()
  await expect(shown).toContainText('Fast words.', { timeout: 15_000 })

  // Typed, then this window's Passwords unlock ends elsewhere (a Lock from another window): the text
  // hides at once and the words are kept. Only this window's unlock: other specs share the vault.
  await shown.locator('p', { hasText: 'Tuesday' }).click()
  await page.keyboard.press('End')
  await page.keyboard.type(' Before lock.')
  const windowToken = await page.evaluate(() => localStorage.getItem('walnut.vault.session'))
  expect(windowToken).toBeTruthy()
  await request.post(`${API}/api/v1/vault/lock`, { data: {}, headers: { 'x-walnut-vault-session': windowToken! } })
  await expect(page.getByTestId('locked-note-hidden')).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('body')).not.toContainText(SECRET)
  // The kept edit saves once Passwords is unlocked again (the sheet asks for the master password,
  // unless this computer shares an unlock), and Show puts it all back.
  const sheet = page.getByTestId('pw-unlock-sheet')
  for (let i = 0; i < 3; i++) {
    if (await sheet.isVisible().catch(() => false)) await unlockInSheet(page)
    if (await shown.isVisible().catch(() => false)) break
    await page.getByTestId('locked-note-show').click()
    await sheet.or(shown).first().waitFor({ timeout: 15_000 })
  }
  await expect(shown).toContainText('Before lock.', { timeout: 15_000 })
  await expect(shown).toContainText('Fast words.')
  expect((await onDisk()).content).not.toContain('Before lock.')
})
