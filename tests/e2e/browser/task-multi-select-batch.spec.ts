/**
 * Multi-select batch actions: "complete N tasks" / "delete N tasks" from the
 * Todo panel's selection bar.
 *
 * REPRO of the reported bug: entering multi-select (kebab → "Select…", then
 * clicking rows) showed a selection bar whose only verbs were Group, priority, pin
 * and date. There was NO Complete and NO Delete anywhere in the batch dropdown, so
 * a user who had picked 10 tasks could not complete or delete them: the feature
 * looked broken because the actions genuinely did not exist.
 *
 * Every interaction below is a real UI click (no page.goto navigation, no direct
 * API mutation for the action under test) so the whole chain is exercised:
 * checkbox → selection bar → batch dropdown → REST batch endpoint → WS → row state.
 */
import { test, expect, type Page } from '@playwright/test'
import { isolateUiPrefs, showEverything } from './todo-panel-helpers'
import { setShowCompleted } from './home-navigation-helpers'
import { setStatus } from './filter-bar-helpers'

const API = 'http://localhost:3457'

// Serial: every test here mutates the ONE shared fixture task list (and the Reopen
// test flips the panel's "Show completed" pref, which round-trips through
// /api/ui-prefs). Under the config's fullyParallel default, a sibling's completes/
// deletes re-render the list from under an in-flight click: a harness interference
// artifact, not a product bug. Same reason the codex-* specs run serial.
test.describe.configure({ mode: 'serial' })

// The Status filter persists in walnut-todo-filters, which ui-prefs-sync mirrors to the
// shared fixture: cut this file off from that mirror so no other spec sees our Status.
test.beforeEach(async ({ page }) => { await isolateUiPrefs(page) })

/** Seed a task via REST (setup only: never the action under test). */
async function seedTask(title: string): Promise<{ id: string; title: string }> {
  const res = await fetch(`${API}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // Off the pinned board: a REST create lands in Satellite by default (newTaskPinDefault,
    // task-manager.ts), and these rows are read in the project list.
    body: JSON.stringify({ title, project: 'Marina', pinned: false }),
  })
  if (!res.ok) throw new Error(`seed failed: ${res.status} ${await res.text()}`)
  const body = (await res.json()) as { task: { id: string; title: string } }
  return body.task
}

async function fetchTask(id: string): Promise<{ phase: string; status: string } | null> {
  const res = await fetch(`${API}/api/tasks/${id}`)
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`)
  const body = (await res.json()) as { task: { phase: string; status: string } }
  return body.task
}

function row(page: Page, title: string) {
  return page.locator('.todo-panel-item', { hasText: title }).first()
}

/** Enter multi-select via the row kebab's "Select…" entry, then pick more rows. */
async function selectRows(page: Page, titles: string[]) {
  const first = row(page, titles[0])
  await expect(first).toBeVisible({ timeout: 15_000 })
  await first.locator('.task-kebab-btn').click()
  await page.locator('.task-kebab-menu').getByText('Select…').click()
  // Select mode: a plain click on any row toggles it into the selection.
  for (const title of titles.slice(1)) {
    await row(page, title).click()
  }
  await expect(page.locator('.task-selection-bar')).toBeVisible()
  await expect(page.locator('.task-selection-count')).toHaveText(`${titles.length} selected`)
}

/** A verb button ON the selection bar (Complete / Reopen / Folder / Delete / More). */
function barBtn(page: Page, name: RegExp) {
  return page.locator('.task-selection-bar').getByRole('button', { name })
}

/** Open the overflow menu (secondary attribute setters only: pin / priority / date). */
async function openMoreMenu(page: Page) {
  await barBtn(page, /^More/).click()
  await expect(page.locator('.task-batch-dropdown')).toBeVisible()
}

async function setup(page: Page, titles: string[]) {
  const tasks = []
  for (const title of titles) tasks.push(await seedTask(title))
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await showEverything(page)
  await page.waitForTimeout(500)
  return tasks
}

