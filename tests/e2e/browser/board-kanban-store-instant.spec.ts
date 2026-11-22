/**
 * A card completed on the Board shows completed on every other surface in the same frame, before
 * the server has answered (2026-11-19: the Board wrote a card's phase and complete with its own
 * request and patched only its own payload, so the task's other surfaces, here its own session
 * header beside the Board, waited for the task event to come back).
 *
 * The Board now writes a card's task through the task store when it holds the row
 * (web/src/components/board/kanban/useKanbanWrites.ts: store.complete / store.setPhase), keeping its
 * own overlay. Proven by holding the write at the network layer.
 *
 * Scenario matrix (Home with two session columns: the leader's, its Board open on Cards, and its
 * worker's; the worker's header phase button says whether it is done):
 *  1. Complete on the worker's card with the write held: the worker's header reads done
 *     inside INSTANT_MS with zero responses answered; after the release, in no frame of the next
 *     2.5 s does it read anything else, and the server has it COMPLETE.
 *  2. Complete refused (500 after 1.2 s): the header reads its old status again, the Board says it
 *     could not complete, and the server still has the task open.
 * The fixture is shared, so this file makes its own tasks and removes them.
 */
import { expect, test, type APIRequestContext, type Locator, type Page, type Route } from '@playwright/test'
import { openSessionBoard } from './board-view-helpers'
import { discoverBrowserFixture } from './codex-test-audit'
import { REAL_PANEL, loadHome, seedColumns } from './draft-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'
import { pickCardsView } from './board-kanban-fixture'
import { keepCornerToBoard } from './board-kanban-corner'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const STAMP = `${Date.now().toString(36)}${process.pid.toString(36)}`
const PROJECT = `Board instant ${STAMP}`
const INSTANT_MS = 700
const made: string[] = []
const ids = { leader: '', leaderSid: '', held: '', heldSid: '', refused: '', refusedSid: '' }
const SHOTS = `${process.env.WALNUT_TASK_DIR ?? 'test-results'}/shots`

test.use({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 })
test.describe.configure({ mode: 'serial' })
test.setTimeout(180_000)

async function post<T>(request: APIRequestContext, url: string, data: unknown): Promise<T> {
  const res = await request.post(url, { data })
  expect(res.ok(), `${url}: ${await res.text()}`).toBe(true)
  return (await res.json()) as T
}

async function phaseOf(request: APIRequestContext, id: string): Promise<string> {
  return ((await (await request.get(`/api/tasks/${id}`)).json()) as { task: { phase: string } }).task.phase
}

test.beforeAll(async ({ request }) => {
  const { fixtureRoot } = await discoverBrowserFixture(TEST_PORT)
  const cwd = `${fixtureRoot}/projects/walnut`
  const task = async (title: string, parent?: string) => {
    const { task: t } = await post<{ task: { id: string } }>(request, '/api/tasks', { title, project: PROJECT, source: 'local', ...(parent ? { parent_task_id: parent } : {}) })
    made.push(t.id)
    return t.id
  }
  const start = async (taskId: string, message: string) =>
    (await post<{ sessionId: string }>(request, '/api/sessions/quick-start', { cwd, message, taskId })).sessionId
  ids.leader = await task(`Board lead ${STAMP}`)
  ids.held = await task(`Held card ${STAMP}`, ids.leader)
  ids.refused = await task(`Refused card ${STAMP}`, ids.leader)
  ids.leaderSid = await start(ids.leader, `snapshot-clean-turn:Board lead ready ${STAMP}`)
  ids.heldSid = await start(ids.held, `snapshot-clean-turn:Held card ready ${STAMP}`)
  ids.refusedSid = await start(ids.refused, `snapshot-clean-turn:Refused card ready ${STAMP}`)
})

test.beforeEach(async ({ context }) => { await pickCardsView(context, ids.leader); await keepCornerToBoard(context) })

test.afterAll(async ({ request }) => {
  for (const id of [...made].reverse()) {
    const t = (await (await request.get(`/api/tasks/${id}`)).json()).task as { session_id?: string } | undefined
    if (t?.session_id) await request.post(`/api/v1/sessions/${t.session_id}/terminate`, { data: { force: true } }).catch(() => {})
    await request.delete(`/api/v1/tasks/${id}/board`).catch(() => {})
    await request.delete(`/api/tasks/${id}?force=true`).catch(() => {})
  }
})

/** The header's phase button: its title says Done once the task is complete (a narrow column shows no label). */
const header = (page: Page, sid: string) => page.locator(`${REAL_PANEL}[data-session-id="${sid}"] .task-quick-phase-btn`).first()
// The header's own title (TaskQuickActions), its dash written as an escape for the hygiene scan.
const DONE = 'Done \u2014 click to reopen'
const title = (l: Locator) => l.getAttribute('title')

