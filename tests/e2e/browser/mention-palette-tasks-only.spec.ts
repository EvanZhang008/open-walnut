/**
 * REAL-PIPELINE Playwright spec for the composer's "@" palette listing TASKS
 * only (MentionPalette), one level: no Sessions group, no Projects group. A
 * row is a task with its run state (a dot and "waiting on you" / "running" in
 * the meta line), and the `<task-ref/>` the pick inserts reaches the agent as a
 * reference card that carries that state.
 *
 * Nothing is route-mocked: two tasks really run (session:start WS RPC →
 * MockDaemon → the mock Claude CLI), one parked on a permission prompt so its
 * live state is stable, one idle; a third task never ran. The palette opens in
 * the idle task's column, so that task itself must be absent.
 */
import { test, expect, type Page, type APIRequestContext, type Locator } from '@playwright/test'

const COLUMNS_KEY = 'open-walnut-home-session-columns'
let rpcSeq = 0

async function startRealSession(page: Page, message: string, taskId: string, mode?: string): Promise<void> {
  const reqId = `pw-mention-start-${++rpcSeq}`
  await page.evaluate(
    async ({ message, taskId, reqId, mode }) => {
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
      const ws = new WebSocket(`${proto}://${window.location.host}/ws`)
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve()
        ws.onerror = () => reject(new Error('ws failed'))
      })
      ws.send(JSON.stringify({
        type: 'req', id: reqId, method: 'session:start',
        payload: { taskId, message, project: 'Walnut', ...(mode ? { mode } : {}) },
      }))
      await new Promise<void>((resolve) => {
        ws.onmessage = (ev) => {
          try {
            const parsed = JSON.parse(ev.data as string)
            if (parsed.type === 'res' && parsed.id === reqId) resolve()
          } catch { /* ignore */ }
        }
        setTimeout(resolve, 5000)
      })
      ws.close()
    },
    { message, taskId, reqId, mode },
  )
}

async function pendingPermissionTool(request: APIRequestContext, sid: string): Promise<string | null> {
  const res = await request.get(`/api/sessions/${sid}`)
  if (!res.ok()) return null
  const body = await res.json() as { session?: { pendingPermission?: { toolName?: string } } }
  return body.session?.pendingPermission?.toolName ?? null
}

async function newTask(request: APIRequestContext, title: string): Promise<string> {
  const res = await request.post('/api/tasks', {
    data: { title: `${title} (${test.info().project.name})`, source: 'local', project: 'Walnut' },
  })
  expect(res.ok(), `create task: ${res.status()}`).toBe(true)
  const body = await res.json() as { task?: { id: string }; id?: string }
  return body.task?.id ?? body.id!
}

async function sessionIdsFor(request: APIRequestContext, taskId: string): Promise<Set<string>> {
  const res = await request.get(`/api/sessions/task/${taskId}`)
  if (!res.ok()) return new Set()
  const body = await res.json() as { sessions?: Array<{ claudeSessionId: string }> }
  return new Set((body.sessions ?? []).map((s) => s.claudeSessionId))
}

async function waitForNewSessionId(request: APIRequestContext, taskId: string, before: Set<string>): Promise<string> {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const ids = await sessionIdsFor(request, taskId)
    for (const id of ids) if (!before.has(id)) return id
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`no new mock session appeared for task ${taskId}`)
}

function columnFor(page: Page, sid: string): Locator {
  return page.locator('.main-page-sessions-area > .main-page-session-column')
    .filter({ has: page.locator(`.session-panel[data-session-id="${sid}"]`) })
}

