/**
 * The side panel's Ask and its Tasks view through the real extension (packages/browser-extension/src/
 * sidepanel.ts, web/src/popout/PopoutExtPanel.tsx and PopoutExtTasks.tsx), for what the first
 * review found:
 *
 * - Ask is a plain chat about the page: no Start Task fork, no session header (Changed, Files,
 *   Terminal), no mode or model pills, no red composer, and a live turn reads "Walnut is thinking".
 * - The person's own question stays on screen after "Let Walnut act in this tab" goes on and off,
 *   and after the panel opens again.
 * - A selection made while a conversation is open shows in its composer and goes with the next
 *   message; the sent bubble shows it as a small quote under it, also after a reopen; × leaves it out.
 * - Tasks never says "Nothing needs you" before it knows; opened again it shows the lists of last
 *   time while it loads; Focus is above Needs you; an open row shows what the task last said; a page
 *   saved as a task links to it.
 */
import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { askView, openPanel, openView, pageChip, selectText, startPanelLab, sw, tasksView, type PanelLab } from './extension-panel-harness'

test.describe.configure({ mode: 'serial' })

let lab: PanelLab
let panel: Page
let askSession = ''
const SHOTS = process.env.PANEL_SHOTS_DIR ?? ''
const shot = async (p: Page, name: string) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await p.screenshot({ path: path.join(SHOTS, `${name}.png`) }) } }

test.beforeAll(async ({}, info) => {
  test.setTimeout(240_000)
  lab = await startPanelLab(String(info.project.use.baseURL ?? 'http://localhost:3457'), 'ask')
})
test.afterAll(async () => { await lab?.close() })

/** The session's rows as history shows them. */
async function rows(sid: string): Promise<Array<{ role: string; text: string; hints?: Array<{ kind: string; text: string }> }>> {
  const r = await (await lab.doc.request.get(`${lab.base}/api/sessions/${sid}/history`)).json()
  return (Array.isArray(r) ? r : r.messages ?? []) as Array<{ role: string; text: string; hints?: Array<{ kind: string; text: string }> }>
}
/** What the CLI received for the message with these words (the mock echoes it for `echo-input`). */
async function received(sid: string, words: string): Promise<string> {
  let raw = ''
  await expect.poll(async () => {
    raw = (await rows(sid)).find((r) => r.role === 'assistant' && r.text.includes(words))?.text ?? ''
    return raw.length > 0
  }, { timeout: 30_000 }).toBe(true)
  return raw
}
const bubble = (words: string) => askView(panel).locator('.session-msg-user').filter({ hasText: words })

test('Ask is a plain chat about the page, before and after the first question', async () => {
  test.setTimeout(150_000)
  await selectText(lab.doc, 'p1')
  ;({ panel } = await openPanel(lab, 'ask'))
  const v = askView(panel)
  await expect(v.getByTestId('ask-object-quote')).toContainText('retries a failed upload three times', { timeout: 60_000 })
  // No coding-session fork, no draft header: a composer about the page.
  await expect(v.locator('.draft-intent-cards')).toHaveCount(0)
  await expect(v.getByText('Start Task')).toHaveCount(0)
  await expect(v.locator('.draft-session-panel .session-panel-header')).toHaveCount(0)
  // No Start Task bar (folder, project, task fields): only the mode and model pills (2026-11-09).
  await expect(v.locator('.draft-actions-bar:not(.is-plain-chat-pickers)')).toHaveCount(0)
  await expect(v.locator('.is-plain-chat-pickers .draft-model-select')).toBeVisible()
  const composer = v.locator('[data-testid="ask-object-compose"] textarea')
  await expect(composer).toHaveAttribute('placeholder', 'Ask a quick question, or have it do something here…')
  await shot(panel, 'd12-compose')

  await composer.fill('slow:2500 Summarize the selected text')
  await composer.press('Enter')
  const session = v.getByTestId('ask-object-session')
  await expect(session).toBeVisible({ timeout: 60_000 })
  askSession = (await session.getAttribute('data-session-id')) ?? ''
  // The live turn says Walnut is thinking, never which coding engine works.
  await expect(v.getByText('Walnut is thinking…')).toBeVisible({ timeout: 20_000 })
  await expect(v.getByText(/is working…/)).toHaveCount(0)
  await shot(panel, 'd12-thinking')
  await expect(v.getByText('Hello! I processed your message', { exact: false }).first()).toBeVisible({ timeout: 60_000 })
  // None of a coding session's controls are on screen.
  for (const word of ['Changed', 'Files', 'Terminal']) await expect(v.locator('.session-action-chip', { hasText: word })).toBeHidden()
  // Its mode and model are picked here as in every composer (2026-11-09, the user: "why can't i choose
  // model, and mode etc"), and nothing else of a session's controls row (reply style, side thread, note).
  await expect(v.locator('.is-plain-chat-pickers .mode-toggle-pill')).toHaveCount(1)
  await expect(v.locator('.is-plain-chat-pickers .composer-model-pill')).toHaveCount(1)
  await expect(v.locator('.mode-toggle-pill:not(.is-plain-chat-pickers *)')).toHaveCount(0)
  await expect(v.locator('.side-question-pill, .output-mode-pill, .session-notes-pill')).toHaveCount(0)
  // Its task is handed back to the person (unread), yet the composer is not drawn red.
  await expect(v.locator('.session-panel-unread')).toHaveCount(0)
  await expect(v.locator('.session-panel.is-plain-chat textarea')).toHaveAttribute('placeholder', 'Ask a follow-up…')
  // What the first question took from the page shows under it.
  await expect(bubble('Summarize the selected text').first()).toBeVisible()
  await expect(v.getByTestId('ext-panel-attached').first()).toContainText('retries a failed upload three times', { timeout: 30_000 })
  // The selection that went with it is not offered again for the next message.
  await expect(v.getByTestId('ext-panel-selection')).toHaveCount(0)
  await shot(panel, 'd12-reply')
})

