/**
 * A locked note on the Notes page (docs/reference/locked-notes.md), as the person uses it: lock a
 * plain note from its header (the master password asked in the unlock sheet), see the lock in the
 * tree and the hidden pane, press Show, write, Hide, leave and come back (hidden again), and remove
 * the lock. Then the ways the text could be lost or shown again: a save still on its way when the
 * note is left, a failed save before Hide, a rename, another window's save, a read that lands after
 * Passwords locked, typing while Lock or Remove lock runs. The file on disk holds only the stub and
 * the ciphertext at every step. Fake text only. The Lock button is the `locked_notes` experiment's.
 */
import { test, expect, type APIRequestContext, type BrowserContext, type Page, type Route } from '@playwright/test'
import { VAULT_MASTER, vaultSession } from './vault-session-helper'
import { API, boot, editorOf, lockMenu, nameIn, openNoteIn, putNotes, stamp, typeAtEnd } from './protected-notes-helper'
import { holdVaultLock } from './vault-lock'

// The fixture's one vault: these tests unlock it for their own window only (vault-lock.ts).
holdVaultLock('shared', 'test')

const SECRET = 'quokkamarmalade'
const TEXT = `# Week\n\nMonday: ${SECRET} is the word I keep.\n\nTuesday: a walk by the river.\n`
const VAULT = (token: string) => ({ 'x-walnut-vault-session': token })

let note = ''
let other = ''
let tag = ''
async function seed(name: string) {
  tag = name
  note = `LockedTest/Week ${tag}.md`
  other = `LockedTest/Other ${tag}.md`
  await putNotes([[note, TEXT], [other, '# Other\n\nA plain note.\n']])
}
const onDisk = async () => (await (await fetch(`${API}/api/notes-v2/content/${note}`)).json()) as { content: string; locked?: boolean }
const nameOf = (p: string) => nameIn('LockedTest', p)

/** The locked note's text as Walnut holds it sealed (read with a Passwords unlock). */
async function sealedText(request: APIRequestContext, token: string, p = note): Promise<string> {
  const r = await request.post(`${API}/api/v1/vault/notes/read`, { data: { path: p }, headers: VAULT(token) })
  expect(r.ok(), await r.text()).toBe(true)
  return ((await r.json()) as { content: string }).content
}
async function lockByApi(request: APIRequestContext, token: string, p = note) {
  expect((await request.post(`${API}/api/v1/vault/notes/lock`, { data: { path: p }, headers: VAULT(token) })).ok()).toBe(true)
}
/** Every window of `context` starts with this Passwords unlock (as one unlocked earlier would). */
async function unlockWindows(context: BrowserContext, token: string) {
  await context.addInitScript((t) => { try { localStorage.setItem('walnut.vault.session', t) } catch { /* no storage here */ } }, token)
}

const openNote = (page: Page, p: string) => openNoteIn(page, 'LockedTest', p)
async function openAndShow(page: Page, p = note) {
  await openNote(page, p)
  await page.getByTestId('locked-note-show').click()
  await expect(editorOf(page)).toContainText(SECRET, { timeout: 15_000 })
}
/** The master password sheet: `button` is Unlock, or Approve for a yes to an agent's ask. */
async function unlockInSheet(page: Page, button: 'Unlock' | 'Approve' = 'Unlock') {
  const sheet = page.getByTestId('pw-unlock-sheet')
  await expect(sheet).toBeVisible()
  await sheet.getByLabel('Master password').fill(VAULT_MASTER)
  await sheet.getByRole('button', { name: button, exact: true }).click()
  await expect(sheet).toHaveCount(0, { timeout: 30_000 })
}

/** Holds every request to `url` while `held.on`; `release` lets them go on (or fail) and stops holding. */
async function holdRequests(page: Page, url: string) {
  const held = { on: true, routes: [] as Route[] }
  await page.route(url, (route) => { if (held.on) held.routes.push(route); else void route.continue() })
  const release = async (how: 'continue' | 'fail') => {
    held.on = false
    for (const r of held.routes.splice(0)) await (how === 'continue' ? r.continue() : r.abort('failed'))
  }
  return { held, release }
}

test.setTimeout(180_000)
// The Lock button is behind the experiment; the panel of a note already locked never is.
test.beforeAll(async ({ request }) => {
  const r = await request.put(`${API}/api/config`, { data: { experimental: { locked_notes: true } } })
  expect(r.ok(), await r.text()).toBe(true)
})

