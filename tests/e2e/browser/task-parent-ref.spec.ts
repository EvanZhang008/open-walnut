/**
 * A subtask whose id starts with its parent's whole id, the parent completed: the
 * search list holds the subtask alone, and it is a top-level row there, never its
 * own parent (src/lib/id-ref.ts matchParentRef). On 2026-11-04 any search with such
 * a pair went blank with "Maximum call stack size exceeded": the parent lookup fell
 * back to a prefix match, found the subtask itself, and the depth walk recursed.
 * The three tasks are the browser's whole task list (answerTaskList) and its search
 * answers, so no other spec, and no other run's server, ever sees them.
 */
import { test, expect } from '@playwright/test'
import { answerTaskList } from './task-list-stub'

const now = new Date().toISOString()
const base = {
  priority: 'none', project: 'Walnut', source: 'local', session_ids: [], active_session_ids: [],
  created_at: now, updated_at: now, description: '', summary: '', note: '', subtasks: [],
}
// The parent's title shares no word with the searches below, so it is out of every search list.
const PARENT = { ...base, id: 'pw-idpair-tour', title: 'Welcome flow umbrella', status: 'done', phase: 'COMPLETE', completed_at: now }
const CHILD = { ...base, id: 'pw-idpair-tour-phone', title: 'Idpair onboarding tour on the phone', status: 'todo', phase: 'TODO', parent_task_id: PARENT.id }
const GRANDCHILD = { ...base, id: 'pw-idpair-tour-phone-2', title: 'Idpair tour copy', status: 'todo', phase: 'TODO', parent_task_id: CHILD.id }

test('a search with the parent completed keeps the page, and the subtask is a top-level row', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  // The board holds these three alone (and no other worker's task frames).
  await answerTaskList(page, () => [PARENT, CHILD, GRANDCHILD])
  // The server lane finds the open two; the completed parent is no search hit.
  await page.route(/\/api\/search(\?|$)/, async (route) => {
    const rows = [CHILD, GRANDCHILD].map((t) => ({ type: 'task', taskId: t.id, title: t.title, matchField: 'title', snippet: t.title }))
    await route.fulfill({ json: { results: rows } })
  })
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  const search = page.locator('.todo-search-input')
  const child = page.locator(`.todo-panel-item[data-task-id="${CHILD.id}"]`)
  for (const query of ['Idpair', 'onboarding tour', 'Idpair tour copy']) {
    await search.fill(query)
    // Past the server lane's debounce, so both lanes have drawn the list.
    await page.waitForResponse((r) => r.url().includes('/api/search'), { timeout: 15_000 })
    await expect(page.getByText('Something went wrong rendering the page')).toHaveCount(0)
    if (query !== 'Idpair tour copy') {
      await expect(child, `"${query}": the subtask's row`).toBeVisible({ timeout: 15_000 })
      // Its completed parent is out of the list, so nothing nests it: a row of its own
      // (a nested row is pushed right by a positive margin, TodoPanel's depth indent).
      expect(parseFloat(await child.evaluate((el) => getComputedStyle(el).marginLeft))).toBeLessThanOrEqual(0)
    }
    await expect(page.locator(`.todo-panel-item[data-task-id="${PARENT.id}"]`)).toHaveCount(0)
  }
  await search.fill('')
  expect(errors, 'the page threw').toEqual([])
})
