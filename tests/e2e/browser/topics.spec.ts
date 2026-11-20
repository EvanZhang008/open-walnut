/**
 * Topics on the Org page (web/src/components/topics/, experiment `topics`): a group chat of tasks,
 * org nodes and people. Checked here, through the real UI on the fixture server:
 *   - off: no Topics group, no "+ New topic" in the Threads view
 *   - on: "+ New topic" in the list's Topics group opens the dialog; two tasks and the project's VP
 *     are picked (the VP hosts it by default), the topic is made and its chat opens, its row lists it
 *   - a message posted from the composer shows in the chat, on the right, and is stored
 *   - "@" lists the members; Enter picks one, and the stored message names that member
 *   - a person added by email (a bot) from the side panel joins only through the confirm, which names
 *     the address and the mailbox ("Email from": a fixture account that can send when there is one,
 *     else "no mailbox chosen yet"); Cancel adds no one
 *   - a person picked in the New topic dialog is added only through the same confirm
 *   - the Org page keeps the topic as its place: Home and back to Org, and a reload, reopen it
 *   - the VP keeps Threads, so the topic's thread is on the VP's Threads view with the members'
 *     avatars; its "Open topic" opens the chat again
 * The fixture is shared, so this file makes its own project and tasks and removes what it made.
 */
import fs from 'node:fs'
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { loadHome } from './draft-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const STAMP = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
const PROJECT = `Topics bed ${STAMP}`
const NODE = `project:${PROJECT.trim().toLowerCase()}`
const FLAG = 'topics'
const made: string[] = []
const topicsMade: string[] = []
const ids = { alpha: '', beta: '', lead: '', topic: '' }
let flagsBefore: Record<string, boolean> | null = null

test.describe.configure({ mode: 'serial' })
test.setTimeout(180_000)

async function post<T>(request: APIRequestContext, url: string, data: unknown): Promise<T> {
  const res = await request.post(url, { data })
  expect(res.ok(), `${url}: ${await res.text()}`).toBe(true)
  return (await res.json()) as T
}

async function createTask(request: APIRequestContext, title: string): Promise<string> {
  const { task } = await post<{ task: { id: string } }>(request, '/api/tasks', { title, project: PROJECT, source: 'local' })
  made.push(task.id)
  return task.id
}

async function setFlag(request: APIRequestContext, on: boolean): Promise<void> {
  const cfg = await (await request.get('/api/config')).json() as { config?: { experimental?: Record<string, boolean> } }
  const now = { ...(cfg.config?.experimental ?? {}) }
  if (flagsBefore === null) flagsBefore = { ...now }
  const res = await request.put('/api/config', { data: { experimental: { ...now, [FLAG]: on } } })
  expect(res.ok(), await res.text()).toBe(true)
}

interface MailAccount { accountId: string; address: string; canSend: boolean }
async function sendableAccount(request: APIRequestContext): Promise<MailAccount | null> {
  const res = await request.get('/api/topics/mail-accounts')
  expect(res.ok(), await res.text()).toBe(true)
  const body = (await res.json()) as { accounts: MailAccount[] }
  return body.accounts.find((a) => a.canSend) ?? null
}
const NO_MAILBOX = 'no mailbox chosen yet: nothing is sent until you choose one'
const mailConfirm = (page: Page) => page.locator('[role="dialog"]', { hasText: 'Email from this topic?' })

interface StoredTopic { mail?: { accountId?: string; everyMinutes: number }; id: string; members: Array<{ id: string; name: string; ref: { kind: string; email?: string; bot?: boolean }; status: string; role: string }>; messages: Array<{ id: string; text: string; author: string; mentions: string[] }>; thread?: { node: string; threadId: string } }
async function readTopic(request: APIRequestContext, id: string): Promise<StoredTopic> {
  const res = await request.get(`/api/topics/${id}`)
  expect(res.ok(), await res.text()).toBe(true)
  return ((await res.json()) as { topic: StoredTopic }).topic
}

async function openOrg(page: Page): Promise<void> {
  await isolateUiPrefs(page)
  // The topic's thread is new (nothing for the user yet): its line of cards in progress starts open.
  await page.addInitScript(() => { localStorage.setItem('open-walnut-view:org.threads.showInProgress', 'true') })
  await loadHome(page)
  await page.getByTestId('sidebar-org').click()
  await expect(page.getByTestId('org-page')).toBeVisible()
}

const list = (page: Page) => page.locator('.org-list')
const SHOTS = `${process.env.WALNUT_TASK_DIR ?? 'test-results'}/shots`

async function shot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(SHOTS, { recursive: true })
  await page.screenshot({ path: `${SHOTS}/topics-${name}-${test.info().project.name}.png` })
}
const chat = (page: Page) => page.getByTestId('topic-chat')

