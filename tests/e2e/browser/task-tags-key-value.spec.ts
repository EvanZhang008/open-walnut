/**
 * Tags are key:value, one system on every surface (src/core/tag-model.ts):
 *   - a key whose rule says `value` reads as its id alone on EVERY row (V, P and D ids
 *     alike, never "ticket:" on some and not others), the whole tag in its tooltip, and a
 *     hidden key never shows;
 *   - the session header shows the task's tags beside its title, by the same rules;
 *   - the detail pane edits tags: text without a key is refused with a hint, a key:value
 *     tag is added and removed, Backspace never removes a hidden tag, and the task's own
 *     dates (`created:` / `updated:`) are listed with the hidden tags, read-only;
 *   - the search box finds a task by `created:<day>`;
 *   - a key with a link rule makes its pill a link: it opens the tag's URL in a new tab, never
 *     the row (or the detail) under it.
 *
 * The rules here name keys of this spec's own (`tkt`, `tkt-id`): the chromium and webkit
 * projects share one fixture board, and a rule on a real key would change another spec's
 * pills. They are set and never removed (setting one twice is no change), so one engine's
 * cleanup cannot pull a rule out from under the other.
 */
import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import { isolateUiPrefs, presetPanelView } from './todo-panel-helpers'

const API = `http://localhost:${process.env.PW_TEST_PORT ?? 3457}`
const SHOT_DIR = '/tmp/task-tags-key-value'
const SEEDED_TASK = 'pw-task-tags'
const SEEDED_SESSION = 'pw-tags-session'

const litter: { tasks: string[]; projects: string[] } = { tasks: [], projects: [] }

async function api<T>(path: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method, headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!res.ok) throw new Error(`${method} ${path} failed: ${res.status} ${await res.text()}`)
  return res.json() as Promise<T>
}

async function createTask(title: string, opts: Record<string, unknown>): Promise<string> {
  const { task } = await api<{ task: { id: string } }>('/api/tasks', 'POST', { title, source: 'local', pinned: false, ...opts })
  litter.tasks.push(task.id)
  return task.id
}

async function storedTags(id: string): Promise<string[]> {
  const res = await api<{ task?: { tags?: string[] }; tags?: string[] }>(`/api/tasks/${id}`, 'GET')
  return (res.task ?? res).tags ?? []
}

function localDay(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso))
}

function row(page: Page, taskId: string) {
  return page.locator(`.todo-panel-item[data-task-id="${taskId}"]`)
}

/** Each chip's visible text (prefix + value, never the remove button). */
async function chipTexts(scope: ReturnType<Page['locator']>): Promise<string[]> {
  return scope.evaluateAll((els) => els.map((el) =>
    el.classList.contains('tag-chip-overflow')
      ? el.textContent ?? ''
      : [...el.querySelectorAll('.tag-chip-prefix, .tag-chip-value')].map((part) => part.textContent).join('')))
}

async function openHome(page: Page) {
  await presetPanelView(page, { section: 'all', project: '' })
  await page.addInitScript(() => { try { localStorage.setItem('walnut-todo-groupBy', 'project') } catch { /* storage off */ } })
  await page.setContent(`<a href="${test.info().project.use.baseURL}/">Open Walnut</a>`)
  await page.getByRole('link', { name: 'Open Walnut' }).click()
  await expect(page.locator('.main-page')).toBeVisible({ timeout: 30_000 })
}

const LINK_ORIGIN = 'https://tickets.example.test'

test.beforeAll(async () => {
  await api('/api/v1/tasks/meta/tag-display', 'PUT', { pattern: 'tkt:*', display: 'value' })
  await api('/api/v1/tasks/meta/tag-display', 'PUT', { pattern: 'tkt-id:*', display: 'hidden' })
  await api('/api/v1/tasks/meta/tag-display', 'PUT', { pattern: 'tkt:*', link: `${LINK_ORIGIN}/{value}` })
})

test.beforeEach(async ({ page }) => {
  litter.tasks = []; litter.projects = []
  await isolateUiPrefs(page)
})

test.afterEach(async () => {
  for (const id of litter.tasks) await fetch(`${API}/api/tasks/${id}`, { method: 'DELETE' }).catch(() => undefined)
  for (const name of litter.projects) await fetch(`${API}/api/projects/${encodeURIComponent(name)}`, { method: 'DELETE' }).catch(() => undefined)
})

