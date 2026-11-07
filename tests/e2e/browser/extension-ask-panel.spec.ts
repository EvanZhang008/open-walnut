/**
 * The extension's side panel and toolbar popup as Walnut's own Ask, with the key in the header
 * (packages/browser-extension/src/panel-ask.ts, key-pop.ts; web/src/popout/PopoutExtPanel.tsx,
 * ExtAskChrome.tsx, ExtPopupBody.tsx), through the real extension in Chromium:
 *
 * - the panel opens on Ask with no tab strip: ≡, the ask's title over the agent, the key (with its
 *   padlock while Passwords is locked) and New chat, all in the first frame; the composer names the
 *   page in a chip; the open conversation stays on another page until New chat or a pick, and New
 *   chat wins over a launch still on its way;
 * - ≡ opens Home's drawer: Main pinned with its line, the asks, New chat, and the foot rows Tasks,
 *   Passwords ("Locked" or this site's count) and Open Walnut; it is an overlay;
 * - the key opens a popover the extension page draws over the frame: locked, one row to unlock;
 *   unlocked, this site's logins with Fill, which fills the page; Escape or a press outside closes it;
 * - Tasks and Passwords open as full views with Back;
 * - the popup opens on Ask with Continue, the key popover and the side panel button, and a question
 *   asked there goes on in the side panel;
 * - a Walnut too old for this shape gets the three tabs, and the popup is the vault popup.
 *
 * Screenshots (D02_SHOTS, default test-results/extension-ask-panel) at the mock's sizes: the panel
 * 400×760, the popup 380×560, light and dark. Fake data only.
 */
import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { askView, backToAsk, openPanel, openView, pageChip, passwordsView, selectText, startPanelLab, sw, tasksView, type PanelLab } from './extension-panel-harness'
import { ensureVaultSetUp, vaultSession, VAULT_MASTER } from './vault-session-helper'
import { holdVaultLock, vaultExclusively } from './vault-lock'

test.describe.configure({ mode: 'serial' })
// It needs its unlocks to hold on the shared fixture vault, where another file may end every unlock.
// Its cleanup's Lock of every window runs alone (vaultExclusively).
holdVaultLock('shared', 'file')

const SHOTS = process.env.D02_SHOTS ?? 'test-results/extension-ask-panel'
let lab: PanelLab
let panel: Page
let askSession = ''
let askTask = ''
let loginTitle = ''
let loginPassword = ''
/** The asks this file seeds (deleted after it), as a person's list holds them. */
const seeded: string[] = []
const SEEDED_ASKS: Array<{ title: string; lastWords?: string; asks?: string }> = [
  { title: 'Compare these two laptops', lastWords: 'Zen 14 wins on battery and weight.' },
  { title: 'Summarize this PR', lastWords: '3 risks, 1 missing test.' },
  { title: 'Draft a reply to Maya about Friday', asks: 'Should the reply say yes to 3 pm?' },
]

async function shot(p: Page, name: string, dark = false): Promise<void> {
  fs.mkdirSync(SHOTS, { recursive: true })
  if (dark) await p.emulateMedia({ colorScheme: 'dark' })
  // The pointer off every control, so no hover shows in the picture.
  await p.mouse.move(399, 400)
  await p.waitForTimeout(250)
  await p.screenshot({ path: path.join(SHOTS, `${name}${dark ? '-dark' : ''}.png`) })
  if (dark) await p.emulateMedia({ colorScheme: 'light' })
}

/** Light and dark, the same state. */
async function shots(p: Page, name: string): Promise<void> {
  await shot(p, name)
  await shot(p, name, true)
}

/** The extension's own unlock goes (its token is in its IndexedDB, secret-store.ts). */
async function lockExtension(): Promise<void> {
  await sw(lab).evaluate(async () => {
    await new Promise<void>((resolve) => {
      const req = indexedDB.open('walnut', 1)
      req.onsuccess = () => { const tx = req.result.transaction('kv', 'readwrite'); tx.objectStore('kv').delete('vaultSession'); tx.oncomplete = () => { req.result.close(); resolve() }; tx.onerror = () => resolve() }
      req.onerror = () => resolve()
    })
    await chrome.storage.session.remove('vaultSession').catch(() => undefined)
  })
}

/** The panel window at the mock's size. */
async function openAskPanel(): Promise<Page> {
  const { panel: p } = await openPanel(lab)
  await p.setViewportSize({ width: 400, height: 760 })
  await expect(askView(p).getByTestId('ext-ask-head')).toBeVisible({ timeout: 60_000 })
  return p
}

const keyPop = (p: Page) => p.getByTestId('key-pop')

/** The session's rows as history shows them. */
async function historyRows(sid: string): Promise<Array<{ role: string; text: string }>> {
  const r = await (await lab.doc.request.get(`${lab.base}/api/sessions/${sid}/history`)).json()
  return (Array.isArray(r) ? r : r.messages ?? []) as Array<{ role: string; text: string }>
}
/** What the CLI received for the message with these words (the mock echoes it for `echo-input`). */
async function received(sid: string, words: string): Promise<string> {
  let raw = ''
  await expect.poll(async () => {
    raw = (await historyRows(sid)).find((r) => r.role === 'assistant' && r.text.includes(words))?.text ?? ''
    return raw.length > 0
  }, { timeout: 30_000 }).toBe(true)
  return raw
}
async function taskOfSession(sid: string): Promise<string> {
  const rec = await (await lab.doc.request.get(`${lab.base}/api/v1/sessions/${sid}`)).json() as Record<string, any>
  return String(rec.taskId ?? rec.session?.taskId ?? '')
}
/** A panel ask is a conversation, not board work: never pinned to a tier (review 2026-11-06). */
async function expectUnpinned(taskId: string): Promise<void> {
  const j = await (await lab.doc.request.get(`${lab.base}/api/v1/tasks/${taskId}`)).json() as Record<string, any>
  const t = (j.task ?? j) as Record<string, unknown>
  expect(t.id).toBe(taskId)
  expect(t.pinned, `task ${taskId} is pinned`).not.toBe(true)
  expect(t.focus_tier ?? null).toBeNull()
}

test.beforeAll(async ({}, info) => {
  test.setTimeout(300_000)
  lab = await startPanelLab(String(info.project.use.baseURL ?? 'http://localhost:3457'), 'ask-panel')
  await ensureVaultSetUp(lab.doc, lab.base, { password: VAULT_MASTER })
  const s = await vaultSession(lab.doc, lab.base, { password: VAULT_MASTER })
  const stamp = Date.now().toString(36)
  loginTitle = `Docs ${stamp}`
  loginPassword = `Key-Pop-${stamp}`
  const made = await lab.doc.request.post(`${lab.base}/api/v1/vault/items`, {
    headers: { 'x-walnut-vault-session': s },
    data: { item: { type: 'login', title: loginTitle, username: 'reader@example.test', password: loginPassword, urls: [lab.site('docs.example.test', '')] } },
  })
  expect(made.ok(), await made.text()).toBe(true)
  await lockExtension()
  // Asks with their own titles and words, as a person's list has them. Their last words are read
  // from a transcript, which the fixture's mock CLI never writes: the fixture route seeds them.
  for (const a of SEEDED_ASKS) {
    const r = await lab.doc.request.post(`${lab.base}/api/v1/tasks`, { data: { title: a.title, project: 'Ask Walnut' } })
    expect(r.ok(), await r.text()).toBe(true)
    const j = await r.json() as Record<string, any>
    const id = String(j.task?.id ?? j.id)
    seeded.push(id)
    if (a.lastWords) expect((await lab.doc.request.post(`${lab.base}/api/test/task-fixture/hand-back`, { data: { taskId: id, lastWords: a.lastWords } })).ok()).toBe(true)
    if (a.asks) {
      const rep = await lab.doc.request.put(`${lab.base}/api/v1/tasks/${id}/report`, { data: { state: 'needs', ask: a.asks } })
      expect(rep.ok(), await rep.text()).toBe(true)
    }
  }
})
test.afterAll(async () => {
  // The unlocks this file made end with it: a later spec's extension must not find one to share.
  if (lab) await vaultExclusively(() => lab.doc.request.post(`${lab.base}/api/v1/vault/lock`, { data: { everywhere: true } }).catch(() => undefined))
  for (const id of [...seeded, askTask].filter(Boolean)) await lab?.doc.request.delete(`${lab.base}/api/v1/tasks/${id}`).catch(() => undefined)
  await lab?.close()
})

