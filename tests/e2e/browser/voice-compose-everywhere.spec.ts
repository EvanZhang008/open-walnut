/**
 * Voice in the boxes where a person writes to Walnut, on the real follow-up flow of the Org
 * Threads (the reported case, web/src/components/org/OrgThreads.tsx FollowUp) and on the shared
 * one-line box (MicInput, web/src/components/common/BoxMic.tsx) that names, titles and searches
 * now use. tests/web/compose-voice-guard.test.ts proves from source that every such box has the
 * mic; this file proves the mic does the right thing in them.
 *
 * Scenario matrix (Chromium: a synthetic microphone and a canned engine that can be HELD, the
 * recipe of send-waits-helpers.ts; Linux WebKit has no MediaRecorder):
 *  1. Follow up, Send while recording: the send waits for the final words, then files typed and
 *     dictated words once under the thread, and the box closes.
 *  2. Typing while the words come in: what the person types after the live preview stays, and
 *     the final words replace only the preview.
 *  3. A failed transcription: nothing is filed, the typed words and preview stay, the mic shows its
 *     error; dictating again and sending files the words once (retry).
 *  4. Closing the follow-up while its words are still being transcribed: the late words land
 *     nowhere (not in another thread's box, not in a reopened one) and nothing is filed.
 *  5. Esc while the send waits: the wait ends, the words land in the box unsent, Send then sends.
 *  6. A search box (MicInput): dictated words land in the box and filter the list; an Enter while
 *     the words are still coming acts only once they are in.
 * The fixture server is shared: this file makes its own lead and threads under a per-run stamp and
 * removes the tasks it made. Shots: /tmp/voice-compose-everywhere/<name>.png.
 */
import fs from 'node:fs'
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { loadHome } from './draft-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'
import { useSyntheticMic } from './stt-failure-helpers'
import { DRAFTED, FULL, stubEngine, type Lane } from './send-waits-helpers'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const STAMP = `${Date.now().toString(36)}${process.pid.toString(36)}`
const LED = `Voice follow ${STAMP}`
const SHOTS = process.env.VOICE_COMPOSE_SHOTS ?? '/tmp/voice-compose-everywhere'
const TYPED = 'Note:'
const made: string[] = []
const ids = { lead: '', leadSid: '', a: '', b: '' }

test.describe.configure({ mode: 'serial' })
test.setTimeout(150_000)
test.use({ viewport: { width: 1280, height: 860 } })

interface Thread { id: string; title: string; messages: Array<{ text: string; via: string }> }

const rowKey = (project: string) => `project:${project.trim().toLowerCase()}`

async function shot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(SHOTS, { recursive: true })
  await page.screenshot({ path: `${SHOTS}/${name}.png`, timeout: 15_000 }).catch(() => {})
}

async function threads(request: APIRequestContext): Promise<Thread[]> {
  const res = await request.get(`/api/v1/tasks/${ids.lead}/threads`)
  expect(res.ok(), await res.text()).toBe(true)
  return ((await res.json()) as { threads: Thread[] }).threads
}

async function followUps(request: APIRequestContext, id: string): Promise<string[]> {
  return ((await threads(request)).find((t) => t.id === id)?.messages ?? []).filter((m) => m.via === 'follow-up').map((m) => m.text)
}

async function openThread(request: APIRequestContext, title: string): Promise<string> {
  const res = await request.post(`/api/v1/tasks/${ids.lead}/threads/open`, {
    data: { title, text: `Please decide: ${title}`, from: 'mail', ref: title, user_kind: 'user_own', user_kind_why: 'It is his own decision' },
    headers: { 'x-walnut-caller-sid': ids.leadSid },
  })
  expect(res.status(), await res.text()).toBe(201)
  return ((await res.json()) as { thread: Thread }).thread.id
}

async function removeTask(request: APIRequestContext, id: string): Promise<void> {
  const task = (await (await request.get(`/api/tasks/${id}`)).json()).task as { session_id?: string } | undefined
  if (task?.session_id) await request.post(`/api/v1/sessions/${task.session_id}/terminate`, { data: { force: true } })
  for (let i = 0; i < 10; i++) {
    const res = await request.delete(`/api/tasks/${id}?force=true`)
    if (res.ok() || res.status() === 404) return
    await new Promise((r) => setTimeout(r, 500))
  }
}