test('selection bar shows Complete and Delete directly, not behind a caret', async ({ page }) => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const titles = [`Batch menu A ${stamp}`, `Batch menu B ${stamp}`]
  await setup(page, titles)

  await selectRows(page, titles)

  // The two verbs that were entirely missing before this fix, and which then spent a
  // round hidden behind a ~7px split-button caret that rendered as a bare dot. They
  // must be visible on the bar itself with no extra click.
  await expect(barBtn(page, /^Complete/)).toBeVisible()
  await expect(barBtn(page, /^Delete/)).toBeVisible()
  await expect(barBtn(page, /Folder/)).toBeVisible()

  // The overflow button carries a text label (not just a caret glyph) so it reads as
  // "opens a menu", and it holds only the secondary attribute setters.
  const more = barBtn(page, /^More/)
  await expect(more).toBeVisible()
  await expect(more).toContainText('More')
  await expect(page.locator('.task-batch-dropdown')).toHaveCount(0)
  await openMoreMenu(page)
  const menu = page.locator('.task-batch-dropdown')
  await expect(menu).toContainText('Pin to')
  await expect(menu.getByRole('button', { name: /^Complete/ })).toHaveCount(0)
  await expect(menu.getByRole('button', { name: /^Delete/ })).toHaveCount(0)
})