test('the panel opens on Ask, with no tab strip; the key wears its padlock', async () => {
  test.setTimeout(150_000)
  panel = await openAskPanel()
  const v = askView(panel)
  await expect(panel.locator('.panel-tabs')).toHaveCount(0)
  await expect(panel.getByTestId('panel-tab-ask')).toHaveCount(0)
  await expect(panel.locator('.panel-shell.is-ask')).toBeVisible()
  await expect(v.getByTestId('ask-walnut-menu')).toBeVisible()
  await expect(v.getByTestId('ext-ask-title')).toHaveText('New chat')
  await expect(v.locator('.ext-ask-agent')).toContainText('Ask Walnut')
  await expect(v.getByTestId('ext-ask-key')).toBeVisible()
  await expect(v.getByTestId('ext-key-locked')).toBeVisible({ timeout: 15_000 })
  await expect(v.getByTestId('ext-panel-new')).toBeVisible()
  // The composer names the page, and it goes with a new chat's first message.
  await expect(pageChip(panel)).toContainText('Release notes 4.2', { timeout: 30_000 })
  await expect(pageChip(panel)).toContainText(`docs.example.test:${lab.port}`)
  await expect(pageChip(panel)).toBeChecked()
  await expect(v.getByTestId('ext-panel-act')).not.toBeChecked()
  await expect(v.locator('[data-testid="ask-object-compose"] textarea')).toHaveAttribute('placeholder', 'Ask Walnut, or ask it to do something here…')
  // A new chat opens as the popup does: the asks to continue, each with what tells it apart.
  const cont = v.getByTestId('ext-continue')
  await expect(cont).toBeVisible({ timeout: 30_000 })
  for (const a of SEEDED_ASKS) {
    const row = cont.locator(`[data-testid="ext-continue-row"][data-task-id="${seeded[SEEDED_ASKS.indexOf(a)]}"]`)
    await expect(row).toContainText(a.title, { timeout: 30_000 })
    await expect(row.locator('.ask-walnut-drawer-item-line')).toHaveText((a.asks ?? a.lastWords)!)
  }
  // A row that needs the person wears the red dot.
  await expect(cont.locator(`[data-testid="ext-continue-row"][data-task-id="${seeded[2]}"]`)).toHaveAttribute('data-needs', 'true')
  // The suggestion chips read whole at 400 px: whole words, no ellipsis and no drawn blank (round 4, #7).
  const chips = v.locator('.draft-walnut-suggests .session-action-chip')
  await expect(chips).toHaveText(['Find a task', 'Schedule my day', 'What ran today'])
  await expect(v.locator('.draft-walnut-suggests .session-action-chip-blank')).toHaveCount(0)
  for (const c of await chips.all()) expect(await c.evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true)
  // What the extension keeps to draw while the frame loads next time: this view itself.
  await expect.poll(async () => {
    const snaps = await sw(lab).evaluate(async () => (await chrome.storage.local.get('panelSnaps')).panelSnaps as Record<string, any> | undefined)
    const a = Object.values((snaps?.ask ?? {}) as Record<string, Record<string, any>>).find((x) => x.askTitle === 'New chat')
    return a ? [a.agent, a.placeholder, (a.cont ?? []).some((r: { title: string }) => r.title === SEEDED_ASKS[0].title), (a.suggestions ?? []).length, a.pageOn] : null
  }, { timeout: 15_000 }).toEqual(['Ask Walnut', 'Ask Walnut, or ask it to do something here…', true, 3, true])
  await shots(panel, 'panel-new-chat')
})

test('a question starts the conversation; its title takes the header', async () => {
  test.setTimeout(150_000)
  const v = askView(panel)
  await v.locator('[data-testid="ask-object-compose"] textarea').fill('What changed for uploads?')
  await v.locator('[data-testid="ask-object-compose"] textarea').press('Enter')
  const session = v.getByTestId('ask-object-session')
  await expect(session).toBeVisible({ timeout: 60_000 })
  askSession = (await session.getAttribute('data-session-id')) ?? ''
  expect(askSession).not.toBe('')
  await expect(v.getByText('Hello! I processed your message', { exact: false }).first()).toBeVisible({ timeout: 60_000 })
  await expect(v.getByTestId('ext-ask-title')).not.toHaveText('New chat', { timeout: 30_000 })
  await expect(v.locator('.session-panel.is-plain-chat textarea')).toHaveAttribute('placeholder', 'Ask a follow-up…')
  // The conversation's Continue list is gone: the chat has the panel.
  await expect(v.getByTestId('ext-continue')).toHaveCount(0)
  // A real ask is named by Walnut's titler after its first message (quick-start's autoTitleFromLaunch,
  // which the fixture's mock CLI does not answer): its write is a task title change, and the header
  // follows it live, with no reload.
  const rec = await (await lab.doc.request.get(`${lab.base}/api/v1/sessions/${askSession}`)).json() as Record<string, any>
  askTask = String(rec.taskId ?? rec.session?.taskId ?? '')
  expect(askTask).not.toBe('')
  await expectUnpinned(askTask)
  expect((await lab.doc.request.patch(`${lab.base}/api/v1/tasks/${askTask}`, { data: { title: 'Uploads in release 4.2' } })).ok()).toBe(true)
  await expect(v.getByTestId('ext-ask-title')).toHaveText('Uploads in release 4.2', { timeout: 15_000 })
  // The page went with the first message: in the same conversation the chip is off for it.
  await expect(pageChip(panel)).not.toBeChecked()
  await expect(v.getByTestId('ext-key-locked')).toBeVisible()
  await shots(panel, 'panel-conversation-locked')
  // Escape in the composer leaves it, never the side panel: the draft stays.
  const follow = v.locator('.session-panel.is-plain-chat textarea')
  await follow.click()
  await follow.fill('half typed')
  await panel.keyboard.press('Escape')
  await panel.waitForTimeout(800)
  expect(panel.isClosed()).toBe(false)
  await expect(follow).toHaveValue('half typed')
  await expect(follow).not.toBeFocused()
  await panel.keyboard.press('Escape')
  await panel.waitForTimeout(400)
  expect(panel.isClosed()).toBe(false)
  await follow.fill('')
  // Its turn handed back with these words: the drawer and Continue rows read them.
  expect((await lab.doc.request.post(`${lab.base}/api/test/task-fixture/hand-back`, { data: { taskId: askTask, lastWords: 'Uploads now retry three times before giving up.' } })).ok()).toBe(true)
})

test('≡ opens the drawer over the chat: Main pinned, the asks, New chat, Tasks, Passwords, Open Walnut', async () => {
  test.setTimeout(120_000)
  const v = askView(panel)
  const chat = v.locator('.ext-panel-chat')
  const before = await chat.boundingBox()
  await v.getByTestId('ask-walnut-menu').click()
  const drawer = v.getByTestId('ask-walnut-drawer')
  await expect(drawer).toBeVisible()
  await expect(v.getByTestId('ask-walnut-drawer-main')).toBeVisible()
  // One name: the CEO row never calls itself "main agent" (the agent list's Walnut is "your main AI").
  await expect(v.getByTestId('ask-walnut-drawer-main-line')).toContainText('Sees all your work:')
  await expect(v.getByTestId('ask-walnut-drawer-item').first()).toBeVisible({ timeout: 30_000 })
  await expect(v.getByTestId('ask-walnut-new')).toBeVisible()
  await expect(v.getByTestId('ask-walnut-search')).toBeVisible()
  await expect(v.getByTestId('ext-drawer-tasks')).toBeVisible()
  await expect(v.getByTestId('ext-drawer-passwords')).toBeVisible()
  await expect(v.getByTestId('ext-drawer-passwords-meta')).toHaveText('Locked')
  await expect(v.getByTestId('ext-drawer-open-walnut')).toBeVisible()
  // An overlay: nothing under it moved.
  expect(await chat.boundingBox()).toEqual(before)
  // Each row's second line tells it apart: the ask's own question, else its last words.
  const lineOf = (id: string) => v.locator(`[data-testid="ask-walnut-drawer-item"][data-task-id="${id}"] .ask-walnut-drawer-item-line`)
  await expect(lineOf(askTask)).toHaveText('Uploads now retry three times before giving up.', { timeout: 15_000 })
  await expect(v.locator(`[data-testid="ask-walnut-drawer-item"][data-task-id="${askTask}"]`)).toContainText('Uploads in release 4.2')
  for (const [i, a] of SEEDED_ASKS.entries()) await expect(lineOf(seeded[i])).toHaveText((a.asks ?? a.lastWords)!)
  // Dark: New chat's words are dark on its light amber.
  await panel.emulateMedia({ colorScheme: 'dark' })
  await expect.poll(() => v.getByTestId('ask-walnut-new').evaluate((e) => getComputedStyle(e).color)).toBe('rgb(31, 29, 27)')
  await panel.emulateMedia({ colorScheme: 'light' })
  await shots(panel, 'panel-drawer')
  // New chat from the drawer, then the ask picked again brings its conversation back.
  await v.getByTestId('ask-walnut-new').click()
  await expect(drawer).toBeHidden()
  await expect(v.getByTestId('ask-object-compose')).toBeVisible({ timeout: 30_000 })
  await expect(v.getByTestId('ext-ask-title')).toHaveText('New chat')
  // The new chat shows the asks to continue, the conversation just left among them.
  await expect(v.locator(`[data-testid="ext-continue-row"][data-task-id="${askTask}"]`)).toBeVisible()
  await v.getByTestId('ask-walnut-menu').click()
  const row = v.locator(`[data-testid="ask-walnut-drawer-item"][data-task-id="${askTask}"]`)
  await expect(row).toBeVisible({ timeout: 30_000 })
  await row.click()
  await expect(v.getByTestId('ask-object-session')).toHaveAttribute('data-session-id', askSession, { timeout: 30_000 })
  // Escape closes it.
  await v.getByTestId('ask-walnut-menu').click()
  await expect(drawer).toBeVisible()
  await panel.keyboard.press('Escape')
  await expect(drawer).toBeHidden()
  // A second Escape right after (the drawer gone) leaves the panel open too.
  await panel.keyboard.press('Escape')
  await panel.waitForTimeout(600)
  expect(panel.isClosed()).toBe(false)
})

test('CEO in the drawer opens Main in the panel, never a Walnut tab', async () => {
  test.setTimeout(150_000)
  const v = askView(panel)
  const pages = lab.ctx.pages().length
  await v.getByTestId('ask-walnut-menu').click()
  await v.getByTestId('ask-walnut-drawer-main').click()
  await expect(v.getByTestId('ask-walnut-drawer')).toBeHidden()
  // Main with a conversation opens it here; Main before its first message opens its composer here.
  const compose = v.getByTestId('ask-object-compose')
  const session = v.getByTestId('ask-object-session')
  await expect(compose.or(session).first()).toBeVisible({ timeout: 30_000 })
  if (await compose.isVisible()) {
    await expect(v.getByTestId('ext-ask-title')).toHaveText('CEO')
    const box = compose.locator('textarea')
    await expect(box).toHaveAttribute('placeholder', 'Ask the CEO, or hand it something to do…')
    await expect(v.getByTestId('ext-continue')).toHaveCount(0)
    await shot(panel, 'panel-ceo-compose')
    // Its question goes to Main's own task. A stand-in answers for Main here, so this shared
    // fixture never gets a real Main from this file.
    const r = await lab.doc.request.post(`${lab.base}/api/v1/tasks`, { data: { title: 'CEO stand-in', project: 'Ask Walnut' } })
    expect(r.ok(), await r.text()).toBe(true)
    const standIn = String(((await r.json()) as Record<string, any>).task?.id)
    seeded.push(standIn)
    await panel.route('**/api/v1/org/main', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ task: { id: standIn, title: 'CEO stand-in' } }) }))
    await box.fill('How are things going?')
    await box.press('Enter')
    await expect(session).toBeVisible({ timeout: 60_000 })
    expect(await taskOfSession((await session.getAttribute('data-session-id')) ?? '')).toBe(standIn)
    await panel.unroute('**/api/v1/org/main')
  }
  // Nothing opened in the person's window.
  await panel.waitForTimeout(500)
  expect(lab.ctx.pages().length).toBe(pages)
})

