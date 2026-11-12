/**
 * New note makes the note at once, and its name follows the title written into it.
 *
 * 2026-11-11, the user, on the Notes tree's New note: "When we new a file please immediate
 * new the file, if nothing provided it is just md file name will be provided as the title,
 * by default if no name provided". It used to show an empty "note name" input first.
 *
 * Now: the click creates `Untitled.md` (or the next free `Untitled N.md`) in the vault root
 * or the folder it was asked in, opens it with the caret in the editor, and once the first
 * line settles the file is renamed to it (web/src/components/notes/note-auto-name.ts),
 * in place: the same editor keeps the caret and whatever is typed next lands in the
 * renamed file, never in a revived Untitled one. A title another note has gets a number;
 * a name the user gives in the tree ends the following.
 *
 * The unit halves: tests/web/note-auto-name.test.ts (names, titles, when to rename) and
 * tests/web/note-rename-in-place.test.ts (the open note moves without reopening).
 * Real clicks and keys only. Runs in both engines: Chromium by default, WebKit with
 * `PW_WEBKIT=1 ... --project=webkit` (the Mac app's engine).
 */
import { mkdirSync } from 'node:fs'
import { test, expect, type APIRequestContext, type Page } from '@playwright/test'

test.setTimeout(120_000)
test.describe.configure({ mode: 'serial' })

const SHOTS = '/tmp/notes-new-note-untitled'
const STAMP = Date.now().toString(36)
/** Every note path a test may have made, removed after each test. */
const made = new Set<string>()

const notePath = (p: string) => `/api/notes-v2/content/${encodeURI(p)}`

async function readNote(request: APIRequestContext, p: string): Promise<string | null> {
  const r = await request.get(notePath(p))
  return r.ok() ? (await r.json()).content as string : null
}

async function openNotes(page: Page): Promise<void> {
  const url = test.info().project.use.baseURL
  if (!url) throw new Error('The fixture server URL is missing')
  await page.setContent(`<a href="${url}">Open Walnut</a>`)
  await page.getByRole('link', { name: 'Open Walnut', exact: true }).click()
  await page.locator('a[href="/notes"]').first().click()
  await expect(page.locator('.notes-tree-panel').first()).toBeVisible({ timeout: 60_000 })
}

/** Click New note (`click`) and return the path the server made. */
async function newNote(page: Page, click: () => Promise<void>): Promise<string> {
  const created = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/v1/notes')
  await click()
  const res = await created
  expect(res.status()).toBe(201)
  const p: string = (await res.json()).path
  made.add(p)
  return p
}

const editor = (page: Page) => page.locator('.notes-editor-pane .notes-editor .tiptap').first()
const treeRow = (page: Page, p: string) => page.locator(`.notes-tree-body .notes-tree-file[data-node-path="${p}"]`)
const openPath = (page: Page) => new URL(page.url()).searchParams.get('path')

async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(SHOTS, { recursive: true })
  const engine = page.context().browser()?.browserType().name() ?? 'browser'
  await page.locator('.notes-split-view').first().screenshot({ path: `${SHOTS}/${engine}-${name}.png`, scale: 'css' })
}

const pageErrors: string[] = []
test.beforeEach(async ({ page }) => {
  pageErrors.length = 0
  page.on('pageerror', (e) => pageErrors.push(String(e)))
  await page.setViewportSize({ width: 1280, height: 800 })
})
test.afterEach(async ({ request }) => {
  for (const p of made) await request.delete(notePath(p))
  made.clear()
  expect(pageErrors, 'browser errors').toEqual([])
})

