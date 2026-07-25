import { expect, test, type Page } from '@playwright/test'

const SESSION_ID = 'pw-ghost-run-session'
const LONG_SYSTEM_TEXT = `commands_changed ${JSON.stringify({
  commands: Array.from({ length: 8 }, (_, index) => ({
    name: `fixture-command-${index}`,
    description: `Fixture command ${index} with enough descriptive content to exercise the collapsed system row.`,
  })),
})}`

async function injectEvent(page: Page, name: string, data: unknown): Promise<void> {
  await page.evaluate(
    ({ name, data }) => {
      const ws = (window as Window & { __capturedWs?: WebSocket }).__capturedWs
      if (!ws) throw new Error('No captured WebSocket')
      ws.dispatchEvent(new MessageEvent('message', {
        data: JSON.stringify({ type: 'event', name, data, seq: Date.now() }),
      }))
    },
    { name, data },
  )
}

async function waitForWs(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const ws = (window as Window & { __capturedWs?: WebSocket }).__capturedWs
    return ws?.readyState === WebSocket.OPEN
  }, null, { timeout: 10_000 })
}

async function mockSession(page: Page, messages: Record<string, unknown>[] = [
  {
    role: 'system',
    text: LONG_SYSTEM_TEXT,
    systemVariant: 'info',
    timestamp: '2026-01-01T00:00:00.000Z',
  },
]): Promise<void> {
  await page.route(`**/api/sessions/${SESSION_ID}/history**`, async (route) => {
    await route.fulfill({
      json: {
        messages,
        cursor: messages.length,
        delta: false,
      },
    })
  })

  await page.route(`**/api/sessions/${SESSION_ID}`, async (route, request) => {
    if (request.url().includes('/history')) return route.fallback()
    await route.fulfill({
      json: {
        session: {
          claudeSessionId: SESSION_ID,
          taskId: 'pw-task-ghost-run',
          project: 'Walnut',
          process_status: 'running',
          mode: 'bypass',
          startedAt: '2026-01-01T00:00:00.000Z',
          lastActiveAt: new Date().toISOString(),
          messageCount: 1,
          title: 'Ghost tool run fixture',
        },
      },
    })
  })
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const OriginalWebSocket = window.WebSocket
    window.WebSocket = class PatchedWebSocket extends OriginalWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        const socketUrl = new URL(String(url), window.location.href)
        if (socketUrl.pathname !== '/ws' || (window as Window & { __capturedWs?: WebSocket }).__capturedWs) return

        ;(window as Window & { __capturedWs?: WebSocket }).__capturedWs = this
        const originalSend = this.send.bind(this)
        this.send = (data: string | ArrayBufferLike | Blob | ArrayBufferView) => {
          let intercepted = false
          try {
            const request = JSON.parse(data as string) as { type?: string; id?: string; method?: string }
            if (request.type === 'req' && request.method === 'session:stream-subscribe') {
              intercepted = true
              setTimeout(() => {
                this.dispatchEvent(new MessageEvent('message', {
                  data: JSON.stringify({ type: 'res', id: request.id, ok: true, payload: { blocks: [], isStreaming: false } }),
                }))
              }, 10)
            }
          } catch { /* non-JSON WebSocket data */ }
          if (!intercepted) originalSend(data)
        }
      }
    } as typeof WebSocket

    for (const key of Object.getOwnPropertyNames(OriginalWebSocket)) {
      if (key === 'prototype' || key === 'length' || key === 'name') continue
      try {
        ;(window.WebSocket as unknown as Record<string, unknown>)[key] = (OriginalWebSocket as unknown as Record<string, unknown>)[key]
      } catch { /* read-only static */ }
    }
  })
})