test('the selection is its own attachment: the page chip leaves out only the page, the quote has its own ×', async () => {
  test.setTimeout(180_000)
  const v = askView(panel)
  await lab.doc.goto(lab.site('docs.example.test', '/notes'))
  await expect(pageChip(panel)).toContainText('Release notes 4.2', { timeout: 30_000 })
  await v.getByTestId('ext-panel-new').click()
  await selectText(lab.doc, 'p1')
  const quote = v.getByTestId('ask-object-quote')
  await expect(quote).toContainText('retries a failed upload three times', { timeout: 15_000 })
  await expect(quote.getByTestId('ask-object-quote-drop')).toBeVisible()
  // × on the page chip: the page goes, the quote stays (and goes with the question).
  await v.getByTestId('ext-panel-page-drop').click()
  await expect(pageChip(panel)).not.toBeChecked()
  await expect(quote).toBeVisible()
  await shot(panel, 'panel-quote-page-left-out')
  const words = 'Explain only the selected words echo-input'
  await v.locator('[data-testid="ask-object-compose"] textarea').fill(words)
  await v.locator('[data-testid="ask-object-compose"] textarea').press('Enter')
  const session = v.getByTestId('ask-object-session')
  await expect(session).toBeVisible({ timeout: 60_000 })
  const sid = (await session.getAttribute('data-session-id')) ?? ''
  const task = await taskOfSession(sid)
  if (task) seeded.push(task)
  const raw = await received(sid, 'Explain only the selected words')
  expect(raw).toContain('retries a failed upload three times')
  expect(raw).toContain('left the page itself out')
  expect(raw).not.toContain("The page's text")
  // Its bubble: the quote, named by its page, and no page chip (the page did not go).
  const sent = v.locator('.session-msg-user').filter({ hasText: 'Explain only the selected words' }).first()
  await expect(sent.getByTestId('ext-panel-attached')).toContainText('retries a failed upload three times', { timeout: 30_000 })
  await expect(sent.locator('.ext-panel-attached figcaption')).toHaveText('From Release notes 4.2')
  await expect(sent.getByTestId('ext-panel-attached-page')).toHaveCount(0)
  // The quote that went is not offered again.
  await expect(v.getByTestId('ext-panel-selection')).toHaveCount(0)
  // A new selection in the conversation: its strip sits inside the composer's rounded card.
  await selectText(lab.doc, 'p2')
  const strip = v.getByTestId('ext-panel-selection')
  await expect(strip).toContainText('Dark mode follows', { timeout: 15_000 })
  const card = (await v.locator('.session-panel.is-plain-chat .chat-input-box').boundingBox())!
  const sb = (await strip.boundingBox())!
  expect(sb.x).toBeGreaterThanOrEqual(card.x + 4)
  expect(sb.y).toBeGreaterThanOrEqual(card.y + 4)
  expect(sb.x + sb.width).toBeLessThanOrEqual(card.x + card.width - 4)
  await shot(panel, 'panel-selection-strip')

  // A new chat with the quote's own × pressed: the page goes, the selection does not.
  await v.getByTestId('ext-panel-new').click()
  await expect(quote).toContainText('Dark mode follows', { timeout: 15_000 })
  await quote.getByTestId('ask-object-quote-drop').click()
  await expect(quote).toHaveCount(0)
  await expect(pageChip(panel)).toBeChecked()
  await v.locator('[data-testid="ask-object-compose"] textarea').fill('No quote this time echo-input')
  await v.locator('[data-testid="ask-object-compose"] textarea').press('Enter')
  await expect(session).toBeVisible({ timeout: 60_000 })
  const sid2 = (await session.getAttribute('data-session-id')) ?? ''
  const task2 = await taskOfSession(sid2)
  if (task2) seeded.push(task2)
  const raw2 = await received(sid2, 'No quote this time')
  expect(raw2).not.toContain('Dark mode follows')
  expect(raw2).toContain('Address: ')
  const sent2 = v.locator('.session-msg-user').filter({ hasText: 'No quote this time' }).first()
  await expect(sent2.getByTestId('ext-panel-attached-page')).toBeVisible({ timeout: 30_000 })
  await expect(sent2.getByTestId('ext-panel-attached')).toHaveCount(0)
  await lab.doc.evaluate(() => getSelection()?.removeAllRanges())
})

test('a new chat under waiting approvals: the Continue list and the approvals give way, the quote and the composer are never covered', async () => {
  test.setTimeout(180_000)
  const v = askView(panel)
  await lab.doc.goto(lab.site('docs.example.test', '/notes'))
  await expect(pageChip(panel)).toContainText('Release notes 4.2', { timeout: 30_000 })
  // Two (and more) agent steps waiting, as outward-asks.ts words them: wrapped whole, each card is tall.
  const now = Date.now()
  const approval = (i: number) => ({
    id: `apr-tall-${i}-${now.toString(36)}`, digest: 'd', mode: 'tap', guard: 'person', status: 'pending',
    what: `Let a Walnut agent press Enter in textbox "Your feedback" on shop.example.test:34567: "Great update number ${i}"? Enter sends the message in that box.`,
    detail: `Message it sends: Great update number ${i}`,
    requester: { host: '__local__', command: 'walnut browser press', local: true },
    createdAt: new Date(now + i).toISOString(), expiresAt: new Date(now + 600_000).toISOString(),
  })
  const list = /\/api\/v1\/approvals(\?.*)?$/
  await lab.ctx.route(list, (route) => route.request().method() === 'GET' ? route.fulfill({ json: { approvals: [1, 2, 3, 4].map(approval), keys: [] } }) : route.continue())
  const frame = () => panel.frames().find((f) => f.url().includes('view=ext-panel'))!
  try {
    await frame().evaluate(() => location.reload())
    await expect(v.getByTestId('ext-ask-approval')).toHaveCount(2, { timeout: 30_000 })
    await v.getByTestId('ext-panel-new').click()
    await expect(v.getByTestId('ext-continue-row').first()).toBeVisible({ timeout: 30_000 })
    await selectText(lab.doc, 'p2')
    const quote = v.getByTestId('ask-object-quote')
    await expect(quote).toContainText('Dark mode follows', { timeout: 15_000 })
    const drop = quote.getByTestId('ask-object-quote-drop')
    // What is on top at the quote's ×, and at the composer's text box, is that control itself.
    const onTop = (sel: string) => frame().evaluate((s) => {
      const el = document.querySelector<HTMLElement>(s)!
      const r = el.getBoundingClientRect()
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      return !!hit && (hit === el || el.contains(hit))
    }, sel)
    expect(await onTop('[data-testid="ask-object-quote-drop"]')).toBe(true)
    expect(await onTop('[data-testid="ask-object-compose"] textarea')).toBe(true)
    // In order down the view, none over the next: the approvals, the Continue list, the quote, the composer, all on screen.
    const ap = (await v.getByTestId('ext-ask-approvals').boundingBox())!
    const cont = (await v.getByTestId('ext-continue').boundingBox())!
    const qb = (await quote.boundingBox())!
    const box = (await v.locator('.session-panel.is-plain-chat .chat-input-box').boundingBox())!
    expect(ap.y + ap.height).toBeLessThanOrEqual(cont.y + 0.5)
    expect(cont.y + cont.height).toBeLessThanOrEqual(qb.y + 0.5)
    expect(qb.y + qb.height).toBeLessThanOrEqual(box.y + box.height + 0.5)
    expect(box.y + box.height).toBeLessThanOrEqual(760 + 0.5)
    await shots(panel, 'panel-new-chat-quote-under-approvals')
    // The × answers a real click.
    await drop.click()
    await expect(quote).toHaveCount(0)
  } finally {
    await lab.ctx.unroute(list)
    await frame()?.evaluate(() => location.reload())
    await expect(v.getByTestId('ext-ask-head')).toBeVisible({ timeout: 30_000 })
    await lab.doc.evaluate(() => getSelection()?.removeAllRanges())
  }
})

