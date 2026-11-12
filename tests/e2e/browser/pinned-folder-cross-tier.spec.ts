/**
 * A collapsed folder dragged into another tier ends in that tier, and never shows
 * back in its old one.
 *
 * The drop sends one tier write per member plus a reorder in the same tick
 * (TodoPanel's whole-folder drop). The server applies writes in the order they get
 * its write lock: the tier route reads the tier registry before it locks, the
 * reorder route locks at once, so the reorder often lands first and its answer, a
 * full tier snapshot, still holds the members in their old tier. That stale
 * snapshot must not be applied: the Focus Bar takes no answer while another of its
 * writes is out, and once the last one is in it pulls the snapshot once
 * (web/src/hooks/useFocusBar.ts).
 *
 * This spec forces that order: each tier request is held in the browser for a
 * moment before it goes out, so the reorder lands first. The members' tier is
 * sampled every frame from the drop until every answer is in and the self-change
 * cooldown (3s) is over, so even a brief snap-back fails; the server must agree.
 */
import { test, expect, type Locator, type Page } from '@playwright/test'
import { isolateUiPrefs, selectProject, showAllSections } from './todo-panel-helpers'

test.use({ viewport: { width: 1280, height: 840 }, deviceScaleFactor: 1 })
test.beforeEach(async ({ page }) => { await isolateUiPrefs(page) })

/** Drag `source` onto `target` in the Home task navigation (home-navigation-drag.spec.ts's
 *  gesture): past the activation distance, scroll the target into the scroller, then
 *  follow it for a few frames until the preview settles. */
async function drag(page: Page, source: Locator, target: Locator) {
  await source.scrollIntoViewIfNeeded()
  const start = await source.boundingBox()
  if (!start) throw new Error('Drag source must be visible')
  await page.mouse.move(start.x + start.width * 0.4, start.y + start.height / 2)
  await page.mouse.down()
  await page.mouse.move(start.x + start.width * 0.4 + 12, start.y + start.height / 2 + 6, { steps: 4 })
  const scroller = page.locator('#home-task-navigation .home-navigation-scroll')
  await target.waitFor({ state: 'visible', timeout: 5_000 })
  for (let round = 0; round < 12; round++) {
    const end = await target.boundingBox(), viewport = await scroller.boundingBox()
    if (!end || !viewport) throw new Error('Drop target disappeared')
    if (end.y >= viewport.y + 20 && end.y + end.height <= viewport.y + viewport.height - 20) break
    await page.mouse.move(viewport.x + viewport.width / 2, viewport.y + viewport.height / 2)
    const before = await scroller.evaluate((el) => el.scrollTop)
    await page.mouse.wheel(0, end.y < viewport.y + 20 ? -180 : 180)
    await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).not.toBe(before)
  }
  const end = await target.boundingBox()
  if (!end) throw new Error('Drop target disappeared')
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 16 })
  for (let step = 0; step < 5; step++) {
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const current = await target.boundingBox()
    if (!current) throw new Error('Drop target disappeared during drag')
    await page.mouse.move(current.x + current.width / 2, current.y + current.height / 2, { steps: 4 })
  }
  await page.mouse.up()
}

const API = `http://localhost:${process.env.PW_TEST_PORT ?? 3457}`

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`)
  return (await res.json()) as T
}

async function createTask(title: string, project: string): Promise<string> {
  const { task } = await call<{ task: { id: string } }>('POST', '/api/tasks', {
    title: `${title} ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, project, source: 'local',
  })
  return task.id
}

async function pinInto(id: string, tier: string): Promise<void> {
  await call('POST', `/api/focus/tasks/${id}`)
  await call('PUT', `/api/focus/tasks/${id}/tier`, { tier })
}

interface Split { focus_tasks?: string[]; satellite_tasks?: string[] }

