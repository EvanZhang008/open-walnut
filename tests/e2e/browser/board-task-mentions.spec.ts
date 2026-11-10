/**
 * A task the Board names by id reads as the task's name, a live chip that opens it
 * (2026-10-31, the user: "make all the task if it is reference in the chat output
 * all name so that user can click"). The leader writes `<walnut-task>` by the
 * skill, but its messages and its prose cite tasks the way a model does: a bare
 * id, an id's first segment, an id in backticks, a `<task-ref/>`.
 *
 * The host resolves each token the text writes (board-model.ts boardMentionTokens,
 * mentionFrameRefs) and the frame turns the ones it knows into chips: messages in
 * board-markdown.frame.js, the page text in board-elements.frame.js. A token that
 * names no task, an id in a path and an id inside a longer code span stay text.
 *
 * Seed tasks (test-server.ts): mpwidref-7c2e (open), mpwidrf2-9b10 (done), the
 * UUID task 9c1d4e2a-… The chromium and webkit projects share one fixture server,
 * so each engine writes the Board of its own fixture task.
 */
import fs from 'node:fs/promises'
import { expect, test, type Locator, type Page } from '@playwright/test'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const API = `http://localhost:${TEST_PORT}`
const SHOTS = process.env.PW_SHOT_DIR ?? '/tmp/walnut-board-task-mentions'
const OPEN_ID = 'mpwidref-7c2e'
const DONE_ID = 'mpwidrf2-9b10'
const UUID_ID = '9c1d4e2a-7b3f-5a6c-8d9e-0f1a2b3c4d5e'

const HOSTS: Record<string, { task: string; session: string; search: string }> = {
  chromium: { task: 'pw-task-idref', session: 'pw-idref-session', search: 'Task id refs fixture' },
  webkit: { task: 'pw-task-codepath', session: 'pw-codepath-session', search: 'Code block paths fixture' },
}

test.setTimeout(150_000)
test.use({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1 })

function boardHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Board</title></head><body>
<h1>Mentions board</h1>
<section id="sec-a" data-project="area-a">
  <h3>Area A</h3>
  <p class="prose">Worker ${OPEN_ID} runs the probe; mpwidrf2 rotated the keys. Not tasks: 2ac8891 and /tmp/${OPEN_ID}/log.</p>
  <p class="code">Run <code>walnut task show ${OPEN_ID}</code> for details.</p>
  <walnut-thread id="area-a" title="Area A"></walnut-thread>