test('a value key reads as its id on every row, and the session header shows the same tags', async ({ page, browserName }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const project = `Tag values ${stamp}`
  litter.projects.push(project)
  // Three id shapes (11, 10 and 9 characters): the old CSS let the prefix go only when a
  // chip was squeezed, so a short id kept "ticket:" and a long one lost it.
  const ids = {
    v: await createTask(`V ticket run ${stamp}`, { project, tags: ['tkt:V2391099522', 'tkt-id:11111111-2222-3333-4444-555555555555', 'sev:2'] }),
    p: await createTask(`P ticket run ${stamp}`, { project, tags: ['tkt:P523407866', 'sev:3'] }),
    d: await createTask(`D ticket run ${stamp}`, { project, tags: ['tkt:D12345678', 'sev:2'] }),
  }

  await openHome(page)
  for (const [id, text] of [[ids.v, 'V2391099522'], [ids.p, 'P523407866'], [ids.d, 'D12345678']] as const) {
    const chips = row(page, id).locator('[data-testid="task-tag-pills"] > .tag-chip')
    await expect(row(page, id)).toBeVisible({ timeout: 15_000 })
    expect(await chipTexts(chips)).toEqual([text, id === ids.p ? 'sev:3' : 'sev:2'])
    // No prefix element at all, whatever the width; the tooltip names the whole tag (and,
    // the key being linked, where it goes).
    await expect(chips.first().locator('.tag-chip-prefix')).toHaveCount(0)
    await expect(chips.first()).toHaveAttribute('title', `tkt:${text} (opens tickets.example.test)`)
  }
  await fs.mkdir(SHOT_DIR, { recursive: true })
  await row(page, ids.v).locator('xpath=..').screenshot({ path: `${SHOT_DIR}/${browserName}-rows.png` })

  // The seeded run's session: its header shows the tags beside the title, by the same rules
  // (the hidden id stays off; the plain word an older build stored bare reads as its word).
  await page.locator('.todo-search-input').fill(SEEDED_SESSION)
  const seeded = row(page, SEEDED_TASK)
  await expect(seeded).toBeVisible({ timeout: 15_000 })
  await seeded.locator('.todo-item-title').click()
  const panel = page.locator(`.session-panel[data-session-id="${SEEDED_SESSION}"]`)
  await expect(panel).toBeVisible()
  const headerPills = panel.locator('.session-panel-title-area > .session-panel-tag-pills > .tag-chip')
  await expect(headerPills).toHaveCount(3)
  expect(await chipTexts(headerPills)).toEqual(['V2391099522', 'sev:2', '+1'])
  await expect(headerPills.nth(2)).toHaveAttribute('title', 'oncall')
  // The row agrees with its header.
  expect(await chipTexts(seeded.locator('[data-testid="task-tag-pills"] > .tag-chip'))).toEqual(['V2391099522', 'sev:2', '+1'])
  // The title keeps the larger share of the row, and nothing leaves the header.
  const layout = await panel.locator('.session-panel-title-area').evaluate((area) => {
    const box = area.getBoundingClientRect()
    const title = area.querySelector('.session-panel-title')!.getBoundingClientRect()
    const pills = area.querySelector('.session-panel-tag-pills')!.getBoundingClientRect()
    return { title: title.width, pills: pills.width, pillsAfterTitle: pills.left >= title.right - 1, inside: pills.right <= box.right + 1 }
  })
  expect(layout.pillsAfterTitle).toBe(true)
  expect(layout.inside).toBe(true)
  expect(layout.title).toBeGreaterThan(layout.pills)
  await panel.locator('.session-panel-header').screenshot({ path: `${SHOT_DIR}/${browserName}-session-header.png` })
  expect(await storedTags(SEEDED_TASK)).toContain('label:oncall')
  expect(errors).toEqual([])
})

