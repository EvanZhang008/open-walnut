/**
 * A save from the WYSIWYG editor changes only the line the user typed on.
 *
 * TipTap + tiptap-markdown does not round-trip Markdown byte for byte: serializing an
 * untouched doc rewrites `|---|` as `| --- |`, escapes `#` and `~`, drops a doubled
 * blank line and the final newline. A save that wrote `getMarkdown()` therefore
 * rewrote lines nobody touched. Every saving surface now goes through
 * markdownKeepingSource (web/src/components/notes/editor-keep-source.ts), which puts
 * the file's own bytes back on every line the user did not edit.
 *
 * For each surface (a vault note on /notes, the home Scratchpad, a task description
 * field, a memory file on /memory): open a document the serializer would rewrite,
 * check that an untouched open writes nothing, then type at the end of one paragraph
 * with real keys and read the bytes back from the server. They must equal the
 * original with ONLY that line changed.
 */
import { test, expect, type Locator, type Page } from '@playwright/test'
import { isolateUiPrefs, openScratchpad } from './todo-panel-helpers'

const API = `http://localhost:${process.env.PW_TEST_PORT ?? 3457}`
const SHOTS = '/tmp/markdown-save-keeps-source'

const LINE = 'Rule: a row is Proven only with a test.'
const TYPED = ' Typed by hand.'
/** Every shape the serializer rewrites: a `#` in a table cell, the `|---|`
 *  delimiter, `~` in code and in prose, a doubled blank line, the final newline. */
const FIXTURE = [
  '# Ledger',
  '',
  '| # | Problem |',
  '|---|---|',
  '| 1 | `~/.codex/config` drift |',
  '',
  LINE,
  '',
  'Budget: ~2 days per row.',
  '',
  '',
  '- one',
  '- two',
  '',
].join('\n')
/** How long an untouched editor is watched for a write. */
const IDLE_MS = 2000

// One file per surface; a failure on one surface does not skip the others.
test.describe.configure({ mode: 'default' })
test.describe.configure({ timeout: 120_000 })

/** Count the PUTs a surface sends to its save endpoint. */
function countPuts(page: Page, pathPart: string): () => number {
  let n = 0
  page.on('request', (req) => {
    if (req.method() === 'PUT' && new URL(req.url()).pathname.includes(pathPart)) n++
  })
  return () => n
}

/** Open untouched: no save goes out and the bytes stay as they were. Then type at
 *  the end of LINE and wait until the server holds exactly the original bytes with
 *  that one line changed. `original` is what the server holds after seeding (a
 *  vault note gains its `id` frontmatter on the first write). */
async function untouchedThenType(
  page: Page,
  editor: Locator,
  puts: () => number,
  read: () => Promise<string>,
  shot: string,
) {
  const original = await read()
  expect(original, 'the seed reached the server').toContain(FIXTURE)
  const expected = original.replace(LINE, LINE + TYPED)
  await expect(editor).toContainText(LINE, { timeout: 20_000 })
  await expect(editor.locator('table')).toHaveCount(1)
  await page.waitForTimeout(IDLE_MS)
  expect(puts(), 'an untouched open sends no save').toBe(0)
  expect(await read(), 'an untouched open leaves the bytes alone').toBe(original)

  await editor.locator('p', { hasText: LINE }).first().click()
  await page.keyboard.press('End')
  await page.keyboard.type(TYPED)
  await expect(editor).toContainText(LINE + TYPED)
  await expect.poll(() => puts(), { timeout: 15_000 }).toBeGreaterThan(0)
  // Exact bytes: the typed line changed, every other line is the file's own.
  await expect.poll(read, { timeout: 15_000, intervals: [250] }).toBe(expected)
  // And no later save rewrites it.
  await page.waitForTimeout(1000)
  expect(await read()).toBe(expected)
  await page.screenshot({ path: `${SHOTS}/${shot}-${test.info().project.name}.png` })
}