test('the popup sends what it shows: its quote goes with the page left out, and with its × nothing of the selection goes', async () => {
  test.setTimeout(240_000)
  await lab.doc.goto(lab.site('docs.example.test', '/notes'))
  await lab.doc.bringToFront()
  await selectText(lab.doc, 'p1')
  const made: string[] = []
  /** The toolbar popup for the person's window, as the popup test opens it; its question goes on in a side panel. */
  async function askInPopup(words: string, drop: { page: boolean; quote: boolean }): Promise<string> {
    const popOpened = lab.ctx.waitForEvent('page')
    await sw(lab).evaluate((w: number) => chrome.windows.create({ url: chrome.runtime.getURL(`popup-ask.html?window=${w}`), type: 'popup', width: 380, height: 560 }), lab.docWindow)
    const pop = await popOpened
    await pop.setViewportSize({ width: 380, height: 560 })
    const v = askView(pop)
    await expect(v.getByTestId('ext-panel')).toHaveAttribute('data-surface', 'popup', { timeout: 60_000 })
    await expect(pageChip(pop)).toContainText('Release notes 4.2', { timeout: 30_000 })
    // The selection shows as its own quote over the composer, with its own ×.
    const strip = v.getByTestId('ext-panel-selection')
    await expect(strip).toContainText('retries a failed upload three times', { timeout: 15_000 })
    if (drop.page) { await v.getByTestId('ext-panel-page-drop').click(); await expect(pageChip(pop)).not.toBeChecked() }
    if (drop.quote) { await strip.getByTestId('ext-panel-selection-drop').click(); await expect(strip).toHaveCount(0) }
    await shot(pop, `popup-quote-${drop.page ? 'nopage' : 'page'}-${drop.quote ? 'noquote' : 'quote'}`)
    const next = lab.ctx.waitForEvent('page')
    const composer = v.locator('.draft-session-panel textarea')
    await composer.fill(words)
    await composer.press('Enter')
    const handed = await next
    const session = askView(handed).getByTestId('ask-object-session')
    await expect(session).toBeVisible({ timeout: 90_000 })
    const sid = (await session.getAttribute('data-session-id')) ?? ''
    const task = await taskOfSession(sid)
    if (task) { seeded.push(task); made.push(task) }
    const raw = await received(sid, words)
    await handed.close()
    await pop.close().catch(() => undefined)
    return raw
  }
  // Page left out, quote shown: the selection alone goes.
  const raw = await askInPopup(`Popup quote only ${Date.now().toString(36)} echo-input`, { page: true, quote: false })
  expect(raw, raw).toContain('retries a failed upload three times')
  expect(raw).toContain('left the page itself out')
  expect(raw).not.toContain("The page's text")
  // Page and quote both left out: nothing of the page, and the selection no quote shows never goes.
  const raw2 = await askInPopup(`Popup nothing ${Date.now().toString(36)} echo-input`, { page: true, quote: true })
  expect(raw2).not.toContain('retries a failed upload three times')
  expect(raw2).not.toContain('left the page itself out')
  expect(raw2).not.toContain('Address: ')
  // The page kept, its quote left out: the page goes without the selection.
  const raw3 = await askInPopup(`Popup page only ${Date.now().toString(36)} echo-input`, { page: false, quote: true })
  expect(raw3).toContain('Address: ')
  expect(raw3).not.toContain('left the page itself out')
  expect(raw3).not.toContain('retries a failed upload three times')
  await lab.doc.evaluate(() => getSelection()?.removeAllRanges())
  // A handed question is asked once, by the panel that took it: this panel keeps the conversation it
  // shows on another page (the open one stays, round 3), and nothing asks the question again there.
  const shownBefore = await askView(panel).getByTestId('ask-object-session').getAttribute('data-session-id', { timeout: 2_000 }).catch(() => null)
  let launched = 0
  const onLaunch = (r: { method(): string; url(): string }) => { if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/sessions/quick-start') launched += 1 }
  panel.on('request', onLaunch)
  await lab.doc.goto(lab.site('docs.example.test', '/login'))
  await expect(pageChip(panel)).toContainText('Sign in', { timeout: 30_000 })
  await panel.waitForTimeout(2000)
  panel.off('request', onLaunch)
  expect(launched).toBe(0)
  if (shownBefore) await expect(askView(panel).getByTestId('ask-object-session')).toHaveAttribute('data-session-id', shownBefore)
  else await expect(askView(panel).getByTestId('ask-object-session')).toHaveCount(0)
  // Back on the notes page, a new chat, so the later specs find that page as a person left it
  // (a conversation's title is renamed after the panel moved on, which its look cannot know).
  await lab.doc.goto(lab.site('docs.example.test', '/notes'))
  await expect(pageChip(panel)).toContainText('Release notes 4.2', { timeout: 30_000 })
  await askView(panel).getByTestId('ext-panel-new').click()
  await expect(askView(panel).getByTestId('ask-object-compose')).toBeVisible({ timeout: 15_000 })
  await panel.waitForTimeout(1000)
  // Its asks go now, so the later specs' Continue lists read as before.
  for (const id of made) await lab.doc.request.delete(`${lab.base}/api/v1/tasks/${id}`).catch(() => undefined)
})

test('the key: locked, one row to unlock; unlocked, this site\'s logins; Fill fills the page; Escape closes', async () => {
  test.setTimeout(180_000)
  const v = askView(panel)
  // Locked on a page with no site (Walnut's own): the unlock row all the same (R1-9).
  await lab.doc.goto(`${lab.base}/`)
  await expect(pageChip(panel)).toHaveCount(0, { timeout: 30_000 })
  await v.getByTestId('ext-ask-key').click()
  await expect(keyPop(panel)).toHaveAttribute('data-shows', 'locked', { timeout: 20_000 })
  await expect(keyPop(panel).getByTestId('key-pop-unlock-row')).toBeVisible()
  await expect(keyPop(panel).getByTestId('key-pop-locked-empty')).toHaveText('Open a site to see its logins here.')
  await panel.keyboard.press('Escape')
  await expect(keyPop(panel)).toHaveCount(0)
  await lab.doc.goto(lab.site('docs.example.test', '/login'))
  await expect(pageChip(panel)).toContainText('Sign in', { timeout: 30_000 })
  const frameBox = await panel.locator('iframe.panel-frame').boundingBox()
  await v.getByTestId('ext-ask-key').click()
  const pop = keyPop(panel)
  await expect(pop).toHaveAttribute('data-shows', 'locked', { timeout: 20_000 })
  await expect(v.getByTestId('ext-ask-key')).toHaveAttribute('aria-expanded', 'true')
  await expect(pop.locator('.key-pop-head')).toHaveText('Passwords for docs.example.test')
  await expect(pop.getByTestId('key-pop-unlock-row')).toBeVisible()
  await expect(pop.getByTestId('key-pop-locked-empty')).toBeVisible()
  await expect(pop.getByTestId('key-pop-search-all')).toBeVisible()
  await expect(pop.getByTestId('key-pop-open-vault')).toBeVisible()
  // An overlay with a border, a solid background and a shadow; the frame under it stays put.
  const look = await pop.evaluate((el) => { const s = getComputedStyle(el); return { pos: s.position, border: s.borderTopWidth, bg: s.backgroundColor, shadow: s.boxShadow } })
  expect(look.pos).toBe('absolute')
  expect(look.border).not.toBe('0px')
  expect(look.bg).not.toMatch(/rgba\(0, 0, 0, 0\)|transparent/)
  expect(look.shadow).not.toBe('none')
  expect(await panel.locator('iframe.panel-frame').boundingBox()).toEqual(frameBox)
  // Under the key, inside the panel.
  const keyBox = (await v.getByTestId('ext-ask-key').boundingBox())!
  const popBox = (await pop.boundingBox())!
  expect(popBox.y).toBeGreaterThanOrEqual(keyBox.y + keyBox.height)
  expect(popBox.x + popBox.width).toBeLessThanOrEqual(400)
  // How long an unlock lasts, in one line that fits.
  const note = pop.locator('.key-pop-note')
  await expect(note).toHaveText('Stays unlocked 48 hours, renewed on use.')
  expect(await note.evaluate((e) => Math.round(e.getBoundingClientRect().height / parseFloat(getComputedStyle(e).lineHeight)))).toBe(1)
  // One type: the popover the extension draws reads in the frame's own font stack.
  const frameFont = await panel.frames().find((f) => f.url().includes('view=ext-panel'))!.evaluate(() => getComputedStyle(document.body).fontFamily)
  expect(await pop.evaluate((e) => getComputedStyle(e).fontFamily)).toBe(frameFont)
  await shots(panel, 'panel-key-locked')

  // Unlock in the row (Enter works): the logins of this site, and the key loses its padlock.
  await pop.getByLabel('Master password').fill(VAULT_MASTER)
  await pop.getByLabel('Master password').press('Enter')
  await expect(pop).toHaveAttribute('data-shows', 'unlocked', { timeout: 30_000 })
  const row = pop.getByTestId('key-pop-row').filter({ hasText: loginTitle })
  await expect(row).toBeVisible()
  // The username whole, as the Passwords view and the toolbar popup show it.
  await expect(row.locator('.row-sub')).toHaveText('reader@example.test')
  await expect(row).not.toContainText(loginPassword)
  await expect(v.getByTestId('ext-key-locked')).toHaveCount(0, { timeout: 10_000 })
  // No keyboard ring on a Fill the person did not reach with the keys.
  await expect(row.getByTestId('key-pop-fill')).not.toBeFocused()
  await shots(panel, 'panel-key-unlocked')

  await row.getByTestId('key-pop-fill').click()
  await expect.poll(() => lab.doc.locator('#pass').inputValue(), { timeout: 15_000 }).toBe(loginPassword)
  expect(await lab.doc.locator('#user').inputValue()).toBe('reader@example.test')
  // The panel stays open after a fill; the popover closes, and no toast is left over Ask's composer (R1-10).
  await expect(pop).toHaveCount(0)
  await expect(v.getByTestId('ext-ask-key')).toHaveAttribute('aria-expanded', 'false')
  await expect(panel.locator('.toast.on')).toHaveCount(0)
  await panel.waitForTimeout(400)
  await expect(panel.locator('.toast')).toHaveCount(0)

  // Open vault goes to Walnut's Passwords, and again to the same tab, not a second one (R1-13d).
  const passwordsTabs = () => sw(lab).evaluate(async (base: string) => (await chrome.tabs.query({})).filter((t) => (t.url ?? '').startsWith(`${base}/passwords`)).length, lab.base)
  for (let i = 0; i < 2; i++) {
    await v.getByTestId('ext-ask-key').click()
    await keyPop(panel).getByTestId('key-pop-open-vault').click()
    await expect.poll(passwordsTabs, { timeout: 15_000 }).toBe(1)
  }
  await sw(lab).evaluate(async (base: string) => { for (const t of await chrome.tabs.query({})) if ((t.url ?? '').startsWith(`${base}/passwords`) && t.id !== undefined) await chrome.tabs.remove(t.id) }, lab.base)
  await lab.doc.bringToFront()
  await sw(lab).evaluate((id: number) => chrome.windows.update(id, { focused: true }), lab.docWindow)

  // Escape closes it, and so does a press on the frame outside it.
  await v.getByTestId('ext-ask-key').click()
  await expect(pop).toHaveAttribute('data-shows', 'unlocked', { timeout: 20_000 })
  await panel.keyboard.press('Escape')
  await expect(pop).toHaveCount(0)
  await v.getByTestId('ext-ask-key').click()
  await expect(pop).toBeVisible()
  await v.getByTestId('ext-ask-title').click()
  await expect(pop).toHaveCount(0)
  // The drawer says how many logins this site has.
  await v.getByTestId('ask-walnut-menu').click()
  await expect(v.getByTestId('ext-drawer-passwords-meta')).toHaveText('1 login here', { timeout: 15_000 })
  await panel.keyboard.press('Escape')
  // On a page with no site (Walnut's own) the row still has a state (R1-13b).
  await lab.doc.goto(`${lab.base}/`)
  await expect(pageChip(panel)).toHaveCount(0, { timeout: 30_000 })
  await v.getByTestId('ask-walnut-menu').click()
  await expect(v.getByTestId('ext-drawer-passwords-meta')).toHaveText('No logins here', { timeout: 15_000 })
  await panel.keyboard.press('Escape')
  await lab.doc.goto(lab.site('docs.example.test', '/login'))
  await expect(pageChip(panel)).toContainText('Sign in', { timeout: 30_000 })
})

let tasksBack = ''
test('Tasks and Passwords open as full views with Back to Ask', async () => {
  test.setTimeout(150_000)
  await openView(panel, 'tasks')
  await expect(tasksView(panel).getByTestId('ext-tasks')).toBeVisible({ timeout: 30_000 })
  await expect(panel.getByTestId('panel-view-tasks').locator('.panel-view-title')).toHaveText('Tasks')
  // A passing wait (its report due in seconds) is no row line here either.
  await expect(tasksView(panel).getByText('Its report on the turn that just ended')).toHaveCount(0)
  tasksBack = await panel.getByTestId('panel-view-tasks').getByTestId('panel-view-back').evaluate((e) => { const c = getComputedStyle(e); return [c.backgroundColor, c.color, c.fontSize, c.height, c.paddingLeft].join(' ') })
  await shot(panel, 'panel-view-tasks')
  await backToAsk(panel)
  // Ask as it was: the new chat, its composer ready.
  await expect(askView(panel).getByTestId('ask-object-compose')).toBeVisible()
  await expect(pageChip(panel)).toContainText('Sign in')

  await openView(panel, 'passwords')
  const pw = passwordsView(panel)
  const item = pw.getByTestId('popup-item').filter({ hasText: loginTitle })
  await expect(item).toBeVisible({ timeout: 30_000 })
  // One bar: Back, the title and the tools in a single row (no row of icons alone), Back drawn as
  // the Tasks view's; the box says it searches logins; the username whole, as in the popover.
  const bar = pw.locator('.top-sub.view-bar')
  await expect(bar.getByTestId('panel-view-back')).toBeVisible()
  await expect(bar.locator('h1')).toHaveText('Passwords')
  await expect(bar.getByTestId('popup-lock')).toBeVisible()
  await expect(pw.locator('.top:not(.top-sub)')).toHaveCount(0)
  await expect(panel.getByTestId('panel-view-passwords').locator('.panel-view-bar')).toHaveCount(0)
  await expect(pw.getByLabel('Search logins')).toHaveAttribute('placeholder', 'Search logins')
  await expect(item.locator('.row-sub')).toHaveText('reader@example.test')
  const backLook = (l: ReturnType<typeof bar.getByTestId>) => l.evaluate((e) => { const c = getComputedStyle(e); return [c.backgroundColor, c.color, c.fontSize, c.height, c.paddingLeft].join(' ') })
  // Measured unhovered: Tasks' Back sat under the pointer that clicked it.
  await panel.mouse.move(399, 400)
  expect(await backLook(bar.getByTestId('panel-view-back'))).toBe(tasksBack)
  await shot(panel, 'panel-view-passwords')
  await backToAsk(panel)
  // The key's "Search all logins" opens the same view.
  await askView(panel).getByTestId('ext-ask-key').click()
  await keyPop(panel).getByTestId('key-pop-search-all').click()
  await expect(panel.getByTestId('panel-view-passwords')).toBeVisible()
  await backToAsk(panel)
})

test('the popup opens on Ask: Continue, the key, the side panel button; a question goes on in the side panel', async () => {
  test.setTimeout(180_000)
  await lockExtension()
  // The popup page in a window of its own for the person's window (Playwright cannot open the
  // toolbar popup itself), so the person's tab stays the active one there.
  const popOpened = lab.ctx.waitForEvent('page')
  await sw(lab).evaluate((w: number) => chrome.windows.create({ url: chrome.runtime.getURL(`popup-ask.html?window=${w}`), type: 'popup', width: 380, height: 560 }), lab.docWindow)
  const pop = await popOpened
  await pop.setViewportSize({ width: 380, height: 560 })
  await pop.emulateMedia({ colorScheme: 'dark' })
  const v = askView(pop)
  await expect(v.getByTestId('ext-panel')).toHaveAttribute('data-surface', 'popup', { timeout: 60_000 })
  await expect(v.getByTestId('ext-ask-side-panel')).toBeVisible()
  await expect(v.getByTestId('ext-ask-key')).toBeVisible()
  await expect(v.getByTestId('ext-continue')).toBeVisible({ timeout: 30_000 })
  const askRow = v.locator(`[data-testid="ext-continue-row"][data-task-id="${askTask}"]`)
  await expect(askRow).toContainText('Uploads in release 4.2', { timeout: 30_000 })
  await expect(askRow.locator('.ask-walnut-drawer-item-line')).toHaveText('Uploads now retry three times before giving up.')
  await expect(v.getByTestId('ext-key-locked')).toBeVisible({ timeout: 15_000 })
  await expect(v.getByTestId('ext-panel-include')).toContainText('Sign in')
  await shot(pop, 'popup-ask-dark')
  // The key popover, unlocked from its row, as in the panel.
  await v.getByTestId('ext-ask-key').click()
  const kp = keyPop(pop)
  await expect(kp).toHaveAttribute('data-shows', 'locked', { timeout: 20_000 })
  await shot(pop, 'popup-key-locked-dark')
  await kp.getByLabel('Master password').fill(VAULT_MASTER)
  await kp.getByTestId('key-pop-unlock').click()
  await expect(kp.getByTestId('key-pop-row').filter({ hasText: loginTitle })).toBeVisible({ timeout: 30_000 })
  await shot(pop, 'popup-key-unlocked-dark')
  await pop.emulateMedia({ colorScheme: 'light' })
  await shot(pop, 'popup-key-unlocked')
  await pop.keyboard.press('Escape')
  await expect(kp).toHaveCount(0)

  // The side panel button opens the panel for this window (a window of its own here: a test's tab).
  const opened = lab.ctx.waitForEvent('page')
  await v.getByTestId('ext-ask-side-panel').click()
  const side = await opened
  expect(side.url()).toContain(`sidepanel.html?window=${lab.docWindow}`)
  await expect(askView(side).getByTestId('ext-ask-head')).toBeVisible({ timeout: 60_000 })
  await side.close()

  // A question asked in the popup starts in the side panel, which sends it.
  const words = `Popup question ${Date.now().toString(36)}`
  const next = lab.ctx.waitForEvent('page')
  const composer = v.locator('.draft-session-panel textarea')
  await composer.fill(words)
  await composer.press('Enter')
  const handed = await next
  const hv = askView(handed)
  const session = hv.getByTestId('ask-object-session')
  await expect(session).toBeVisible({ timeout: 90_000 })
  const sid = (await session.getAttribute('data-session-id')) ?? ''
  expect(sid).not.toBe('')
  expect(sid).not.toBe(askSession)
  // Its task is removed with the others after the run.
  const handedRec = await lab.doc.request.get(`${lab.base}/api/v1/sessions/${sid}`).then((r) => r.json()).catch(() => ({})) as Record<string, any>
  const handedTask = String(handedRec.session?.taskId ?? handedRec.taskId ?? '')
  if (handedTask) { seeded.push(handedTask); await expectUnpinned(handedTask) }
  // The question reached the session (the mock CLI answers with it; it keeps no transcript to
  // draw the person's own row from, as the other panel specs note).
  await expect(hv.getByText(`Hello! I processed your message: ${words}`, { exact: false }).first()).toBeVisible({ timeout: 30_000 })
  await handed.close()
  // Escape closes the toolbar popup (the side panel's Escape never closes it).
  const closed = pop.waitForEvent('close', { timeout: 15_000 })
  await v.locator('.draft-session-panel textarea').click()
  // The press may not return: the popup is gone by then.
  await Promise.all([closed, pop.keyboard.press('Escape').catch(() => undefined)])
})

test('locked: the Passwords view has Back, Escape goes back; Escape never closes the side panel; Settings from the key', async () => {
  test.setTimeout(150_000)
  await lockExtension()
  // The full Passwords view, locked: Back to Ask is there all the same (R1-2), and Escape is Back.
  await openView(panel, 'passwords')
  const pw = passwordsView(panel)
  await expect(pw.getByLabel('Master password')).toBeVisible({ timeout: 30_000 })
  await expect(pw.getByTestId('panel-view-back')).toBeVisible()
  await expect(pw.locator('.view-bar h1')).toHaveText('Passwords')
  await shot(panel, 'panel-view-passwords-locked')
  await pw.getByLabel('Master password').press('Escape')
  await expect(panel.locator('.panel-view:not([hidden])')).toHaveCount(0)
  // Escape in the composer leaves the side panel open, with what was typed (R1-3).
  const composer = askView(panel).locator('[data-testid="ask-object-compose"] textarea, .session-panel.is-plain-chat textarea').first()
  await composer.fill('half typed')
  await composer.press('Escape')
  await panel.waitForTimeout(500)
  expect(panel.isClosed()).toBe(false)
  await expect(composer).toHaveValue('half typed')
  await composer.fill('')
  // Settings, where agents in this browser are turned on, is a step from the key (R1-7).
  await askView(panel).getByTestId('ext-ask-key').click()
  await keyPop(panel).getByTestId('key-pop-settings').click()
  await expect(panel.getByTestId('panel-view-settings')).toBeVisible()
  const st = panel.frameLocator('iframe.panel-frame-settings')
  await expect(st.getByText('Let Walnut agents use this browser')).toBeVisible({ timeout: 30_000 })
  await expect(st.getByTestId('panel-view-back')).toHaveText('Ask')
  await shot(panel, 'panel-view-settings')
  await st.getByTestId('panel-view-back').click()
  await expect(panel.locator('.panel-view:not([hidden])')).toHaveCount(0)
  // The frame may open it too (its drawer row, ext=3).
  expect(await panel.locator('iframe.panel-frame').getAttribute('src')).toContain('ext=3')
})

test('the popup\'s hand-over is taken by one panel only', async () => {
  // Three takes at once for a window no panel follows: one gets it (R1-16).
  const got = await panel.evaluate(async () => {
    const w = 987_654
    await chrome.storage.session.set({ panelHand: { windowId: w, ask: { text: 'once' }, at: Date.now() } })
    const rs = await Promise.all([1, 2, 3].map(() => chrome.runtime.sendMessage({ type: 'panel-hand', windowId: w })))
    return rs.filter((r: { hand?: unknown }) => !!r?.hand).length
  })
  expect(got).toBe(1)
})

test('Walnut\'s theme reaches the key popover and the Passwords view (R1-19)', async () => {
  test.setTimeout(120_000)
  // What the Ask frame says when Walnut's General theme is Dark (on a light system).
  const tell = (theme: string) => panel.frames().find((f) => f.url().includes('view=ext-panel'))!.evaluate((t) => parent.postMessage({ walnut: 'ext-panel', type: 'theme', theme: t }, '*'), theme)
  await tell('dark')
  await expect(panel.locator('html')).toHaveClass(/theme-dark/)
  await askView(panel).getByTestId('ext-ask-key').click()
  await expect(keyPop(panel)).toBeVisible()
  expect(await keyPop(panel).evaluate((e) => getComputedStyle(e).backgroundColor)).toBe('rgb(31, 29, 27)')
  await shot(panel, 'panel-key-walnut-dark')
  await panel.keyboard.press('Escape')
  await openView(panel, 'passwords')
  await expect.poll(() => passwordsView(panel).locator('html').getAttribute('class'), { timeout: 10_000 }).toContain('theme-dark')
  expect(await passwordsView(panel).locator('body').evaluate((e) => getComputedStyle(e).backgroundColor)).toBe('rgb(31, 29, 27)')
  await shot(panel, 'panel-view-passwords-walnut-dark')
  await backToAsk(panel)
  // System again: the browser's own scheme (light here).
  await tell('system')
  await expect(panel.locator('html')).not.toHaveClass(/theme-dark/)
})

test('opened, it looks like the view at once: the same header and composer in the same places (R1-4)', async () => {
  test.setTimeout(150_000)
  await lab.doc.goto(lab.site('docs.example.test', '/notes'))
  const { panel: p } = await openPanel(lab)
  await p.setViewportSize({ width: 400, height: 760 })
  const look = p.getByTestId('panel-snap')
  await expect(look).toBeVisible({ timeout: 10_000 })
  const rect = (l: ReturnType<Page['locator']>) => l.evaluate((e) => { const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } })
  // Read in one go: the look is drawn again as more is known (the page, the lock), which replaces its parts.
  const drawn = await look.evaluate((el) => {
    const r = (sel: string) => { const b = el.querySelector(sel)!.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) } }
    return {
      menu: r('[data-testid="panel-snap-menu"]'),
      key: r('[data-testid="panel-snap-key"]'),
      title: el.querySelector('[data-testid="panel-snap-title"]')?.textContent ?? null,
      placeholder: el.querySelector('[data-testid="panel-snap-placeholder"]')?.textContent ?? null,
      composer: r('.look-composer'),
      head: r('.look-head'),
    }
  })
  await shot(p, 'panel-look-placeholder')
  const v = askView(p)
  await expect(v.getByTestId('ext-ask-head')).toBeVisible({ timeout: 60_000 })
  await expect(look).toHaveCount(0, { timeout: 20_000 })
  const ta = v.locator('[data-testid="ask-object-compose"] textarea, .session-panel.is-plain-chat textarea').first()
  await expect(ta).toBeVisible({ timeout: 30_000 })
  const real = {
    menu: await rect(v.getByTestId('ask-walnut-menu')),
    key: await rect(v.getByTestId('ext-ask-key')),
    title: await v.getByTestId('ext-ask-title').textContent(),
    placeholder: await ta.getAttribute('placeholder'),
    // The composer's box: the textarea's nearest ancestor with a border.
    composer: await ta.evaluate((e) => {
      let n: HTMLElement | null = e as HTMLElement
      while (n && getComputedStyle(n).borderTopWidth === '0px') n = n.parentElement
      const r = (n ?? e).getBoundingClientRect()
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
    }),
    head: await rect(v.getByTestId('ext-ask-head')),
  }
  await shot(p, 'panel-look-real')
  console.log('[look]', JSON.stringify({ drawn, real }))
  const near = (a: { x: number; y: number; w: number; h: number }, b: typeof a, d = 3) => {
    for (const k of ['x', 'y', 'w', 'h'] as const) expect.soft(Math.abs(a[k] - b[k]), `${k}: drawn ${a[k]}, view ${b[k]}`).toBeLessThanOrEqual(d)
  }
  near(drawn.menu, real.menu)
  near(drawn.key, real.key)
  near(drawn.head, real.head)
  near(drawn.composer, real.composer)
  expect(drawn.title).toBe(real.title)
  expect(drawn.placeholder).toBe(real.placeholder)
  await p.close()
})