test('lock a note, show it with the master password, write, hide, and remove the lock', async ({ page, request }, info) => {
  await seed(stamp(info))
  await vaultSession(request, API) // Passwords is set up; this window has no unlock of its own
  await boot(page)

  // A plain note, then Lock > Encrypt in its header: a confirm, then the unlock sheet asks the master password.
  await openNote(page, note)
  await expect(editorOf(page)).toContainText(SECRET)
  await lockMenu(page, 'Encrypt')
  const dialog = page.locator('.app-modal')
  await expect(dialog).toContainText('Lock this note?')
  await expect(dialog).toContainText('lock a note before you write private text in it')
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
  const shown = editorOf(page)
  await expect(shown).toContainText(SECRET, { timeout: 15_000 })
  await expect(page.locator('.notes-format-toolbar').getByRole('button', { name: 'Image' })).toHaveCount(0)

  // Write: saved sealed, the file still holds no text.
  await typeAtEnd(page, 'Tuesday', ' Then tea.')
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
  await expect(editorOf(page)).toContainText('A plain note.')
  await openNote(page, note)
  await expect(hidden).toBeVisible()
  await expect(page.locator('body')).not.toContainText(SECRET)

  // Remove lock: the editor is read-only while it runs (typing then goes nowhere, so nothing is
  // lost), and the text goes back into the file as a plain note.
  await page.getByTestId('locked-note-show').click()
  await expect(shown).toContainText('Then tea.')
  const remove = await holdRequests(page, '**/api/v1/vault/notes/remove-lock')
  await page.getByTestId('locked-note-remove-lock').click()
  await expect(dialog).toContainText('Remove the lock?')
  await dialog.getByRole('button', { name: 'Remove lock', exact: true }).click()
  await expect.poll(() => remove.held.routes.length, { timeout: 15_000 }).toBe(1)
  await expect(shown).toHaveAttribute('contenteditable', 'false')
  await shown.locator('p', { hasText: 'Tuesday' }).click()
  await page.keyboard.type(' Typed while removing.')
  await expect(shown).not.toContainText('Typed while removing.')
  await remove.release('continue')
  await expect(page.getByTestId('note-lock')).toBeVisible({ timeout: 15_000 })
  await expect(editorOf(page)).toContainText('Then tea.')
  disk = await onDisk()
  expect(disk.locked).toBeUndefined()
  expect(disk.content).toContain(SECRET)
  expect(disk.content).toContain('Then tea.')
})

test('after Lock the note hides at once, with no change event, and typing while it locks goes nowhere', async ({ page, context, request }, info) => {
  await seed(`ev-${stamp(info)}`)
  await unlockWindows(context, await vaultSession(request, API))
  // The note's change events never reach this window: the hide must come from the lock's own answer.
  let dropped = 0
  await page.routeWebSocket(/\/ws(?:\?|$)/, (ws) => {
    const server = ws.connectToServer()
    server.onMessage((m) => {
      if (typeof m === 'string' && m.includes('"notes:updated"') && m.includes(nameOf(note))) { dropped++; return }
      ws.send(m)
    })
  })
  await boot(page)
  await openNote(page, note)
  await expect(editorOf(page)).toContainText(SECRET)

  const lock = await holdRequests(page, '**/api/v1/vault/notes/lock')
  await lockMenu(page, 'Encrypt')
  await page.locator('.app-modal').getByRole('button', { name: 'Lock', exact: true }).click()
  await expect.poll(() => lock.held.routes.length, { timeout: 15_000 }).toBe(1)
  await expect(editorOf(page)).toHaveAttribute('contenteditable', 'false')
  await editorOf(page).locator('p', { hasText: 'Tuesday' }).click()
  await page.keyboard.type(' During lock.')
  await expect(editorOf(page)).not.toContainText('During lock.')
  await lock.release('continue')

  await expect(page.getByTestId('locked-note-hidden')).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('body')).not.toContainText(SECRET)
  await expect.poll(() => dropped, { timeout: 15_000 }).toBeGreaterThan(0)
  expect((await onDisk()).locked).toBe(true)
})

