/**
 * What a trigger DOES, in the words of whoever set it up, on every surface a
 * user meets it: the task's TRIGGER pill (hover text + flyout), the Routines
 * card, and the routine form, plus the composer "+" menu row that starts a
 * message with /walnut-trigger.
 *
 * Triggers are created through POST /api/v1/routines/trigger, the call an agent
 * makes, so the description rides the real create path. A trigger with no
 * description (made before it was required) must render exactly as before.
 *
 * Run in WebKit too (PW_WEBKIT=1 … --project webkit): the Mac app is a
 * WKWebView, and the flyout's three-line clamp is the part WebKit can get wrong.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from './shortcut-test-fixture'
import type { Locator, Page } from '@playwright/test'
import { openDraft, draftPanel } from './draft-helpers'
import {
  startSessionAt, openPanels, openPlusMenu, composerTextarea, plusButton,
} from './engine-settings-popover-helpers'

const API = `http://localhost:${process.env.PW_TEST_PORT ?? 3457}`
const SHOTS = '/tmp/trigger-description'

// A cold fixture (Vite compiling the home chunks under load) can take over a
// minute to draw the task panel, so the budget covers a cold first load.
test.describe.configure({ timeout: 180_000 })

// Long enough to need more than three lines in the flyout, so the clamp is real.
const LONG = 'Checks the release pipeline every 5 minutes for a failed stage or a stage stuck '
  + 'longer than an hour; when one appears, the session reads the failing step\'s log, '
  + 'retries it once if the failure looks transient, and otherwise writes up the cause '
  + 'with the exact error line and the commit that introduced it, then pings the owner.'

async function shot(target: Page | Locator, name: string): Promise<void> {
  await fs.mkdir(SHOTS, { recursive: true })
  // Menus slide in with an opacity animation; shoot the settled frame.
  await target.screenshot({ path: `${SHOTS}/${name}-${test.info().project.name}.png`, animations: 'disabled' })
}

async function createTask(title: string): Promise<{ id: string; title: string }> {
  const uniqueTitle = `${title} ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const res = await fetch(`${API}/api/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: uniqueTitle, source: 'local', project: 'Work' }),
  })
  if (!res.ok) throw new Error(`task create failed: ${res.status} ${await res.text()}`)
  return ((await res.json()) as { task: { id: string; title: string } }).task
}

/** The agent's create call: description included, as trigger_create now requires. */
async function createDescribedTrigger(taskId: string, name: string, description: string): Promise<{ id: string }> {
  const res = await fetch(`${API}/api/v1/routines/trigger`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name, description, run: `echo '{"fire": false}'`, every: '5m', prompt: 'Read the new items.', session: taskId,
    }),
  })
  if (res.status !== 201) throw new Error(`trigger create failed: ${res.status} ${await res.text()}`)
  return ((await res.json()) as { job: { id: string } }).job
}

/** A trigger from before descriptions existed: no description field at all. */
async function createLegacyTrigger(taskId: string, name: string): Promise<{ id: string }> {
  const res = await fetch(`${API}/api/routines`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      schedule: { kind: 'every', everyMs: 300_000 },
      check: { run: `echo '{"fire": false}'`, host: '__local__' },
      executor: { type: 'session', config: { target: taskId, prompt: 'Read the new items.' } },
    }),
  })
  if (!res.ok) throw new Error(`trigger create failed: ${res.status} ${await res.text()}`)
  return ((await res.json()) as { job: { id: string } }).job
}

async function getRoutine(id: string): Promise<any | null> {
  const res = await fetch(`${API}/api/routines/${id}`)
  return res.ok ? ((await res.json()) as { job: any }).job : null
}

function taskRow(page: Page, title: string): Locator {
  return page.locator('.todo-panel-item, .todo-pinned-card, .todo-focus-card').filter({ hasText: title })
}

