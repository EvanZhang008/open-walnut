import fs from 'node:fs'
import { expect, test } from '@playwright/test'
import { discoverBrowserFixture } from './codex-test-audit'
import { loadHome } from './draft-helpers'
import { isolateUiPrefs } from './todo-panel-helpers'

test('needs cards use the quiet check clock and the linked task deadline, not the reply clock', async ({ page, request }) => {
  test.setTimeout(120_000)
  const project = `Reminder clock ${Date.now()}`
  const contact = await request.post('/api/v1/org/projects', { data: { name: project } })
  expect(contact.ok(), await contact.text()).toBe(true)
  const node = (await contact.json()).task.id as string
  const taskRes = await request.post('/api/tasks', { data: { title: 'Release date decision', project, source: 'local', due_date: new Date(Date.now() + 6 * 3600_000).toISOString() } })
  expect(taskRes.ok(), await taskRes.text()).toBe(true)
  const work = (await taskRes.json()).task.id as string
  const { walnutHome } = await discoverBrowserFixture(Number(process.env.PW_TEST_PORT ?? 3457))
  const now = Date.now()
  const ago = (hours: number) => new Date(now - hours * 3600_000).toISOString()
  const t = (id: string, title: string, hours: number, more: Record<string, unknown> = {}) => ({
    id, title, titled: true, state: 'needs', reply: `${title}: waiting for your choice.`, replyAt: ago(hours),
    createdAt: ago(hours), updatedAt: ago(hours), by: 'task:node',
    opener: { text: 'Choose the release date.', at: ago(hours), from: 'node', by: 'task:node' }, messages: [], ...more,
  })
  const dir = `${walnutHome}/org/threads`
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(`${dir}/${node}.json`, JSON.stringify({ version: 1, taskId: node, threads: [
    t('th-00000000d001', 'Four hours is not overdue', 8),
    t('th-00000000d002', 'Quiet for more than a day', 26),
    t('th-00000000d003', 'Checked recently', 26, { recheck: { since: ago(27), at: ago(3), why: 'needs' } }),
    t('th-00000000d004', 'Linked deadline approaching', 20, { tasks: [work] }),
    t('th-00000000d005', 'Updated inside deadline window', 3, { tasks: [work] }),
  ] }))
  try {
    await page.setViewportSize({ width: 1200, height: 800 })
    await isolateUiPrefs(page)
    await loadHome(page)
    await page.getByTestId('sidebar-org').click()
    await page.locator(`[data-testid="org-channel"][data-key="project:${project.toLowerCase()}"]`).click()
    await page.getByTestId('org-top-threads').click()
    const card = (id: string) => page.locator(`[data-testid="org-thread"][data-thread-id="${id}"]`)
    for (const id of ['th-00000000d001', 'th-00000000d002', 'th-00000000d003', 'th-00000000d004', 'th-00000000d005']) await expect(card(id)).toBeVisible()
    await expect(card('th-00000000d001').getByTestId('org-thread-overdue')).toHaveCount(0)
    await expect(card('th-00000000d002').getByTestId('org-thread-overdue')).toContainText('Nothing new from')
    await expect(card('th-00000000d003').getByTestId('org-thread-overdue')).toHaveCount(0)
    await expect(card('th-00000000d004').getByTestId('org-thread-overdue')).toContainText('A linked task is due')
    await expect(card('th-00000000d005').getByTestId('org-thread-overdue')).toHaveCount(0)
    // Normal reading still works after the clock change: open and fold the conversation.
    await card('th-00000000d001').getByTestId('org-thread-history').click()
    await expect(card('th-00000000d001').getByTestId('org-thread-opener')).toBeVisible()
    await card('th-00000000d001').getByTestId('org-thread-history').click()
    await expect(card('th-00000000d001').getByTestId('org-thread-opener')).toHaveCount(0)
    const shots = `${process.env.WALNUT_TASK_DIR ?? 'test-results'}/shots`
    fs.mkdirSync(shots, { recursive: true })
    await page.getByTestId('org-rail').screenshot({ path: `${shots}/org-needs-reminder-${test.info().project.name}.png` })
  } finally {
    fs.rmSync(`${dir}/${node}.json`, { force: true })
    for (const id of [node, work]) await request.delete(`/api/tasks/${id}?force=true`)
  }
})
