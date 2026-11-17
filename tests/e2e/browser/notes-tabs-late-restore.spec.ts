/**
 * A restored Notes workspace never decides where the person's typing is saved.
 *
 * 2026-11-16, CI (notes-new-note-untitled "New note from a folder's menu"): the previous test had
 * deleted `Plan ... 1.md`; the next page restored it from the shared server's ui-prefs, closed it
 * once the tree came back without it, and opened a New note in a folder. Then the URL mirror's own
 * write of the restored tab (`?path=Plan ... 1.md`), which the router applies as a transition and
 * a busy machine lands late, came back after all that, was taken for a navigation and opened the
 * deleted note again, empty; the words typed next were saved into it, writing it back.
 *
 * The rules this guards (web/src/pages/NotesPage.tsx, web/src/utils/ui-prefs-sync.ts):
 *  1. Once the person opened or created a note in this visit, a late ui-prefs answer never
 *     replaces the open tabs (claimPrefKey): storage and the server keep the person's.
 *  2. A tab restored from prefs is not a save target until the tree lists its note: a gone note
 *     is never asked for, and the page's own URL write coming back late never opens it again.
 *  (A note that is not there when it opens, or deleted under typing: notes-deleted-note.spec.ts.)
 *
 * The late transition is made deterministic by slowing React's scheduler (the MessagePort it
 * posts its work slices on) while the page mounts: the tree's answer then commits before the
 * router's URL transition, exactly as it did under load. The prefs are this page's own (its
 * reads of /api/ui-prefs are answered here and its writes recorded, never sent), so the specs
 * running beside it on the shared fixture server neither disturb it nor see its deleted note.
 * Real clicks and keys only.
 */
import { test, expect } from '@playwright/test'
import {
  TABS_KEY, editor, tabLabels, readNote, deletedWorkspace, ownPrefs, watchNote, openApp, newNoteInFolder, slowableScheduler, setSlow, schedulerDrained, NEGATIVE_WAIT_MS, uniqueStamp, notesTestHooks,
} from './notes-gone-helpers'

test.setTimeout(120_000)

const { made, folders } = notesTestHooks()

test('a deleted note in the restored workspace is never asked for, and the URL write coming back late never opens it', async ({ page, request }) => {
  const stamp = uniqueStamp()
  const gone = `Gone ${stamp}.md`
  made.add(gone)
  await ownPrefs(page, await deletedWorkspace(request, gone))
  const folder = `lr-folder-${stamp}`
  folders.add(folder)
  expect((await request.post('/api/notes-v2/folder', { data: { path: folder } })).ok()).toBe(true)
  const goneRequests = watchNote(page, gone)
  const urls: string[] = []
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) urls.push(f.url()) })

  // Delaying React's work slices while Notes mounts makes the tree's answer commit before the
  // router's URL transition, as it did on the busy CI machine.
  await slowableScheduler(page)
  await openApp(page)
  expect(await page.evaluate((k) => localStorage.getItem(k), TABS_KEY), 'the saved workspace was read at boot').toContain(gone)
  await setSlow(page, 200)
  await page.locator('a[href="/notes"]').first().click()
  await expect(page.locator('.notes-tree-panel').first()).toBeVisible({ timeout: 60_000 })
  await expect(page.locator(`.notes-tree-folder[data-node-path="${folder}"]`).first()).toBeVisible({ timeout: 30_000 })
  // The mirror wrote the restored tab into the URL while it waited for the tree: the write whose
  // late echo used to reopen it.
  await expect.poll(() => urls.some((u) => new URL(u).searchParams.get('path') === gone), { message: 'the URL named the restored tab' }).toBe(true)
  // The tree's answer is on screen while the router's transition of that write still waits. Back
  // to full speed (still counted), then every slice queued has run, that transition among them.
  await setSlow(page, 0)
  await expect.poll(() => schedulerDrained(page), { timeout: 30_000 }).toBe(true)
  await expect(tabLabels(page).filter({ hasText: `Gone ${stamp}` }), 'the deleted note is not open').toHaveCount(0)
  expect(new URL(page.url()).searchParams.get('path'), 'the URL does not keep the deleted note').not.toBe(gone)

  const untitled = await newNoteInFolder(page, folder)
  made.add(untitled)
  await expect(editor(page)).toBeFocused()
  const named = `${folder}/Inside ${stamp}.md`
  made.add(named)
  await page.keyboard.type(`Inside ${stamp}`, { delay: 15 })
  await expect.poll(() => readNote(request, named), { timeout: 20_000 }).toContain(`Inside ${stamp}`)
  await expect(page.locator('.notes-save-status.saving')).toHaveCount(0)
  // A negative: any save the typing could still send to the deleted note has had its time.
  await page.waitForTimeout(NEGATIVE_WAIT_MS)
  expect(await readNote(request, gone), 'the deleted note was not written back').toBeNull()
  expect(goneRequests.filter((r) => r.method() === 'PUT').length, 'no save to the deleted note').toBe(0)
  expect(goneRequests.map((r) => r.method()), 'the deleted note was never asked for').toEqual([])
})

test('a late prefs answer keeps the tabs the person opened, in this browser and on the server', async ({ page, request }) => {
  const stamp = uniqueStamp()
  const gone = `Gone ${stamp}.md`
  made.add(gone)
  const folder = `lr-folder-${stamp}`
  folders.add(folder)
  expect((await request.post('/api/notes-v2/folder', { data: { path: folder } })).ok()).toBe(true)
  const goneRequests = watchNote(page, gone)

  // The first read of the prefs times out (2.5 s) and the retries wait until released.
  let release!: () => void
  const released = new Promise<void>((resolve) => { release = resolve })
  const prefs = await ownPrefs(page, await deletedWorkspace(request, gone), released)
  const lateApplied = page.waitForEvent('console', { predicate: (m) => m.text().includes('late prefs applied'), timeout: 60_000 })

  await openApp(page)
  await page.locator('a[href="/notes"]').first().click()
  await expect(page.locator('.notes-tree-panel').first()).toBeVisible({ timeout: 60_000 })
  const untitled = await newNoteInFolder(page, folder)
  made.add(untitled)
  await expect(editor(page)).toBeFocused()
  const named = `${folder}/Inside ${stamp}.md`
  made.add(named)
  await page.keyboard.type(`Inside ${stamp}`, { delay: 15 })
  await expect.poll(() => readNote(request, named), { timeout: 20_000 }).toContain(`Inside ${stamp}`)
  await expect.poll(() => new URL(page.url()).searchParams.get('path')).toBe(named)

  release()
  await lateApplied
  await page.keyboard.type(' and more', { delay: 15 })
  await expect.poll(() => readNote(request, named), { timeout: 15_000 }).toContain(`Inside ${stamp} and more`)

  const stored = await page.evaluate((k) => localStorage.getItem(k), TABS_KEY)
  expect(stored, 'this browser keeps the person\'s tabs').toContain(named)
  expect(stored).not.toContain(gone)
  await expect.poll(() => prefs.lastSent(TABS_KEY), { timeout: 15_000, message: 'the server gets the person\'s tabs' }).toContain(named)
  expect(prefs.lastSent(TABS_KEY)).not.toContain(gone)
  await expect(tabLabels(page).filter({ hasText: `Inside ${stamp}` })).toHaveCount(1)
  await expect(tabLabels(page).filter({ hasText: `Gone ${stamp}` })).toHaveCount(0)
  expect(await readNote(request, gone), 'the deleted note was not written back').toBeNull()
  expect(goneRequests.filter((r) => r.method() === 'PUT').length, 'no save to the deleted note').toBe(0)
})
