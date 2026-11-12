import { expect, test, type Locator, type Page } from '@playwright/test'

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

async function openSession(page: Page): Promise<void> {
  await page.addInitScript((id) => {
    sessionStorage.setItem('open-walnut-home-session-columns', JSON.stringify([{ id, locked: false }]))
  }, SESSION_ID)
  await page.setContent(`<a href="${test.info().project.use.baseURL}/">Open Walnut</a>`)
  await page.getByRole('link', { name: 'Open Walnut' }).click()
  await expect(page.locator(`.session-panel[data-session-id="${SESSION_ID}"]`)).toBeVisible({ timeout: 20_000 })
  await waitForWs(page)
}

async function completedTool(page: Page, name: string, id: string, parentToolUseId?: string, msgId?: string): Promise<void> {
  const inputs: Record<string, Record<string, string>> = {
    Read: { file_path: `/tmp/${id}.txt` },
    Edit: { file_path: `/tmp/${id}.txt`, old_string: 'before', new_string: 'after' },
    SendMessage: { to: 'background-research', message: id },
    Bash: { command: `printf ${id}` },
  }
  await injectEvent(page, 'session:tool-use', {
    sessionId: SESSION_ID, toolName: name, toolUseId: id, parentToolUseId, input: inputs[name], ...(msgId ? { msgId } : {}),
  })
  await injectEvent(page, 'session:tool-result', {
    sessionId: SESSION_ID, toolUseId: id, result: id, parentToolUseId,
  })
}

/** Every step before a turn's answer is one fold (2026-11-12): the turn's fold,
 *  opened, and the step rows in its body. */
/** A beat for a render the click caused (or a reader hold) to settle. */
const page_wait = (fold: Locator) => fold.page().waitForTimeout(300)

async function openTurn(scope: Locator): Promise<Locator> {
  const fold = scope.locator('[data-testid="turn-fold"]').last()
  await expect(fold).toHaveCount(1)
  // The timeline may open it for the reader at any moment (fold-reader-hold.ts), and a click
  // then closes it: click only while it reads closed, until it stays open.
  await expect(async () => {
    if ((await fold.getAttribute('data-open')) !== 'true') await fold.locator(':scope > .tool-run-toggle').click()
    await page_wait(fold)
    await expect(fold).toHaveAttribute('data-open', 'true', { timeout: 500 })
  }).toPass({ timeout: 10_000 })
  return fold.locator(':scope > .process-fold-body')
}
// Inside the opened fold a run is no line of its own: its calls are the fold's rows (flat).
const runsIn = (body: Locator) => body.locator(':scope > .session-msg-bare > .tool-run-row:not(.tool-run-row--words)')
const callsIn = (run: Locator) => run.locator('.chat-tool-block')
/** The turn fold's own failure words ("1 failed"). */
const foldFail = (scope: Locator) => scope.locator('[data-testid="turn-fold"] > .tool-run-toggle .tool-run-fail')

