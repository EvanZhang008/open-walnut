/**
 * The phone's layers and pages beyond the home rows (spec 4.3, 4.7): task
 * detail with its phase choice and the complete confirmation (C58, C23), the
 * search layer (C76, C23), a note that reads until Edit (C79, C23), Calendar's
 * finger-sized day controls and its task list layer (C40, C23), and the 44 px
 * / 12 px / no-overflow scans of each (C18, C19, C28).
 *
 * iPhone 15 emulation, WebKit first, chromium too. First load is a `goto`; the
 * rest are taps. Task writes the test makes the page send are answered by a
 * stub, so the shared fixture task is never completed; search answers come
 * from stubs too (three groups on demand).
 */
import { bunRuntime } from '../../helpers/bun-runtime.js'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs/promises'
import net from 'node:net'
import { expect, test, type Page, type Request } from '@playwright/test'
import { isolateUiPrefs } from './todo-panel-helpers'
import {
  PHONE, backButton, expectNoHorizontalOverflow, findSmallTargets, findSmallText, menuButton, openDrawer,
} from './phone-helpers'

const SHOTS = '/tmp/mobile-web/phone-pages'
const SESSION_TASK_TITLE = 'Quarterly invoice reconciliation'
const SESSION_TASK_ID = 'mpwidref-7c2e'
const SESSION_ID = 'pw-idref-target-session'
const SIZES = [{ width: 390, height: 844 }, { width: 375, height: 667 }, { width: 320, height: 568 }]

test.use({
  viewport: PHONE.viewport,
  screen: PHONE.screen,
  deviceScaleFactor: PHONE.deviceScaleFactor,
  isMobile: true,
  hasTouch: true,
  userAgent: PHONE.userAgent,
})

test.beforeAll(async () => { await fs.mkdir(SHOTS, { recursive: true }) })

async function boot(page: Page, path = '/'): Promise<string[]> {
  await isolateUiPrefs(page)
  await page.addInitScript(() => {
    try { localStorage.setItem('open-walnut-home-chat-visible', 'false') } catch { /* storage off */ }
  })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(path)
  await expect(menuButton(page)).toBeVisible({ timeout: 30_000 })
  return errors
}

async function expandProject(page: Page, name: string): Promise<void> {
  const header = page.locator('.todo-panel .todo-group-project-header', {
    has: page.locator('.todo-group-project-name', { hasText: new RegExp(`^${name}$`) }),
  }).first()
  await expect(header).toBeVisible({ timeout: 15_000 })
  await header.scrollIntoViewIfNeeded()
  // The whole row folds on a phone (its name and chevron are pictures there).
  if (/to expand/.test((await header.getAttribute('title')) ?? '')) await header.tap({ position: { x: 48, y: 22 } })
  await expect(header).not.toHaveAttribute('title', /to expand/)
}

/** The fixture session reads as running (completing it would stop it). */
async function sessionRunning(page: Page): Promise<void> {
  await page.route('**/api/sessions/status**', async (route) => {
    const res = await route.fetch()
    const body = await res.json().catch(() => ({})) as { statuses?: Record<string, Record<string, unknown>> }
    for (const [key, snap] of Object.entries(body.statuses ?? {})) {
      if (key === SESSION_ID || snap.claudeSessionId === SESSION_ID) Object.assign(snap, { process_status: 'running', version: Number(snap.version ?? 0) + 1000 })
    }
    await route.fulfill({ response: res, json: body })
  })
}

/** Writes to the session's task are recorded and answered here, never applied. */
async function stubTaskWrites(page: Page): Promise<Request[]> {
  const writes: Request[] = []
  await page.route(`**/api/tasks/${SESSION_TASK_ID}**`, async (route) => {
    const r = route.request()
    if (r.method() === 'GET' || r.method() === 'HEAD') return route.fallback()
    writes.push(r)
    const body = JSON.parse(r.postData() || '{}') as Record<string, unknown>
    await route.fulfill({ json: { task: { id: SESSION_TASK_ID, title: SESSION_TASK_TITLE, ...body } } })
  })
  return writes
}

const markerId = (page: Page) => page.evaluate(() => (history.state as { walnutOverlay?: { id: string } } | null)?.walnutOverlay?.id ?? null)

