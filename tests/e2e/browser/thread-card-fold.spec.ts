/**
 * A long thread card stays readable whole and its answer follows its words (2026-11-22, UI audit on
 * the user's own Threads at 1280 x 800). The words are never cut (the user, 2026-11-20: "the threa
 * over here shoud show all"); what shortens the card is its long paths read as short names.
 *
 *  1. A Needs you card whose body names two long local paths: each path reads as a short name on
 *     one line (the whole path its tooltip, still the same link), so the body is shorter than with
 *     the paths written out; the body reads whole, with no toggle and nothing cut; its choices and
 *     its reply box come right after it.
 *  2. A Done card's body reads whole too, its buttons right after it; a related task's long name
 *     wraps whole, never cut at the chip's end.
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { loadHome } from './draft-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'
import { restoreOneCard, setOneCard, type OneCardWas } from './one-card-helpers'

const STAMP = `${Date.now().toString(36)}${process.pid.toString(36)}`
const PROJECT = `Card fold ${STAMP}`
const made: string[] = []
let oneCardWas: OneCardWas | null = null
const SHOTS = `${process.env.WALNUT_TASK_DIR ?? 'test-results'}/shots`

const DESIGNS = '/Users/someone/.local/state/open-walnut/tasks/b89f10f0-bdd0-5134-aafc-8fecb73668ed/design-t3/index.html'
const VIDEO = '/Users/someone/.local/state/open-walnut/tasks/b89f10f0-bdd0-5134-aafc-8fecb73668ed/design-t3/video/d1.mp4'
const PARA = 'The composer under the chat keeps its height when the picker opens, and the project and folder choices move to the line above it so nothing jumps while you type. '
const NEEDS_BODY = [
  `**Pick one.** The designs are at ${DESIGNS}, ten of them on one page; the recording is ${VIDEO}.`,
  `**Design 1 is** ${PARA.repeat(2)}`,
  `**What stays the same:** ${PARA}`,
  `**Two looks:** ${PARA.repeat(2)}`,
  'Reply with a number, or tell me what to change before you pick.',
].join('\n\n')
const DONE_BODY = `The fix is live. ${PARA.repeat(6)}The last line of the conclusion.`
const LONG_TASK = `Task status foundation and org testing · Only Threads, with a long name that wraps ${STAMP}`
const OPTIONS = [
  { label: '1 Headline sentence', detail: 'One sentence on top, the project and folder under it', recommended: true },
  { label: '6 Two-pane picker', detail: 'The picker on the left, the preview on the right' },
  { label: '2 Work in pill', detail: 'Keep the pill, fix its height' },
  { label: '8 Plan card', detail: 'A card above the box with the plan' },
  { label: '4 Keep it as it is', detail: 'Nothing changes' },
]
const WHY = { user_kind: 'user_own', user_kind_why: 'It is his own product choice.' }
const rowKey = (project: string) => `project:${project.trim().toLowerCase()}`

test.describe.configure({ mode: 'serial' })
test.setTimeout(180_000)
test.use({ viewport: { width: 1280, height: 800 } })

async function post<T>(request: APIRequestContext, url: string, data: unknown): Promise<T> {
  const res = await request.post(url, { data })
  expect(res.ok(), `${url}: ${await res.text()}`).toBe(true)
  return (await res.json()) as T
}

let lead = ''
let related = ''
const ids: Record<'needs' | 'done' | 'short', string> = { needs: '', done: '', short: '' }

async function openThread(request: APIRequestContext, title: string, reply: string, state: 'needs' | 'answered', extra: Record<string, unknown> = {}): Promise<string> {
  const opened = await post<{ thread: { id: string } }>(request, `/api/v1/tasks/${lead}/threads/open`, { title, text: title, state, from: 'node', ...WHY })
  const res = await request.patch(`/api/v1/tasks/${lead}/threads/${opened.thread.id}`, { data: { reply, state, ...WHY, ...extra } })
  expect(res.ok(), await res.text()).toBe(true)
  return opened.thread.id
}

test.beforeAll(async ({ request }) => {
  oneCardWas = await setOneCard(request, true)
  // A project with two or more teams gets a lead (org_contact).
  for (const title of [`Side work ${STAMP}`, LONG_TASK]) {
    made.push((await post<{ task: { id: string } }>(request, '/api/tasks', { title, project: PROJECT, source: 'local' })).task.id)
  }
  related = made[1]
  lead = (await post<{ task: { id: string } }>(request, '/api/v1/org/contact', { to: PROJECT })).task.id
  made.push(lead)
  ids.needs = await openThread(request, `Where new tasks run ${STAMP}`, NEEDS_BODY, 'needs', { options: OPTIONS })
  ids.done = await openThread(request, `Done long ${STAMP}`, DONE_BODY, 'answered', { tasks: [related] })
  ids.short = await openThread(request, `Done short ${STAMP}`, 'Shipped; nothing more to do.', 'answered')
})

test.afterAll(async ({ request }) => {
  await restoreOneCard(request, oneCardWas)
  for (const id of made) {
    for (let i = 0; i < 10; i++) {
      const res = await request.delete(`/api/tasks/${id}?force=true`)
      if (res.ok() || res.status() === 404) break
      await new Promise((r) => setTimeout(r, 500))
    }
  }
})

async function openLead(page: Page): Promise<void> {
  await page.getByTestId('sidebar-org').click()
  await expect(page.getByTestId('org-page')).toBeVisible()
  await page.locator(`[data-testid="org-channel"][data-key="${rowKey(PROJECT)}"]`).click()
  await expect(page.getByTestId('org-detail')).toHaveAttribute('data-key', rowKey(PROJECT))
}

const card = (page: Page, id: string) => page.locator(`[data-testid="org-thread"][data-thread-id="${id}"]`)

test('a long thread card reads whole, its paths short, its answer right after its words', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await isolateUiPrefs(page)
  await loadHome(page)
  await openLead(page)

  // 1. The Needs you card.
  const needs = card(page, ids.needs)
  await expect(needs).toBeVisible({ timeout: 20_000 })
  await needs.scrollIntoViewIfNeeded()
  await needs.evaluate((el) => el.scrollIntoView({ block: 'start' }))
  const body = needs.getByTestId('org-thread-reply')
  // Whole: nothing cut, no toggle.
  await expect(body).toContainText('Reply with a number, or tell me what to change')
  await expect(needs.getByTestId('org-thread-reply-more')).toHaveCount(0)
  const whole = await body.evaluate((el) => ({ ch: el.clientHeight, sh: el.scrollHeight }))
  expect(whole.sh).toBeLessThanOrEqual(whole.ch + 1)
  // Each long path reads as its short name on one line, the whole path its tooltip, the same link.
  const line = await body.evaluate((el) => Number.parseFloat(getComputedStyle(el).lineHeight))
  for (const [full, short] of [[DESIGNS, /^…\/design-t3\/index\.html$/], [VIDEO, /^…\/video\/d1\.mp4$/]] as const) {
    const link = body.locator(`a[data-file-path="${full}"]`)
    await expect(link).toHaveText(short)
    await expect(link).toHaveAttribute('title', full)
    expect((await link.boundingBox())!.height, `${full} on one line`).toBeLessThan(line * 1.5)
  }
  // Shorter than with the paths written out: put the whole paths back and measure the difference.
  const longer = await body.evaluate((el) => {
    const links = [...el.querySelectorAll<HTMLAnchorElement>('a[data-short-label]')]
    const was = links.map((a) => a.textContent)
    const before = el.getBoundingClientRect().height
    for (const a of links) a.textContent = a.title
    const after = el.getBoundingClientRect().height
    links.forEach((a, i) => { a.textContent = was[i] })
    return { before, after }
  })
  expect(longer.after - longer.before, 'the short names save lines').toBeGreaterThanOrEqual(line * 2 - 1)
  // Its choices and its box come right after its words (only the one-line Conversation toggle between).
  const options = needs.getByTestId('org-answer-option')
  await expect(options).toHaveCount(OPTIONS.length)
  const bodyBox = (await body.boundingBox())!
  const first = (await options.first().boundingBox())!
  expect(first.y - (bodyBox.y + bodyBox.height), 'the choices follow the words').toBeLessThan(72)
  const last = (await options.last().boundingBox())!
  const box = (await needs.getByTestId('org-thread-follow-input').boundingBox())!
  expect(box.y - (last.y + last.height), 'the box follows the choices').toBeLessThan(24)
  await page.screenshot({ path: `${SHOTS}/thread-card-fold-needs-${test.info().project.name}.png`, clip: (await needs.boundingBox())! })

  // 2. The Done card: whole, its related task's long name whole.
  const done = card(page, ids.done)
  await done.scrollIntoViewIfNeeded()
  await expect(done.getByTestId('org-thread-reply')).toContainText('The last line of the conclusion.')
  await expect(done.getByTestId('org-thread-reply-more')).toHaveCount(0)
  const chip = done.locator(`[data-testid="org-thread-task"][data-task-id="${related}"]`)
  await expect(chip).toContainText(LONG_TASK)
  const name = chip.locator('.wn-title')
  const fit = await name.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth, overflow: getComputedStyle(el).textOverflow, white: getComputedStyle(el).whiteSpace }))
  expect(fit.sw).toBeLessThanOrEqual(fit.cw + 1)
  expect(fit.white).toBe('normal')
  const chipBox = (await chip.boundingBox())!
  const cardBox = (await done.boundingBox())!
  expect(chipBox.x + chipBox.width).toBeLessThanOrEqual(cardBox.x + cardBox.width + 1)
  // Its buttons come right after its words, its chip and its Conversation toggle.
  const ack = (await done.getByTestId('org-thread-ack').boundingBox())!
  const reply = (await done.getByTestId('org-thread-reply').boundingBox())!
  expect(ack.y - (reply.y + reply.height)).toBeLessThan(140)
  await page.screenshot({ path: `${SHOTS}/thread-card-fold-done-${test.info().project.name}.png`, clip: (await done.boundingBox())! })

  await expect(card(page, ids.short).getByTestId('org-thread-reply')).toContainText('Shipped; nothing more to do.')
  expect(errors).toEqual([])
})