test('the person\'s question stays after acting in the tab goes on and off, and after a reopen', async () => {
  test.setTimeout(120_000)
  const v = askView(panel)
  await v.getByTestId('ext-panel-act').check()
  await expect(v.getByTestId('ext-panel-act')).toBeChecked()
  // Acting in the tab is that tab only: the note says so (the browser-wide agents switch stays as it was).
  await expect(v.getByTestId('ext-panel-act')).toHaveAttribute('title', /^Walnut's agents may act in this tab only, until you take it back\./)
  await expect(bubble('Summarize the selected text').first()).toBeVisible()
  await v.getByTestId('ext-panel-act').uncheck()
  await expect(bubble('Summarize the selected text').first()).toBeVisible()
  // Turning it off is the person's choice, not a failure: no error line.
  await panel.waitForTimeout(800)
  await expect(v.getByText('Taken back.')).toHaveCount(0)
  await panel.close()
  ;({ panel } = await openPanel(lab, 'ask'))
  // The same conversation comes back. (The fixture's mock CLI keeps no transcript, so a reopened
  // conversation has no saved row of the person's words to show here; with the real CLI it does,
  // and its quote is read from the row's hint: tests/web/ext-panel-attached-hint.test.ts.)
  await expect(askView(panel).getByTestId('ask-object-session')).toHaveAttribute('data-session-id', askSession, { timeout: 60_000 })
  await expect(askView(panel).getByText('Hello! I processed your message', { exact: false }).first()).toBeVisible({ timeout: 30_000 })
  // The page still holds the selection the first question took: reopened, it is not offered again.
  await expect(askView(panel).getByTestId('ext-panel-selection')).toHaveCount(0)
  // Acting on again in the reopened panel keeps the conversation on screen too.
  await askView(panel).getByTestId('ext-panel-act').check()
  await expect(askView(panel).getByText('Hello! I processed your message', { exact: false }).first()).toBeVisible()
  await askView(panel).getByTestId('ext-panel-act').uncheck()
  await shot(panel, 'd13-after-reopen-and-act')
})

test('a selection made in an open conversation goes with the next message, as a quote under it', async () => {
  test.setTimeout(150_000)
  const v = askView(panel)
  await selectText(lab.doc, 'p2')
  const chip = v.getByTestId('ext-panel-selection')
  await expect(chip).toContainText('Dark mode follows the system setting', { timeout: 15_000 })
  await shot(panel, 'd14-chip')
  const composer = v.locator('.ask-object-session textarea')
  await composer.fill('What does this mean? echo-input')
  await composer.press('Enter')
  await expect(chip).toHaveCount(0, { timeout: 10_000 })
  const raw = await received(askSession, 'What does this mean?')
  // The selection rides as Walnut's hint; the person's words are as they typed them.
  expect(raw).toMatch(/<system-reminder>[\s\S]*Dark mode follows the system setting[\s\S]*<\/system-reminder>/)
  expect(raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')).not.toContain('Dark mode follows')
  // Acting in the tab was turned on and off again before this message: it must not say the ask may act.
  expect(raw).not.toContain('They let you act in this tab')
  const sent = v.locator('.session-msg-user').filter({ hasText: 'What does this mean?' }).first()
  await expect(sent.getByTestId('ext-panel-attached')).toContainText('Dark mode follows the system setting', { timeout: 30_000 })
  await shot(panel, 'd14-sent')
  // The same selection, already sent, is not offered again (also after a reopen). A reopened
  // conversation's saved row shows the quote from its hint (tests/web/ext-panel-attached-hint.test.ts;
  // the fixture's mock CLI keeps no transcript to reload it from).
  await expect(v.getByTestId('ext-panel-selection')).toHaveCount(0)
  // Cleared on the page and the same words selected again: a new selection, offered again (review round 4, L6).
  await lab.doc.evaluate(() => getSelection()?.removeAllRanges())
  await panel.waitForTimeout(800)
  await selectText(lab.doc, 'p2')
  await expect(chip).toContainText('Dark mode follows the system setting', { timeout: 15_000 })
  await v.getByTestId('ext-panel-selection-drop').click()
  await expect(chip).toHaveCount(0)
  await lab.doc.evaluate(() => getSelection()?.removeAllRanges())
})

test('× leaves a selection out of the next message', async () => {
  test.setTimeout(120_000)
  const v = askView(panel)
  await selectText(lab.doc, 'p1')
  const chip = v.getByTestId('ext-panel-selection')
  await expect(chip).toContainText('retries a failed upload', { timeout: 15_000 })
  await v.getByTestId('ext-panel-selection-drop').click()
  await expect(chip).toHaveCount(0)
  const composer = v.locator('.ask-object-session textarea')
  await composer.fill('Anything else? echo-input')
  await composer.press('Enter')
  const raw = await received(askSession, 'Anything else?')
  expect(raw).not.toContain('retries a failed upload')
  const sent = v.locator('.session-msg-user').filter({ hasText: 'Anything else?' }).first()
  await expect(sent).toBeVisible()
  await expect(sent.getByTestId('ext-panel-attached')).toHaveCount(0)
})

// ── Tasks ──

async function taskOfSession(sid: string): Promise<string> {
  const rec = await (await lab.doc.request.get(`${lab.base}/api/v1/sessions/${sid}`)).json() as Record<string, any>
  return String(rec.taskId ?? rec.session?.taskId ?? '')
}

test('Tasks: Focus above Needs you; an open row shows what the task last said; a saved page links to its task', async () => {
  test.setTimeout(120_000)
  const taskId = await taskOfSession(askSession)
  expect(taskId).not.toBe('')
  const patched = await lab.doc.request.patch(`${lab.base}/api/v1/tasks/${taskId}`, { data: { phase: 'NEED_ACTION' } })
  expect(patched.ok(), await patched.text()).toBe(true)
  const made = await lab.doc.request.post(`${lab.base}/api/v1/tasks`, { data: { title: `Panel focus ${Date.now().toString(36)}`, pinned: true, focus_tier: 'focus' } })
  expect(made.ok(), await made.text()).toBe(true)

  await openView(panel, 'tasks')
  const t = tasksView(panel)
  const row = t.locator(`[data-testid="ext-task"][data-task-id="${taskId}"]`)
  await expect(row).toBeVisible({ timeout: 30_000 })
  // Focus comes first, so a long Needs you list never pushes it out of reach.
  const order = await t.locator('[data-testid="ext-tasks-focus"], [data-testid="ext-tasks-needs"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')))
  expect(order).toEqual(['ext-tasks-focus', 'ext-tasks-needs'])
  // Opened, the row shows what the task last said before the reply box.
  await row.locator('.ext-task-head').click()
  await expect(row.getByTestId('ext-task-asked')).toContainText('Hello! I processed your message', { timeout: 30_000 })
  await shot(panel, 'd32-task-open')

  await t.getByTestId('ext-tasks-save-page').click()
  const link = t.getByTestId('ext-tasks-saved-link')
  await expect(link).toHaveText('Release notes 4.2', { timeout: 30_000 })
  const savedId = await t.getByTestId('ext-tasks-saved').getAttribute('data-task-id')
  expect(await link.getAttribute('href')).toBe(`${lab.base}/tasks/${savedId}`)
  expect(await link.getAttribute('target')).toBe('_blank')
  await shot(panel, 'd33-saved-link')
})