async function scan(page: Page, root: string, label: string): Promise<void> {
  await expectNoHorizontalOverflow(page)
  const small = await findSmallTargets(page, root)
  const text = await findSmallText(page, 12, root)
  console.log(`[C18/C19 ${label}] small targets: ${JSON.stringify(small)} small text: ${JSON.stringify(text)}`)
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-${label}.png` })
  expect(small, `${label}: small targets`).toEqual([])
  expect(text, `${label}: small text`).toEqual([])
}

async function openSessionTaskDetail(page: Page): Promise<void> {
  await expandProject(page, 'Walnut')
  const row = page.locator(`.todo-panel .todo-panel-item[data-task-id="${SESSION_TASK_ID}"]`)
  // A project lists its first rows and a `Show more`.
  for (let i = 0; i < 8 && await row.count() === 0; i++) {
    const more = page.locator('.todo-panel').getByRole('button', { name: 'Show more' }).first()
    if (await more.count() === 0) break
    await more.scrollIntoViewIfNeeded()
    await more.tap()
  }
  await row.scrollIntoViewIfNeeded()
  await row.locator('.task-kebab-btn').tap()
  await page.locator('.task-kebab-menu').getByRole('button', { name: 'Details' }).tap()
  await expect(page.locator('.task-detail-modal-overlay.is-phone-layer')).toBeVisible({ timeout: 10_000 })
  await expect(page.locator('.phone-topbar-title-text')).toHaveText(SESSION_TASK_TITLE)
}

test('N25: opening an unread row and typing in its session marks it read once', async ({ page }) => {
  // The fixture task reads as unread (agent output not seen yet); its writes are recorded, not applied.
  await page.route('**/api/tasks?**', async (route) => {
    const res = await route.fetch()
    const body = await res.json().catch(() => ({})) as { tasks?: Array<Record<string, unknown>> }
    for (const t of body.tasks ?? []) if (t.id === SESSION_TASK_ID) t.unread = true
    await route.fulfill({ response: res, json: body })
  })
  const writes = await stubTaskWrites(page)
  const errors = await boot(page)
  await expandProject(page, 'Walnut')
  const row = page.locator(`.todo-panel .todo-panel-item[data-task-id="${SESSION_TASK_ID}"]`)
  for (let i = 0; i < 8 && await row.count() === 0; i++) {
    const more = page.locator('.todo-panel').getByRole('button', { name: 'Show more' }).first()
    if (await more.count() === 0) break
    await more.scrollIntoViewIfNeeded()
    await more.tap()
  }
  await row.scrollIntoViewIfNeeded()
  await row.locator('.todo-item-title').first().tap()
  const layer = page.locator('.main-page-session-column.is-mobile-active')
  await expect(layer).toBeVisible({ timeout: 15_000 })
  // The first tap into the session (the composer) is the panel's own read event.
  await layer.locator('.chat-input-textarea').tap()
  await page.waitForTimeout(1_500)
  const reads = writes.filter((r) => (JSON.parse(r.postData() || '{}') as { unread?: boolean }).unread === false)
  expect(reads.map((r) => `${r.method()} ${new URL(r.url()).pathname}`)).toEqual([`PATCH /api/tasks/${SESSION_TASK_ID}`])
  await expect(page.locator('.toast, .notification-toast').filter({ hasText: 'Action failed' })).toHaveCount(0)
  expect(errors).toEqual([])
})

test('C58: completing a task whose session runs asks first; Cancel sends nothing', async ({ page }) => {
  await sessionRunning(page)
  const writes = await stubTaskWrites(page)
  const errors = await boot(page)
  await openSessionTaskDetail(page)
  expect(await markerId(page)).toBe(`task-detail:${SESSION_TASK_ID}`)
  const phaseRow = page.getByTestId('phone-phase-row')
  await expect(phaseRow).toContainText('Phase')
  // Whatever phase the shared fixture task is in now; it must not move.
  const phaseBefore = (await phaseRow.textContent()) ?? ''
  expect(phaseBefore).not.toMatch(/Complete/)
  await phaseRow.tap()
  const options = page.getByTestId('phone-phase-sheet').getByRole('option')
  await expect(options.first()).toBeVisible()
  expect(await options.count()).toBeGreaterThanOrEqual(2)
  for (const box of await Promise.all((await options.all()).map((o) => o.boundingBox()))) expect(box!.height).toBeGreaterThanOrEqual(44)
  await page.getByTestId('phone-phase-sheet').getByRole('option', { name: 'Complete' }).tap()
  const sheet = page.getByTestId('phone-complete-confirm')
  await expect(sheet).toBeVisible()
  await expect(sheet).toContainText('Complete this task?')
  await expect(sheet).toContainText('Its running session stops.')
  // The sheet's buttons (its backdrop is a Cancel too, out of the tab order).
  const cancel = sheet.locator('.phone-confirm-sheet-btn', { hasText: /^Cancel$/ })
  const complete = sheet.locator('.phone-confirm-sheet-btn', { hasText: /^Complete$/ })
  expect((await cancel.boundingBox())!.height).toBeGreaterThanOrEqual(44)
  expect((await complete.boundingBox())!.height).toBeGreaterThanOrEqual(44)
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-c58-confirm.png` })
  await cancel.tap()
  await expect(sheet).toHaveCount(0)
  await expect(phaseRow).toHaveText(phaseBefore)
  expect(writes.length).toBe(0)

  // C23: back from the sheet closes the sheet only, then the detail.
  await phaseRow.tap()
  await page.getByTestId('phone-phase-sheet').getByRole('option', { name: 'Complete' }).tap()
  await expect(sheet).toBeVisible()
  await page.goBack()
  await expect(sheet).toHaveCount(0)
  await expect(page.locator('.task-detail-modal-overlay')).toBeVisible()
  expect(writes.length).toBe(0)

  await phaseRow.tap()
  await page.getByTestId('phone-phase-sheet').getByRole('option', { name: 'Complete' }).tap()
  await complete.tap()
  await expect.poll(() => writes.length).toBe(1)
  expect(JSON.parse(writes[0].postData() || '{}')).toMatchObject({ phase: 'COMPLETE' })
  expect(errors).toEqual([])
})