/** Home, then the Org page and the lead's node, by clicks; it opens on Threads. */
async function openThreads(page: Page): Promise<void> {
  await isolateUiPrefs(page)
  await page.addInitScript(() => { localStorage.setItem('open-walnut-view:org.threads.showInProgress', 'true') })
  await loadHome(page)
  await page.getByTestId('sidebar-org').click()
  await expect(page.getByTestId('org-page')).toBeVisible()
  await page.locator(`[data-testid="org-channel"][data-key="${rowKey(LED)}"]`).click()
  const detail = page.getByTestId('org-detail')
  await expect(detail).toHaveAttribute('data-key', rowKey(LED))
  await expect(detail.getByTestId('org-top')).toHaveAttribute('data-view', 'threads')
}

interface Follow { card: Locator; box: Locator; input: Locator; mic: Locator; send: Locator }

async function openFollowUp(page: Page, threadId: string): Promise<Follow> {
  const card = page.locator(`[data-testid="org-thread"][data-thread-id="${threadId}"]`)
  await expect(card).toBeVisible({ timeout: 30_000 })
  const box = card.getByTestId('org-thread-follow')
  await expect(box).toBeVisible()
  return {
    card,
    box,
    input: box.getByTestId('org-thread-follow-input'),
    mic: box.locator('.mic-btn').first(),
    send: box.getByTestId('org-thread-follow-send'),
  }
}

/** Type a few words, start the mic and wait for the live preview after them. */
async function typeThenDictate(f: Follow, lane: Lane): Promise<void> {
  lane.final = false
  await f.input.click()
  await f.input.fill(TYPED)
  await f.mic.click()
  await expect(f.mic).toHaveClass(/mic-recording/, { timeout: 15_000 })
  await expect(f.input).toHaveValue(`${TYPED} ${DRAFTED}`, { timeout: 15_000 })
}

test.beforeAll(async ({ request }) => {
  test.setTimeout(150_000)
  const { fixtureRoot } = await discoverBrowserFixture(TEST_PORT)
  // Org contact resolves a real project, not an invented name with no registry row.
  const work = await request.post('/api/tasks', { data: { title: `Voice input acceptance ${STAMP}`, project: LED, source: 'local' } })
  expect(work.ok(), await work.text()).toBe(true)
  made.push(((await work.json()) as { task: { id: string } }).task.id)
  // A project with several teams has a lead; one task resolves to that task itself.
  const second = await request.post('/api/tasks', { data: { title: `Voice input recovery ${STAMP}`, project: LED, source: 'local' } })
  expect(second.ok(), await second.text()).toBe(true)
  made.push(((await second.json()) as { task: { id: string } }).task.id)
  const response = await request.post('/api/v1/org/contact', { data: { to: LED } })
  expect(response.ok(), await response.text()).toBe(true)
  const contact = await response.json() as { task: { id: string } }
  ids.lead = contact.task.id
  made.push(ids.lead)
  const started = await request.post('/api/sessions/quick-start', { data: { cwd: `${fixtureRoot}/projects/walnut`, message: 'snapshot-clean-turn:Started.', taskId: ids.lead } })
  expect(started.ok(), await started.text()).toBe(true)
  await expect.poll(async () => (await (await request.get(`/api/tasks/${ids.lead}`)).json()).task?.session_id ?? '', { timeout: 90_000 }).not.toBe('')
  ids.leadSid = (await (await request.get(`/api/tasks/${ids.lead}`)).json()).task.session_id
  ids.a = await openThread(request, `Voice thread A ${STAMP}`)
  ids.b = await openThread(request, `Voice thread B ${STAMP}`)
})

test.afterAll(async ({ request }) => {
  for (const id of made) await removeTask(request, id)
})

test.beforeEach(({ browserName }) => {
  test.skip(browserName !== 'chromium', 'the synthetic microphone needs MediaRecorder, which Linux WebKit lacks')
})

