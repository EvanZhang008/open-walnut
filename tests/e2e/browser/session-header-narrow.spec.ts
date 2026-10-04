/**
 * A narrow session column keeps both header rows on one line (2026-10-02 report:
 * three columns side by side, or the Mac app zoomed in, wrapped the tool row one
 * chip per line, drew the window buttons over the chips, and ran the title row's
 * pills past the panel edge over the phase circle).
 *
 * Real density: the header carries the pills a busy task has (Trigger, Worker,
 * Leader · 1), the status badge and the kebab, on a real session on the fixture
 * server. The column is clamped to the widths the report showed (400 → 180px);
 * at each one every row is a single line inside the panel, the hidden chips sit
 * in a "..." menu that opens them, the hidden window buttons sit in the kebab,
 * the pills fold to letters without losing their text, and a widened column
 * gets everything back.
 */
import fs from 'node:fs/promises'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { REAL_PANEL, draftComposer, openDraftOnCwd } from './draft-helpers'
import { clampColumn } from './composer-controls-overflow-helpers'

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
  await api('PATCH', `/api/tasks/${taskId}`, { title: 'Pulse orphan EventsCrd manual cleanup across the fleet' })
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
  titleRow: { lines: number; fit: string; hiddenPills: string; overflowBy: number; titleWidth: number; pillsStartAfterTitle: boolean }
  letters: Record<string, string>
  statusLabelVisible: boolean
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
    const letters: Record<string, string> = {}
    for (const [key, sel] of Object.entries({ trigger: '.task-trigger-pill', worker: '.todo-item-subtask-pill', leader: '.todo-item-leader-pill' })) {
      const el = meta.querySelector(sel)
      if (!el) continue
      const after = getComputedStyle(el, '::after').content
      const longShown = el.querySelector('.task-pill-long') ? getComputedStyle(el.querySelector('.task-pill-long')!).display !== 'none' : true
      letters[key] = longShown ? `text:${(el.textContent ?? '').trim()}` : `after:${after.replace(/"/g, '')}`
    }
    const label = meta.querySelector<HTMLElement>('.session-panel-badge:not([data-header-pill="embedded"]) .session-badge-label')
    const titleRowEls = [...header.querySelector('.session-panel-header-top')!.children]
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
        fit: meta.dataset.fit ?? '',
        hiddenPills: meta.dataset.hiddenPills ?? '',
        overflowBy: overflow(metaKids),
        titleWidth: Math.round(titleBox.width),
        pillsStartAfterTitle: metaKids.every((el) => el.getBoundingClientRect().left >= titleBox.right - 1),
      },
      letters,
      // The word is kept for readers at the compact levels (1px, clipped): "shown" means it takes room on the row.
      statusLabelVisible: label ? label.getBoundingClientRect().width > 2 : false,
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
  expect(state.titleRow.lines, `${label}: the title row wrapped`).toBeLessThanOrEqual(1)
  expect(state.titleRow.overflowBy, `${label}: the title row runs past the panel`).toBeLessThanOrEqual(0)
  expect(state.titleRow.pillsStartAfterTitle, `${label}: a pill overlaps the title`).toBe(true)
  expect(state.toolRow.visible, `${label}: close must stay`).toContain('close')
  expect(state.toolRow.visible, `${label}: expand must stay`).toContain('expand')
  expect(state.toolRow.visible, `${label}: pin must stay`).toContain('lock')
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

/** The order the chips leave the tool row, first to go first. Pin, Expand and Close never leave. */
const CHIP_LEAVE_ORDER = ['terminal', 'board', 'files', 'changed', 'fork']
const WINDOW_BUTTONS = ['locate', 'popout']
/** The chips a "..." row stands in for (the heavy pill is one too, when a session wears it). */
const VIEW_CHIPS = ['changed', 'files', 'board', 'terminal', 'resources']
/** Everything the "..." menu lists: the time is the one hidden item it does not. */
const LISTED = [...VIEW_CHIPS, ...WINDOW_BUTTONS]

