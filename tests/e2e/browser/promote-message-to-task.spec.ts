/**
 * "Turn this into task" on a Main Chat message.
 *
 * What this proves, end to end through real UI clicks:
 *  1. The hover action exists on a Main Chat message and opens a menu with an
 *     editable title + a Project picker (and NO path/folder picker — a task has
 *     no working directory of its own).
 *  2. Create actually persists a task with the chosen project, and it shows up
 *     in the todo panel.
 *  3. Inbox (no project picked) is the default.
 *  4. The menu is placed by useMenuPlacement — it stays inside the viewport.
 *  5. The action is MAIN CHAT ONLY: session-column bubbles don't grow it.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { test, expect, type Page } from '@playwright/test'

const API = `http://localhost:${process.env.PW_TEST_PORT ?? 3457}`

const MULTILINE_MSG_TITLE = 'Re-key the promote fixture cache'
const MULTILINE_MSG = [
  MULTILINE_MSG_TITLE,
  '',
  'The old prefix leaks across conversations, so the second turn reads the first',
  "turn's entry and answers from it.",
].join('\n')
const SHORT_MSG = 'Promote fixture short answer'

/** Seed the active Main Chat conversation with an exact two-message history. */
async function seedConversation(): Promise<void> {
  const dirsResponse = await fetch(`${API}/api/sessions/working-dirs`)
  if (!dirsResponse.ok) {
    throw new Error(`Working directories request failed: ${dirsResponse.status}`)
  }
  const dirsBody = await dirsResponse.json() as { dirs: Array<{ cwd: string }> }
  const walnutFixture = dirsBody.dirs.find((dir) => /\/ps-fixture\/projects\/walnut$/.test(dir.cwd))
  if (!walnutFixture) throw new Error('Playwright working-directory fixture is missing')
  const testDataRoot = walnutFixture.cwd.replace(/\/ps-fixture\/projects\/walnut$/, '')

  const conversationsResponse = await fetch(`${API}/api/agents/general/conversations`)
  if (!conversationsResponse.ok) {
    throw new Error(`Conversations request failed: ${conversationsResponse.status}`)
  }
  const { activeConversationId } = await conversationsResponse.json() as { activeConversationId: string }
  const now = Date.now()

  const store = {
    version: 2,
    lastUpdated: new Date(now).toISOString(),
    compactionCount: 0,
    compactionSummary: null,
    entries: [
      {
        tag: 'ui',
        role: 'user',
        content: 'What is wrong with the promote fixture cache?',
        timestamp: new Date(now - 3_000).toISOString(),
      },
      {
        tag: 'ai',
        role: 'assistant',
        content: [{ type: 'text', text: MULTILINE_MSG }],
        timestamp: new Date(now - 2_000).toISOString(),
      },
      {
        tag: 'ai',
        role: 'assistant',
        content: [{ type: 'text', text: SHORT_MSG }],
        timestamp: new Date(now - 1_000).toISOString(),
      },
    ],
  }

  const historyFile = path.join(testDataRoot, 'conversations', 'general', `${activeConversationId}.json`)
  await fs.writeFile(historyFile, JSON.stringify(store, null, 2))
}

/** Hover the message bubble, then open its "Task" menu. Returns the menu locator. */
async function openPromoteMenu(page: Page, messageText: string) {
  const message = page.locator('.chat-message-assistant', { hasText: messageText }).first()
  await expect(message).toBeVisible()
  await message.hover()
  const trigger = message.locator('.promote-task-trigger')
  await expect(trigger).toBeVisible()
  await trigger.click()
  const menu = page.locator('.promote-task-menu')
  await expect(menu).toBeVisible()
  return menu
}

/** Fetch the task list straight from the API — the source of truth for "it persisted". */
async function fetchTasks(): Promise<Array<{ id: string; title: string; project?: string; description?: string }>> {
  const res = await fetch(`${API}/api/tasks`)
  if (!res.ok) throw new Error(`Task list request failed: ${res.status}`)
  const body = await res.json() as { tasks: Array<{ id: string; title: string; project?: string; description?: string }> }
  return body.tasks
}

async function deleteTask(id: string): Promise<void> {
  await fetch(`${API}/api/tasks/${id}?force=1`, { method: 'DELETE' })
}