test('an agent reads a locked note only after the person approves its card with the master password', async ({ page, context, request }, info) => {
  await seed(`ask-${stamp(info)}`)
  const token = await vaultSession(request, API)
  await lockByApi(request, token)
  // This window is already unlocked: approving still asks for the master password, typed now.
  await unlockWindows(context, token)
  const agent = { 'x-walnut-caller-sid': 'pw-locked-note-agent' }
  const askFor = async (access: 'read' | 'edit') => {
    const ask = await (await request.post(`${API}/api/v1/vault/notes/agent/ask`, { data: { path: note, purpose: 'summarise the week for the plan', access }, headers: agent })).json()
    expect(ask.status).toBe('pending')
    return ask as { requestId: string; waitToken: string }
  }
  const waitFor = async (ask: { requestId: string; waitToken: string }) =>
    (await request.post(`${API}/api/v1/vault/notes/agent/ask/${ask.requestId}/wait`, { data: { token: ask.waitToken, wait_ms: 0 }, headers: agent })).json()

  const read = await askFor('read')
  expect((await waitFor(read)).status).toBe('pending')
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/')
  const card = page.locator(`[data-testid="approval-card"][data-approval-id="${read.requestId}"]`)
  await expect(card).toBeVisible({ timeout: 30_000 })
  await expect(card).toContainText(`read your locked note "${nameOf(note)}"`)
  await expect(card).not.toContainText(SECRET)
  await card.getByTestId('approval-approve').click()
  // The sheet approves, and says who, which note, for how long and where the text goes.
  const sheet = page.getByTestId('pw-unlock-sheet')
  await expect(sheet.getByRole('heading')).toHaveText('Approve with your master password')
  await expect(sheet).toContainText(`read your locked note "${nameOf(note)}". A yes lets the agent read it for 10 minutes`)
  await expect(sheet).toContainText("goes into that agent's conversation")
  await unlockInSheet(page, 'Approve')
  await expect(page.locator(`.approval-card-settled[data-approval-id="${read.requestId}"]`)).toContainText('Approved', { timeout: 15_000 })
  const got = await waitFor(read)
  expect(got.status).toBe('released')
  expect(got.content).toContain(SECRET)
  // The file itself still holds no text.
  expect((await onDisk()).content).not.toContain(SECRET)

  // An edit ask: the sheet says the yes lets it change the note too.
  const edit = await askFor('edit')
  const editCard = page.locator(`[data-testid="approval-card"][data-approval-id="${edit.requestId}"]`)
  await expect(editCard).toContainText(`read and change your locked note "${nameOf(note)}"`, { timeout: 30_000 })
  await editCard.getByTestId('approval-approve').click()
  await expect(page.getByTestId('pw-unlock-sheet')).toContainText('A yes lets the agent read and change it for 30 minutes')
  await unlockInSheet(page, 'Approve')
  await expect(page.locator(`.approval-card-settled[data-approval-id="${edit.requestId}"]`)).toContainText('Approved', { timeout: 15_000 })
})

test('a quick note switch and a Passwords lock never lose what was typed', async ({ page, request }, info) => {
  await seed(`fast-${stamp(info)}`)
  const token = await vaultSession(request, API)
  await lockByApi(request, token)
  await boot(page)
  await openNote(page, note)
  await page.getByTestId('locked-note-show').click()
  await unlockInSheet(page)
  const shown = editorOf(page)
  await expect(shown).toContainText(SECRET)

  // Typed, then straight to another note. No save can land before the switch (held), and the one
  // that went out, if any, then fails: the words are kept either way, and saved.
  let saves = await holdRequests(page, '**/api/v1/vault/notes/save')
  await typeAtEnd(page, 'Tuesday', ' Fast words.')
  await openNote(page, other)
  await expect(editorOf(page)).toContainText('A plain note.')
  await saves.release('fail')
  await page.unroute('**/api/v1/vault/notes/save')
  await openNote(page, note)
  await page.getByTestId('locked-note-show').click()
  await expect(shown).toContainText('Fast words.', { timeout: 15_000 })
  await expect.poll(() => sealedText(request, token), { timeout: 20_000 }).toContain('Fast words.')

  // Typed, its save already on its way when the note is left, and that save then fails: the words
  // were written aside before the save went, so they are kept and saved again.
  saves = await holdRequests(page, '**/api/v1/vault/notes/save')
  await typeAtEnd(page, 'Monday', ' Flight words.')
  await expect.poll(() => saves.held.routes.length, { timeout: 15_000 }).toBe(1)
  await openNote(page, other)
  await expect(editorOf(page)).toContainText('A plain note.')
  await saves.release('fail')
  await page.unroute('**/api/v1/vault/notes/save')
  await expect.poll(() => sealedText(request, token), { timeout: 20_000 }).toContain('Flight words.')
  await openNote(page, note)
  await page.getByTestId('locked-note-show').click()
  await expect(shown).toContainText('Flight words.', { timeout: 15_000 })

  // Typed, then this window's Passwords unlock ends elsewhere (a Lock from another window): the text
  // hides at once and the words are kept. Only this window's unlock: other specs share the vault.
  await typeAtEnd(page, 'Tuesday', ' Before lock.')
  const windowToken = await page.evaluate(() => localStorage.getItem('walnut.vault.session'))
  expect(windowToken).toBeTruthy()
  await request.post(`${API}/api/v1/vault/lock`, { data: {}, headers: VAULT(windowToken!) })
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
  await expect.poll(() => sealedText(request, token), { timeout: 20_000 }).toMatch(/Fast words\. Before lock\./)
})

