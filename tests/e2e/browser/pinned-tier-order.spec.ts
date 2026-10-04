/**
 * Playwright: a pinned tier on the home panel is drawn in exactly the order
 * `orderPinnedTier` (web/src/utils/pinned-tier-order.ts) computes, in both of its
 * view modes, and a task added from the tier's own "Add to" row lands at its FOOT.
 *
 * Why this exists: the phone's Tasks tab now runs a Swift twin of that function
 * (PinnedTierOrder.swift), pinned by a differential fixture test. That test runs the
 * FUNCTION; this one proves the panel draws what the function says (the pin order
 * the panel feeds it, the folder blocks, the project order, and that no filter or
 * fold reorders the result). Driven through the UI: the View menu picks the tier and
 * its mode, and the new task is typed into the tier's inline add row.
 *
 * All data is owned by the test: a custom tier nobody else pins into, projects named
 * with a per-run stamp, and a project order that only ADDS this run's name to the
 * shared list (and restores the list afterwards), so no other spec's tier moves.
 */
import { test, expect, type Page } from '@playwright/test'
import { isolateUiPrefs } from './todo-panel-helpers'
import { chooseViewOption, openHome } from './home-navigation-helpers'
import { orderPinnedTier } from '../../../web/src/utils/pinned-tier-order'

const API = `http://localhost:${process.env.PW_TEST_PORT ?? 3457}`
const SHOTS = process.env.PW_SHOTS_DIR ?? '/tmp/pinned-tier-order'

test.setTimeout(180_000)

const litter = { tasks: [] as string[], folders: [] as string[], tiers: [] as string[], projects: [] as string[] }
/** This run's name in the SHARED project order, removed again (and only it) afterwards. */
let listedProject: string | null = null
/** The task typed into the add row, cleaned up by title even if the test died first. */
let addRowTitle: string | null = null

test.beforeEach(async ({ page }) => {
  litter.tasks = []; litter.folders = []; litter.tiers = []; litter.projects = []
  listedProject = null
  addRowTitle = null
  await isolateUiPrefs(page)
})

