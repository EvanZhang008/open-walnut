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
 *  4. A note the page has already seen paints from the in-page content cache
 *     the moment it is clicked, before the server answers, with no spinner; the
 *     bytes are revalidated against the disk in the background.
 *  5. Resting the pointer on a tree row fetches that note ahead of the click,
 *     and the click that follows shares that request instead of racing it.
 *  6. An edit made just before a switch reaches the disk even though the click
 *     render already unmounted that note's editor (the departing editor
 *     serializes itself on destroy; the flush never reads a dead instance).
 *  7. The tree is served from the server's snapshot: two reads back to back are
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
// Never opened by a click before the hover test: a page restores its last active
// note on open (and caches it), so the hover target must be one nobody touched.
const NOTE_C = `${FOLDER}/Hover Target.md`
const NOTE_C_BODY = '# Hover\n\nOnly ever reached by resting the pointer first: sentinel-c.\n'

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

/**
 * Fail loudly on a React render crash. The boundary logs it and crash-recovery
 * reloads the page, so without this the test only sees "element not found".
 */
function failOnRenderCrash(page: Page): () => void {
  const crashes: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error' && /render error caught by boundary|render crash/.test(m.text())) crashes.push(m.text().slice(0, 400))
  })
  return () => expect(crashes, 'render crash during the test').toEqual([])
}

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

// Serial: the tests seed the same two notes, and a re-seed landing while another
// test has the note open is a genuine external change the editor must (and does)
// reload and re-normalize, which would read as a spurious write here. 90 s: the
// first test alone waits ~15 s on purpose (autosave and refresh windows), and a
// cold Vite dev fixture on a loaded machine takes 30 s+ to serve the home page.
test.describe.configure({ mode: 'serial', timeout: 90_000 })

test.beforeEach(async () => {
  await putNote(NOTE_A, NOTE_A_BODY)
  await putNote(NOTE_B, NOTE_B_BODY)
  await putNote(NOTE_C, NOTE_C_BODY)
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

test('a note the page already holds paints from cache before the server answers', async ({ page }) => {
  const assertNoCrash = failOnRenderCrash(page)
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await gotoNotes(page)
  const editor = page.locator('.notes-editor .tiptap').first()
  await openFromTree(page, FOLDER, 'Nested List')
  await expect(editor).toContainText('Lost session during restart')
  await openFromTree(page, FOLDER, 'Plain Note')
  await expect(editor).toContainText('sentinel-b')
  await page.waitForTimeout(1500) // the first open's normalization write settles

  // Hold every content read from here on: a click must not wait for one.
  const HOLD_MS = 5000
  await page.route('**/api/notes-v2/content/**', async (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    await new Promise((r) => setTimeout(r, HOLD_MS))
    await route.continue()
  })
  // Any spinner inside the editor body from now on is a cache miss.
  await page.evaluate(() => {
    const w = window as unknown as { __spinnerSeen: boolean }
    w.__spinnerSeen = false
    new MutationObserver(() => {
      if (document.querySelector('.notes-editor-body .loading-spinner')) w.__spinnerSeen = true
    }).observe(document.body, { subtree: true, childList: true })
  })

  const t0 = Date.now()
  await page.locator('.notes-tree-file', { hasText: 'Nested List' }).first().click()
  await expect(editor).toContainText('Lost session during restart', { timeout: HOLD_MS - 1000 })
  expect(Date.now() - t0, 'painted before the held response could arrive').toBeLessThan(HOLD_MS)
  expect(await page.evaluate(() => (window as unknown as { __spinnerSeen: boolean }).__spinnerSeen)).toBe(false)
  await page.unroute('**/api/notes-v2/content/**')
  assertNoCrash()
})

test('an edit made right before switching notes is saved by the departing editor', async ({ page }) => {
  const assertNoCrash = failOnRenderCrash(page)
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await gotoNotes(page)
  const editor = page.locator('.notes-editor .tiptap').first()
  await openFromTree(page, FOLDER, 'Plain Note')
  await expect(editor).toContainText('sentinel-b')
  await page.waitForTimeout(1500) // first-open normalization settles

  // Type, then switch inside the 500 ms autosave window. The click render shows
  // the next note at once, so React unmounts this editor BEFORE the hook's
  // switch flush runs; the flush must still carry these bytes to disk (they
  // used to be read from the destroyed editor: a render crash + a lost edit).
  await editor.click()
  await page.keyboard.press('End')
  await page.keyboard.type(' quick-switch-probe')
  await page.locator('.notes-tree-file', { hasText: 'Nested List' }).first().click()
  await expect(editor).toContainText('Lost session during restart')
  await expect.poll(async () => (await readNote(NOTE_B)).includes('quick-switch-probe'), { timeout: 5000 }).toBe(true)

  // Coming back shows the saved text at once (the cache learned the write too).
  await page.locator('.notes-tree-file', { hasText: 'Plain Note' }).first().click()
  await expect(editor).toContainText('quick-switch-probe')
  assertNoCrash()
})

test('resting the pointer on a tree row fetches its note ahead of the click', async ({ page }) => {
  const assertNoCrash = failOnRenderCrash(page)
  const hits = recordNotesRequests(page)
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await gotoNotes(page)
  const folderEl = page.locator(`.notes-tree-folder[data-node-path="${FOLDER}"]`).first()
  const arrowClass = (await folderEl.locator('.notes-tree-arrow').getAttribute('class')) ?? ''
  if (!arrowClass.includes('expanded')) await folderEl.click()
  const row = page.locator('.notes-tree-file', { hasText: 'Hover Target' }).first()

  const mark = hits.length
  await row.hover()
  await expect
    .poll(() => only(hits.slice(mark), 'GET', '/api/notes-v2/content').map((h) => decodeURIComponent(h.url)), { timeout: 3000 })
    .toEqual([`/api/notes-v2/content/${NOTE_C}`])
  await page.waitForTimeout(600)

  // The click that follows either joins the prefetch still in flight or, once
  // it landed, paints from it and revalidates once: never two loads racing.
  const beforeClick = hits.length
  await row.click()
  await expect(page.locator('.notes-editor .tiptap').first()).toContainText('sentinel-c')
  await page.waitForTimeout(800)
  expect(only(hits.slice(beforeClick), 'GET', '/api/notes-v2/content').length).toBeLessThanOrEqual(1)
  assertNoCrash()
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
