import fs from 'node:fs/promises'
import { test, expect, type Page } from '@playwright/test'
import { showEverything } from './todo-panel-helpers'

const SESSION_ID = 'pw-question-recovery-session'
const REQUEST_ID = 'req-question-recovery'
const SCREENSHOT_DIR = '/tmp/ask-user-question-recovery'

async function injectEvent(page: Page, name: string, data: unknown): Promise<void> {
  await page.evaluate(({ eventName, eventData }) => {
    const ws = (window as unknown as { __capturedQuestionWs?: WebSocket }).__capturedQuestionWs
    if (!ws) throw new Error('Question test WebSocket was not captured')
    ws.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify({ type: 'event', name: eventName, data: eventData, seq: Date.now() }),
    }))
  }, { eventName: name, eventData: data })
}

async function openSessionFromTaskDetail(page: Page): Promise<void> {
  const task = page.locator('.todo-panel-item', { hasText: 'Question recovery fixture' })
  await expect(task).toBeVisible({ timeout: 15_000 })
  await task.getByRole('button', { name: 'More actions' }).click()
  await page.locator('.task-kebab-menu').getByText('Details', { exact: true }).click()

  const detail = page.locator('.task-detail-modal')
  await expect(detail).toBeVisible()
  await detail.locator(`.todo-detail-session-item[title="${SESSION_ID}"]`).click()
  await detail.getByRole('button', { name: 'Close detail panel' }).click()
}

test('AskUserQuestion survives server attach gaps and reopening the session column', async ({ page }) => {
  test.setTimeout(60_000)
  let suppressDurablePermission = false
  let submittedBody: Record<string, unknown> | undefined

  await page.addInitScript(() => {
    const original = window.WebSocket
    window.WebSocket = class QuestionTestWebSocket extends original {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        const socketUrl = new URL(String(url), window.location.href)
        if (socketUrl.pathname !== '/ws' || (window as unknown as { __capturedQuestionWs?: WebSocket }).__capturedQuestionWs) {
          return
        }
        ;(window as unknown as { __capturedQuestionWs?: WebSocket }).__capturedQuestionWs = this
        const sendOriginal = this.send.bind(this)
        this.send = (data: string | ArrayBufferLike | Blob | ArrayBufferView) => {
          try {
            const frame = JSON.parse(String(data)) as { type?: string; method?: string; id?: string }
            const hold = (window as unknown as { __holdQuestionSnapshots?: boolean }).__holdQuestionSnapshots
            if (hold && frame.type === 'req' && frame.method === 'session:stream-subscribe') {
              setTimeout(() => {
                this.dispatchEvent(new MessageEvent('message', {
                  data: JSON.stringify({ type: 'res', id: frame.id, ok: true, payload: null }),
                }))
              }, 10)
              return
            }
          } catch {
            // Forward non-JSON WebSocket frames unchanged.
          }
          sendOriginal(data)
        }
      }
    } as typeof WebSocket
    for (const key of Object.getOwnPropertyNames(original)) {
      if (key === 'prototype' || key === 'length' || key === 'name') continue
      try {
        ;(window.WebSocket as unknown as Record<string, unknown>)[key] =
          (original as unknown as Record<string, unknown>)[key]
      } catch {
        // Read-only browser constants already exist on the subclass.
      }
    }
  })

  await page.route(`**/api/sessions/${SESSION_ID}`, async (route) => {
    if (!suppressDurablePermission) {
      await route.fallback()
      return
    }
    await route.fulfill({
      json: {
        session: {
          claudeSessionId: SESSION_ID,
          taskId: 'pw-task-question-recovery',
          project: 'Walnut',
          process_status: 'running',
          mode: 'bypass',
          startedAt: '2026-08-17T00:50:00.000Z',
          lastActiveAt: '2026-08-17T00:56:52.000Z',
          messageCount: 1,
          title: 'Pending question recovery',
        },
        pendingPermissions: [],
      },
    })
  })
  await page.route(`**/api/sessions/${SESSION_ID}/history**`, async (route) => {
    await route.fulfill({ json: { messages: [], cursor: 0, delta: false } })
  })
  await page.route(`**/api/sessions/${SESSION_ID}/permission`, async (route) => {
    submittedBody = route.request().postDataJSON() as Record<string, unknown>
    await route.fulfill({
      json: { status: 'resolved', requestId: REQUEST_ID, allow: true },
    })
  })

  await page.goto('/')
  await page.waitForLoadState('networkidle')
  await showEverything(page)

  await openSessionFromTaskDetail(page)

  let panel = page.locator(`.main-page-session-column .session-panel[data-session-id="${SESSION_ID}"]`)
  await expect(panel).toBeVisible({ timeout: 15_000 })
  let questionCard = panel.locator('.ask-user-question-card')
  await expect(questionCard).toContainText('Which deployment?')
  await expect(questionCard.getByRole('button', { name: /Staging/ })).toBeVisible()

  const permissionEvent = {
    sessionId: SESSION_ID,
    requestId: REQUEST_ID,
    toolName: 'AskUserQuestion',
    input: {
      questions: [{
        header: 'Target',
        question: 'Which deployment?',
        options: [
          { label: 'Staging', description: 'Deploy to staging' },
          { label: 'Production', description: 'Deploy to production' },
        ],
        multiSelect: false,
      }],
    },
    reason: 'Need a deployment target',
  }
  await injectEvent(page, 'session:permission-request', permissionEvent)

  suppressDurablePermission = true
  await page.evaluate(() => {
    ;(window as unknown as { __holdQuestionSnapshots?: boolean }).__holdQuestionSnapshots = true
  })
  await panel.getByRole('button', { name: 'Close session panel' }).click()
  await expect(panel).toHaveCount(0)

  await openSessionFromTaskDetail(page)
  panel = page.locator(`.main-page-session-column .session-panel[data-session-id="${SESSION_ID}"]`)
  await expect(panel).toBeVisible({ timeout: 15_000 })
  questionCard = panel.locator('.ask-user-question-card')
  await expect(questionCard).toContainText('Which deployment?')
  await expect(questionCard.getByRole('button', { name: /Production/ })).toBeVisible()

  await fs.mkdir(SCREENSHOT_DIR, { recursive: true })
  await page.screenshot({
    path: `${SCREENSHOT_DIR}/restored-question-card.png`,
    fullPage: true,
  })

  await questionCard.getByRole('button', { name: /Staging/ }).click()
  await questionCard.getByRole('button', { name: 'Submit' }).click()
  await expect(panel.locator('.permission-request-resolved--allowed')).toContainText('Which deployment?')
  expect(submittedBody).toMatchObject({
    requestId: REQUEST_ID,
    allow: true,
    answers: { 'Which deployment?': 'Staging' },
  })
})
