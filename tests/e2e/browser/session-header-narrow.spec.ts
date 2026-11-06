/**
 * A narrow session column keeps its header readable (2026-10-02 report:
 * three columns side by side, or the Mac app zoomed in, wrapped the tool row one
 * chip per line, drew the window buttons over the chips, and ran the title row's
 * pills past the panel edge over the phase circle).
 *
 * Real density: the task carries the pills a busy task has (Trigger, Worker,
 * Leader · 1), on a real session on the fixture server. They stay on the title
 * row (2026-11-03: only link tags fold into the tags control; no status badge):
 * beside the title in a wide row, and on a line of their own under the title,
 * each in full, in a narrow one (2026-11-04, the user: "maybe we shoud make the
 * lable another line if the space is narrow"), the kebab staying on the title's
 * line. The column is clamped to the widths the report showed (400 → 180px); at
 * each one the tool row is a single line inside the panel, the hidden chips sit in
 * a "..." menu that opens them, the title keeps all the room the kebab (and in a
 * wide row the pills) leave it, each pill opens what it opens, and a widened
 * column gets everything back.
 */
import fs from 'node:fs/promises'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { REAL_PANEL, draftComposer, openDraftOnCwd } from './draft-helpers'
import { clampColumn } from './composer-controls-overflow-helpers'
import { expectHeaderLabel, headerLabelsButton } from './session-header-labels-helpers'

const SHOT_DIR = process.env.PW_SCREENSHOT_DIR ?? '/tmp/session-header-narrow'
const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const API = `http://localhost:${TEST_PORT}`

let fixtureRoot = ''
const litterTasks: string[] = []
const litterRoutines: string[] = []

test.describe.configure({ mode: 'serial' })
test.use({ viewport: { width: 1280, height: 800 } })

test.beforeAll(async () => {
  ;({ fixtureRoot } = await discoverBrowserFixture(TEST_PORT))
  await fs.mkdir(SHOT_DIR, { recursive: true })
})

