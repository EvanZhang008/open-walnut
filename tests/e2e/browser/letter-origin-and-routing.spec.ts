/**
 * Who a letter is from, and Inbox Triage's routing rules, in the REAL UI (2026-11-05).
 *
 *  1. The inbox rail leads every letter with its origin badge (Task / Triage / Walnut / Plugin and
 *     the sender's name) before the subject, and the reader says "From <task>" with a task link.
 *     Letters are invented and seeded straight into the fixture's store; the server derives the
 *     origin on read, so this also proves a letter written before the field reads right.
 *  2. Settings > Inbox Triage > Routing rules: add a rule by picking a task, turn it off, edit it,
 *     remove it; what is on screen matches the rules file.
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { home } from './inbox-items-helpers'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const API = `http://localhost:${TEST_PORT}/api/v1`
const SHOTS = process.env.WALNUT_TASK_DIR ? path.join(process.env.WALNUT_TASK_DIR, 'shots') : '/tmp/letter-origin'
const NONCE = Date.now().toString(36)
const TASK_TITLE = `Offer review ${NONCE}`
const SUBJECTS = {
  task: `Decide on the Acme Robotics offer ${NONCE}`,
  triage: `2 new mails need you ${NONCE}`,
  walnut: `Sign in to devbox again ${NONCE}`,
  plugin: `Acme CRM sync paused ${NONCE}`,
}

let walnutHome = ''
let taskId = ''
const seeded: string[] = []

test.describe.configure({ mode: 'serial' })

function newLetterId(): string {
  return `lt-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`
}

async function seed(subject: string, type: string, sender: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<string> {
  const dir = path.join(walnutHome, 'human-inbox')
  const indexFile = path.join(dir, 'index.json')
  await fs.mkdir(path.join(dir, 'bodies'), { recursive: true })
  const id = newLetterId()
  const markdown = `## ${subject}\n\nAn invented letter for the origin spec.\n`
  await fs.writeFile(path.join(dir, 'bodies', `${id}.md`), markdown, 'utf-8')
  const store = await fs.readFile(indexFile, 'utf-8')
    .then(raw => JSON.parse(raw) as { version: 1; letters: unknown[] })
    .catch(() => ({ version: 1 as const, letters: [] as unknown[] }))
  store.letters.push({
    id, subject, type, bodyFormat: 'markdown', textPreview: 'An invented letter for the origin spec.',
    sender, createdAt: Date.now(), read: false, pinned: false, archived: false,
    bodyBytes: Buffer.byteLength(markdown), thread: [], ...extra,
  })
  await fs.writeFile(indexFile, JSON.stringify(store, null, 2), 'utf-8')
  seeded.push(id)
  return id
}

async function openInbox(page: Page) {
  await page.getByRole('button', { name: /^Notifications/ }).click()
  const panel = page.locator('.notification-panel')
  await panel.locator('.nfc-rail-btn').filter({ hasText: 'Inbox' }).click()
  await expect(panel.locator('.hib-toolbar')).toBeVisible()
  return panel
}

test.beforeAll(async () => {
  ;({ walnutHome } = await discoverBrowserFixture(TEST_PORT))
  await fs.mkdir(SHOTS, { recursive: true })
  const res = await fetch(`${API}/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: TASK_TITLE, project: 'Acme' }) })
  taskId = ((await res.json()) as { task: { id: string } }).task.id
  await seed(SUBJECTS.task, 'action_required', { sessionId: 'sess-origin-1', taskId, taskTitle: TASK_TITLE, project: 'Acme', host: 'local' },
    { actions: [{ id: 'yes', label: 'Accept' }, { id: 'no', label: 'Decline' }] })
  await seed(SUBJECTS.triage, 'review', { sessionId: 'sess-origin-2', taskId: 'task-triage-run', taskTitle: 'Triage · 09:00 · 2 items', project: 'Ask Inbox Triage', agentId: 'triage', host: 'local' })
  await seed(SUBJECTS.walnut, 'review', { sessionId: 'external', host: 'local' })
  await seed(SUBJECTS.plugin, 'info', { sessionId: 'external', host: 'local', pluginId: 'acme-crm', pluginName: 'Acme CRM' })
})

test.afterAll(async () => {
  for (const id of seeded) {
    await fetch(`${API}/human-inbox/${id}/archive`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ archived: true }) }).catch(() => {})
  }
  const rules = await fetch(`${API}/triage/routing-rules`).then(r => r.json() as Promise<{ rules: Array<{ id: string; taskId: string }> }>).catch(() => ({ rules: [] }))
  for (const r of rules.rules.filter(r => r.taskId === taskId)) await fetch(`${API}/triage/routing-rules/${r.id}`, { method: 'DELETE' }).catch(() => {})
})

test('every letter in the inbox leads with who it is from, before the subject', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  const errors: string[] = []
  page.on('pageerror', e => errors.push(e.message))
  await home(page)
  const panel = await openInbox(page)
  const want: Array<[keyof typeof SUBJECTS, string, string]> = [
    ['task', 'task', TASK_TITLE], ['triage', 'triage', 'Inbox Triage'], ['walnut', 'walnut', 'Walnut'], ['plugin', 'plugin', 'Acme CRM'],
  ]
  for (const [key, kind, name] of want) {
    const row = panel.locator('.hib-row').filter({ hasText: SUBJECTS[key] })
    await expect(row).toHaveCount(1, { timeout: 15_000 })
    const origin = row.locator('[data-testid="letter-origin"]')
    await expect(origin).toHaveAttribute('data-origin-kind', kind)
    await expect(origin.locator('.hib-origin-name')).toHaveText(name)
    // The origin is the row's first line, above the subject.
    const [o, s] = await Promise.all([origin.boundingBox(), row.locator('.hib-subject').boundingBox()])
    expect(o!.y).toBeLessThan(s!.y)
  }
  await panel.screenshot({ path: path.join(SHOTS, 'inbox-rail-origins.png') })

  await panel.locator('.hib-row').filter({ hasText: SUBJECTS.task }).locator('.hib-subject').click()
  const view = page.locator('.hib-reader .hib-view')
  await expect(view).toBeVisible()
  const from = view.locator('.hib-reader-head [data-testid="letter-origin"]')
  await expect(from).toContainText('From')
  await expect(from.locator('a.hib-origin-name')).toHaveText(TASK_TITLE)
  await expect(from.locator('a.hib-origin-name')).toHaveAttribute('data-task-id', taskId)
  await view.locator('.hib-reader-head').screenshot({ path: path.join(SHOTS, 'reader-head-origin.png') })
  expect(errors).toEqual([])
})

test('a routing rule is added, turned off, edited and removed in Settings', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await home(page)
  await page.getByRole('link', { name: /settings/i }).first().click()
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('settings-nav-triage').click()
  const group = page.getByTestId('triage-routing-rules')
  await expect(group).toBeVisible({ timeout: 15_000 })

  await group.getByTestId('triage-rule-add').click()
  const editor = group.getByTestId('triage-rule-editor')
  await editor.getByTestId('triage-rule-save').click()
  await expect(editor.getByTestId('triage-rule-error')).toHaveText('Give a sender or a subject to match.')
  await editor.getByTestId('triage-rule-from').fill('acme-robotics.example')
  // Save with the task list open: the first click counts (the list closing must not move it away).
  await editor.getByTestId('triage-rule-task-search').fill('kit')
  await editor.getByTestId('triage-rule-save').click()
  await expect(editor.getByTestId('triage-rule-error')).toHaveText('Pick the task these items go to.')
  await editor.getByTestId('triage-rule-task-search').fill(`offer ${NONCE}`)
  await editor.getByTestId('triage-rule-task-option').filter({ hasText: TASK_TITLE }).click()
  await expect(editor.getByTestId('triage-rule-task-chosen')).toContainText(TASK_TITLE)
  await editor.getByTestId('triage-rule-note').fill('Offer mail from the recruiter')
  await editor.screenshot({ path: path.join(SHOTS, 'routing-rule-editor.png') })
  await editor.getByTestId('triage-rule-save').click()

  const row = group.getByTestId('triage-rule').filter({ hasText: 'acme-robotics.example' })
  await expect(row).toHaveCount(1)
  await expect(row).toContainText(`sender contains "acme-robotics.example"`)
  await expect(row).toContainText(TASK_TITLE)
  await expect(row.getByTestId('triage-rule-provenance')).toHaveText(/^Added by you/)
  await expect(row.getByTestId('triage-rule-routed')).toHaveText('Nothing routed yet')
  await group.screenshot({ path: path.join(SHOTS, 'routing-rules-list.png') })
  const ruleId = await row.getAttribute('data-rule-id')
  const stored = async () => (await fetch(`${API}/triage/routing-rules`).then(r => r.json() as Promise<{ rules: Array<Record<string, any>> }>)).rules.find(r => r.id === ruleId)

  expect((await stored())).toMatchObject({ match: { from: 'acme-robotics.example' }, taskId, note: 'Offer mail from the recruiter', enabled: true })

  // While Inbox triage is off the list says the rules route nothing yet.
  const triageOn = (await page.locator('#inbox-triage-enabled').getAttribute('aria-checked')) === 'true'
  await expect(group.getByTestId('triage-rules-off')).toHaveCount(triageOn ? 0 : 1)

  // A pasted "Name <address>" is kept as the address, the task list opens on focus, and a rule
  // the one above already covers says it is never used.
  await group.getByTestId('triage-rule-add').click()
  const second = group.getByTestId('triage-rule-editor')
  await second.getByTestId('triage-rule-from').fill('Recruiter <hr@acme-robotics.example>')
  await expect(second.getByTestId('triage-rule-from-hint')).toContainText('Saved as hr@acme-robotics.example')
  await second.getByTestId('triage-rule-task-search').focus()
  await expect(second.getByTestId('triage-rule-task-option').first()).toBeVisible()
  await second.getByTestId('triage-rule-task-search').fill(`offer ${NONCE}`)
  await second.getByTestId('triage-rule-task-option').filter({ hasText: TASK_TITLE }).click()
  await second.getByTestId('triage-rule-save').click()
  const shadowed = group.getByTestId('triage-rule').filter({ hasText: 'sender contains "hr@acme-robotics.example"' })
  await expect(shadowed.getByTestId('triage-rule-shadowed')).toContainText('sender contains "acme-robotics.example"')
  await expect(row.first().getByTestId('triage-rule-shadowed')).toHaveCount(0)
  await group.screenshot({ path: path.join(SHOTS, 'routing-rules-shadowed.png') })
  // "Move this rule above it" puts the narrower rule first: then neither hides the other.
  await shadowed.getByTestId('triage-rule-move-up').click()
  await expect(group.getByTestId('triage-rule-shadowed')).toHaveCount(0)
  await expect(group.getByTestId('triage-rule').first()).toContainText('hr@acme-robotics.example')
  // Opening another editor drops the open one's unsaved words (as its Cancel would).
  await shadowed.getByTestId('triage-rule-edit').click()
  await group.getByTestId('triage-rule-editor').getByTestId('triage-rule-subject').fill('never saved')
  await group.getByTestId('triage-rule-add').click()
  await expect(group.getByTestId('triage-rule-editor').getByTestId('triage-rule-from')).toBeFocused()
  await group.getByTestId('triage-rule-editor').getByRole('button', { name: 'Cancel' }).click()
  await shadowed.getByTestId('triage-rule-edit').click()
  await expect(group.getByTestId('triage-rule-editor').getByTestId('triage-rule-subject')).toHaveValue('')
  await group.getByTestId('triage-rule-editor').getByRole('button', { name: 'Cancel' }).click()
  await shadowed.getByTestId('triage-rule-delete').click()
  await shadowed.getByTestId('triage-rule-delete-confirm').click()
  await expect(shadowed).toHaveCount(0)

  // Narrow (a phone): the actions go under the rule.
  await page.setViewportSize({ width: 390, height: 844 })
  const [main, actions] = await Promise.all([row.locator('.trr-rule-main').boundingBox(), row.locator('.trr-rule-actions').boundingBox()])
  expect(actions!.y).toBeGreaterThanOrEqual(main!.y + main!.height - 1)
  await page.setViewportSize({ width: 1280, height: 900 })

  await row.getByTestId('triage-rule-toggle').click()
  await expect(row.getByTestId('triage-rule-toggle')).toHaveAttribute('aria-checked', 'false')
  await expect(row).toHaveClass(/trr-rule-off/)
  expect((await stored())?.enabled).toBe(false)

  await row.getByTestId('triage-rule-edit').click()
  const edit = group.getByTestId('triage-rule-editor')
  // Change opens the picker focused; Escape puts the task back; a closed list picks nothing on Enter.
  await edit.getByTestId('triage-rule-task-change').click()
  await expect(edit.getByTestId('triage-rule-task-search')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(edit.getByTestId('triage-rule-task-chosen')).toContainText(TASK_TITLE)
  await edit.getByTestId('triage-rule-subject').fill('offer')
  await edit.getByTestId('triage-rule-save').click()
  await expect(group.getByTestId('triage-rule').filter({ hasText: 'subject contains "offer"' })).toHaveCount(1)
  expect((await stored())?.match).toEqual({ from: 'acme-robotics.example', subject: 'offer' })

  // A saved edit leaves no draft behind: another writer's newer value shows on the next Edit.
  await fetch(`${API}/triage/routing-rules/${ruleId}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ subject: 'offer letter' }) })
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  const latest = group.getByTestId('triage-rule').filter({ hasText: 'subject contains "offer letter"' })
  await expect(latest).toHaveCount(1)
  await latest.getByTestId('triage-rule-edit').click()
  await expect(group.getByTestId('triage-rule-editor').getByTestId('triage-rule-subject')).toHaveValue('offer letter')
  await group.getByTestId('triage-rule-editor').getByRole('button', { name: 'Cancel' }).click()

  const again = group.getByTestId('triage-rule').filter({ hasText: 'acme-robotics.example' })
  await again.getByTestId('triage-rule-delete').click()
  await again.getByTestId('triage-rule-delete-confirm').click()
  await expect(group.getByTestId('triage-rule').filter({ hasText: 'acme-robotics.example' })).toHaveCount(0)
  expect(await stored()).toBeUndefined()
})
