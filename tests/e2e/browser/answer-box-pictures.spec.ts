/**
 * A picture pasted into a box that writes to an AI reaches that AI (2026-11-03, the user: "the
 * follow up in org thread or anywhere ... should be able to copy pictures"). Through the real UI:
 *  1. a letter's reply box takes a pasted screenshot (its thumbnail shows, × removes it, a second
 *     paste puts one back), Send threads the reply with the picture under it, the letter keeps the
 *     picture's name, and the letter's own session receives the file under the images header;
 *  2. an Org thread's Follow up takes a pasted screenshot and an attached one, Send files the
 *     follow-up with both pictures, and the lead's session receives them;
 *  3. a session's question card takes a screenshot under its own-words answer, and Submit sends
 *     the answer and the picture in ONE request, which the session reads as one tool result.
 * The paste is a real paste event carrying a File in its clipboardData, drawn on a canvas in the
 * page, the way a screenshot from the clipboard arrives. The receipts are the server's records and
 * the session's own history, never a status the UI printed. Every object this file makes it removes.
 */
import fs from 'node:fs'
import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { isolateUiPrefs } from './todo-panel-helpers'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const NONCE = `${Date.now().toString(36)}${process.pid.toString(36)}`
const SHOTS = `${process.env.WALNUT_TASK_DIR ?? 'test-results'}/shots`
const made: string[] = []
interface Letter { thread: Array<{ from: string; text: string; images?: string[] }> }
let fixtureRoot = ''

test.describe.configure({ mode: 'serial' })
// PW_RECORD_VIDEO=1 keeps a video of each flow (the demo the user asked to see), in test-results.
if (process.env.PW_RECORD_VIDEO) test.use({ viewport: { width: 1280, height: 800 }, video: { mode: 'on', size: { width: 1280, height: 800 } } })
test.setTimeout(180_000)

async function home(page: Page): Promise<void> {
  await page.setContent('<a id="fixture-entry" href="/">Open fixture console</a>')
  await page.locator('#fixture-entry').evaluate((a, url) => { (a as HTMLAnchorElement).href = url }, test.info().project.use.baseURL as string)
  await page.locator('#fixture-entry').click()
  await expect(page.locator('.main-page')).toBeVisible({ timeout: 30_000 })
}

/** Paste a screenshot (drawn on a canvas, a PNG File in clipboardData) into `box`. */
async function pasteScreenshot(box: Locator, label: string): Promise<void> {
  await box.focus()
  await box.evaluate(async (el, text) => {
    const canvas = document.createElement('canvas')
    canvas.width = 320
    canvas.height = 180
    const g = canvas.getContext('2d')!
    g.fillStyle = '#1f6feb'
    g.fillRect(0, 0, 320, 180)
    g.fillStyle = '#ffffff'
    g.font = 'bold 22px sans-serif'
    g.fillText(text, 16, 96)
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), 'image/png'))
    const file = new File([blob], 'Screenshot.png', { type: 'image/png' })
    const data = new DataTransfer()
    data.items.add(file)
    const ev = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(ev, 'clipboardData', { value: data })
    el.dispatchEvent(ev)
  }, label)
}

async function startSession(request: APIRequestContext, taskId?: string): Promise<string> {
  const res = await request.post('/api/sessions/quick-start', {
    data: { cwd: `${fixtureRoot}/projects/walnut`, message: taskId ? 'snapshot-clean-turn:Started.' : '', ...(taskId ? { taskId } : {}) },
  })
  expect(res.ok(), await res.text()).toBe(true)
  return ((await res.json()) as { sessionId: string }).sessionId
}

async function history(request: APIRequestContext, sid: string): Promise<string> {
  const res = await request.get(`/api/sessions/${sid}/history`)
  return res.ok() ? await res.text() : ''
}

/** A pause a viewer can follow, only while recording. */
async function beat(page: Page, ms = 900): Promise<void> {
  if (process.env.PW_RECORD_VIDEO) await page.waitForTimeout(ms)
}

async function shot(target: Locator, name: string): Promise<void> {
  fs.mkdirSync(SHOTS, { recursive: true })
  await target.screenshot({ path: `${SHOTS}/answer-pictures-${name}-${test.info().project.name}.png` })
}

test.beforeAll(async () => {
  ;({ fixtureRoot } = await discoverBrowserFixture(TEST_PORT))
})

test.afterAll(async ({ request }) => {
  for (const id of made) {
    const task = (await (await request.get(`/api/tasks/${id}`)).json()).task as { session_id?: string } | undefined
    if (task?.session_id) await request.post(`/api/v1/sessions/${task.session_id}/terminate`, { data: { force: true } })
    await request.delete(`/api/tasks/${id}?force=true`)
  }
})