test('C23: back from task detail goes home, one layer at a time', async ({ page }) => {
  await stubTaskWrites(page)
  const errors = await boot(page)
  await openSessionTaskDetail(page)
  await page.goBack()
  await expect(page.locator('.task-detail-modal-overlay')).toHaveCount(0)
  expect(await markerId(page)).toBeNull()
  expect(new URL(page.url()).pathname).toBe('/')
  await expect(page.locator('.todo-search-input')).toBeVisible()
  expect(errors).toEqual([])
})

for (const size of SIZES) {
  test(`C18, C19, C28: task detail at ${size.width}x${size.height}`, async ({ page }) => {
    await page.setViewportSize(size)
    await stubTaskWrites(page)
    const errors = await boot(page)
    await openSessionTaskDetail(page)
    const title = page.locator('.phone-detail-title')
    expect(parseFloat(await title.evaluate((el) => getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16)
    await title.tap()
    expect(await page.evaluate(() => window.visualViewport?.scale ?? 1)).toBe(1)
    await title.evaluate((el) => (el as HTMLElement).blur())
    await scan(page, '.task-detail-modal-overlay', `detail-${size.width}`)
    expect(errors).toEqual([])
  })
}

/** Search answers: the three groups for "invoice", nothing for anything else. */
async function stubSearch(page: Page): Promise<void> {
  await page.route('**/api/search?**', async (route) => {
    const q = new URL(route.request().url()).searchParams.get('q') ?? ''
    const results = /invoice/i.test(q) ? [
      { type: 'task', title: SESSION_TASK_TITLE, snippet: 'invoice totals for the quarter', taskId: SESSION_TASK_ID, score: 0.9, matchField: 'title' },
      { type: 'session', title: 'Invoice reconciliation run', snippet: 'matched the invoice rows', taskId: SESSION_TASK_ID, sessionId: SESSION_ID, score: 0.8, matchField: 'transcript' },
    ] : []
    await route.fulfill({ json: { results } })
  })
  await page.route('**/api/notes-v2/search**', async (route) => {
    const q = new URL(route.request().url()).searchParams.get('q') ?? ''
    const results = /invoice/i.test(q) ? [{ path: 'Finance/invoice-checklist.md', title: 'Invoice checklist', snippet: 'steps for an invoice' }] : []
    await route.fulfill({ json: { results } })
  })
}

async function openSearch(page: Page): Promise<void> {
  await page.locator('.todo-search-input').tap()
  await expect(page.getByTestId('phone-search-layer')).toBeVisible()
  await expect(page.locator('.phone-search-input')).toBeFocused()
}

test('C76: the home search opens a full-screen layer with Tasks, Sessions and Notes; back walks out', async ({ page }) => {
  await stubSearch(page)
  const errors = await boot(page)
  const home = page.locator('.todo-search-input')
  await expect(home).toHaveAttribute('type', 'search')
  await expect(home).toHaveAttribute('enterkeyhint', 'search')
  await openSearch(page)
  expect(await markerId(page)).toBe('search')
  const field = page.locator('.phone-search-input')
  await expect(field).toHaveAttribute('type', 'search')
  await expect(field).toHaveAttribute('enterkeyhint', 'search')
  const cancel = page.locator('.phone-topbar').getByRole('button', { name: 'Cancel' })
  expect((await cancel.boundingBox())!.height).toBeGreaterThanOrEqual(44)
  await field.fill('invoice')
  const layer = page.getByTestId('phone-search-layer')
  for (const group of ['Tasks', 'Sessions', 'Notes']) await expect(layer.getByRole('heading', { name: group })).toBeVisible({ timeout: 10_000 })
  for (const box of await Promise.all((await layer.locator('.phone-search-row').all()).map((r) => r.boundingBox()))) {
    expect(box!.height).toBeGreaterThanOrEqual(48)
  }
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-c76-results.png` })
  await layer.getByRole('region', { name: 'Sessions' }).locator('.phone-search-row').first().tap()
  await expect(page.locator('.main-page-session-column.is-mobile-active')).toBeVisible({ timeout: 15_000 })
  await page.goBack()
  await expect(page.locator('.main-page-session-column.is-mobile-active')).toHaveCount(0)
  await expect(layer.getByRole('heading', { name: 'Sessions' })).toBeVisible()
  await page.goBack()
  await expect(layer).toHaveCount(0)
  expect(new URL(page.url()).pathname).toBe('/')
  expect(await markerId(page)).toBeNull()
  expect(errors).toEqual([])
})

test('N26: search has Cancel and no Back, and a snippet reads as plain words', async ({ page }) => {
  await page.route('**/api/search?**', (route) => route.fulfill({ json: { results: [
    { type: 'session', title: 'Invoice **reconciliation** run', snippet: '## Totals\n- <mark>invoice</mark> rows &amp; the [ledger](https://example.test/l) `matched`', taskId: SESSION_TASK_ID, sessionId: SESSION_ID, score: 0.8, matchField: 'transcript' },
  ] } }))
  await page.route('**/api/notes-v2/search**', (route) => route.fulfill({ json: { results: [] } }))
  const errors = await boot(page)
  await openSearch(page)
  const bar = page.locator('.phone-topbar')
  await expect(bar.getByRole('button', { name: 'Cancel' })).toBeVisible()
  await expect(bar.getByRole('button', { name: 'Back' })).toHaveCount(0)
  await page.locator('.phone-search-input').fill('invoice')
  const row = page.getByTestId('phone-search-layer').locator('.phone-search-row').first()
  await expect(row).toBeVisible({ timeout: 10_000 })
  await expect(row.locator('.phone-search-row-title')).toHaveText('Invoice reconciliation run')
  await expect(row.locator('.phone-search-row-snippet')).toHaveText('Totals invoice rows & the ledger matched')
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-n26-search.png` })
  await bar.getByRole('button', { name: 'Cancel' }).tap()
  await expect(page.getByTestId('phone-search-layer')).toHaveCount(0)
  expect(errors).toEqual([])
})

