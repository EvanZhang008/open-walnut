/**
 * A note that is not there never takes the person's typing as a way to come back, and never
 * loses it (web/src/hooks/useNoteGone.ts, useNoteContent.ts, src/web/routes/notes-v2.ts).
 *
 * 2026-11-16, CI: a deleted note opened as an empty editor and the next keystrokes were saved
 * into it, writing it back. The rules:
 *  1. A note reached by Back, a deep link or a restored tab that is not there shows as "not
 *     here", never as an editor. "Write it" makes it create-only: a note someone wrote meanwhile
 *     opens, and a note written while it shows as not here replaces that state by itself.
 *  2. A save naming the bytes it replaces is refused (410) once the note was deleted. The text
 *     is held: leaving the note, or Notes, and coming back shows it again with its banner.
 *  3. The hold ends when the note is there again (reloaded, saved elsewhere): typing saves again.
 *  4. "Save as a new note" is create-only too: a note made meanwhile is never overwritten (the
 *     text merges into it, or lands beside it under a new name).
 *  5. A save still out when the person moves to another note is held all the same once refused,
 *     and its tab stays. Held text keeps the hash it was edited from, so the first save after the
 *     note is made again merges instead of writing over it, and it outlives a full reload (a
 *     deploy's auto-reload waits for it while the banner shows).
 *
 * Real clicks and keys only; the prefs are this page's own (notes-gone-helpers.ts ownPrefs).
 */
import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { TABS_KEY, notePath, editor, tabLabels, readNote, ownPrefs, watchNote, openApp, slowableScheduler, NEGATIVE_WAIT_MS, uniqueStamp, notesTestHooks } from './notes-gone-helpers'

test.setTimeout(120_000)

const { made } = notesTestHooks()

const missingState = (page: Page) => page.getByTestId('notes-missing-state')
const deletedBanner = (page: Page) => page.getByTestId('notes-deleted-banner')
const treeRow = (page: Page, p: string) => page.locator(`.notes-tree-file[data-node-path="${p}"]`).first()
const tab = (page: Page, label: string) => page.locator('.notes-tab-strip .notes-tab').filter({ has: page.locator('.notes-tab-label', { hasText: label }) }).first()

async function makeNote(request: APIRequestContext, p: string, content: string): Promise<void> {
  expect((await request.post('/api/v1/notes', { data: { path: p, content } })).status()).toBe(201)
  made.add(p)
}

/** Opens `target`, then reaches it again by Back after it was deleted: it shows as not here. */
async function backToDeleted(page: Page, request: APIRequestContext, stamp: string): Promise<string> {
  const target = `Back B ${stamp}.md`
  const linking = `Back A ${stamp}.md`
  await makeNote(request, target, `Target ${stamp}\n`)
  await makeNote(request, linking, `Links to [[Back B ${stamp}]]\n`)
  await slowableScheduler(page)
  await openApp(page)
  await page.locator('a[href="/notes"]').first().click()
  await treeRow(page, target).click()
  await expect(editor(page)).toContainText(`Target ${stamp}`)
  // Follow the backlink: a history entry of its own (Back returns to the target's).
  const toggle = page.locator('.notes-backlinks-toggle')
  await expect(toggle).toBeVisible({ timeout: 20_000 })
  await toggle.click()
  await page.locator('.notes-backlink-item').filter({ hasText: `Back A ${stamp}` }).first().click()
  await expect(editor(page)).toContainText('Links to')
  await expect.poll(() => new URL(page.url()).searchParams.get('path')).toBe(linking)
  // Deleted elsewhere: its tab closes once the tree says so.
  expect((await request.delete(notePath(target))).ok()).toBe(true)
  await expect(tabLabels(page).filter({ hasText: `Back B ${stamp}` })).toHaveCount(0, { timeout: 20_000 })
  await page.goBack()
  await expect.poll(() => new URL(page.url()).searchParams.get('path')).toBe(target)
  await expect(missingState(page)).toBeVisible({ timeout: 15_000 })
  return target
}

/**
 * Opens `target` (and `other` in a second tab), types into `target` while its save is held,
 * deletes it on the server and lets the save go: it is refused (410) and the banner shows.
 * Returns the statuses of the saves that reached the server.
 */