test('a letter reply takes a pasted screenshot, and the letter\'s session receives it', async ({ page, request }) => {
  const origin = await startSession(request)
  const subject = `PW pictures letter ${NONCE}`
  const sent = await request.post('/api/v1/human-inbox', {
    data: { subject, type: 'review', markdown: `Does the header look right? (${NONCE})` },
    headers: { 'x-walnut-caller-sid': origin },
  })
  expect(sent.status(), await sent.text()).toBe(201)
  const letterId = ((await sent.json()) as { id: string }).id

  await isolateUiPrefs(page)
  await home(page)
  await page.getByRole('button', { name: /^Notifications/ }).click()
  const center = page.locator('.notification-panel')
  await center.locator('.nfc-rail-btn').filter({ hasText: 'Inbox' }).click()
  await center.locator('.hib-row').filter({ hasText: subject }).locator('.hib-subject').click()
  const reader = page.locator('.hib-reader')
  await expect(reader).toBeVisible({ timeout: 15_000 })

  const box = reader.getByTestId('letter-reply-input')
  const strip = reader.getByTestId('letter-reply-input-pictures')
  await pasteScreenshot(box, 'first paste')
  await expect(strip.locator('img')).toHaveCount(1)
  // × takes it off; a second paste puts one back (the box is not done after one).
  await strip.getByRole('button', { name: 'Remove image' }).click()
  await expect(strip).toHaveCount(0)
  await pasteScreenshot(box, `Header is cut off ${NONCE}`)
  await expect(strip.locator('img')).toHaveCount(1)
  await beat(page, 1500)
  await box.fill(`The header is cut off, see the picture (${NONCE})`)
  await shot(reader.locator('.hib-composer'), 'letter-before-send')
  await beat(page)
  await reader.locator('.hib-send-btn').click()

  await expect(reader.getByTestId('letter-turn-images').locator('img')).toHaveCount(1, { timeout: 20_000 })
  await expect(strip).toHaveCount(0)
  await expect(box).toHaveValue('')
  await beat(page, 2000)
  await shot(reader, 'letter-sent')

  const got = (await (await request.get(`/api/v1/human-inbox/${letterId}`)).json()) as { letter?: Letter } & Letter
  const letter: Letter = got.letter ?? got
  const turn = letter.thread.filter((t) => t.from === 'human').at(-1)!
  expect(turn.text).toBe(`The header is cut off, see the picture (${NONCE})`)
  expect(turn.images).toHaveLength(1)
  const name = turn.images![0]!
  // The picture is a real file the server serves.
  const img = await request.get(`/api/images/${name}`)
  expect(img.ok()).toBe(true)
  expect(img.headers()['content-type']).toMatch(/^image\//)
  // The letter's own session got the file under the images header, with the reply.
  await expect.poll(() => history(request, origin), { timeout: 45_000, intervals: [500, 1000, 2000] }).toContain('[Letter reply]')
  const said = await history(request, origin)
  expect(said).toContain(name)
  expect(said).toContain(`The header is cut off, see the picture (${NONCE})`)
})

test('an Org thread\'s Follow up takes a pasted and an attached screenshot, and the lead receives both', async ({ page, request }) => {
  const project = `Pictures led ${NONCE}`
  // A project with two teams has a lead, who keeps Threads.
  for (const title of [`Work ${NONCE}`, `Other ${NONCE}`]) {
    const work = await request.post('/api/tasks', { data: { title, project, source: 'local' } })
    made.push(((await work.json()) as { task: { id: string } }).task.id)
  }
  const contact = await request.post('/api/v1/org/contact', { data: { to: project } })
  const lead = ((await contact.json()) as { task: { id: string } }).task.id
  made.push(lead)
  await startSession(request, lead)
  await expect.poll(async () => (await (await request.get(`/api/tasks/${lead}`)).json()).task?.session_id ?? '', { timeout: 90_000 }).not.toBe('')
  const leadSid = (await (await request.get(`/api/tasks/${lead}`)).json()).task.session_id as string
  const opened = await request.post(`/api/v1/tasks/${lead}/threads`, { data: { text: `Fix the Org header layout ${NONCE}` } })
  expect(opened.ok(), await opened.text()).toBe(true)
  const threadId = ((await opened.json()) as { thread: { id: string } }).thread.id

  await isolateUiPrefs(page)
  await page.addInitScript(() => { localStorage.setItem('open-walnut-view:org.threads.showInProgress', 'true') })
  await home(page)
  await page.getByTestId('sidebar-org').click()
  await page.locator(`[data-testid="org-channel"][data-key="project:${project.toLowerCase()}"]`).click()
  const detail = page.getByTestId('org-detail')
  await detail.getByTestId('org-top-threads').click()
  const card = page.locator(`[data-testid="org-thread"][data-thread-id="${threadId}"]`)
  await expect(card).toBeVisible({ timeout: 30_000 })
  await card.getByTestId('org-thread-follow-open').click()

  const box = card.getByTestId('org-thread-follow-input')
  await pasteScreenshot(box, `Org header ${NONCE}`)
  // The attach button's picker takes a file too.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
  await card.getByTestId('org-thread-follow-input-attach-file').setInputFiles({ name: 'second.png', mimeType: 'image/png', buffer: png })
  const strip = card.getByTestId('org-thread-follow-input-pictures')
  await expect(strip.locator('img')).toHaveCount(2)
  await beat(page, 1500)
  await box.fill(`Here is how it looks now (${NONCE})`)
  await shot(card, 'org-before-send')
  await beat(page)
  await card.getByTestId('org-thread-follow-send').click()
  await expect(card.getByTestId('org-thread-follow')).toHaveCount(0, { timeout: 20_000 })

  await expect.poll(async () => {
    const res = await request.get(`/api/v1/tasks/${lead}/threads`)
    const t = ((await res.json()) as { threads: Array<{ id: string; messages: Array<{ via: string; images?: string[] }> }> }).threads.find((x) => x.id === threadId)
    const last = t?.messages.at(-1)
    return last?.via === 'follow-up' ? (last.images?.length ?? 0) : -1
  }, { timeout: 30_000 }).toBe(2)
  await expect.poll(() => history(request, leadSid), { timeout: 45_000, intervals: [500, 1000, 2000] }).toContain(`Here is how it looks now (${NONCE})`)
  expect(await history(request, leadSid)).toContain('[Images attached')
  // The lead's chat beside the side bar shows the message with its pictures.
  const chat = detail.locator('[data-testid="org-chat"]')
  await expect(chat.getByText(`Here is how it looks now (${NONCE})`).first()).toBeVisible({ timeout: 60_000 })
  await expect(chat.locator('img.inline-image').first()).toBeVisible({ timeout: 30_000 })
  await beat(page, 2500)
})

test('a question card sends its answer and its picture as one message', async ({ page, request }) => {
  const task = await request.post('/api/tasks', { data: { title: `PW question picture ${NONCE}`, project: 'Walnut', source: 'local' } })
  expect(task.ok(), await task.text()).toBe(true)
  const taskId = ((await task.json()) as { task: { id: string } }).task.id
  made.push(taskId)
  const started = await request.post('/api/sessions/quick-start', {
    data: { cwd: `${fixtureRoot}/projects/walnut`, message: 'status-permission-test:AskUserQuestion', taskId, mode: 'default' },
  })
  expect(started.ok(), await started.text()).toBe(true)
  const sid = ((await started.json()) as { sessionId: string }).sessionId
  await expect.poll(async () => ((await (await request.get(`/api/sessions/${sid}`)).json()).session?.pendingPermission?.toolName ?? ''),
    { timeout: 90_000 }).toBe('AskUserQuestion')

  // Every request the page makes to the session after Submit: the answer, and nothing that
  // carries the pictures on their own.
  const permissionBodies: Array<Record<string, unknown>> = []
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().endsWith(`/api/sessions/${sid}/permission`)) permissionBodies.push(r.postDataJSON() as Record<string, unknown>)
  })
  const sent: string[] = []
  page.on('websocket', (ws) => ws.on('framesent', (f) => {
    const text = typeof f.payload === 'string' ? f.payload : ''
    if (text.includes('session:send') && text.includes(sid)) sent.push(text)
  }))

  await isolateUiPrefs(page)
  await page.goto(`/sessions?id=${sid}`)
  const card = page.locator('.ask-user-question-card')
  await expect(card).toBeVisible({ timeout: 30_000 })
  const box = card.locator('.qp-input').last()
  await box.fill(`Like this one (${NONCE})`)
  await pasteScreenshot(box, `Badge mock ${NONCE}`)
  await expect(card.locator('.answer-box-pictures img')).toHaveCount(1)
  await beat(page, 1500)
  await shot(card, 'question-before-submit')
  // An upload that fails answers nothing and keeps the words and the picture for the next try.
  await page.route('**/api/images/upload', (route) => route.fulfill({ status: 503, json: { error: 'test: upload refused' } }))
  await card.locator('.permission-request-btn--allow').click()
  await expect(card.locator('.permission-request-btn--allow')).toBeEnabled({ timeout: 20_000 })
  expect(permissionBodies).toHaveLength(0)
  await expect(box).toHaveValue(`Like this one (${NONCE})`)
  await expect(card.locator('.answer-box-pictures img')).toHaveCount(1)
  await page.unroute('**/api/images/upload')
  await card.locator('.permission-request-btn--allow').click()

  await expect.poll(() => permissionBodies.length, { timeout: 20_000 }).toBe(1)
  const body = permissionBodies[0]!
  expect(body.answers).toEqual({ 'Which validation target?': `Like this one (${NONCE})` })
  expect(body.imageRefs).toHaveLength(1)
  // The one tool result: the images header, the saved file, and the words, in the answer itself.
  await expect.poll(() => historyText(request, sid), { timeout: 60_000 }).toContain('AskUserQuestion decision received: [Images attached')
  const said = await historyText(request, sid)
  const name = (body.imageRefs as Array<{ filename: string }>)[0]!.filename
  expect(said).toContain(name)
  expect(said).toContain(`Like this one (${NONCE})`)
  await beat(page, 1500)
  expect(sent, 'no message after the answer carries the pictures').toEqual([])
})

async function historyText(request: APIRequestContext, sid: string): Promise<string> {
  const res = await request.get(`/api/v1/sessions/${sid}/history?tail=80`)
  if (!res.ok()) return ''
  const body = (await res.json()) as { messages?: Array<{ text?: string }> }
  return (body.messages ?? []).map((m) => m.text ?? '').join('\n')
}
