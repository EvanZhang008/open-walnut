/**
 * E2E: what opening a note costs on the wire (the "clicking a note takes
 * seconds" fix, 2026-09-24).
 *
 *  1. Switching notes fetches that note's CONTENT and nothing vault-wide: the
 *     note list and tag corpora are fetched once per page and then reused
 *     (they used to be refetched twice per click, ~600 KB on a real vault).
 *  2. Re-opening a note never writes it back. The editor's normalization pass on
 *     open emits an update for many notes; once the disk holds the normalized
 *     bytes every later open used to PUT those same bytes again, and each such
 *     PUT triggered an index reconcile plus a broadcast. (A never-normalized
 *     note may still be rewritten once, on its first open.)
 *  3. A real edit still saves, exactly once per debounce window.
 *  4. The tree is served from the server's snapshot: two reads back to back are
 *     both fast and identical, and a note created through the API is in the
 *     next read. The snapshot is server-side only: API responses stay no-store.
 */
import { test, expect, type Page } from '@playwright/test'

const API = `http://localhost:${process.env.PW_TEST_PORT ?? 3457}`
const FOLDER = 'NetProbe'
// A nested numbered list: tiptap re-emits an update when it normalizes it on open,
// which is exactly the case that used to write the note straight back.
const NOTE_A = `${FOLDER}/Nested List.md`
const NOTE_A_BODY = '1. Walnut promotion\n   1. Hook\n      1. Lost session during restart\n      2. Want to quickly find the old session\n   2. Central agent to manage it\n'
const NOTE_B = `${FOLDER}/Plain Note.md`
const NOTE_B_BODY = '# Plain\n\nA short note with the word sentinel-b in it.\n'

