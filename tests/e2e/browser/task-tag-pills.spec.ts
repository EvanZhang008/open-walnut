/**
 * A task's own tags on the Homepage: pills on the row (one, then "+N") and in the
 * detail pane. An id tag like `ticket:V1234567890` reads whole when the row has
 * room, machine tags ("walnut:…") never show as a tag, the pills never starve the
 * title or push the row's controls out, and a tag added elsewhere appears live.
 */
import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import { isolateUiPrefs, presetPanelView } from './todo-panel-helpers'

const API = `http://localhost:${process.env.PW_TEST_PORT ?? 3457}`
const IMPORT_TAG = 'walnut:external-sessions'
const SHOT_DIR = '/tmp/task-tag-pills'

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

function row(page: Page, taskId: string) {
  return page.locator(`.todo-panel-item[data-task-id="${taskId}"]`)
}

async function rowLayout(page: Page, taskId: string) {
  return row(page, taskId).locator('.todo-item-title-row').evaluate((rowEl) => {
    const r = rowEl.getBoundingClientRect()
    const title = rowEl.querySelector('.todo-item-title')!.getBoundingClientRect()
    const pills = rowEl.querySelector('[data-testid="task-tag-pills"]')!.getBoundingClientRect()
    const overflow = [...rowEl.children].some((child) => child.getBoundingClientRect().right > r.right + 1)
    return { row: r.width, title: title.width, pillsLeft: pills.left, pillsWidth: pills.width, titleRight: title.right, overflow }
  })
}

async function expectTitleFirst(page: Page, ids: string[], { titleLeads = true } = {}) {
  for (const id of ids) {
    const box = await rowLayout(page, id)
    expect(box.pillsWidth, `pills of ${id}`).toBeLessThanOrEqual(box.row * 0.34 + 1)
    expect(box.pillsLeft, `pills of ${id} sit after the title`).toBeGreaterThanOrEqual(box.titleRight - 1)
    if (titleLeads) expect(box.title, `title of ${id} keeps more than its tags`).toBeGreaterThan(box.pillsWidth)
    expect(box.overflow, `row of ${id} overflows`).toBe(false)
  }
}

async function setColumnWidth(page: Page, width: number | null) {
  await page.locator('#home-task-navigation').evaluate((el, w) => {
    (el as HTMLElement).style.width = w === null ? '' : `${w}px`
  }, width)
}

test.beforeEach(async ({ page }) => {
  litter.tasks = []; litter.projects = []
  await isolateUiPrefs(page)
})

test.afterEach(async () => {
  for (const id of litter.tasks) await fetch(`${API}/api/tasks/${id}`, { method: 'DELETE' }).catch(() => undefined)
  for (const name of litter.projects) await fetch(`${API}/api/projects/${encodeURIComponent(name)}`, { method: 'DELETE' }).catch(() => undefined)
})