test('a new ask reads its question until Walnut titles it, then Walnut\'s title, from the same launch Home uses (R2-7)', async () => {
  test.setTimeout(150_000)
  const p = await openAskPanel()
  const v = askView(p)
  await v.getByTestId('ext-panel-new').click()
  await expect(v.getByTestId('ext-ask-title')).toHaveText('New chat', { timeout: 15_000 })
  // `title-test:` keeps the fixture's mock CLI alive to answer the titler's side question, as the
  // real CLI does: the title comes from quick-start's launch auto-title, the path every ask takes.
  const question = `title-test:Which laptop lasts longest ${Date.now().toString(36)}`
  const composer = v.locator('[data-testid="ask-object-compose"] textarea')
  await composer.fill(question)
  await composer.press('Enter')
  const session = v.getByTestId('ask-object-session')
  await expect(session).toBeVisible({ timeout: 60_000 })
  const sid = (await session.getAttribute('data-session-id')) ?? ''
  const task = await taskOfSession(sid)
  seeded.push(task)
  // Never the agent's placeholder twice ("Ask Walnut" over "Ask Walnut ⌄"): its question, then its title.
  const title = v.getByTestId('ext-ask-title')
  await expect(title).toBeVisible({ timeout: 15_000 })
  await expect(title).not.toHaveText('Ask Walnut')
  const aiTitle = `Side title: ${question.split(/\s+/).slice(0, 5).join(' ')}`
  await expect(title).toHaveText(aiTitle, { timeout: 60_000 })
  const j = await (await lab.doc.request.get(`${lab.base}/api/v1/tasks/${task}`)).json() as Record<string, any>
  expect(((j.task ?? j) as { title?: string }).title).toBe(aiTitle)
  // The drawer tells it apart by the same title.
  await v.getByTestId('ask-walnut-menu').click()
  await expect(v.locator('.ask-walnut-drawer').getByText(aiTitle)).toBeVisible({ timeout: 15_000 })
  await shot(p, 'panel-ask-titled')
  await p.keyboard.press('Escape')
  await p.close()
})

