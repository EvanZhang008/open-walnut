/**
 * The editor must NEVER put an old copy of a file back on disk.
 *
 * The incident (2026-09-05, a remote design doc): the Files panel wrote one
 * byte-identical stale snapshot back FOUR times over eleven hours, each write
 * about a second after the pane read the file, each one wiping what other writers
 * had added since. The server's optimistic lock did not stop it, because the
 * write carried the hash of the bytes the pane had just READ while the buffer
 * still held the bytes it had loaded EARLIER — a valid token for the wrong text.
 *
 * These are OUTCOME guards for the user-visible promise: whatever the pane does on
 * open, reload, refocus or restore, a change made on disk by someone else survives
 * unless the user themself saves over it. Be aware of what they are not: they pass
 * against the pre-fix code too, because the local fixture answers a read in ~2 ms
 * and the armed write almost always fires first, where the optimistic lock catches
 * it honestly (409 → merge). The incident needed the read to land INSIDE the write
 * debounce, which is what a remote host over an SSH tunnel does routinely and this
 * fixture does not.
 *
 * The rule itself is pinned deterministically elsewhere, and that is where to look
 * when changing this behaviour:
 *   - tests/web/live-edit-policy.test.ts → planLiveWrite (the text/token pairing),
 *   - tests/web/routes/file-content.test.ts → the server's refusal of an automatic
 *     write that carries no lock at all.
 */
import { test, expect, type Locator, type Page } from '@playwright/test'

const SESSION_ID = 'pw-vscode-session'
const TASK_ID = 'pw-task-vscode'
const SCREENSHOT_DIR = '/tmp/walnut-files-panel/stale-writeback'

// Each test loads the console twice and waits out debounces.
test.setTimeout(120_000)

async function fixtureCwd(page: Page): Promise<string> {
  const res = await page.request.get(`/api/sessions/${SESSION_ID}`)
  expect(res.ok()).toBe(true)
  const body = await res.json()
  const cwd = body?.session?.cwd ?? body?.cwd
  expect(typeof cwd).toBe('string')
  return cwd as string
}

async function openFilesPanel(page: Page): Promise<Locator> {
  await page.locator('.todo-search-input').fill(SESSION_ID)
  const task = page.locator(`.todo-panel-item[data-task-id="${TASK_ID}"]`)
  await expect(task).toBeVisible()
  await task.getByRole('button', { name: 'More actions' }).click()
  await page.locator('.task-kebab-menu:visible').locator('.task-kebab-item').first().click()
  const panel = page.locator(`.session-panel[data-session-id="${SESSION_ID}"]`)
  await expect(panel).toBeVisible()
  await panel.getByRole('button', { name: 'Files', exact: true }).click()
  const explorer = panel.locator('.session-file-explorer')
  await expect(explorer).toBeVisible({ timeout: 15_000 })
  return explorer
}

function nodeByName(explorer: Locator, name: string) {
  return explorer.locator('.sfe-name', { hasText: name }).locator('xpath=..')
}

/** The editable surface, whichever editor this file type opens in: a markdown
 *  file in a session Files panel goes straight into the TipTap (WYSIWYG) editor,
 *  which is the shape the incident happened in. */
function editor(page: Page): Locator {
  return page.locator('.fv-wysiwyg-editor .ProseMirror, .fv-source-editor .cm-content').first()
}

async function onDisk(page: Page, abs: string): Promise<string> {
  const res = await page.request.get(`/api/file-content?path=${encodeURIComponent(abs)}`, {
    headers: { 'cache-control': 'no-store' },
  })
  expect(res.ok()).toBe(true)
  return (await res.json()).content as string
}

async function makeScratchFile(page: Page, name: string, body: string): Promise<string> {
  const cwd = await fixtureCwd(page)
  const abs = `${cwd}/${name}`
  const put = await page.request.put('/api/file-content', { data: { path: abs, content: body } })
  expect(put.ok(), await put.text()).toBe(true)
  return abs
}

/** Someone else (an agent, another tab, a script) rewrites the file. */
async function externalWrite(page: Page, abs: string, content: string): Promise<void> {
  const put = await page.request.put('/api/file-content', { data: { path: abs, content } })
  expect(put.ok(), await put.text()).toBe(true)
}

async function bootConsole(page: Page, liveOn: boolean): Promise<void> {
  await page.addInitScript((live) => {
    try {
      localStorage.setItem('open-walnut-file-explorer-tree-collapsed', '0')
      localStorage.setItem('open-walnut-live-edit', live ? '1' : '0')
    } catch { /* off */ }
  }, liveOn)
  await page.goto('/')
  await page.waitForLoadState('networkidle')
}