/** The rules every width must obey, whatever the exact pixel widths of the chips. */
function expectRules(state: HeaderState, label: string) {
  expectInsidePanel(state, label)
  const hidden = new Set(state.toolRow.hidden)
  // The chips leave in order (Terminal first, Fork last). A window button fills whatever room they
  // leave, so it may sit on the row beside a hidden chip (2026-10-04).
  const chips = CHIP_LEAVE_ORDER.filter((id) => hidden.has(id) || state.toolRow.visible.includes(id))
  const firstVisibleChip = chips.findIndex((id) => !hidden.has(id))
  if (firstVisibleChip >= 0) {
    for (const id of chips.slice(firstVisibleChip)) expect(hidden.has(id), `${label}: ${id} left before a chip that leaves sooner`).toBe(false)
  }
  const listedHidden = LISTED.some((id) => hidden.has(id))
  expect(state.moreVisible, `${label}: the "..." chip shows exactly when it has something to list`).toBe(listedHidden)
  expect(state.statusLabelVisible, `${label}: the status word shows only at the full level`).toBe(state.titleRow.fit === 'full')
  const letters = state.titleRow.fit === 'letters'
  for (const [kind, text] of Object.entries(state.letters)) {
    if (state.titleRow.hiddenPills.split(' ').includes(kind)) continue
    expect(text.startsWith(letters ? 'after:' : 'text:'), `${label}: ${kind} pill reads ${text} at level ${state.titleRow.fit}`).toBe(true)
  }
  if (state.titleRow.hiddenPills) expect(letters, `${label}: pills hide only after the letter level`).toBe(true)
}

/** Narrower never shows a chip that wider hid (a window button can return where a chip left). */
function expectMonotonic(wider: HeaderState, narrower: HeaderState, label: string) {
  for (const id of wider.toolRow.hidden.filter((h) => CHIP_LEAVE_ORDER.includes(h))) expect(narrower.toolRow.hidden, `${label}: ${id} came back`).toContain(id)
  const rank = { full: 0, dot: 1, letters: 2 } as Record<string, number>
  expect(rank[narrower.titleRow.fit], `${label}: the title row stepped back up`).toBeGreaterThanOrEqual(rank[wider.titleRow.fit])
}

test('a narrow column keeps both header rows on one line, from 400px down to 180px', async ({ page }) => {
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
  for (const pill of ['Trigger', 'Worker', 'Leader']) {
    await expect(meta.getByText(new RegExp(pill, 'i')).first()).toBeVisible({ timeout: 20_000 })
  }
  await expect(meta.locator('.session-panel-badge .session-badge-label')).toHaveText(/Idle|Running/, { timeout: 20_000 })

  // Wide: today's header, untouched. Every chip and button on the row, full words.
  const wide = await settleAt(page, panel, null)
  expectRules(wide, 'wide')
  expect(wide.toolRow.hidden).toEqual([])
  expect(wide.titleRow.fit).toBe('full')
  expect(wide.letters.worker).toBe('text:Worker')
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
  // buttons too); Pin, Expand and Close stay at every width.
  expect(states[400].toolRow.hidden).toContain('popout')
  expect(['changed', 'files', 'board', 'terminal'].every((id) => states[400].toolRow.visible.includes(id)), `400px: ${states[400].toolRow.visible}`).toBe(true)
  // 240px cannot hold five chips; 180px holds Fork and little else.
  expect(states[240].toolRow.hidden).toEqual(expect.arrayContaining(['terminal']))
  expect(states[180].toolRow.hidden).toEqual(expect.arrayContaining(['files', 'board', 'terminal']))
  expect(states[180].toolRow.visible[0]).toBe('fork')
  // The pills read as letters by 240px, and the words are still there for readers and tests.
  expect(states[240].titleRow.fit).toBe('letters')
  await expect(meta.locator('[data-testid="subtask-pill"]')).toHaveText('Worker')
  await expect(meta.locator('[data-testid="leader-pill"]')).toHaveText('Leader · 1')
  await expect(meta.locator('[data-testid="task-trigger-pill"]')).toHaveText('TRIGGER')
  expect(states[180].titleRow.titleWidth).toBeGreaterThanOrEqual(40)

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
  await expect(more.getByTestId('session-header-more-item-expand')).toHaveCount(0)
  const moreRows = await more.locator('[role="menuitem"]').evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')!.replace('session-header-more-item-', '')))
  expect(moreRows.slice(-2), 'window buttons come after the views').toEqual(['locate', 'popout'])
  await shootHeader(panel, '180-more', 220)
  await more.getByTestId('session-header-more-item-files').click()
  await expect(more).toHaveCount(0)
  await expect(panel.locator('[data-header-id="files"]')).toHaveClass(/session-action-chip-active/, { timeout: 10_000 })
  await expect(panel.locator('[data-header-id="files"]')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(panel.locator('[data-header-id="files"]')).not.toHaveClass(/session-action-chip-active/, { timeout: 10_000 })
  const back180 = await settleAt(page, panel, 180)
  expect(back180.toolRow.hidden).toEqual(states[180].toolRow.hidden)

  // The kebab lists only the title row's own overflow: any pill that did not fit even as a
  // letter. No window button from the row above.
  await meta.locator('.task-kebab-btn').click()
  const kebab = page.locator('.task-kebab-menu').last()
  await expect(kebab.locator('[data-testid^="session-header-kebab-pill-"]').first()).toBeVisible()
  await expect(kebab.getByText(/Locate task|Pin panel|Open in new tab/)).toHaveCount(0)
  const hiddenPills180 = states[180].titleRow.hiddenPills.split(' ').filter(Boolean)
  expect(hiddenPills180, '180px cannot hold three letter pills beside a title').toContain('trigger')
  for (const kind of hiddenPills180) {
    await expect(kebab.getByTestId(`session-header-kebab-pill-${kind}`)).toBeVisible()
  }
  await shootHeader(panel, '180-kebab', 220)
  // A hidden pill's row brings the pill back and opens it: the Trigger flyout anchors to a real box.
  await kebab.getByTestId('session-header-kebab-pill-trigger').click()
  await expect(page.getByTestId('trigger-jobs-flyout')).toBeVisible({ timeout: 10_000 })
  await expect(meta.locator('[data-testid="task-trigger-pill"]')).toBeVisible()
  await shootHeader(panel, '180-trigger-pinned')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('trigger-jobs-flyout')).toHaveCount(0, { timeout: 10_000 })

  // 320px: something is in the "..." menu while the pills are still on the row; Pin and Expand
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
  expect(wideAgain.titleRow.fit).toBe('full')
  expect(wideAgain.titleRow.hiddenPills).toBe('')
  expect(wideAgain.statusLabelVisible).toBe(true)
  await expect(meta.locator('[data-testid="leader-pill"] .task-pill-long')).toBeVisible()
  expect(errors).toEqual([])
})