test('a collapsed folder dragged into another tier stays there when the reorder lands before the tier writes', async ({ page }) => {
  test.setTimeout(120_000)
  const proj = `FoldTier${Date.now().toString(36)}`
  const m1 = await createTask('Folder member one', proj)
  const m2 = await createTask('Folder member two', proj)
  const sat = await createTask('Satellite resident', proj)
  // A task in a custom tier means the board has tiers on purpose, so every tier keeps its
  // heading (with only Focus and Satellite in use they would sit headless under Pinned).
  const shelfResident = await createTask('Shelf resident', proj)
  const seeded = [m1, m2, sat, shelfResident]
  let gid = ''
  let shelf = ''
  try {
    ;({ tier: { id: shelf } } = await call<{ tier: { id: string } }>('POST', '/api/focus/tiers', { label: `Shelf ${proj}` }))
    ;({ group_id: gid } = await call<{ group_id: string }>('POST', '/api/tasks/groups', { task_ids: [m1, m2], label: `Seeds ${proj}` }))
    await pinInto(m1, 'focus')
    await pinInto(m2, 'focus')
    await pinInto(sat, 'satellite')
    await pinInto(shelfResident, shelf)

    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)))

    // Hold each member's tier write back so the reorder reaches the server first.
    const finished: string[] = []
    let tierRequests = 0
    await page.route('**/api/focus/tasks/*/tier', async (route) => {
      if (route.request().method() !== 'PUT') return route.continue()
      tierRequests++
      await new Promise((r) => setTimeout(r, 1200))
      await route.continue()
    })
    page.on('requestfinished', (req) => {
      const url = req.url()
      if (req.method() === 'PUT' && url.endsWith('/api/focus/reorder')) finished.push('reorder')
      else if (req.method() === 'PUT' && /\/api\/focus\/tasks\/[^/]+\/tier$/.test(url)) finished.push('tier')
    })

    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await showAllSections(page)
    await selectProject(page, proj)
    const root = page.locator('#home-task-navigation')
    const heading = (id: string) => root.locator(`[data-navigation-id="${id}"]`)
    const focusZone = root.locator('[data-drop-zone="focus-drop-zone"]')
    const satZone = root.locator('[data-drop-zone="satellite-drop-zone"]')
    const chip = focusZone.locator(`.task-group-chip[data-group-id="${gid}"]`)
    await expect(heading('satellite')).toBeVisible({ timeout: 45_000 })
    await expect(chip).toBeVisible({ timeout: 20_000 })
    await expect(focusZone.locator(`[data-task-id="${m1}"]`)).toHaveCount(1)

    // Drag the whole folder by its chip onto the Satellite heading.
    await drag(page, chip.locator('.task-group-chip-label').first(), heading('satellite'))

    // Both members are drawn in Satellite at once (the optimistic move).
    for (const id of [m1, m2]) await expect(satZone.locator(`[data-task-id="${id}"]`)).toHaveCount(1, { timeout: 5_000 })

    // From here on, sample where each member is drawn on every animation frame, in the
    // page, so a snap-back that lasts a single frame is caught.
    await page.evaluate((ids) => {
      const w = window as unknown as { __tierSamples: string[]; __tierSampling: boolean }
      w.__tierSamples = []
      w.__tierSampling = true
      const zoneOf = (id: string) => {
        const zones = [...document.querySelectorAll(`#home-task-navigation [data-task-id="${id}"]`)]
          .map((el) => (el.closest('[data-drop-zone]') as HTMLElement | null)?.dataset.dropZone ?? 'none')
        return zones.join('+') || 'missing'
      }
      const sample = () => {
        if (!w.__tierSampling) return
        w.__tierSamples.push(ids.map(zoneOf).join(','))
        requestAnimationFrame(sample)
      }
      requestAnimationFrame(sample)
    }, [m1, m2])

    // The race really happened: the reorder answered before any tier write did.
    await expect.poll(() => finished.filter((f) => f === 'tier').length, { timeout: 20_000 }).toBe(2)
    expect(tierRequests).toBe(2)
    expect(finished.indexOf('reorder'), `answer order: ${finished.join(', ')}`).toBeGreaterThanOrEqual(0)
    expect(finished.indexOf('reorder')).toBeLessThan(finished.indexOf('tier'))

    // The server agrees.
    await expect.poll(async () => {
      const split = await call<Split>('GET', '/api/focus/tasks')
      return [m1, m2].every((id) => split.satellite_tasks?.includes(id) && !split.focus_tasks?.includes(id))
    }, { timeout: 10_000 }).toBe(true)

    // Every answer is in and the cooldown is over: the folder has not snapped back,
    // in any frame since the drop.
    await page.waitForTimeout(4_000)
    for (const id of [m1, m2]) {
      await expect(satZone.locator(`[data-task-id="${id}"]`)).toHaveCount(1)
      await expect(focusZone.locator(`[data-task-id="${id}"]`)).toHaveCount(0)
    }
    const samples = await page.evaluate(() => {
      const w = window as unknown as { __tierSamples: string[]; __tierSampling: boolean }
      w.__tierSampling = false
      return w.__tierSamples
    })
    expect(samples.length, 'frames sampled while the answers came in').toBeGreaterThan(20)
    const wrong = samples.filter((line) => line !== 'satellite-drop-zone,satellite-drop-zone')
    expect(wrong, `frames where a member was not in Satellite (of ${samples.length})`).toEqual([])
    expect(errors).toEqual([])
  } finally {
    await page.unroute('**/api/focus/tasks/*/tier').catch(() => {})
    if (gid) await fetch(`${API}/api/tasks/folders/${gid}`, { method: 'DELETE' }).catch(() => {})
    for (const id of seeded) {
      await fetch(`${API}/api/focus/tasks/${id}`, { method: 'DELETE' }).catch(() => {})
      await fetch(`${API}/api/tasks/${id}`, { method: 'DELETE' }).catch(() => {})
    }
    if (shelf) await fetch(`${API}/api/focus/tiers/${shelf}`, { method: 'DELETE' }).catch(() => {})
  }
})
