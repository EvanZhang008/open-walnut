/**
 * A locked note whose key is not in Passwords (a new computer, a vault set up again): Show offers
 * the key's backup in the data folder (docs/reference/locked-notes.md, "Backup of the key"), the
 * person types the master password and Secret Key of the vault that locked it, and the note opens.
 * The fixture server shares one vault with every spec, so the key going missing is the read's
 * answer (410 locked_key_missing) held here until the restore answered; the restore itself is the
 * real route. The master password leaves the page only as its derived key. Fake text only.
 */
import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { VAULT_MASTER, vaultCheckedRequest, vaultSession } from './vault-session-helper'
import { API, boot, editorOf, openNoteIn, putNotes, stamp } from './protected-notes-helper'

const FOLDER = 'KeyRestoreTest'
const SECRET = 'narwhalsnowglobe'
const VAULT = (token: string) => ({ 'x-walnut-vault-session': token })
const KEY_MISSING = { status: 410, contentType: 'application/json', body: JSON.stringify({ error: 'The key this note was locked with is not in Passwords.', code: 'locked_key_missing' }) }

let note = ''
async function lockedNote(request: APIRequestContext, info: { repeatEachIndex: number }): Promise<string> {
  note = `${FOLDER}/Kept ${stamp(info)}.md`
  await putNotes([[note, `# Kept\n\n${SECRET} stays sealed.\n`]])
  const token = await vaultSession(request, API)
  expect((await request.post(`${API}/api/v1/vault/notes/lock`, { data: { path: note }, headers: VAULT(token) })).ok()).toBe(true)
  return token
}
async function openWithUnlock(page: Page, token: string) {
  await page.context().addInitScript((t) => { try { localStorage.setItem('walnut.vault.session', t) } catch { /* no storage here */ } }, token)
  await boot(page)
  await openNoteIn(page, FOLDER, note)
  await page.getByTestId('locked-note-show').click()
}
const card = (page: Page) => page.getByTestId('locked-note-key-restore')

test.setTimeout(180_000)

test('a note whose key is gone opens again after a restore with the master password and Secret Key', async ({ page, request }, info) => {
  const token = await lockedNote(request, info)
  const kit = await vaultCheckedRequest(request, 'post', `${API}/api/v1/vault/secret-key`, { data: { password: VAULT_MASTER }, headers: VAULT(token) })
  expect(kit.ok(), await kit.text()).toBe(true)
  const secretKey = ((await kit.json()) as { secretKey: string }).secretKey

  let keyBack = false
  await page.route('**/api/v1/vault/notes/read', (route) => (keyBack ? route.continue() : route.fulfill(KEY_MISSING)))
  await openWithUnlock(page, token)

  // Show finds no key: the restore card, never the text.
  await expect(card(page)).toBeVisible({ timeout: 15_000 })
  await expect(card(page)).toContainText('Restore the key')
  await expect(card(page)).toContainText(note.slice(FOLDER.length + 1, -3))
  await expect(page.locator('body')).not.toContainText(SECRET)
  const restore = card(page).getByTestId('locked-note-restore')
  await expect(restore).toBeDisabled()

  // A wrong master password: told, the field cleared, the card stays. (Answered here: a real wrong
  // try would slow every spec's unlock on this shared server.)
  await page.route('**/api/v1/vault/notes/restore-key', (route) => route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'Wrong', code: 'wrong_password' }) }), { times: 1 })
  await card(page).getByTestId('locked-note-restore-password').fill('not the master password')
  await card(page).getByTestId('locked-note-restore-secret-key').fill(secretKey)
  await restore.click()
  await expect(card(page).getByTestId('locked-note-restore-error')).toContainText('do not open this backup')
  await expect(card(page).getByTestId('locked-note-restore-password')).toHaveValue('')

  // The right ones: the real restore (the key is back once it answered), then the note opens.
  await page.route('**/api/v1/vault/notes/restore-key', async (route) => {
    const r = await route.fetch()
    keyBack = r.ok()
    await route.fulfill({ response: r })
  })
  await card(page).getByTestId('locked-note-restore-password').fill(VAULT_MASTER)
  const sent = page.waitForRequest((r) => r.url().endsWith('/api/v1/vault/notes/restore-key') && r.method() === 'POST')
  await restore.click()
  const body = (await sent).postDataJSON() as Record<string, unknown>
  expect(typeof body.passwordKey).toBe('string')
  expect(body.password).toBeUndefined()
  expect(JSON.stringify(body)).not.toContain(VAULT_MASTER)
  await expect(editorOf(page)).toContainText(SECRET, { timeout: 15_000 })
  await expect(card(page)).toHaveCount(0)
})

test('with no backup in the data folder, the card says where the key can come back from', async ({ page, request }, info) => {
  const token = await lockedNote(request, info)
  await page.route('**/api/v1/vault/notes/read', (route) => route.fulfill(KEY_MISSING))
  await page.route('**/api/v1/vault/notes/key-backup', (route) => route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'none', code: 'no_key_backup' }) }))
  await openWithUnlock(page, token)
  await expect(card(page).getByTestId('locked-note-no-backup')).toContainText('Passwords trash', { timeout: 15_000 })
  await expect(card(page).getByTestId('locked-note-restore')).toHaveCount(0)
  await expect(page.locator('body')).not.toContainText(SECRET)
})

test('with backups of two vaults, the person picks the one that locked the note', async ({ page, request }, info) => {
  const token = await lockedNote(request, info)
  const kdf = { name: 'PBKDF2-SHA256', iterations: 1000, salt: 'c2FsdHNhbHRzYWx0c2FsdA==' }
  const list = { vaultId: 'v-new', kdf, keys: 1, hint: 'the new laptop', earlier: [{ vaultId: 'v-old', kdf, keys: 1, hint: 'the old desk' }] }
  await page.route('**/api/v1/vault/notes/read', (route) => route.fulfill(KEY_MISSING))
  await page.route('**/api/v1/vault/notes/key-backup', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(list) }))
  let asked: Record<string, unknown> | null = null
  await page.route('**/api/v1/vault/notes/restore-key', (route) => {
    asked = route.request().postDataJSON() as Record<string, unknown>
    return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'Wrong', code: 'wrong_password' }) })
  })
  await openWithUnlock(page, token)
  const pick = card(page).getByRole('radiogroup', { name: 'Which backup' })
  await expect(pick.getByRole('radio')).toHaveCount(2, { timeout: 15_000 })
  await expect(pick).toContainText('Newest backup, hint: the new laptop')
  await pick.getByLabel('Older backup 1, hint: the old desk').check()
  await card(page).getByTestId('locked-note-restore-password').fill('an old master password')
  await card(page).getByTestId('locked-note-restore-secret-key').fill('W1-AAAAAA-BBBBB-CCCCC-DDDDD-EEEEE')
  await card(page).getByTestId('locked-note-restore').click()
  await expect(card(page).getByTestId('locked-note-restore-error')).toBeVisible()
  expect(asked).toMatchObject({ vaultId: 'v-old', secretKey: 'W1-AAAAAA-BBBBB-CCCCC-DDDDD-EEEEE' })
})