test('the detail pane edits key:value tags and lists the task\'s own dates as hidden', async ({ page, browserName }) => {
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const project = `Tag editor ${stamp}`
  litter.projects.push(project)
  const id = await createTask(`Edit my tags ${stamp}`, { project, tags: ['sev:2', 'tkt-id:99999999-8888-7777-6666-555555555555'] })

  await openHome(page)
  await expect(row(page, id)).toBeVisible({ timeout: 15_000 })
  await row(page, id).getByRole('button', { name: 'More actions' }).click()
  await page.locator('.task-kebab-menu').getByText('Details', { exact: true }).click()
  const detail = page.locator('.todo-detail-pane').filter({ hasText: `Edit my tags ${stamp}` })
  await expect(detail).toBeVisible()
  const editor = detail.locator('.todo-detail-badges [data-testid="tag-editor"]')
  const input = editor.getByRole('textbox', { name: 'Add a tag (key:value)' })
  const chips = editor.locator('.tag-chip')
  expect(await chipTexts(chips)).toEqual(['sev:2'])
  // The hidden id and the two dates fold behind one toggle.
  const toggle = editor.getByTestId('tag-editor-hidden-toggle')
  await expect(toggle).toHaveText('3 hidden')

  // A plain word is not a tag yet: refused with a hint naming the fix, nothing stored.
  await input.fill('oncall')
  await input.press('Enter')
  await expect(editor.getByTestId('tag-editor-problem')).toContainText('label:oncall')
  await expect(input).toHaveValue('oncall')
  expect(await storedTags(id)).toEqual(['sev:2', 'tkt-id:99999999-8888-7777-6666-555555555555'])
  // Typing again clears the hint; a key:value tag is added (its key lowercased).
  await input.fill('Team:marina')
  await expect(editor.getByTestId('tag-editor-problem')).toHaveCount(0)
  await input.press('Enter')
  await expect.poll(() => storedTags(id)).toContain('team:marina')
  await expect(input).toHaveValue('')
  // The label form a hint suggested works, and reads as its word.
  await input.fill('label:oncall')
  await input.press('Enter')
  await expect.poll(() => storedTags(id)).toContain('label:oncall')
  await expect.poll(() => chipTexts(chips)).toEqual(['sev:2', 'team:marina', 'oncall'])

  // A suggestion from the board's tags, clicked: added, and the detail stays open (the list is
  // portalled above the modal, and a click on it is not a click on the backdrop).
  await input.fill('tkt:V239')
  const suggestion = page.locator('.tag-autocomplete-portal .tag-autocomplete-item', { hasText: 'tkt:V2391099522' })
  await expect(suggestion).toBeVisible()
  await suggestion.click()
  await expect.poll(() => storedTags(id)).toContain('tkt:V2391099522')
  await expect(detail).toBeVisible()
  await expect(input).toHaveValue('')
  await editor.locator('.tag-chip[data-tag="tkt:V2391099522"] .tag-chip-remove').click()
  await expect.poll(() => storedTags(id)).not.toContain('tkt:V2391099522')

  // The hidden ones and the dates, read-only dates (no remove button).
  await toggle.click()
  const today = localDay(new Date().toISOString())
  const created = editor.locator(`.tag-chip[data-tag="created:${today}"]`)
  await expect(created).toBeVisible()
  await expect(created.locator('.tag-chip-remove')).toHaveCount(0)
  await expect(editor.locator('.tag-chip[data-tag="tkt-id:99999999-8888-7777-6666-555555555555"] .tag-chip-remove')).toHaveCount(1)
  await detail.locator('.todo-detail-meta').screenshot({ path: `${SHOT_DIR}/${browserName}-detail-editor.png` })
  await toggle.click()

  // Remove with the chip's ×, then Backspace removes the last tag the user can SEE.
  await editor.locator('.tag-chip[data-tag="team:marina"] .tag-chip-remove').click()
  await expect.poll(() => storedTags(id)).not.toContain('team:marina')
  await input.click()
  await input.press('Backspace')
  await expect.poll(() => storedTags(id)).toEqual(['sev:2', 'tkt-id:99999999-8888-7777-6666-555555555555'])
  await input.press('Backspace')
  await expect.poll(() => storedTags(id)).toEqual(['tkt-id:99999999-8888-7777-6666-555555555555'])
  // Nothing visible is left: Backspace never reaches the hidden id.
  await input.press('Backspace')
  await page.waitForTimeout(500)
  expect(await storedTags(id)).toEqual(['tkt-id:99999999-8888-7777-6666-555555555555'])
})

test('the search box finds a task by its creation day, and the API filter does too', async ({ page }) => {
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const project = `Tag dates ${stamp}`
  litter.projects.push(project)
  const id = await createTask(`Created today ${stamp}`, { project })
  const today = localDay(new Date().toISOString())

  const listed = await api<{ tasks: Array<{ id: string }> }>(`/api/v1/tasks?tag=${encodeURIComponent(`created:${today}`)}`, 'GET')
  expect(listed.tasks.map((t) => t.id)).toContain(id)
  const none = await api<{ tasks: Array<{ id: string }> }>('/api/v1/tasks?tag=created:1999-01-01', 'GET')
  expect(none.tasks).toEqual([])

  await openHome(page)
  const search = page.locator('.todo-search-input')
  await search.fill(`created:${today}`)
  await expect(row(page, id)).toBeVisible({ timeout: 15_000 })
  await search.fill('created:1999-01-01')
  await expect(row(page, id)).toHaveCount(0)
})