test('New chat wins over a launch still on its way: the next question starts its own ask, and stays (review round 3, #3)', async () => {
  test.setTimeout(180_000)
  const p = await openAskPanel()
  const v = askView(p)
  await v.getByTestId('ext-panel-new').click()
  const composer = v.locator('[data-testid="ask-object-compose"] textarea')
  await expect(composer).toBeVisible({ timeout: 15_000 })
  const launchPath = '/api/sessions/quick-start'
  const isLaunch = (u: URL) => u.pathname === launchPath
  const launches: string[] = []
  const tasks: string[] = []
  p.on('request', (r) => { if (r.method() === 'POST' && new URL(r.url()).pathname === launchPath) launches.push(String((r.postDataJSON() as { message?: string }).message ?? '')) })
  p.on('response', (r) => { if (r.request().method() === 'POST' && new URL(r.url()).pathname === launchPath) void r.json().then((j: { taskId?: string }) => { if (j.taskId) tasks.push(j.taskId) }).catch(() => undefined) })
  // The first question's launch is held at the server's door for 4 s: New chat comes while it is out.
  let seen = 0
  await lab.ctx.route(isLaunch, async (route) => { seen += 1; if (seen === 1) await new Promise((r) => setTimeout(r, 4000)); await route.continue() })
  const stamp = Date.now().toString(36)
  const first = `First question ${stamp}`
  const second = `Second question ${stamp}`
  try {
    await composer.fill(first)
    await composer.press('Enter')
    await expect.poll(() => launches.length, { timeout: 15_000 }).toBe(1)
    await v.getByTestId('ext-panel-new').click()
    await expect(composer).toBeVisible({ timeout: 15_000 })
    await composer.fill(second)
    await composer.press('Enter')
    // Its own launch, not a follow-up into the first ask (it joined the launch still out before).
    await expect.poll(() => launches, { timeout: 15_000 }).toEqual([first, second])
    const session = v.getByTestId('ask-object-session')
    await expect(session).toBeVisible({ timeout: 60_000 })
    const sid = (await session.getAttribute('data-session-id')) ?? ''
    // The first launch lands meanwhile: the panel stays on the second.
    await expect.poll(() => tasks.length, { timeout: 30_000 }).toBe(2)
    await p.waitForTimeout(1500)
    await expect(session).toHaveAttribute('data-session-id', sid)
    await expect(v.locator('.session-msg-user', { hasText: second }).first()).toBeVisible({ timeout: 30_000 })
    await expect(v.locator('.session-msg-user', { hasText: first })).toHaveCount(0)
    await p.close()
    // Opened again: the conversation New chat started, never the one left behind.
    const again = await openAskPanel()
    await expect(askView(again).getByTestId('ask-object-session')).toHaveAttribute('data-session-id', sid, { timeout: 60_000 })
    await again.close()
  } finally {
    await lab.ctx.unroute(isLaunch)
    seeded.push(...tasks)
  }
})