async function deleteUnderTyping(page: Page, request: APIRequestContext, target: string, words: string, other?: string): Promise<number[]> {
  await slowableScheduler(page)
  await openApp(page)
  await page.locator('a[href="/notes"]').first().click()
  await treeRow(page, target).click()
  await expect(editor(page)).toContainText('Start')
  if (other) {
    await treeRow(page, other).click({ modifiers: ['ControlOrMeta'] })
    await expect(editor(page)).toContainText('Other')
    await tab(page, target.replace(/\.md$/, '')).click()
    await expect(editor(page)).toContainText('Start')
  }
  let release!: () => void
  const deletedFirst = new Promise<void>((resolve) => { release = resolve })
  const saves: number[] = []
  await page.route((u) => decodeURIComponent(u.pathname) === `/api/notes-v2/content/${target}`, async (route) => {
    if (route.request().method() !== 'PUT') return route.fallback()
    if (saves.length === 0) await deletedFirst
    const res = await route.fetch()
    saves.push(res.status())
    await route.fulfill({ response: res })
  })
  const firstSave = page.waitForRequest((r) => r.method() === 'PUT' && decodeURIComponent(new URL(r.url()).pathname) === `/api/notes-v2/content/${target}`)
  await editor(page).click()
  await page.keyboard.press('End')
  await page.keyboard.type(words, { delay: 15 })
  await firstSave
  expect((await request.delete(notePath(target))).ok()).toBe(true)
  release()
  await expect(deletedBanner(page)).toBeVisible({ timeout: 15_000 })
  expect(saves).toEqual([410])
  await expect(editor(page)).toContainText(words.trim())
  expect(await readNote(request, target), 'the refused save did not recreate the note').toBeNull()
  return saves
}

test('Back to a deleted note shows it as not there, never as an editor to type into; Write it makes it on purpose', async ({ page, request }) => {
  const stamp = uniqueStamp()
  await ownPrefs(page, {})
  const target = `Back B ${stamp}.md`
  const targetRequests = watchNote(page, target)
  await backToDeleted(page, request, stamp)
  await expect(page.locator('.notes-editor-pane .notes-editor .tiptap'), 'no editor to type into').toHaveCount(0)
  expect(targetRequests.filter((r) => r.method() === 'PUT'), 'no save to the deleted note').toHaveLength(0)
  expect(await readNote(request, target), 'the deleted note was not written back').toBeNull()

  // On purpose, it is one click away.
  await missingState(page).getByRole('button', { name: 'Write it', exact: true }).click()
  await editor(page).click()
  await page.keyboard.type(`Again ${stamp}`, { delay: 15 })
  await expect.poll(() => readNote(request, target), { timeout: 20_000 }).toContain(`Again ${stamp}`)
})

test('a note written by someone while it shows as not here opens by itself', async ({ page, request }) => {
  const stamp = uniqueStamp()
  await ownPrefs(page, {})
  const target = await backToDeleted(page, request, stamp)
  // An agent writes the note: the page reads it, and the "not here" state goes.
  expect((await request.post('/api/v1/notes', { data: { path: target, content: `Agent words ${stamp}\n` } })).status()).toBe(201)
  await expect(editor(page)).toContainText(`Agent words ${stamp}`, { timeout: 15_000 })
  await expect(missingState(page)).toHaveCount(0)
})

test('Write it is create-only: a note someone wrote a moment before opens untouched, and typing edits it', async ({ page, request }) => {
  const stamp = uniqueStamp()
  await ownPrefs(page, {})
  const target = await backToDeleted(page, request, stamp)
  // The agent's write lands just before the page's create.
  await page.route('**/api/v1/notes', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    expect((await request.post('/api/v1/notes', { data: { path: target, content: `Agent again ${stamp}\n` } })).status()).toBe(201)
    await route.fallback()
  }, { times: 1 })
  const created = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/v1/notes')
  await missingState(page).getByRole('button', { name: 'Write it', exact: true }).click()
  expect((await created).status(), 'the create was refused: a note is there').toBe(409)
  await expect(editor(page)).toContainText(`Agent again ${stamp}`, { timeout: 15_000 })
  await editor(page).click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type(' plus', { delay: 15 })
  await expect.poll(() => readNote(request, target), { timeout: 15_000 }).toContain(`Agent again ${stamp} plus`)
})

