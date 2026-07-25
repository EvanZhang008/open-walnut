import fs from 'node:fs/promises'
import path from 'node:path'
import { test, expect } from '@playwright/test'

const API = `http://localhost:${process.env.PW_TEST_PORT ?? 3457}`
const CRON_JOB_NAME = 'daily-report'
const CRON_FIRST_LINE = 'Daily report completed.'
const BLANK_THINKING_TEXT = 'Blank thinking fixture rendered its normal answer.'
const REAL_THINKING_TEXT = 'I checked the fictional report inputs before answering.'
const REAL_THINKING_ANSWER = 'Real thinking fixture rendered its normal answer.'

test.describe.serial('main chat collapse and thinking rendering', () => {
  test.beforeAll(async () => {
    const dirsResponse = await fetch(`${API}/api/sessions/working-dirs`)
    if (!dirsResponse.ok) {
      throw new Error(`Working directories request failed: ${dirsResponse.status} ${await dirsResponse.text()}`)
    }
    const dirsBody = await dirsResponse.json() as { dirs: Array<{ cwd: string }> }
    const walnutFixture = dirsBody.dirs.find((dir) => /\/ps-fixture\/projects\/walnut$/.test(dir.cwd))
    if (!walnutFixture) throw new Error('Playwright working-directory fixture is missing')
    const testDataRoot = walnutFixture.cwd.replace(/\/ps-fixture\/projects\/walnut$/, '')

    // Force the server's legacy history migration, then replace the active
    // conversation with an exact v2 ChatHistoryStore fixture.
    const conversationsResponse = await fetch(`${API}/api/agents/general/conversations`)
    if (!conversationsResponse.ok) {
      throw new Error(`Conversations request failed: ${conversationsResponse.status} ${await conversationsResponse.text()}`)
    }
    const conversationsBody = await conversationsResponse.json() as { activeConversationId: string }
    const conversationId = conversationsBody.activeConversationId
    const now = Date.now()
    const cronContent = [
      CRON_FIRST_LINE,
      ...Array.from({ length: 30 }, (_, index) => `Report line ${index + 1}: fictional sample status is ready.`),
    ].join('\n')

    const store = {
      version: 2,
      lastUpdated: new Date(now).toISOString(),
      compactionCount: 0,
      compactionSummary: null,
      entries: [
        {
          tag: 'ui',
          role: 'user',
          content: cronContent,
          timestamp: new Date(now - 3_000).toISOString(),
          source: 'cron',
          cronJobName: CRON_JOB_NAME,
        },
        {
          tag: 'ai',
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: '', signature: 'x' },
            { type: 'text', text: BLANK_THINKING_TEXT },
          ],
          timestamp: new Date(now - 2_000).toISOString(),
        },
        {
          tag: 'ai',
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: REAL_THINKING_TEXT, signature: 'y' },
            { type: 'text', text: REAL_THINKING_ANSWER },
          ],
          timestamp: new Date(now - 1_000).toISOString(),
        },
      ],
    }

    const historyFile = path.join(testDataRoot, 'conversations', 'general', `${conversationId}.json`)
    await fs.writeFile(historyFile, JSON.stringify(store, null, 2))
  })

  test('cron message auto-collapses and toggles from its header', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('.main-page')).toBeVisible()

    const cronMessage = page.locator('.chat-message-cron', { hasText: CRON_FIRST_LINE })
    await expect(cronMessage).toBeVisible()
    await expect(cronMessage.locator('.chat-message-content')).toBeHidden()
    await expect(cronMessage.locator('.chat-collapse-toggle')).toHaveText('▶')

    const header = cronMessage.locator('.chat-notification-header')
    await header.click()
    await expect(cronMessage.locator('.chat-message-content')).toBeVisible()
    await expect(cronMessage.locator('.chat-message-content')).toContainText('Report line 30')
    await expect(cronMessage.locator('.chat-collapse-toggle')).toHaveText('▼')

    await header.click()
    await expect(cronMessage.locator('.chat-message-content')).toBeHidden()
    await expect(cronMessage.locator('.chat-collapse-toggle')).toHaveText('▶')
  })

  test('blank thinking is omitted while real thinking expands', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('.main-page')).toBeVisible()

    const blankThinkingMessage = page.locator('.chat-message-assistant', { hasText: BLANK_THINKING_TEXT })
    await expect(blankThinkingMessage).toBeVisible()
    await expect(blankThinkingMessage).toContainText(BLANK_THINKING_TEXT)
    const blankThinkingRow = blankThinkingMessage.locator('.tool-run-row', {
      has: page.locator('.tool-run-label', { hasText: /^Thinking$/ }),
    })
    await expect(blankThinkingRow).toHaveCount(0)

    const realThinkingMessage = page.locator('.chat-message-assistant', { hasText: REAL_THINKING_ANSWER })
    await expect(realThinkingMessage).toBeVisible()
    const thinkingRow = realThinkingMessage.locator('.tool-run-row', {
      has: page.locator('.tool-run-label', { hasText: /^Thinking$/ }),
    })
    await expect(thinkingRow).toBeVisible()
    await expect(thinkingRow.locator('.chat-thinking-content')).toHaveCount(0)

    await thinkingRow.locator('.tool-run-toggle').click()
    await expect(thinkingRow.locator('.chat-thinking-content')).toBeVisible()
    await expect(thinkingRow.locator('.chat-thinking-content')).toHaveText(REAL_THINKING_TEXT)
  })
})