test('Follow up: Send while recording waits for the final words and files them once under the thread', async ({ page, request }) => {
  await useSyntheticMic(page)
  const lane = await stubEngine(page)
  await openThreads(page)
  const before = (await followUps(request, ids.a)).length
  const f = await openFollowUp(page, ids.a)
  await typeThenDictate(f, lane)
  lane.held = true
  await f.send.click()
  await expect(f.send).toHaveAttribute('data-dictation-wait', 'true')
  await expect(f.send).toBeEnabled()
  await shot(page, 'follow-waiting')
  // Nothing is filed while the words are still coming.
  await page.waitForTimeout(800)
  expect(await followUps(request, ids.a)).toHaveLength(before)
  lane.release()
  await expect.poll(async () => (await followUps(request, ids.a)).length, { timeout: 30_000 }).toBe(before + 1)
  expect((await followUps(request, ids.a)).at(-1)).toBe(`${TYPED} ${FULL}`)
  await expect(f.box).toHaveCount(0)
  // No second copy arrives later.
  await page.waitForTimeout(1500)
  expect(await followUps(request, ids.a)).toHaveLength(before + 1)
  await shot(page, 'follow-sent')
})

test('Follow up: typing while the words come in keeps the typing, and the final words replace only the preview', async ({ page, request }) => {
  await useSyntheticMic(page)
  const lane = await stubEngine(page)
  await openThreads(page)
  const before = (await followUps(request, ids.a)).length
  const f = await openFollowUp(page, ids.a)
  await typeThenDictate(f, lane)
  // The person keeps typing at the end while the mic still records.
  await f.input.press('End')
  await f.input.pressSequentially(' asap')
  await expect(f.input).toHaveValue(`${TYPED} ${DRAFTED} asap`)
  lane.final = true
  await f.mic.click()
  await expect(f.input).toHaveValue(`${TYPED} ${FULL} asap`, { timeout: 20_000 })
  await f.send.click()
  await expect.poll(async () => (await followUps(request, ids.a)).length, { timeout: 30_000 }).toBe(before + 1)
  expect((await followUps(request, ids.a)).at(-1)).toBe(`${TYPED} ${FULL} asap`)
})

test('Follow up: a failed transcription files nothing and keeps the words; dictating again then sends once', async ({ page, request }) => {
  await useSyntheticMic(page)
  const lane = await stubEngine(page)
  // The dictation's own log lines, for the failure message of the retry below.
  const stt: string[] = []
  page.on('console', (m) => { if (/\[stt\]/.test(m.text())) stt.push(m.text()) })
  await openThreads(page)
  const before = (await followUps(request, ids.b)).length
  const f = await openFollowUp(page, ids.b)
  await typeThenDictate(f, lane)
  lane.held = true
  lane.fail = true
  await f.send.click()
  await expect(f.send).toHaveAttribute('data-dictation-wait', 'true')
  lane.release()
  await expect(page.locator('.mic-error-bubble').first()).toBeVisible({ timeout: 20_000 })
  await expect(f.send).not.toHaveAttribute('data-dictation-wait', 'true')
  await expect(f.input).toHaveValue(`${TYPED} ${DRAFTED}`)
  await page.waitForTimeout(800)
  expect(await followUps(request, ids.b)).toHaveLength(before)
  await shot(page, 'follow-failed-kept')

  // Retry: the engine answers again; a new recording, Send while it records, one follow-up.
  lane.fail = false
  lane.final = false
  await f.input.click()
  await f.input.press('End')
  // The first press may only dismiss the error the mic shows; press until it records.
  await expect(async () => {
    if (!/mic-recording/.test((await f.mic.getAttribute('class')) ?? '')) await f.mic.click()
    await expect(f.mic).toHaveClass(/mic-recording/, { timeout: 4_000 })
  }).toPass({ timeout: 20_000 })
  // The person speaks once the button stops saying "Starting the microphone" (the
  // mic delivered its first sound). A Send before that holds no words at all: the
  // first clouddev runs pressed it 87 ms in, and the take was empty (classifyTake).
  await expect(f.mic).not.toHaveClass(/mic-starting/, { timeout: 10_000 })
  await page.waitForTimeout(1000) // a second of speech, under the 2 s live-draft tick
  const said = { draft: lane.arrivals.draft, transcribe: lane.arrivals.transcribe, stt: stt.length }
  lane.held = true
  await f.send.click()
  await expect(f.send).toHaveAttribute('data-dictation-wait', 'true')
  // The final pass of this take reaches the engine and waits there.
  await expect.poll(() => lane.arrivals.transcribe, { timeout: 20_000 }).toBe(said.transcribe + 1)
  lane.release()
  await expect.poll(async () => (await followUps(request, ids.b)).length, { timeout: 30_000 }).toBe(before + 1)
  const sent = (await followUps(request, ids.b)).at(-1) ?? ''
  const why = `sent ${JSON.stringify(sent)}; engine calls after the retry: ${lane.arrivals.draft - said.draft} draft, ${lane.arrivals.transcribe - said.transcribe} final; [stt] since: ${stt.slice(said.stt).join(' | ')}`
  expect(sent.startsWith(`${TYPED} ${DRAFTED}`), why).toBe(true)
  expect(sent.endsWith(FULL), why).toBe(true)
})