test('a note deleted while its text is being saved keeps the text, and saves it as a new note on request', async ({ page, request }) => {
  const stamp = uniqueStamp()
  const target = `Typing ${stamp}.md`
  await ownPrefs(page, {})
  await makeNote(request, target, `Start ${stamp}\n`)
  const saves = await deleteUnderTyping(page, request, target, ` and words ${stamp}`)
  // More typing is kept on screen, never sent.
  await page.keyboard.type(' more', { delay: 15 })
  await page.waitForTimeout(NEGATIVE_WAIT_MS)
  expect(saves).toEqual([410])

  await deletedBanner(page).getByRole('button', { name: 'Save as a new note', exact: true }).click()
  await expect.poll(() => readNote(request, target), { timeout: 15_000 }).toContain(`and words ${stamp} more`)
  await expect(deletedBanner(page)).toHaveCount(0)
})

test('the held text of a deleted note survives switching tabs and leaving Notes', async ({ page, request }) => {
  const stamp = uniqueStamp()
  const target = `Held ${stamp}.md`
  const other = `Other ${stamp}.md`
  await ownPrefs(page, {})
  await makeNote(request, target, `Start ${stamp}\n`)
  await makeNote(request, other, `Other ${stamp}\n`)
  await deleteUnderTyping(page, request, target, ` and words ${stamp}`, other)

  await tab(page, `Other ${stamp}`).click()
  await expect(editor(page)).toContainText(`Other ${stamp}`)
  await tab(page, `Held ${stamp}`).click()
  await expect(editor(page)).toContainText(`and words ${stamp}`)
  await expect(deletedBanner(page)).toBeVisible()

  await page.locator('a[href="/"]').first().click()
  // The sidebar's Notes link remembers the open note (`/notes?path=...`).
  await page.locator('a[href^="/notes"]').first().click()
  await expect(editor(page)).toContainText(`and words ${stamp}`, { timeout: 15_000 })
  await expect(deletedBanner(page)).toBeVisible()
  expect(await readNote(request, target), 'nothing was sent while held').toBeNull()

  await deletedBanner(page).getByRole('button', { name: 'Save as a new note', exact: true }).click()
  await expect.poll(() => readNote(request, target), { timeout: 15_000 }).toContain(`and words ${stamp}`)
})

test('a deleted note made again elsewhere ends the hold: the next typing saves, merged into it', async ({ page, request }) => {
  const stamp = uniqueStamp()
  const target = `Again ${stamp}.md`
  await ownPrefs(page, {})
  await makeNote(request, target, `Start ${stamp}\n`)
  const saves = await deleteUnderTyping(page, request, target, ` and words ${stamp}`)
  // Someone makes it again, adding a line of their own: the banner it held is replaced.
  expect((await request.post('/api/v1/notes', { data: { path: target, content: `Start ${stamp}\n\nTheirs ${stamp}\n` } })).status()).toBe(201)
  await expect(deletedBanner(page)).toHaveCount(0, { timeout: 15_000 })
  await editor(page).click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type(' last', { delay: 15 })
  await expect.poll(() => saves.length, { timeout: 15_000, message: 'typing saves again' }).toBeGreaterThan(1)
  await expect.poll(async () => {
    const now = await readNote(request, target)
    return !!now && now.includes(`Theirs ${stamp}`) && now.includes(`and words ${stamp}`)
  }, { timeout: 20_000, message: 'their line and the held words are both in the note' }).toBe(true)
})