test('a second trigger while narrow keeps the single letter; the count returns with the width', async ({ page }) => {
  test.setTimeout(180_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await openHome(page)
  await openDraftOnCwd(page, `${fixtureRoot}/projects/walnut`)
  const { taskId, sessionId } = await quickStart(page, draftComposer(page), 'snapshot-clean-turn:Narrow header second turn finished')
  const panel = page.locator(`${REAL_PANEL}[data-session-id="${sessionId}"]`)
  await expect(panel.getByText('Narrow header second turn finished', { exact: true }).first()).toBeVisible({ timeout: 30_000 })
  await dressAsBusyTask(taskId)
  const trigger = panel.locator('.session-panel-title-meta [data-testid="task-trigger-pill"]')
  await expect(trigger).toHaveText('TRIGGER', { timeout: 20_000 })

  const narrow = await settleAt(page, panel, 260)
  expect(narrow.titleRow.fit).toBe('letters')
  expect(narrow.titleRow.hiddenPills.split(' ')).not.toContain('trigger')
  const second = await api<{ job: { id: string } }>('POST', '/api/v1/routines/trigger', {
    name: 'Narrow header second watch', description: 'A second trigger, so the pill counts.',
    run: `echo '{"fire": false}'`, every: '5m', prompt: 'Nothing to do.', session: taskId,
  })
  litterRoutines.push(second.job.id)
  await expect(trigger).toHaveText('TRIGGER ×2', { timeout: 20_000 })
  const still = await settleAt(page, panel, 260)
  expectInsidePanel(still, '260px with two triggers')
  expect(still.letters.trigger).toBe('after:T')
  await expect(trigger).toHaveAttribute('title', /Narrow header watch[\s\S]*Narrow header second watch|Narrow header second watch[\s\S]*Narrow header watch/)

  const wide = await settleAt(page, panel, null)
  expect(wide.titleRow.fit).toBe('full')
  expect(wide.letters.trigger).toBe('text:TRIGGER ×2')
  expect(errors).toEqual([])
})