test('the header\'s key and New chat are in the first frame, the placeholder\'s and the view\'s (review round 3, #10)', async () => {
  test.setTimeout(120_000)
  await lab.doc.goto(lab.site('docs.example.test', '/notes'))
  const { panel: p } = await openPanel(lab)
  // Every frame from here on, as drawn: whenever the head shows, its icons are there and on screen.
  await p.evaluate(() => {
    const w = window as unknown as { __heads: Array<{ vw: number; at: number; menu: number[] | null; key: number[] | null; compose: number[] | null }> }
    w.__heads = []
    const box = (e: Element | null) => { if (!e) return null; const b = e.getBoundingClientRect(); return b.width > 0 ? [b.left, b.right] : null }
    const tick = () => {
      const look = document.querySelector('[data-testid="panel-snap"]')
      if (look) w.__heads.push({ vw: innerWidth, at: performance.now(), menu: box(look.querySelector('[data-testid="panel-snap-menu"]')), key: box(look.querySelector('[data-testid="panel-snap-key"]')), compose: box(look.querySelector('.look-head > .look-btn:last-child')) })
      if (w.__heads.length < 600) requestAnimationFrame(tick)
    }
    tick()
  })
  const v = askView(p)
  await expect(v.getByTestId('ext-ask-head')).toBeVisible({ timeout: 60_000 })
  // The view's header, at its first render: the key and New chat with it.
  const frame = p.frames().find((f) => f.url().includes('view=ext-panel'))!
  const head = await frame.evaluate(() => {
    const h = document.querySelector('[data-testid="ext-ask-head"]')
    return { key: !!h?.querySelector('[data-testid="ext-ask-key"]'), compose: !!h?.querySelector('[data-testid="ext-panel-new"]') }
  })
  expect(head).toEqual({ key: true, compose: true })
  await expect(p.getByTestId('panel-snap')).toHaveCount(0, { timeout: 20_000 })
  const heads = await p.evaluate(() => (window as unknown as { __heads: Array<{ vw: number; menu: number[] | null; key: number[] | null; compose: number[] | null }> }).__heads)
  const drawn = heads.filter((x) => x.menu)
  expect(drawn.length, 'the placeholder was sampled').toBeGreaterThan(0)
  for (const x of drawn) {
    expect(x.key, 'key with the menu').not.toBeNull()
    expect(x.compose, 'New chat with the menu').not.toBeNull()
    expect(x.compose![1], 'New chat inside the panel').toBeLessThanOrEqual(x.vw + 0.5)
  }
  // The view's own: on screen, inside the panel.
  const vw = await frame.evaluate(() => innerWidth)
  for (const id of ['ext-ask-key', 'ext-panel-new']) {
    const b = (await v.getByTestId(id).boundingBox())!
    expect(b.x + b.width, `${id} inside the view`).toBeLessThanOrEqual(vw + 0.5)
  }
  await p.close()
})

test('an old phone chat reads its last answer; the Tasks view says the same; a click or keystroke in it reads its answer, which leaves the count until the next (review round 4, #1 #2 #3)', async () => {
  test.setTimeout(240_000)
  // An ask on a phone chat opened again: its lane session never ran a turn (no transcript), its
  // whole chat is in chat history (tests/e2e/browser/chat-earlier-fixture.ts).
  const made = await lab.doc.request.post(`${lab.base}/api/v1/tasks`, { data: { title: 'An old phone chat', project: 'Ask Walnut' } })
  expect(made.ok(), await made.text()).toBe(true)
  const oldTask = String(((await made.json()) as Record<string, any>).task?.id)
  seeded.push(oldTask)
  const handBack = async () => {
    expect((await lab.doc.request.post(`${lab.base}/api/test/task-fixture/hand-back`, { data: { taskId: oldTask, sessionId: 'pw-chat-earlier-ext' } })).ok()).toBe(true)
    // A real hand-back's read marker (phase.ts readMarkerForPhase); the fixture route writes the phase raw.
    expect((await lab.doc.request.patch(`${lab.base}/api/tasks/${oldTask}`, { data: { unread: true } })).ok()).toBe(true)
  }
  await handBack()
  const stateOf = async () => ((await (await lab.doc.request.get(`${lab.base}/api/v1/tasks/${oldTask}`)).json()) as Record<string, any>).task as { unread?: boolean; user_status?: { state?: string } }
  await expect.poll(async () => (await stateOf()).user_status?.state, { timeout: 60_000 }).toBe('read')
  const ANSWER = 'Old phone answer 30, with bold text'

  const p = await openAskPanel()
  const v = askView(p)
  const diag: string[] = []
  p.on('console', (m) => { const t = m.text(); if (/tasks|ws /.test(t)) diag.push(`${Date.now()} ${m.location().url.includes('ext-tasks') ? 'T' : 'A'} ${t.slice(0, 240)}`) })
  try {
    await v.getByTestId('ext-panel-new').click()
    const contRow = v.locator(`[data-testid="ext-continue-row"][data-task-id="${oldTask}"]`)
    await expect(contRow.locator('.ask-walnut-drawer-item-line')).toHaveText(ANSWER, { timeout: 30_000 })
    await expect(contRow).toHaveAttribute('data-needs', 'true')
    await v.getByTestId('ask-walnut-menu').click()
    const drawerRow = v.locator(`[data-testid="ask-walnut-drawer-item"][data-task-id="${oldTask}"]`)
    await expect(drawerRow.locator('.ask-walnut-drawer-item-line')).toHaveText(ANSWER)
    await p.keyboard.press('Escape')
    // The Tasks view: its row says the same words after what to do.
    await openView(p, 'tasks')
    const taskRow = tasksView(p).locator(`[data-testid="ext-task"][data-task-id="${oldTask}"]`)
    await expect(taskRow.locator('.ext-task-line')).toHaveText(`Take a look: ${ANSWER}`, { timeout: 30_000 })
    await p.setViewportSize({ width: 400, height: 760 })
    await shots(p, 'r4-tasks-lines')
    await backToAsk(p)

    // Opened in the panel with its answer on screen, it is not read yet: Home's rule, a click or a
    // keystroke in the conversation reads it, its being on screen does not (round 4 code review).
    const answerShown = v.getByText(ANSWER.replace(', with bold text', '')).first()
    const openOld = async () => {
      await v.getByTestId('ask-walnut-menu').click()
      await drawerRow.click()
      await expect(v.getByTestId('ask-object-session')).toHaveAttribute('data-session-id', 'pw-chat-earlier-ext', { timeout: 30_000 })
      await expect(answerShown).toBeVisible({ timeout: 30_000 })
    }
    await openOld()
    await p.waitForTimeout(2_500)
    expect((await stateOf()).unread, 'shown, not touched: still unread').toBe(true)
    await v.getByTestId('ask-walnut-menu').click()
    await expect(drawerRow.locator('.ask-walnut-drawer-needs')).toHaveClass(/is-on/)
    await p.keyboard.press('Escape')

    // A click in the conversation reads it.
    await answerShown.click()
    await expect.poll(async () => (await stateOf()).unread, { timeout: 15_000 }).toBe(false)
    const markAt = Date.now()
    // Walnut's own status is as it was (an answer to read stays on Home's list).
    expect((await stateOf()).user_status?.state).toBe('read')
    const leavesEverywhere = async () => {
      await v.getByTestId('ext-panel-new').click()
      await expect(contRow).toHaveAttribute('data-needs', 'false', { timeout: 15_000 })
      await v.getByTestId('ask-walnut-menu').click()
      await expect(drawerRow.locator('.ask-walnut-drawer-needs')).not.toHaveClass(/is-on/)
      await p.keyboard.press('Escape')
      await openView(p, 'tasks')
      try {
        await expect(tasksView(p).getByTestId('ext-tasks-needs').locator(`[data-task-id="${oldTask}"]`)).toHaveCount(0, { timeout: 15_000 })
      } catch (err) {
        const st = await stateOf()
        console.log(`[r4-3] server: unread=${st.unread} status=${JSON.stringify(st.user_status)}; read at ${markAt}; frames:\n${diag.join('\n')}`)
        throw err
      }
      await backToAsk(p)
    }
    await leavesEverywhere()
    await shots(p, 'r4-drawer-read')

    // Its next answer brings the dot back; a keystroke in the conversation reads it again.
    await handBack()
    await expect(contRow).toHaveAttribute('data-needs', 'true', { timeout: 30_000 })
    await openOld()
    expect((await stateOf()).unread).toBe(true)
    // Focus without a pointer, then a key that types nothing.
    const box = v.locator('[data-testid="ask-object-session"] textarea').first()
    await box.focus()
    await p.waitForTimeout(1_000)
    expect((await stateOf()).unread, 'focus alone is no read').toBe(true)
    await p.keyboard.press('ArrowRight')
    await expect.poll(async () => (await stateOf()).unread, { timeout: 15_000 }).toBe(false)
    await leavesEverywhere()

    // A real ask of the person keeps its dot though it was read (Decide is not read away).
    const asked = await lab.doc.request.post(`${lab.base}/api/v1/tasks`, { data: { title: 'Which slot for the call', project: 'Ask Walnut' } })
    expect(asked.ok(), await asked.text()).toBe(true)
    const realAsk = String(((await asked.json()) as Record<string, any>).task?.id)
    seeded.push(realAsk)
    const rep = await lab.doc.request.put(`${lab.base}/api/v1/tasks/${realAsk}/report`, { data: { state: 'needs', ask: 'Pick the 3 pm or the 4 pm slot for the call?' } })
    expect(rep.ok(), await rep.text()).toBe(true)
    expect((await lab.doc.request.patch(`${lab.base}/api/tasks/${realAsk}`, { data: { unread: false } })).ok()).toBe(true)
    await v.getByTestId('ext-panel-new').click()
    await expect(v.getByTestId('ext-continue').locator(`[data-testid="ext-continue-row"][data-task-id="${realAsk}"]`)).toHaveAttribute('data-needs', 'true', { timeout: 30_000 })
    await v.getByTestId('ask-walnut-menu').click()
    await expect(v.locator(`[data-testid="ask-walnut-drawer-item"][data-task-id="${realAsk}"] .ask-walnut-drawer-needs`)).toHaveClass(/is-on/)
    await p.keyboard.press('Escape')
  } finally {
    await p.close()
  }
})

