/**
 * A run imported from outside Walnut is never Not started (2026-11-16, the user, on five imports
 * with a full result under Home's Not started: "not starrted means no sesisonc reate"), and it
 * carries its prompt's title, never the "Claude session <id>" placeholder.
 *
 * The fixture server seeds the row an older importer left (TODO, its session in the slot, the
 * placeholder title) and the transcripts of two automation runs that open with Walnut's own
 * message envelope (imported-run-fixture.ts); the mock daemon re-reads them with the real scanner.
 * The importer's own pass then moves the old row and renames it, and a new import by id lands
 * started. A task nobody started stays under Not started.
 */
import { test, expect } from './shortcut-test-fixture'
import type { APIRequestContext, Page } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { isolateUiPrefs, selectSection } from './todo-panel-helpers'
import { presetPanelDesign, setStatusSectionOpen, showSectionCard, statusSection, statusSectionRows } from './status-section-helpers'
import { NEW_RUN, NEW_TITLE, OLD_IMPORT, OLD_TITLE } from './imported-run-fixture'

const SHOT_DIR = path.join(process.env.WALNUT_TASK_DIR || '/tmp', 'shots', 'imported-run-status')
const made: string[] = []
test.afterEach(async ({ request }) => {
  for (const id of made.splice(0)) await request.delete(`/api/tasks/${id}?force=true`).catch(() => {})
})

interface Row { id: string; title: string; phase: string; session_id?: string; user_status?: { state?: string; kind?: string } }

async function task(request: APIRequestContext, id: string): Promise<Row> {
  const res = await request.get(`/api/v1/tasks/${id}`)
  expect(res.ok(), await res.text()).toBe(true)
  const body = await res.json() as { task?: Row } & Row
  return body.task ?? body
}

async function taskOfSession(request: APIRequestContext, sessionId: string): Promise<Row> {
  const res = await request.get(`/api/sessions/${sessionId}`)
  expect(res.ok(), await res.text()).toBe(true)
  const body = await res.json() as { taskId?: string; session?: { taskId?: string } }
  const taskId = body.taskId ?? body.session?.taskId
  expect(taskId, JSON.stringify(body).slice(0, 400)).toBeTruthy()
  return task(request, taskId!)
}

async function shoot(page: Page, name: string): Promise<void> {
  await fs.mkdir(SHOT_DIR, { recursive: true })
  await page.locator('.todo-panel').first().screenshot({ path: path.join(SHOT_DIR, `${name}.png`) })
}

test.describe('an imported run is never Not started', () => {
  test.describe.configure({ timeout: 180_000 })

  test('the old Not started import moves and gets its title; a new import lands started; a task nobody started stays', async ({ page }) => {
    await isolateUiPrefs(page)
    await presetPanelDesign(page, 'status')
    const stamp = Date.now()
    await page.goto('/')
    await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 30_000 })

    // The row the older importer left, before any pass of this build: its status already reads
    // what its finished session left, not Not started.
    await expect.poll(async () => {
      const us = (await task(page.request, OLD_IMPORT.taskId)).user_status
      return us ? `${us.state}/${us.kind ?? ''}` : 'underived'
    }, { timeout: 30_000 }).toBe('read/')

    // A task nobody started, as the control.
    const fresh = await page.request.post('/api/tasks', { data: { title: `never started ${stamp}`, source: 'local', project: `Seedbed${stamp}` } })
    expect(fresh.ok(), await fresh.text()).toBe(true)
    const freshId = ((await fresh.json()) as { task: { id: string } }).task.id
    made.push(freshId)

    // A new import by id (it answers once the fixture's local daemon is connected), then the
    // importer's pass (the 10-minute tick, run now).
    let byId = await page.request.post('/api/sessions/import-external', { data: { sessionIds: [NEW_RUN.sessionId] } })
    for (let i = 0; i < 30 && !byId.ok() && /not connected/.test(await byId.text()); i++) {
      await page.waitForTimeout(2_000)
      byId = await page.request.post('/api/sessions/import-external', { data: { sessionIds: [NEW_RUN.sessionId] } })
    }
    expect(byId.ok(), await byId.text()).toBe(true)
    const pass = await page.request.post('/api/sessions/import-external', { data: {} })
    expect(pass.ok(), await pass.text()).toBe(true)
    // A retry of this spec on the same server finds it imported already.
    const answer = (await byId.json()) as { imported: string[]; skipped: Array<{ sessionId: string; reason: string }> }
    expect([...answer.imported, ...answer.skipped.filter((x) => x.reason === 'already-tracked').map((x) => x.sessionId)]).toEqual([NEW_RUN.sessionId])

    const old = await task(page.request, OLD_IMPORT.taskId)
    expect(old).toMatchObject({ phase: 'NEED_ACTION', title: OLD_TITLE })
    const added = await taskOfSession(page.request, NEW_RUN.sessionId)
    made.push(added.id)
    expect(added).toMatchObject({ phase: 'NEED_ACTION', title: NEW_TITLE })
    for (const row of [old, added]) expect(row.title).not.toMatch(/^\S+ session [0-9a-f]{8}$/i)
    await expect.poll(async () => (await task(page.request, added.id)).user_status?.state, { timeout: 30_000 }).toBe('read')

    // What the user sees on Home: both imports under Needs you, with their titles; only the task
    // nobody started under Not started.
    await page.reload()
    await selectSection(page, 'All')
    const panel = page.locator('.todo-panel').first()
    await expect(statusSection(panel, 'needs')).toBeVisible({ timeout: 30_000 })
    await setStatusSectionOpen(panel, 'needs', true)
    const oldCard = await showSectionCard(panel, 'needs', OLD_IMPORT.taskId)
    await expect(oldCard).toContainText(OLD_TITLE)
    const newCard = await showSectionCard(panel, 'needs', added.id)
    await expect(newCard).toContainText(NEW_TITLE)
    await oldCard.scrollIntoViewIfNeeded()
    await shoot(page, '1-needs-you')

    await setStatusSectionOpen(panel, 'notstarted', true)
    await showSectionCard(panel, 'notstarted', freshId)
    for (const id of [OLD_IMPORT.taskId, added.id]) await expect(statusSectionRows(panel, 'notstarted').locator(`[data-task-id="${id}"]`)).toHaveCount(0)
    await statusSection(panel, 'notstarted').scrollIntoViewIfNeeded()
    await shoot(page, '2-not-started')

    // Its conversation still opens from the row: the import kept the session.
    await oldCard.click()
    await expect(page.getByText('Finding for T100', { exact: false }).first()).toBeVisible({ timeout: 30_000 })
    await page.screenshot({ path: path.join(SHOT_DIR, '3-session-open.png') })
  })
})