test('tags show as pills on the row and in the detail pane, and follow live edits', async ({ page, browserName }) => {
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const project = `Tag pills ${stamp}`
  litter.projects.push(project)

  const ticket = await createTask(`[ALARM] canary health check SEV3 ${stamp}`, { project, tags: [IMPORT_TAG, 'ticket:V1234567890'] })
  const many = await createTask(`Three tags ${stamp}`, { project, tags: ['oncall', 'ticket:P100000001', 'marina'] })
  const plain = await createTask(`No tags ${stamp}`, { project })
  // As dense as a real imported ticket run: a long title, a date pill, the ticket.
  const longTitle = await createTask(`A long investigation title that needs most of the row to stay readable ${stamp}`, {
    project, tags: ['ticket:V2000000001'], due_date: '2030-01-15',
  })

  await presetPanelView(page, { section: 'all', project: '' })
  await page.addInitScript(() => { try { localStorage.setItem('walnut-todo-groupBy', 'project') } catch { /* storage off */ } })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await expect(row(page, ticket)).toBeVisible({ timeout: 15_000 })

  // The ticket reads whole when the row has room: prefix and id.
  const ticketPills = row(page, ticket).locator('[data-testid="task-tag-pills"] .tag-chip')
  await expect(ticketPills).toHaveCount(1)
  await expect(ticketPills.first()).toHaveText('ticket:V1234567890')
  await expect(ticketPills.first()).toHaveAttribute('title', 'ticket:V1234567890')
  // The importer's marker is a type (the Imported pill), never a tag chip.
  await expect(row(page, ticket).locator('[data-testid="imported-pill"]')).toBeVisible()
  await expect(row(page, ticket).locator('.tag-chip', { hasText: 'walnut' })).toHaveCount(0)

  // One chip on a row, then "+N" naming the rest.
  const manyPills = row(page, many).locator('[data-testid="task-tag-pills"] > .tag-chip')
  await expect(manyPills).toHaveCount(2)
  await expect(manyPills.nth(0)).toHaveText('oncall')
  await expect(manyPills.nth(1)).toHaveText('+2')
  await expect(manyPills.nth(1)).toHaveAttribute('title', 'ticket:P100000001, marina')
  await expect(row(page, plain).locator('[data-testid="task-tag-pills"]')).toHaveCount(0)

  // The pills never starve the title: they take at most a third of the row, sit
  // after the title, get less room than it, and every control stays inside the row.
  const tagged = [ticket, many, longTitle]
  await expectTitleFirst(page, tagged)

  await fs.mkdir(SHOT_DIR, { recursive: true })
  await row(page, ticket).locator('xpath=..').screenshot({ path: `${SHOT_DIR}/${browserName}-rows.png` })

  // A 300px column (the default at a 1280px window): the chip keeps the id and lets
  // the "ticket:" prefix go first, and the title still leads.
  await setColumnWidth(page, 300)
  const squeezed = row(page, longTitle).locator('[data-testid="task-tag-pills"] .tag-chip').first()
  await expect.poll(async () => squeezed.evaluate((el) => {
    const prefix = (el.querySelector('.tag-chip-prefix') as HTMLElement).getBoundingClientRect().width
    const value = (el.querySelector('.tag-chip-value') as HTMLElement).getBoundingClientRect().width
    return prefix < 12 && value > 30
  })).toBe(true)
  await expectTitleFirst(page, tagged)
  await row(page, longTitle).screenshot({ path: `${SHOT_DIR}/${browserName}-squeezed.png` })

  // Very narrow (220px): everything gives way, nothing is pushed out of the row, and
  // the chip stays a readable "V…" instead of a sliver.
  await setColumnWidth(page, 220)
  await expect.poll(async () => (await rowLayout(page, longTitle)).row).toBeLessThan(200)
  await expectTitleFirst(page, tagged, { titleLeads: false })
  for (const id of tagged) {
    const chip = row(page, id).locator('[data-testid="task-tag-pills"] .tag-chip-inline').first()
    expect(await chip.evaluate((el) => el.getBoundingClientRect().width), `chip of ${id}`).toBeGreaterThanOrEqual(29)
  }
  await row(page, longTitle).screenshot({ path: `${SHOT_DIR}/${browserName}-narrow.png` })
  await setColumnWidth(page, null)

  // A tag added elsewhere (a plugin, the agent) arrives over the socket, no reload.
  await api(`/api/tasks/${plain}`, 'PATCH', { add_tags: ['ticket:D100000002'] })
  await expect(row(page, plain).locator('[data-testid="task-tag-pills"] .tag-chip')).toHaveText('ticket:D100000002', { timeout: 10_000 })

  // The detail pane lists every tag, not only the row's first.
  await row(page, many).getByRole('button', { name: 'More actions' }).click()
  await page.locator('.task-kebab-menu').getByText('Details', { exact: true }).click()
  const detail = page.locator('.todo-detail-pane').filter({ hasText: `Three tags ${stamp}` })
  await expect(detail).toBeVisible()
  await expect(detail.locator('.todo-detail-badges [data-testid="task-tag-pills"] .tag-chip'))
    .toHaveText(['oncall', 'ticket:P100000001', 'marina'])
  await detail.locator('.todo-detail-meta').screenshot({ path: `${SHOT_DIR}/${browserName}-detail.png` })
})