test('C76: no matches says so, and Cancel closes the layer through history', async ({ page }) => {
  await stubSearch(page)
  const errors = await boot(page)
  await openSearch(page)
  await page.locator('.phone-search-input').fill('zzz nothing')
  await expect(page.getByTestId('phone-search-layer').getByText('No matches.')).toBeVisible({ timeout: 10_000 })
  const before = await page.evaluate(() => history.length)
  await page.locator('.phone-topbar').getByRole('button', { name: 'Cancel' }).tap()
  await expect(page.getByTestId('phone-search-layer')).toHaveCount(0)
  expect(await markerId(page)).toBeNull()
  expect(await page.evaluate(() => history.length)).toBe(before)
  expect(errors).toEqual([])
})

for (const size of SIZES) {
  test(`C18, C19, C28: the search layer at ${size.width}x${size.height}`, async ({ page }) => {
    await page.setViewportSize(size)
    await stubSearch(page)
    const errors = await boot(page)
    await openSearch(page)
    await page.locator('.phone-search-input').fill('invoice')
    await expect(page.getByTestId('phone-search-layer').getByRole('heading', { name: 'Notes' })).toBeVisible({ timeout: 10_000 })
    expect(await page.evaluate(() => window.visualViewport?.scale ?? 1)).toBe(1)
    await scan(page, '[data-testid="phone-search-layer"]', `search-${size.width}`)
    expect(errors).toEqual([])
  })
}

const NOTE_BODY = (tag: string) => [
  `# Phone reading ${tag}`, '',
  'A paragraph to tap while reading. It should never put a caret in or raise the keyboard.', '',
  'See [the example page](https://example.com/phone-link) for more.', '',
  ...Array.from({ length: 30 }, (_, i) => `Line ${i + 1} of the long note body.`), '',
].join('\n')