test.use({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 1 })

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
  for (const anchor of ['missing', 'history', 'stream'] as const) {
    test(`merges tools through hidden subagent lanes with a ${anchor} anchor`, async ({ page }) => {
      const parent = 'toolu_background_parent'
      const agent = {
        name: 'Agent', toolUseId: parent,
        input: { description: 'Background research', run_in_background: true },
        result: 'Background research started',
      }
      await mockSession(page, [{
        role: 'assistant', text: 'Parent turn.', timestamp: '2026-01-01T00:00:00.000Z',
        ...(anchor === 'history' ? { tools: [agent] } : {}),
      }])
      await openSession(page)
      const panel = page.locator(`.session-panel[data-session-id="${SESSION_ID}"]`)
      await expect(panel.locator('.session-history')).toContainText('Parent turn.')
      if (anchor !== 'missing') {
        await injectEvent(page, 'session:tool-use', {
          sessionId: SESSION_ID, toolName: 'Agent', toolUseId: parent, input: agent.input,
        })
        await injectEvent(page, 'session:tool-result', {
          sessionId: SESSION_ID, toolUseId: parent, result: agent.result,
        })
      }
      await completedTool(page, 'Read', 'main_read_1')
      await completedTool(page, 'Bash', 'child_command', parent)
      await completedTool(page, 'Bash', 'main_command')
      await injectEvent(page, 'session:text-delta', {
        sessionId: SESSION_ID, delta: 'Hidden child narration.', msgId: 'child_text', parentToolUseId: parent,
      })
      await injectEvent(page, 'session:thinking-delta', {
        sessionId: SESSION_ID, delta: 'Hidden child thinking.', msgId: 'child_thinking', parentToolUseId: parent,
      })
      await completedTool(page, 'Read', 'main_read_2')
      await injectEvent(page, 'session:tool-use', {
        sessionId: SESSION_ID, toolName: 'Agent', toolUseId: 'child_agent', parentToolUseId: parent,
        input: { description: 'Nested research' },
      })
      await completedTool(page, 'Read', 'grandchild_read', 'child_agent')
      await completedTool(page, 'Bash', 'main_command_2')

      const rows = runsIn(await openTurn(panel))
      await expect(rows).toHaveCount(1)
      await expect(callsIn(rows)).toHaveCount(4)
      await expect(panel.locator('.bg-tasks-chip')).toHaveCount(anchor === 'missing' ? 0 : 1)
      await expect(panel).not.toContainText('Hidden child narration.')
      await expect(panel).not.toContainText('Hidden child thinking.')
      await expect(rows).not.toContainText('child_command')
      await expect(rows).not.toContainText('grandchild_read')
      if (anchor === 'stream') {
        await panel.locator('.bg-tasks-chip').click()
        const reader = page.locator('.wf-modal--tasks')
        await expect(reader.locator('.bg-tasks-detail')).toContainText('Hidden child narration.')
        const laneRun = reader.locator('.bg-tasks-detail .tool-run-row').first()
        await expect(laneRun.locator('.tool-run-label')).toHaveText('Ran a command')
        await laneRun.locator('.tool-run-toggle').click()
        await expect(reader.locator('.bg-tasks-detail')).toContainText('child_command')
        await expect(panel.locator('.task-group')).toHaveCount(0)
        await expect(panel).not.toContainText('Hidden child narration.')
        await page.keyboard.press('Escape')
        await expect(reader).toHaveCount(0)
      }
    })
  }

  test('keeps dense interleaved runs together while preserving the visible update', async ({ page }) => {
    await mockSession(page, [{ role: 'assistant', text: 'Parent turn.', timestamp: '2026-01-01T00:00:00.000Z' }])
    await openSession(page)
    const panel = page.locator(`.session-panel[data-session-id="${SESSION_ID}"]`)
    await expect(panel.locator('.session-history')).toContainText('Parent turn.')
    const runs = [
      ['Read'], ['Bash'],
      ['Read', 'Bash', 'Read', 'Read'], ['Read'], ['Edit'], ['Bash'], ['SendMessage'],
      ['Bash', 'Read'], ['Bash'], ['Edit', 'Bash'], ['Read', 'Bash', 'Read'], ['Bash'],
      ['Read', 'Bash', 'Edit'], ['Bash', 'Read', 'Read'],
    ]
    for (const [i, names] of runs.entries()) {
      if (i === 2) {
        await injectEvent(page, 'session:text-delta', {
          sessionId: SESSION_ID, delta: 'Visible progress between tool runs.', msgId: 'dense_progress',
        })
      }
      for (const [j, name] of names.entries()) await completedTool(page, name, `dense_main_${i}_${j}`)
      await completedTool(page, 'Bash', `dense_child_${i}`, 'dense_background')
    }
    const rows = runsIn(await openTurn(panel))
    await expect(rows).toHaveCount(2)
    await expect(callsIn(rows.first())).toHaveCount(2)
    await expect(callsIn(rows.last())).toHaveCount(23)
    await expect(panel).toContainText('Visible progress between tool runs.')
    await page.screenshot({ path: test.info().outputPath('merged-runs.png') })
    await expect(rows.last()).not.toContainText('dense_child')
    await page.screenshot({ path: test.info().outputPath('expanded-run.png') })
  })

  test('merges history and live tools across leading hidden subagent output', async ({ page }) => {
    await mockSession(page, [{
      role: 'assistant', text: 'Parent turn.', timestamp: '2026-01-01T00:00:00.000Z',
      tools: [{ name: 'Read', toolUseId: 'history_read', input: { file_path: '/tmp/history.txt' }, result: 'history content' }],
    }])
    await openSession(page)
    const panel = page.locator(`.session-panel[data-session-id="${SESSION_ID}"]`)
    await expect(callsIn(runsIn(await openTurn(panel)))).toHaveCount(1)
    await completedTool(page, 'Read', 'child_boundary', 'background_parent')
    await completedTool(page, 'Bash', 'main_boundary_1')
    await injectEvent(page, 'session:text-delta', {
      sessionId: SESSION_ID, delta: 'Hidden boundary narration.', msgId: 'child_boundary_text', parentToolUseId: 'background_parent',
    })
    await completedTool(page, 'Bash', 'main_boundary_2')
    const runs = runsIn(await openTurn(panel))
    await expect(runs).toHaveCount(1)
    await expect(callsIn(runs)).toHaveCount(3)
    await expect(panel.locator('.chat-tool-block')).toHaveCount(3)
    await expect(panel).not.toContainText('Hidden boundary narration.')
    await expect(panel).not.toContainText('child_boundary')
  })

  test('keeps visible prose, system notices and agents as boundaries; thinking and a running tool ride the run', async ({ page }) => {
    await mockSession(page, [{ role: 'assistant', text: 'Parent turn.', timestamp: '2026-01-01T00:00:00.000Z' }])
    await openSession(page)
    const panel = page.locator(`.session-panel[data-session-id="${SESSION_ID}"]`)
    await expect(panel.locator('.session-history')).toContainText('Parent turn.')
    await completedTool(page, 'Bash', 'before_prose')
    await injectEvent(page, 'session:text-delta', { sessionId: SESSION_ID, delta: 'Visible progress.', msgId: 'main_prose' })
    await completedTool(page, 'Bash', 'before_thinking')
    await injectEvent(page, 'session:thinking-delta', { sessionId: SESSION_ID, delta: 'Visible thinking.', msgId: 'main_thinking' })
    // Reasoning is a run MEMBER, not a boundary: the row it streams into pulses,
    // and no top-level "Thinking ›" row appears (thinking-run-merge.spec.ts).
    const body = await openTurn(panel)
    const toolRows = runsIn(body)
    await expect(toolRows).toHaveCount(2)
    await completedTool(page, 'Bash', 'before_system')
    await injectEvent(page, 'session:system-event', { sessionId: SESSION_ID, variant: 'info', message: 'Visible notice.' })
    await completedTool(page, 'Bash', 'before_agent')
    await injectEvent(page, 'session:tool-use', {
      sessionId: SESSION_ID, toolName: 'Agent', toolUseId: 'visible_agent', input: { description: 'Visible agent' },
    })
    await completedTool(page, 'Bash', 'before_running')
    await injectEvent(page, 'session:tool-use', {
      sessionId: SESSION_ID, toolName: 'Bash', toolUseId: 'running_command', input: { command: 'printf running' },
    })
    await completedTool(page, 'Bash', 'after_running')
    // A running call is no boundary (2026-10-04): it is inside the closed run,
    // which breathes until it returns, and no card opens for it.
    await expect(toolRows).toHaveCount(4)
    for (const [i, n] of [1, 2, 1, 3].entries()) await expect(callsIn(toolRows.nth(i))).toHaveCount(n)
    await expect(panel.locator('[data-testid="turn-fold"]')).toHaveAttribute('data-running', 'true')
    await expect(panel.locator('.bg-tasks-chip')).toHaveCount(1)
    await expect(panel).toContainText('Visible notice.')
    await injectEvent(page, 'session:tool-result', { sessionId: SESSION_ID, toolUseId: 'running_command', result: 'done' })
    await expect(toolRows).toHaveCount(4)
    await expect(callsIn(toolRows.last())).toHaveCount(3)
  })

  test('keeps failures and retries through duplicate results and history absorption', async ({ page }) => {
    const messages: Record<string, unknown>[] = [{
      role: 'assistant', text: 'Parent turn.', timestamp: '2026-01-01T00:00:00.000Z',
    }]
    await mockSession(page, messages)
    await openSession(page)
    const panel = page.locator(`.session-panel[data-session-id="${SESSION_ID}"]`)
    await expect(panel.locator('.session-history')).toContainText('Parent turn.')
    // The ids the CLI gives a turn's blocks, which its saved rows carry too.
    await injectEvent(page, 'session:tool-use', {
      sessionId: SESSION_ID, toolName: 'Bash', toolUseId: 'failed_command', input: { command: 'printf failed_command' }, msgId: 'msg_retry',
    })
    await injectEvent(page, 'session:tool-result', {
      sessionId: SESSION_ID, toolUseId: 'failed_command', result: 'Error: fixture command failed',
    })
    await completedTool(page, 'Read', 'retry_child', 'retry_agent')
    await completedTool(page, 'Bash', 'retry_command', undefined, 'msg_retry')
    await injectEvent(page, 'session:tool-result', {
      sessionId: SESSION_ID, toolUseId: 'retry_command', result: 'retry_command',
    })
    const liveRuns = runsIn(await openTurn(panel))
    await expect(liveRuns).toHaveCount(1)
    await expect(foldFail(panel)).toHaveText('1 failed')
    await expect(panel.locator('.chat-tool-block')).toHaveCount(2)
    await expect(panel).not.toContainText('retry_child')
    messages.push({
      role: 'assistant', text: '', msgId: 'msg_retry', timestamp: new Date().toISOString(),
      tools: [
        { name: 'Bash', toolUseId: 'failed_command', input: { command: 'printf failed_command' }, result: 'Error: fixture command failed', isError: true },
        { name: 'Bash', toolUseId: 'retry_command', input: { command: 'printf retry_command' }, result: 'retry_command' },
      ],
    })
    await injectEvent(page, 'session:batch-completed', { sessionId: SESSION_ID, count: 1 })
    await injectEvent(page, 'session:result', { sessionId: SESSION_ID, result: 'done', isError: false })
    await expect(panel.locator('.session-live-row .tool-run-row')).toHaveCount(0)
    // The reader opened the turn live: it stays open once saved.
    await expect(panel.locator('[data-testid="turn-fold"]')).toHaveAttribute('data-open', 'true')
    await expect(foldFail(panel)).toHaveText('1 failed')
    const savedRuns = runsIn(await openTurn(panel))
    await expect(savedRuns).toHaveCount(1)
    await expect(callsIn(savedRuns)).toHaveCount(2)
    await expect(panel.locator('.chat-tool-block')).toHaveCount(2)
  })

  test('merges completed tool calls through a render-null ghost block', async ({ page }) => {
    await mockSession(page)
    await openSession(page)
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

    const body = await openTurn(page.locator(`.session-panel[data-session-id="${SESSION_ID}"]`))
    const toolRows = runsIn(body)
    // Saved rows that come in after the stream (a late history read) keep the open row open.
    await page.waitForTimeout(2000)
    await expect(toolRows).toHaveCount(1)
    await expect(callsIn(toolRows)).toHaveCount(2)
  })

  test('merges adjacent streaming thinking segments into one row', async ({ page }) => {
    await mockSession(page, [])
    await openSession(page)
    await waitForWs(page)

    // Two thinking segments from DIFFERENT messages, split by a ghost tool
    // call (renders null) — the timeline must show ONE "Thinking ›" row.
    await injectEvent(page, 'session:thinking-delta', {
      sessionId: SESSION_ID,
      taskId: 'pw-task-ghost-run',
      delta: 'First thinking segment.',
      msgId: 'msg_think_1',
    })
    await injectEvent(page, 'session:tool-use', {
      sessionId: SESSION_ID,
      taskId: 'pw-task-ghost-run',
      toolName: 'Bash',
      toolUseId: 'toolu_think_ghost',
      input: {},
    })
    await injectEvent(page, 'session:thinking-delta', {
      sessionId: SESSION_ID,
      taskId: 'pw-task-ghost-run',
      delta: 'Second thinking segment.',
      msgId: 'msg_think_2',
    })

    // A new session's first turn is its one fold too (2026-11-12); opened, ONE reasoning row.
    const body = await openTurn(page.locator(`.session-panel[data-session-id="${SESSION_ID}"]`))
    const thinkingRows = body.locator('.tool-run-row--step', {
      has: page.locator(':scope > .tool-run-toggle > .tool-run-label', { hasText: /^Thinking$/ }),
    })
    await expect(thinkingRows).toHaveCount(1)

    await thinkingRows.locator(':scope > .tool-run-toggle').click()
    await expect(thinkingRows.locator('.chat-thinking-content')).toContainText('First thinking segment.')
    await expect(thinkingRows.locator('.chat-thinking-content')).toContainText('Second thinking segment.')
  })

  test('merges consecutive thinking-only history messages into one row', async ({ page }) => {
    await mockSession(page, [
      {
        role: 'assistant',
        text: '',
        thinking: 'History thinking segment one.',
        timestamp: '2026-01-01T00:00:00.000Z',
      },
      {
        role: 'assistant',
        text: '',
        thinking: 'History thinking segment two.',
        timestamp: '2026-01-01T00:00:01.000Z',
      },
      {
        role: 'assistant',
        text: 'Final visible answer.',
        thinking: 'History thinking segment three.',
        timestamp: '2026-01-01T00:00:02.000Z',
      },
    ])
    await openSession(page)

    await expect(page.locator('.session-history .markdown-body p', { hasText: 'Final visible answer.' })).toBeVisible()
    // The reasoning before the answer is the turn's one fold; inside it, one thinking row.
    const turnBody = await openTurn(page.locator('.session-history'))
    const thinkingRows = turnBody.locator('.tool-run-row', {
      has: page.locator('.tool-run-label', { hasText: /^Thinking$/ }),
    })
    await expect(thinkingRows).toHaveCount(1)

    await thinkingRows.locator('.tool-run-toggle').click()
    const body = thinkingRows.locator('.chat-thinking-content')
    await expect(body).toContainText('History thinking segment one.')
    await expect(body).toContainText('History thinking segment two.')
    await expect(body).toContainText('History thinking segment three.')
  })

  test('collapses a verbose persisted system line and reveals its full text', async ({ page }) => {
    await mockSession(page)
    await openSession(page)

    // A lone step is the turn's fold too: opened, the line is in it.
    const systemRow = (await openTurn(page.locator('.session-history'))).locator('.tool-run-row').filter({ hasText: 'commands_changed' })
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
        text: '',
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
      { role: 'assistant', text: 'Timeline prose baseline', timestamp: '2026-01-01T00:00:05.000Z' },
    ])
    await openSession(page)

    const history = page.locator('.session-history')
    await expect(history.locator('.markdown-body p', { hasText: 'Timeline prose baseline' })).toBeVisible()
    // The steps before the answer are its one fold, lined up with the answer.
    const turn = history.locator('[data-testid="turn-fold"]')
    const body = await openTurn(history)
    // Inside it the three lines are rows of its list, as the call is (no second line to open).
    const lines = body.locator('.session-system-line')
    await expect(lines).toHaveCount(3)
    await expect(body.locator('.tool-run-row').filter({ hasText: /^3 system messages/ })).toHaveCount(0)

    const left = async (l: Locator) => (await l.boundingBox())!.x
    const prose = await left(history.locator('.markdown-body p', { hasText: 'Timeline prose baseline' }))
    const fold = await left(turn.locator(':scope > .tool-run-toggle'))
    const tool = await left(callsIn(runsIn(body)).first())
    const system = await left(lines.first())
    console.log(`ALIGNMENT_PROBE fold=${fold} prose=${prose} tool=${tool} system=${system}`)
    expect(Math.abs(fold - prose)).toBeLessThanOrEqual(1)
    expect(Math.abs(tool - system)).toBeLessThanOrEqual(1)
    await expect(body.locator('.session-system-text')).toHaveText([
      'history_notice_1',
      'history_notice_2',
      'history_notice_3',
    ])
  })
})
