/**
 * The workers line stays inside a narrow session column in every shape it takes: by itself after
 * the lead's turn, and inside the live turn's "<engine> is working…" row while the lead's own turn
 * runs (SessionWorkingIndicator.tsx). 2026-11-25: at 820px (a 508px column) with 13 workers at work
 * and the list open, the lead's own turn widened the line to 527px and two long titles ran past the
 * column's edge with no ellipsis; by itself the same line kept its 467px. The nested row is a flex
 * item, and a flex item's min-width is its content's unless it says otherwise.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { REAL_PANEL } from './draft-helpers'
import { isolateUiPrefs, presetPanelView } from './todo-panel-helpers'
import { call, kanbanApi, pollUntil, startSession, type KanbanApi } from './board-kanban-fixture'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const PROJECT = 'Workers Narrow'
const litter: string[] = []
let api: KanbanApi
let lead = ''
let leadSid = ''
const LEAD_TITLE = `Narrow column lead ${Date.now().toString(36)}`

// Titles as long as the user's own workers' titles.
const TITLES = Array.from({ length: 13 }, (_, i) => i % 7 === 0
  ? `Part ${i + 1}: one process manager runs every service on each machine, and the desktop app only asks it to start or stop them`
  : `Part ${i + 1}: health checks per host`)

test.use({ viewport: { width: 820, height: 800 }, deviceScaleFactor: 1 })
test.describe.configure({ mode: 'serial' })

const task = (body: Record<string, unknown>) => call<{ task: { id: string } }>(api, 'POST', '/api/tasks', { project: PROJECT, source: 'local', ...body })

test.beforeAll(async () => {
  test.setTimeout(300_000)
  const { fixtureRoot } = await discoverBrowserFixture(TEST_PORT)
  api = kanbanApi(TEST_PORT, fixtureRoot)
  lead = (await task({ title: LEAD_TITLE })).task.id
  litter.push(lead)
  leadSid = await startSession(api, lead, 'snapshot-clean-turn:Planned the work; the workers run it.')
  for (const title of TITLES) {
    const id = (await task({ title, parent_task_id: lead })).task.id
    litter.push(id)
    await startSession(api, id, 'slow:900000 snapshot-clean-turn:Worker finished.')
  }
  await pollUntil('13 workers at work', async () => (await call<{ tasks: Array<{ parent_task_id?: string; user_status?: { state?: string } }> }>(api, 'GET', '/api/tasks')).tasks
    .filter((t) => t.parent_task_id === lead && t.user_status?.state === 'working').length, (n) => n === TITLES.length, 120_000)
})

test.afterAll(async () => {
  for (const id of [...litter].reverse()) await fetch(`${api.base}/api/tasks/${id}?force=true`, { method: 'DELETE' }).catch(() => undefined)
})

async function openLead(page: Page): Promise<Locator> {
  await isolateUiPrefs(page)
  await presetPanelView(page, { section: 'all', project: PROJECT })
  await page.setContent(`<a href="${api.base}/">Open Walnut</a>`)
  await page.getByRole('link', { name: 'Open Walnut', exact: true }).click()
  // Found by search, as the user finds one task among many in a narrow window.
  await page.locator('.todo-search-input').click()
  await page.keyboard.type(LEAD_TITLE)
  const row = page.locator(`.todo-panel-item[data-task-id="${lead}"]`)
  await expect(row).toBeVisible({ timeout: 90_000 })
  await row.locator('.todo-item-title').click()
  const panel = page.locator(`${REAL_PANEL}[data-session-id="${leadSid}"]`)
  await expect(panel).toBeVisible({ timeout: 30_000 })
  return panel
}

/** The line, its chips and the column it sits in, as boxes; every chip's title cut shows its ellipsis. */
async function expectInside(panel: Locator, shape: string): Promise<void> {
  const line = panel.getByTestId('session-workers-working')
  await expect(line).toHaveAttribute('data-open', 'true')
  const m = await line.evaluate((el) => {
    const column = el.closest('.main-page-session-column')!.getBoundingClientRect()
    const chips = [...el.querySelectorAll<HTMLElement>('.wn-chip')]
    return {
      column: { left: column.left, right: column.right },
      line: el.getBoundingClientRect().right,
      chips: chips.map((c) => {
        const label = c.querySelector<HTMLElement>('.wn-chip-label')
        return { right: c.getBoundingClientRect().right, clipped: label ? label.scrollWidth > label.clientWidth : false,
          ellipsis: label ? getComputedStyle(label).textOverflow : '' }
      }),
    }
  })
  expect(m.chips, shape).toHaveLength(TITLES.length)
  expect(m.line, `${shape}: the line ends inside the column`).toBeLessThanOrEqual(m.column.right + 0.5)
  for (const [i, c] of m.chips.entries()) {
    expect(c.right, `${shape}: chip ${i + 1} ends inside the column`).toBeLessThanOrEqual(m.column.right + 0.5)
    if (c.clipped) expect(c.ellipsis, `${shape}: chip ${i + 1} cut with an ellipsis`).toBe('ellipsis')
  }
  // The long titles are cut in a 508px column: the test means nothing if none is.
  expect(m.chips.some((c) => c.clipped), `${shape}: a long title is cut`).toBe(true)
}

test('open, the line keeps inside a narrow column by itself and inside the lead\'s live turn', async ({ page }) => {
  test.setTimeout(180_000)
  const panel = await openLead(page)
  const line = panel.getByTestId('session-workers-working')
  await expect(line).toBeVisible({ timeout: 60_000 })
  await panel.getByTestId('session-workers-toggle').click()
  await expectInside(panel, 'by itself')

  // The lead's own turn runs: the line moves inside the working row.
  await panel.locator('.chat-input-textarea').click()
  await page.keyboard.type('compaction-test:10:2000')
  await page.keyboard.press('Enter')
  await expect(panel.locator('.session-working-row .session-working-row[data-testid="session-workers-working"]')).toBeVisible({ timeout: 30_000 })
  await expectInside(panel, 'inside the live turn')
  await expect(panel.locator('.chat-input-textarea')).toBeInViewport()
})