async function seedNote(page: Page): Promise<string> {
  const name = `phone-read-${test.info().project.name}`
  const res = await page.request.put(`/api/notes-v2/content/${name}.md`, { data: { content: NOTE_BODY(name) } })
  expect(res.ok(), await res.text()).toBe(true)
  return name
}

/** After a drawer link: the drawer has slid fully off screen (a scan mid-slide sees it). */
async function drawerGone(page: Page): Promise<void> {
  await expect(page.locator('.sidebar.open')).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => {
    const d = document.querySelector('#primary-sidebar')
    return !d || d.getBoundingClientRect().right <= 0 || getComputedStyle(d).visibility === 'hidden'
  }), { timeout: 5_000 }).toBe(true)
}

async function openNoteFromTree(page: Page, name: string): Promise<void> {
  await openDrawer(page)
  await page.locator('#primary-sidebar').getByRole('link', { name: 'Notes' }).click()
  await expect(page).toHaveURL(/\/notes/)
  await drawerGone(page)
  const item = page.locator('.notes-tree-pane').getByText(name, { exact: true }).first()
  await expect(item).toBeVisible({ timeout: 15_000 })
  await item.tap()
  await expect(page.locator('.notes-editor-pane .ProseMirror')).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('.phone-topbar-title-text')).toHaveText(name)
}

