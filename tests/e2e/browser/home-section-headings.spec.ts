/**
 * Every status section of the home task panel draws exactly one heading with its count,
 * on every tab (All and each tier), Needs you included. 2026-10-31, the user: Needs you
 * had no heading, so its rows ran on under Watching's and read as Watching's ("make them
 * clear watching vs waiting now the need action and watching kind of mixed"). Watching
 * and Waiting also carry their own marks (an eye, an hourglass) so they never read alike.
 *
 * The check is the invariant, not a list of cases: for each section key, a section with
 * rows has one heading; a heading's count is a number at least its drawn rows.
 */
import { test, expect } from './shortcut-test-fixture'
import type { Locator, Page } from '@playwright/test'
import { isolateUiPrefs, selectSection } from './todo-panel-helpers'
import {
  endRunningTurn, presetPanelDesign, setStatusSectionOpen, showSectionCard, startRunningTurn, type StatusSectionKey,
} from './status-section-helpers'

const KEYS: StatusSectionKey[] = ['watching', 'needs', 'working', 'waiting', 'notstarted', 'done']
const TABS = ['All', 'Focus', 'Satellite'] as const

const made: string[] = []
const turns: string[] = []
test.afterEach(async ({ request }) => {
  for (const sid of turns.splice(0)) await endRunningTurn(request, sid)
  for (const id of made.splice(0)) {
    await request.delete(`/api/focus/tasks/${id}`).catch(() => {})
    await request.delete(`/api/tasks/${id}?force=true`).catch(() => {})
  }
})

async function seed(page: Page, project: string, title: string, tier: string, patch: Record<string, unknown>): Promise<string> {
  const res = await page.request.post('/api/tasks', { data: { title, source: 'local', project } })
  expect(res.ok(), await res.text()).toBe(true)
  const id = ((await res.json()) as { task: { id: string } }).task.id
  made.push(id)
  expect((await page.request.post(`/api/focus/tasks/${id}`)).ok()).toBe(true)
  expect((await page.request.put(`/api/focus/tasks/${id}/tier`, { data: { tier } })).ok()).toBe(true)
  if (Object.keys(patch).length) {
    const p = await page.request.patch(`/api/v1/tasks/${id}`, { data: patch })
    expect(p.ok(), await p.text()).toBe(true)
  }
  return id
}

/** Each key: how many headings and rows it draws, and the number its heading shows. */
async function sectionShape(panel: Locator): Promise<Record<string, { headings: number; rows: number; count: string | null; label: string }>> {
  return panel.evaluate((root, keys) => {
    const out: Record<string, { headings: number; rows: number; count: string | null; label: string }> = {}
    for (const k of keys) {
      const heads = root.querySelectorAll(`[data-testid="status-section-${k}"]`)
      out[k] = {
        headings: heads.length,
        rows: root.querySelectorAll(`[data-testid="status-section-${k}-rows"] [data-task-id]`).length,
        count: root.querySelector(`[data-testid="status-section-${k}-count"]`)?.textContent ?? null,
        label: heads[0]?.querySelector('.navigation-label')?.textContent ?? '',
      }
    }
    return out
  }, KEYS)
}

test('every section draws one heading with its count on every tab, Needs you included', async ({ page }) => {
  test.setTimeout(240_000)
  await isolateUiPrefs(page)
  await presetPanelDesign(page, 'status')
  const stamp = Date.now()
  const project = `Headings${stamp}`
  await page.goto('/')
  await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 30_000 })
  const ids: Record<string, Record<string, string>> = {}
  for (const tier of ['focus', 'satellite']) {
    ids[tier] = {
      needs: await seed(page, project, `heading needs ${tier} ${stamp}`, tier, { phase: 'NEED_ACTION' }),
      waiting: await seed(page, project, `heading parked ${tier} ${stamp}`, tier, { phase: 'WAITING', wait_until: new Date(Date.now() + 6 * 3600e3).toISOString() }),
      watching: await seed(page, project, `heading watched ${tier} ${stamp}`, tier, { phase: 'NEED_ACTION', watched_at: new Date().toISOString() }),
      done: await seed(page, project, `heading done ${tier} ${stamp}`, tier, { phase: 'COMPLETE' }),
      notstarted: await seed(page, project, `heading not started ${tier} ${stamp}`, tier, {}),
    }
  }
  ids.focus.working = await seed(page, project, `heading working focus ${stamp}`, 'focus', { phase: 'IN_PROGRESS' })
  turns.push(await startRunningTurn(page.request, ids.focus.working))
  await page.reload()
  const panel = page.locator('.todo-panel').first()

  for (const tab of TABS) {
    await selectSection(page, tab)
    const want = tab === 'All' ? [...Object.values(ids.focus), ...Object.values(ids.satellite)]
      : Object.values(ids[tab.toLowerCase()])
    await expect(panel.locator(`[data-task-id="${tab === 'Satellite' ? ids.satellite.needs : ids.focus.needs}"]`).first()).toBeVisible({ timeout: 20_000 })
    for (const k of KEYS) if (await panel.getByTestId(`status-section-${k}`).count()) await setStatusSectionOpen(panel, k, true)
    // Each seeded task is drawn under one heading of its own section.
    for (const [key, id] of Object.entries(tab === 'All' ? ids.focus : ids[tab.toLowerCase()])) {
      await showSectionCard(panel, key as StatusSectionKey, id)
      await expect(panel.locator(`[data-task-id="${id}"]`), `${tab}: ${key} drawn once`).toHaveCount(1)
    }
    expect(want.length).toBeGreaterThan(0)
    const shape = await sectionShape(panel)
    for (const k of KEYS) {
      const s = shape[k]
      if (s.rows > 0) expect(s.headings, `${tab}: ${k} has rows, so one heading`).toBe(1)
      expect(s.headings, `${tab}: ${k} draws at most one heading`).toBeLessThanOrEqual(1)
      if (s.headings) {
        expect(s.count, `${tab}: ${k} heading shows a count`).toMatch(/^\d+\+?$/)
        expect(Number.parseInt(s.count!, 10), `${tab}: ${k} count covers its drawn rows`).toBeGreaterThanOrEqual(s.rows)
      }
    }
    expect(shape.needs.label).toBe('Needs you')
    // Watching and Waiting wear different marks.
    const mark = (k: StatusSectionKey) => panel.getByTestId(`status-section-${k}`).locator('.status-section-heading-icon').innerHTML()
    expect(await mark('watching')).not.toBe(await mark('waiting'))
  }
})