</section>
</body></html>`
}

async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
  const res = await fetch(`${API}${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`)
  return res
}

async function pointer(page: Page, target: Locator) {
  await target.scrollIntoViewIfNeeded()
  const bounds = await target.boundingBox()
  const rect = await target.evaluate(el => {
    const first = el.getClientRects()[0], whole = el.getBoundingClientRect()
    return first ? { dx: first.x - whole.x, dy: first.y - whole.y, width: first.width, height: first.height } : null
  })
  expect(bounds).not.toBeNull()
  expect(rect).not.toBeNull()
  await page.mouse.move(bounds!.x + rect!.dx + Math.min(25, rect!.width / 2), bounds!.y + rect!.dy + rect!.height / 2, { steps: 12 })
  await page.mouse.down()
  await page.mouse.up()
}

async function openBoard(page: Page, host: { task: string; session: string; search: string }) {
  await page.setContent(`<a href="${API}/">Open Walnut</a>`)
  await pointer(page, page.getByRole('link', { name: 'Open Walnut', exact: true }))
  await pointer(page, page.locator('.todo-search-input'))
  await page.keyboard.type(host.search, { delay: 20 })
  const row = page.locator(`.todo-panel-item[data-task-id="${host.task}"]`)
  await expect(row).toBeVisible({ timeout: 30_000 })
  await pointer(page, row.locator('.todo-item-title'))
  const panel = page.locator(`.main-page-session-column .session-panel[data-session-id="${host.session}"]`)
  await expect(panel).toBeVisible({ timeout: 20_000 })
  const chip = panel.getByTestId('session-board-chip')
  await expect(chip).toBeVisible({ timeout: 20_000 })
  await pointer(page, chip)
  const pane = page.getByTestId('task-board-pane')
  await pointer(page, pane.getByTestId('board-view-custom'))
  return page.frameLocator('.task-board-frame')
}

test.afterEach(async ({}, info) => {
  const host = HOSTS[info.project.name]
  if (host) await fetch(`${API}/api/v1/tasks/${host.task}/board`, { method: 'DELETE' }).catch(() => undefined)
})

test('task ids in the Board text and its messages become live chips', async ({ page }, info) => {
  const host = HOSTS[info.project.name]
  test.skip(!host, 'one fixture task per engine')
  await fs.mkdir(SHOTS, { recursive: true })
  const pageErrors: string[] = []
  page.on('pageerror', (e) => pageErrors.push(e.message))

  await api('PUT', `/api/v1/tasks/${host!.task}/board`, { html: boardHtml() })
  await api('POST', `/api/v1/tasks/${host!.task}/board/threads/area-a`, {
    text: `Done by ${OPEN_ID}, keys in \`${DONE_ID}\`, the order fix is <task-ref id="9c1d4e2a" label="old words"/>; hash 2ac8891 and \`git log ${OPEN_ID}\` stay text.`,
  }, { 'x-walnut-caller-sid': host!.session })

  const frame = await openBoard(page, host!)

  // The page text: the bare id and the first segment are chips with the names.
  const prose = frame.locator('#sec-a p.prose')
  await expect(prose.locator(`walnut-task[id="${OPEN_ID}"] .wn-title`)).toHaveText('Quarterly invoice reconciliation', { timeout: 20_000 })
  await expect(prose.locator('walnut-task[id="mpwidrf2"] .wn-title')).toHaveText('Rotate the staging API keys')
  await expect(prose.locator('walnut-task[id="mpwidrf2"] .wn-phase')).toHaveText('Completed')
  await expect(prose.locator('walnut-task')).toHaveCount(2)
  await expect(prose).toContainText('Not tasks: 2ac8891 and /tmp/mpwidref-7c2e/log.')
  // Code stays code.
  await expect(frame.locator('#sec-a p.code walnut-task')).toHaveCount(0)
  await expect(frame.locator('#sec-a p.code code')).toHaveText(`walnut task show ${OPEN_ID}`)

  // The message: a bare id, a backticked id and a task-ref by a UUID segment.
  const msg = frame.locator('walnut-thread .wn-msg .wn-text').last()
  await expect(msg.locator(`a.task-link:not(.task-link-code)[data-task-id="${OPEN_ID}"]`)).toHaveText('Quarterly invoice reconciliation', { timeout: 20_000 })
  await expect(msg.locator(`a.task-link[data-task-id="${DONE_ID}"]`)).toHaveText('Rotate the staging API keys')
  await expect(msg.locator(`a.task-link[data-task-id="${UUID_ID}"]`)).toHaveText('Chat order fixture')
  await expect(msg.locator('a.task-link')).toHaveCount(4)
  await expect(msg).toContainText('hash 2ac8891 and')
  await expect(msg.locator('code')).toHaveText(`git log ${OPEN_ID}`)
  // The thread may draw its messages again as the board settles (2026-11-10 gate: the element went away mid-scroll).
  await expect(async () => { await msg.scrollIntoViewIfNeeded({ timeout: 2_000 }) }).toPass({ timeout: 20_000 })
  await page.screenshot({ path: `${SHOTS}/${info.project.name}-board.png` })

  // An author cannot fabricate an input by calling a public element method.
  await msg.locator(`walnut-task[id="9c1d4e2a"]`).evaluate((el) => {
    const possible = el as HTMLElement & { wnOpen?: (event: unknown) => void };
    possible.wnOpen?.({ isTrusted: true });
  })
  expect(await page.evaluate((id) => JSON.parse(localStorage.getItem('walnut-todo-recent-opened') ?? '[]').some((e: { id: string }) => e.id === id), UUID_ID)).toBe(false)

  // A chip opens its task beside the board.
  await pointer(page, msg.locator(`a.task-link[data-task-id="${UUID_ID}"]`))
  await expect(page.getByTestId('board-task-peek').or(page.locator(`[data-task-id="${UUID_ID}"]`)).first()).toBeVisible({ timeout: 15_000 })
  await expect.poll(() => page.evaluate((id) => JSON.parse(localStorage.getItem('walnut-todo-recent-opened') ?? '[]').some((e: { id: string; human?: boolean }) => e.id === id && e.human === true), UUID_ID)).toBe(true)
  expect(pageErrors).toEqual([])
})