test('C79: a note reads until Edit; a tap never raises the keyboard; Done reads again; a link opens on one tap', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __opened: string[] }
    w.__opened = []
    window.open = ((url?: string | URL) => { w.__opened.push(String(url)); return null }) as typeof window.open
  })
  const errors = await boot(page)
  const name = await seedNote(page)
  await openNoteFromTree(page, name)
  expect(await markerId(page)).toBe(`note:${name}.md`)
  // N2-29: the edit time is relative ("Edited 2m ago"), not a seconds-precise stamp.
  const updated = page.locator('.notes-editor-pane .notes-editor-updated')
  if (await updated.count()) await expect(updated.first()).toHaveText(/^Edited (just now|\d+[smhdw]+ ago|.+ ago)$/)
  const body = page.locator('.notes-editor-pane .ProseMirror')
  await expect(body).toHaveAttribute('contenteditable', 'false')
  expect(parseFloat(await body.evaluate((el) => getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16)
  const vv = await page.evaluate(() => window.visualViewport?.height ?? window.innerHeight)
  await body.getByText('A paragraph to tap while reading.').tap()
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true)
  expect(await page.locator('[contenteditable="true"]').count()).toBe(0)
  expect(await page.evaluate(() => window.visualViewport?.height ?? window.innerHeight)).toBe(vv)
  await expect(page.locator('.notes-bubble-menu, .tiptap-bubble-menu')).toHaveCount(0)

  await body.getByRole('link', { name: 'the example page' }).tap()
  await expect.poll(() => page.evaluate(() => (window as unknown as { __opened: string[] }).__opened)).toEqual(['https://example.com/phone-link'])

  const edit = page.getByTestId('phone-note-edit')
  await expect(edit).toHaveText('Edit')
  const before = await page.evaluate(() => history.length)
  await edit.tap()
  await expect(body).toHaveAttribute('contenteditable', 'true')
  await expect(body).toBeFocused()
  await expect(edit).toHaveText('Done')
  expect(await page.evaluate(() => history.length)).toBe(before)
  await edit.tap()
  await expect(body).toHaveAttribute('contenteditable', 'false')
  await expect(edit).toHaveText('Edit')
  const back = page.locator('.notes-phone-back')
  if (await back.isVisible()) {
    const b = (await back.boundingBox())!
    expect(b.width).toBeGreaterThanOrEqual(44)
    expect(b.height).toBeGreaterThanOrEqual(44)
  }
  await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-c79-note.png` })
  expect(errors).toEqual([])
})

test('C23: back from a note goes to the tree, and the tree is where it was', async ({ page }) => {
  const errors = await boot(page)
  const name = await seedNote(page)
  await openNoteFromTree(page, name)
  await page.goBack()
  await expect(page.locator('.notes-tree-pane')).toBeVisible()
  await expect(page.locator('.notes-editor-pane .ProseMirror')).toBeHidden()
  expect(await markerId(page)).toBeNull()
  await expect(page).toHaveURL(/\/notes/)
  await expect(menuButton(page)).toBeVisible()
  expect(errors).toEqual([])
})

for (const size of SIZES) {
  test(`C18, C19: Notes tree and note at ${size.width}x${size.height}`, async ({ page }) => {
    await page.setViewportSize(size)
    const errors = await boot(page)
    const name = await seedNote(page)
    await openDrawer(page)
    await page.locator('#primary-sidebar').getByRole('link', { name: 'Notes' }).click()
    await drawerGone(page)
    await expect(page.locator('.notes-tree-pane').getByText(name, { exact: true }).first()).toBeVisible({ timeout: 15_000 })
    await scan(page, '.notes-split-view', `notes-tree-${size.width}`)
    await page.locator('.notes-tree-pane').getByText(name, { exact: true }).first().tap()
    await expect(page.locator('.notes-editor-pane .ProseMirror')).toBeVisible({ timeout: 15_000 })
    await scan(page, '.notes-split-view', `notes-note-${size.width}`)
    expect(errors).toEqual([])
  })
}

async function openCalendar(page: Page): Promise<void> {
  await openDrawer(page)
  await page.locator('#primary-sidebar').getByRole('link', { name: 'Calendar' }).click()
  await expect(page.locator('.cal-page')).toBeVisible({ timeout: 15_000 })
  await drawerGone(page)
}

test('C40: Calendar day view: day controls and every event block are 44 px targets', async ({ page }) => {
  const errors = await boot(page)
  await openCalendar(page)
  await expect(page.locator('.cal-page')).toHaveAttribute('data-view', 'day')
  for (const name of ['Previous', 'Next']) {
    const b = (await page.locator('.cal-toolbar').getByRole('button', { name }).boundingBox())!
    expect(b.width, name).toBeGreaterThanOrEqual(44)
    expect(b.height, name).toBeGreaterThanOrEqual(44)
  }
  const today = (await page.locator('.cal-toolbar .cal-today-btn').boundingBox())!
  expect(today.width).toBeGreaterThanOrEqual(44)
  expect(today.height).toBeGreaterThanOrEqual(44)
  // The shortest event still takes a finger (R3-06): it is drawn as long as
  // its time, and its tap band (phone-fixes-r4.css) reaches 44 px.
  const floor = await page.evaluate(() => {
    const cols = document.querySelector('.cal-grid-cols')
    if (!cols) return null
    const probe = document.createElement('div')
    probe.className = 'cal-chip'
    probe.style.position = 'absolute'
    probe.style.top = '0px'
    probe.style.height = '10px'
    cols.appendChild(probe)
    const h = probe.getBoundingClientRect().height
    const before = getComputedStyle(probe, '::before')
    const band = h - parseFloat(before.top) - parseFloat(before.bottom)
    probe.remove()
    return { h, band }
  })
  expect(floor).not.toBeNull()
  expect(floor!.h).toBeLessThan(44)
  expect(floor!.band).toBeGreaterThanOrEqual(44)
  const title = page.locator('.cal-toolbar .cal-title')
  expect(await title.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
  expect(errors).toEqual([])
})

for (const size of SIZES) {
  test(`N27: the calendar toolbar is two lines at ${size.width}, and an empty day says so`, async ({ page }) => {
    await page.setViewportSize(size)
    // No events from any source, so a day without dated tasks is empty.
    await page.route('**/api/calendar/events?**', (route) => route.fulfill({ json: { events: [], sources: [] } }))
    const errors = await boot(page)
    await openCalendar(page)
    const bar = page.locator('.cal-toolbar')
    // Every control sits on one of two lines, never a third.
    const tops = await bar.locator('button:visible, h2').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().top))
    const lines: number[] = []
    for (const t of tops.sort((a, b) => a - b)) if (!lines.some((l) => Math.abs(l - t) < 16)) lines.push(t)
    expect(lines.length, `control lines at ${JSON.stringify(tops.map(Math.round))}`).toBeLessThanOrEqual(2)
    await expect(bar.getByRole('button', { name: 'Zoom in calendar' })).toBeHidden()
    await expect(bar.getByRole('button', { name: 'Zoom out calendar' })).toBeHidden()
    await expect(bar.locator('.cal-hours-toggle')).toBeVisible()
    const cals = bar.getByRole('button', { name: 'Calendars' })
    const cb = (await cals.boundingBox())!
    expect(Math.min(cb.width, cb.height)).toBeGreaterThanOrEqual(44)
    expect(await findSmallTargets(page, '.cal-toolbar')).toEqual([])
    // Walk forward to a day with nothing on it: the line says so; a day with a chip has no line.
    let found = false
    for (let i = 0; i < 10 && !found; i++) {
      await page.waitForTimeout(300)
      const chips = await page.locator('.cal-view .cal-chip').count()
      const line = page.getByTestId('cal-empty-day')
      if (chips === 0) {
        await expect(line).toBeVisible()
        await expect(line).toHaveText(/^Nothing scheduled (today|on [A-Z][a-z]+day, [A-Z][a-z]+ \d{1,2})\.$/)
        found = true
      } else {
        await expect(line).toHaveCount(0)
        await bar.getByRole('button', { name: 'Next' }).tap()
      }
    }
    expect(found).toBe(true)
    await expectNoHorizontalOverflow(page)
    await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-n27-calendar-${size.width}.png` })
    expect(errors).toEqual([])
  })
}