test('a text read that lands after Passwords locked is never shown', async ({ page, context, request }, info) => {
  await seed(`late-${stamp(info)}`)
  const token = await vaultSession(request, API)
  await lockByApi(request, token)
  const windowToken = await vaultSession(request, API)
  await unlockWindows(context, windowToken)
  await boot(page)
  await openNote(page, note)
  // Show's read is answered while unlocked, but reaches the page only after Passwords locked here.
  let late: { route: Route; response: Awaited<ReturnType<Route['fetch']>> } | null = null
  await page.route('**/api/v1/vault/notes/read', async (route) => { late = { route, response: await route.fetch() } })
  await page.getByTestId('locked-note-show').click()
  await expect.poll(() => late !== null, { timeout: 15_000 }).toBe(true)
  await request.post(`${API}/api/v1/vault/lock`, { data: {}, headers: VAULT(windowToken) })
  await expect.poll(() => page.evaluate(() => localStorage.getItem('walnut.vault.session')), { timeout: 15_000 }).toBeNull()
  await late!.route.fulfill({ response: late!.response })
  await page.waitForTimeout(1000)
  await expect(page.getByTestId('locked-note-hidden')).toBeVisible()
  await expect(page.locator('body')).not.toContainText(SECRET)
})

test('a failed save, then Hide: the change is kept and saved on the next Show', async ({ page, context, request }, info) => {
  await seed(`fail-${stamp(info)}`)
  const token = await vaultSession(request, API)
  await lockByApi(request, token)
  await unlockWindows(context, token)
  await boot(page)
  await openAndShow(page)
  const failing = (route: Route) => route.fulfill({ status: 500, json: { error: 'Disk full' } })
  await page.route('**/api/v1/vault/notes/save', failing)
  await typeAtEnd(page, 'Tuesday', ' Hidden words.')
  await expect(page.locator('.notes-save-status.error')).toHaveCount(1, { timeout: 15_000 })
  await page.getByTestId('locked-note-hide').click()
  const dialog = page.locator('.app-modal')
  await expect(dialog).toContainText('Hide without saving?')
  await dialog.getByRole('button', { name: 'Hide', exact: true }).click()
  await expect(page.getByTestId('locked-note-hidden')).toBeVisible()
  await expect(page.locator('body')).not.toContainText(SECRET)
  expect(await sealedText(request, token)).not.toContain('Hidden words.')

  await page.unroute('**/api/v1/vault/notes/save', failing)
  await page.getByTestId('locked-note-show').click()
  await expect(editorOf(page)).toContainText('Hidden words.', { timeout: 15_000 })
  await expect.poll(() => sealedText(request, token), { timeout: 20_000 }).toContain('Hidden words.')
})

test('a rename of the open locked note keeps the change not saved yet', async ({ page, context, request }, info) => {
  await seed(`ren-${stamp(info)}`)
  const token = await vaultSession(request, API)
  await lockByApi(request, token)
  await unlockWindows(context, token)
  await boot(page)
  await openAndShow(page)
  const saves = await holdRequests(page, '**/api/v1/vault/notes/save')
  await typeAtEnd(page, 'Tuesday', ' Renamed words.')

  const renamed = `LockedTest/Renamed ${tag}.md`
  await page.locator('.notes-tree-file', { hasText: nameOf(note) }).first().click({ button: 'right' })
  await page.locator('.notes-context-menu').getByRole('button', { name: 'Rename', exact: true }).click()
  const input = page.locator('.notes-tree-inline-input')
  await input.fill(nameOf(renamed))
  await input.press('Enter')
  await expect(page.locator('.notes-tree-file', { hasText: nameOf(renamed) }).first()).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('locked-note-hidden')).toContainText(nameOf(renamed), { timeout: 15_000 })
  await saves.release('continue')

  await page.getByTestId('locked-note-show').click()
  await expect(editorOf(page)).toContainText('Renamed words.', { timeout: 15_000 })
  await expect.poll(() => sealedText(request, token, renamed), { timeout: 20_000 }).toContain('Renamed words.')
})