test.beforeAll(async ({ request }) => {
  test.setTimeout(120_000)
  if (TEST_PORT === 3456) throw new Error('These checks write tasks, topics and settings: run them on a test server, never production')
  ids.alpha = await createTask(request, `Alpha ${STAMP}`)
  ids.beta = await createTask(request, `Beta ${STAMP}`)
  // Two teams: the project gets its VP (a lead), which keeps Threads.
  const contact = await post<{ task: { id: string } }>(request, '/api/v1/org/contact', { to: PROJECT })
  ids.lead = contact.task.id
  made.push(ids.lead)
})

test.afterAll(async ({ request }) => {
  for (const id of topicsMade) await request.post(`/api/topics/${id}/close`, { data: {} }).catch(() => undefined)
  if (flagsBefore) await request.put('/api/config', { data: { experimental: flagsBefore } })
  for (const id of [...made].reverse()) {
    for (let i = 0; i < 10; i++) {
      const res = await request.delete(`/api/tasks/${id}?force=true`)
      if (res.ok() || res.status() === 404) break
      await new Promise((r) => setTimeout(r, 500))
    }
  }
})

test('off: no Topics group and no New topic button', async ({ page, request }) => {
  await setFlag(request, false)
  await openOrg(page)
  await expect(list(page).getByTestId('org-vps-head')).toBeVisible()
  await expect(page.getByTestId('org-topics')).toHaveCount(0)
  await expect(page.getByTestId('org-topic-new')).toHaveCount(0)
  await expect(page.getByTestId('org-threads-new-topic')).toHaveCount(0)
})