test('the "@" palette lists tasks only, a task carries its session, and the pick reaches the agent with that session', async ({ page, request }) => {
  test.setTimeout(240_000)
  const tag = `pw-mention-${Date.now().toString(36)}`
  await page.goto('/')
  await page.waitForLoadState('networkidle')

  // Three tasks: one whose session parks on a permission prompt (a stable live
  // "waiting" state), one whose session answers and goes idle (the column the
  // palette opens in), one with no session at all.
  const waitingTask = await newTask(request, `${tag} waiting`)
  const selfTask = await newTask(request, `${tag} self`)
  const plainTask = await newTask(request, `${tag} plain`)

  // `default` mode: the fixture's default would auto-approve the prompt and the
  // session would settle idle instead of parking on it.
  const beforeWaiting = await sessionIdsFor(request, waitingTask)
  await startRealSession(page, 'status-permission-test:Bash', waitingTask, 'default')
  const waitingSid = await waitForNewSessionId(request, waitingTask, beforeWaiting)
  await expect.poll(() => pendingPermissionTool(request, waitingSid), { timeout: 30_000 }).toBe('Bash')
  const beforeSelf = await sessionIdsFor(request, selfTask)
  await startRealSession(page, 'hello from the palette spec', selfTask)
  const selfSid = await waitForNewSessionId(request, selfTask, beforeSelf)

  await page.addInitScript(({ key, ids }) => {
    try { sessionStorage.setItem(key, JSON.stringify(ids.map((id: string) => ({ id, locked: false })))) } catch { /* ignore */ }
  }, { key: COLUMNS_KEY, ids: [selfSid] })
  await page.goto('/')
  await page.waitForLoadState('networkidle')
  const col = columnFor(page, selfSid)
  await expect(col).toBeVisible({ timeout: 30_000 })
  // The idle session's turn has to be over before the palette opens, so that
  // sending the reference below is a fresh turn the mock echoes whole.
  await expect(col.locator('.session-panel')).toContainText('hello from the palette spec', { timeout: 60_000 })

  const textarea = col.locator('.session-panel-input textarea')
  await textarea.click()
  await page.keyboard.type(`@${tag}`)
  const palette = col.locator('.mention-palette')
  await expect(palette).toBeVisible({ timeout: 10_000 })

  // Tasks and Files: nothing else. No Sessions group, no Projects group, and no
  // row for a session or a project.
  await expect(palette.locator('.mention-row-task').filter({ hasText: `${tag} waiting` })).toBeVisible({ timeout: 15_000 })
  const groupNames = await palette.locator('.mention-group-name').allTextContents()
  expect(groupNames.every((n) => n === 'Tasks' || n === 'Files'), `groups: ${groupNames.join(',')}`).toBe(true)
  expect(groupNames).toContain('Tasks')
  await expect(palette.locator('.mention-row-session, .mention-row-project, [data-group="session"], [data-group="project"]')).toHaveCount(0)

  // The task parked on a permission: a waiting dot and "waiting on you" in its
  // meta. The task that never ran: the same row shape, an idle dot. The
  // column's own task is never offered.
  const waitingRow = palette.locator('.mention-row-task').filter({ hasText: `${tag} waiting` })
  await expect(waitingRow).toHaveAttribute('data-state', 'waiting')
  await expect(waitingRow.locator('.mention-dot.waiting')).toBeVisible()
  await expect(waitingRow.locator('.mention-meta')).toContainText('waiting on you')
  const plainRow = palette.locator('.mention-row-task').filter({ hasText: `${tag} plain` })
  await expect(plainRow).toHaveAttribute('data-state', 'idle')
  await expect(plainRow.locator('.mention-dot.idle')).toBeVisible()
  await expect(plainRow.locator('.mention-meta')).toHaveText('TODO · Walnut')
  await expect(palette.locator('.mention-row-task').filter({ hasText: `${tag} self` })).toHaveCount(0)
  // The live-first ordering: the waiting task sits above the idle one.
  const titles = await palette.locator('.mention-row-task .mention-title').allTextContents()
  expect(titles.findIndex((t) => t.includes(`${tag} waiting`))).toBeLessThan(titles.findIndex((t) => t.includes(`${tag} plain`)))

  // Pick the waiting task: the "@query" becomes a reference chip, the prose stays.
  await waitingRow.click()
  await expect(palette).toHaveCount(0)
  await expect(col.locator('.composer-ref-title')).toHaveText(`${tag} waiting (${test.info().project.name})`)
  await expect(textarea).toHaveValue('')
  await page.keyboard.type('look at this one')
  await page.keyboard.press('Enter')

  // The sent message shows the task as a pill, and the agent's copy carried the
  // reference card: the mock CLI echoes its whole input, so the reply shows the
  // task line with its run state, one id, no second one to address.
  const panel = col.locator('.session-panel')
  await expect(panel.locator(`a.task-link[data-task-id="${waitingTask}"]`).first()).toBeVisible({ timeout: 30_000 })
  await expect(panel).toContainText(`task ${waitingTask}`, { timeout: 60_000 })
  await expect(panel).toContainText('project Walnut · waiting on you')
  await expect(panel).toContainText('use task_get / task_send for more')
  await expect(panel).not.toContainText(`session ${waitingSid}`)
  await expect(panel).not.toContainText('session-ref id=')
})