test('Save as a new note never overwrites a note made again while the text was held', async ({ page, request }) => {
  const stamp = uniqueStamp()
  const target = `Taken ${stamp}.md`
  const other = `Other ${stamp}.md`
  const restored = `Taken ${stamp} (restored).md`
  made.add(restored)
  await ownPrefs(page, {})
  await makeNote(request, target, `Start ${stamp}\n`)
  await makeNote(request, other, `Other ${stamp}\n`)
  await deleteUnderTyping(page, request, target, ` and words ${stamp}`, other)

  // Away from it, someone writes the note again, the same line their own way.
  await tab(page, `Other ${stamp}`).click()
  await expect(editor(page)).toContainText(`Other ${stamp}`)
  expect((await request.post('/api/v1/notes', { data: { path: target, content: `Rewritten ${stamp}\n` } })).status()).toBe(201)
  await tab(page, `Taken ${stamp}`).click()
  await expect(editor(page)).toContainText(`and words ${stamp}`)
  await expect(deletedBanner(page)).toBeVisible()

  await deletedBanner(page).getByRole('button', { name: 'Save as a new note', exact: true }).click()
  // The two cannot merge: the held text lands beside theirs, which stays as they wrote it.
  await expect.poll(() => readNote(request, restored), { timeout: 15_000 }).toContain(`and words ${stamp}`)
  const theirs = await readNote(request, target)
  expect(theirs).toContain(`Rewritten ${stamp}`)
  expect(theirs).not.toContain(`and words ${stamp}`)
  await expect(tabLabels(page).filter({ hasText: `Taken ${stamp} (restored)` })).toHaveCount(1)
})

/** The app's own reload check (stale-assets.ts hasUnsavedWork), run in the page's module instance. */
const reloadWouldLoseWork = (page: Page) => page.evaluate(`(async () => {
  const stale = await import('/src/utils/stale-assets.ts')
  return stale.hasUnsavedWork()
})()`) as Promise<boolean>

test('a save still out when the person moves to another tab keeps its text once refused, and its tab stays', async ({ page, request }) => {
  const stamp = uniqueStamp()
  const target = `Out ${stamp}.md`
  const other = `Other ${stamp}.md`
  await ownPrefs(page, {})
  await makeNote(request, target, `Start ${stamp}\n`)
  await makeNote(request, other, `Other ${stamp}\n`)
  await slowableScheduler(page)
  await openApp(page)
  await page.locator('a[href="/notes"]').first().click()
  await treeRow(page, target).click()
  await expect(editor(page)).toContainText('Start')
  await treeRow(page, other).click({ modifiers: ['ControlOrMeta'] })
  await expect(editor(page)).toContainText('Other')
  await tab(page, `Out ${stamp}`).click()
  await expect(editor(page)).toContainText('Start')
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const saves: number[] = []
  await page.route((u) => decodeURIComponent(u.pathname) === `/api/notes-v2/content/${target}`, async (route) => {
    if (route.request().method() !== 'PUT') return route.fallback()
    if (saves.length === 0) await gate
    const res = await route.fetch()
    saves.push(res.status())
    await route.fulfill({ response: res })
  })
  const firstSave = page.waitForRequest((r) => r.method() === 'PUT' && decodeURIComponent(new URL(r.url()).pathname) === `/api/notes-v2/content/${target}`)
  await editor(page).click()
  await page.keyboard.press('End')
  await page.keyboard.type(` and words ${stamp}`, { delay: 15 })
  await firstSave
  // The save is out; the person moves on, and the note is deleted elsewhere meanwhile.
  await tab(page, `Other ${stamp}`).click()
  await expect(editor(page)).toContainText(`Other ${stamp}`)
  expect((await request.delete(notePath(target))).ok()).toBe(true)
  await expect(treeRow(page, target)).toHaveCount(0, { timeout: 20_000 })
  // The tree said so, and the check that closes a deleted note's tab ran: this one stays.
  await page.waitForTimeout(NEGATIVE_WAIT_MS)
  await expect(tab(page, `Out ${stamp}`), 'the tab of a note with a save out stays').toHaveCount(1)
  release()
  await expect.poll(() => saves, { timeout: 15_000 }).toEqual([410])
  await tab(page, `Out ${stamp}`).click()
  await expect(editor(page)).toContainText(`and words ${stamp}`, { timeout: 15_000 })
  await expect(deletedBanner(page)).toBeVisible()
  expect(await readNote(request, target), 'the refused save did not recreate the note').toBeNull()
  await deletedBanner(page).getByRole('button', { name: 'Save as a new note', exact: true }).click()
  await expect.poll(() => readNote(request, target), { timeout: 15_000 }).toContain(`and words ${stamp}`)
})