async function putNote(p: string, content: string) {
  const res = await fetch(`${API}/api/notes-v2/content/${encodeURI(p)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  })
  expect(res.ok).toBeTruthy()
}

async function readNote(p: string): Promise<string> {
  const res = await fetch(`${API}/api/notes-v2/content/${encodeURI(p)}`)
  return ((await res.json()) as { content: string }).content
}

type Hit = { method: string; url: string }
function recordNotesRequests(page: Page): Hit[] {
  const hits: Hit[] = []
  page.on('request', (req) => {
    const url = req.url()
    if (url.includes('/api/notes-v2')) hits.push({ method: req.method(), url: url.replace(API, '') })
  })
  return hits
}
const only = (hits: Hit[], method: string, pathPrefix: string) =>
  hits.filter((h) => h.method === method && h.url.split('?')[0].startsWith(pathPrefix))

async function gotoNotes(page: Page) {
  await page.locator('a[href="/notes"]').first().click()
  await expect(page.locator('.notes-tree-panel, .notes-tree-item').first()).toBeVisible({ timeout: 15_000 })
}

async function openFromTree(page: Page, folder: string, name: string) {
  const folderEl = page.locator(`.notes-tree-folder[data-node-path="${folder}"]`).first()
  const arrowClass = (await folderEl.locator('.notes-tree-arrow').getAttribute('class')) ?? ''
  if (!arrowClass.includes('expanded')) await folderEl.click()
  await page.locator('.notes-tree-file', { hasText: name }).first().click()
  await expect(page.locator('.notes-editor .tiptap').first()).toBeVisible({ timeout: 10_000 })
}

// Serial: both tests seed the same two notes, and a re-seed landing while the
// other test has the note open is a genuine external change the editor must
// (and does) reload and re-normalize, which would read as a spurious write here.
test.describe.configure({ mode: 'serial' })

test.beforeEach(async () => {
  await putNote(NOTE_A, NOTE_A_BODY)
  await putNote(NOTE_B, NOTE_B_BODY)
})

test('a note switch fetches only its content; re-opening never writes back; an edit saves once', async ({ page }) => {
  const hits = recordNotesRequests(page)
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await gotoNotes(page)

  // First open of a note the editor has never seen: content + the two corpora
  // (once each). The editor may normalize the markdown on this FIRST open (list
  // indentation, fence info strings) and write that once; what must never happen
  // is a write whose bytes equal the disk, which is every open after this one.
  await openFromTree(page, FOLDER, 'Nested List')
  await expect(page.locator('.notes-editor .tiptap').first()).toContainText('Lost session during restart')
  // Long enough for the 500 ms autosave window AND the corpora's debounced
  // refresh after a save (1.5 s): a normalization write here legitimately
  // refreshes the list/tags once, and that must not be mistaken for a per-switch
  // refetch below.
  await page.waitForTimeout(3500)
  const normalizationWrites = only(hits, 'PUT', '/api/notes-v2/content').length
  expect(normalizationWrites, 'at most one normalization write on a first open').toBeLessThanOrEqual(1)
  // One fetch per corpus, plus at most one refresh if the first open wrote.
  expect(only(hits, 'GET', '/api/notes-v2/list').length).toBeLessThanOrEqual(1 + normalizationWrites)
  expect(only(hits, 'GET', '/api/notes-v2/tags').length).toBeLessThanOrEqual(1 + normalizationWrites)
  const settledBytes = await readNote(NOTE_A)
  expect(settledBytes).toContain('Lost session during restart')

  // Switch: one content fetch, no corpora, no write.
  let mark = hits.length
  await openFromTree(page, FOLDER, 'Plain Note')
  await expect(page.locator('.notes-editor .tiptap').first()).toContainText('sentinel-b')
  await page.waitForTimeout(1500)
  const sinceSwitch = hits.slice(mark)
  expect(only(sinceSwitch, 'GET', '/api/notes-v2/content').map((h) => decodeURIComponent(h.url))).toEqual([
    `/api/notes-v2/content/${NOTE_B}`,
  ])
  expect(only(sinceSwitch, 'GET', '/api/notes-v2/list')).toEqual([])
  expect(only(sinceSwitch, 'GET', '/api/notes-v2/tags')).toEqual([])
  expect(only(sinceSwitch, 'GET', '/api/notes-v2/backlinks').length, 'one backlinks read per switch').toBeLessThanOrEqual(1)
  expect(only(sinceSwitch, 'PUT', '/api/notes-v2/content')).toEqual([])

  // Back and forth: re-opening a note the editor already normalized never writes,
  // and the bytes on disk stay exactly what the first open settled on.
  for (const name of ['Nested List', 'Plain Note', 'Nested List', 'Plain Note']) {
    mark = hits.length
    await openFromTree(page, FOLDER, name)
    await page.waitForTimeout(1200)
    const since = hits.slice(mark)
    expect(only(since, 'GET', '/api/notes-v2/list'), `${name}: list refetched`).toEqual([])
    expect(only(since, 'GET', '/api/notes-v2/tags'), `${name}: tags refetched`).toEqual([])
    expect(only(since, 'PUT', '/api/notes-v2/content'), `${name}: re-open wrote the note back`).toEqual([])
  }
  expect(await readNote(NOTE_A)).toBe(settledBytes)

  // A fresh page (new editor instance) opening the same settled note: still no write.
  await page.reload()
  await page.waitForLoadState('networkidle')
  mark = hits.length
  await expect(page.locator('.notes-editor .tiptap').first()).toBeVisible({ timeout: 15_000 })
  await page.waitForTimeout(1500)
  expect(only(hits.slice(mark), 'PUT', '/api/notes-v2/content'), 'reload re-opened the note and wrote it back').toEqual([])
  expect(await readNote(NOTE_A)).toBe(settledBytes)

  // A real edit still saves, once, and lands on disk.
  await openFromTree(page, FOLDER, 'Nested List')
  await page.waitForTimeout(800)
  mark = hits.length
  const editor = page.locator('.notes-editor .tiptap').first()
  await editor.click()
  await page.keyboard.press('End')
  await page.keyboard.type(' edited-by-probe')
  await expect.poll(async () => (await readNote(NOTE_A)).includes('edited-by-probe'), { timeout: 5000 }).toBe(true)
  await page.waitForTimeout(1200)
  const puts = only(hits.slice(mark), 'PUT', '/api/notes-v2/content')
  expect(puts.length).toBe(1)
  expect(decodeURIComponent(puts[0].url)).toBe(`/api/notes-v2/content/${NOTE_A}`)
})

test('the tree is served from a snapshot and still reflects a note created behind the page', async ({ request }) => {
  const t0 = Date.now()
  const a = await request.get(`${API}/api/notes-v2`)
  const b = await request.get(`${API}/api/notes-v2`)
  expect(a.ok() && b.ok()).toBeTruthy()
  expect(await a.text()).toBe(await b.text())
  expect(Date.now() - t0).toBeLessThan(2000)
  // API responses are deliberately uncacheable (server-wide `etag` off + no-store,
  // see server.ts): the snapshot lives on the server, never in the browser cache.
  expect(a.headers()['cache-control']).toContain('no-store')
  expect(a.headers()['etag']).toBeUndefined()

  const fresh = `${FOLDER}/Created Later ${Date.now()}.md`
  await putNote(fresh, '# later\n')
  const c = await request.get(`${API}/api/notes-v2`)
  expect(await c.text()).toContain(fresh.split('/')[1])
})