test('C23: the calendar task list is a layer that back closes', async ({ page }) => {
  const errors = await boot(page)
  await openCalendar(page)
  const calendarUrl = page.url()
  await page.locator('.cal-toolbar .cal-rail-toggle').tap()
  await expect(page.locator('.cal-body > .cal-rail')).toBeVisible()
  expect(await markerId(page)).toBe('calendar-tasks')
  await expect(page.locator('.phone-topbar-title-text')).toHaveText('Tasks')
  await page.goBack()
  await expect(page.locator('.cal-body > .cal-rail')).toHaveCount(0)
  await expect(page.locator('.cal-page')).toBeVisible()
  expect(await markerId(page)).toBeNull()
  // The bar's Back closes it through history too: it goes back over the
  // layer's own entry and pushes nothing, so no empty back is left behind.
  await page.locator('.cal-toolbar .cal-rail-toggle').tap()
  await expect(page.locator('.cal-body > .cal-rail')).toBeVisible()
  expect(await markerId(page)).toBe('calendar-tasks')
  const open = await page.evaluate(() => history.length)
  await backButton(page).tap()
  await expect(page.locator('.cal-body > .cal-rail')).toHaveCount(0)
  expect(await page.evaluate(() => history.length)).toBe(open)
  expect(await markerId(page)).toBeNull()
  expect(page.url()).toBe(calendarUrl)
  expect(errors).toEqual([])
})

for (const size of SIZES) {
  test(`C18, C19: Calendar at ${size.width}x${size.height}`, async ({ page }) => {
    await page.setViewportSize(size)
    const errors = await boot(page)
    await openCalendar(page)
    await scan(page, '.cal-page', `calendar-${size.width}`)
    expect(errors).toEqual([])
  })
}

/**
 * Mail runs on its own fixture server (tests/e2e/browser/mail-app-server.ts,
 * throwaway home, canned dense provider: two adopted accounts, no dialog).
 * Reading a canned message is the only thing done there; nothing is sent.
 */