test.afterAll(async () => {
  for (const id of litterRoutines) await fetch(`${API}/api/routines/${id}`, { method: 'DELETE' }).catch(() => undefined)
  for (const id of [...litterTasks].reverse()) await fetch(`${API}/api/tasks/${id}`, { method: 'DELETE' }).catch(() => undefined)
})

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`)
  return (await res.json()) as T
}

async function openHome(page: Page): Promise<void> {
  await page.setContent(`<a href="${API}/">Open Walnut</a>`)
  await page.getByRole('link', { name: 'Open Walnut', exact: true }).click()
  await expect(page.locator('.main-page')).toBeVisible({ timeout: 90_000 })
}

async function quickStart(page: Page, composer: Locator, prompt: string): Promise<{ taskId: string; sessionId: string }> {
  const response = page.waitForResponse((r) =>
    r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/sessions/quick-start')
  await composer.fill(prompt)
  await composer.press('Enter')
  const res = await response
  expect(res.status()).toBe(200)
  const out = (await res.json()) as { taskId: string; sessionId: string }
  litterTasks.push(out.taskId)
  return out
}

/** The pills a busy task carries: a parent (Worker), a subtask (Leader · 1), a trigger. */
async function dressAsBusyTask(taskId: string): Promise<void> {
  await api('PATCH', `/api/tasks/${taskId}`, { title: 'Garden shed stale thumbnail tidy-up across the archive' })
  const parent = await api<{ task: { id: string } }>('POST', '/api/tasks', { title: `Narrow header parent ${Date.now()}`, source: 'local', project: 'Work' })
  litterTasks.unshift(parent.task.id)
  await api('PATCH', `/api/tasks/${taskId}`, { parent_task_id: parent.task.id })
  const child = await api<{ task: { id: string } }>('POST', '/api/tasks', { title: `Narrow header child ${Date.now()}`, source: 'local', project: 'Work', parent_task_id: taskId })
  litterTasks.push(child.task.id)
  const trigger = await api<{ job: { id: string } }>('POST', '/api/v1/routines/trigger', {
    name: 'Narrow header watch', description: 'Watches nothing; it only puts a Trigger pill on the header.',
    run: `echo '{"fire": false}'`, every: '5m', prompt: 'Nothing to do.', session: taskId,
  })
  litterRoutines.push(trigger.job.id)
}

interface HeaderState {
  panelRight: number
  toolRow: { lines: number; visible: string[]; hidden: string[]; overflowBy: number }
  titleRow: {
    lines: number; overflowBy: number; titleWidth: number; pillsClearOfTitle: boolean
    /** What the title row's right side shows, in order: 'pill', 'labels' (the tags control), 'kebab'. */
    items: string[]
    /** Room between the title's end and the first thing after it when the title is cut (else 0). */
    slackWhenCut: number
    pillCount: string
    /** The labels sit on a line under the title (a narrow row). */
    labelsBelow: boolean
    /** Every pill shows its whole label (nothing cut to letters or an ellipsis). */
    pillsWhole: boolean
    /** The row measured narrow (data-header-fit="tight"). */
    tight: boolean
    /** The widest gap between two pills side by side on one line (they sit together, never spread). */
    pillGap: number
  }
  moreVisible: boolean
}

/** Everything the header shows, read in one pass. */
async function headerState(panel: Locator): Promise<HeaderState> {
  return panel.locator('.session-panel-header').evaluate((header) => {
    const panelBox = header.getBoundingClientRect()
    const toolRow = header.querySelector('.session-meta-row-2')!
    const items = [...toolRow.querySelectorAll<HTMLElement>('[data-header-id]')]
      .filter((el) => el.childElementCount > 0 || (el.textContent ?? '').trim())
    const visible = items.filter((el) => el.dataset.hidden !== 'true')
    // Items on one flex row share a vertical center (align-items: center), whatever
    // their heights: one line when the centers spread less than 2px, two otherwise.
    const tops = (els: Element[]) => {
      const centers = els.map((el) => { const b = el.getBoundingClientRect(); return (b.top + b.bottom) / 2 })
      return centers.length && Math.max(...centers) - Math.min(...centers) > 2 ? 2 : 1
    }
    const overflow = (els: Element[]) => Math.max(0, ...els.map((el) => Math.round(el.getBoundingClientRect().right - panelBox.right)))
    const meta = header.querySelector<HTMLElement>('.session-panel-title-meta')!
    const metaKids = [...meta.children].filter((el) => getComputedStyle(el).display !== 'none')
    const title = header.querySelector<HTMLElement>('.session-panel-title')!
    const titleBox = title.getBoundingClientRect()
    const titleRowEls = [...header.querySelector('.session-panel-header-top')!.children]
    const labels = meta.querySelector<HTMLElement>('[data-testid="session-header-labels"]')
    const cut = title.scrollWidth > title.clientWidth + 1
    return {
      panelRight: panelBox.right,
      toolRow: {
        lines: tops(visible),
        visible: visible.map((el) => el.dataset.headerId!),
        hidden: items.filter((el) => el.dataset.hidden === 'true').map((el) => el.dataset.headerId!),
        overflowBy: overflow(visible),
      },
      titleRow: {
        lines: tops([...titleRowEls, ...metaKids]),
        overflowBy: overflow(metaKids),
        titleWidth: Math.round(titleBox.width),
        pillsClearOfTitle: metaKids.every((el) => {
          const b = el.getBoundingClientRect()
          return b.left >= titleBox.right - 1 || b.top >= titleBox.bottom - 1
        }),
        items: metaKids.map((el) => el === labels ? 'labels'
          : el.matches('.task-kebab-btn') || el.querySelector('.task-kebab-btn') ? 'kebab'
            : el.matches('.task-row-pill, .task-waiting-chip') ? 'pill' : `other:${el.className}`),
        // The first thing after the title on its own line: the first pill in a wide row, the
        // kebab in a narrow one (the pills went to the line under it).
        slackWhenCut: (() => {
          const next = metaKids.find((el) => Math.abs(el.getBoundingClientRect().top - titleBox.top) < titleBox.height)
          return cut && next ? Math.round(next.getBoundingClientRect().left - titleBox.right) : 0
        })(),
        pillCount: String(metaKids.filter((el) => el.matches('.task-row-pill, .task-waiting-chip')).length),
        labelsBelow: metaKids.filter((el) => el.matches('.task-row-pill, .task-waiting-chip'))
          .every((el) => el.getBoundingClientRect().top >= titleBox.bottom - 1),
        pillsWhole: metaKids.filter((el) => el.matches('.task-row-pill, .task-waiting-chip'))
          .every((el) => el.scrollWidth <= el.clientWidth + 1),
        tight: header.querySelector('.session-panel-header-top')!.getAttribute('data-header-fit') === 'tight',
        pillGap: (() => {
          const boxes = metaKids.filter((el) => el.matches('.task-row-pill, .task-waiting-chip')).map((el) => el.getBoundingClientRect())
          let widest = 0
          for (let i = 1; i < boxes.length; i++) {
            if (Math.abs(boxes[i]!.top - boxes[i - 1]!.top) < 2) widest = Math.max(widest, Math.round(boxes[i]!.left - boxes[i - 1]!.right))
          }
          return widest
        })(),
      },
      moreVisible: !!header.querySelector('[data-header-more]'),
    }
  })
}

/** Clamp the column and wait for the header to settle (two identical reads 200ms apart). */
async function settleAt(page: Page, panel: Locator, width: number | null): Promise<HeaderState> {
  await clampColumn(page, width)
  let last = await headerState(panel)
  await expect.poll(async () => {
    await page.waitForTimeout(200)
    const now = await headerState(panel)
    const same = JSON.stringify(now) === JSON.stringify(last)
    last = now
    return same
  }, { timeout: 15_000 }).toBe(true)
  return last
}

function expectInsidePanel(state: HeaderState, label: string) {
  expect(state.toolRow.lines, `${label}: the tool row wrapped`).toBeLessThanOrEqual(1)
  expect(state.toolRow.overflowBy, `${label}: the tool row runs past the panel`).toBeLessThanOrEqual(0)
  // One line when wide; when narrow, the title's line and the labels' line under it.
  expect(state.titleRow.lines, `${label}: the title row wrapped`).toBeLessThanOrEqual(state.titleRow.tight ? 2 : 1)
  if (state.titleRow.tight) expect(state.titleRow.labelsBelow, `${label}: the labels sit on the line under the title`).toBe(true)
  // The labels sit together from the start of their line, never spread edge to edge.
  expect(state.titleRow.pillGap, `${label}: the pills are spread apart`).toBeLessThanOrEqual(8)
  expect(state.titleRow.pillsWhole, `${label}: a pill is cut`).toBe(true)
  expect(state.titleRow.overflowBy, `${label}: the title row runs past the panel`).toBeLessThanOrEqual(0)
  expect(state.titleRow.pillsClearOfTitle, `${label}: a pill or the kebab overlaps the title`).toBe(true)
  // The task has no link tag, so no tags control: its three state pills (Trigger, Worker,
  // Leader) and the kebab sit beside the title.
  expect(state.titleRow.items, `${label}: the state pills and the kebab sit beside the title`).toEqual(['pill', 'pill', 'pill', 'kebab'])
  // The title takes the whole row but those: when it is cut, it is cut at the first pill.
  expect(state.titleRow.slackWhenCut, `${label}: the cut title leaves room unused`).toBeLessThanOrEqual(12)
  expect(state.toolRow.visible, `${label}: close must stay`).toContain('close')
  expect(state.toolRow.visible, `${label}: expand must stay`).toContain('expand')
  expect(state.toolRow.visible, `${label}: lock must stay`).toContain('lock')
  expect(state.toolRow.visible.slice(-3), `${label}: Lock, Expand and Close end the row, in that order`).toEqual(['lock', 'expand', 'close'])
}

/** The header alone, or the header plus `below` px of the page under it (an open menu). */
async function shootHeader(panel: Locator, name: string, below = 0): Promise<void> {
  const box = await panel.locator('.session-panel-header').boundingBox()
  if (!box) return
  const engine = panel.page().context().browser()?.browserType().name() ?? 'browser'
  await panel.page().screenshot({
    path: `${SHOT_DIR}/${engine}-${name}.png`, animations: 'disabled',
    clip: { x: box.x - 1, y: box.y - 1, width: Math.min(box.width + 2, 640), height: box.height + 2 + below },
  })
}

/** The order the chips leave the tool row, first to go first. Lock, Expand and Close never leave. */
const CHIP_LEAVE_ORDER = ['board', 'terminal', 'files', 'changed', 'fork']
const WINDOW_BUTTONS = ['locate', 'popout']
/** The chips a "..." row stands in for. */
const VIEW_CHIPS = ['changed', 'files', 'board', 'terminal']
/** Everything the "..." menu lists: the time is the one hidden item it does not. */
const LISTED = [...VIEW_CHIPS, ...WINDOW_BUTTONS]

/** The rules every width must obey, whatever the exact pixel widths of the chips. */
function expectRules(state: HeaderState, label: string) {
  expectInsidePanel(state, label)
  const hidden = new Set(state.toolRow.hidden)
  // The chips leave in order (Board first, a lead's chip that may arrive late; Fork last). A window button fills whatever room they
  // leave, so it may sit on the row beside a hidden chip (2026-10-04).
  const chips = CHIP_LEAVE_ORDER.filter((id) => hidden.has(id) || state.toolRow.visible.includes(id))
  const firstVisibleChip = chips.findIndex((id) => !hidden.has(id))
  if (firstVisibleChip >= 0) {
    for (const id of chips.slice(firstVisibleChip)) expect(hidden.has(id), `${label}: ${id} left before a chip that leaves sooner`).toBe(false)
  }
  const listedHidden = LISTED.some((id) => hidden.has(id))
  expect(state.moreVisible, `${label}: the "..." chip shows exactly when it has something to list`).toBe(listedHidden)
  // The pills never leave the row: the same three at every width.
  expect(state.titleRow.pillCount, `${label}: Trigger, Worker and Leader stay on the row`).toBe('3')
}

/** Narrower never shows a chip that wider hid (a window button can return where a chip left). */
function expectMonotonic(wider: HeaderState, narrower: HeaderState, label: string) {
  for (const id of wider.toolRow.hidden.filter((h) => CHIP_LEAVE_ORDER.includes(h))) expect(narrower.toolRow.hidden, `${label}: ${id} came back`).toContain(id)
  expect(narrower.titleRow.titleWidth, `${label}: the title grew in a narrower column`).toBeLessThanOrEqual(wider.titleRow.titleWidth)
}

test('a narrow column keeps the tool row on one line and the labels whole under the title, from 400px down to 180px', async ({ page }) => {
  test.setTimeout(240_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await openHome(page)
  await openDraftOnCwd(page, `${fixtureRoot}/projects/walnut`)
  const { taskId, sessionId } = await quickStart(page, draftComposer(page), 'snapshot-clean-turn:Narrow header turn finished')
  const panel = page.locator(`${REAL_PANEL}[data-session-id="${sessionId}"]`)
  await expect(panel.getByText('Narrow header turn finished', { exact: true }).first()).toBeVisible({ timeout: 30_000 })
  await dressAsBusyTask(taskId)
  const meta = panel.locator('.session-panel-title-meta')
  for (const pill of ['Trigger', 'Worker', 'Leader']) await expectHeaderLabel(panel, pill)
  // No status badge on the header any more (the task detail shows the run status).
  await expect(panel.locator('.session-panel-header .session-panel-badge')).toHaveCount(0)

  // Wide: today's header, untouched. Every chip and button on the row, full words.
  const wide = await settleAt(page, panel, null)
  expectRules(wide, 'wide')
  expect(wide.toolRow.hidden).toEqual([])
  await shootHeader(panel, 'wide')

  // Each width the report showed, in turn: the rules hold and nothing comes back.
  const states: Record<number, HeaderState> = {}
  let previous = wide
  for (const width of [400, 320, 240, 180]) {
    const state = await settleAt(page, panel, width)
    expectRules(state, `${width}px`)
    expectMonotonic(previous, state, `${width}px`)
    states[width] = state
    previous = state
    await shootHeader(panel, String(width))
  }
  // The movable window buttons are the first to go (400px has room for the chips, not for five
  // buttons too); Lock, Expand and Close stay at every width.
  expect(states[400].toolRow.hidden).toContain('popout')
  expect(['changed', 'files', 'board', 'terminal'].every((id) => states[400].toolRow.visible.includes(id)), `400px: ${states[400].toolRow.visible}`).toBe(true)
  // 240px cannot hold five chips (Board, the first to leave, is gone); 180px holds Fork and little else.
  expect(states[240].toolRow.hidden).toEqual(expect.arrayContaining(['board']))
  expect(states[180].toolRow.hidden).toEqual(expect.arrayContaining(['files', 'board', 'terminal']))
  expect(states[180].toolRow.visible[0]).toBe('fork')
  // A narrow row puts the pills, in full, on a line under the title; a wide one keeps them beside it.
  expect(wide.titleRow.tight).toBe(false)
  expect(wide.titleRow.lines).toBe(1)
  expect(states[240].titleRow.tight).toBe(true)
  expect(states[180].titleRow.tight).toBe(true)
  // The title has its line to itself but the kebab: room to read it even at 180px.
  expect(states[180].titleRow.titleWidth).toBeGreaterThanOrEqual(90)
  expect(states[240].titleRow.titleWidth).toBeGreaterThanOrEqual(150)

  // 180px: the "..." menu names every hidden view, then the hidden window buttons (the
  // tool row's overflow stays on the tool row; the kebab below is the task's menu). Opening
  // a view takes the panel full screen (wide): the Files chip is back on the row, marked open.
  await panel.getByTestId('session-header-more-btn').click()
  const more = page.getByTestId('session-header-more-menu')
  for (const id of states[180].toolRow.hidden.filter((h) => VIEW_CHIPS.includes(h))) {
    await expect(more.getByTestId(`session-header-more-item-${id}`)).toHaveText(id[0]!.toUpperCase() + id.slice(1))
  }
  await expect(more.getByTestId('session-header-more-item-locate')).toHaveText(/Locate task/)
  await expect(more.getByTestId('session-header-more-item-lock')).toHaveCount(0)
  await expect(more.getByTestId('session-header-more-item-popout')).toHaveText(/Open in new tab/)
  // Home's columns also carry Minimize (the taskbar), the third movable window button.
  await expect(more.getByTestId('session-header-more-item-minimize')).toHaveText(/Minimize/)
  await expect(more.getByTestId('session-header-more-item-expand')).toHaveCount(0)
  const moreRows = await more.locator('[role="menuitem"]').evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')!.replace('session-header-more-item-', '')))
  expect(moreRows.slice(-3), 'window buttons come after the views').toEqual(['locate', 'popout', 'minimize'])
  await shootHeader(panel, '180-more', 220)
  await more.getByTestId('session-header-more-item-files').click()
  await expect(more).toHaveCount(0)
  await expect(panel.locator('[data-header-id="files"]')).toHaveClass(/session-action-chip-active/, { timeout: 10_000 })
  await expect(panel.locator('[data-header-id="files"]')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(panel.locator('[data-header-id="files"]')).not.toHaveClass(/session-action-chip-active/, { timeout: 10_000 })
  const back180 = await settleAt(page, panel, 180)
  expect(back180.toolRow.hidden).toEqual(states[180].toolRow.hidden)

  // The kebab is the task's menu: no pill rows (the labels control holds them) and no window
  // button from the row above.
  await meta.locator('.task-kebab-btn').click()
  const kebab = page.locator('.task-kebab-menu').last()
  await expect(kebab).toBeVisible()
  await expect(kebab.locator('[data-testid^="session-header-kebab-pill-"]')).toHaveCount(0)
  await expect(kebab.getByText(/Locate task|Lock panel|Open in new tab/)).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(kebab).toHaveCount(0, { timeout: 10_000 })

  // At 180px the pills, on their own line, read in full, and each one opens what it
  // opens: the Trigger flyout anchors to a real box inside the window.
  await expect(meta.locator('[data-testid="subtask-pill"]')).toHaveText('Worker')
  await expect(meta.locator('[data-testid="leader-pill"]')).toHaveText('Leader · 1')
  await expect(meta.locator('[data-testid="task-trigger-pill"]')).toHaveText('Trigger')
  await expect(headerLabelsButton(panel)).toHaveCount(0)
  await meta.locator('[data-testid="task-trigger-pill"]').click()
  const jobs = page.getByTestId('trigger-jobs-flyout')
  await expect(jobs).toBeVisible({ timeout: 10_000 })
  const jobsBox = (await jobs.boundingBox())!
  const viewport = page.viewportSize()!
  expect(jobsBox.x, 'the trigger flyout starts inside the window').toBeGreaterThanOrEqual(0)
  expect(jobsBox.x + jobsBox.width, 'the trigger flyout ends inside the window').toBeLessThanOrEqual(viewport.width)
  await shootHeader(panel, '180-trigger-open', 220)
  await page.keyboard.press('Escape')
  await expect(jobs).toHaveCount(0, { timeout: 10_000 })

  // 320px: something is in the "..." menu while the pills are still on the row; Lock and Expand
  // are still buttons. It goes full screen, where the whole header comes back;
  // Escape returns to the same narrow shape.
  const at320 = await settleAt(page, panel, 320)
  expect(at320.toolRow.hidden.length, '320px cannot hold every chip and button').toBeGreaterThan(0)
  expect(at320.toolRow.visible).toEqual(expect.arrayContaining(['lock', 'expand']))
  await panel.getByRole('button', { name: 'Expand session to full screen', exact: true }).click()
  await expect(panel.getByRole('button', { name: 'Collapse session', exact: true })).toBeVisible({ timeout: 10_000 })
  const full = await settleAt(page, panel, 320)
  expect(full.toolRow.hidden, 'full screen is wide: nothing hidden').toEqual([])
  await page.keyboard.press('Escape')
  await expect(panel.getByRole('button', { name: 'Collapse session', exact: true })).toHaveCount(0, { timeout: 10_000 })
  const back320 = await settleAt(page, panel, 320)
  expect(back320.toolRow.hidden).toEqual(at320.toolRow.hidden)

  // Widened again: everything returns, no leftovers.
  const wideAgain = await settleAt(page, panel, null)
  expect(wideAgain.toolRow.hidden).toEqual([])
  expect(wideAgain.moreVisible).toBe(false)
  expect(wideAgain.titleRow.titleWidth).toBe(wide.titleRow.titleWidth)
  expect(errors).toEqual([])
})

test('a second trigger while narrow stays one Trigger label that names both watches', async ({ page }) => {
  test.setTimeout(180_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await openHome(page)
  await openDraftOnCwd(page, `${fixtureRoot}/projects/walnut`)
  const { taskId, sessionId } = await quickStart(page, draftComposer(page), 'snapshot-clean-turn:Narrow header second turn finished')
  const panel = page.locator(`${REAL_PANEL}[data-session-id="${sessionId}"]`)
  await expect(panel.getByText('Narrow header second turn finished', { exact: true }).first()).toBeVisible({ timeout: 30_000 })
  await dressAsBusyTask(taskId)
  await expectHeaderLabel(panel, 'Trigger')
  const narrow = await settleAt(page, panel, 260)
  expectInsidePanel(narrow, '260px')
  const second = await api<{ job: { id: string } }>('POST', '/api/v1/routines/trigger', {
    name: 'Narrow header second watch', description: 'A second trigger, so the hover text lists two.',
    run: `echo '{"fire": false}'`, every: '5m', prompt: 'Nothing to do.', session: taskId,
  })
  litterRoutines.push(second.job.id)
  const trigger = panel.locator('.session-panel-title-meta [data-testid="task-trigger-pill"]')
  await expect(trigger).toHaveText('Trigger', { timeout: 20_000 })
  await expect(trigger).toHaveAttribute('data-trigger-count', '2', { timeout: 20_000 })
  await expect(trigger).toHaveAttribute('title', /Narrow header watch[\s\S]*Narrow header second watch|Narrow header second watch[\s\S]*Narrow header watch/)
  // Still one Trigger label: the count and the row did not change.
  const still = await settleAt(page, panel, 260)
  expectInsidePanel(still, '260px with two triggers')
  expect(still.titleRow.pillCount).toBe(narrow.titleRow.pillCount)

  const wide = await settleAt(page, panel, null)
  expectInsidePanel(wide, 'wide with two triggers')
  expect(errors).toEqual([])
})
