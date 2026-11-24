/**
 * A task's result on the subject he asked his lead about is listed on the lead (2026-11-24, the
 * threads inspection, item 4; src/core/org/thread-subject-pairs.ts): only Needs you popped up, so a
 * result on a task below never reached the lead's Threads where he had asked.
 *
 *  1. The lead's Threads show the task's result card for him (from the task, its result, an
 *     Acknowledge button); the lead's own card waits with the in-progress ones and says the task has
 *     the result.
 *  2. He clicks Acknowledge on it: nothing is left for him, and nothing comes back.
 * The fixture is shared: this file makes its own project and tasks, and puts the flags back.
 */
import { expect, test } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { loadHome } from './draft-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'
import { restoreOneCard, setOneCard } from './one-card-helpers'
import { card, openLead, popUpFlag, removeTask, send, shot, startSession } from './lead-threads-helpers'

const TEST_PORT = Number(process.env.PW_TEST_PORT ?? 3457)
const STAMP = `${Date.now().toString(36)}${process.pid.toString(36)}`
const PROJECT = `Result ${STAMP}`
const made: string[] = []
let oneCardWas: boolean | null = null
const ids = { lead: '', leadSid: '', owner: '', ownerSid: '', his: '', result: '' }

test.describe.configure({ mode: 'serial' })
test.setTimeout(180_000)
test.use({ video: 'on', viewport: { width: 1280, height: 800 } })

test.beforeAll(async ({ request }) => {
  test.setTimeout(170_000)
  oneCardWas = await setOneCard(request, true)
  await popUpFlag(request, true)
  // A project with two or more teams gets a lead (org_contact).
  for (const title of [`Side work ${STAMP}`, `More work ${STAMP}`]) {
    made.push((await send<{ task: { id: string } }>(request, 'post', '/api/tasks', { title, project: PROJECT, source: 'local' })).task.id)
  }
  ids.lead = (await send<{ task: { id: string } }>(request, 'post', '/api/v1/org/contact', { to: PROJECT })).task.id
  made.push(ids.lead)
  ids.owner = (await send<{ task: { id: string } }>(request, 'post', '/api/tasks', { title: `Panel flash fix ${STAMP}`, project: PROJECT, source: 'local', parent_task_id: ids.lead })).task.id
  made.push(ids.owner)
  const on = await request.patch(`/api/tasks/${ids.owner}`, { data: { threads_on: true } })
  expect(on.ok(), await on.text()).toBe(true)
  const { fixtureRoot } = await discoverBrowserFixture(TEST_PORT)
  ids.leadSid = await startSession(request, ids.lead, fixtureRoot)
  ids.ownerSid = await startSession(request, ids.owner, fixtureRoot)
  // His request to the lead, handed to the task, set aside while the task works.
  const reply = 'The flash comes from the list sorting again while it opens.'
  ids.his = (await send<{ thread: { id: string } }>(request, 'post', `/api/v1/tasks/${ids.lead}/threads/open`, {
    title: `Threads panel flashes when opened on the lead page ${STAMP}`, text: reply, reply, state: 'answered', from: 'node', tasks: [ids.owner],
  }, ids.leadSid)).thread.id
  await send(request, 'patch', `/api/v1/tasks/${ids.lead}/threads/${ids.his}`, { state: 'pending' }, ids.leadSid)
  // The task's own card: its result, on that subject.
  ids.result = (await send<{ thread: { id: string } }>(request, 'post', `/api/v1/tasks/${ids.owner}/threads/open`, {
    title: `Threads panel flash when opened: fixed and live ${STAMP}`, text: 'Working on the flash.', state: 'answered', from: 'node',
    reply: 'The panel keeps its place while it opens; it is live. Video: /tmp/panel/flash.mp4',
    separate_reason: 'The task reports its own result on the fix it made',
  }, ids.ownerSid)).thread.id
})

test.afterAll(async ({ request }) => {
  await restoreOneCard(request, oneCardWas)
  await popUpFlag(request, false)
  for (const id of made) await removeTask(request, id)
})

test('the task\'s result is on the lead\'s Threads where he asked, and his Acknowledge there clears it', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(err.message))
  await isolateUiPrefs(page)
  await loadHome(page)
  await openLead(page, PROJECT)
  const rail = page.getByTestId('org-rail')
  const forHim = rail.locator('[data-testid="org-thread"][data-group="needs"], [data-testid="org-thread"][data-group="read"]')

  // 1. The task's result card is the one card for him: from the task, with its result and Acknowledge.
  const result = card(page, ids.result)
  await expect(result).toBeVisible({ timeout: 20_000 })
  await expect(result).toHaveAttribute('data-owner', ids.owner)
  await expect(result).toHaveAttribute('data-group', 'read')
  await expect(result.getByTestId('org-thread-owner')).toContainText(`Panel flash fix ${STAMP}`)
  await expect(result).toContainText('The panel keeps its place while it opens')
  await expect(forHim).toHaveCount(1)
  // The lead's own card waits with the in-progress ones and says the task has the result.
  await rail.getByTestId('org-threads-hidden').click()
  const own = card(page, ids.his)
  await expect(own).toBeVisible()
  await expect(own).toHaveAttribute('data-asked-in', ids.owner)
  await expect(own.getByTestId('org-thread-asked-in')).toContainText('has the result on this: read it on its card')
  await page.waitForTimeout(1_500)
  await shot(page, 'thread-result-below', '1-result-on-lead')

  // 2. He acknowledges it there: nothing is left for him, and nothing comes back.
  await result.getByTestId('org-thread-ack').click()
  await expect(forHim).toHaveCount(0, { timeout: 20_000 })
  await page.waitForTimeout(3_000)
  await expect(forHim).toHaveCount(0)
  const stored = (await (await page.request.get(`/api/v1/tasks/${ids.owner}/threads/${ids.result}`)).json()).thread as { closed?: { by?: string }; known?: { by?: string } }
  expect((stored.closed ?? stored.known)?.by).toBe('human')
  await shot(page, 'thread-result-below', '2-acknowledged')
  await page.waitForTimeout(1_500)
  expect(pageErrors).toEqual([])
})