test.afterEach(async () => {
  if (listedProject) {
    const name = listedProject
    const current = await fetch(`${API}/api/ordering`).then((r) => r.json() as Promise<{ projects: string[] }>).catch(() => null)
    if (current?.projects.includes(name)) {
      await fetch(`${API}/api/ordering/projects`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order: current.projects.filter((p) => p !== name) }),
      }).catch(() => undefined)
    }
  }
  if (addRowTitle) {
    const res = await fetch(`${API}/api/tasks`).catch(() => null)
    const tasks = res?.ok ? ((await res.json()) as { tasks: Array<{ id: string; title: string }> }).tasks : []
    for (const t of tasks) if (t.title === addRowTitle && !litter.tasks.includes(t.id)) litter.tasks.push(t.id)
  }
  for (const id of litter.tasks) {
    await fetch(`${API}/api/focus/tasks/${id}`, { method: 'DELETE' }).catch(() => undefined)
    await fetch(`${API}/api/tasks/${id}`, { method: 'DELETE' }).catch(() => undefined)
  }
  for (const gid of litter.folders) await fetch(`${API}/api/tasks/folders/${gid}`, { method: 'DELETE' }).catch(() => undefined)
  for (const tier of litter.tiers) await fetch(`${API}/api/focus/tiers/${tier}`, { method: 'DELETE' }).catch(() => undefined)
  for (const name of litter.projects) await fetch(`${API}/api/projects/${encodeURIComponent(name)}`, { method: 'DELETE' }).catch(() => undefined)
})

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`)
  return res.json() as Promise<T>
}

async function createTask(title: string, project: string): Promise<string> {
  const { task } = await api<{ task: { id: string } }>('POST', '/api/tasks', { title, project, source: 'local', pinned: false })
  litter.tasks.push(task.id)
  if (project && !litter.projects.includes(project)) litter.projects.push(project)
  return task.id
}

async function pinInto(id: string, tier: string): Promise<void> {
  await api('POST', `/api/focus/tasks/${id}`)
  await api('PUT', `/api/focus/tasks/${id}/tier`, { tier })
}

interface ServerTask {
  id: string; title: string; project?: string; group_id?: string
  pinned?: boolean; pin_order?: number; focus_tier?: string; status: string
}

async function serverTasks(): Promise<ServerTask[]> {
  return (await api<{ tasks: ServerTask[] }>('GET', '/api/tasks')).tasks
}

/** The tier's cards, in DOM order, as task ids. */
function drawn(page: Page, tier: string): Promise<string[]> {
  return page.locator(`[data-drop-zone="${tier}-drop-zone"] [data-task-id]`)
    .evaluateAll((els) => els
      .filter((el) => (el as HTMLElement).offsetParent !== null)
      .map((el) => (el as HTMLElement).dataset.taskId ?? ''))
}

/**
 * Keep `name` in the shared project order. Other workers (this spec under the other
 * engine, specs that drag project labels) rewrite the WHOLE list, so a name added once
 * can be dropped by a write that raced it; adding it back is what a user's order is.
 */
async function ensureListed(name: string): Promise<void> {
  const { projects } = await api<{ projects: string[] }>('GET', '/api/ordering')
  if (!projects.includes(name)) await api('PUT', '/api/ordering/projects', { order: [...projects, name] })
}

/** The tier is drawn exactly as the function computes it, from one reading of the data. */
async function expectDrawnAsComputed(page: Page, tier: string, mode: 'project' | 'custom', listed: string, expected?: string[]): Promise<string[]> {
  let want: string[] = []
  await expect(async () => {
    await ensureListed(listed)
    want = await computed(tier, mode)
    if (expected) expect(want).toEqual(expected)
    expect(await drawn(page, tier)).toEqual(want)
  }).toPass({ timeout: 30_000 })
  return want
}

/** What the function says for this tier, from the server's own data. */
async function computed(tier: string, mode: 'project' | 'custom'): Promise<string[]> {
  const { projects } = await api<{ projects: string[] }>('GET', '/api/ordering')
  const rows = (await serverTasks())
    .filter((t) => t.pinned && t.focus_tier === tier && t.status !== 'done')
    .sort((a, b) => (a.pin_order ?? 0) - (b.pin_order ?? 0))
  return orderPinnedTier(rows, mode, projects)
}

test('a pinned tier draws the order orderPinnedTier computes, By project and Custom order', async ({ page, baseURL }) => {
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
  const alder = `OrdAlder${stamp}`
  const birch = `OrdBirch${stamp}`
  const cedar = `OrdCedar${stamp}`
  const { tier } = await api<{ tier: { id: string; label: string } }>('POST', '/api/focus/tiers', { label: `Ord${stamp}` })
  litter.tiers.push(tier.id)

  const c1 = await createTask('Cedar first', cedar)
  const i1 = await createTask('Inbox first', '')
  const a1 = await createTask('Alder folder lead', alder)
  const b1 = await createTask('Birch only', birch)
  const a2 = await createTask('Alder loose', alder)
  const a3 = await createTask('Alder folder second', alder)
  const i2 = await createTask('Inbox second \u679c\u56ed', '')
  const { group_id: folder } = await api<{ group_id: string }>('POST', '/api/tasks/groups', { task_ids: [a1, a3], label: `Seeds ${stamp}` })
  litter.folders.push(folder)
  // Pin order = the order of these calls (each pin takes the highest pin_order).
  for (const id of [c1, i1, a1, b1, a2, a3, i2]) await pinInto(id, tier.id)
  // Birch is LISTED in the hand-arranged project order, so it leads.
  listedProject = birch
  await ensureListed(birch)

  await openHome(page, baseURL!)
  await chooseViewOption(page, tier.id)
  const zone = page.locator(`[data-drop-zone="${tier.id}-drop-zone"]`)
  await expect(zone).toBeVisible({ timeout: 20_000 })

  // By project: Birch (listed) first, then the rest where their first row appears
  // (Cedar, Inbox, Alder); inside Alder its loose row, then the folder block.
  await chooseViewOption(page, 'tier-project')
  const byProject = [b1, c1, i1, i2, a2, a1, a3]
  await expectDrawnAsComputed(page, tier.id, 'project', birch, byProject)
  await expect.poll(async () => {
    await ensureListed(birch)
    return zone.locator('.tier-project-label')
      .evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.project ?? ''))
  }, { timeout: 30_000 }).toEqual([birch, cedar, '', alder])
  await page.screenshot({ path: `${SHOTS}/web-tier-by-project.png` })

  // Custom order: pin order, the folder's rows gathered at its first member.
  await chooseViewOption(page, 'tier-custom')
  const custom = [c1, i1, a1, a3, b1, a2, i2]
  await expectDrawnAsComputed(page, tier.id, 'custom', birch, custom)
  await page.screenshot({ path: `${SHOTS}/web-tier-custom.png` })

  // A task typed into the tier's own "Add to" row takes the highest pin_order: the
  // FOOT of the tier in Custom order, and the foot of its project's run By project.
  const title = `Fresh from the add row ${stamp}`
  addRowTitle = title
  // The add row is the drop zone's sibling, at the foot of the tier's list.
  const list = zone.locator('xpath=..')
  await list.locator(`.focus-inline-add-trigger[title="Add to ${tier.label}\u2026"]`).click()
  const input = list.locator('.focus-inline-add input')
  await input.fill(title)
  await input.press('Enter')
  await expect(zone.locator('[data-task-id]').filter({ hasText: title })).toHaveCount(1, { timeout: 20_000 })
  // The card is drawn optimistically, before the create returns: wait for the server row.
  let all: ServerTask[] = []
  await expect.poll(async () => {
    all = await serverTasks()
    return all.some((t) => t.title === title)
  }, { timeout: 20_000 }).toBe(true)
  const created = all.find((t) => t.title === title)!
  litter.tasks.push(created.id)
  await expect.poll(() => drawn(page, tier.id), { timeout: 15_000 }).toEqual([...custom, created.id])

  await chooseViewOption(page, 'tier-project')
  const withNew = await expectDrawnAsComputed(page, tier.id, 'project', birch)
  const byId = new Map(all.map((t) => [t.id, t]))
  const home = created.project ?? ''
  const run = withNew.filter((id) => (byId.get(id)?.project ?? '') === home && !byId.get(id)?.group_id)
  expect(run[run.length - 1], 'the new task is the last of its project run').toBe(created.id)
  expect(withNew[0], 'and never the top of the tier').not.toBe(created.id)
  await page.screenshot({ path: `${SHOTS}/web-tier-new-task.png` })
})
