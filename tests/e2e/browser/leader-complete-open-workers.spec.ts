/**
 * A leader completes with its workers still open (2026-10-04 report: "I mark it
 * complete and there is no way". The leader's only worker was a recurring daily
 * job; the header ring sent PATCH phase=COMPLETE, the server answered
 * 409 active_children three times, and the ring snapped back).
 *
 * Real UI path: the session column header's ring on a leader that has open
 * workers (one waiting on the user, one not started, one with a CJK title) and
 * a finished one, on three real columns with long transcripts. Every round
 * completes the leader, checks that the workers were not touched and that no
 * request failed, then takes it back with Undo, twice over.
 */
import { test, expect, type Page, type Response } from '@playwright/test'
import fs from 'node:fs/promises'
import { homeColumns, loadHome, seedColumns, setPanelMode } from './draft-helpers'

const KEYS = ['a', 'b', 'c'] as const
type Key = (typeof KEYS)[number]
const SID = (k: Key) => `pw-rollup-${k}-session`
const TID = (k: Key) => `pw-task-rollup-${k}`
const SHOTS = '/tmp/leader-complete-open-workers'
const API = `http://localhost:${process.env.PW_TEST_PORT ?? 3457}`

const col = (page: Page, k: Key) => page.locator(`.main-page-session-column[data-column-id="${SID(k)}"]`)
const ring = (page: Page, k: Key) => col(page, k).locator('.task-quick-phase-btn')
const undo = (page: Page) => page
  .locator('.notification-toast--success', { hasText: 'Task completed' })
  .locator('.notification-toast-action', { hasText: 'Undo' })

interface TaskRow { id: string; phase: string; parent_task_id?: string; title: string }

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`)
  return (await res.json()) as T
}
const taskOf = async (id: string) => (await api<{ task: TaskRow }>('GET', `/api/tasks/${id}`)).task

const litter: string[] = []
/** The leader this run's engine owns; only it is reset (the engines share one board). */
let ownLeader = ''

// Panel count goes through Settings and the first fixture load is cold: on a
// busy machine that alone is most of the default 30s.
test.setTimeout(180_000)

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.addInitScript(() => {
    try { localStorage.setItem('open-walnut-home-chat-visible', '0') } catch { /* off */ }
  })
  await fs.mkdir(SHOTS, { recursive: true })
})

test.afterEach(async () => {
  for (const id of litter.splice(0)) await fetch(`${API}/api/tasks/${id}`, { method: 'DELETE' }).catch(() => undefined)
  if (ownLeader) await fetch(`${API}/api/tasks/${ownLeader}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phase: 'IN_PROGRESS' }),
  }).catch(() => undefined)
})

test('the header ring completes a leader whose workers are still open, round after round', async ({ page, browserName }, info) => {
  // The two engines share one fixture board: each takes its own leader column.
  const k: Key = browserName === 'webkit' ? 'c' : 'b'
  const leader = TID(k)
  ownLeader = leader
  const stamp = `${browserName}-${Date.now().toString(36)}`
  await api('PATCH', `/api/tasks/${leader}`, { phase: 'IN_PROGRESS' })
  const mk = async (title: string) => {
    const { task } = await api<{ task: TaskRow }>('POST', '/api/tasks', { title, source: 'local', project: 'Walnut', parent_task_id: leader })
    litter.push(task.id)
    return task.id
  }
  const waiting = await mk(`Daily digest worker ${stamp}`)
  await api('PATCH', `/api/tasks/${waiting}`, { phase: 'NEED_ACTION' })
  // Test data: a CJK title like the real worker's (escaped).
  const cjk = await mk(`\u6bcf\u65e5\u6458\u8981 worker ${stamp}`)
  const finished = await mk(`Finished worker ${stamp}`)
  await api('POST', `/api/tasks/${finished}/complete`)

  const failed: string[] = []
  page.on('response', (r: Response) => {
    if (r.url().includes('/api/') && r.status() >= 400) failed.push(`${r.request().method()} ${new URL(r.url()).pathname} ${r.status()}`)
  })
  const pageErrors: string[] = []
  page.on('pageerror', (e) => pageErrors.push(e.message))

  await setPanelMode(page, '3')
  await seedColumns(page, KEYS.map(SID))
  await loadHome(page)
  await expect(homeColumns(page)).toHaveCount(3, { timeout: 30_000 })
  await expect(col(page, k).getByText(`roll-up ${k} answer 45`)).toBeVisible({ timeout: 30_000 })
  // The header says this is a leader with two open workers.
  await expect(col(page, k).locator('[data-testid="leader-pill"]').first()).toHaveText('Leader · 2', { timeout: 20_000 })
  await page.screenshot({ path: `${SHOTS}/${info.project.name}-before.png` })

  for (let round = 1; round <= 2; round++) {
    const patch = page.waitForResponse((r) => r.request().method() === 'PATCH' && new URL(r.url()).pathname === `/api/tasks/${leader}`)
    await ring(page, k).click()
    const res = await patch
    expect(res.status(), `round ${round}: the server takes the completion`).toBe(200)
    await expect.poll(async () => (await taskOf(leader)).phase, { timeout: 15_000 }).toBe('COMPLETE')
    // The workers were not touched: same phase, still its workers.
    expect(await taskOf(waiting)).toMatchObject({ phase: 'NEED_ACTION', parent_task_id: leader })
    expect(await taskOf(cjk)).toMatchObject({ phase: 'TODO', parent_task_id: leader })
    expect((await taskOf(finished)).phase).toBe('COMPLETE')
    // No refusal shown; the column completes like any other (rolls up, offers Undo).
    await expect(page.locator('.notification-toast--error')).toHaveCount(0)
    await expect(undo(page)).toBeVisible({ timeout: 15_000 })
    if (round === 1) await page.screenshot({ path: `${SHOTS}/${info.project.name}-completed.png` })
    await expect(col(page, k)).toHaveCount(0, { timeout: 20_000 })

    await undo(page).click()
    await expect(col(page, k)).toHaveCount(1, { timeout: 15_000 })
    await expect.poll(async () => (await taskOf(leader)).phase, { timeout: 15_000 }).toBe('IN_PROGRESS')
    await expect(ring(page, k)).toBeEnabled()
  }
  await page.screenshot({ path: `${SHOTS}/${info.project.name}-after-undo.png` })
  expect(failed, 'no API request failed').toEqual([])
  expect(pageErrors).toEqual([])
})
