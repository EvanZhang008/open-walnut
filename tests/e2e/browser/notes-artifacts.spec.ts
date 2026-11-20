/**
 * The Notes page's "Walnut artifacts" section (web/src/components/notes/NotesArtifactsGroup.tsx,
 * experiment notes_artifacts): Walnut's artifacts folder listed under the notes tree. Off, the tree
 * is as before; on, one collapsed row; opened, the org's skills and one group per node with its
 * MEMORY.md, skills and notes; a click opens the file in the app's viewer.
 *
 * Seeded through the real routes an agent uses (agent-memory, agent-skills, memory-files). Real
 * clicks only.
 */
import { test, expect, type APIRequestContext } from '@playwright/test'

test.setTimeout(90_000)

const STAMP = Date.now().toString(36)
const TITLE = `Lagoon lead ${STAMP}`
const SKILL = `lagoon-steps-${STAMP}`
let taskId = ''

async function ok(res: Awaited<ReturnType<APIRequestContext['get']>>, what: string) {
  expect(res.ok(), `${what}: ${res.status()} ${await res.text().catch(() => '')}`).toBe(true)
  return res.json()
}
const setFlag = (request: APIRequestContext, on: boolean) => request.put('/api/config', { data: { experimental: { notes_artifacts: on } } })

test.beforeAll(async ({ request }) => {
  taskId = (await ok(await request.post('/api/tasks', { data: { title: TITLE, project: 'Lagoon', source: 'local' } }), 'task')).task.id
  await ok(await request.put(`/api/v1/tasks/${taskId}/agent-memory`, { data: { content: `# Lagoon\n- the pier opens ${STAMP}`, mode: 'replace' } }), 'memory')
  await ok(await request.put(`/api/v1/tasks/${taskId}/agent-skills/${SKILL}`, { data: { description: 'How the lagoon review goes', content: '1. Walk the pier.', scope: 'own' } }), 'skill')
  await ok(await request.put(`/api/v1/tasks/${taskId}/memory-files/tide-notes.md`, { data: { content: 'High tide at noon.' } }), 'note')
})

test.afterAll(async ({ request }) => {
  await setFlag(request, false).catch(() => {})
  if (taskId) await request.delete(`/api/tasks/${taskId}?force=true`).catch(() => {})
})

test('the section lists a node\'s artifacts and opens a file, only with the experiment on', async ({ page, request }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await setFlag(request, false)
  await page.setViewportSize({ width: 1280, height: 860 })
  await page.goto('/')
  await page.locator('a[href="/notes"]').first().click()
  await expect(page.locator('.notes-tree-body')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('notes-artifacts-group')).toHaveCount(0)

  await ok(await setFlag(request, true), 'flag on')
  const section = page.getByTestId('notes-artifacts-group')
  await expect(section).toBeVisible({ timeout: 15_000 })
  // Collapsed: one row, nothing listed.
  await expect(section.locator('.notes-artifacts-list')).toHaveCount(0)
  await section.getByText('Walnut artifacts').click()

  const group = section.getByTestId(`notes-artifacts-node:${taskId}`)
  await expect(group).toBeVisible({ timeout: 15_000 })
  await expect(group.locator('.notes-artifacts-sub-header')).toContainText(TITLE)
  await group.locator('.notes-artifacts-sub-header').click()
  await expect(group.locator('.notes-artifacts-row')).toHaveText(['MEMORY.md', SKILL, 'tide-notes'])

  await group.locator('.notes-artifacts-row', { hasText: 'MEMORY.md' }).click()
  await expect(page.getByText(`the pier opens ${STAMP}`).first()).toBeVisible({ timeout: 15_000 })
  expect(errors).toEqual([])
})