test('the More menu opens inside the window and its top row really applies', async ({ page }) => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const titles = [`Batch place A ${stamp}`, `Batch place B ${stamp}`]
  const tasks = await setup(page, titles)
  await selectRows(page, titles)
  await openMoreMenu(page)

  // The bar sits right under the task toolbar (y about 50): a menu that still opened
  // upward from there went off the top of the window (round 3 review). Every edge of
  // its box lies inside the viewport, and the top row is not under anything else.
  const menu = page.locator('.task-batch-dropdown')
  const box = (await menu.boundingBox())!
  const vp = page.viewportSize()!
  expect(box.y).toBeGreaterThanOrEqual(0)
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.y + box.height).toBeLessThanOrEqual(vp.height)
  expect(box.x + box.width).toBeLessThanOrEqual(vp.width)
  const top = menu.locator('.task-kebab-tier-btn').first()
  const topBox = (await top.boundingBox())!
  expect(topBox.y).toBeGreaterThanOrEqual(0)
  const tierTitle = await top.getAttribute('title')
  const hit = await page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y)
    return !!el?.closest('.task-batch-dropdown .task-kebab-tier-btn')
  }, { x: topBox.x + topBox.width / 2, y: topBox.y + topBox.height / 2 })
  expect(hit, `the top row (${tierTitle}) is the element at its own centre`).toBe(true)

  // A real click (no force): it pins every selected task and closes the menu.
  await top.click()
  await expect(menu).toHaveCount(0)
  try {
    await expect.poll(async () => {
      const res = await fetch(`${API}/api/focus/tasks`)
      const bar = (await res.json()) as Record<string, unknown>
      const all = Object.values(bar).flatMap((v) => Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v).flat() : [])
      return tasks.every((t) => all.includes(t.id))
    }, { timeout: 10_000 }).toBe(true)
  } finally {
    // Unpin what this test pinned: the fixture's focus bar is shared with other specs.
    await fetch(`${API}/api/focus/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_ids: tasks.map((t) => t.id), tier: null }),
    })
  }
})

test('Cmd/Ctrl-clicking rows one after another from the plain list: no row moves when the bar comes or goes', async ({ page }) => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const titles = [`Batch still A ${stamp}`, `Batch still B ${stamp}`, `Batch still C ${stamp}`]
  await setup(page, titles)
  const rows = titles.map((t) => row(page, t))
  await rows[1].evaluate((el) => el.scrollIntoView({ block: 'center' }))
  for (const r of rows) await expect(r).toBeInViewport()
  const middle = async (i: number) => { const b = (await rows[i]!.boundingBox())!; return b.y + b.height / 2 }
  // Aimed once, before any click, as a person aims: the second click brings the bar in under the
  // toolbar (2026-11-17, review: it pushed the list down about 44px, so the third click landed on
  // another row). The clicks go to those points, never to where the rows are found afterwards.
  const aimed = await Promise.all(rows.map(async (r) => { const b = (await r.boundingBox())!; return { x: b.x + b.width * 0.45, y: b.y + b.height / 2 } }))
  await page.keyboard.down('ControlOrMeta')
  for (const p of aimed) await page.mouse.click(p.x, p.y)
  await page.keyboard.up('ControlOrMeta')
  await expect(page.locator('.task-selection-bar')).toBeVisible()
  await expect(page.locator('.task-selection-count')).toHaveText('3 selected')
  for (const r of rows) await expect(r).toHaveClass(/task-multi-selected/)
  for (const i of [0, 1, 2]) expect(Math.abs((await middle(i)) - aimed[i]!.y), `row ${i} stayed`).toBeLessThanOrEqual(1)

  // And back: Cancel takes the bar away, and the rows stay where they are.
  await page.locator('.task-selection-clear-btn').click()
  await expect(page.locator('.task-selection-bar')).toHaveCount(0)
  for (const i of [0, 1, 2]) expect(Math.abs((await middle(i)) - aimed[i]!.y), `row ${i} stayed after Cancel`).toBeLessThanOrEqual(1)
})

test('multi-select completes every selected task', async ({ page }) => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const titles = [`Batch done A ${stamp}`, `Batch done B ${stamp}`, `Batch done C ${stamp}`]
  const tasks = await setup(page, titles)

  await selectRows(page, titles)
  await barBtn(page, /^Complete/).click()

  // Selection bar closes: the action was the user's intent, so select mode exits.
  await expect(page.locator('.task-selection-bar')).toBeHidden({ timeout: 10_000 })

  // Server truth: all three are COMPLETE.
  await expect.poll(async () => {
    const phases = await Promise.all(tasks.map(async (t) => (await fetchTask(t.id))?.phase))
    return phases.join(',')
  }, { timeout: 15_000 }).toBe('COMPLETE,COMPLETE,COMPLETE')
})

test('multi-select deletes every selected task after confirming', async ({ page }) => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const titles = [`Batch del A ${stamp}`, `Batch del B ${stamp}`, `Batch del C ${stamp}`]
  const tasks = await setup(page, titles)

  await selectRows(page, titles)
  await barBtn(page, /^Delete/).click()

  // Destructive → the app's own confirm dialog (never window.confirm).
  const dialog = page.locator('.app-modal-overlay[role="dialog"]').first()
  await expect(dialog).toBeVisible({ timeout: 10_000 })
  await expect(dialog).toContainText('3 tasks')
  await dialog.getByRole('button', { name: 'Delete' }).click()

  await expect(page.locator('.task-selection-bar')).toBeHidden({ timeout: 10_000 })

  // All three are gone server-side.
  await expect.poll(async () => {
    const results = await Promise.all(tasks.map((t) => fetchTask(t.id)))
    return results.filter(Boolean).length
  }, { timeout: 15_000 }).toBe(0)

  // And their rows are gone from the list.
  for (const title of titles) {
    await expect(page.locator('.todo-panel-item', { hasText: title })).toHaveCount(0)
  }
})

test('cancelling the delete confirm keeps every task', async ({ page }) => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const titles = [`Batch keep A ${stamp}`, `Batch keep B ${stamp}`]
  const tasks = await setup(page, titles)

  await selectRows(page, titles)
  await barBtn(page, /^Delete/).click()

  const dialog = page.locator('.app-modal-overlay[role="dialog"]').first()
  await expect(dialog).toBeVisible({ timeout: 10_000 })
  await dialog.getByRole('button', { name: /Cancel/i }).click()

  // Nothing deleted: the tasks still exist.
  for (const t of tasks) {
    expect(await fetchTask(t.id)).not.toBeNull()
  }
})

test('a done selection offers Reopen instead of Complete', async ({ page }) => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const titles = [`Batch reopen A ${stamp}`, `Batch reopen B ${stamp}`]
  const tasks = await setup(page, titles)

  // Complete them through the UI first.
  await selectRows(page, titles)
  await barBtn(page, /^Complete/).click()
  await expect.poll(async () => (await fetchTask(tasks[0].id))?.phase, { timeout: 15_000 }).toBe('COMPLETE')

  // Show done rows as list rows (Status: Completed only), re-select them, and the bar should now
  // offer Reopen. With every open status picked too, a done row keeps its place only for the
  // completion grace (GRACE_MS, 3.15 s, TodoPanel.tsx) and then joins the Completed section's
  // cards at the bottom (panel-design.ts): a slow run picked A in place and found B already gone.
  // A Status narrower than Open has no sections, so the rows stay in their project's list.
  await setStatus(page, ['Completed'])

  await selectRows(page, titles)
  await expect(barBtn(page, /^Reopen/)).toBeVisible()
  await expect(barBtn(page, /^Complete/)).toHaveCount(0)

  await barBtn(page, /^Reopen/).click()
  await expect.poll(async () => {
    const phases = await Promise.all(tasks.map(async (t) => (await fetchTask(t.id))?.phase))
    return phases.join(',')
  }, { timeout: 15_000 }).toBe('TODO,TODO')

  // Restore the default Status (isolateUiPrefs already keeps it out of other files).
  await setShowCompleted(page, false)
})