test.describe('Mail on a phone', () => {
  test.describe.configure({ mode: 'serial' })
  let child: ChildProcessWithoutNullStreams | null = null
  let mail: { port: number; home: string } | null = null
  let output = ''

  test.beforeAll(async () => {
    test.setTimeout(300_000)
    const port = await new Promise<number>((resolve, reject) => {
      const srv = net.createServer()
      srv.once('error', reject)
      srv.listen(0, '127.0.0.1', () => {
        const a = srv.address()
        srv.close(() => (a && typeof a === 'object' ? resolve(a.port) : reject(new Error('no port'))))
      })
    })
    child = spawn(bunRuntime(), ['tests/e2e/browser/mail-app-server.ts'], {
      cwd: process.cwd(), env: { ...process.env, PW_MAIL_PORT: String(port), PW_MAIL_DENSE: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', (c) => { output = `${output}${String(c)}`.slice(-20_000) })
    child.stderr.on('data', (c) => { output = `${output}${String(c)}`.slice(-20_000) })
    const deadline = Date.now() + 240_000
    while (!mail) {
      const m = /MAIL_FIXTURE_READY (\{.*\})/.exec(output)
      if (m) mail = JSON.parse(m[1]) as { port: number; home: string }
      else if (child.exitCode !== null || Date.now() > deadline) throw new Error(`mail fixture did not start\n${output.slice(-4000)}`)
      else await new Promise((r) => setTimeout(r, 250))
    }
  })

  test.afterAll(async () => {
    if (child && child.exitCode === null) {
      child.kill('SIGTERM')
      const deadline = Date.now() + 15_000
      while (child.exitCode === null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250))
    }
    if (mail?.home.includes('walnut-mail-app-')) await fs.rm(mail.home, { recursive: true, force: true }).catch(() => undefined)
  })

  for (const size of SIZES) {
    test(`C18, C19, C40: Mail list and one message at ${size.width}x${size.height}`, async ({ page }) => {
      await page.setViewportSize(size)
      const errors: string[] = []
      page.on('pageerror', (e) => errors.push(e.message))
      await page.goto(`http://127.0.0.1:${mail!.port}/`)
      await expect(menuButton(page)).toBeVisible({ timeout: 60_000 })
      await openDrawer(page)
      await page.locator('#primary-sidebar').getByTestId('sidebar-core-app-mail').click()
      await drawerGone(page)
      const rows = page.getByTestId('mail-row')
      await expect(rows.first()).toBeVisible({ timeout: 60_000 })
      await scan(page, '[data-testid="mail-app"]', `mail-list-${size.width}`)
      await rows.first().tap()
      const body = page.locator('.mail-reader-body').first()
      await expect(body).toBeVisible({ timeout: 30_000 })
      expect(parseFloat(await body.evaluate((el) => getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16)
      await scan(page, '[data-testid="mail-app"]', `mail-message-${size.width}`)
      expect(errors).toEqual([])
    })
  }

  test('C19: an open message\'s attachment chips and blocked-images strip read at 12 px+, Load images takes a finger', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto(`http://127.0.0.1:${mail!.port}/`)
    await expect(menuButton(page)).toBeVisible({ timeout: 60_000 })
    await openDrawer(page)
    await page.locator('#primary-sidebar').getByTestId('sidebar-core-app-mail').click()
    await drawerGone(page)
    await page.getByTestId('mail-row').first().tap()
    const body = page.locator('.mail-reader-body').first()
    await expect(body).toBeVisible({ timeout: 30_000 })
    // The canned mail has neither part, so the reader's own markup for them is
    // placed in the open message and measured there (the rules are what is graded).
    const geo = await body.evaluate((el) => {
      const host = document.createElement('div')
      host.innerHTML = '<div class="mail-blocked-images"><span class="mail-blocked-text">2 remote images blocked</span>'
        + '<button type="button" class="mail-paper-btn">Load images</button></div>'
        + '<span class="mail-attachment"><span class="mail-attachment-name">Seed list.pdf</span></span>'
      el.prepend(host)
      const size = (sel: string) => parseFloat(getComputedStyle(host.querySelector(sel)!).fontSize)
      const btn = host.querySelector('.mail-paper-btn')!.getBoundingClientRect()
      const out = { text: size('.mail-blocked-text'), name: size('.mail-attachment-name'), btn: size('.mail-paper-btn'), btnH: btn.height }
      host.remove()
      return out
    })
    expect(geo.text).toBeGreaterThanOrEqual(12)
    expect(geo.name).toBeGreaterThanOrEqual(12)
    expect(geo.btn).toBeGreaterThanOrEqual(12)
    expect(geo.btnH).toBeGreaterThanOrEqual(44)
    expect(errors).toEqual([])
  })

  test('N4: one message is a history layer: Back + subject in the bar, Back returns to the list where it was', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto(`http://127.0.0.1:${mail!.port}/`)
    await expect(menuButton(page)).toBeVisible({ timeout: 60_000 })
    await openDrawer(page)
    await page.locator('#primary-sidebar').getByTestId('sidebar-core-app-mail').click()
    await drawerGone(page)
    const rows = page.getByTestId('mail-row')
    await expect(rows.first()).toBeVisible({ timeout: 60_000 })
    const listBox = page.locator('[data-testid="mail-app"] .mail-list-scroll, [data-testid="mail-app"] [data-testid="mail-list"]').first()
    const scrolled = await listBox.count() ? await listBox.evaluate((el) => { el.scrollTop = 60; return el.scrollTop }) : 0
    const target = rows.nth(1)
    const subject = ((await target.locator('.mail-row-subject-text').first().innerText().catch(() => '')) || '').trim()
    const depth = await page.evaluate(() => history.length)
    await target.tap()
    await expect(page.locator('.mail-reader-body').first()).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('.phone-topbar').getByRole('button', { name: 'Back' })).toBeVisible()
    if (subject) await expect(page.locator('.phone-topbar-title-text')).toHaveText(subject)
    // No second, in-page back row under the bar.
    await expect(page.getByTestId('mail-reader-back')).toHaveCount(0)
    expect(await page.evaluate(() => history.length)).toBe(depth + 1)
    await page.screenshot({ path: `${SHOTS}/${test.info().project.name}-n4-mail-open.png` })
    await page.goBack()
    await expect(page.locator('.mail-reader-body')).toHaveCount(0)
    await expect(rows.first()).toBeVisible()
    expect(new URL(page.url()).pathname).not.toBe('/')
    await expect(menuButton(page)).toBeVisible()
    if (scrolled > 0) expect(Math.abs((await listBox.evaluate((el) => el.scrollTop)) - scrolled)).toBeLessThanOrEqual(1)
    expect(errors).toEqual([])
  })
})
