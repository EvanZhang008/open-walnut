/**
 * The extension's side panel and toolbar popup as Walnut's own Ask, with the key in the header
 * (packages/browser-extension/src/panel-ask.ts, key-pop.ts; web/src/popout/PopoutExtPanel.tsx,
 * ExtAskChrome.tsx, ExtPopupBody.tsx), through the real extension in Chromium:
 *
 * - the panel opens on Ask with no tab strip: ≡, the ask's title over the agent, the key (with its
 *   padlock while Passwords is locked) and New chat; the composer names the page in a chip;
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
import { askView, backToAsk, openPanel, openView, pageChip, passwordsView, startPanelLab, sw, tasksView, type PanelLab } from './extension-panel-harness'
import { ensureVaultSetUp, vaultSession, VAULT_MASTER } from './vault-session-helper'

test.describe.configure({ mode: 'serial' })

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
  if (lab) await lab.doc.request.post(`${lab.base}/api/v1/vault/lock`, { data: { everywhere: true } }).catch(() => undefined)
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
  expect((await lab.doc.request.patch(`${lab.base}/api/v1/tasks/${askTask}`, { data: { title: 'Uploads in release 4.2' } })).ok()).toBe(true)
  await expect(v.getByTestId('ext-ask-title')).toHaveText('Uploads in release 4.2', { timeout: 15_000 })
  // The page went with the first message: in the same conversation the chip is off for it.
  await expect(pageChip(panel)).not.toBeChecked()
  await expect(v.getByTestId('ext-key-locked')).toBeVisible()
  await shots(panel, 'panel-conversation-locked')
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
  await expect(v.getByTestId('ask-walnut-drawer-main-line')).toContainText('Your main agent:')
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
})

test('the key: locked, one row to unlock; unlocked, this site\'s logins; Fill fills the page; Escape closes', async () => {
  test.setTimeout(180_000)
  await lab.doc.goto(lab.site('docs.example.test', '/login'))
  const v = askView(panel)
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
  // The panel stays open after a fill; the popover closes.
  await expect(pop).toHaveCount(0)
  await expect(v.getByTestId('ext-ask-key')).toHaveAttribute('aria-expanded', 'false')

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
  // Ask as it was: the sign-in page's own conversation (none yet), its composer ready.
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
  if (handedTask) seeded.push(handedTask)
  // The question reached the session (the mock CLI answers with it; it keeps no transcript to
  // draw the person's own row from, as the other panel specs note).
  await expect(hv.getByText(`Hello! I processed your message: ${words}`, { exact: false }).first()).toBeVisible({ timeout: 30_000 })
  await handed.close()
  await pop.close()
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
    expect(await old.locator('iframe.panel-frame').getAttribute('src')).not.toContain('ext=2')
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