test('a linked tag opens its URL in a new tab, never the row or the detail under it', async ({ page, context }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  // The tracker is not reached: the new tab gets a stand-in page.
  await context.route(`${LINK_ORIGIN}/**`, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>ticket</title>ok' }))
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const project = `Tag links ${stamp}`
  litter.projects.push(project)
  const id = await createTask(`Linked ticket run ${stamp}`, { project, tags: ['tkt:V2391099522', 'sev:2'] })

  await openHome(page)
  const chip = row(page, id).locator('a.tag-chip[data-tag="tkt:V2391099522"]')
  await expect(chip).toBeVisible({ timeout: 15_000 })
  await expect(chip).toHaveAttribute('href', `${LINK_ORIGIN}/V2391099522`)
  await expect(chip).toHaveAttribute('target', '_blank')
  await expect(chip).toHaveAttribute('rel', /noopener/)
  expect(await chipTexts(chip)).toEqual(['V2391099522'])
  // sev has no link rule: an ordinary pill.
  await expect(row(page, id).locator('span.tag-chip[data-tag="sev:2"]')).toBeVisible()

  const columnsBefore = await page.locator('.main-page-session-column').count()
  const [tab] = await Promise.all([page.waitForEvent('popup'), chip.click()])
  await tab.waitForLoadState()
  expect(tab.url()).toBe(`${LINK_ORIGIN}/V2391099522`)
  await tab.close()
  // The click was the link's: no detail opened, no session column added, still on Home.
  await expect(page.locator('.todo-detail-pane')).toHaveCount(0)
  expect(await page.locator('.main-page-session-column').count()).toBe(columnsBefore)

  // In the detail's tag editor the chip links too, beside its remove button, and the detail
  // stays open.
  await row(page, id).getByRole('button', { name: 'More actions' }).click()
  await page.locator('.task-kebab-menu').getByText('Details', { exact: true }).click()
  const detail = page.locator('.todo-detail-pane').filter({ hasText: `Linked ticket run ${stamp}` })
  await expect(detail).toBeVisible()
  const editorChip = detail.locator('[data-testid="tag-editor"] .tag-chip[data-tag="tkt:V2391099522"]')
  await expect(editorChip.locator('.tag-chip-remove')).toHaveCount(1)
  const editorLink = editorChip.locator('a.tag-chip-link')
  await expect(editorLink).toHaveAttribute('href', `${LINK_ORIGIN}/V2391099522`)
  const [tab2] = await Promise.all([page.waitForEvent('popup'), editorLink.click()])
  await tab2.waitForLoadState()
  expect(tab2.url()).toBe(`${LINK_ORIGIN}/V2391099522`)
  await tab2.close()
  await expect(detail).toBeVisible()
  expect(await storedTags(id)).toEqual(['tkt:V2391099522', 'sev:2'])
  await fs.mkdir(SHOT_DIR, { recursive: true })
  await detail.locator('.todo-detail-meta').screenshot({ path: `${SHOT_DIR}/${test.info().project.name}-linked-detail.png` })
  expect(errors).toEqual([])
})

test('Settings, Tags: a key gets a link, one tag turns it off and back on, and the pills follow', async ({ page, browserName }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  // A key per engine: the chromium and webkit projects share one board.
  const key = `tkl-${browserName}`
  const origin = 'https://links.example.test'
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const project = `Tag link settings ${stamp}`
  litter.projects.push(project)
  const id = await createTask(`Link settings ${stamp}`, { project, tags: [`${key}:A-1`, `${key}:B 2`] })
  // An exact rule gives `B 2` a row of its own (the switch the user would flip first).
  await api('/api/v1/tasks/meta/tag-display', 'PUT', { pattern: `${key}:B 2`, display: 'shown' })
  try {
    await page.setContent(`<a href="${test.info().project.use.baseURL}/settings#tags">Open Tags</a>`)
    await page.getByRole('link', { name: 'Open Tags' }).click()
    const keyRow = page.locator(`[data-tag-pattern="${key}:*"]`)
    await expect(keyRow).toBeVisible({ timeout: 30_000 })
    await keyRow.scrollIntoViewIfNeeded()
    const addLink = page.getByTestId(`tag-link-edit-${key}:*`)
    await expect(addLink).toHaveText('Add link')
    await addLink.click()
    const editor = page.getByTestId(`tag-link-editor-${key}:*`)
    const input = editor.getByTestId('tag-link-input')
    await expect(input).toBeFocused()

    // Not a template: refused in place, nothing written.
    let writes = 0
    page.on('request', (req) => { if (req.method() === 'PUT' && req.url().includes('/tag-display')) writes++ })
    await input.fill('https://links.example.test/no-slot')
    await editor.getByTestId('tag-link-save').click()
    await expect(page.locator('.settings-row-error').filter({ hasText: 'with {value} where' })).toBeVisible()
    expect(writes).toBe(0)

    // A template: the preview names a real tag, Enter saves, the row says where it opens.
    await input.fill(`${origin}/browse/{value}`)
    await expect(editor.locator('.settings-row-help')).toHaveText(`${key}:A-1 opens ${origin}/browse/A-1`)
    await input.press('Enter')
    await expect(editor).toHaveCount(0)
    expect(writes).toBe(1)
    await expect(keyRow.locator('.settings-row-help')).toContainText('Opens links.example.test.')
    await expect(addLink).toHaveText('Edit link')

    // The tag with a row of its own inherits the key's link; "No link" turns it off for that tag.
    const exactRow = page.locator(`[data-tag-pattern="${key}:B 2"]`)
    await expect(exactRow.locator('.settings-row-help')).toContainText('Opens links.example.test.')
    await page.getByTestId(`tag-link-edit-${key}:B 2`).click()
    const exactEditor = page.getByTestId(`tag-link-editor-${key}:B 2`)
    await expect(exactEditor.getByTestId('tag-link-input')).toHaveValue(`${origin}/browse/{value}`)
    await expect(exactEditor.getByTestId('tag-link-clear')).toHaveText('No link')
    await exactEditor.getByTestId('tag-link-clear').click()
    await expect(exactEditor).toHaveCount(0)
    await expect(exactRow.locator('.settings-row-help')).toContainText(`No link: you turned your ${key}: link off.`)
    await expect(page.getByTestId(`tag-link-edit-${key}:B 2`)).toHaveText('Add link')
    await fs.mkdir(SHOT_DIR, { recursive: true })
    await page.locator('[data-testid="tags-settings"]').screenshot({ path: `${SHOT_DIR}/${test.info().project.name}-settings-links.png` })

    const stored = await api<{ links: Array<{ pattern: string; link: string; source: string }> }>('/api/v1/tasks/meta/tag-display', 'GET')
    expect(stored.links).toContainEqual({ pattern: `${key}:*`, link: `${origin}/browse/{value}`, source: 'user' })
    expect(stored.links).toContainEqual({ pattern: `${key}:B 2`, link: '', source: 'user' })

    // Home: A-1 opens the page (its value encoded), B 2 is an ordinary pill.
    await openHome(page)
    await expect(row(page, id).locator(`a.tag-chip[data-tag="${key}:A-1"]`)).toHaveAttribute('href', `${origin}/browse/A-1`, { timeout: 15_000 })
    await expect(row(page, id).locator(`span.tag-chip[data-tag="${key}:B 2"]`)).toBeVisible()

    // Back in Settings, "Use your … link" undoes the turn-off: B 2 links again, encoded.
    await page.setContent(`<a href="${test.info().project.use.baseURL}/settings#tags">Open Tags</a>`)
    await page.getByRole('link', { name: 'Open Tags' }).click()
    await expect(exactRow).toBeVisible({ timeout: 30_000 })
    await page.getByTestId(`tag-link-edit-${key}:B 2`).click()
    await expect(exactEditor.getByTestId('tag-link-clear')).toHaveText(`Use your ${key}: link`)
    await exactEditor.getByTestId('tag-link-clear').click()
    await expect(exactRow.locator('.settings-row-help')).toContainText('Opens links.example.test.')
    // Escape closes an editor without a write.
    await page.getByTestId(`tag-link-edit-${key}:*`).click()
    const before = writes
    await page.getByTestId(`tag-link-editor-${key}:*`).getByTestId('tag-link-input').press('Escape')
    await expect(page.getByTestId(`tag-link-editor-${key}:*`)).toHaveCount(0)
    expect(writes).toBe(before)
    await openHome(page)
    await expect(row(page, id).locator(`a.tag-chip[data-tag="${key}:B 2"]`)).toHaveAttribute('href', `${origin}/browse/B%202`, { timeout: 15_000 })
    expect(errors).toEqual([])
  } finally {
    await api('/api/v1/tasks/meta/tag-display', 'PUT', { pattern: `${key}:*`, link: null }).catch(() => undefined)
    await api('/api/v1/tasks/meta/tag-display', 'PUT', { pattern: `${key}:B 2`, link: null }).catch(() => undefined)
    await api('/api/v1/tasks/meta/tag-display', 'PUT', { pattern: `${key}:B 2`, display: null }).catch(() => undefined)
  }
})