test('held text shown again after a tab switch keeps its hash: a note made again meanwhile is merged into, never overwritten', async ({ page, request }) => {
  const stamp = uniqueStamp()
  const target = `Kept ${stamp}.md`
  const other = `Other ${stamp}.md`
  await ownPrefs(page, {})
  await makeNote(request, target, `Start ${stamp}\n`)
  await makeNote(request, other, `Other ${stamp}\n`)
  const saves = await deleteUnderTyping(page, request, target, ` and words ${stamp}`, other)
  await tab(page, `Other ${stamp}`).click()
  await expect(editor(page)).toContainText(`Other ${stamp}`)
  await tab(page, `Kept ${stamp}`).click()
  await expect(editor(page)).toContainText(`and words ${stamp}`)
  await expect(deletedBanner(page)).toBeVisible()
  // Someone makes it again with a line of their own: the hold ends, and the next typing saves.
  expect((await request.post('/api/v1/notes', { data: { path: target, content: `Start ${stamp}\n\nTheirs ${stamp}\n` } })).status()).toBe(201)
  await expect(deletedBanner(page)).toHaveCount(0, { timeout: 15_000 })
  await editor(page).click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type(' last', { delay: 15 })
  await expect.poll(() => saves.length, { timeout: 15_000, message: 'typing saves again' }).toBeGreaterThan(1)
  await expect.poll(async () => {
    const now = await readNote(request, target)
    return !!now && now.includes(`Theirs ${stamp}`) && now.includes(`and words ${stamp}`)
  }, { timeout: 20_000, message: 'their line and the held words are both in the note' }).toBe(true)
})

test('held text outlives a full reload, and a reload check sees it as unsaved', async ({ page, request }) => {
  const stamp = uniqueStamp()
  const target = `Reload ${stamp}.md`
  const prefs: Record<string, { v: string; ts: number }> = {}
  const own = await ownPrefs(page, prefs)
  await makeNote(request, target, `Start ${stamp}\n`)
  await deleteUnderTyping(page, request, target, ` and words ${stamp}`)
  expect(await reloadWouldLoseWork(page), 'a deploy\'s auto-reload waits while the banner shows').toBe(true)

  // The page reloads (a deploy, or the person): its tabs come back from the prefs it sent.
  await expect.poll(() => own.lastSent(TABS_KEY), { timeout: 15_000 }).toContain(target)
  prefs[TABS_KEY] = { v: own.lastSent(TABS_KEY)!, ts: Date.now() }
  await page.reload()
  await expect(editor(page)).toContainText(`and words ${stamp}`, { timeout: 30_000 })
  await expect(deletedBanner(page)).toBeVisible()
  expect(await readNote(request, target), 'nothing was sent while held').toBeNull()
  await deletedBanner(page).getByRole('button', { name: 'Save as a new note', exact: true }).click()
  await expect.poll(() => readNote(request, target), { timeout: 15_000 }).toContain(`and words ${stamp}`)
  await expect(deletedBanner(page)).toHaveCount(0)
  await expect.poll(() => reloadWouldLoseWork(page), { timeout: 10_000 }).toBe(false)
})

test('Save as a new note that fails says why on the banner, and Try again saves it', async ({ page, request }) => {
  const stamp = uniqueStamp()
  const target = `Fails ${stamp}.md`
  await ownPrefs(page, {})
  await makeNote(request, target, `Start ${stamp}\n`)
  await deleteUnderTyping(page, request, target, ` and words ${stamp}`)
  await page.route('**/api/v1/notes', (route) => route.request().method() === 'POST'
    ? route.fulfill({ status: 507, json: { error: 'The disk is full' } })
    : route.fallback(), { times: 1 })
  await deletedBanner(page).getByRole('button', { name: 'Save as a new note', exact: true }).click()
  await expect(deletedBanner(page)).toContainText('Could not save it as a new note: The disk is full')
  expect(await readNote(request, target)).toBeNull()
  await deletedBanner(page).getByRole('button', { name: 'Try again', exact: true }).click()
  await expect.poll(() => readNote(request, target), { timeout: 15_000 }).toContain(`and words ${stamp}`)
  await expect(deletedBanner(page)).toHaveCount(0)
})