test('the pill, the flyout and the Routines card say what each trigger does; the form edits it', async ({ page }) => {
  const { isolateUiPrefs, presetPanelView, showEverything } = await import('./todo-panel-helpers')
  await isolateUiPrefs(page)
  await presetPanelView(page, { section: 'all', project: '' })
  const task = await createTask('PW trigger description task')
  const stamp = `${Date.now()}`
  const made: string[] = []
  try {
    const described = await createDescribedTrigger(task.id, `PW described ${stamp}`, LONG)
    made.push(described.id)
    made.push((await createLegacyTrigger(task.id, `PW legacy ${stamp}`)).id)
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    await expect(page.locator('.todo-panel')).toBeVisible({ timeout: 90_000 })
    await showEverything(page)
    const row = taskRow(page, task.title)
    const pill = row.getByTestId('task-trigger-pill')
    await expect(pill).toHaveText('TRIGGER ×2', { timeout: 15_000 })
    // Hover text: the description right after the name; the legacy line as before.
    const title = (await pill.getAttribute('title')) ?? ''
    expect(title).toContain(`PW described ${stamp}: ${LONG} · Every 5 min, $ echo`)
    expect(title).toContain(`PW legacy ${stamp}: Every 5 min, $ echo`)

    await pill.click()
    const flyout = page.getByTestId('trigger-jobs-flyout')
    await expect(flyout).toBeVisible()
    const describedRow = flyout.locator('.trigger-jobs-row', { hasText: `PW described ${stamp}` })
    const legacyRow = flyout.locator('.trigger-jobs-row', { hasText: `PW legacy ${stamp}` })
    const text = describedRow.locator('.trigger-jobs-description')
    await expect(text).toHaveText(LONG)
    // The whole text is on hover even though only three lines show.
    await expect(text).toHaveAttribute('title', LONG)
    // Sits under the heading (name + cadence), above the check command.
    const [headBox, textBox, runBox] = await Promise.all([
      describedRow.locator('.trigger-jobs-heading').boundingBox(),
      text.boundingBox(),
      describedRow.locator('.trigger-jobs-run').boundingBox(),
    ])
    expect(textBox!.y).toBeGreaterThanOrEqual(headBox!.y + headBox!.height - 1)
    expect(runBox!.y).toBeGreaterThanOrEqual(textBox!.y + textBox!.height - 1)
    // Exactly three 18px lines, the rest clipped (WebKit included).
    const clamp = await text.evaluate((el) => ({
      height: el.getBoundingClientRect().height, scroll: el.scrollHeight, client: el.clientHeight,
    }))
    expect(clamp.height).toBeGreaterThan(53)
    expect(clamp.height).toBeLessThan(55.5)
    expect(clamp.scroll).toBeGreaterThan(clamp.client)
    // A trigger with no description draws no empty line.
    await expect(legacyRow).toBeVisible()
    await expect(legacyRow.locator('.trigger-jobs-description')).toHaveCount(0)
    const box = await flyout.boundingBox()
    const viewport = page.viewportSize()!
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width)
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height)
    await shot(flyout, 'flyout')
    await page.keyboard.press('Escape')
    await expect(flyout).toBeHidden()

    // The Routines card shows the whole description; the legacy card nothing extra.
    await page.getByTestId('sidebar-core-app-routines').click()
    await expect(page.locator('.page-title')).toContainText('Routines')
    const card = page.locator('.routine-list .routine-card', { hasText: `PW described ${stamp}` }).first()
    const legacyCard = page.locator('.routine-list .routine-card', { hasText: `PW legacy ${stamp}` }).first()
    await expect(card.locator('.routine-card-description')).toHaveText(LONG)
    await expect(legacyCard).toBeVisible()
    await expect(legacyCard.locator('.routine-card-description')).toHaveCount(0)
    await shot(card, 'card')

    // Edit: the field opens with the stored text; a new one replaces it.
    const before = await getRoutine(described.id)
    await card.locator('.cron-menu-btn').click()
    await card.getByRole('button', { name: 'Edit' }).click()
    const form = page.locator('.routine-modal')
    const field = form.locator('#routine-description')
    await expect(field).toHaveValue(LONG)
    await shot(form, 'form')
    // Non-ASCII test data (Latin accents + CJK), written as escapes.
    const edited = 'Watches the caf\u00e9 order feed for \u65b0\u8ba2\u5355 and files each one.'
    await field.fill(edited)
    await form.getByRole('button', { name: 'Save' }).click()
    await expect(form).toBeHidden()
    await expect(card.locator('.routine-card-description')).toHaveText(edited)
    await expect.poll(async () => (await getRoutine(described.id))?.description).toBe(edited)
    const after = await getRoutine(described.id)
    // Only the words changed: the check, cadence and target are what they were.
    expect(after.check).toEqual(before.check)
    // The form re-sends the schedule, which restamps its anchor (as every form
    // save always has); the daemon runs a check job on everyMs alone.
    expect({ kind: after.schedule.kind, everyMs: after.schedule.everyMs })
      .toEqual({ kind: before.schedule.kind, everyMs: before.schedule.everyMs })
    expect(after.executor).toEqual(before.executor)

    // Cleared in the form: gone from the card and from the stored routine.
    await card.locator('.cron-menu-btn').click()
    await card.getByRole('button', { name: 'Edit' }).click()
    await expect(field).toHaveValue(edited)
    await field.fill('')
    await form.getByRole('button', { name: 'Save' }).click()
    await expect(form).toBeHidden()
    await expect(card.locator('.routine-card-description')).toHaveCount(0)
    await expect.poll(async () => (await getRoutine(described.id))?.description ?? null).toBeNull()

    // Back on Home, the flyout follows the edit without a reload.
    await page.getByTestId('sidebar-core-app-home').click()
    await expect(pill).toBeVisible({ timeout: 15_000 })
    await pill.click()
    await expect(flyout).toBeVisible()
    await expect(flyout.locator('.trigger-jobs-row')).toHaveCount(2)
    await expect(flyout.locator('.trigger-jobs-description')).toHaveCount(0)
  } finally {
    for (const id of made) await fetch(`${API}/api/routines/${id}`, { method: 'DELETE' }).catch(() => {})
    await fetch(`${API}/api/tasks/${task.id}`, { method: 'DELETE' }).catch(() => {})
  }
})

