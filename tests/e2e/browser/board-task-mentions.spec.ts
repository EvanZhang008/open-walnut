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
import { expect, test, type Page } from '@playwright/test'
import { showCustomBoard } from './board-view-helpers'

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

async function openBoard(page: Page, host: { task: string; session: string; search: string }) {
  await page.setContent(`<a href="${API}/">Open Walnut</a>`)
  await page.getByRole('link', { name: 'Open Walnut', exact: true }).click()
  await page.locator('.todo-search-input').fill(host.search)
  const row = page.locator(`.todo-panel-item[data-task-id="${host.task}"]`)
  await expect(row).toBeVisible({ timeout: 30_000 })
  await row.locator('.todo-item-title').click()
  const panel = page.locator(`.main-page-session-column .session-panel[data-session-id="${host.session}"]`)
  await expect(panel).toBeVisible({ timeout: 20_000 })
  const chip = panel.getByTestId('session-board-chip')
  await expect(chip).toBeVisible({ timeout: 20_000 })
  await chip.click()
  const pane = page.getByTestId('task-board-pane')
  await showCustomBoard(pane)
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
  await expect(msg.locator(`walnut-task[id="${OPEN_ID}"] .wn-title`)).toHaveText('Quarterly invoice reconciliation', { timeout: 20_000 })
  await expect(msg.locator(`walnut-task[id="${DONE_ID}"] .wn-title`)).toHaveText('Rotate the staging API keys')
  await expect(msg.locator('walnut-task[id="9c1d4e2a"] .wn-title')).toHaveText('Chat order fixture')
  await expect(msg.locator('walnut-task')).toHaveCount(3)
  await expect(msg).toContainText('hash 2ac8891 and')
  await expect(msg.locator('code')).toHaveText(`git log ${OPEN_ID}`)
  await msg.scrollIntoViewIfNeeded()
  await page.screenshot({ path: `${SHOTS}/${info.project.name}-board.png` })

  // A chip opens its task beside the board.
  await msg.locator(`walnut-task[id="9c1d4e2a"] .wn-task`).click()
  await expect(page.getByTestId('board-task-peek').or(page.locator(`[data-task-id="${UUID_ID}"]`)).first()).toBeVisible({ timeout: 15_000 })
  expect(pageErrors).toEqual([])
})