test('the selection quote follows the page and stays with its agent; the composer names the agent (review round 4, #4 #5)', async () => {
  test.setTimeout(180_000)
  // The agent pick is mirrored to the fixture's ui-prefs: kept in this browser, never handed to another spec.
  await lab.ctx.route('**/api/ui-prefs', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: route.request().method() === 'GET' ? '{"prefs":{}}' : '{"ok":true}' }))
  await lab.doc.goto(lab.site('docs.example.test', '/notes'))
  const p = await openAskPanel()
  const v = askView(p)
  const quote = v.getByTestId('ask-object-quote')
  const box = v.locator('[data-testid="ask-object-compose"] textarea')
  try {
    await v.getByTestId('ext-panel-new').click()
    await selectText(lab.doc, 'p1')
    await expect(quote).toContainText('retries a failed upload three times', { timeout: 15_000 })
    // Cleared on the page: gone here.
    await lab.doc.evaluate(() => getSelection()?.removeAllRanges())
    await expect(quote).toHaveCount(0, { timeout: 10_000 })
    // Selected again (the same words): shown again.
    await selectText(lab.doc, 'p1')
    await expect(quote).toContainText('retries a failed upload three times', { timeout: 15_000 })
    // Another agent: its conversation is not offered the selection shown to Walnut's.
    await v.getByTestId('ext-ask-agent').click()
    await v.locator('[data-testid="ask-walnut-agent-item"][data-agent-id="mentor"]').click()
    await expect(v.locator('.ext-ask-agent')).toContainText('Mentor', { timeout: 15_000 })
    // Its list, still open, says when it has no asks, its words where the drawer's title starts (round 4, #7).
    const drawer = v.getByTestId('ask-walnut-drawer')
    if (await drawer.isVisible()) {
      const empty = drawer.locator('.ask-walnut-drawer-empty').first()
      if (await empty.isVisible()) {
        // Where each one's words start (a button's box starts at its padding, not its text).
        const textX = (l: typeof empty) => l.evaluate((e) => { const r = document.createRange(); r.selectNodeContents(e); return r.getClientRects()[0]?.left ?? -1 })
        const ex = await textX(empty)
        const tx = await textX(v.locator('.ask-walnut-drawer-title').first())
        expect(Math.abs(ex - tx), `the empty line starts where the title does (${ex} vs ${tx})`).toBeLessThanOrEqual(2)
      }
      await p.setViewportSize({ width: 400, height: 760 })
      await shots(p, 'r4-mentor-drawer')
      await p.keyboard.press('Escape')
    }
    if (await v.getByTestId('ask-object-session').isVisible()) await v.getByTestId('ext-panel-new').click()
    await expect(box).toHaveAttribute('placeholder', 'Ask Mentor, or ask it to do something here…', { timeout: 15_000 })
    await expect(quote).toHaveCount(0)
    await p.setViewportSize({ width: 400, height: 760 })
    await shots(p, 'r4-mentor-no-quote')
    // A selection made after the switch is its own.
    await selectText(lab.doc, 'p2')
    await expect(quote).toContainText('Dark mode follows', { timeout: 15_000 })
  } finally {
    await lab.doc.evaluate(() => getSelection()?.removeAllRanges())
    // Back on Walnut's agent for the files after this one.
    if (await v.getByTestId('ask-walnut-drawer').isVisible().catch(() => false)) await p.keyboard.press('Escape').catch(() => undefined)
    await v.getByTestId('ext-ask-agent').click({ timeout: 10_000 }).catch(() => undefined)
    await v.locator(`[data-testid="ask-walnut-agent-item"][data-agent-id="general"]`).click({ timeout: 10_000 }).catch(() => undefined)
    await p.close()
    await lab.ctx.unroute('**/api/ui-prefs')
  }
})

test('Tasks opened before it was ever shown: its loading line at once, never a blank body (review round 4, R4-8)', async () => {
  test.setTimeout(120_000)
  // No lists of last time: the extension's kept drawing of Tasks is gone. The shared panel goes
  // first (its Tasks view, opened by an earlier test, keeps the drawing current as tasks change on
  // the shared server); the last test closes it anyway.
  await panel.close().catch(() => undefined)
  await sw(lab).evaluate(async () => {
    const all = ((await chrome.storage.local.get('panelSnaps')).panelSnaps ?? {}) as Record<string, unknown>
    delete all.tasks
    await chrome.storage.local.set({ panelSnaps: all })
  })
  const p = await openAskPanel()
  try {
    const v = askView(p)
    await v.getByTestId('ask-walnut-menu').click()
    // Every frame from the click on: the Tasks view shows the drawing or its own content.
    await p.evaluate(() => {
      const w = window as unknown as { __tasks: Array<{ at: number; snap: string | null }>; __t0: number }
      w.__tasks = []
      w.__t0 = performance.now()
      const tick = () => {
        const view = document.querySelector('[data-testid="panel-view-tasks"]')
        if (view && !(view as HTMLElement).hidden) w.__tasks.push({ at: performance.now() - w.__t0, snap: view.querySelector('[data-testid="panel-snap"]')?.getAttribute('data-snap') ?? (view.querySelector('[data-testid="panel-snap"]') ? 'lists' : null) })
        if (w.__tasks.length < 400) requestAnimationFrame(tick)
      }
      tick()
    })
    const clicked = Date.now()
    await v.getByTestId('ext-drawer-tasks').click()
    await expect(p.getByTestId('panel-view-tasks')).toBeVisible({ timeout: 15_000 })
    // What the body showed before this drawing: Walnut's own page in the frame, once it is up.
    await expect(tasksView(p).getByTestId('ext-tasks')).toBeVisible({ timeout: 30_000 })
    const ownAt = Date.now() - clicked
    await expect(p.getByTestId('panel-view-tasks').getByTestId('panel-snap')).toHaveCount(0, { timeout: 20_000 })
    const frames = await p.evaluate(() => (window as unknown as { __tasks: Array<{ at: number; snap: string | null }> }).__tasks)
    expect(frames.length).toBeGreaterThan(0)
    // Its loading line is drawn within a frame or two of the view showing (one storage read), long
    // before Walnut's page in the frame can draw; it goes once the view says its lists are up.
    const first = frames[0].at
    const drawn = frames.find((f) => f.snap === 'loading')
    expect(drawn, JSON.stringify(frames.slice(0, 8))).toBeTruthy()
    expect(drawn!.at - first).toBeLessThan(200)
    console.log(`[r4-8] Tasks view on screen at ${Math.round(first)} ms after the drawer opened, its loading line at ${Math.round(drawn!.at)} ms; the frame's own content about ${ownAt} ms after the click (the body was blank until then before this drawing); the drawing gone at ${Math.round(frames.find((f) => f.at > drawn!.at && !f.snap)?.at ?? -1)} ms`)
  } finally {
    await p.close()
  }
})

/** The background's answer from Walnut's panel route, as an older Walnut gives it (no `askPanel`). */
async function olderWalnut(on: boolean): Promise<void> {
  await sw(lab).evaluate((older: boolean) => {
    const g = globalThis as unknown as { fetch: typeof fetch; __realFetch?: typeof fetch }
    if (!g.__realFetch) g.__realFetch = g.fetch
    const real = g.__realFetch
    g.fetch = older
      ? (input, init) => {
          const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input)
          if (new URL(url).pathname === '/api/v1/browser/panel') return Promise.resolve(new Response(JSON.stringify({ panel: 1 }), { status: 200, headers: { 'content-type': 'application/json' } }))
          return real(input, init)
        }
      : real
  }, on)
}

test('a Walnut older than this shape: the three tabs in the panel, the vault popup in the toolbar', async () => {
  test.setTimeout(180_000)
  panel.close().catch(() => undefined)
  await olderWalnut(true)
  try {
    const { panel: old } = await openPanel(lab)
    // The shape of last time shows first, then the answer brings the tabs.
    await expect(old.getByTestId('panel-tab-ask')).toBeVisible({ timeout: 60_000 })
    await expect(old.getByTestId('panel-tab-passwords')).toBeVisible()
    await expect(askView(old).getByTestId('ext-panel')).toBeVisible({ timeout: 60_000 })
    expect(await old.locator('iframe.panel-frame').getAttribute('src')).not.toContain('ext=')
    // No key in an old shell: its Passwords tab is the vault.
    await expect(askView(old).getByTestId('ext-ask-key')).toHaveCount(0)
    await old.close()
    const pop = await lab.ctx.newPage()
    await pop.goto(`chrome-extension://${lab.extId}/popup-ask.html?window=${lab.docWindow}`)
    await expect.poll(() => new URL(pop.url()).pathname, { timeout: 30_000 }).toBe('/popup.html')
    await pop.close()
  } finally {
    await olderWalnut(false)
  }
  // Walnut answers askPanel again: Ask comes back.
  const { panel: back } = await openPanel(lab)
  await expect(askView(back).getByTestId('ext-ask-key')).toBeVisible({ timeout: 60_000 })
  await expect(back.getByTestId('panel-tab-ask')).toHaveCount(0)
  await back.close()
})
