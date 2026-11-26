/**
 * Shared by the Notes specs about a note that is not there (notes-tabs-late-restore.spec.ts,
 * notes-deleted-note.spec.ts): the page's own prefs, the app opened by a real click, a scheduler
 * that can be slowed and watched, and the clean-up of what a test made.
 */
import { test, expect, type APIRequestContext, type Page, type Request } from '@playwright/test'

export const TABS_KEY = 'open-walnut-notes-tabs'
export const notePath = (p: string) => `/api/notes-v2/content/${encodeURI(p)}`
export const editor = (page: Page) => page.locator('.notes-editor-pane .notes-editor .tiptap').first()
export const tabLabels = (page: Page) => page.locator('.notes-tab-strip .notes-tab-label')

export async function readNote(request: APIRequestContext, p: string): Promise<string | null> {
  const r = await request.get(notePath(p))
  return r.ok() ? (await r.json()).content as string : null
}

/** A note that existed and was deleted since; the saved workspace names it as its open tab. */
export async function deletedWorkspace(request: APIRequestContext, gone: string): Promise<Record<string, { v: string; ts: number }>> {
  expect((await request.post('/api/v1/notes', { data: { path: gone, content: 'deleted before this visit\n' } })).status()).toBe(201)
  expect((await request.delete(notePath(gone))).ok()).toBe(true)
  const v = JSON.stringify({ tabs: [{ path: gone, kind: 'note' }], activePath: gone })
  return { [TABS_KEY]: { v, ts: Date.now() - 60_000 } }
}

/**
 * The page's prefs, answered here: the full read gets `prefs` once `ready` resolves (at once
 * by default), and every write is recorded in `sent` instead of reaching the shared server.
 */
export async function ownPrefs(page: Page, prefs: Record<string, { v: string; ts: number }>, ready: Promise<void> = Promise.resolve()) {
  const sent: Array<Record<string, { v: string | null; ts: number }>> = []
  await page.route('**/api/ui-prefs*', async (route) => {
    const req = route.request()
    if (req.method() === 'PUT') {
      sent.push((req.postDataJSON() as { prefs: Record<string, { v: string | null; ts: number }> }).prefs)
      return route.fulfill({ json: { ok: true } })
    }
    const key = new URL(req.url()).searchParams.get('key')
    if (key) return route.fulfill({ json: { prefs: key in prefs ? { [key]: prefs[key] } : {} } })
    await ready
    try { await route.fulfill({ json: { prefs } }) } catch { /* the page gave up on this read */ }
  })
  /** The last value of the key this page sent up. */
  return { lastSent: (key: string): string | null | undefined => [...sent].reverse().find((p) => key in p)?.[key]?.v }
}

/** Every request for the note's content, by method. */
export function watchNote(page: Page, p: string): Request[] {
  const seen: Request[] = []
  page.on('request', (r) => { if (decodeURIComponent(new URL(r.url()).pathname) === `/api/notes-v2/content/${p}`) seen.push(r) })
  return seen
}

export async function openApp(page: Page): Promise<void> {
  const url = test.info().project.use.baseURL
  if (!url) throw new Error('The fixture server URL is missing')
  await page.setContent(`<a href="${url}">Open Walnut</a>`)
  await page.getByRole('link', { name: 'Open Walnut', exact: true }).click()
  await page.locator('a[href="/notes"]').first().waitFor({ timeout: 60_000 })
}

export async function newNoteInFolder(page: Page, folder: string): Promise<string> {
  const row = page.locator(`.notes-tree-folder[data-node-path="${folder}"]`).first()
  await expect(row).toBeVisible({ timeout: 15_000 })
  await row.click({ button: 'right' })
  const created = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/v1/notes')
  await page.locator('.notes-context-menu').getByRole('button', { name: 'New note', exact: true }).click()
  const res = await created
  expect(res.status()).toBe(201)
  return (await res.json()).path as string
}

/**
 * Delays each slice of work React's scheduler posts on a MessagePort by `window.__slowScheduler`
 * ms (unset: untouched), and counts the slices still waiting. React posts the next slice as soon
 * as it has work, so none waiting (twice, a moment apart) means its queue ran dry: every
 * transition queued before, the router's late URL transition among them, has run.
 */
export async function slowableScheduler(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __slowScheduler?: number; __slicesWaiting: number }
    w.__slicesWaiting = 0
    const post = MessagePort.prototype.postMessage
    MessagePort.prototype.postMessage = function (this: MessagePort, ...args: unknown[]) {
      const send = () => (post as (...a: unknown[]) => void).apply(this, args)
      const delay = w.__slowScheduler
      if (delay === undefined) { send(); return }
      w.__slicesWaiting++
      setTimeout(() => { w.__slicesWaiting--; send() }, delay)
    } as typeof post
  })
}
export const setSlow = (page: Page, ms: number) => page.evaluate((v) => { (window as unknown as { __slowScheduler?: number }).__slowScheduler = v }, ms)
export const schedulerDrained = (page: Page) => page.evaluate(() => new Promise<boolean>((resolve) => {
  const w = window as unknown as { __slicesWaiting: number }
  if (w.__slicesWaiting !== 0) { resolve(false); return }
  setTimeout(() => resolve(w.__slicesWaiting === 0), 50)
}))
/** How long a write that must NOT happen is given to show up: past the editor's 500 ms save debounce. */
export const NEGATIVE_WAIT_MS = 1_500

/** Names of this test's own notes: the two tests run at once on two workers and can start in the same millisecond. */
export const uniqueStamp = () => `${Date.now().toString(36)}w${test.info().parallelIndex}`

/**
 * The notes and folders a test made, removed after it, and the browser errors it must not have.
 * Call once at the top of a spec file.
 */
export function notesTestHooks(): { made: Set<string>; folders: Set<string> } {
  const made = new Set<string>()
  const folders = new Set<string>()
  const pageErrors: string[] = []
  test.beforeEach(async ({ page }) => {
    pageErrors.length = 0
    page.on('pageerror', (e) => pageErrors.push(String(e)))
    await page.setViewportSize({ width: 1280, height: 800 })
  })
  test.afterEach(async ({ request }) => {
    for (const p of made) await request.delete(notePath(p))
    made.clear()
    for (const f of folders) await request.delete(`/api/notes-v2/folder/${encodeURIComponent(f)}`)
    folders.clear()
    expect(pageErrors, 'browser errors').toEqual([])
  })
  return { made, folders }
}