test.describe('Session timeline collapsed rows', () => {
  test('merges completed tool calls through a render-null ghost block', async ({ page }) => {
    await mockSession(page)
    await page.goto(`/sessions?id=${SESSION_ID}`)
    await page.waitForLoadState('networkidle')
    await waitForWs(page)

    await injectEvent(page, 'session:tool-use', {
      sessionId: SESSION_ID,
      taskId: 'pw-task-ghost-run',
      toolName: 'Bash',
      toolUseId: 'toolu_done_1',
      input: { command: 'printf first' },
    })
    await injectEvent(page, 'session:tool-result', {
      sessionId: SESSION_ID,
      taskId: 'pw-task-ghost-run',
      toolUseId: 'toolu_done_1',
      result: 'first',
    })
    await injectEvent(page, 'session:tool-use', {
      sessionId: SESSION_ID,
      taskId: 'pw-task-ghost-run',
      toolName: 'Bash',
      toolUseId: 'toolu_ghost',
      input: {},
    })
    await injectEvent(page, 'session:tool-use', {
      sessionId: SESSION_ID,
      taskId: 'pw-task-ghost-run',
      toolName: 'Bash',
      toolUseId: 'toolu_done_2',
      input: { command: 'printf second' },
    })
    await injectEvent(page, 'session:tool-result', {
      sessionId: SESSION_ID,
      taskId: 'pw-task-ghost-run',
      toolUseId: 'toolu_done_2',
      result: 'second',
    })

    const toolRows = page.locator('.session-streaming-panel .tool-run-row')
    await expect(toolRows).toHaveCount(1)
    await expect(toolRows.locator('.tool-run-label')).toHaveText(/Ran 2 commands/i)
    await expect(page.locator('.session-streaming-panel .chat-tool-block')).toHaveCount(0)
  })

  test('collapses a verbose persisted system line and reveals its full text', async ({ page }) => {
    await mockSession(page)
    await page.goto(`/sessions?id=${SESSION_ID}`)
    await page.waitForLoadState('networkidle')

    const systemRow = page.locator('.session-history .tool-run-row').filter({ hasText: 'commands_changed' })
    await expect(systemRow).toHaveCount(1)
    await expect(systemRow.locator('.tool-run-label')).toContainText('…')
    await expect(systemRow.locator('.session-system-detail-pre')).toHaveCount(0)

    await systemRow.locator('.tool-run-toggle').click()
    await expect(systemRow.locator('.session-system-detail-pre')).toHaveText(LONG_SYSTEM_TEXT)
  })

  test('groups consecutive system history and aligns timeline rows', async ({ page }) => {
    await mockSession(page, [
      {
        role: 'assistant',
        text: 'Timeline prose baseline',
        timestamp: '2026-01-01T00:00:00.000Z',
        tools: [{
          name: 'Bash',
          input: { command: 'printf baseline' },
          result: 'baseline',
          toolUseId: 'toolu_history_baseline',
        }],
      },
      ...Array.from({ length: 3 }, (_, index) => ({
        role: 'system',
        text: `history_notice_${index + 1}`,
        systemVariant: 'info',
        timestamp: `2026-01-01T00:00:0${index + 1}.000Z`,
      })),
    ])
    await page.goto(`/sessions?id=${SESSION_ID}`)
    await page.waitForLoadState('networkidle')

    const history = page.locator('.session-history')
    const systemGroup = history.locator('.tool-run-row').filter({ hasText: /^3 system messages/ })
    await expect(systemGroup).toHaveCount(1)
    await expect(history.locator('.session-system-line')).toHaveCount(0)

    const baseline = await page.evaluate(() => {
      const history = document.querySelector('.session-history')
      if (!history) throw new Error('Missing session history')
      const systemToggle = Array.from(history.querySelectorAll<HTMLElement>('.tool-run-toggle'))
        .find((element) => element.textContent?.includes('3 system messages'))
      const toolToggle = Array.from(history.querySelectorAll<HTMLElement>('.tool-run-toggle'))
        .find((element) => element.textContent?.match(/Ran a command/i))
      const prose = Array.from(history.querySelectorAll<HTMLElement>('.markdown-body p'))
        .find((element) => element.textContent?.includes('Timeline prose baseline'))
      if (!systemToggle || !toolToggle || !prose) throw new Error('Missing alignment probes')
      return {
        tool: toolToggle.getBoundingClientRect().left,
        prose: prose.getBoundingClientRect().left,
        system: systemToggle.getBoundingClientRect().left,
      }
    })
    console.log(`ALIGNMENT_PROBE tool=${baseline.tool} prose=${baseline.prose} system=${baseline.system}`)
    expect(Math.abs(baseline.tool - baseline.prose)).toBeLessThanOrEqual(1)
    expect(Math.abs(baseline.system - baseline.prose)).toBeLessThanOrEqual(1)

    await systemGroup.locator('.tool-run-toggle').click()
    await expect(systemGroup.locator('.session-system-line')).toHaveCount(3)
    await expect(systemGroup.locator('.session-system-text')).toHaveText([
      'history_notice_1',
      'history_notice_2',
      'history_notice_3',
    ])
  })
})
