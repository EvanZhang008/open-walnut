/**
 * Typing WHILE a live write is in flight — the one interleaving the rest of the
 * suite cannot reach.
 *
 * Why it needs its own file: the local fixture answers a PUT in a couple of
 * milliseconds, so a keystroke never lands inside the flight and the state this
 * pins simply does not occur. Here the response is HELD by a route handler for as
 * long as the test needs, which turns "a remote host's tunnel round trip" into
 * something deterministic.
 *
 * What went wrong there, found in review of the write-guard fix (2026-09-08): a
 * successful write deliberately does NOT re-baseline the editor when the buffer has
 * already moved on (the file is still dirty by exactly those keystrokes, and
 * re-baselining would switch the dirty dot off and delete the draft backing them).
 * But the bytes on disk DID change, and the write's optimistic-lock token is now
 * derived from the editor's base, so leaving the base behind made every following
 * write 409 by construction. Symptoms were not silent: a pointless full-file
 * re-read per typing pause, a "Merged disk changes" receipt for a disk that never
 * changed, the caret yanked to the top of a markdown document, and on unmount the
 * last burst dropped instead of written.
 *
 * These tests assert the OUTCOMES a user would notice, not the internals: the
 * second burst reaches disk, and no conflict UI appears.
 */
import { test, expect, type Locator, type Page } from '@playwright/test'

const SESSION_ID = 'pw-vscode-session'
const TASK_ID = 'pw-task-vscode'
const SCREENSHOT_DIR = '/tmp/walnut-files-panel/live-edit-inflight'

async function fixtureCwd(page: Page): Promise<string> {
  const res = await page.request.get(`/api/sessions/${SESSION_ID}`)
  expect(res.ok()).toBe(true)
  const body = await res.json()
  return (body?.session?.cwd ?? body?.cwd) as string
}

async function openFilesPanel(page: Page): Promise<Locator> {
  await page.locator('.todo-search-input').fill(SESSION_ID)
  const task = page.locator(`.todo-panel-item[data-task-id="${TASK_ID}"]`)
  await expect(task).toBeVisible()
  await task.getByRole('button', { name: 'More actions' }).click()
  await page.locator('.task-kebab-menu:visible').locator('.task-kebab-item').first().click()
  const panel = page.locator(`.session-panel[data-session-id="${SESSION_ID}"]`)
  await expect(panel).toBeVisible()
  await panel.getByRole('button', { name: 'Files' }).click()
  const explorer = panel.locator('.session-file-explorer')
  await expect(explorer).toBeVisible({ timeout: 15_000 })
  return explorer
}

const nodeByName = (explorer: Locator, name: string) =>
  explorer.locator('.sfe-name', { hasText: name }).locator('xpath=..')
const editor = (page: Page) => page.locator('.fv-source-editor .cm-content')

async function makeScratchFile(page: Page, name: string, body: string): Promise<string> {
  const cwd = await fixtureCwd(page)
  const abs = `${cwd}/${name}`
  expect((await page.request.post('/api/files/create', { data: { path: abs } })).status()).toBe(200)
  expect((await page.request.put('/api/file-content', { data: { path: abs, content: body } })).ok()).toBe(true)
  return abs
}

async function onDisk(page: Page, abs: string): Promise<string> {
  const res = await page.request.get(`/api/file-content?path=${encodeURIComponent(abs)}`, {
    headers: { 'cache-control': 'no-store' },
  })
  expect(res.ok()).toBe(true)
  return (await res.json()).content as string
}

async function openFileLive(page: Page, explorer: Locator, name: string, expectText: string): Promise<void> {
  await nodeByName(explorer, name).click()
  await expect(editor(page)).toContainText(expectText)
  const toggle = page.locator('.fv-live-toggle')
  await expect(toggle).toBeVisible()
  if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('open-walnut-file-explorer-tree-collapsed', '0')
      localStorage.setItem('open-walnut-live-edit', '0')
    } catch { /* storage off */ }
  })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
})

