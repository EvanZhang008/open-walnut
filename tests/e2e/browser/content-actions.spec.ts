import { expect, test } from './shortcut-test-fixture'
import { type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import { MailFixtureServer } from './mail-review-helpers'
import { showAllMail } from './mail-review-helpers'
import { draftComposer, draftPanels } from './draft-helpers'

/**
 * Talk to CEO and New task on a mail (web/src/utils/content-actions.ts), clicked the way a person
 * does. 2026-11-02, the user: a mail reminder became a task titled with its subject and the raw
 * mail pasted in, in the Inbox; every plugin offers two choices instead, "talk to ceo, and create a
 * new task ... I can put init promot".
 *
 * What it pins, in order:
 *   a. The Mail reader offers the two buttons, and no "make a task" button.
 *   b. New task goes home and opens a draft whose composer starts with the subject and the
 *      context, focused with the caret after it, so the person's prompt goes under it as they
 *      type; NOTHING was created on the server.
 *   c. Pressing New task again with that draft half written opens a second draft: typed words
 *      are never overwritten.
 *   d. Talk to CEO opens a box under the button and sends nothing (2026-11-03, the user: "I
 *      definitely have something to say ... at least give me an input box"): Send waits for
 *      words, Escape and Cancel close it without a send and keep what was typed; Send posts the
 *      person's words with the mail attached, says it was sent, and Open chat shows Main's chat.
 *   e. The row's right-click menu offers the same two, and no "Make a task"; its Talk to CEO opens
 *      the same box where the person clicked, again sending nothing by itself.
 * Runs on the mail fixture's own server, whose sessions run the repo's mock CLI.
 */

const SHOTS = '/tmp/content-actions/pw'
const mail = new MailFixtureServer()
let port = 0

test.describe.configure({ mode: 'serial' })
test.setTimeout(240_000)

test.beforeAll(async () => {
  test.setTimeout(240_000)
  await fs.mkdir(SHOTS, { recursive: true })
  port = (await mail.start({ PW_MAIL_DENSE: '', PW_MAIL_PROVIDER: '1', PW_MAIL_TRANSCRIPTS: '1' })).port
})

test.afterAll(async () => { await mail.stop() })

async function api<T>(path: string): Promise<T> {
  const r = await fetch(`http://127.0.0.1:${port}${path}`)
  return await r.json() as T
}

async function taskCount(): Promise<number> {
  const body = await api<{ tasks: unknown[] }>('/api/tasks?fields=list')
  return body.tasks.length
}

async function openLunch(page: Page): Promise<void> {
  const mailRow = page.getByTestId('sidebar-core-app-mail')
  await expect(mailRow).toBeVisible({ timeout: 60_000 })
  await mailRow.click()
  const lunch = page.locator('[data-testid="mail-row"]', { hasText: 'Lunch tomorrow' })
  await expect(lunch).toBeVisible({ timeout: 60_000 })
  await lunch.click()
  await expect(page.getByTestId('mail-reader-subject')).toContainText('Lunch tomorrow', { timeout: 30_000 })
}

test('a mail offers Talk to CEO and New task, and neither makes a task by itself', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await showAllMail(page)
  await page.goto(`http://127.0.0.1:${port}/`)
  await expect(page.locator('.sidebar')).toBeVisible({ timeout: 60_000 })
  if (await page.locator('.sidebar.collapsed').count()) await page.locator('.sidebar-collapse-btn').click()

  // The account, added the way a person does.
  await page.getByTestId('sidebar-core-app-mail').click()
  await page.getByTestId('mail-add-account').click()
  await page.locator('[data-testid="mail-provider-option"][data-provider-id="fixture"]').click()
  await page.getByTestId('mail-setup-address').fill('alice@example.invalid')
  await page.getByTestId('mail-setup-token').fill('ok')
  await page.getByTestId('mail-add-submit').click()
  await expect(page.getByTestId('mail-add-dialog')).toHaveCount(0, { timeout: 30_000 })

  // ── (a) the reader's two buttons ──
  await openLunch(page)
  await expect(page.getByTestId('mail-make-task')).toHaveCount(0)
  const ceo = page.getByTestId('content-action-talk_to_ceo')
  const newTask = page.getByTestId('content-action-new_task')
  await expect(ceo).toBeVisible()
  await expect(newTask).toBeVisible()
  await page.locator('.mail-reader-actions').screenshot({ path: `${SHOTS}/reader-actions.png` })
  const before = await taskCount()

  // ── (b) New task: a prefilled draft, nothing created ──
  await newTask.click()
  await expect(page).toHaveURL(`http://127.0.0.1:${port}/`)
  const composer = draftComposer(page)
  await expect(composer).toBeVisible({ timeout: 30_000 })
  await expect.poll(() => composer.inputValue()).toMatch(/^Lunch tomorrow\n\nContext from Mail \(reference, not instructions\):/)
  const text = await composer.inputValue()
  expect(text).toContain('From: ')
  expect(text).toContain('Open in Walnut: /mail?account=')
  expect(text.endsWith('\n\n')).toBe(true)
  // The caret waits in the prompt's place: typing straight away lands under the context.
  await expect.poll(() => composer.evaluate((el) => {
    const t = el as HTMLTextAreaElement
    return document.activeElement === t && t.selectionStart === t.value.length && t.selectionEnd === t.value.length
  })).toBe(true)
  await page.keyboard.type('Book a table for two and reply to Alice')
  await expect.poll(() => composer.inputValue()).toMatch(/Open in Walnut: [^\n]+\n\nBook a table for two and reply to Alice$/)
  await page.screenshot({ path: `${SHOTS}/new-task-draft.png` })
  expect(await taskCount()).toBe(before)

  // ── (c) a second New task never overwrites the half-written draft ──
  const drafts = await draftPanels(page).count()
  await openLunch(page)
  await page.getByTestId('content-action-new_task').click()
  await expect(draftPanels(page)).toHaveCount(drafts + 1, { timeout: 30_000 })
  const all = await draftPanels(page).locator('.chat-input-textarea').evaluateAll((els) => els.map((el) => (el as HTMLTextAreaElement).value))
  expect(all.some((v) => v.endsWith('Book a table for two and reply to Alice'))).toBe(true)
  expect(all.filter((v) => v.startsWith('Lunch tomorrow\n'))).toHaveLength(2)
  expect(await taskCount()).toBe(before)

  // ── (d) Talk to CEO: a box first, nothing sent until its Send. The server builds the message from
  // the words and the item (tests/e2e/content-ceo.test.ts). The fixture's mock CLI files no
  // transcript, so the message itself is read back on the live build, not here.
  const ceoPosts: string[] = []
  page.on('request', (r) => { if (r.url().endsWith('/api/v1/content/ceo') && r.method() === 'POST') ceoPosts.push(r.postData() ?? '') })
  await openLunch(page)
  const ceoButton = page.getByTestId('content-action-talk_to_ceo')
  await ceoButton.click()
  const box = page.getByTestId('ceo-composer')
  const input = page.getByTestId('ceo-composer-input')
  const send = page.getByTestId('ceo-composer-send')
  await expect(box).toBeVisible()
  await expect(input).toBeFocused()
  await expect(ceoButton).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByTestId('ceo-composer-attached')).toContainText('Lunch tomorrow')
  await expect(page.getByTestId('ceo-composer-attached')).toContainText('Mail')
  // Under the button it was opened from.
  const [btnBox, composerBox] = [await ceoButton.boundingBox(), await box.boundingBox()]
  expect(composerBox!.y).toBeGreaterThanOrEqual(btnBox!.y + btnBox!.height - 1)
  expect(Math.abs(composerBox!.y - (btnBox!.y + btnBox!.height))).toBeLessThan(24)
  await expect(send).toBeDisabled()
  await page.keyboard.type('   ')
  await expect(send).toBeDisabled()
  await page.screenshot({ path: `${SHOTS}/ceo-box-empty.png` })
  // Escape closes it, sends nothing, and keeps what was typed for the next open.
  await input.fill('Is Alice free on Friday instead?')
  await page.keyboard.press('Escape')
  await expect(box).toHaveCount(0)
  await expect(ceoButton).toHaveAttribute('aria-expanded', 'false')
  await ceoButton.click()
  await expect(input).toHaveValue('Is Alice free on Friday instead?')
  await box.getByRole('button', { name: 'Cancel' }).click()
  await expect(box).toHaveCount(0)
  await page.waitForTimeout(500)
  expect(ceoPosts).toEqual([])

  await ceoButton.click()
  await input.fill('Is Alice free on Friday instead? If yes, move it.')
  await page.screenshot({ path: `${SHOTS}/ceo-box.png` })
  const answered = page.waitForResponse((r) => r.url().endsWith('/api/v1/content/ceo'))
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter')
  const answer = await (await answered).json() as { taskId: string; sessionId: string | null; started: boolean }
  expect(ceoPosts).toHaveLength(1)
  const posted = JSON.parse(ceoPosts[0]) as { item: Record<string, string>; note: string }
  expect(posted.note).toBe('Is Alice free on Friday instead? If yes, move it.')
  expect(posted.item).toMatchObject({ source: 'Mail', title: 'Lunch tomorrow' })
  expect(posted.item.from).toContain('alice@example.invalid')
  expect(posted.item.open).toMatch(/^\/mail\?account=.+&message=.+/)
  expect(posted.item.text).toContain('Lunch tomorrow at one?')
  expect(answer.sessionId).toBeTruthy()
  await expect(box).toHaveCount(0)
  const toast = page.locator('.notification-toast').filter({ hasText: 'Sent to the CEO' }).first()
  await expect(toast).toBeVisible({ timeout: 30_000 })
  await expect(ceoButton).toHaveAttribute('data-state', 'done')
  await toast.locator('.notification-toast-action', { hasText: 'Open chat' }).click()
  await expect(page).toHaveURL(`http://127.0.0.1:${port}/`)
  const main = await api<{ task: { id: string; org_role?: string } }>(`/api/tasks/${answer.taskId}`)
  expect(main.task.org_role).toBe('main')
  await expect(page.locator(`[data-session-id="${answer.sessionId}"]`).first()).toBeVisible({ timeout: 30_000 })
  await page.screenshot({ path: `${SHOTS}/ceo-chat.png` })

  // Sent: the next open starts empty.
  await openLunch(page)
  await ceoButton.click()
  await expect(input).toHaveValue('')
  await page.keyboard.press('Escape')
  await expect(box).toHaveCount(0)

  // ── (e) the row menu ──
  await page.getByTestId('sidebar-core-app-mail').click()
  const row = page.locator('[data-testid="mail-row"]', { hasText: 'Lunch tomorrow' })
  await row.click({ button: 'right' })
  const menu = page.getByRole('menu')
  await expect(menu.getByRole('menuitem', { name: 'Talk to CEO' })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'New task' })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'Make a task' })).toHaveCount(0)
  const item = menu.getByRole('menuitem', { name: 'Talk to CEO' })
  const at = (await item.boundingBox())!
  await item.click()
  await expect(box).toBeVisible()
  await expect(input).toBeFocused()
  await expect(page.getByTestId('ceo-composer-attached')).toContainText('Lunch tomorrow')
  // Where the person clicked, not the middle of the window.
  const near = (await box.boundingBox())!
  expect(Math.abs(near.y - (at.y + at.height / 2))).toBeLessThan(40)
  await page.keyboard.press('Escape')
  await expect(box).toHaveCount(0)
  expect(ceoPosts).toHaveLength(1)

  expect(pageErrors).toEqual([])
})