test('Follow up: closing the box while its words are still coming drops them; no other box gets them', async ({ page, request }) => {
  await useSyntheticMic(page)
  const lane = await stubEngine(page)
  await openThreads(page)
  const beforeA = (await followUps(request, ids.a)).length
  const beforeB = (await followUps(request, ids.b)).length
  const a = await openFollowUp(page, ids.a)
  await typeThenDictate(a, lane)
  lane.held = true
  // Stop the mic: its words are now being transcribed, held by the engine.
  await a.mic.click()
  await expect(a.mic).toHaveClass(/mic-transcribing/, { timeout: 10_000 })
  await a.box.getByRole('button', { name: 'Cancel' }).click()
  await expect(a.box).toHaveCount(0)
  // Another thread's box opens while the old words are still owed.
  const b = await openFollowUp(page, ids.b)
  lane.release()
  await page.waitForTimeout(2000)
  await expect(b.input).toHaveValue('')
  await b.box.getByRole('button', { name: 'Cancel' }).click()
  const again = await openFollowUp(page, ids.a)
  await expect(again.input).toHaveValue('')
  expect(await followUps(request, ids.a)).toHaveLength(beforeA)
  expect(await followUps(request, ids.b)).toHaveLength(beforeB)
  await shot(page, 'follow-closed-dropped')
})

test('Follow up: Esc while the send waits ends the wait; the words land unsent, and Send sends them', async ({ page, request }) => {
  await useSyntheticMic(page)
  const lane = await stubEngine(page)
  await openThreads(page)
  const before = (await followUps(request, ids.b)).length
  const f = await openFollowUp(page, ids.b)
  await typeThenDictate(f, lane)
  lane.held = true
  await f.send.click()
  await expect(f.send).toHaveAttribute('data-dictation-wait', 'true')
  await page.keyboard.press('Escape')
  await expect(f.send).not.toHaveAttribute('data-dictation-wait', 'true')
  // Esc went to the wait: the box is still open.
  await expect(f.box).toBeVisible()
  lane.release()
  await expect(f.input).toHaveValue(`${TYPED} ${FULL}`, { timeout: 20_000 })
  await page.waitForTimeout(800)
  expect(await followUps(request, ids.b)).toHaveLength(before)
  await f.send.click()
  await expect.poll(async () => (await followUps(request, ids.b)).length, { timeout: 30_000 }).toBe(before + 1)
  expect((await followUps(request, ids.b)).at(-1)).toBe(`${TYPED} ${FULL}`)
})

test('a search box (MicInput): dictated words land in it and filter; Enter while they are coming waits for them', async ({ page }) => {
  await useSyntheticMic(page)
  const lane = await stubEngine(page)
  await openThreads(page)
  const search = page.getByTestId('org-search')
  const field = search.locator('xpath=..')
  const mic = field.locator('.mic-btn').first()
  await expect(mic).toBeVisible()
  // The mic sits inside the box's right edge.
  const box = await search.boundingBox()
  const at = await mic.boundingBox()
  expect(box && at && at.x >= box.x && at.x + at.width <= box.x + box.width + 1).toBe(true)
  await search.click()
  lane.final = false
  await mic.click()
  await expect(mic).toHaveClass(/mic-recording/, { timeout: 15_000 })
  await expect(search).toHaveValue(DRAFTED, { timeout: 15_000 })
  lane.held = true
  // Enter while recording stops the mic and waits: nothing acts on half the words.
  await search.press('Enter')
  await expect(mic).not.toHaveClass(/mic-recording/, { timeout: 10_000 })
  lane.release()
  await expect(search).toHaveValue(FULL, { timeout: 20_000 })
  // No VP or router is named like the dictated words: the list filters to none of the lead's rows.
  await expect(page.locator(`[data-testid="org-channel"][data-key="${rowKey(LED)}"]`)).toHaveCount(0)
  await search.fill('')
  await expect(page.locator(`[data-testid="org-channel"][data-key="${rowKey(LED)}"]`)).toBeVisible()
  await shot(page, 'search-mic')
})
