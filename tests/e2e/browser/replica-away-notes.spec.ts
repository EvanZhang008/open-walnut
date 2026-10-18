/**
 * A note edited in the console through a host replica while the Mac sleeps, and the
 * same note edited on the Mac itself (docs/plan/walnut-replica-servers-impl.md
 * section 6, WP11). Fixture: replica-server.ts (a real Mac, a host daemon twin, the
 * replica it supervises, a fake tunnel); config replica.config.ts, all four
 * projects, WebKit first.
 *
 *   1. through the tunnel: sign in; the Mac made this project's note; open it
 *   2. the Mac edits one paragraph through its API and sleeps at once (before its
 *      debounced round tells the host); the console edits ANOTHER paragraph, with
 *      real typing: kept on the host, no banner
 *   3. the Mac wakes and drains: the note holds both edits, no copy, no letter
 *   4. the same again, both on ONE paragraph: on wake the console's (newer) text is
 *      the note, the Mac's version is one conflict copy beside it, one letter
 *
 * The Mac cannot answer its API while it is stopped, so its edit is made just before
 * the sleep, in the same control call. The first load of the tunnel address is a
 * `goto`; everything after it is a click or typing. Screenshots:
 * /tmp/replica-plan/replica-away-notes/<project>-<step>.png (1280 px wide at most).
 */
import fs from 'node:fs'
import path from 'node:path'
import { test, expect, type Page } from '@playwright/test'

test.setTimeout(480_000)

const PORT = Number(process.env.PW_TEST_PORT ?? 3472)
const CONTROL = `http://127.0.0.1:${PORT + 1}`
const SHOTS = path.join('/tmp/replica-plan', path.basename(import.meta.filename, '.spec.ts'))
/** WALNUT_LEADER_QUIET_MS of the fixture (tests/helpers/replica-cluster.ts WINDOWS). */
const QUIET_MS = 6_000
const MERGE_LETTER = /did not merge cleanly/

async function control<T = Record<string, any>>(method: string, p: string, body?: unknown): Promise<T> {
  const res = await fetch(CONTROL + p, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) })
  const json = await res.json() as T
  if (!res.ok) throw new Error(`control ${method} ${p}: ${res.status} ${JSON.stringify(json)}`)
  return json
}