test.describe.serial('promote a Main Chat message into a task', () => {
  const createdIds: string[] = []

  test.beforeAll(async () => {
    await seedConversation()
  })

  test.afterAll(async () => {
    for (const id of createdIds) await deleteTask(id)
  })

  test('menu prefills the title, offers Project, and offers NO path picker', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('.main-page')).toBeVisible()

    const menu = await openPromoteMenu(page, MULTILINE_MSG_TITLE)

    // Title prefilled from the first line — not the whole paragraph.
    const titleInput = menu.locator('.promote-task-title')
    await expect(titleInput).toHaveValue(MULTILINE_MSG_TITLE)

    // Project is selectable and defaults to Inbox.
    await expect(menu.locator('.task-kebab-project-current-name')).toHaveText('Inbox')

    // A task has no working directory of its own — the menu must not offer one.
    await expect(menu.locator('.session-path-selector')).toHaveCount(0)
    await expect(menu.getByText(/folder|directory|cwd/i)).toHaveCount(0)

    // Placed by useMenuPlacement: fully inside the viewport.
    const box = await menu.boundingBox()
    const viewport = page.viewportSize()
    expect(box).not.toBeNull()
    expect(viewport).not.toBeNull()
    expect(box!.y).toBeGreaterThanOrEqual(0)
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height + 1)
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width + 1)

    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
  })

  test('creates the task in the picked project, with the message as its body', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('.main-page')).toBeVisible()

    const menu = await openPromoteMenu(page, MULTILINE_MSG_TITLE)

    // Pick a real project from the shared flyout (its own portal, not inlined).
    await menu.locator('.task-kebab-project-current').click()
    const flyout = page.locator('.task-kebab-project-flyout')
    await expect(flyout).toBeVisible()
    await flyout.locator('.task-kebab-project-opt', { hasText: 'Ideas' }).first().click()
    await expect(menu.locator('.task-kebab-project-current-name')).toHaveText('Ideas')

    // Edit the title — the menu is a form, not a blind action.
    const editedTitle = `${MULTILINE_MSG_TITLE} (edited)`
    await menu.locator('.promote-task-title').fill(editedTitle)
    await menu.locator('.promote-task-create').click()
    await expect(menu).toHaveCount(0)

    // Persisted with the picked project and the full message as the description.
    await expect.poll(async () => {
      const tasks = await fetchTasks()
      return tasks.find((t) => t.title === editedTitle)?.project ?? null
    }, { timeout: 10_000 }).toBe('Ideas')

    const created = (await fetchTasks()).find((t) => t.title === editedTitle)!
    createdIds.push(created.id)
    expect(created.description).toContain('The old prefix leaks across conversations')

    // And it is visible in the todo panel, not just in the database.
    await expect(page.locator('.todo-panel').getByText(editedTitle).first()).toBeVisible({ timeout: 10_000 })
  })

  test('no project picked lands the task in the Inbox', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('.main-page')).toBeVisible()

    const menu = await openPromoteMenu(page, SHORT_MSG)
    await expect(menu.locator('.promote-task-title')).toHaveValue(SHORT_MSG)
    await menu.locator('.promote-task-create').click()
    await expect(menu).toHaveCount(0)

    await expect.poll(async () => {
      const tasks = await fetchTasks()
      const hit = tasks.find((t) => t.title === SHORT_MSG)
      return hit ? (hit.project ?? '') : null
    }, { timeout: 10_000 }).toBe('')

    const created = (await fetchTasks()).find((t) => t.title === SHORT_MSG)!
    createdIds.push(created.id)
    // A one-liner whose title IS the whole message stores no duplicate body.
    expect(created.description ?? '').toBe('')
  })

  test('session-column bubbles do NOT grow the action (Main Chat only)', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('.main-page')).toBeVisible()

    // Main Chat has it…
    const chatMessage = page.locator('.chat-message-assistant', { hasText: SHORT_MSG }).first()
    await chatMessage.hover()
    await expect(chatMessage.locator('.promote-task-trigger')).toBeVisible()

    // …and the session timeline does not, even where its copy actions live.
    await expect(page.locator('.session-msg .promote-task-trigger')).toHaveCount(0)
    await expect(page.locator('.session-msg-bare .promote-task-trigger')).toHaveCount(0)
  })
})