const CMD = '/walnut-trigger'
const triggerRow = (menu: Locator): Locator =>
  menu.locator('button.chat-plus-menu-item[role=menuitem]', { hasText: 'Set up a trigger' })

async function caretAtEnd(box: Locator): Promise<boolean> {
  return await box.evaluate((el) => {
    const t = el as HTMLTextAreaElement
    return t.selectionStart === t.value.length && t.selectionEnd === t.value.length
  })
}

test('"Set up a trigger" in the composer + menu starts the message with /walnut-trigger', async ({ page, request }) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'pw-trigger-row-'))
  const sid = await startSessionAt(request, cwd)
  const [panel] = await openPanels(page, [sid])
  const box = composerTextarea(panel)

  // Typed first: that text becomes what the command is about.
  await box.click()
  await box.fill('tell me when the nightly build goes red')
  const menu = await openPlusMenu(panel)
  await expect(triggerRow(menu)).toBeVisible()
  await shot(menu, 'plus-menu')
  await triggerRow(menu).click()
  await expect(menu).toBeHidden()
  await expect(box).toHaveValue(`${CMD} tell me when the nightly build goes red`)
  await expect(box).toBeFocused()
  expect(await caretAtEnd(box)).toBe(true)
  // The trailing space means the slash palette is not asking which command.
  await expect(panel.locator('.command-palette')).toHaveCount(0)

  // Chosen again: nothing doubles.
  await triggerRow(await openPlusMenu(panel)).click()
  await expect(box).toHaveValue(`${CMD} tell me when the nightly build goes red`)

  // From empty: the command and a space, then the user keeps typing.
  await box.fill('')
  await triggerRow(await openPlusMenu(panel)).click()
  await expect(box).toHaveValue(`${CMD} `)
  await page.keyboard.type('watch PR 123')
  await expect(box).toHaveValue(`${CMD} watch PR 123`)
  await expect(panel.locator('.command-palette')).toHaveCount(0)
  await shot(panel.locator('.chat-input-container'), 'composer-armed')
  await box.fill('')

  // The draft column has the same row.
  await openDraft(page)
  const draft = draftPanel(page)
  await expect(plusButton(draft)).toBeVisible()
  const draftBox = composerTextarea(draft)
  await draftBox.click()
  await draftBox.fill('watch the deploy')
  await triggerRow(await openPlusMenu(draft)).click()
  await expect(draftBox).toHaveValue(`${CMD} watch the deploy`)
  // The session's composer was not touched by the draft's row.
  await expect(box).toHaveValue('')
})
