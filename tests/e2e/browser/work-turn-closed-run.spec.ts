/**
 * A working turn stays ONE closed line, through the real pipeline.
 *
 * 2026-10-04 report: while a session ran commands, every new command arrived as
 * an opened card under the run and folded away seconds later, and the reasoning
 * between calls stood as "Thinking ›" rows of its own. The reader wants the run
 * closed whatever arrives, with the reasoning inside it.
 *
 * The mock CLI's `stream-partial-work` turn is three API messages: reasoning and
 * a Bash call that runs, reasoning and a Read that runs, reasoning and the
 * answer. `chunk-delay:<ms>` makes each call run for 20x that, so the page can
 * be looked at while a call is in flight. Nothing is injected: session:start RPC
 * → daemon → mock CLI → real stream events → reducer → render, and the history
 * after the turn is the real parser reading the daemon's stream file.
 *
 * The turn runs on a task of the test's own: a task holds one session, so a
 * start on a fixture task that already has a conversation continues THAT one
 * (src/core/sessions/task-session-claim.ts) and makes no new session.
 */
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test'

const ANSWER = 'The folder has a readme and a src folder.'

/** A task of this test's own, titled by browser project and repeat so runs
 *  against the one fixture server never share a task. */
async function newTask(request: APIRequestContext): Promise<string> {
  const info = test.info()
  const res = await request.post('/api/tasks', {
    data: { title: `Closed run (${info.project.name} #${info.repeatEachIndex})`, source: 'local', project: 'Walnut' },
  })
  expect(res.ok(), `create task: ${res.status()}`).toBe(true)
  const body = await res.json() as { task?: { id: string }; id?: string }
  return body.task?.id ?? body.id!
}

/** Start a real session via the session:start WS RPC from inside the page. A
 *  refused or unanswered start fails here, not later as a missing session. */
async function startRealSession(page: Page, message: string, taskId: string): Promise<void> {
  const answer = await page.evaluate(async ({ message, taskId }) => {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${window.location.host}/ws`)
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve()
      ws.onerror = () => reject(new Error('ws failed'))
    })
    ws.send(JSON.stringify({
      type: 'req', id: 'pw-work-start', method: 'session:start',
      payload: { taskId, message, project: 'Walnut' },
    }))
    const result = await new Promise<string>((resolve) => {
      ws.onmessage = (ev) => {
        try {
          const parsed = JSON.parse(ev.data as string)
          if (parsed.type === 'res' && parsed.id === 'pw-work-start') resolve(parsed.ok ? 'ok' : `error: ${JSON.stringify(parsed.error)}`)
        } catch { /* not ours */ }
      }
      setTimeout(() => resolve('no answer within 10s'), 10_000)
    })
    ws.close()
    return result
  }, { message, taskId })
  expect(answer, 'session:start answer').toBe('ok')
}

/** The task's session; the task is new, so it is the one the start made. The
 *  server names a new session itself, so its id says nothing about the CLI. */
async function waitForSessionId(page: Page, taskId: string): Promise<string> {
  for (let i = 0; i < 150; i++) {
    const res = await page.request.get(`/api/sessions/task/${taskId}`)
    if (res.ok()) {
      const body = await res.json() as { sessions?: Array<{ claudeSessionId: string }> }
      const sid = body.sessions?.[0]?.claudeSessionId
      if (sid) return sid
    }
    await page.waitForTimeout(200)
  }
  throw new Error(`no session appeared for task ${taskId}`)
}

/** Home with the session in a column, reached by a click (never page.goto). */
async function openHome(page: Page, sessionId?: string): Promise<void> {
  if (sessionId) {
    await page.addInitScript((id) => {
      sessionStorage.setItem('open-walnut-home-session-columns', JSON.stringify([{ id, locked: false }]))
    }, sessionId)
  }
  await page.setContent(`<a href="${test.info().project.use.baseURL}/">Open Walnut</a>`)
  await page.getByRole('link', { name: 'Open Walnut' }).click()
  await expect(page.locator('.todo-search-input')).toBeVisible({ timeout: 20_000 })
}

type RunView = { label: string; live: boolean; open: boolean }

/** The conversation's top-level run rows (a run's own members excluded), as the
 *  reader sees them: the label, whether it breathes, whether it is open. */
async function topRuns(panel: Locator): Promise<RunView[]> {
  return panel.evaluate((root) => [...root.querySelectorAll('.tool-run-row')]
    .filter((row) => !row.parentElement?.closest('.tool-run-body'))
    .map((row) => ({
      label: row.querySelector(':scope > .tool-run-toggle > .tool-run-label')?.textContent ?? '',
      live: !!row.querySelector(':scope > .tool-run-toggle > .tool-run-live-dot'),
      open: !!row.querySelector(':scope > .tool-run-body'),
    }))
    .filter((r) => /^(Ran |Read |Thinking$)/.test(r.label)))
}

/** ONE closed run with this label and nothing else: no card open anywhere and
 *  no reasoning row of its own. */
async function expectClosedRun(panel: Locator, label: string, breathing: boolean): Promise<void> {
  await expect.poll(() => topRuns(panel), { timeout: 20_000 })
    .toEqual([{ label, live: breathing, open: false }])
  await expect(panel.locator('.chat-tool-block')).toHaveCount(0)
}

test('a working turn stays one closed run while calls run, and after it ends', async ({ page }) => {
  test.setTimeout(120_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  const taskId = await newTask(page.request)
  await openHome(page)
  // Each call runs 20 x 500ms = 10s: room to look at it under a loaded machine.
  await startRealSession(page, 'chunk-delay:500 stream-partial-work', taskId)
  const sid = await waitForSessionId(page, taskId)

  await openHome(page, sid)
  const panel = page.locator(`.main-page-session-column .session-panel[data-session-id="${sid}"]`)
  await expect(panel).toBeVisible({ timeout: 20_000 })
  const shots = test.info().outputPath('')

  // The Bash call is running: one closed line that breathes, no card.
  await expectClosedRun(panel, 'Ran a command', true)
  await page.screenshot({ path: `${shots}/1-bash-running.png`, clip: { x: 0, y: 0, width: 1280, height: 720 } })

  // The Read joins the same closed line while it runs.
  await expectClosedRun(panel, 'Ran a command, read a file', true)
  await page.screenshot({ path: `${shots}/2-read-running.png`, clip: { x: 0, y: 0, width: 1280, height: 720 } })

  // The answer lands: still one closed line, now still, with the answer under it.
  await expect(panel).toContainText(ANSWER, { timeout: 30_000 })
  await expectClosedRun(panel, 'Ran a command, read a file', false)
  await page.screenshot({ path: `${shots}/3-answered.png`, clip: { x: 0, y: 0, width: 1280, height: 720 } })

  // Opened, the run holds both calls (done) and, where the record kept it, the
  // reasoning; the reasoning is never a sibling row.
  const run = panel.locator('.tool-run-row').filter({ hasText: 'Ran a command, read a file' }).first()
  await run.locator(':scope > .tool-run-toggle').click()
  await expect(run.locator('.chat-tool-block')).toHaveCount(2)
  await expect(run.locator('.chat-tool-block-calling')).toHaveCount(0)
  await page.screenshot({ path: `${shots}/4-opened.png`, clip: { x: 0, y: 0, width: 1280, height: 720 } })
  expect(errors).toEqual([])
})