async function shot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(SHOTS, { recursive: true })
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-${name}.png` })
}

const isPhone = () => test.info().project.name.endsWith('-phone')
const editor = (page: Page) => page.locator('.notes-editor-pane, .notes-editor').locator('.ProseMirror, .tiptap').first()
const macLetters = async () => (await control<{ letters: Array<{ subject: string }> }>('GET', '/control/mac-letters')).letters.filter((l) => MERGE_LETTER.test(l.subject)).length
const macNote = (rel: string) => control<{ content: string | null; beside: string[]; hostCopyHash: string | null }>('GET', `/control/mac-note?path=${encodeURIComponent(rel)}`)

async function navTo(page: Page, name: string): Promise<void> {
  if (isPhone()) {
    await page.getByRole('button', { name: 'Menu', exact: true }).click()
    await expect(page.locator('#primary-sidebar')).toHaveClass(/\bopen\b/)
  }
  await page.locator('#primary-sidebar').getByRole('link', { name, exact: true }).first().click()
}

async function signIn(page: Page): Promise<void> {
  await page.goto('/')
  const notice = page.getByTestId('unpaired-notice')
  await expect(notice).toBeVisible({ timeout: 120_000 })
  const before = (await control<{ count: number }>('GET', '/control/devices')).count
  const { code } = await control<{ code: string }>('GET', '/control/code')
  await page.getByTestId('unpaired-code-input').fill(code)
  await page.getByTestId('unpaired-code-submit').click()
  await expect(notice).toBeHidden({ timeout: 60_000 })
  // The device round reaches the replica before the Mac sleeps (it checks this browser's token then).
  await expect.poll(async () => (await control<{ count: number }>('GET', '/control/devices')).count, { timeout: 60_000 }).toBeGreaterThan(before)
  await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 120_000 })
}

/** Opens a note of the Acme folder from the Notes tree (a phone first leaves an open note). */
async function openNote(page: Page, rel: string, text: string): Promise<void> {
  if (isPhone()) {
    const back = page.locator('.phone-topbar').getByRole('button', { name: 'Back' })
    if (await editor(page).isVisible().catch(() => false) && await back.isVisible()) await back.click()
  }
  if (!(await page.locator('.notes-tree-panel, .notes-tree-pane').first().isVisible().catch(() => false))) await navTo(page, 'Notes')
  await expect(page.locator('.notes-tree-panel, .notes-tree-pane').first()).toBeVisible({ timeout: 30_000 })
  const folder = page.locator('.notes-tree-folder[data-node-path="Acme"]').first()
  await expect(folder).toBeVisible({ timeout: 30_000 })
  if (!((await folder.locator('.notes-tree-arrow').getAttribute('class')) ?? '').includes('expanded')) await folder.click()
  const file = page.locator(`.notes-tree-file[data-node-path="${rel}"], .notes-tree-file[data-node-path="${rel.replace(/\.md$/, '')}"]`).first()
  await expect(file).toBeVisible({ timeout: 30_000 })
  await file.click()
  await expect(editor(page)).toContainText(text, { timeout: 30_000 })
}

/**
 * Types `add` at the end of the paragraph that holds `text` (a click past its last
 * character puts the caret there in both engines), then waits for the autosave that
 * carries it to be answered 200.
 */
async function appendTo(page: Page, text: string, add: string): Promise<void> {
  // A phone opens a note read only until the bar's Edit.
  if (isPhone()) {
    const edit = page.getByTestId('phone-note-edit')
    await expect(edit).toBeVisible()
    if ((await edit.textContent())?.trim() === 'Edit') await edit.click()
    await expect(edit).toHaveText('Done')
  }
  const para = editor(page).locator('p', { hasText: text }).first()
  await expect(para).toBeVisible()
  const box = (await para.boundingBox())!
  const saved = page.waitForResponse((r) => r.request().method() === 'PUT' && r.url().includes('/api/notes-v2/content/')
    && (r.request().postData() ?? '').includes(add.trim()), { timeout: 60_000 })
  await para.click({ position: { x: box.width - 2, y: box.height / 2 } })
  await page.keyboard.type(add, { delay: 15 })
  const res = await saved
  expect(res.status(), await res.text()).toBe(200)
  await expect(page.getByTestId('notes-needs-leader-banner')).toHaveCount(0)
}

// A test that fails while the Mac sleeps must not hand the next one a sleeping Mac.
test.afterEach(async () => {
  const { asleep } = await control<{ asleep: boolean }>('GET', '/control/ready')
  if (asleep) await control('POST', '/control/wake')
  await control('POST', '/control/drain')
})

test('a note edited while the Mac sleeps merges with the Mac\'s own edit; a real conflict keeps both, one copy and one letter', async ({ page }) => {
  const project = test.info().project.name
  const name = `Away notes ${project}`
  const rel = `Acme/${name}.md`
  const seed = `# ${name}\n\nThe Mac paragraph.\n\nThe shared paragraph.\n\nThe phone paragraph.\n`
  const pageErrors: string[] = []
  page.on('pageerror', (e) => pageErrors.push(e.message))
  await control('POST', '/control/mac-note', { path: rel, content: seed })
  const lettersBefore = await macLetters()

  await test.step('1. sign in through the tunnel and open the note while the Mac answers', async () => {
    await signIn(page)
    await openNote(page, rel, 'The phone paragraph.')
    await shot(page, '1-open')
  })

  await test.step('2. the Mac edits one paragraph and sleeps; the console edits another, kept on the host', async () => {
    // Another note is open while the Mac edits: its live update must not reach this editor first.
    await openNote(page, 'Acme/Release notes.md', 'rollback drill')
    await control('POST', '/control/mac-note', { path: rel, find: 'The Mac paragraph.', replace: 'The Mac paragraph, edited on the Mac.', sleep: true })
    await expect(page.getByTestId('away-line')).toBeVisible({ timeout: QUIET_MS + 10_000 })
    // From the host's copy: the text before the Mac's edit.
    await openNote(page, rel, 'The phone paragraph.')
    await expect(editor(page)).not.toContainText('edited on the Mac')
    await appendTo(page, 'The phone paragraph.', ' Added on the phone.')
    const { records } = await control<{ records: Array<{ kind: string; acked: boolean }> }>('GET', '/control/journal')
    expect(records.filter((r) => r.kind === 'note' && !r.acked).length).toBeGreaterThan(0)
    await shot(page, '2-away-edit')
  })

  await test.step('3. the Mac wakes and drains: both edits in the note, no copy, no letter', async () => {
    await control('POST', '/control/wake')
    await control('POST', '/control/drain')
    await expect.poll(async () => (await macNote(rel)).content ?? '', { timeout: 60_000 }).toContain('Added on the phone.')
    const after = await macNote(rel)
    expect(after.content).toContain('The Mac paragraph, edited on the Mac.')
    expect(after.content).toContain('The phone paragraph. Added on the phone.')
    expect(after.beside.filter((n) => n.startsWith(`${name} (conflict`))).toEqual([])
    expect(await macLetters()).toBe(lettersBefore)
    await openNote(page, 'Acme/Release notes.md', 'rollback drill')
    await openNote(page, rel, 'The Mac paragraph, edited on the Mac.')
    await expect(editor(page)).toContainText('Added on the phone.')
    await shot(page, '3-merged')
  })

  await test.step('4. both edit the same paragraph: the console\'s newer text is the note, the Mac\'s a copy, one letter', async () => {
    await openNote(page, 'Acme/Release notes.md', 'rollback drill')
    await control('POST', '/control/mac-note', { path: rel, find: 'The shared paragraph.', replace: 'The shared paragraph. The Mac says Tuesday.', sleep: true })
    await expect(page.getByTestId('away-line')).toBeVisible({ timeout: QUIET_MS + 10_000 })
    await openNote(page, rel, 'Added on the phone.')
    await expect(editor(page)).not.toContainText('The Mac says Tuesday.')
    await appendTo(page, 'The shared paragraph.', ' The phone says Thursday.')
    await shot(page, '4-away-conflict-edit')
    await control('POST', '/control/wake')
    await control('POST', '/control/drain')
    await expect.poll(async () => (await macNote(rel)).beside.filter((n) => n.startsWith(`${name} (conflict`)).length, { timeout: 60_000 }).toBe(1)
    const after = await macNote(rel)
    expect(after.content).toContain('The shared paragraph. The phone says Thursday.')
    expect(after.content).not.toContain('The Mac says Tuesday.')
    const copyName = after.beside.find((n) => n.startsWith(`${name} (conflict`))!
    expect(copyName).toMatch(new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(conflict Mac \\d{4}-\\d{2}-\\d{2} \\d{4}\\)\\.md$`))
    const copy = await macNote(`Acme/${copyName}`)
    expect(copy.content).toContain('The shared paragraph. The Mac says Tuesday.')
    // Nothing of either side is lost: the earlier merge stays in both.
    expect(copy.content).toContain('Added on the phone.')
    await expect.poll(macLetters, { timeout: 60_000 }).toBe(lettersBefore + 1)
    await openNote(page, 'Acme/Release notes.md', 'rollback drill')
    await openNote(page, rel, 'The phone says Thursday.')
    await shot(page, '5-conflict-note')
    await openNote(page, `Acme/${copyName}`, 'The Mac says Tuesday.')
    await shot(page, '6-conflict-copy')
  })

  expect(pageErrors).toEqual([])
})