test('Tasks opened again: the lists of last time while it loads, never a false "Nothing needs you"', async () => {
  test.setTimeout(120_000)
  await panel.close()
  // The task list answers slowly, as on a busy Walnut.
  let release!: () => void
  const held = new Promise<void>((r) => { release = r })
  await lab.ctx.route(/\/api\/tasks(\?|$)/, async (route) => { await held; await route.continue() })
  try {
    ;({ panel } = await openPanel(lab, 'tasks'))
    const t = tasksView(panel)
    await expect(t.getByTestId('ext-tasks')).toHaveAttribute('data-lists', 'kept', { timeout: 30_000 })
    await expect(t.getByTestId('ext-task').first()).toBeVisible()
    await expect(t.getByTestId('ext-tasks-updating')).toBeVisible()
    await expect(t.getByText('Nothing needs you.')).toHaveCount(0)
    await shot(panel, 'd11-kept')
    // With nothing kept, it says it is loading, not that the lists are empty.
    await t.getByTestId('ext-tasks').evaluate(() => localStorage.removeItem('walnut.ext-tasks.lists'))
    await panel.close()
    ;({ panel } = await openPanel(lab, 'tasks'))
    const t2 = tasksView(panel)
    await expect(t2.getByTestId('ext-tasks-loading')).toBeVisible({ timeout: 30_000 })
    await expect(t2.getByText('Nothing needs you.')).toHaveCount(0)
    await expect(t2.getByText('No Focus tasks.')).toHaveCount(0)
    await shot(panel, 'd11-loading')
    release()
    await expect(t2.getByTestId('ext-tasks')).toHaveAttribute('data-lists', 'fresh', { timeout: 30_000 })
    await expect(t2.getByTestId('ext-task').first()).toBeVisible()
  } finally {
    release()
    await lab.ctx.unroute(/\/api\/tasks(\?|$)/)
  }
})