test('on: a topic made from the Org page with two tasks and the VP; a message, an @mention, a person by email', async ({ page, request }) => {
  await setFlag(request, true)
  await openOrg(page)
  await expect(list(page).getByTestId('org-topics')).toBeVisible()
  await list(page).getByTestId('org-topic-new').click()

  const dialog = page.getByTestId('topic-new-dialog')
  await expect(dialog).toBeVisible()
  await dialog.getByTestId('topic-new-title').fill(`Launch plan ${STAMP}`)
  const search = dialog.getByTestId('topic-member-search')
  for (const ref of [`task:${ids.alpha}`, `task:${ids.beta}`, `org:${NODE}`]) {
    await search.fill(STAMP)
    await dialog.locator(`[data-testid="topic-candidate"][data-ref="${ref}"]`).click()
    await expect(dialog.locator(`[data-testid="topic-picked-member"][data-ref="${ref}"]`)).toBeVisible()
  }
  // The VP hosts it: the first org node picked, as the server's default.
  await expect(dialog.locator(`[data-testid="topic-picked-member"][data-ref="org:${NODE}"]`)).toHaveClass(/is-host/)
  await shot(page, 'new-dialog')
  await dialog.getByTestId('topic-new-create').click()
  await expect(dialog).toHaveCount(0)

  await expect(chat(page)).toBeVisible()
  await expect(chat(page).getByTestId('topic-title')).toHaveText(`Launch plan ${STAMP}`)
  await expect(chat(page).getByTestId('topic-subtitle')).toContainText('3 members')
  ids.topic = (await chat(page).getAttribute('data-topic-id')) ?? ''
  expect(ids.topic).toMatch(/^tp-/)
  topicsMade.push(ids.topic)
  const row = list(page).locator(`[data-testid="org-topic"][data-topic-id="${ids.topic}"]`)
  await expect(row).toBeVisible()
  await expect(row).toHaveAttribute('aria-selected', 'true')

  // A message from the composer: on the right, as the user's own, and stored.
  const input = chat(page).getByTestId('topic-input')
  const words = `Friday is the launch ${STAMP}`
  await input.fill(words)
  await chat(page).getByTestId('topic-send').click()
  const mine = chat(page).locator('[data-testid="topic-message"][data-author="human"]', { hasText: words })
  await expect(mine).toBeVisible()
  await expect(mine).not.toHaveClass(/is-sending/, { timeout: 15_000 })
  await expect.poll(async () => (await readTopic(request, ids.topic)).messages.some((m) => m.author === 'human' && m.text === words)).toBe(true)
  // The row's last line moved on: the message, or Walnut's line after it (these tasks have no session to wake).
  await expect(row.getByTestId('org-topic-last')).not.toHaveText('No messages yet', { timeout: 15_000 })
  await expect(mine.getByTestId('topic-message-reach')).toContainText('not woken', { timeout: 15_000 })

  // "@" lists the members; Enter picks the highlighted one into the box.
  await input.fill('@Alp')
  const menu = page.getByTestId('topic-mention-menu')
  await expect(menu).toBeVisible()
  await expect(menu.getByTestId('topic-mention-row').first()).toContainText(`Alpha ${STAMP}`)
  await shot(page, 'mention')
  await input.press('Enter')
  await expect(menu).toHaveCount(0)
  await expect(input).toHaveValue(`@Alpha ${STAMP} `)
  await input.press('End')
  await input.pressSequentially('can you check the copy?')
  await chat(page).getByTestId('topic-send').click()
  await expect(chat(page).locator('[data-testid="topic-message"][data-author="human"]', { hasText: 'can you check the copy?' })).toBeVisible()
  await expect.poll(async () => {
    const t = await readTopic(request, ids.topic)
    const alpha = t.members.find((m) => m.name === `Alpha ${STAMP}`)
    return !!alpha && t.messages.some((m) => m.text.endsWith('can you check the copy?') && m.mentions.includes(alpha.id))
  }).toBe(true)

  // A person by email, from the side panel: "Email from" shows while one is being added, and the add
  // goes out only through the confirm that names the address and the mailbox.
  const side = chat(page).getByTestId('topic-side')
  await expect(side).toBeVisible()
  await expect(side.getByTestId('topic-mail-from')).toHaveCount(0)
  await side.getByTestId('topic-member-add').click()
  await side.getByTestId('topic-add-person').click()
  await side.getByTestId('topic-person-name').fill('Robin')
  const email = `robin.${STAMP}@example.com`
  await side.getByTestId('topic-person-email').fill(email)
  await side.getByTestId('topic-person-bot').check()
  await side.getByTestId('topic-person-add').click()
  await expect(side.getByTestId('topic-mail-from')).toBeVisible()
  await expect(side.getByTestId('topic-mail-from-none')).toBeVisible()
  const account = await sendableAccount(request)
  if (account) {
    await side.getByTestId('topic-mail-from-button').click()
    const menu = page.getByTestId('topic-mail-from-menu')
    await expect(menu).toBeVisible()
    await menu.getByRole('menuitemradio', { name: account.address }).click()
    await expect(side.getByTestId('topic-mail-from-button')).toHaveAttribute('data-account-id', account.accountId)
    await expect.poll(async () => (await readTopic(request, ids.topic)).mail?.accountId).toBe(account.accountId)
  } else {
    // No account can send here: Walnut's own menu says so, with "No mailbox" checked.
    await side.getByTestId('topic-mail-from-button').click()
    const menu = page.getByTestId('topic-mail-from-menu')
    await expect(menu).toContainText('No mail account can send')
    await expect(menu.getByRole('menuitemradio', { name: 'No mailbox (nothing is emailed)' })).toHaveAttribute('aria-checked', 'true')
    await shot(page, 'mail-from-menu')
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
    await expect(side.getByTestId('topic-side-add')).toBeVisible()
  }
  const asked = `Walnut will email ${email} from ${account ? account.address : NO_MAILBOX} with this topic's new messages. Add?`
  // Cancel: nobody is added and the picked person stays to add.
  await side.getByTestId('topic-side-add-save').click()
  await expect(mailConfirm(page)).toContainText(asked)
  await shot(page, 'person-confirm')
  await mailConfirm(page).getByRole('button', { name: 'Cancel' }).click()
  await expect(mailConfirm(page)).toHaveCount(0)
  expect((await readTopic(request, ids.topic)).members.some((m) => m.ref.kind === 'person')).toBe(false)
  await side.getByTestId('topic-side-add-save').click()
  await expect(mailConfirm(page)).toContainText(asked)
  await mailConfirm(page).getByRole('button', { name: 'Add' }).click()
  const robin = side.locator('[data-testid="topic-member"]', { hasText: 'Robin' })
  await expect(robin).toBeVisible()
  await expect(robin).toHaveAttribute('data-status', 'active')
  await expect(robin).toContainText('bot')
  await expect(chat(page).getByTestId('topic-subtitle')).toContainText('4 members')
  const stored = await readTopic(request, ids.topic)
  await shot(page, 'chat')
  expect(stored.members.find((m) => m.ref.kind === 'person')).toMatchObject({ status: 'active', ref: { email: `robin.${STAMP}@example.com`, bot: true } })
  // With a person in it, the side panel keeps "Email from".
  await expect(side.getByTestId('topic-mail-from')).toBeVisible()

  // The topic is the Org page's place: Home and back to Org reopens it, and so does a reload.
  await page.getByRole('link', { name: 'Home', exact: true }).first().click()
  await expect(page.getByTestId('org-page')).toHaveCount(0)
  await page.getByTestId('sidebar-org').click()
  await expect(chat(page)).toHaveAttribute('data-topic-id', ids.topic)
  await page.reload()
  await expect(chat(page)).toHaveAttribute('data-topic-id', ids.topic, { timeout: 30_000 })
  await expect(list(page).locator(`[data-testid="org-topic"][data-topic-id="${ids.topic}"]`)).toHaveAttribute('aria-selected', 'true')
})