/** Home with the leader's column (its Board on Cards) and the worker's column. */
async function openBoard(page: Page, workerSid: string): Promise<Locator> {
  await isolateUiPrefs(page)
  await seedColumns(page, [ids.leaderSid, workerSid])
  await loadHome(page)
  const lead = page.locator(`${REAL_PANEL}[data-session-id="${ids.leaderSid}"]`)
  await expect(lead).toBeVisible({ timeout: 30_000 })
  await expect(page.locator(`${REAL_PANEL}[data-session-id="${workerSid}"]`)).toBeVisible({ timeout: 30_000 })
  const pane = await openSessionBoard(page, lead)
  if (!(await pane.getByTestId('board-kanban').isVisible().catch(() => false))) await pane.getByTestId('board-view-cards').click()
  await expect(pane.getByTestId('board-kanban')).toBeVisible({ timeout: 30_000 })
  return pane
}

const card = (pane: Locator, id: string) => pane.locator(`[data-testid="kanban-card"][data-task-id="${id}"]`)

/** Record every animation frame's header label from now on; the reader gives the labels seen. */
async function watchHeader(page: Page, sid: string): Promise<() => Promise<string[]>> {
  await page.evaluate(([sel]) => {
    const seen = new Set<string>()
    const w = window as unknown as { __boardSeen?: Set<string> }
    w.__boardSeen = seen
    const tick = () => {
      if (w.__boardSeen !== seen) return
      seen.add(document.querySelector(sel!)?.getAttribute('title') ?? 'not drawn')
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }, [`${REAL_PANEL}[data-session-id="${sid}"] .task-quick-phase-btn`] as const)
  return () => page.evaluate(() => [...((window as unknown as { __boardSeen?: Set<string> }).__boardSeen ?? [])])
}

test('a card completed on the Board reads completed in its own session header before the server answers', async ({ page }) => {
  const pane = await openBoard(page, ids.heldSid)
  await expect(header(page, ids.heldSid)).toBeVisible({ timeout: 30_000 })
  expect(await title(header(page, ids.heldSid))).not.toBe(DONE)
  let sent = 0
  let answered = 0
  let open = false
  const held: Route[] = []
  await page.route(`**/api/**/tasks/${ids.held}/complete`, async (route) => {
    sent += 1
    if (open) { await route.continue(); answered += 1; return }
    held.push(route)
  })
  await card(pane, ids.held).hover()
  await card(pane, ids.held).getByTestId('kanban-card-complete').click()
  await expect(header(page, ids.heldSid)).toHaveAttribute('title', DONE, { timeout: INSTANT_MS })
  await expect.poll(() => sent, { timeout: 5_000 }).toBeGreaterThanOrEqual(1)
  expect(answered, 'the server answered before the header moved').toBe(0)
  expect(await phaseOf(page.request, ids.held), 'the server has not seen the write').not.toBe('COMPLETE')
  await page.screenshot({ path: `${SHOTS}/board-kanban-store-held-${test.info().project.name}.png` }).catch(() => {})

  const seen = await watchHeader(page, ids.heldSid)
  await page.waitForTimeout(1_500)
  open = true
  for (const r of held.splice(0)) { await r.continue(); answered += 1 }
  await expect.poll(() => phaseOf(page.request, ids.held), { timeout: 15_000 }).toBe('COMPLETE')
  await page.waitForTimeout(2_500)
  await expect(header(page, ids.heldSid)).toHaveAttribute('title', DONE)
  expect(await seen(), 'the header read another status after it moved').toEqual([DONE])
})

test('a complete the server refuses puts the header back and the Board says so', async ({ page }) => {
  const pane = await openBoard(page, ids.refusedSid)
  await expect(header(page, ids.refusedSid)).toBeVisible({ timeout: 30_000 })
  const before = (await title(header(page, ids.refusedSid))) ?? ''
  expect(before).not.toBe(DONE)
  let refusals = 0
  await page.route(`**/api/**/tasks/${ids.refused}/complete`, async (route) => {
    await new Promise((r) => setTimeout(r, 1_200))
    refusals += 1
    await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'disk full' }) })
  })
  await card(pane, ids.refused).hover()
  await card(pane, ids.refused).getByTestId('kanban-card-complete').click()
  await expect(header(page, ids.refusedSid)).toHaveAttribute('title', DONE, { timeout: INSTANT_MS })
  expect(refusals).toBe(0)
  await expect(header(page, ids.refusedSid)).toHaveAttribute('title', before, { timeout: 15_000 })
  await expect(page.getByTestId('kanban-toast').filter({ hasText: "Couldn't complete" }).first()).toBeVisible({ timeout: 15_000 })
  expect(refusals).toBeGreaterThanOrEqual(1)
  expect(await phaseOf(page.request, ids.refused)).not.toBe('COMPLETE')
})