test('New note opens an Untitled note at once, ready to type, and the file takes its title', async ({ page, request }) => {
  await openNotes(page)
  const untitled = await newNote(page, () => page.getByTitle('New Note', { exact: true }).click())
  expect(untitled).toMatch(/^Untitled( \d+)?\.md$/)
  // No name step: no input in the tree, the note is open with the caret in it.
  await expect(page.getByPlaceholder('note name', { exact: true })).toHaveCount(0)
  await expect(editor(page)).toBeFocused()
  await expect(treeRow(page, untitled)).toBeVisible()
  expect(await readNote(request, untitled), 'on disk before a word is typed').not.toBeNull()
  await shot(page, '1-untitled-open')

  const title = `Weekly sync ${STAMP}`
  const renamed = `${title}.md`
  made.add(renamed)
  await page.keyboard.type(`# ${title}`, { delay: 15 })
  await page.keyboard.press('Enter')
  await page.keyboard.type('Agenda', { delay: 15 })
  await expect.poll(() => readNote(request, renamed), { timeout: 20_000 }).toContain('Agenda')
  expect(await readNote(request, untitled), 'the Untitled file is gone, not copied').toBeNull()
  await expect(treeRow(page, renamed)).toBeVisible()
  await expect(treeRow(page, renamed)).toHaveClass(/selected/)
  await expect.poll(() => openPath(page)).toBe(renamed)
  // The same editor carries on: still focused, and the next words land in the renamed file.
  await expect(editor(page)).toBeFocused()
  await page.keyboard.type(' and notes', { delay: 15 })
  await expect.poll(() => readNote(request, renamed), { timeout: 15_000 }).toContain('Agenda and notes')
  // Give a stray save to the old path its chance: it must never come.
  await page.waitForTimeout(1500)
  expect(await readNote(request, untitled), 'no save brought the Untitled file back').toBeNull()
  await shot(page, '2-renamed-after-title')
})

test('a title another note has gets the next number, and that note is untouched', async ({ page, request }) => {
  const title = `Plan ${STAMP}`
  const taken = `${title}.md`
  made.add(taken)
  const seeded = await request.post('/api/v1/notes', { data: { path: taken, content: 'the other note\n' } })
  expect(seeded.status()).toBe(201)
  await openNotes(page)
  await newNote(page, () => page.getByTitle('New Note', { exact: true }).click())
  await expect(editor(page)).toBeFocused()
  const numbered = `${title} 1.md`
  made.add(numbered)
  await page.keyboard.type(`# ${title}`, { delay: 15 })
  await expect.poll(() => readNote(request, numbered), { timeout: 20_000 }).toContain(`# ${title}`)
  expect(await readNote(request, taken)).toContain('the other note')
  await expect(treeRow(page, numbered)).toBeVisible()
})

test('New note from a folder\'s menu makes it in that folder', async ({ page, request }) => {
  const folder = `nn-folder-${STAMP}`
  expect((await request.post('/api/notes-v2/folder', { data: { path: folder } })).ok()).toBe(true)
  try {
    await openNotes(page)
    const row = page.locator(`.notes-tree-folder[data-node-path="${folder}"]`).first()
    await expect(row).toBeVisible({ timeout: 15_000 })
    await row.click({ button: 'right' })
    const inFolder = await newNote(page, () => page.locator('.notes-context-menu').getByRole('button', { name: 'New Note', exact: true }).click())
    expect(inFolder).toBe(`${folder}/Untitled.md`)
    await expect(editor(page)).toBeFocused()
    await expect(treeRow(page, inFolder)).toBeVisible()
    const named = `${folder}/Inside ${STAMP}.md`
    made.add(named)
    await page.keyboard.type(`Inside ${STAMP}`, { delay: 15 })
    await expect.poll(() => readNote(request, named), { timeout: 20_000 }).toContain(`Inside ${STAMP}`)
  } finally {
    for (const p of made) await request.delete(notePath(p))
    made.clear()
    await request.delete(`/api/notes-v2/folder/${encodeURIComponent(folder)}`)
  }
})

test('a name given in the tree ends the following: a later title edit keeps it', async ({ page, request }) => {
  await openNotes(page)
  const untitled = await newNote(page, () => page.getByTitle('New Note', { exact: true }).click())
  await expect(editor(page)).toBeFocused()
  const chosen = `Chosen ${STAMP}`
  made.add(`${chosen}.md`)
  await treeRow(page, untitled).click({ button: 'right' })
  await page.locator('.notes-context-menu').getByRole('button', { name: 'Rename', exact: true }).click()
  const input = page.locator('.notes-tree-inline-input')
  await expect(input).toBeFocused()
  await input.fill(chosen)
  await input.press('Enter')
  await expect(treeRow(page, `${chosen}.md`)).toBeVisible({ timeout: 15_000 })
  await editor(page).click()
  await page.keyboard.type(`# Something else ${STAMP}`, { delay: 15 })
  await expect.poll(() => readNote(request, `${chosen}.md`), { timeout: 15_000 }).toContain('Something else')
  // Past the save and the settle time: still the chosen name.
  await page.waitForTimeout(2500)
  expect(await readNote(request, `${chosen}.md`)).toContain('Something else')
  expect(await readNote(request, `Something else ${STAMP}.md`)).toBeNull()
})