test('a save that merges with another window keeps both windows\' words', async ({ page, context, request }, info) => {
  await seed(`two-${stamp(info)}`)
  const token = await vaultSession(request, API)
  await lockByApi(request, token)
  await unlockWindows(context, token)
  await boot(page)
  await openAndShow(page)
  const second = await context.newPage()
  await boot(second)
  await openAndShow(second)

  // This window's save waits while the other window saves first; more is typed meanwhile.
  const saves = await holdRequests(page, '**/api/v1/vault/notes/save')
  await typeAtEnd(page, 'Monday', ' Ay words.')
  await expect.poll(() => saves.held.routes.length, { timeout: 15_000 }).toBe(1)
  await page.keyboard.type(' More ay.')
  await typeAtEnd(second, 'Tuesday', ' Bee words.')
  await expect(second.locator('.notes-save-status.saved')).toHaveCount(1, { timeout: 15_000 })
  await saves.release('continue')

  // The merge shows here at once, and every later save carries the other window's words.
  await expect(editorOf(page)).toContainText('Bee words.', { timeout: 15_000 })
  await expect.poll(() => sealedText(request, token), { timeout: 20_000 }).toMatch(/Ay words\. More ay\.[\s\S]*Bee words\./)
  await typeAtEnd(page, 'Monday', ' Last.')
  await expect.poll(() => sealedText(request, token), { timeout: 20_000 }).toContain('Last.')
  expect(await sealedText(request, token)).toContain('Bee words.')
  await second.close()
})

test('a kept change that cannot merge with another window\'s shows on the next Show, with the choice', async ({ page, context, request }, info) => {
  await seed(`clash-${stamp(info)}`)
  const token = await vaultSession(request, API)
  await lockByApi(request, token)
  await unlockWindows(context, token)
  await boot(page)
  await openAndShow(page)
  const second = await context.newPage()
  await boot(second)
  await openAndShow(second)

  // Typed here, then off to another note while that save is still on its way; the other window
  // changes the same line meanwhile, so the kept change cannot merge.
  const saves = await holdRequests(page, '**/api/v1/vault/notes/save')
  await typeAtEnd(page, 'Monday', ' Mine words.')
  await expect.poll(() => saves.held.routes.length, { timeout: 15_000 }).toBe(1)
  await openNote(page, other)
  await expect(editorOf(page)).toContainText('A plain note.')
  await typeAtEnd(second, 'Monday', ' Theirs words.')
  await expect(second.locator('.notes-save-status.saved')).toHaveCount(1, { timeout: 15_000 })
  await saves.release('continue')

  // Show puts the person's version back, unsaved, and asks which one to keep.
  await openNote(page, note)
  await page.getByTestId('locked-note-show').click()
  const notice = page.getByTestId('locked-note-conflict')
  await expect(notice).toBeVisible({ timeout: 15_000 })
  await expect(notice).toContainText('could not be merged')
  await expect(editorOf(page)).toContainText('Mine words.')
  await expect(editorOf(page)).not.toContainText('Theirs words.')
  if (process.env.LOCKED_SHOTS) await page.screenshot({ path: `${process.env.LOCKED_SHOTS}/locked-note-conflict.png` })
  expect(await sealedText(request, token)).toContain('Theirs words.')
  await notice.getByTestId('locked-note-keep-mine').click()
  await expect(notice).toHaveCount(0)
  await expect.poll(() => sealedText(request, token), { timeout: 20_000 }).toContain('Mine words.')
  expect(await sealedText(request, token)).not.toContain('Theirs words.')
  await second.close()
})

test('with the experiment off: no Lock button, and a locked note still opens hidden with Show', async ({ page, context, request }, info) => {
  await seed(`off-${stamp(info)}`)
  const token = await vaultSession(request, API)
  await lockByApi(request, token)
  await unlockWindows(context, token)
  // Only this window reads the switch off; the server's switch stays as the other tests need it.
  await page.route((url) => url.pathname === '/api/config', async (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    const response = await route.fetch()
    const body = await response.json() as { config?: { experimental?: Record<string, boolean> } }
    body.config = { ...body.config, experimental: { ...(body.config?.experimental ?? {}), locked_notes: false } }
    await route.fulfill({ response, json: body })
  })
  await boot(page)
  await openNote(page, other)
  await expect(editorOf(page)).toContainText('A plain note.')
  await expect(page.getByTestId('note-lock')).toHaveCount(0)
  await openNote(page, note)
  await expect(page.getByTestId('locked-note-hidden')).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('body')).not.toContainText(SECRET)
  await page.getByTestId('locked-note-show').click()
  await expect(editorOf(page)).toContainText(SECRET, { timeout: 15_000 })
})