test('a reload with unsaved text does not put the old copy back over someone else\'s newer file', async ({ page }) => {
  const name = `staleback-${Date.now()}.md`
  const ORIGINAL = `# Doc\n\nthe original body\n`
  // Deliberately much bigger, like the real incident (28 KB stale copy vs a
  // 40 KB file): a size difference makes the clobber unmistakable.
  const NEWER = `# Doc\n\n${'a paragraph another writer added\n'.repeat(200)}`

  await bootConsole(page, false)
  const abs = await makeScratchFile(page, name, ORIGINAL)

  // 1. The user opens the file and types, leaving UNSAVED text (a draft record,
  //    which is what survives a page reload).
  const explorer = await openFilesPanel(page)
  await nodeByName(explorer, name).click()
  await expect(editor(page)).toContainText('the original body', { timeout: 15_000 })
  await editor(page).click()
  await page.keyboard.press('End')
  await page.keyboard.type(' plus my sentence')
  await expect(page.locator('.fv-dirty-dot')).toHaveCount(1)
  // The draft store is debounced; give it its write.
  await page.waitForTimeout(1200)
  await page.screenshot({ path: `${SCREENSHOT_DIR}/1-unsaved-typing.png` })

  // 2. Someone else rewrites the file while the user is away.
  await externalWrite(page, abs, NEWER)
  expect(await onDisk(page, abs)).toContain('another writer added')

  // 3. The user comes back: the console is reloaded (the incident's trigger) with
  //    live mode ON, which is how it is left once used.
  await page.close()
  const page2 = await page.context().newPage()
  await bootConsole(page2, true)
  const explorer2 = await openFilesPanel(page2)
  await nodeByName(explorer2, name).click()
  await expect(page2.locator('.file-content-view')).toBeVisible({ timeout: 15_000 })

  // 4. Sit through every debounce that could fire a write (live write 600ms,
  //    draft 400ms, plus room for the round trip).
  await page2.waitForTimeout(6000)
  await page2.screenshot({ path: `${SCREENSHOT_DIR}/2-after-reopen.png` })

  // The assertion: the other writer's file is still there. The user's unsaved
  // sentence may be offered (banner) or held in the buffer, but it must not have
  // been written over the newer file without them asking.
  const disk = await onDisk(page2, abs)
  expect(disk, 'the newer file on disk survived the reopen').toContain('another writer added')
  expect(disk, 'the pane did not put its old copy back').not.toBe(`${ORIGINAL} plus my sentence`)
})

test('re-reading a file while the buffer holds older text does not write the older text back', async ({ page }) => {
  const name = `staleback-refresh-${Date.now()}.md`
  const ORIGINAL = `# Doc\n\nthe original body\n`
  const NEWER = `# Doc\n\n${'another writer was here\n'.repeat(120)}`

  await bootConsole(page, true)
  const abs = await makeScratchFile(page, name, ORIGINAL)

  const explorer = await openFilesPanel(page)
  await nodeByName(explorer, name).click()
  await expect(editor(page)).toContainText('the original body', { timeout: 15_000 })

  // Live mode is on, so the pane is armed to write. Change the file underneath it
  // and make it re-read (Refresh is the deterministic stand-in for the refocus /
  // reopen read in the incident, and takes the same code path).
  await externalWrite(page, abs, NEWER)
  const refresh = page.locator('.sfe-refresh-btn')
  await expect(refresh).toBeVisible()
  await refresh.click()

  await page.waitForTimeout(5000)
  await page.screenshot({ path: `${SCREENSHOT_DIR}/3-after-refresh.png` })

  const disk = await onDisk(page, abs)
  expect(disk, 'the re-read did not hand the old buffer a valid lock').toContain('another writer was here')
})

test('a write armed around a re-read never shrinks the file back', async ({ page }) => {
  // The incident's shape: an auto-write is armed (600 ms debounce) and the pane
  // re-reads the file around the same moment, moving the optimistic lock to the
  // newer bytes. Whichever order the two land in, the other writer's file must
  // still be there afterwards. (Locally the write usually wins the race and is
  // caught by an honest 409 + merge — see the file header.)
  const name = `staleback-window-${Date.now()}.md`
  const ORIGINAL = `# Doc\n\nthe original body\n`
  const NEWER = `# Doc\n\n${'a paragraph another writer added\n'.repeat(150)}`

  await bootConsole(page, true)
  const abs = await makeScratchFile(page, name, ORIGINAL)

  const writes: Array<{ bytes: number }> = []
  page.on('request', (req) => {
    if (req.method() === 'PUT' && req.url().includes('/api/file-content')) {
      writes.push({ bytes: (req.postData() ?? '').length })
    }
  })

  const explorer = await openFilesPanel(page)
  await nodeByName(explorer, name).click()
  await expect(editor(page)).toContainText('the original body', { timeout: 20_000 })

  // The other writer goes FIRST, so nothing but the click sits between the
  // keystroke and the re-read: the read (delayed 200ms above) then lands inside
  // the 600ms write debounce, which is the ordering the incident needs. Doing the
  // external write after the keystroke spends the window on its own round trip,
  // the armed write fires first, and the lock legitimately catches it (a 409 and a
  // merge) — which proves nothing about this bug.
  await externalWrite(page, abs, NEWER)
  await editor(page).click()
  await page.keyboard.press('End')
  await page.keyboard.type('!')
  await page.locator('.sfe-refresh-btn').click()

  // Sit out the debounce, the read, and any merge cycle it triggers.
  await page.waitForTimeout(6000)
  await page.screenshot({ path: `${SCREENSHOT_DIR}/4-armed-write-vs-reread.png` })

  const disk = await onDisk(page, abs)
  expect(disk, 'the other writer\'s file survived a write armed before the re-read')
    .toContain('another writer added')
  // Teeth: if nothing was ever armed the assertion above proves nothing. Either a
  // write was attempted (and had to be corrected/dropped) or the editor really did
  // hold the newer bytes — both fine — but the file must never shrink back.
  expect(disk.length, 'disk did not shrink back to the pre-read copy').toBeGreaterThan(ORIGINAL.length + 10)
  // Teeth: a write really was attempted in the window (otherwise the assertions
  // above hold trivially and the test guards nothing).
  expect(writes.length, 'the pane really did attempt a write').toBeGreaterThan(0)
})