test('a person picked in the New topic dialog joins only through the confirm', async ({ page, request }) => {
  test.skip(!ids.alpha, 'the tasks were not made')
  await openOrg(page)
  await list(page).getByTestId('org-topic-new').click()
  const dialog = page.getByTestId('topic-new-dialog')
  await dialog.getByTestId('topic-new-title').fill(`Partner sync ${STAMP}`)
  await dialog.getByTestId('topic-member-search').fill(STAMP)
  await dialog.locator(`[data-testid="topic-candidate"][data-ref="task:${ids.alpha}"]`).click()
  await expect(dialog.getByTestId('topic-mail-from')).toHaveCount(0)
  await dialog.getByTestId('topic-add-person').click()
  const email = `dana.${STAMP}@example.com`
  await dialog.getByTestId('topic-person-name').fill('Dana')
  await dialog.getByTestId('topic-person-email').fill(email)
  await dialog.getByTestId('topic-person-add').click()
  await expect(dialog.getByTestId('topic-mail-from')).toBeVisible()
  const account = await sendableAccount(request)
  if (account) {
    await dialog.getByTestId('topic-mail-from-button').click()
    await page.getByTestId('topic-mail-from-menu').getByRole('menuitemradio', { name: account.address }).click()
    // The pick closes only the menu, never the dialog under it.
    await expect(dialog).toBeVisible()
    await expect(dialog.getByTestId('topic-mail-from-button')).toHaveAttribute('data-account-id', account.accountId)
  }
  const words = `Walnut will email ${email} from ${account ? account.address : NO_MAILBOX} with this topic's new messages. Add?`
  const before = ((await (await request.get('/api/topics')).json()) as { topics: Array<{ title: string }> }).topics.length
  await dialog.getByTestId('topic-new-create').click()
  await expect(mailConfirm(page)).toContainText(words)
  await mailConfirm(page).getByRole('button', { name: 'Cancel' }).click()
  // Nothing made: the dialog stays with what was picked.
  await expect(dialog).toBeVisible()
  expect(((await (await request.get('/api/topics')).json()) as { topics: unknown[] }).topics.length).toBe(before)
  await dialog.getByTestId('topic-new-create').click()
  await mailConfirm(page).getByRole('button', { name: 'Add' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(chat(page).getByTestId('topic-title')).toHaveText(`Partner sync ${STAMP}`)
  const id = (await chat(page).getAttribute('data-topic-id')) ?? ''
  topicsMade.push(id)
  const stored = await readTopic(request, id)
  expect(stored.members.find((m) => m.ref.kind === 'person')).toMatchObject({ status: 'active', ref: { email } })
  expect(stored.mail?.accountId).toBe(account?.accountId)
  await expect(chat(page).getByTestId('topic-side').getByTestId('topic-mail-from')).toBeVisible()
})

test('the topic thread on the VP Threads view wears the members and opens the topic', async ({ page, request }) => {
  test.skip(!ids.topic, 'the topic was not made')
  const stored = await readTopic(request, ids.topic)
  expect(stored.thread, 'the VP host keeps Threads, so the topic has its thread').toBeTruthy()
  await openOrg(page)
  const vpRow = list(page).locator(`[data-testid="org-channel"][data-key="${NODE}"]`)
  // The row menu's "Add to topic…" lists the open topics; the VP is in this one already.
  await vpRow.click({ button: 'right' })
  await page.getByTestId('org-channel-menu').getByRole('menuitem', { name: 'Add to topic…' }).click()
  const add = page.getByTestId('topic-add-dialog')
  await expect(add.locator(`[data-testid="topic-add-pick"][data-topic-id="${ids.topic}"]`)).toContainText('Already in')
  await add.getByRole('button', { name: 'Cancel' }).click()
  await expect(add).toHaveCount(0)
  await vpRow.click()
  const detail = page.getByTestId('org-detail')
  await expect(detail).toHaveAttribute('data-key', NODE)
  const card = detail.locator(`[data-testid="org-thread"][data-thread-id="${stored.thread!.threadId}"]`)
  await expect(card).toBeVisible({ timeout: 30_000 })
  const badge = card.getByTestId('topic-thread-badge')
  await expect(badge).toHaveAttribute('data-topic-id', ids.topic)
  await expect(badge.getByTestId('topic-stack')).toBeVisible()
  // The Threads view offers a new topic with this VP already picked.
  await expect(detail.getByTestId('org-threads-new-topic')).toBeVisible()
  await shot(page, 'thread-card')
  await badge.getByTestId('topic-thread-open').click()
  await expect(chat(page)).toHaveAttribute('data-topic-id', ids.topic)
  await expect(chat(page).getByTestId('topic-title')).toHaveText(`Launch plan ${STAMP}`)
  await expect(list(page).locator(`[data-testid="org-topic"][data-topic-id="${ids.topic}"]`)).toHaveAttribute('aria-selected', 'true')
})