test('a vault note on /notes keeps its own bytes', async ({ page }) => {
  const stamp = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`
  const folder = `KeepSource${stamp}`
  const name = `Ledger ${stamp}`
  const notePath = `${folder}/${name}.md`
  const url = `${API}/api/notes-v2/content/${notePath.split('/').map(encodeURIComponent).join('/')}`
  const read = async () => {
    const res = await fetch(url)
    expect(res.ok, `GET ${notePath}: ${res.status}`).toBe(true)
    return ((await res.json()) as { content: string }).content
  }
  try {
    const put = await fetch(url, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: FIXTURE }),
    })
    expect(put.ok, `seed ${notePath}: ${put.status}`).toBe(true)

    const puts = countPuts(page, '/api/notes-v2/content/')
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await page.locator('a[href="/notes"]').first().click()
    await page.waitForLoadState('networkidle')
    const folderRow = page.locator('.notes-tree-folder', { hasText: folder })
    const file = page.locator('.notes-tree-file:not(.notes-bookmark-row)', { hasText: name })
    // Folder expansion is server-synced: a blind click can collapse an open folder.
    for (let i = 0; i < 5 && !(await file.isVisible().catch(() => false)); i++) {
      await folderRow.click().catch(() => {})
      await page.waitForTimeout(300)
    }
    await file.click()
    const editor = page.locator('.notes-editor-pane .notes-editor-content .tiptap')
    await untouchedThenType(page, editor, puts, read, 'vault-note')
  } finally {
    await fetch(`${API}/api/notes-v2/folder/${encodeURIComponent(folder)}`, { method: 'DELETE' }).catch(() => {})
  }
})

test('the home Scratchpad keeps its own bytes', async ({ page }) => {
  const read = async () => {
    const res = await fetch(`${API}/api/notes/global`)
    expect(res.ok, `GET /api/notes/global: ${res.status}`).toBe(true)
    return ((await res.json()) as { content: string }).content
  }
  const write = async (content: string) => {
    const res = await fetch(`${API}/api/notes/global`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content }),
    })
    expect(res.ok, `PUT /api/notes/global: ${res.status}`).toBe(true)
  }
  // One shared file on the fixture server: put back what was there.
  const original = await read()
  try {
    await write(FIXTURE)
    expect(await read()).toBe(FIXTURE)
    await isolateUiPrefs(page)
    const puts = countPuts(page, '/api/notes/global')
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    const editor = await openScratchpad(page)
    await untouchedThenType(page, editor, puts, read, 'scratchpad')
  } finally {
    await write(original).catch(() => {})
  }
})

test('a task description keeps its own bytes', async ({ page }) => {
  const title = `Keep source task ${Date.now()}${Math.random().toString(36).slice(2, 6)}`
  const created = await page.request.post('/api/tasks', { data: { title, source: 'local', project: 'Work', description: FIXTURE } })
  expect(created.ok(), await created.text()).toBe(true)
  const taskId = ((await created.json()) as { task: { id: string } }).task.id
  const read = async () => {
    const res = await fetch(`${API}/api/tasks/${taskId}`)
    expect(res.ok, `GET task: ${res.status}`).toBe(true)
    return ((await res.json()) as { task: { description?: string } }).task.description ?? ''
  }
  try {
    expect(await read()).toBe(FIXTURE)
    await isolateUiPrefs(page)
    const puts = countPuts(page, `/api/tasks/${taskId}/description`)
    await page.goto('/')
    await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 60_000 })
    // Typed again until the row shows: a list that hydrates late can reset the box.
    const row = page.locator(`.todo-panel-item[data-task-id="${taskId}"]:visible`).first()
    await expect(async () => {
      await page.locator('.todo-search-input').fill(title)
      await expect(row).toBeVisible({ timeout: 5_000 })
    }).toPass({ timeout: 40_000 })
    await row.getByRole('button', { name: 'More actions' }).click()
    await page.locator('.task-kebab-menu:visible').getByText('Details', { exact: true }).click()
    const modal = page.locator('.task-detail-modal')
    await expect(modal).toBeVisible()
    const editor = modal.getByTestId('task-detail-description').locator('.tiptap')
    await untouchedThenType(page, editor, puts, read, 'task-description')
  } finally {
    await page.request.delete(`/api/tasks/${taskId}?force=true`).catch(() => {})
  }
})

test('a memory file on /memory keeps its own bytes', async ({ page }) => {
  // A seeded topic file (test-server.ts): its tree label is the file name, not its
  // heading, so the fixture body does not move it. Put the original back after.
  const memPath = 'topics/search-architecture.md'
  const read = async () => {
    const res = await fetch(`${API}/api/memory/${memPath}`)
    expect(res.ok, `GET /api/memory/${memPath}: ${res.status}`).toBe(true)
    return ((await res.json()) as { memory: { content: string } }).memory.content
  }
  const write = async (content: string) => {
    const res = await fetch(`${API}/api/memory/${memPath}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content }),
    })
    expect(res.ok, `PUT /api/memory/${memPath}: ${res.status}`).toBe(true)
  }
  const original = await read()
  try {
    await write(FIXTURE)
    expect(await read()).toBe(FIXTURE)
    const puts = countPuts(page, `/api/memory/${memPath}`)
    // /settings keeps polling: wait on locators, never on networkidle.
    await page.goto('/settings')
    await expect(page.locator('.settings-nav')).toBeVisible({ timeout: 30_000 })
    await page.locator('[data-testid="settings-nav-memory"]').click()
    const tree = page.locator('.memory-tree-panel')
    await expect(tree).toBeVisible({ timeout: 15_000 })
    const item = tree.locator('.memory-tree-section', { hasText: 'Topics' })
      .locator('.memory-tree-item', { hasText: 'search-architecture' })
    await expect(item).toBeVisible({ timeout: 10_000 })
    await item.click()
    const editor = page.locator('.memory-detail-pane .notes-editor .tiptap')
    await untouchedThenType(page, editor, puts, read, 'memory-file')
  } finally {
    await write(original).catch(() => {})
  }
})