test('the page is named at once even when it does not answer the panel', async () => {
  test.setTimeout(150_000)
  await panel.close()
  // A page that answers nothing (a frozen renderer, a content script gone after an extension
  // reload): every message the background sends a tab goes unanswered, whatever script it injects.
  const frozen = await sw(lab).evaluate(() => {
    const tabs = chrome.tabs as unknown as { sendMessage: unknown; __realSend?: unknown }
    tabs.__realSend = tabs.sendMessage
    Object.defineProperty(tabs, 'sendMessage', { value: () => new Promise(() => undefined), configurable: true, writable: true })
    return tabs.sendMessage !== tabs.__realSend
  })
  expect(frozen, 'the background now reaches no page').toBe(true)
  // What the Ask view hears, in its own clock: every page it is told, with when.
  await lab.ctx.addInitScript(() => {
    if (!location.search.includes('view=ext-panel')) return
    const log: Array<{ at: number; title: string }> = []
    ;(window as unknown as { __told: typeof log }).__told = log
    window.addEventListener('message', (e) => {
      const d = e.data as { walnut?: string; type?: string; page?: { title?: string } | null } | null
      if (d?.walnut === 'ext-panel' && d.type === 'context') log.push({ at: performance.now(), title: d.page?.title ?? '' })
    })
  })
  ;({ panel } = await openPanel(lab, 'ask'))
  await expect(pageChip(panel)).toContainText('Release notes 4.2', { timeout: 60_000 })
  // The same tab moves to a new address while the view is up: the panel names it by its tab at
  // once, and the page's own answer (it never comes, so the background gives up after its wait)
  // follows seconds later. Measured between those two messages in the view's own clock, so a
  // loaded machine that starts the frame or the panel late does not change the result.
  await lab.doc.evaluate(() => { document.title = 'Release notes 4.3'; history.pushState({}, '', '/notes?v=2') })
  await expect(pageChip(panel)).toContainText('Release notes 4.3', { timeout: 30_000 })
  const frame = panel.frames().find((f) => f.url().includes('view=ext-panel'))!
  const told = () => frame.evaluate(() => (window as unknown as { __told?: Array<{ at: number; title: string }> }).__told ?? [])
  const named = (await told()).find((m) => m.title === 'Release notes 4.3')
  expect(named, 'the view was told the new address by its tab').toBeTruthy()
  // The background gives up on the page after its wait (8 s at least); the name came well before
  // that (2 s of slack for a slow first word on a loaded machine; a name that waited for the page
  // has no gap at all).
  const late = () => told().then((l) => l.some((m) => m.title === 'Release notes 4.3' && m.at - named!.at > 2000))
  await expect.poll(late, { timeout: 45_000, message: 'the page answer came after the name' }).toBe(true)
    .catch(async (e: Error) => { throw new Error(`${e.message}\ntold: ${JSON.stringify(await told())}`) })
  await sw(lab).evaluate(() => {
    const tabs = chrome.tabs as unknown as { sendMessage: unknown; __realSend?: unknown }
    Object.defineProperty(tabs, 'sendMessage', { value: tabs.__realSend, configurable: true, writable: true })
  })
})