test('a keystroke during an in-flight write does not break the NEXT write', async ({ page }) => {
  const name = `inflight-${Date.now()}.txt`
  const abs = await makeScratchFile(page, name, 'base line\n')

  // Hold the FIRST auto-write's response until we say so. Later writes pass
  // straight through, so the test measures the state the held one leaves behind.
  let release: (() => void) | null = null
  const held = new Promise<void>((r) => { release = r })
  let seen = 0
  const conflicts: number[] = []
  await page.route('**/api/file-content', async (route) => {
    if (route.request().method() !== 'PUT') return route.fallback()
    seen += 1
    if (seen === 1) await held
    const res = await route.fetch()
    if (res.status() === 409) conflicts.push(seen)
    await route.fulfill({ response: res })
  })

  const explorer = await openFilesPanel(page)
  await openFileLive(page, explorer, name, 'base line')

  await editor(page).click()
  await page.keyboard.press('End')
  await page.keyboard.type('-first')
  // The debounce plus the request itself; by now write #1 is parked in our handler.
  await expect.poll(() => seen, { timeout: 10_000 }).toBe(1)

  // The keystroke that lands INSIDE the flight. This is the whole point: when the
  // held response finally arrives, the buffer no longer equals what was written.
  await page.keyboard.type('-second')
  release!()

  // Both bursts must reach disk. Before the fix the second write 409'd against a
  // base left one generation behind, and only survived by a merge cycle that
  // re-read the file and told the user their changes had been merged.
  await expect.poll(() => onDisk(page, abs), { timeout: 15_000 }).toContain('-first-second')

  // And no conflict UI: nothing else touched this file, so a receipt or a banner
  // here would be a lie the user has to interpret.
  await expect(page.locator('.fv-conflict-banner')).toHaveCount(0)
  expect(conflicts, `PUT #${conflicts.join(',')} returned 409 with no other writer`).toEqual([])
  await page.screenshot({ path: `${SCREENSHOT_DIR}/1-inflight-both-bursts.png` })
})

test('the last burst still lands when the file is switched away mid-flight', async ({ page }) => {
  const stamp = Date.now()
  const a = await makeScratchFile(page, `inflight-a-${stamp}.txt`, 'file a\n')
  await makeScratchFile(page, `inflight-b-${stamp}.txt`, 'file b\n')

  let release: (() => void) | null = null
  const held = new Promise<void>((r) => { release = r })
  let seen = 0
  await page.route('**/api/file-content', async (route) => {
    if (route.request().method() !== 'PUT') return route.fallback()
    seen += 1
    if (seen === 1) await held
    await route.fulfill({ response: await route.fetch() })
  })

  const explorer = await openFilesPanel(page)
  await openFileLive(page, explorer, `inflight-a-${stamp}.txt`, 'file a')

  await editor(page).click()
  await page.keyboard.press('End')
  await page.keyboard.type('-one')
  await expect.poll(() => seen, { timeout: 10_000 }).toBe(1)
  await page.keyboard.type('-two')
  release!()
  // Leave the file mid-flight. This is a SEPARATE gap from the one above, and it
  // predates the write-guard work: the final flush found a write already in flight
  // and simply dropped the record, because there was no timer left to re-check on
  // and "the draft store still holds the text". True, but it means the characters
  // someone typed just before clicking another file are not on disk, and only come
  // back as a stale-draft banner the next time they open that file. The flush now
  // waits for the write in flight and rebases onto the bytes it left.
  await nodeByName(explorer, `inflight-b-${stamp}.txt`).click()
  await expect(editor(page)).toContainText('file b')

  await expect.poll(() => onDisk(page, a), { timeout: 15_000 }).toContain('-one-two')
  await page.screenshot({ path: `${SCREENSHOT_DIR}/2-switch-away-mid-flight.png` })
})
